# Evaluation package

The 2026-11-16 prospective revision uses a fixed twelve-case held-out target, the public delivery checker/presentation, and an observed-data retention roster. Human case adjudication, pilot observations, final planning assumptions and main-study observations remain pending. `PROTOCOL.md` defines the estimand, inference, allocation, consent-based retention and stopping rules.

## Execution checks

```bash
npx vitest run --exclude '**/.cache/**' tests/studyRevision.test.js tests/studyModel.test.js tests/studyProtocol.test.js
node scripts/study/run_study.mjs status --protocol paper/evaluation/protocol.json
node scripts/study/smoke.mjs .cache/revision-2026-11-16/study/analysis-smoke
Rscript scripts/study/power_study.R paper/evaluation/power-config.json .cache/revision-2026-11-16/study/power-smoke.json --smoke
```

The primary estimate is the equally weighted mean of twelve case-specific full-minus-basic error differences. The same participant-cluster jackknife t test/CI is used in simulation and observed-data analysis. The supporting GLMM reports a conditional odds ratio. Participant bootstrap sensitivity preserves actual allocation-profile sizes, reports valid attempts and withholds an interval for singleton profiles. First-period-only inference is descriptive and reports empty cells explicitly.

Final planning requires an actual six-person pilot record and independently adjudicated held-out cases. It uses at least 1,000 alternative simulations per scenario, followed by a separate 10,000-null-simulation calibration at power-eligible candidate N. The prespecified criteria are power lower95 >=.80, type-I upper95 <=.06 and coverage lower95 >=.94. The source code, case pool, nuisance settings and numerical tolerances are frozen before main collection. Smoke results are execution checks with `selectedN=null`.

## Case and adjudication materials

The revision uses `paper/manifests/publication_2026_11_16.json` and writes fresh versioned packets. The prior `publication_v2/expert_review` directory retains its historical artifacts.

```bash
node scripts/study/build_case_packets.mjs --manifest paper/manifests/publication_2026_11_16.json --output paper/outputs/publication_2026_11_16/expert_review
node scripts/study/build_case_packets.mjs --verify paper/outputs/publication_2026_11_16/expert_review
```

There are twelve PD development contexts and twelve MDD held-out contexts, each balanced six ordinary/six audit. Target pathways and target genes are disjoint, with explicit critical-fact exposure commitments. Interleukin practice is separate. The normal product checker and renderer generate the diagnostic/linking intervention. Complete common source records are accessible across all three conditions. Private recipes, frozen predictions and expert forms remain in the coordinator workspace. Independent experts receive their own kits through `recruitment/README.md`.

## Assignment, records and analysis

Populate a separate protocol copy with actual institutional, consent, expert-adjudication, pilot, power and preregistration records. The initial main roster equals selected N. Pilot participants have their own six-person roster. Use `wasPilot:false` for actual main eligibility. Record actual experience and consent.

```bash
node scripts/study/run_study.mjs assign --protocol /private/protocol.json --participants /private/pilot-roster.json --cases /private/adjudicated-cases.json --phase pilot --out /private/pilot-assignment.json
Rscript scripts/study/power_study.R /private/frozen-power-config.json /private/final-power.json
node scripts/study/run_study.mjs assign --protocol /private/protocol.json --power /private/final-power.json --participants /private/main-roster.json --cases /private/adjudicated-cases.json --phase main --out /private/main-assignment.json
node scripts/study/run_study.mjs audit-assignments --assignments /private/main-assignment.json --out /private/allocation-audit.json
node scripts/study/session_html.mjs /private/main-assignment.json /private/adjudicated-cases.json P001 /path/to/participant/P001-session.html
```

Every case carries a committed context ID and exposure keys. The audit reports pairwise and full case×condition×period counts. Case-block rotations are part of each allocation profile. Session pages show held-out prompts after the timer starts and use distinct ten-minute tutorials. They record first/prior target visits and the participant's self-reported prior exposure. The session can stop with submitted records retained or clear its browser answers after withdrawal. Session status is downloaded separately from responses.

The disposition JSON covers every randomized participant with `participantId`, `status`, and `allowUse`. Allowed closed statuses are `completed`, `stopped_retain`, `technical_loss`, `missing_unknown`, `no_data`, and `withdrawn_delete`. Loss states also carry a reason. `withdrawn_delete` sets `allowUse:false`. Ongoing sessions use `active`. Missing records under a completed disposition cause a validation error. Partial/lost records have no invented trial rows.

```bash
node scripts/study/run_study.mjs recruitment-status --assignments /private/main-assignment.json --responses /private/responses.json --dispositions /private/dispositions.json
node scripts/study/run_study.mjs replace --protocol /private/protocol.json --power /private/final-power.json --assignments /private/main-assignment.json --cases /private/adjudicated-cases.json --participants /private/next-six.json --responses /private/responses.json --dispositions /private/dispositions.json --out /private/extended-assignment.json
node scripts/study/run_study.mjs blind --assignments /private/extended-assignment.json --responses /private/responses.json --dispositions /private/dispositions.json --out /private/blinded.json --key /private/rating-key.json
node scripts/study/run_study.mjs prepare --protocol /private/protocol.json --power /private/final-power.json --assignments /private/extended-assignment.json --responses /private/responses.json --dispositions /private/dispositions.json --ratings /private/ratings.json --key /private/rating-key.json --phase main --out /private/prepared.json
Rscript scripts/study/analyze_study.R /private/prepared.json /private/main-results.json
```

The 20% attrition allowance is a prospective operational default to review after the pilot. It fixes a maximum of `6*ceil((N/0.8)/6)` randomized participants. Additional enrollment occurs in six-person blocks based only on retained primary-trial availability, with target and cap stopping rules. Every consented observed record is included, and missingness, withdrawal, shortfall and task-cell availability are reported. Main inference assumes ignorable missingness conditional on the recorded design. The first-period and bootstrap sensitivities retain their stated finite-task scope.

## Withdrawal processing

A full deletion request first removes data-use permission. The command then purges the named active response, rating and key files and emits an administrative receipt requiring reanalysis.

```bash
node scripts/study/run_study.mjs withdraw --assignments /private/main-assignment.json --responses /private/responses.json --ratings /private/ratings.json --key /private/rating-key.json --dispositions /private/dispositions.json --participant P001 --out /private/withdrawal-P001.json
```

The coordinator applies the approved institutional policy to other copies, backups and identity linkage. Retained partial observations are analyzed with their actual denominators. Missing or leave-one-participant-out case cells yield a non-estimable result. Final recruitment state and aggregate disposition counts accompany the analysis. Raters receive shuffled opaque response IDs for retained completed answers. The private key is held separately.

Use `protocolDigest()` to compute the canonical protocol hash. Main commands verify the frozen power file, source code, case pool, seed, inference target, attrition choice and actual runtime. The participant-facing consent draft in `recruitment/` retains the fields requiring a real institutional decision.

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

Implementation figures are generated only after all five cohorts in the selected publication manifest are finalized:

```bash
python3 scripts/study/build_implementation_figures.py
```

Main Figure 1 presents all PD/MDD original FDR values and reselection frequencies, plus the minimum-FDR PD pathway. Generate it with `python3 scripts/study/build_case_figure.py` using the finalized cohort artifacts. The software workflow and eighteen integration checks per dataset are Supplementary Figures S1 and S2, generated by `build_implementation_figures.py`. Figure manifests record the source paths, hashes and display rules for the PNG/PDF/SVG, source tables and DOCX legends in the selected publication output's `figures` directory. The 2026-11-16 revision uses `paper/outputs/publication_2026_11_16`.

`--dev-preview` creates visibly marked, uncertified previews exclusively under `.cache/implementation-figure-preview`, with pending cells for unavailable checks. It cannot silently fill the final manuscript figure directory.

```bash
python3 scripts/study/export_figures.py /path/main-results.json /path/figures --kind user
python3 scripts/study/export_figures.py /path/detector-results.json /path/figures --kind detector
```

The exporter refuses pending, missing, or synthetic main results. `--dry-run` permits synthetic user smoke results with a prominent watermark and `DRY_RUN_` filenames. PNG/PDF/SVG, source TSV and an input-hash manifest are emitted. Do not copy dry-run figures into manuscript results.

## External gates

Pending: institutional determination, consent approval, independent expert cases, pilot, final power assumptions, preregistration, real recruitment/results and independent clean-environment reruns. No script makes these events occur and no AI-generated review substitutes for them.
