# Reproduce the native report comparison

The comparator fixture uses human airway RNA-seq counts for four paired donors. Preparation runs the normal PNV airway annotation and frozen HGNC/NCBI identifier mapping, then the main PNV fitting and pathway functions. An independent direct DESeq2/apeglm/fgsea calculation checks those arrays. The captured PNV arrays become the matched input for both native report consumers.

Run from the repository root after restoring the primary R and Node dependencies. Each output path must be new.

```bash
Rscript scripts/comparators/install.R
Rscript scripts/comparators/prepare_fixture.R /absolute/new/airway-pnv-matched.rds airway data/reference/ReactomePathways.gmt.zip
Rscript tests/comparators/airway-replay.R /absolute/new/airway-pnv-matched.rds
node scripts/comparators/benchmark.mjs /absolute/new/airway-pnv-matched.rds /absolute/new/comparator-runs
node scripts/comparators/check_offline.mjs /absolute/new/comparator-runs/genetonic-matched/metrics.json
node scripts/comparators/check_offline.mjs /absolute/new/comparator-runs/genetonic-defaults/metrics.json
node scripts/comparators/check_offline.mjs /absolute/new/comparator-runs/rnamel-matched/metrics.json
node scripts/comparators/check_offline.mjs /absolute/new/comparator-runs/rnamel-defaults/metrics.json
node scripts/comparators/summarize.mjs /absolute/new/comparator-runs
```

GeneTonic is pinned to 3.4.0 at Bioconductor revision `21785a12d4ffe30af533d0db15b270d80d42be29`. RNAmel is pinned to 0.18.1 at revision `efdd8e3849b2afbf24c933bd5049d55ee4896cbc`. The installer uses `.cache/comparators/R` and records whether each pinned installation was reused or installed. GeneTonic requires Pandoc. Chromium is required for the automated report tasks.

The fixture receipt records the exact identifier convention, input/reference/source hashes, package versions, design, filtering, Wald ranking, gene-set settings and PNV parity. The full matched result objects are saved in the RDS. GeneTonic consumes those objects in both named modes because its report API requires upstream results. RNAmel defaults mode executes its own `run_deseq2()` and `run_gsea()` defaults on the same supplied matrix and metadata. The receipt exposes its actual settings and resulting gene/pathway counts.

Each execution directory contains an executable runner snapshot and helper, actual invocation, complete result tables, native API call records, installed-package hashes and resource measurements. The `manualSteps` record covers interventions during the automated execution after preparation and installation. Human operator time remains unmeasured. Each cell is one observed run with a recorded workload and platform.

The browser audit records whether specified values can be reached in the native report and traces the companion tables to their captured inputs and code. GeneTonic supplies searchable selected-gene and selected-pathway tables. The inspected RNAmel export supplies overview, contrast plots and generated code, while complete numerical results remain in the companion tables. These task-specific observations apply to the recorded package versions.

Use a new fixture and run directory for each independent attempt. The `smoke` fixture option generates explicitly synthetic data for software checks. The earlier raw-airway-symbol fixture and executions are retained with their own receipts as historical observations.
