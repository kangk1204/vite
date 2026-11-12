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
    benchmark_dir.mkdir(parents=True, exist_ok=True)
    figure_dir.mkdir(parents=True, exist_ok=True)

    scorecard = json.loads((ROOT / "paper/configs/tool_comparison_scorecard.json").read_text())
    criteria = scorecard["criteria"]
    criterion_ids = [entry["id"] for entry in criteria]
    criterion_labels = {entry["id"]: entry["label"] for entry in criteria}

    rows: list[dict[str, object]] = []
    for tool in scorecard["tools"]:
      row = {
          "tool": tool["tool"],
          "source": tool["source"],
          "notes": tool["notes"],
      }
      total = 0
      for criterion in criterion_ids:
          score = int(tool["scores"].get(criterion, 0))
          row[criterion] = score
          total += score
      row["total_score"] = total
      rows.append(row)

    table = pd.DataFrame(rows).sort_values("total_score", ascending=False)
    table.to_csv(benchmark_dir / "tool_comparison_benchmark.tsv", sep="\t", index=False)

    heatmap_frame = table[["tool", *criterion_ids]].set_index("tool").rename(columns=criterion_labels)

    fig = plt.figure(figsize=(13.5, 6.9))
    gs = fig.add_gridspec(1, 2, width_ratios=[1.05, 0.95], wspace=0.22)
    ax_bar = fig.add_subplot(gs[0, 0])
    ax_heat = fig.add_subplot(gs[0, 1])

    sns.barplot(
        data=table,
        y="tool",
        x="total_score",
        hue="tool",
        palette="crest",
        legend=False,
        ax=ax_bar,
    )
    ax_bar.set_xlabel("Workflow score (0-12)")
    ax_bar.set_ylabel(None)
    ax_bar.set_title("Workflow-completeness score", fontsize=13, fontweight="bold")
    for _, row in table.iterrows():
        ax_bar.text(row["total_score"] + 0.15, row["tool"], str(int(row["total_score"])), va="center", fontsize=9.5)
    ax_bar.set_xlim(0, max(table["total_score"]) + 2)
    sns.despine(ax=ax_bar)

    sns.heatmap(
        heatmap_frame,
        annot=True,
        fmt=".0f",
        cmap="YlGnBu",
        vmin=0,
        vmax=2,
        linewidths=0.5,
        cbar_kws={"label": "Criterion score (0 unsupported, 1 partial, 2 first-class)"},
        ax=ax_heat,
    )
    ax_heat.set_title("Per-criterion scorecard", fontsize=13, fontweight="bold")
    ax_heat.set_xlabel(None)
    ax_heat.set_ylabel(None)

    fig.suptitle(
        "Supplementary Figure S1. Workflow-level comparator benchmark against nearby tools",
        fontsize=15,
        fontweight="bold",
        y=0.98,
    )
    fig.text(
        0.055,
        0.02,
        "Scores are assigned from public documentation and papers, emphasizing intake, delivery, provenance, and rerun behavior.",
        fontsize=9.4,
        color="#475569",
    )
    fig.savefig(figure_dir / "supplementary_figure_s1_tool_comparison.pdf", bbox_inches="tight")
    fig.savefig(figure_dir / "supplementary_figure_s1_tool_comparison.png", bbox_inches="tight", dpi=320)

    print(f"Wrote tool comparison benchmark: {benchmark_dir / 'tool_comparison_benchmark.tsv'}")
    print(f"Wrote comparator figure: {figure_dir / 'supplementary_figure_s1_tool_comparison.pdf'}")


if __name__ == "__main__":
    main()
