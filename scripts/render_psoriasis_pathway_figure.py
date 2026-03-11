#!/usr/bin/env python3

from __future__ import annotations

import json
import math
from pathlib import Path
import zipfile

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import seaborn as sns


ROOT = Path(__file__).resolve().parents[1]
RESULTS = ROOT / "results"
FIGURES = ROOT / "figures"


def load_reactome() -> dict[str, set[str]]:
    reactome_zip = ROOT / ".cache" / "reference" / "ReactomePathways.gmt.zip"
    pathways: dict[str, set[str]] = {}
    with zipfile.ZipFile(reactome_zip) as archive:
        with archive.open("ReactomePathways.gmt") as handle:
            for raw in handle.read().decode().splitlines():
                parts = raw.split("\t")
                if len(parts) < 3:
                    continue
                _name, pathway_id, *genes = parts
                pathways[pathway_id] = set(g for g in genes if g)
    return pathways


def enrichment_curve(ranked: pd.Series, gene_set: set[str]):
    ranked = ranked.dropna().sort_values(ascending=False)
    hits = ranked.index.isin(gene_set)
    abs_weights = ranked.abs()
    hit_weight = abs_weights[hits].sum()
    miss_weight = (~hits).sum()
    running = [0.0]
    current = 0.0
    hit_positions = []
    for idx, (gene, value) in enumerate(ranked.items(), start=1):
        if gene in gene_set:
            current += abs(value) / hit_weight if hit_weight else 0.0
            hit_positions.append(idx)
        else:
            current -= 1.0 / miss_weight if miss_weight else 0.0
        running.append(current)
    return np.arange(len(running)), np.array(running), hit_positions


def choose_pathway(gsea: pd.DataFrame) -> pd.Series:
    preferred_terms = [
        "Formation of the cornified envelope",
        "Keratinization",
        "Interferon Signaling",
        "Cytokine Signaling in Immune system",
        "Neutrophil degranulation",
    ]
    for term in preferred_terms:
        hits = gsea[(gsea["pathway_name"] == term) & (gsea["padj"] < 0.05)]
        if not hits.empty:
            return hits.iloc[0]
    return gsea.sort_values(["padj", "NES"], ascending=[True, False]).iloc[0]


def build_network(pathway_row: pd.Series, deg: pd.DataFrame, ppi: dict[str, list[list]]):
    leading_edge = [gene for gene in str(pathway_row["leadingEdge"]).split(";") if gene]
    nodes = sorted(set(leading_edge))
    node_set = set(nodes)
    edges: list[tuple[str, str, float]] = []
    seen = set()
    for gene in nodes:
        for neighbor, score in ppi.get(gene, []):
            if neighbor in node_set and gene != neighbor:
                key = tuple(sorted((gene, neighbor)))
                if key in seen:
                    continue
                seen.add(key)
                edges.append((key[0], key[1], float(score)))
    return nodes, edges


def spring_layout(nodes: list[str], edges: list[tuple[str, str, float]], seed: int = 11):
    rng = np.random.default_rng(seed)
    n = len(nodes)
    if n == 1:
        return {nodes[0]: np.array([0.0, 0.0])}

    idx = {node: i for i, node in enumerate(nodes)}
    pos = rng.normal(scale=0.42, size=(n, 2))
    k = 1.75 / math.sqrt(max(n, 1))
    temperature = 0.24

    for _ in range(360):
        disp = np.zeros_like(pos)
        for i in range(n):
            delta = pos[i] - pos
            dist = np.linalg.norm(delta, axis=1) + 1e-6
            repulsive = (1.35 * k * k / dist**2)[:, None] * delta
            disp[i] += repulsive.sum(axis=0)
        for source, target, score in edges:
            i = idx[source]
            j = idx[target]
            delta = pos[i] - pos[j]
            dist = np.linalg.norm(delta) + 1e-6
            strength = 0.16 + score / 2200.0
            attractive = (dist**2 / k) * strength * (delta / dist)
            disp[i] -= attractive
            disp[j] += attractive
        norms = np.linalg.norm(disp, axis=1) + 1e-9
        pos += (disp / norms[:, None]) * np.minimum(norms[:, None], temperature)
        pos -= pos.mean(axis=0)
        pos = np.clip(pos, -1.45, 1.45)
        temperature *= 0.988

    pos /= np.max(np.abs(pos)) + 1e-6
    return {node: pos[idx[node]] for node in nodes}


def main():
    FIGURES.mkdir(exist_ok=True)
    deg = pd.read_csv(RESULTS / "psoriasis_lesional_vs_healthy_deseq2.tsv", sep="\t")
    gsea = pd.read_csv(RESULTS / "psoriasis_lesional_vs_healthy_fgsea_reactome.tsv", sep="\t")
    with open(ROOT / "src" / "reference" / "generated" / "ppi.json") as handle:
        ppi = json.load(handle)

    selected = choose_pathway(gsea)
    reactome = load_reactome()
    gene_set = reactome.get(selected["pathway_id"], set())
    ranked = deg.set_index("gene")["stat"].dropna()
    x, y, hit_positions = enrichment_curve(ranked, gene_set)

    nodes, edges = build_network(selected, deg, ppi)
    if not nodes:
        raise RuntimeError("Selected pathway produced an empty leading-edge network.")

    layout = spring_layout(nodes, edges)
    deg_lookup = deg.set_index("gene")
    node_sizes = []
    node_colors = []
    label_scores = []
    for gene in nodes:
        row = deg_lookup.loc[gene]
        node_sizes.append(max(85, min(760, -math.log10(max(float(row["padj"]), 1e-12)) * 118)))
        node_colors.append(float(row["log2FoldChange"]))
        label_scores.append((gene, float(row["padj"]), abs(float(row["log2FoldChange"]))))

    label_scores.sort(key=lambda item: (item[1], -item[2]))
    labels = {gene: gene for gene, _, _ in label_scores[: min(14, len(label_scores))]}

    fig = plt.figure(figsize=(13.5, 6.5))
    gs = fig.add_gridspec(1, 2, width_ratios=[1.15, 0.85], wspace=0.24)
    ax0 = fig.add_subplot(gs[0, 0])
    ax1 = fig.add_subplot(gs[0, 1])

    for source, target, score in edges:
        x0, y0 = layout[source]
        x1, y1 = layout[target]
        ax0.plot(
            [x0, x1],
            [y0, y1],
            color="#94a3b8",
            linewidth=0.8 + score / 230.0,
            alpha=0.42,
            zorder=1,
        )

    scatter = ax0.scatter(
        [layout[node][0] for node in nodes],
        [layout[node][1] for node in nodes],
        s=node_sizes,
        c=node_colors,
        cmap="coolwarm",
        vmin=-3,
        vmax=3,
        edgecolors="#1e293b",
        linewidths=1.2,
        zorder=2,
    )
    for gene, label in labels.items():
        px, py = layout[gene]
        ax0.text(px, py + 0.035, label, fontsize=9, fontweight="bold", ha="center", va="bottom")

    cbar = fig.colorbar(scatter, ax=ax0, fraction=0.046, pad=0.04)
    cbar.set_label("log2 fold-change")
    ax0.set_title(f"Leading-edge network: {selected['pathway_name']}", fontsize=13, fontweight="bold")
    ax0.text(
        0.02,
        0.02,
        "Node size = -log10(FDR)\nEdge width = STRING score",
        transform=ax0.transAxes,
        va="bottom",
        ha="left",
        fontsize=10,
        color="#475569",
        bbox=dict(boxstyle="round,pad=0.35", fc="white", ec="#cbd5e1", alpha=0.9),
    )
    ax0.set_xticks([])
    ax0.set_yticks([])
    ax0.set_xlim(-1.28, 1.28)
    ax0.set_ylim(-1.28, 1.28)
    for spine in ax0.spines.values():
        spine.set_visible(False)

    ax1.plot(x, y, color="#7c3aed", linewidth=2.8)
    if len(hit_positions):
        ymin = float(y.min())
        ymax = ymin + (abs(ymin) + abs(y.max())) * 0.12
        ax1.vlines(hit_positions, ymin=ymin * 0.08, ymax=ymax, color="#0f172a", linewidth=0.65)
    ax1.axhline(0, color="#64748b", linestyle="--", linewidth=0.8)
    ax1.set_title("GSEA running enrichment score", fontsize=13, fontweight="bold")
    ax1.set_xlabel("Ranked genes (DESeq2 Wald statistic)")
    ax1.set_ylabel("Running enrichment score")
    ax1.text(
        0.02,
        0.96,
        f"Pathway: {selected['pathway_name']}\nNES = {selected['NES']:.2f}\nFDR = {selected['padj']:.2e}",
        transform=ax1.transAxes,
        va="top",
        ha="left",
        fontsize=10,
        bbox=dict(boxstyle="round,pad=0.35", fc="white", ec="#cbd5e1", alpha=0.92),
    )
    sns.despine(ax=ax1)

    fig.suptitle(
        "Psoriasis lesions activate immune-effector and epidermal stress modules",
        fontsize=15,
        fontweight="bold",
        y=0.98,
    )
    fig.subplots_adjust(left=0.05, right=0.98, bottom=0.11, top=0.88, wspace=0.26)
    fig.savefig(FIGURES / "figure5_selected_pathway_network_and_enrichment.pdf", bbox_inches="tight")
    fig.savefig(FIGURES / "figure5_selected_pathway_network_and_enrichment.png", dpi=320, bbox_inches="tight")
    (RESULTS / "selected_pathway_for_network.tsv").write_text(selected.to_frame().T.to_csv(sep="\t", index=False))


if __name__ == "__main__":
    main()
