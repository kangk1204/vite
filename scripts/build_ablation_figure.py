#!/usr/bin/env python3

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
import pandas as pd
import seaborn as sns


ROOT = Path(__file__).resolve().parents[1]


def load_manifest(path_arg: str | None) -> dict:
    manifest_path = (ROOT / (path_arg or "paper/cohort_manifest.json")).resolve()
    if ROOT not in (manifest_path, *manifest_path.parents):
        raise ValueError(f"Path escapes repository root: {path_arg}")
    return json.loads(manifest_path.read_text())


def resolve_root_path(path_value: str) -> Path:
    resolved = (ROOT / path_value).resolve()
    if ROOT not in (resolved, *resolved.parents):
        raise ValueError(f"Path escapes repository root: {path_value}")
    return resolved


def main() -> None:
    import sys

    manifest = load_manifest(sys.argv[1] if len(sys.argv) > 1 else None)
    output_root = resolve_root_path(manifest.get("outputRoot", "paper/outputs"))
    benchmark_dir = output_root / "benchmarks"
    figure_dir = output_root / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)

    ablation = pd.read_csv(benchmark_dir / "ablation_summary.tsv", sep="\t")

    fig = plt.figure(figsize=(12.8, 6.5))
    gs = fig.add_gridspec(1, 2, width_ratios=[1.0, 1.0], wspace=0.28)
    ax_bar = fig.add_subplot(gs[0, 0])
    ax_scatter = fig.add_subplot(gs[0, 1])

    melted = ablation.melt(
        id_vars=["cohort"],
        value_vars=["reference_significant_pathways", "ablation_significant_pathways"],
        var_name="series",
        value_name="count",
    )
    melted["series"] = melted["series"].map({
        "reference_significant_pathways": "Reference design",
        "ablation_significant_pathways": "Simple-group ablation",
    })
    sns.barplot(data=melted, x="count", y="cohort", hue="series", palette=["#0f766e", "#c2410c"], ax=ax_bar)
    ax_bar.set_xlabel("Significant Reactome pathways")
    ax_bar.set_ylabel(None)
    ax_bar.set_title("Pathway-count sensitivity to design simplification", fontsize=12.8, fontweight="bold")
    sns.despine(ax=ax_bar)

    for _, row in ablation.iterrows():
        ax_scatter.scatter(
            row["direction_consistency"],
            row["leading_edge_overlap_score"],
            s=max(120, row["runtime_seconds"] * 4),
            color="#2563eb",
            alpha=0.9,
            edgecolor="#0f172a",
            linewidth=0.8,
        )
        ax_scatter.text(
            row["direction_consistency"] + 0.01,
            row["leading_edge_overlap_score"] + 0.01,
            row["cohort"],
            fontsize=9.3,
            fontweight="bold",
        )

    ax_scatter.set_xlabel("Direction consistency")
    ax_scatter.set_ylabel("Leading-edge overlap score")
    ax_scatter.set_xlim(0.45, 1.02)
    ax_scatter.set_ylim(0.05, 1.02)
    ax_scatter.set_title("Pathway-rank stability under ablation", fontsize=12.8, fontweight="bold")
    ax_scatter.grid(alpha=0.22, linewidth=0.5)
    sns.despine(ax=ax_scatter)

    fig.suptitle(
        "Supplementary Figure S2. Covariate ablation summary",
        fontsize=15,
        fontweight="bold",
        y=0.98,
    )
    fig.text(
        0.055,
        0.02,
        "Bubble size in the right panel reflects ablation runtime in seconds. Reference vs ablation compares full configured design to ~ group only.",
        fontsize=9.4,
        color="#475569",
    )
    fig.savefig(figure_dir / "supplementary_figure_s2_ablation_summary.pdf", bbox_inches="tight")
    fig.savefig(figure_dir / "supplementary_figure_s2_ablation_summary.png", bbox_inches="tight", dpi=320)

    print(f"Wrote ablation figure: {figure_dir / 'supplementary_figure_s2_ablation_summary.pdf'}")


if __name__ == "__main__":
    main()
