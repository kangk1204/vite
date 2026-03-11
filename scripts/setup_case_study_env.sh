#!/usr/bin/env bash
set -euo pipefail

python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -r requirements.txt
Rscript scripts/install_case_study_r_packages.R

echo "Environment setup complete."
