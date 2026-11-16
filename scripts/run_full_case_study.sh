#!/usr/bin/env bash
set -euo pipefail

PNV_GIT_COMMIT="${PNV_GIT_COMMIT:-$(git rev-parse --short HEAD 2>/dev/null || printf 'unknown')}"
PNV_REFERENCE_ASSET_VERSION="${PNV_REFERENCE_ASSET_VERSION:-$(node -e \"const fs=require('fs'); const m=JSON.parse(fs.readFileSync('src/reference/generated/metadata.json','utf8')); process.stdout.write(['reactome-'+m.reactomePathways,'hallmark-'+m.hallmarkPathways,'string-'+m.stringScoreCutoff,'huri-'+(m.huriPpiEdges ?? 0),'mode-'+m.hallmarkMode].join('.'));\" 2>/dev/null || printf 'reference-unspecified')}"

export PNV_GIT_COMMIT
export PNV_REFERENCE_ASSET_VERSION

node scripts/run_paper_benchmark.mjs paper/cohort_manifest.json
