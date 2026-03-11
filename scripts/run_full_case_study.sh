#!/usr/bin/env bash
set -euo pipefail

Rscript scripts/analyze_gse121212_psoriasis.R
.venv/bin/python scripts/render_psoriasis_pathway_figure.py
node scripts/build_report_from_workbook.mjs \
  results/psoriasis_pathway_viewer_input.xlsx \
  results/psoriasis_pathway_viewer_report.html
