# Pathway Network Viewer enables pathway-centered interpretation of bulk RNA-seq and reveals proliferative, interferon, and cornified-envelope programs in psoriasis

## Abstract

Bulk RNA-seq studies routinely produce differential-expression tables and pathway-enrichment outputs, but it remains difficult for experimental researchers to connect enrichment statistics to gene-level network structure in a way that is both interactive and publication-ready. The repository in the current workspace contained an offline pathway-visualization framework, but no biological dataset. We therefore inferred that the underlying research objective was a pathway-centric interpretation workflow for human two-group bulk RNA-seq and selected a public benchmark cohort to evaluate the framework.

Using the human skin RNA-seq dataset `GSE121212`, we analyzed psoriasis lesional skin (`n=28`) against healthy control skin (`n=38`) and validated major findings in matched psoriasis lesional versus non-lesional samples (`27` pairs). Differential expression was performed with `DESeq2`, Reactome pathway enrichment with preranked `fgsea`, and figure generation with `ggplot2` and `matplotlib`. We also exported the analysis into a spreadsheet input file compatible with the offline pathway viewer in this repository.

Psoriasis lesions showed strong separation from healthy skin by principal component analysis and contained `4,527` genes with `FDR < 0.05` and `|log2FC| > 1`. The dominant upregulated Reactome programs were `Cell Cycle, Mitotic` (`NES = 2.84`, `FDR = 8.43 × 10^-43`), `Translation` (`NES = 2.89`, `FDR = 1.22 × 10^-36`), `Neutrophil degranulation` (`NES = 2.60`, `FDR = 3.49 × 10^-29`), `Signaling by Interleukins` (`NES = 2.53`, `FDR = 5.69 × 10^-25`), and `Interferon Signaling` (`NES = 2.68`, `FDR = 8.67 × 10^-23`). Negative programs centered on `Non-integrin membrane-ECM interactions` and `Extracellular matrix organization`. These pathway shifts were robust in paired lesional-versus-uninvolved skin analysis, with `607` significant Reactome pathways shared between contrasts and a Spearman correlation of `0.96` between gene-level effect sizes. A compact pathway-network view further highlighted `Formation of the cornified envelope` (`NES = 2.37`, `FDR = 1.62 × 10^-10`) as a visually coherent epidermal stress module.

Together, these results show that the repository is best interpreted as a methods-oriented bulk RNA-seq interpretation project. The implemented workflow and public case study demonstrate that pathway-level enrichment, leading-edge genes, and STRING-informed connectivity can be synthesized into a coherent biological narrative suitable for manuscript figures and wet-lab review.

## Introduction

Bulk RNA-seq remains a standard assay for profiling disease mechanisms, drug response, and tissue-state transitions. In practice, many studies stop at ranked gene lists and pathway tables, leaving investigators to manually reconcile enrichment statistics with the expression behavior of individual genes. This gap is especially limiting in mechanism-focused studies, where the defensibility of a pathway claim depends not only on its enrichment score, but also on whether its member genes show coordinated and biologically plausible expression changes.

The codebase in the current directory points to a specific solution to this problem: an offline, browser-based viewer that accepts differential-expression statistics, pathway enrichment results, leading-edge genes, and protein-protein interaction priors, then renders them as a combined pathway list, enrichment plot, and STRING-style network. The existing scripts and assets indicate a focus on human bulk RNA-seq, Reactome/Hallmark-style pathway collections, and STRING-based gene connectivity. In other words, the repository is more naturally interpreted as a **methods project for post-analysis pathway storytelling** than as a disease-specific analysis repository.

To ground the software in a real biological use case, we selected `GSE121212`, a public human skin RNA-seq cohort containing atopic dermatitis, psoriasis, and healthy control biopsies. Psoriasis is a strong benchmark for pathway-centric transcriptomics because its biology spans multiple interpretable layers: keratinocyte hyperproliferation, innate immune activation, interleukin signaling, interferon activity, and tissue remodeling. We reasoned that an ideal demonstration dataset should produce both large-scale pathway shifts and compact, gene-level subnetworks suitable for exportable figures.

## Methods

### Study selection and data acquisition

The repository contained no local bulk RNA-seq count matrix or previously computed biological results; therefore, a public benchmark dataset was selected to continue the project. We chose `GSE121212` from GEO because it provides processed read counts, rich phenotype structure, and clear disease-control contrasts in human skin. GEO metadata describe `147` samples from `27` atopic dermatitis patients, `28` psoriasis patients, and `38` healthy controls. The public count matrix (`GSE121212_readcount.txt.gz`) and series metadata (`GSE121212_series_matrix.txt.gz`) were downloaded directly from NCBI GEO.

### Sample annotation

Sample annotations were parsed from GEO sample titles. The primary analysis compared `PSO_lesional` samples against `CTRL_healthy` samples. A secondary validation analysis used only psoriasis cases with paired lesional and non-lesional biopsies; this produced `27` matched pairs (`54` samples total).

### Differential-expression analysis

Counts were analyzed in `DESeq2`. Genes were retained if they had at least `10` counts in at least `15%` of samples within a given contrast. The primary model used `design = ~ group`, and the paired model used `design = ~ patient_id + state`. Reported fold changes were shrunk with `lfcShrink(type = "normal")`. Differentially expressed genes (DEGs) were summarized using `FDR < 0.05` and `|log2FC| > 1`.

### Pathway enrichment

Reactome pathways were obtained from the official Reactome GMT distributed in the repository cache. Genes were preranked by the `DESeq2` Wald statistic, and enrichment was performed with `fgseaMultilevel` using pathway size limits of `15–500` genes. Pathway significance was defined as `FDR < 0.05`. Leading-edge genes were retained as semicolon-delimited strings for downstream network and viewer generation.

### Figures and offline viewer input

Publication figures were generated with `ggplot2`, `ggrepel`, `patchwork`, `pheatmap`, and `matplotlib`. The pathway-network figure used the repository’s built-in STRING-derived adjacency (`src/reference/generated/ppi.json`) and Reactome pathway membership to render leading-edge networks colored by `log2FC` and scaled by `−log10(FDR)`. A compatible spreadsheet input file for the offline viewer was written to `results/psoriasis_pathway_viewer_input.xlsx`, and a fully standalone browser report was rendered to `results/psoriasis_pathway_viewer_report.html`.

### Reproducibility

The full case study can be rerun with:

```bash
./scripts/run_full_case_study.sh
```

The primary analysis script is `scripts/analyze_gse121212_psoriasis.R`, and the selected-pathway network figure is generated by `scripts/render_psoriasis_pathway_figure.py`.

## Results

### 1. The repository is a pathway-interpretation framework rather than a disease-specific project

Inspection of the workspace showed software components for an offline bulk RNA-seq pathway viewer, along with reference assets for HGNC alias normalization, Reactome pathway membership, and STRING protein-protein interactions. No disease-specific count matrix or prior biological analysis was present. This motivated a public benchmark analysis designed to test the intended repository function: transforming DEG and pathway-enrichment outputs into biologically interpretable, figure-grade summaries.

### 2. Psoriasis lesions show large-scale transcriptomic separation from healthy skin

Principal component analysis showed clear separation of psoriasis lesional biopsies from healthy controls (`Figure 1`). The primary DESeq2 analysis tested `21,469` genes and identified `4,527` DEGs at `FDR < 0.05` and `|log2FC| > 1`. Highly induced genes included `IL36G`, `KYNU`, `GJB2`, `FABP5`, `PLA2G4D`, `TMPRSS11D`, `CLEC7A`, `NOD2`, `KLK13`, and `ZC3H12A`, consistent with inflammatory epidermal activation. Representative downregulated genes included `CLDN1`, `PPARGC1A`, `ERBB4`, `PRKCB`, `NFIB`, and `RGMB`, suggesting loss of barrier homeostasis and altered tissue-structural programs.

### 3. The dominant psoriasis pathways combine hyperproliferation with immune activation

Reactome enrichment identified `679` significant pathways in the primary contrast. The strongest positive programs were `Cell Cycle, Mitotic`, `Translation`, `Cell Cycle Checkpoints`, `DNA Replication`, and `G2/M Checkpoints`, indicating a strong proliferative component. In parallel, immune-effector pathways such as `Neutrophil degranulation`, `Signaling by Interleukins`, and `Interferon Signaling` were among the top positive enrichments (`Figure 3`). Negative programs were dominated by `Non-integrin membrane-ECM interactions`, `Extracellular matrix organization`, `ECM proteoglycans`, and related extracellular-structure terms, suggesting a redistribution away from normal stromal and matrix-associated skin programs.

### 4. The pathway architecture is preserved in paired lesional-versus-uninvolved skin comparisons

To assess whether the primary signal was an artifact of unrelated donor-to-donor differences between psoriasis and healthy skin, we repeated the analysis in `27` matched lesional/non-lesional psoriasis pairs. The paired comparison recapitulated the same central themes: `Cell Cycle, Mitotic`, `Cell Cycle Checkpoints`, `Translation`, `DNA Replication`, `Neutrophil degranulation`, and `Signaling by Interleukins` were again strongly enriched, while extracellular-matrix programs remained depleted. Across the two contrasts, `607` Reactome pathways were significant in both, and gene-level log2 fold changes were highly concordant (`Spearman ρ = 0.96`; `Figure 4`). This concordance argues that the dominant biological findings are not dependent on the choice of comparator group.

### 5. A pathway-centered network view highlights compact epidermal stress modules

While broad pathway ranking emphasized cell cycle and immune signaling, the most visually compact and disease-specific module was `Formation of the cornified envelope` (`NES = 2.37`, `FDR = 1.62 × 10^-10`). Its leading-edge network concentrated on keratinization and barrier-remodeling genes including `KRT16`, `KRT6A`, `KRT6B`, `KRT6C`, `IVL`, `TGM1`, `SPRR1A`, `SPRR1B`, `SPRR2A/B/D/E/F/G`, `LCE3A/D/E`, `KLK13`, `KLK8`, `DSC2`, and `DSG3` (`Figure 5`). This module complements the broader interferon and interleukin signatures by showing that psoriasis lesions simultaneously engage a highly coordinated epidermal terminal-differentiation stress response.

### 6. The repository can now generate viewer-ready inputs from a real public dataset

Beyond static figures, the analysis produces both `results/psoriasis_pathway_viewer_input.xlsx` and an automatically rendered `results/psoriasis_pathway_viewer_report.html`. This closes the loop between biological analysis and the repository’s original objective: enabling experimental researchers to inspect pathway enrichment, gene-level expression, and STRING-derived connectivity in a browser without deploying a server.

## Discussion

The combined evidence supports two conclusions. First, the scientific purpose of the repository is best understood as a **pathway-centric interpretation and visualization platform for bulk RNA-seq**, not as a disease-specific analysis repository. Second, when applied to a public psoriasis cohort, the framework recovers a biologically coherent transcriptomic architecture centered on proliferative cell-cycle activation, innate/interleukin/interferon signaling, and epidermal cornified-envelope remodeling.

These findings align with current views of psoriasis as a disease driven by inflammatory cytokine circuits superimposed on keratinocyte-intrinsic activation states. The data do not point to a single isolated pathway; rather, they show a coordinated multi-axis program in which proliferative and immune pathways rise together. The paired lesional-versus-non-lesional analysis is particularly important because it demonstrates that the pathway architecture remains largely intact after controlling for patient-specific background.

From a methods perspective, the study also validates the rationale of the repository design. Pathway tables alone would have highlighted cell-cycle and immune programs, but they would not have clearly shown whether pathway-member genes form compact, interpretable subnetworks. Conversely, a network plot without enrichment statistics would not indicate pathway-level significance. By combining both levels, the repository’s viewer concept addresses a genuine analysis bottleneck for wet-lab researchers who need defensible and exportable pathway figures.

## Limitations

This analysis used public processed read counts rather than raw FASTQ files, so alignment-level quality control and alternative-counting strategies were not re-evaluated. GEO series metadata did not expose a complete batch-covariate table, so explicit batch correction was not modeled. Pathway enrichment was restricted to Reactome because built-in Hallmark full-membership support in the repository remains optional. Finally, the study remains a transcriptomic analysis; it does not directly resolve cell-type composition, spatial context, or protein-level validation.

## Conclusion

The current directory contains a mature starting point for an offline RNA-seq pathway viewer. By attaching a reproducible public benchmark analysis to that framework, we show that the repository can support a methodologically coherent bioinformatics manuscript. In psoriasis skin, the dominant biology converges on hyperproliferation, neutrophil/interleukin/interferon activation, and cornified-envelope remodeling, and these findings can now be explored in both static figure form and viewer-ready workbook form.

## Figure legends

**Figure 1.** Principal component analysis of normalized expression values from psoriasis lesional (`n=28`) and healthy control (`n=38`) skin samples. Lesional samples separate clearly from controls along the dominant variance axis, indicating large-scale transcriptomic remodeling.

**Figure 2.** Volcano plot of DESeq2 results for psoriasis lesions versus healthy control skin. The plot highlights strong induction of canonical inflammatory and epidermal stress genes including `IL36G`, `GJB2`, `FABP5`, `CLEC7A`, and `NOD2`.

**Figure 3.** Reactome preranked GSEA summary for psoriasis lesions versus healthy control skin. Positive enrichment is dominated by mitotic/cell-cycle, translational, neutrophil, interleukin, and interferon pathways, whereas negative enrichment is concentrated in extracellular-matrix programs.

**Figure 4.** Concordance of Reactome pathway normalized enrichment scores between psoriasis lesion-versus-healthy and paired lesion-versus-non-lesional analyses. Most high-confidence pathways remain directionally consistent, supporting robustness to comparator choice.

**Figure 5.** Combined pathway-enrichment and network view for `Formation of the cornified envelope`. The left panel shows STRING-informed edges among leading-edge genes with node size proportional to `−log10(FDR)` and color proportional to `log2FC`; the right panel shows the GSEA running enrichment score. This figure represents the type of pathway-centered summary the offline viewer in this repository is designed to produce interactively.

## Selected references

1. [GSE121212 GEO series](https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE121212)
2. [Tsoi LC et al. 2019. Atopic Dermatitis Is an IL-13-Dominant Disease with Greater Molecular Heterogeneity Compared to Psoriasis.](https://pubmed.ncbi.nlm.nih.gov/30641038/)
3. [Garzorz-Stark N et al. 2020. Progression of acute-to-chronic atopic dermatitis is associated with quantitative rather than qualitative changes in cytokine responses.](https://pubmed.ncbi.nlm.nih.gov/31891686/)
4. [Lawless N et al. 2022. IL-17A and TNF-α inhibitors induce multiple molecular changes in psoriasis.](https://pubmed.ncbi.nlm.nih.gov/36483564/)
5. [Jassal B et al. 2024. The Reactome Pathway Knowledgebase 2024.](https://pubmed.ncbi.nlm.nih.gov/37941124/)
6. [Szklarczyk D et al. 2025. The STRING database in 2025: protein networks with directionality of regulation.](https://pubmed.ncbi.nlm.nih.gov/39558183/)
7. [Rudolph M et al. 2025. Gene-set enrichment analysis and visualization on the web using EnrichmentMap:RNASeq.](https://pubmed.ncbi.nlm.nih.gov/40861393/)
