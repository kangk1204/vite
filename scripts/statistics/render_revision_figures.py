#!/usr/bin/env python3
"""Render source-backed R1 supplements with PNG/PDF/SVG, source manifests and legends."""
import argparse
import hashlib
import json
import textwrap
from pathlib import Path

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

COLORS = {"PD": "#176788", "MDD": "#b34968"}


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def configure():
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 9, "axes.titlesize": 10,
        "axes.labelsize": 9, "xtick.labelsize": 8, "ytick.labelsize": 8,
        "axes.spines.top": False, "axes.spines.right": False, "svg.fonttype": "none",
        "pdf.fonttype": 42, "savefig.facecolor": "white"})


def export(fig, stem, output, sources, legend):
    output.mkdir(parents=True, exist_ok=True)
    artifacts = []
    for extension in ("png", "pdf", "svg"):
        path = output / f"{stem}.{extension}"
        fig.savefig(path, dpi=320, bbox_inches="tight", metadata={"Creator": "Pathway Network Viewer revision diagnostics"} if extension != "png" else None)
        artifacts.append({"path": str(path), "sha256": sha(path), "bytes": path.stat().st_size})
    plt.close(fig)
    (output / f"{stem}.legend.md").write_text(legend + "\n")
    manifest = {"figure": stem, "renderer": {"path": __file__, "sha256": sha(Path(__file__))},
                "sourceData": [{"path": str(p), "sha256": sha(p)} for p in sources], "exports": artifacts}
    (output / f"{stem}.manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


def bootstrap_figure(root, output, kind):
    names = {"PD": "gse68719_pd_primary", "MDD": "gse102556_mdd_extension"}
    datasets, sources = {}, []
    for label, key in names.items():
        datasets[label] = {}
        sources.append(root / f"{key}_derivation.json")
        for part in ("precision", "convergence", "split", "thresholds"):
            file = root / f"{key}_{part}.tsv"
            datasets[label][part] = pd.read_csv(file, sep="\t")
            sources.append(file)
    fig, axes = plt.subplots(2, 2, figsize=(11.8, 9), layout="constrained")
    for label, ax, panel in zip(names, axes[0], ("A", "B")):
        table = datasets[label]["convergence"]
        ax.plot(table.replicates, table.below_half, "o-", color=COLORS[label], linewidth=1.7, markersize=4)
        ax.axhline(table.below_half.iloc[-1], color=COLORS[label], linestyle="--", alpha=.6)
        ax.set(title=f"{panel}  {label}: cumulative selection summary", xlabel="Number of stored resamples",
               ylabel="Originally significant pathways\nwith selection frequency <0.5")
        ax.set_xticks([50, 100, 200, 300, 400, 500])
        ax.grid(axis="y", alpha=.15)
    ax = axes[1, 0]
    for label in names:
        table = datasets[label]["split"]
        table = table[table.originally_significant]
        ax.scatter(table.first_frequency, table.last_frequency, s=11, alpha=.4,
                   color=COLORS[label], label=f"{label} (n={len(table)})", edgecolors="none")
    ax.plot([0, 1], [0, 1], color="#58616e", linewidth=.8)
    ax.axvline(.5, color="#777", linestyle=":", linewidth=.8)
    ax.axhline(.5, color="#777", linestyle=":", linewidth=.8)
    ax.set(title="C  First and last halves of the stored sequence", xlabel="Selection frequency, first 250 draws",
           ylabel="Selection frequency, last 250 draws", xlim=(-.02, 1.02), ylim=(-.02, 1.02))
    ax.legend(frameon=False, loc="upper left")
    chosen = []
    for label in names:
        table = datasets[label]["precision"]
        table = table[table.originally_significant].copy()
        table["distance"] = abs(table.selection_frequency - .5)
        table = table.sort_values(["distance", "pathway_id"]).head(8)
        table["cohort"] = label
        chosen.append(table)
    chosen = pd.concat(chosen, ignore_index=True)
    out_data = root / "plotted_boundary_pathways.tsv"
    chosen.to_csv(out_data, sep="\t", index=False)
    sources.append(out_data)
    ax = axes[1, 1]
    for i, row in enumerate(chosen.itertuples()):
        ax.errorbar(row.selection_frequency, i,
                    xerr=[[row.selection_frequency-row.selection_lower], [row.selection_upper-row.selection_frequency]],
                    color=COLORS[row.cohort], fmt="o", markersize=3.5, linewidth=1.1, capsize=2)
    ax.axvline(.5, color="#777", linestyle="--", linewidth=.8)
    ax.set_yticks(np.arange(len(chosen)), [f"{r.cohort} · {r.pathway_id}" for r in chosen.itertuples()], fontsize=7)
    ax.invert_yaxis()
    ax.set(title="D  Near-boundary Monte Carlo precision", xlabel="Selection frequency and 95% Wilson interval")
    fig.suptitle(f"Conditional pathway reselection precision — {kind}", fontsize=13)
    legend = f"""# Bootstrap precision ({kind})

Panels A and B show cumulative counts at the prespecified increments of 50 stored draws through 500. The dashed lines mark the complete 500-draw summaries. Panel C compares the first and last 250 draws, using the original-analysis significant pathways. Panel D shows the eight originally significant pathways per cohort closest to a selection frequency of 0.5, with ties ordered by pathway ID. Its exact rows are in plotted_boundary_pathways.tsv. Points are selected/valid counts. The unadjusted Wilson 95% intervals describe finite Monte Carlo precision conditional on a testable resample. Both sample resampling and fgsea's stochastic calculation vary. Pathways overlap, so these are per-pathway precision intervals. Invalid iterations are separated into fit failure, pathway ineligibility and non-finite statistics in the source tables. The source derivation JSON identifies every checkpoint by SHA-256 and records whether these are historical or revised computations. These intervals do not estimate biological uncertainty or the probability of replication in a new cohort.
"""
    export(fig, f"supplementary_bootstrap_precision_{kind}", output, sources, legend)


def cook_figure(root, output):
    file = root / "pathway_comparison.tsv"
    table = pd.read_csv(file, sep="\t")
    summary_path = root / "sensitivity_provenance.json"
    summary = json.loads(summary_path.read_text())
    common = table[table.eligible_primary & table.eligible_exclude_cook].copy()
    changed = common[common.decision_changed.fillna(False)].sort_values(["padj_primary", "pathway_id"])
    fig, axes = plt.subplots(1, 2, figsize=(13.5, 5.8), layout="constrained", gridspec_kw={"width_ratios": [1, 1.55]})
    ax = axes[0]
    ax.scatter(common.NES_primary, common.NES_exclude_cook, s=8, color="#8b9aa8", alpha=.3, edgecolors="none")
    ax.scatter(changed.NES_primary, changed.NES_exclude_cook, s=20, color="#b34968", label="BH decision changed", edgecolors="none")
    limits = [min(common.NES_primary.min(), common.NES_exclude_cook.min()), max(common.NES_primary.max(), common.NES_exclude_cook.max())]
    ax.plot(limits, limits, color="#555", linewidth=.8)
    ax.set(title="A  Enrichment scores on common eligible pathways", xlabel="NES, finite-Wald primary policy", ylabel="NES, Cook-withheld genes excluded")
    ax.legend(frameon=False)
    ax = axes[1]
    for i, row in enumerate(changed.itertuples()):
        a, b = [-np.log10(max(v, 1e-300)) for v in (row.padj_primary, row.padj_exclude_cook)]
        ax.plot([a, b], [i, i], color="#bdc6ce", linewidth=1.3)
        ax.scatter(a, i, c="#176788", s=27, label="Primary" if i == 0 else None)
        ax.scatter(b, i, c="#b34968", s=27, marker="s", label="Cook exclusion" if i == 0 else None)
    ax.axvline(-np.log10(.05), color="#777", linestyle="--", linewidth=.8)
    ax.set_yticks(np.arange(len(changed)), [textwrap.fill(x, 40) for x in changed.pathway_name], fontsize=7.5)
    ax.invert_yaxis()
    ax.set(title="B  Common pathways crossing BH 0.05", xlabel="−log10(BH-adjusted p value)")
    ax.set_ylim(len(changed) + 1.2, -0.5)
    ax.legend(frameon=False, loc="lower right")
    fig.suptitle(f"AKAP11 Cook-exclusion sensitivity: {summary['excludedCookGenes']} genes; "
                 f"{summary['primarySignificant']} → {summary['sensitivitySignificant']} significant pathways", fontsize=12)
    legend = """# AKAP11 Cook-withheld rank sensitivity

The revised ordinary AKAP11 analysis supplies the original DESeq2 Wald statistics and per-gene Cook flags. The primary policy retains every finite original Wald statistic. The sensitivity removes only finite-ranked genes whose p value was withheld by the default Cook filter. All fgsea settings, seed, pathway size limits, count preprocessing and model fitting are fixed. Panel A shows common eligible pathways, with changed BH decisions highlighted. Panel B shows every common pathway crossing BH 0.05, with the threshold indicated by a dashed line. The comparison table also contains pathways whose eligibility changed, primary leading-edge Cook genes, and leading-edge Jaccard similarity. A seeded primary-rank replay was checked against the actual revised output before sensitivity. The primary analysis remains the prespecified finite-Wald policy.
"""
    export(fig, "supplementary_akap11_cook_sensitivity", output, [file, summary_path], legend)


def camera_figure(root, output):
    source = root / "camera_pathway_diagnostics.tsv"
    summary_file = root / "camera_cohort_summary.tsv"
    data = pd.read_csv(source, sep="\t")
    summary = pd.read_csv(summary_file, sep="\t")
    colors = {"PD": "#176788", "AD": "#aa7536", "MDD": "#b34968", "AKAP11": "#497f52", "airway": "#7551a6"}
    fig, axes = plt.subplots(1, 2, figsize=(10.6, 4.5), layout="constrained")
    for cohort, color in colors.items():
        values = np.sort(data.loc[data.cohort == cohort, "Correlation"].dropna())
        axes[0].plot(values, np.arange(1, len(values)+1)/len(values), color=color, label=cohort, linewidth=1.5)
    axes[0].axvline(0, color="#999", linestyle=":", linewidth=.8)
    axes[0].set(title="A  Estimated within-set residual correlations", xlabel="CAMERA-reported Correlation", ylabel="Cumulative proportion of tested pathways")
    axes[0].legend(frameon=False)
    x = np.arange(len(summary))
    axes[1].bar(x-.18, summary.fgsea_significant, .36, color="#176788", label="fgsea")
    axes[1].bar(x+.18, summary.camera_significant, .36, color="#b27b49", label="CAMERA")
    for i, row in enumerate(summary.itertuples()):
        for offset, number in ((-.18, row.fgsea_significant), (.18, row.camera_significant)):
            axes[1].annotate(str(number), (i+offset, number), xytext=(0, 3), textcoords="offset points", ha="center", fontsize=8)
    axes[1].set_xticks(x, summary.cohort)
    axes[1].set(title="B  Distinct tests at BH <0.05", ylabel="Pathways meeting each test's threshold")
    axes[1].set_ylim(0, max(summary.fgsea_significant.max(), summary.camera_significant.max())*1.15+1)
    axes[1].legend(frameon=False)
    legend = """# CAMERA correlation and method sensitivity

Panel A displays all available Correlation values returned by CAMERA, using TMM normalization, voom observation weights, per-set estimated inter-gene correlation (`inter.gene.cor=NA`), `allow.neg.cor=FALSE`, `use.ranks=FALSE`, `trend.var=FALSE`, `directional=TRUE`, and unsorted output. NGenes and the raw reported correlation are preserved in the source table. Panel B reports counts passing BH 0.05 separately for the existing DESeq2-Wald/fgsea and voom/CAMERA methods. Their null hypotheses and treatment of within-set dependence differ, so these counts are descriptive method sensitivity rather than an accuracy score. The cohort summary also includes direction counts, correlation quantiles, adjusted-p summaries, gene-set size ranges, and a descriptive signed-rank correlation.
"""
    export(fig, "supplementary_camera_correlation", output, [source, summary_file, root / "diagnostic_sources.json"], legend)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path("paper/outputs/publication_2026_11_16/statistics"))
    parser.add_argument("--bootstrap-kind", choices=["historical", "revised"], default="historical")
    parser.add_argument("--skip-cook", action="store_true")
    args = parser.parse_args()
    configure()
    bootstrap_figure(args.root / f"{args.bootstrap_kind}-bootstrap", args.root / "figures", args.bootstrap_kind)
    if not args.skip_cook:
        cook_figure(args.root / "akap11-cook-sensitivity", args.root / "figures")
    if (args.root / "camera-and-fit/camera_cohort_summary.tsv").exists():
        camera_figure(args.root / "camera-and-fit", args.root / "figures")
