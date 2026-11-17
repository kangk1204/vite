# Matched PD technical evaluation supplement

This supplement is distinct from the archived PNV software revision. It uses the retained GSE68719 PD analysis (44 controls, 29 PD samples; 23,133 tested genes; 1,342 tested pathways), with R-HSA-449147 fixed before task probing. The frozen task contract has ten tasks and 37 components. These are developer-defined software observations, not human-performance measurements or diagnostic-accuracy estimates.

All three conditions receive the same base companion manifest and case-specific supplied records. Original DESeq2 Wald tests, apeglm effects, fgsea results, identifiers, missingness and leading-edge sets are retained. The original group-only/CAMERA/bootstrap outputs are supplied, not recomputed. Native annotations are visibly prefixed `supplied_`; they are externally computed input evidence, not new native statistical calculations. No task answer summary is injected into reports.

## Versions and native input mapping

Base software: [036ad2f5b9404b6c981bd0c1657f8b56fea89fe6](https://github.com/kangk1204/vite/commit/036ad2f5b9404b6c981bd0c1657f8b56fea89fe6), source snapshot d5972e16793b02848c198a8d94dfbf30428cc6d34855d8187d5dc5c151e0b56f. R 4.5.1 and the archived package lock are the reference environment. GeneTonic 3.4.0 and RNAmel 0.18.1 use their installed public APIs and unchanged native renderers/templates.

GeneTonic receives original results plus common fields through `happy_hour(res_enrich, annotation_obj)`, with explicit `mygenesets` including the target. Its gene annotations retain original rank positions. The native selected-set table receives exact membership, ES reconstruction, model/contrast, group-only, CAMERA, conditional bootstrap and raw delivery fields.

RNAmel receives the same arrays through `contrast_store_upsert()` and `assemble_project()`. Supported contrast keys `covariates`, `treated`, `reference`, `shrink`, and `shrink_used` record the actual upstream model. `settings$enrichment` retains the imported result table, full ordered rank dataframe, membership list, analysis metadata and case context. `save_project()` / `load_project()` is a documented native export requiring R; it is not an HTML control.

RNAmel's generated script is a native template, not the exact imported PNV workflow: its DE minimum-count filter is based on row sums, and its enrichment generator retrieves MSigDB collections rather than the supplied frozen Reactome GMT. Labeled default enrichment and optional WGCNA/signature/activity examples were not executed. Those examples do not identify the actual imported inference. Use the exact reconstruction recipe below. Initial adapter preflight outputs were preserved locally and are not scored as tool defects.

## Exact replay inputs

The compact supplement includes the original 7.46 MB reference RDS, original tables and required raw/reference/source input bytes under `shared-evidence/`. The opaque fitted DDS fixture (238 MB), its fitted cache and three redundant contextual RDS files are retained locally but omitted from the compact upload. Their actual digests and commands are recorded in the fixture receipts. This package does not claim to contain those omitted binaries.

`replay/` contains new evaluation scripts and the frozen contract. Overlay those files onto an extracted copy of the pinned software source. Place this evaluation directory at `paper/outputs/publication_2026_11_17/comparators/` in that source tree. Restore the archived R/Node dependencies and the pinned comparator packages using the original instructions; Pandoc is required for GeneTonic.

```sh
python3 scripts/comparators/restore_pd_sources.py
Rscript scripts/comparators/prepare_pd_fixture.R \
  paper/outputs/publication_2026_11_17/comparators/replay-runs/pd-matched.rds \
  paper/outputs/publication_2026_11_16/gse68719_pd_primary/gse68719_pd_vs_control_reference_input.rds \
  paper/outputs/publication_2026_11_16/gse68719_pd_primary/gse68719_pd_vs_control_report_evidence.json
```

The preparer reconstructs one primary DDS and stops unless the retained primary arrays match within absolute/relative 1e-8, with exact identifiers, missingness and leading-edge sets. It supplies the original arrays after that check. No 500-resample analysis is invoked. Numerical portability across different R builds/platforms is not guaranteed; do not bypass the parity gate. Serialized fixture bytes may vary with paths and R object environments; the recorded execution digest identifies the actual input used here, while the original reference RDS bytes and statistical parity remain independently checkable.

For each neutral context D01, D02 and D03, derive a new fixture with `prepare_pd_delivery.R BASE.rds matched_tasks/deliveries/D01/native-context.json NEW.rds`, then run `node scripts/comparators/run_pd_matched.mjs NEW.rds NEW_OUTPUT_DIRECTORY`. The contextual step performs no fitting and preserves the original arrays exactly. Use new paths to retain prior attempts. Final observed GeneTonic outputs are under `native-deliveries/`; final RNAmel outputs are under `native-rnamel-final/`. The RNAmel official export is `project.rnaflow.rds` beside each HTML.

`native-data-preservation.json` verifies all six final outputs. `preparation-history.json` reports two attempted primary fits and the recovery details honestly. Actual per-run commands, source/package hashes, settings, warnings, stdout/stderr and outputs are retained. Runtime/memory and native/companion byte sizes are descriptive; no controlled task-time or overall-winner claim is made. The browser auditor records visible native, documented native export, embedded machine and common-companion routes separately. T10 is record-only for all tools and has no independent specimen-label evidence.
