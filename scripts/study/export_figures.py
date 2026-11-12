#!/usr/bin/env python3
"""Render source-backed evaluation figures; reject synthetic/pending main results."""
import argparse
import hashlib
import json
import math
from pathlib import Path


def extract_points(data, kind, dry_run=False):
    if kind == "user":
        expected = "software-smoke-only-not-human-evidence" if dry_run else "main-analysis"
        origin = "synthetic" if dry_run else "human"
        if data.get("status") != expected or data.get("dataOrigin") != origin:
            raise ValueError("User figures require completed main human results, or explicit --dry-run synthetic smoke results.")
        if data.get("participants", 0) < 2:
            raise ValueError("No participant-level estimates available.")
        effect = data.get("primary", {})
        points = [("Full − basic error rate", effect.get("estimate"), effect.get("interval"))]
    else:
        if data.get("status") != "independently-adjudicated" or data.get("dataOrigin") != "expert-adjudicated-cases":
            raise ValueError("Detector figures require independently adjudicated result metadata.")
        points = [(name.capitalize(), data.get(name, {}).get("estimate"), data.get(name, {}).get("interval")) for name in ["sensitivity", "specificity"]]
    for _, value, interval in points:
        if not isinstance(value, (int, float)) or not math.isfinite(value) or not isinstance(interval, list) or len(interval) != 2 or any(not isinstance(x, (int, float)) or not math.isfinite(x) for x in interval) or not interval[0] <= value <= interval[1]:
            raise ValueError("Missing effect or uncertainty interval; no figure can be drawn.")
    return points


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("output_dir", type=Path)
    parser.add_argument("--kind", choices=["user", "detector"], required=True)
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    raw = args.input.read_bytes()
    data = json.loads(raw)
    points = extract_points(data, args.kind, args.dry_run)
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, ax = plt.subplots(figsize=(6.4, 2.4 + 0.4 * len(points)))
    for i, (label, estimate, interval) in enumerate(points):
        ax.errorbar(estimate, i, xerr=[[max(0, estimate-interval[0])], [max(0, interval[1]-estimate)]], fmt="o", color="#155e75", capsize=5)
    ax.set_yticks(range(len(points)), [p[0] for p in points])
    ax.set_xlabel("Error-rate difference (95% participant bootstrap interval)" if args.kind == "user" else "Proportion (95% Wilson interval)")
    ax.axvline(0, color="#94a3b8", linewidth=0.8)
    ax.spines[["top", "right"]].set_visible(False)
    title = "User evaluation" if args.kind == "user" else "Artifact detection"
    if args.dry_run:
        title = "SYNTHETIC SOFTWARE CHECK — NOT HUMAN EVIDENCE\n" + title
    ax.set_title(title, fontsize=10)
    fig.tight_layout()
    args.output_dir.mkdir(parents=True, exist_ok=True)
    stem = ("DRY_RUN_" if args.dry_run else "") + args.kind + "_evaluation"
    outputs = []
    for extension in ["png", "pdf", "svg"]:
        target = args.output_dir / f"{stem}.{extension}"
        fig.savefig(target, dpi=300)
        outputs.append(str(target))
    plt.close(fig)
    table = args.output_dir / f"{stem}.source.tsv"
    table.write_text("measure\testimate\tlower95\tupper95\n" + "".join(f"{label}\t{value}\t{interval[0]}\t{interval[1]}\n" for label, value, interval in points))
    manifest = {"input": str(args.input), "inputSha256": hashlib.sha256(raw).hexdigest(), "dataOrigin": data.get("dataOrigin"), "dryRun": args.dry_run, "outputs": outputs, "sourceTable": str(table)}
    (args.output_dir / f"{stem}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps(manifest))


if __name__ == "__main__":
    main()
