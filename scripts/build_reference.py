#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import gzip
import io
import json
import re
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
OUT_DIR = ROOT / "src" / "reference" / "generated"
CACHE_DIR = ROOT / ".cache" / "reference"

HGNC_URL = "https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/hgnc_complete_set.txt"
REACTOME_GMT_URL = "https://reactome.org/download/current/ReactomePathways.gmt.zip"
STRING_ALIASES_URL = "https://stringdb-downloads.org/download/protein.aliases.v12.0/9606.protein.aliases.v12.0.txt.gz"
STRING_LINKS_URL = "https://stringdb-downloads.org/download/protein.links.v12.0/9606.protein.links.v12.0.txt.gz"
HURI_URL = "https://interactome-atlas.org/data/HuRI.tsv"


def download(url: str, filename: str) -> Path:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path = CACHE_DIR / filename
    if path.exists():
        return path
    tmp_path = path.with_suffix(path.suffix + ".part")
    with urllib.request.urlopen(url, timeout=180) as response, tmp_path.open("wb") as handle:
        while True:
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            handle.write(chunk)
    tmp_path.replace(path)
    return path


def normalize_symbol(value: str) -> str:
    return value.strip().strip('"').strip("'").upper()


def normalize_ensembl_gene_id(value: str) -> str:
    normalized = value.strip().split(".")[0].upper()
    return normalized if normalized.startswith("ENSG") else ""


def normalize_pathway_name(value: str) -> str:
    value = value.strip().lower().replace("&", " and ")
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def build_alias_map(hgnc_path: Path) -> tuple[dict[str, str], dict[str, str]]:
    alias_map: dict[str, str] = {}
    ensembl_to_symbol: dict[str, str] = {}
    with hgnc_path.open("r", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for row in reader:
            symbol = normalize_symbol(row.get("symbol", ""))
            if not symbol:
                continue
            alias_map[symbol] = symbol
            for ensembl_id in str(row.get("ensembl_gene_id") or "").split("|"):
                normalized_ensembl = normalize_ensembl_gene_id(ensembl_id)
                if normalized_ensembl:
                    ensembl_to_symbol.setdefault(normalized_ensembl, symbol)
            for field in ("alias_symbol", "prev_symbol"):
                raw_value = row.get(field) or ""
                for alias in raw_value.split("|"):
                    cleaned = normalize_symbol(alias)
                    if cleaned and re.search(r"[A-Z]", cleaned):
                        alias_map.setdefault(cleaned, symbol)
    return alias_map, ensembl_to_symbol


def parse_reactome(reactome_zip_path: Path) -> tuple[dict[str, dict], dict[str, str]]:
    by_id: dict[str, dict] = {}
    by_key: dict[str, str] = {}
    with zipfile.ZipFile(reactome_zip_path) as archive:
        gmt_name = archive.namelist()[0]
        with archive.open(gmt_name) as handle:
            for raw_line in io.TextIOWrapper(handle, encoding="utf-8"):
                parts = raw_line.rstrip("\n").split("\t")
                if len(parts) < 3:
                    continue
                pathway_name, pathway_id, *genes = parts
                genes = sorted({normalize_symbol(gene) for gene in genes if normalize_symbol(gene)})
                if not genes:
                    continue
                key = f"Reactome::{pathway_id.upper()}"
                by_id[key] = {
                    "id": pathway_id.upper(),
                    "name": pathway_name.strip(),
                    "collection": "Reactome",
                    "genes": genes,
                }
                by_key[f"reactome::{normalize_pathway_name(pathway_name)}"] = key
    return by_id, by_key


def parse_hallmark(hallmark_path: Path | None, alias_map: dict[str, str]) -> tuple[dict[str, dict], dict[str, str]]:
    if hallmark_path is None or not hallmark_path.exists():
        return {}, {}

    by_id: dict[str, dict] = {}
    by_key: dict[str, str] = {}
    with hallmark_path.open("r", encoding="utf-8") as handle:
        for line in handle:
            parts = line.rstrip("\n").split("\t")
            if len(parts) < 3:
                continue
            pathway_name, _, *genes = parts
            normalized_genes = sorted(
                {
                    alias_map.get(normalize_symbol(gene), normalize_symbol(gene))
                    for gene in genes
                    if normalize_symbol(gene)
                }
            )
            key = f"Hallmark::{normalize_symbol(pathway_name)}"
            by_id[key] = {
                "id": normalize_symbol(pathway_name),
                "name": pathway_name.strip(),
                "collection": "Hallmark",
                "genes": normalized_genes,
            }
            by_key[f"hallmark::{normalize_pathway_name(pathway_name)}"] = key
    return by_id, by_key


def allowed_alias_source(source: str) -> bool:
    patterns = ("HGNC", "BioMart_HUGO", "UniProt_GN", "BLAST_UniProt_GN")
    return any(pattern in source for pattern in patterns)


def build_string_protein_map(
    aliases_path: Path,
    alias_map: dict[str, str],
    union_genes: set[str],
) -> dict[str, set[str]]:
    protein_map: dict[str, set[str]] = defaultdict(set)
    with gzip.open(aliases_path, "rt", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter="\t")
        for row in reader:
            protein = row["#string_protein_id"]
            alias = normalize_symbol(row["alias"])
            source = row["source"]
            if not alias or not allowed_alias_source(source):
                continue
            canonical = alias_map.get(alias)
            if canonical and canonical in union_genes:
                protein_map[protein].add(canonical)
    return protein_map


def build_ppi_adjacency(
    links_path: Path,
    protein_map: dict[str, set[str]],
    score_cutoff: int,
) -> dict[str, list[list[str | int]]]:
    edges: dict[tuple[str, str], int] = {}
    with gzip.open(links_path, "rt", encoding="utf-8") as handle:
        reader = csv.DictReader(handle, delimiter=" ")
        for row in reader:
            score = int(row["combined_score"])
            if score < score_cutoff:
                continue
            left_genes = protein_map.get(row["protein1"])
            right_genes = protein_map.get(row["protein2"])
            if not left_genes or not right_genes:
                continue
            for left in left_genes:
                for right in right_genes:
                    if left == right:
                        continue
                    pair = tuple(sorted((left, right)))
                    if score > edges.get(pair, 0):
                        edges[pair] = score

    adjacency: dict[str, list[list[str | int]]] = defaultdict(list)
    for (left, right), score in edges.items():
        adjacency[left].append([right, score])
        adjacency[right].append([left, score])

    for gene, neighbors in adjacency.items():
        neighbors.sort(key=lambda item: (-int(item[1]), item[0]))
    return dict(adjacency)


def build_huri_adjacency(
    huri_path: Path,
    ensembl_to_symbol: dict[str, str],
    union_genes: set[str],
    default_score: int = 850,
) -> dict[str, list[list[str | int]]]:
    edges: set[tuple[str, str]] = set()
    with huri_path.open("r", encoding="utf-8") as handle:
        for raw_line in handle:
            left_raw, _, right_raw = raw_line.partition("\t")
            if not right_raw:
                continue
            left = ensembl_to_symbol.get(normalize_ensembl_gene_id(left_raw))
            right = ensembl_to_symbol.get(normalize_ensembl_gene_id(right_raw))
            if not left or not right or left == right:
                continue
            if left not in union_genes or right not in union_genes:
                continue
            edges.add(tuple(sorted((left, right))))

    adjacency: dict[str, list[list[str | int]]] = defaultdict(list)
    for left, right in edges:
        adjacency[left].append([right, default_score])
        adjacency[right].append([left, default_score])

    for gene, neighbors in adjacency.items():
        neighbors.sort(key=lambda item: (-int(item[1]), item[0]))
    return dict(adjacency)


def count_edges(adjacency: dict[str, list[list[str | int]]]) -> set[tuple[str, str]]:
    edge_pairs: set[tuple[str, str]] = set()
    for source, neighbors in adjacency.items():
        for target, _score in neighbors:
            if source == target:
                continue
            edge_pairs.add(tuple(sorted((source, str(target)))))
    return edge_pairs


def main() -> None:
    parser = argparse.ArgumentParser(description="Build offline reference assets for the viewer.")
    parser.add_argument("--string-score-cutoff", type=int, default=700)
    parser.add_argument(
        "--hallmark-gmt",
        type=Path,
        default=None,
        help="Optional local GMT file for Hallmark membership.",
    )
    args = parser.parse_args()

    OUT_DIR.mkdir(parents=True, exist_ok=True)

    hgnc_path = download(HGNC_URL, "hgnc_complete_set.txt")
    reactome_path = download(REACTOME_GMT_URL, "ReactomePathways.gmt.zip")
    string_aliases_path = download(STRING_ALIASES_URL, "9606.protein.aliases.v12.0.txt.gz")
    string_links_path = download(STRING_LINKS_URL, "9606.protein.links.v12.0.txt.gz")
    huri_path = download(HURI_URL, "HuRI.tsv")

    alias_map, ensembl_to_symbol = build_alias_map(hgnc_path)
    reactome_by_id, reactome_by_key = parse_reactome(reactome_path)
    hallmark_by_id, hallmark_by_key = parse_hallmark(args.hallmark_gmt, alias_map)

    pathways_by_id = {**reactome_by_id, **hallmark_by_id}
    pathways_by_key = {**reactome_by_key, **hallmark_by_key}
    union_genes = {gene for pathway in pathways_by_id.values() for gene in pathway["genes"]}

    protein_map = build_string_protein_map(string_aliases_path, alias_map, union_genes)
    string_adjacency = build_ppi_adjacency(string_links_path, protein_map, args.string_score_cutoff)
    huri_adjacency = build_huri_adjacency(huri_path, ensembl_to_symbol, union_genes)
    string_edges = count_edges(string_adjacency)
    huri_edges = count_edges(huri_adjacency)
    combined_edges = string_edges | huri_edges
    combined_genes = {gene for pair in combined_edges for gene in pair}

    metadata = {
        "reactomePathways": len(reactome_by_id),
        "hallmarkPathways": len(hallmark_by_id),
        "ppiGenes": len(combined_genes),
        "ppiEdges": len(combined_edges),
        "stringPpiGenes": len(string_adjacency),
        "stringPpiEdges": len(string_edges),
        "huriPpiGenes": len(huri_adjacency),
        "huriPpiEdges": len(huri_edges),
        "hallmarkMode": "built-in" if hallmark_by_id else "leading-edge-only",
        "stringScoreCutoff": args.string_score_cutoff,
    }

    (OUT_DIR / "aliases.json").write_text(json.dumps(alias_map, separators=(",", ":")))
    (OUT_DIR / "pathways.json").write_text(
        json.dumps({"byId": pathways_by_id, "byKey": pathways_by_key}, separators=(",", ":"))
    )
    (OUT_DIR / "ppi.json").write_text(json.dumps(string_adjacency, separators=(",", ":")))
    (OUT_DIR / "huri.json").write_text(json.dumps(huri_adjacency, separators=(",", ":")))
    (OUT_DIR / "metadata.json").write_text(json.dumps(metadata, separators=(",", ":")))

    print(json.dumps(metadata, indent=2))


if __name__ == "__main__":
    main()
