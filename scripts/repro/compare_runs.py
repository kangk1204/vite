#!/usr/bin/env python3
"""Quantify differences against the released macOS output, matching stable row IDs."""
import argparse
import csv
import gzip
import json
import math
from pathlib import Path

TABLES = {
    "genes": ("gene", "_deseq2.tsv", ["stat", "pvalue", "padj", "log2FoldChangeUnshrunk", "log2FoldChange", "lfcSE"]),
    "pathways": ("pathway_id", "_fgsea_reactome.tsv", ["ES", "NES", "pval", "padj", "size"]),
    "camera": ("pathway", "_camera.tsv", ["pvalue", "padj"]),
    "samples": ("sample", "_sample_metadata.tsv", []),
}
SIGNED = {"stat", "log2FoldChange", "log2FoldChangeUnshrunk", "ES", "NES"}
MISSING = {"", "NA", "NaN"}


def read_table(path, id_column, columns):
    opener = gzip.open if path.suffix == ".gz" else open
    with opener(path, "rt", encoding="utf-8", newline="") as source:
        reader = csv.DictReader(source, delimiter="\t")
        if not {id_column, *columns}.issubset(reader.fieldnames or []):
            raise ValueError(f"{path.name} lacks required columns")
        rows = {}
        for row in reader:
            key = row[id_column]
            if not key or key in rows:
                raise ValueError(f"{path.name} has a missing or duplicate {id_column} {key!r}")
            rows[key] = row
    return rows


def number(cell):
    if cell in MISSING:
        return None
    value = float(cell)
    if not math.isfinite(value):
        raise ValueError(f"Unexpected non-finite result {cell!r}")
    return value


def numeric_summary(expected, observed, keys, column, tolerance):
    summary = dict(compared=0, bothMissing=0, missingChanges=0, directionChanges=0,
                   outsideTolerance=0, maxAbsoluteDifference=0.0, maxRelativeDifference=0.0)
    examples = []
    for key in keys:
        a, b = number(expected[key][column]), number(observed[key][column])
        if a is None or b is None:
            summary["bothMissing" if a is b else "missingChanges"] += 1
            continue
        summary["compared"] += 1
        delta = abs(a - b)
        if a != 0:
            summary["maxRelativeDifference"] = max(summary["maxRelativeDifference"], delta / abs(a))
        summary["maxAbsoluteDifference"] = max(summary["maxAbsoluteDifference"], delta)
        if column in SIGNED and ((a > 0) - (a < 0)) != ((b > 0) - (b < 0)):
            summary["directionChanges"] += 1
        if delta > tolerance + tolerance * abs(a):
            summary["outsideTolerance"] += 1
            if len(examples) < 8:
                examples.append({"id": key, "reference": a, "replay": b})
    return {**summary, "examplesOutsideTolerance": examples}


def decision(row, effect_threshold=False):
    q = number(row["padj"])
    if q is None:
        return None
    if not effect_threshold:
        return q < 0.05
    lfc = number(row["log2FoldChange"])
    return None if lfc is None else q < 0.05 and abs(lfc) > 1


def compare_table(reference, replay, kind, columns=None, tolerance=1e-8, label_columns=None):
    id_column, _, default_columns = TABLES[kind]
    columns = default_columns if columns is None else columns
    labels = label_columns if label_columns is not None else {"genes": [], "pathways": [], "camera": ["direction"], "samples": ["group"]}[kind]
    extra = labels + (["leadingEdge"] if kind == "pathways" else [])
    a = read_table(reference, id_column, columns + extra)
    b = read_table(replay, id_column, columns + extra)
    keys = sorted(a.keys() & b.keys())
    only_a, only_b = sorted(a.keys() - b.keys()), sorted(b.keys() - a.keys())
    result = {"ids": {"reference": len(a), "replay": len(b), "shared": len(keys),
                      "onlyReference": len(only_a), "onlyReplay": len(only_b),
                      "examplesOnlyReference": only_a[:8], "examplesOnlyReplay": only_b[:8]},
              "numeric": {col: numeric_summary(a, b, keys, col, tolerance) for col in columns}}
    if kind != "samples":
        result["decisions"] = {"bh05": sum(decision(a[k]) != decision(b[k]) for k in keys)}
    if kind == "genes":
        result["decisions"]["bh05_abs_lfc_gt1"] = sum(decision(a[k], True) != decision(b[k], True) for k in keys)
    if kind == "pathways":
        def edge_set(value):
            return set() if value in MISSING else set(filter(None, value.split(";")))
        changed = [k for k in keys if edge_set(a[k]["leadingEdge"]) != edge_set(b[k]["leadingEdge"])]
        result["sets"] = {"changed": len(changed), "examples": changed[:8]}
    result["labelChanges"] = {label: sum(a[k][label] != b[k][label] for k in keys) for label in labels}
    result["withinToleranceAndDecisionsMatch"] = not (only_a or only_b or any(result["labelChanges"].values()) or
        result.get("sets", {}).get("changed") or any(result.get("decisions", {}).values()) or
        any(v["outsideTolerance"] or v["missingChanges"] or v["directionChanges"] for v in result["numeric"].values()))
    return result


def compare_bootstrap(reference, replay):
    fields = ("requested", "valid", "selected", "directionMatches")
    a = {k: v["bootstrap"] for k, v in reference.items() if v.get("bootstrap") is not None}
    b = {k: v["bootstrap"] for k, v in replay.items() if v.get("bootstrap") is not None}
    keys = sorted(a.keys() & b.keys())
    changed = [k for k in keys if any(a[k].get(f) != b[k].get(f) for f in fields)]
    return {"expectedPathways": len(a), "replayPathways": len(b), "sharedPathways": len(keys),
            "missingIds": len(a.keys() ^ b.keys()), "changedPathways": len(changed), "examples": changed[:8]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("project", type=Path)
    parser.add_argument("kit", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    plan = json.loads((args.kit / "selection.json").read_text())
    comparisons = {}
    for cohort in plan["cohorts"]:
        key = cohort["key"]
        base = args.kit / "expected" / key
        run = args.project / cohort["outputDir"]
        prefix = cohort["prefix"]
        tables = {kind: compare_table(base / f"{kind}.tsv.gz", run / (prefix + suffix), kind,
                                      columns=cohort["numericCovariates"] if kind == "samples" else None,
                                      label_columns=["group", *cohort["categoricalCovariates"]] if kind == "samples" else None)
                  for kind, (_, suffix, _) in TABLES.items()}
        evidence = json.loads((run / (prefix + "_evidence.json")).read_text())["evidence"]
        original = json.loads((base / "evidence-summary.json").read_text())
        design_match = all(original["analysis"].get(k) == evidence["analysis"].get(k) for k in original["analysis"])
        comparisons[key] = {"tables": tables, "designAndMethodMatch": design_match,
                            "bootstrap": compare_bootstrap(original["pathways"], evidence["pathways"])}
    matches = all(c["designAndMethodMatch"] and not c["bootstrap"]["missingIds"] and not c["bootstrap"]["changedPathways"]
                  and all(t["withinToleranceAndDecisionsMatch"] for t in c["tables"].values()) for c in comparisons.values())
    report = {"schemaVersion": 1, "comparison": "released macOS arm64 vs Linux",
              "absoluteTolerance": 1e-8, "relativeTolerance": 1e-8,
              "status": "matched" if matches else "differences_observed", "cohorts": comparisons}
    args.output.write_text(json.dumps(report, indent=2, allow_nan=False) + "\n")
    print(report["status"])


if __name__ == "__main__":
    main()
