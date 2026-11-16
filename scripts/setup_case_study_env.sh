#!/usr/bin/env bash
set -euo pipefail

python3 -m venv .venv
. .venv/bin/activate
python -m pip install -r requirements.lock.txt
Rscript scripts/restore_analysis_env.R

echo "Environment setup complete."
