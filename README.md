# Pathway Network Viewer

Local R analysis and evidence-linked offline reports for human bulk RNA-seq. GEO discovery and sample assignment run in the browser; inference uses DESeq2, apeglm and fgsea in R. Results become a standalone interactive `report.html` with `PDF` / `SVG` / `PNG` / `JPG` exports. User-prepared workbooks and versioned JSON results can also be imported without inventing missing provenance.

This is a research software implementation. External expert adjudication, participant recruitment, preregistration and the user study are pending; the repository does not yet establish that the software reduces interpretation errors. The evaluation protocol and verified computational results are in `paper/evaluation/PROTOCOL.md` and `paper/implementation_status.md`. Live study cases and private adjudication materials are distributed separately to the study team.

## Reviewer quick start

Download the offline reviewer ZIP from the [publication release](https://github.com/kangk1204/vite/releases/tag/publication-2026-11-12), extract it, and open `index.html`. The guided task follows Signaling by Interleukins through the exact PD pathway row, 473 of 500 sample refits and the CAMERA result. The source tables, full PD report and replay instructions are in the same package. `CITATION.cff` gives the software citation.

## What ships

- `builder.html` served locally for GEO discovery, input-bundle preparation, and result import
- standalone `report.html` generator with:
  - pathway-synced network + enrichment plot
  - leading-edge / all-genes toggle
  - gene-level DEG + expression detail
  - figure export presets
  - explicit method, provenance verification state and descriptive sensitivity evidence
- methods-facing paper pipeline with:
  - cohort-manifest benchmark runner
  - provenance-tagged standalone reports
  - paper-ready output directories for tables, reports, figures, and benchmarks

## Workbook contract

Required sheets:

- `Project`
  - required: `project_title`, `contrast_name`, `condition_a`, `condition_b`, `species`
  - optional provenance fields: `dataset_identifier`, `contrast_definition`, `sample_group_source`, `batch_handling_rule`, `analysis_timestamp`, `git_commit`, `reference_asset_version`, `notes`
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
npm run dev
```

Open the local URL printed by Vite. The builder requires HTTP serving; opening `dist/builder.html` directly through `file://` is unsupported. Generated report HTML files are self-contained and open offline.

The builder lets you:

- import a completed workbook or v2 viewer JSON
- search GEO (`GSE*` or keyword) and discover NCBI-generated raw counts
- prepare local analysis from downloaded GEO files (`raw_counts*.tsv(.gz)` + `*_series_matrix.txt(.gz)`)
- assign groups and optional batch, then download the analysis-input JSON
- review validation issues
- download a standalone `report.html`

Restore the measured R/Python environments once, then execute the downloaded input:

```bash
bash scripts/setup_case_study_env.sh
npm run analyze:local -- study.pnv-input.json --output results/local-study
```

The local runner writes analysis tables, a workbook, evidence metadata, viewer JSON, and report HTML. Import the result workbook/JSON to inspect or export it in the builder, or open the generated report directly. Browser analysis entrypoints no longer compute inferential statistics.

The main analysis preserves DESeq2 Wald p-values and statistics, uses apeglm only for displayed effect sizes, and runs fgsea on the original Wald ranks. CAMERA is a separate method-sensitivity result. Sample bootstrap frequencies are descriptive, with failed fits and valid denominators exposed; they are not new FDR values or probabilities of future replication. No matching pathway produces an empty result, never a fabricated significant signature.

`renv.lock` records actual installed R package versions. `requirements.lock.txt` records the figure environment. `data/reference/manifest.json` hashes the frozen references. The Dockerfile pins R 4.5.1 and Bioconductor 3.22 by registry digest. Restore also checks the three source-pinned packages needed to read compressed GEO files. The Linux replay instructions and operator record are in `paper/evaluation/linux-replay/RUNBOOK.md`.

### GEO search behavior

Public GEO search now uses the live GEO metadata index with these default filters:

- `gse[ETYP]`
- `"Homo sapiens"[Organism]`
- `"expression profiling by high throughput sequencing"[DataSet Type]`

This keeps search fast and current while narrowing results to human RNA-seq studies.
`NCBI-generated raw counts` availability is still checked as a second step on the top candidates.

### Optional shared GEO cache

For multi-user deployments, you can run the bundled shared cache server so multiple browsers reuse the same GEO query/accession results instead of re-hitting NCBI independently.

Start the cache server:

```bash
npm run geo-cache-server
```

Point the Vite app at it:

```bash
VITE_GEO_CACHE_ENDPOINT=http://127.0.0.1:8787 npm run dev
```

The cache server stores:

- query results for 10 minutes
- accession eligibility results for 30 minutes

Optional cache tuning env vars:

- `GEO_QUERY_CACHE_MAX_ENTRIES` (default `128`)
- `GEO_ACCESSION_CACHE_MAX_ENTRIES` (default `2048`)
- `GEO_CACHE_PERSIST_DEBOUNCE_MS` (default `220`)

## GEO quick-start input prep

Two routes are supported:

- Search -> prepare local analysis:
  - Enter a keyword or accession (for example `GSE157951`) in GEO quick search.
  - If `NCBI raw counts available` is shown, open setup, assign samples, and prepare the local input JSON.
- User-prepared files -> prepare local analysis:
  - Download from GEO:
    - `...raw_counts...tsv.gz` (NCBI-generated raw count matrix)
    - `..._series_matrix.txt.gz` (sample metadata for group inference)
  - Upload both files in the builder, prepare the input JSON, and execute the local R command above.

For manual curation or custom statistics, workbook mode remains available with required sheets:
`Project`, `Genes`, and `Pathways`.

## Publication v2 workflow

The publication manifest is `paper/manifests/publication_v2.json`. It preserves all tested pathways for the four neural examples and adds the paired airway integration reference. PD/MDD use 500 seeded sample bootstrap fits; group-only sensitivity runs explicitly use zero bootstrap repetitions and the same included samples.

```bash
npm run paper:benchmark
npm run paper:finalize
```

The benchmark executes the declared R jobs and sensitivity runs. The finalizer checks execution-time hashes and independent package parity, then creates full/basic reports and RO-Crate metadata without starting the primary fits again. It refuses missing or inconsistent results. Bootstrap checkpoints are content-bound and resumable; changed analysis inputs/code/environment invalidate them.

Publication outputs live under `paper/outputs/publication_v2/`:

- cohort subdirectories: complete DE/pathway/CAMERA tables, workbook, sample metadata, evidence, reference-input snapshot and validation results;
- `reports/`: full/basic offline HTML, compact viewer JSON and RO-Crate;
- `benchmarks/`: finalization receipts, source-backed summaries and design-sensitivity results.

Full/basic reports contain identical raw evidence. The full condition additionally connects that information to the selected pathway; the basic condition exposes the same records without integrated interpretation guidance. Verification labels distinguish supplied-artifact checks, internal consistency, unavailable evidence and mismatches. Generation-time verification does not automatically recheck original files when a report is opened offline.

Legacy materials remain available separately:

```bash
npm run paper:benchmark:legacy-neural
npm run paper:benchmark:psoriasis
```

The old `results/`, `figures/`, and `paper/outputs/ymeth_pivot/` assets are historical outputs. Their earlier analysis settings, figure selections and feature-score tables are not validation of the publication v2 implementation. The legacy-neural command retains the old output locations but now invokes the shared R engine: running it regenerates those locations with current methods, rather than reproducing historical statistics. The psoriasis script retains its separate legacy method and is outside v2 validation. Use the publication v2 commands to keep historical outputs separate.

## Evaluation and claims

`paper/evaluation/README.md` documents the executable external-study protocol, comparator adapters, response logger, blinded adjudication, power selection, analysis and figure exporter. Normal/mismatch/insufficient-evidence cases remain unadjudicated until independent researchers review them. Main participant assignment is blocked until the documented institutional, consent, pilot, preregistration and power gates are met.

```bash
npm run study -- status --protocol paper/evaluation/protocol.json
```

Smoke outputs are explicitly synthetic and cannot serve as manuscript human results. The contribution being tested is interpretation support, not a new differential-expression/enrichment method or disease mechanism. Cross-disease overlap is descriptive, conditional on the stated comparison universe.

The search performance utility is retained separately:

```bash
npm run search:benchmark
```

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
npm run typecheck
npm run test:r
npm run build
npm run test:ui
npm run test:e2e
npm run environment:verify
```

Activate the restored Python environment (`source .venv/bin/activate`) for tests and figure generation. Playwright Chromium must be installed for browser checks (`npx playwright install chromium`). These checks exercise private input preparation, workbook/v2 import, offline rendering, null statistics, hostile strings, full/basic evidence equivalence and SVG/PNG/PDF exports. Browser captures and logs are saved under `.cache/verification/`.

The workbook parser is the vendored official SheetJS 0.20.3 archive; see `vendor/README.md`. Re-run `npm audit` when preparing a release. No package audit result is a guarantee against unknown vulnerabilities.

After verification, `python3 scripts/package_source.py` creates a public software source archive with per-file hashes and permissions. Unpublished manuscripts, live evaluation instruments and private adjudication materials are excluded. It includes the actual working source and declares whether it differs from the base Git commit. Raw counts, participant observations and generated reports are excluded. This command does not upload or publish anything.
