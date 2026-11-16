#!/usr/bin/env python3

from __future__ import annotations

import json
from pathlib import Path

import matplotlib.pyplot as plt
from matplotlib.patches import FancyArrowPatch, FancyBboxPatch
import pandas as pd
import seaborn as sns


ROOT = Path(__file__).resolve().parents[1]
ROLE_COLORS = {
    "primary": "#0f766e",
    "replication": "#7c3aed",
    "extension": "#c2410c",
    "orthogonal_extension": "#2563eb",
}
PROVENANCE_FIELDS = [
    "dataset identifier",
    "contrast definition",
    "sample-group source",
    "batch-handling rule",
    "analysis timestamp",
    "git commit",
    "reference asset version",
]
ROLE_LABELS = {
    "primary": "PRIMARY",
    "replication": "REPLICATION",
    "extension": "EXTENSION",
    "orthogonal_extension": "ORTHOGONAL",
}


def load_manifest(manifest_arg: str | None) -> tuple[dict, Path]:
    manifest_path = (ROOT / (manifest_arg or "paper/cohort_manifest.json")).resolve()
    if ROOT not in (manifest_path, *manifest_path.parents):
        raise ValueError(f"Path escapes repository root: {manifest_arg}")
    return json.loads(manifest_path.read_text()), manifest_path


def resolve_root_path(path_value: str) -> Path:
    resolved = (ROOT / path_value).resolve()
    if ROOT not in (resolved, *resolved.parents):
        raise ValueError(f"Path escapes repository root: {path_value}")
    return resolved


def build_replication_summary_figure(output_root: Path, manifest: dict, cohort_summary: pd.DataFrame) -> None:
    figure_dir = output_root / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)

    summary = cohort_summary.copy()
    summary["role"] = summary["role"].fillna("replication")
    summary["significant_pathways"] = pd.to_numeric(summary["significant_pathways"], errors="coerce")
    summary["direction_consistency"] = pd.to_numeric(summary["direction_consistency"], errors="coerce")
    summary["leading_edge_overlap_score"] = pd.to_numeric(summary["leading_edge_overlap_score"], errors="coerce")
    summary["runtime_seconds"] = pd.to_numeric(summary["runtime_seconds"], errors="coerce")
    summary["n_samples"] = pd.to_numeric(summary["n_samples"], errors="coerce")

    summary = summary.sort_values(["role", "significant_pathways"], ascending=[True, False])

    fig = plt.figure(figsize=(13.2, 6.9))
    gs = fig.add_gridspec(1, 2, width_ratios=[1.15, 1.0], wspace=0.28)
    ax_bar = fig.add_subplot(gs[0, 0])
    ax_scatter = fig.add_subplot(gs[0, 1])

    bar_colors = [ROLE_COLORS.get(role, "#475569") for role in summary["role"]]
    ax_bar.barh(summary["cohort"], summary["significant_pathways"], color=bar_colors, alpha=0.92)
    ax_bar.invert_yaxis()
    ax_bar.set_xlabel("Significant Reactome pathways (FDR < 0.05)")
    ax_bar.set_ylabel(None)
    ax_bar.set_title("Cross-cohort pathway yield", fontsize=13, fontweight="bold")
    for index, row in summary.iterrows():
        ax_bar.text(
            row["significant_pathways"] + 8,
            row["cohort"],
            f"n={int(row['n_samples'])} | {row['runtime_seconds']:.1f}s",
            va="center",
            fontsize=9.5,
            color="#334155",
        )
    sns.despine(ax=ax_bar)

    for _, row in summary.iterrows():
        size = max(120, row["n_samples"] * 9)
        ax_scatter.scatter(
            row["direction_consistency"],
            row["leading_edge_overlap_score"],
            s=size,
            color=ROLE_COLORS.get(row["role"], "#475569"),
            alpha=0.9,
            edgecolor="#0f172a",
            linewidth=0.8,
        )
        ax_scatter.text(
            row["direction_consistency"] + 0.012,
            row["leading_edge_overlap_score"] + 0.008,
            row["dataset_identifier"],
            fontsize=9.5,
            fontweight="bold",
        )

    ax_scatter.set_xlim(0.45, 1.05)
    ax_scatter.set_ylim(0.12, 1.05)
    ax_scatter.set_xlabel("Direction consistency vs primary cohort")
    ax_scatter.set_ylabel("Leading-edge overlap score")
    ax_scatter.set_title("Replication is partial across diseases", fontsize=13, fontweight="bold")
    ax_scatter.grid(alpha=0.22, linewidth=0.5)
    sns.despine(ax=ax_scatter)

    fig.suptitle(
        "Figure 4. Four-benchmark mental/neural summary",
        fontsize=15,
        fontweight="bold",
        y=0.98,
    )
    fig.text(
        0.055,
        0.02,
        "Primary cohort anchors the comparison at direction consistency = 1 and overlap = 1 by definition.",
        fontsize=9.5,
        color="#475569",
    )

    fig.savefig(figure_dir / "figure4_neural_replication_summary.pdf", bbox_inches="tight")
    fig.savefig(figure_dir / "figure4_neural_replication_summary.png", bbox_inches="tight", dpi=320)


def draw_step(ax, x: float, y: float, w: float, h: float, title: str, body: str, face: str) -> None:
    patch = FancyBboxPatch(
        (x, y),
        w,
        h,
        boxstyle="round,pad=0.02,rounding_size=0.03",
        linewidth=1.2,
        edgecolor="#cbd5e1",
        facecolor=face,
    )
    ax.add_patch(patch)
    ax.text(x + 0.025, y + h - 0.055, title, fontsize=10.6, fontweight="bold", color="#0f172a")
    ax.text(x + 0.025, y + 0.045, body, fontsize=8.35, color="#334155", va="bottom", linespacing=1.22)


def build_delivery_figure(output_root: Path, manifest: dict, cohort_summary: pd.DataFrame) -> None:
    figure_dir = output_root / "figures"
    figure_dir.mkdir(parents=True, exist_ok=True)

    fig = plt.figure(figsize=(13.8, 7.0))
    ax = fig.add_subplot(111)
    ax.set_axis_off()
    ax.set_xlim(0, 1)
    ax.set_ylim(0, 1)

    draw_step(
        ax,
        0.04,
        0.66,
        0.20,
        0.18,
        "Public GEO intake",
        "NCBI counts +\nseries matrix\nsubset rules locked.",
        "#eef6ff",
    )
    draw_step(
        ax,
        0.30,
        0.66,
        0.23,
        0.18,
        "Differential analysis",
        "DESeq2 + covariates\nthen preranked\nReactome fgsea.",
        "#f8f5ff",
    )
    draw_step(
        ax,
        0.58,
        0.66,
        0.17,
        0.18,
        "Workbook bridge",
        "Excel contract +\nproject provenance.",
        "#fdf2f8",
    )
    draw_step(
        ax,
        0.80,
        0.66,
        0.16,
        0.18,
        "Standalone delivery",
        "Offline report,\nfigures, and\nmanifest reruns.",
        "#f0fdf4",
    )

    for start, end in [(0.24, 0.30), (0.53, 0.58), (0.75, 0.80)]:
        arrow = FancyArrowPatch((start, 0.75), (end, 0.75), arrowstyle="-|>", mutation_scale=15, linewidth=1.35, color="#64748b")
        ax.add_patch(arrow)

    ax.text(0.04, 0.50, "Active report package", fontsize=12.0, fontweight="bold", color="#0f172a")
    card_width = 0.31
    card_height = 0.13
    for idx, row in enumerate(cohort_summary.itertuples(index=False)):
        col = idx % 2
        row_index = idx // 2
        x = 0.04 + col * 0.335
        y = 0.315 - row_index * 0.18
        card = FancyBboxPatch(
            (x, y),
            card_width,
            card_height,
            boxstyle="round,pad=0.02,rounding_size=0.03",
            linewidth=1.1,
            edgecolor="#cbd5e1",
            facecolor="white",
        )
        ax.add_patch(card)
        color = ROLE_COLORS.get(row.role, "#475569")
        badge_width = 0.128 if row.role == "orthogonal_extension" else 0.108
        ax.add_patch(FancyBboxPatch((x + 0.015, y + card_height - 0.043), badge_width, 0.024, boxstyle="round,pad=0.01,rounding_size=0.02", linewidth=0, facecolor=color))
        ax.text(x + 0.015 + badge_width / 2, y + card_height - 0.031, ROLE_LABELS.get(row.role, str(row.role).upper()), ha="center", va="center", fontsize=6.15, color="white", fontweight="bold")
        contrast_label = str(row.contrast).replace("_", " ")
        report_label = Path(row.report_path).name.replace(".report.html", ".html")
        if len(report_label) > 42:
            report_label = f"{report_label[:39]}..."
        ax.text(x + 0.015, y + 0.064, f"{row.dataset_identifier} | {contrast_label}", fontsize=7.35, fontweight="bold", color="#0f172a")
        ax.text(x + 0.015, y + 0.039, f"{int(row.n_samples)} samples | {int(row.significant_pathways)} pathways", fontsize=7.25, color="#334155")
        ax.text(x + 0.015, y + 0.017, f"{report_label} | {float(row.runtime_seconds):.1f}s", fontsize=6.75, color="#475569")

    ax.text(0.75, 0.50, "Provenance fields expected in every report", fontsize=12.0, fontweight="bold", color="#0f172a")
    for idx, field in enumerate(PROVENANCE_FIELDS):
        ax.text(0.75, 0.45 - idx * 0.044, f"- {field}", fontsize=9.4, color="#334155")

    fig.suptitle(
        "Figure 5. Standalone report contract and provenance-aware delivery",
        fontsize=13.7,
        fontweight="bold",
        y=0.96,
    )
    fig.subplots_adjust(left=0.02, right=0.985, top=0.89, bottom=0.05)
    fig.savefig(figure_dir / "figure5_report_delivery_contract.pdf", bbox_inches="tight")
    fig.savefig(figure_dir / "figure5_report_delivery_contract.png", bbox_inches="tight", dpi=320)


def main() -> None:
    manifest, manifest_path = load_manifest(None if len(__import__("sys").argv) < 2 else __import__("sys").argv[1])
    output_root = resolve_root_path(manifest.get("outputRoot", "paper/outputs"))
    cohort_summary = pd.read_csv(output_root / "benchmarks" / "cohort_summary.tsv", sep="\t")

    build_replication_summary_figure(output_root, manifest, cohort_summary)
    build_delivery_figure(output_root, manifest, cohort_summary)
    print(f"Wrote paper summary figures under {output_root / 'figures'}")
    print(f"Manifest: {manifest_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
