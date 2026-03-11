# Reproducibility

## Environment

- R `4.5.1`
- Python virtual environment at `.venv`
- Node.js `25.8.0`

## Setup

```bash
./scripts/setup_case_study_env.sh
```

## One-command rerun

```bash
./scripts/run_full_case_study.sh
```

## Main outputs

- Differential expression: `results/psoriasis_lesional_vs_healthy_deseq2.tsv`
- Reactome GSEA: `results/psoriasis_lesional_vs_healthy_fgsea_reactome.tsv`
- Paired validation: `results/psoriasis_lesional_vs_nonlesional_paired_deseq2.tsv`
- Viewer workbook: `results/psoriasis_pathway_viewer_input.xlsx`
- Standalone interactive report: `results/psoriasis_pathway_viewer_report.html`
- Figures: `figures/`

## Notes

- The repository’s original software assets contained no local biological dataset, so this case study uses a public benchmark from GEO (`GSE121212`).
- The selected pathway-network figure and standalone report use the repository’s built-in STRING-derived adjacency and Reactome pathway membership.
