# Evaluation package

This directory contains the external-study protocol. Human reviews and participant responses are pending. Coordinators can start with the invitation and independent-review instructions in `recruitment/README.md`. Software checks use explicitly marked synthetic records.

## Software checks

```bash
npx vitest run tests/studyProtocol.test.js
node scripts/study/run_study.mjs status --protocol paper/evaluation/protocol.json
node scripts/study/smoke.mjs
Rscript scripts/study/power_study.R paper/evaluation/power-config.json /tmp/pnv-power-smoke.json --smoke
```

The first two smoke tools write clearly labeled synthetic artifacts outside the manuscript output directories. Smoke power uses three simulations for execution verification and **cannot select recruitment**. Final power uses at least 1,000 simulations per scenario, a conservative parameter grid, candidate N starting at 24 and increasing by six without an arbitrary recruitment cap. The lower 95% binomial bound must reach 80% in every scenario. Checkpoint output is rewritten after each candidate N; `search-in-progress` is not a final sample-size decision.

## Real study workflow

In the coordinator workspace run `node scripts/study/build_case_packets.mjs`, then `node scripts/study/build_case_packets.mjs --verify paper/outputs/publication_v2/expert_review`. Run `node tests/e2e/case-packets.mjs` for the offline browser audit. Coordinator-only scripts and case inputs stay in the study workspace while independent review and participant data collection are pending. The private coordinator index is `paper/outputs/publication_v2/expert_adjudication/README.md`.

The coordinator workspace builds twelve development and twelve held-out cases with three report conditions and a common evidence sheet. Technical predictions are frozen before independent adjudication. The public software archive includes the protocol and statistical model. Ask the study coordinator for the role-specific materials needed for an assigned review.

Populate a separate copy of `protocol.json` with actual institutional and consent records. Two independent experts must provide adjudicated cases and complete equal-information packets. Pilot assignment requires those prerequisites; main assignment additionally requires six completed pilot participants, preregistration, a frozen protocol hash and a final power result/hash. Final power uses the same held-out case pool and assignment helper as the study; the same model convergence/fallback rules are executed inside every simulation.

```bash
node scripts/study/run_study.mjs assign --protocol /path/protocol.json --participants /path/roster.json --cases /path/adjudicated-cases.json --phase pilot --out /path/pilot-assignment.json
Rscript scripts/study/power_study.R paper/evaluation/power-config.json /path/final-power.json
node scripts/study/run_study.mjs assign --protocol /path/protocol.json --power /path/final-power.json --participants /path/main-roster.json --cases /path/adjudicated-cases.json --phase main --out /path/main-assignment.json
node scripts/study/session_html.mjs /path/main-assignment.json /path/adjudicated-cases.json P001 /path/P001-session.html
node scripts/study/run_study.mjs blind --assignments /path/main-assignment.json --responses /path/responses.json --out /path/blinded-responses.json --key /private/rating-key.json
node scripts/study/run_study.mjs prepare --protocol /path/protocol.json --power /path/final-power.json --assignments /path/main-assignment.json --responses /path/responses.json --ratings /path/agreed-ratings.json --key /private/rating-key.json --phase main --out /path/prepared-analysis.json
Rscript scripts/study/analyze_study.R /path/prepared-analysis.json /path/main-results.json
```

Roster rows: `id`, `experience` (`novice|experienced`), `consent: true`, `wasPilot: false` for main. The complete main roster must equal the frozen planned N; pilot has exactly six. Main tasks use only `held_out` cases, pilot tasks only `development`, with no case-family leakage. Response rows include assigned IDs, `phase`, `dataOrigin: human`, `status` (`completed|timeout|abandoned|system_error`), `elapsedMs`, confidence (0–1; null only for incomplete trials), and answer. Keep all twelve trials including failures. Completed responses after the frozen deadline are invalid.

The standalone session HTML records time/status/answers locally and downloads JSON; it never uploads responses. Cases require a prompt, `reportUrls` for all conditions, and a common `rawEvidenceUrl`. Set `protocol.tutorials[condition]` to separate training text/report/evidence links; these may not reuse held-out task artifacts. Evaluation prompts and links are hidden until their task timer starts. Real sessions enforce equal ten-minute training per condition; dry-run training is zero and records remain synthetic.

Blinded rater exports contain shuffled opaque UUIDs, case IDs and answers, without participant/period/trial IDs. Rater rows contain `ratingId`, independent `raterId`, and boolean `correct`. The private mapping is never supplied to raters. Disagreement blocks preparation until independently resolved and the agreed record/audit trail is retained.

Use `protocolDigest()` from `run_study.mjs` to compute the canonical protocol hash (the hash field itself is nulled). Main assignment checks the actual final power file hash, `power-selected` status, selected N, case-pool hash, seed/statistical targets and study-source hash. Main analysis rechecks the source digest and R/lme4 environment. Changing the assignment/model code after power selection requires repeating the planning/freeze procedure.

Detector evaluation accepts unique held-out case IDs, `truth`, `predicted` (`normal|mismatch|unverifiable`), `adjudicationStatus: adjudicated`, and two nonempty distinct reviewer IDs. It reports Wilson intervals and keeps untestable cases separate.

## Comparator execution

```bash
Rscript scripts/comparators/install.R
Rscript scripts/comparators/prepare_fixture.R /tmp/comparator-smoke.rds smoke
Rscript scripts/comparators/run_comparator.R GeneTonic /tmp/comparator-smoke.rds /tmp/genetonic-smoke matched
Rscript scripts/comparators/run_comparator.R RNAmel /tmp/comparator-smoke.rds /tmp/rnamel-smoke matched
```

Use `defaults` for native defaults. Comparator libraries are isolated in `.cache/comparators/R`. RNAmel's source commit is pinned; installed versions/session info are recorded. Missing dependencies or incompatible inputs are failures, not zero performance. GeneTonic may require its documented `ignore_pandoc` flag with modern built-in citeproc; this workaround is recorded and actual HTML creation is still required.

For real airway comparison, provide a frozen **Ensembl-keyed** pathway RDS to `prepare_fixture.R output.rds airway pathways.rds`; do not substitute synthetic sets. A general fixture RDS has `counts`, `metadata` (sample/group A|B and covariates), `pathways`, `design`, `contrast`, `id`, `dataOrigin`, and optionally `matched` (`dds`, `res`, `enrichment`) from a frozen common input. Matched mode measures delivery; defaults mode also includes native analysis. Preserve original settings and report native differences instead of forcing apparent numerical agreement.

`metrics.json` records only observed metrics. Peak memory, manual steps and offline verification remain null/false until separately measured. Synthetic comparator outputs establish software execution, not publication-level utility.

`node scripts/comparators/benchmark.mjs fixture.rds output-dir` runs both tools in both modes, captures exit status/logs and operating-system peak memory where available, and writes JSON/TSV summaries. `node scripts/comparators/check_offline.mjs metrics.json` performs a network-disabled Chromium initial-render check; this does not certify every widget or export.

Benchmark runners use an immutable hashed copy of the R adapter so source changes during other development cannot alter an active execution. Optional final tool/mode arguments rerun a selected cell. After offline checks or selective reruns, `node scripts/comparators/summarize.mjs output-dir` rebuilds the table from observed metrics. Fixed-order single-run timings are descriptive feasibility evidence, not a controlled performance claim.

## Source-backed evaluation figures

Implementation figures are generated only after all five publication-v2 cohorts are finalized:

```bash
python3 scripts/study/build_implementation_figures.py
```

Main Figure 1 presents all PD/MDD original FDR values and reselection frequencies, plus the minimum-FDR PD pathway. Generate it with `python3 scripts/study/build_case_figure.py` using the finalized cohort artifacts. The software workflow and eighteen integration checks per dataset are Supplementary Figures S1 and S2, generated by `build_implementation_figures.py`. Figure manifests record the source paths, hashes and display rules for the PNG/PDF/SVG, source tables and DOCX legends in `paper/outputs/publication_v2/figures`.

`--dev-preview` creates visibly marked, uncertified previews exclusively under `.cache/implementation-figure-preview`, with pending cells for unavailable checks. It cannot silently fill the final manuscript figure directory.

```bash
python3 scripts/study/export_figures.py /path/main-results.json /path/figures --kind user
python3 scripts/study/export_figures.py /path/detector-results.json /path/figures --kind detector
```

The exporter refuses pending, missing, or synthetic main results. `--dry-run` permits synthetic user smoke results with a prominent watermark and `DRY_RUN_` filenames. PNG/PDF/SVG, source TSV and an input-hash manifest are emitted. Do not copy dry-run figures into manuscript results.

## External gates

Pending: institutional determination, consent approval, independent expert cases, pilot, final power assumptions, preregistration, real recruitment/results and independent clean-environment reruns. No script makes these events occur and no AI-generated review substitutes for them.
