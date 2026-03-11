# Pathway Network Viewer v1

Offline figure builder for bulk RNA-seq pathway storytelling. The app turns a single Excel workbook into a standalone interactive `report.html` that opens without a server and exports publication-ready `PDF` / `SVG` / `PNG` / `JPG`.

## What ships

- `builder.html` build target for offline workbook upload and validation
- standalone `report.html` generator with:
  - pathway-synced network + enrichment plot
  - leading-edge / all-genes toggle
  - gene-level DEG + expression detail
  - figure export presets

## Workbook contract

Required sheets:

- `Project`
  - `project_title`, `contrast_name`, `condition_a`, `condition_b`, `species`
- `Genes`
  - `gene_symbol`, `log2fc`, `padj`, `pvalue`, `rank_metric`, `condition_a_mean`, `condition_b_mean`
- `Pathways`
  - `pathway_name`, `collection`, `nes`, `padj`, `leading_edge_genes`
  - optional `pathway_id`

Optional sheets:

- `GeneLabels`
- `Samples`
- `CustomPPI`

Use semicolon-separated symbols for `leading_edge_genes`, for example:

```text
TP53;CDKN1A;MDM2
```

## Local usage

```bash
npm install
npm run build
open dist/builder.html
```

The builder lets you:

- download the template workbook
- upload a completed workbook
- search GEO (`GSE*` or keyword), discover NCBI-generated raw counts, and run direct analysis
- analyze from downloaded GEO files (`raw_counts*.tsv(.gz)` + `*_series_matrix.txt(.gz)`)
- review validation issues
- download a standalone `report.html`

## GEO quick-start input prep

Two routes are supported:

- Search -> analyze:
  - Enter a keyword or accession (for example `GSE157951`) in GEO quick search.
  - If `NCBI raw counts available` is shown, run direct analysis.
- User-prepared files -> analyze:
  - Download from GEO:
    - `...raw_counts...tsv.gz` (NCBI-generated raw count matrix)
    - `..._series_matrix.txt.gz` (sample metadata for group inference)
  - Upload both files in the builder and run analysis.

For manual curation or custom statistics, workbook mode remains available with required sheets:
`Project`, `Genes`, and `Pathways`.

## Case study workflow

This repository now includes a complete public benchmark analysis using psoriasis bulk RNA-seq dataset `GSE121212`.

Set up the case-study environment:

```bash
./scripts/setup_case_study_env.sh
```

Run the full case study:

```bash
./scripts/run_full_case_study.sh
```

Main case-study outputs:

- `results/psoriasis_lesional_vs_healthy_deseq2.tsv`
- `results/psoriasis_lesional_vs_healthy_fgsea_reactome.tsv`
- `results/psoriasis_pathway_viewer_input.xlsx`
- `results/psoriasis_pathway_viewer_report.html`
- `figures/figure1_pca_psoriasis_vs_healthy.pdf`
- `figures/figure2_volcano_psoriasis_vs_healthy.pdf`
- `figures/figure3_reactome_fgsea_psoriasis_vs_healthy.pdf`
- `figures/figure4_pathway_concordance.pdf`
- `figures/figure5_selected_pathway_network_and_enrichment.pdf`

The generated `results/psoriasis_pathway_viewer_report.html` is fully standalone and opens directly in a browser without a server.

## Reference assets

The viewer reads built-in JSON assets under `src/reference/generated`.

Generate them with:

```bash
npm run build:ref
```

Notes:

- Reactome, HGNC alias normalization, and STRING processing are scripted by default.
- Hallmark membership is optional in the current asset pipeline because many teams use licensed MSigDB files. To include built-in Hallmark full-membership support, provide a local GMT:

```bash
python3 scripts/build_reference.py --hallmark-gmt /absolute/path/to/h.all.v*.symbols.gmt
```

Without that GMT, Hallmark pathways still work in the viewer via `leading_edge_genes`, but the `all genes` toggle falls back to leading-edge-only for unmatched pathways.

## Validation

```bash
npm test
npx tsc --noEmit
npm run build
```
