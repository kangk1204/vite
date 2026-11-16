# Prospective study protocol revision

Version date 2026-11-16. Institutional determination, expert case adjudication, the six-person pilot, final sample-size selection and preregistration are pending. This revision changes the primary analysis before enrollment in response to R3-M3/M4/M5 and R2-3.

## Target and intervention

The primary estimand is the equally weighted average error-risk difference, full PNV minus basic PNV, across the twelve frozen held-out cases. Every case receives weight 1/12. The target population is eligible external researchers represented by the retained, consented observations under the registered allocation. Interpretation assumes missingness is ignorable conditional on the recorded context and design. Informative withdrawal or technical loss can bias this observed-data estimate and change the represented participant population.

The full intervention is the public PNV delivery-diagnostic and linked-evidence presentation. Its checker is `scripts/lib/delivery_inspection.mjs`, and its presentation is `scripts/lib/delivery_presentation.mjs`. The study adapter calls these product modules on the submitted files and analysis record. Full presents diagnostics and navigation prominently. Basic and GeneTonic retain the same common source data and raw delivery record, including the recorded machine checks. The primary contrast therefore concerns the integrated diagnostic/linking presentation. Independent expert labels and construction recipes remain outside participant views.

The primary risk difference and its uncertainty are conditional on the exact held-out case IDs and sources frozen for this study. The GLMM conditional odds ratio is supporting evidence. Task-effect sensitivity in simulation describes the prespecified case pool. Claims about new tasks, other pathways or other cohorts require additional observations.

## Case contexts, allocation and prior exposure

The development pool contains twelve PD contexts. The held-out pool contains twelve MDD contexts. Each pool has six ordinary interpretation tasks and six evidence-audit tasks. Across the two pools, targeted pathway IDs and target genes are disjoint. Each case also commits explicit answer-critical fields in `exposureKeys`. Assignment rejects a repeated target pathway, target gene, context ID or scored critical-fact key. Signaling by Interleukins and its three practice genes are reserved for training.

These rules concern the scored target contexts. The native reports retain common cohort metadata and general method explanations. Familiarity with that background can develop during the session and is part of the study setting. Each trial records the number of prior scheduled visits to its target context and a participant report of previous exposure (`no`, `yes`, `unsure`). Missing historical exposure information remains `unrecorded`.

Each participant receives twelve distinct tasks, four in each of full PNV, basic PNV and GeneTonic. Each condition has two ordinary and two audit tasks. Six tool-order permutations are balanced within six-person blocks. Orthogonal case-block assignment balances case-by-condition and case-by-period exposure. Case blocks rotate across successive six-person blocks to support first-period comparisons. `allocationProfile` contains both tool order and case-block rotation. The audit exports the actual pairwise and three-way counts; exact three-way equality depends on the final number of blocks.

Separate ten-minute practice materials precede each condition. Each scored task has a four-minute limit. Evaluation prompts and links become visible when the timer starts. Correct answers may state that the supplied evidence is insufficient. Pseudonymous participant codes are used, with identity linkage and consent materials held separately by the coordinator.

## Expert adjudication and observation status

Two implementation-independent experts review the source-backed cases and establish technical labels, answer keys and task readiness. Initial disagreement and its resolution are retained. Cases and task-source commitments are frozen before main assignment. The revised generated packets use a new output directory so preceding versions remain available as historical records.

Two independent response raters receive shuffled opaque response IDs and case answers. Participant, condition, period and sequential trial identifiers remain in the coordinator's mapping. Completed answers require two agreeing ratings or a documented resolution. Recorded task timeouts, task abandonment and system errors are defined failures regardless of answer grading. Unrecorded trials are missing observations and receive no invented response or failure row.

## Pilot, power and calibration

Six pilot participants are excluded from the main study. The pilot checks usability, difficulty, exposure reports, loss rates and nuisance assumptions. `pilotAssumptions` stays unfrozen until the actual pilot record exists and its hash is recorded. No final recruitment N is selected from a software smoke run.

The practical target is an equal-case marginal error reduction of 10 percentage points. The frozen planning grid starts with baseline errors 0.20/0.35/0.50, participant intercept SD 0.5/1.0, task difficulty SD 0.5/1.0, participant condition-slope SD 0.25/0.5, and task-by-condition offset SD 0/0.25/0.5, on the logit scale. Task offsets are drawn once per scenario with a recorded seed and are fixed over simulated participant cohorts. The intercept and condition coefficients are numerically calibrated so the mean marginal difference over the twelve cases is exactly the specified null or alternative target within numerical tolerance. The code records the achieved target.

Two availability scenarios are prespecified for planning: complete observations, and independent probabilities of 0.10 whole withdrawal and 0.10 partial technical loss. A partial-loss event removes two scheduled trial records. These planning assumptions are reviewed after the pilot and frozen before the main study. Their simulations assume outcome-independent availability. Informative attrition remains a limitation to assess from actual data and disposition patterns.

The simulation uses the same allocation, availability-based reserve-block rule and primary jackknife test as the actual analysis. Final power requires at least 1,000 alternative repetitions per scenario. Final candidate calibration uses a separate 10,000 null repetitions per scenario. As a prospective operating choice, require power lower 95% bound >=0.80, null type-I upper 95% bound <=0.06, and null coverage lower 95% bound >=0.94 in every scenario. These tolerances and seeds are fixed before final simulation and are not widened after seeing results. Non-estimable repetitions remain in all denominators and are counted as uncovered and non-rejections. Candidate target N starts at 24 and increases by six. Smoke runs evaluate execution paths with three repetitions per scenario and retain `selectedN=null`.

## Primary risk-difference inference

For each case, calculate its mean error among observed full-PNV trials and observed basic-PNV trials. Average the twelve differences with equal weights. Participant records form the independent clusters. Cases are held fixed.

Leave out each observed participant cluster in turn and recompute the same twelve-case estimate. If the leave-one-out estimates are d_i and their mean is d_bar, the jackknife variance is `(N-1)/N * sum((d_i-d_bar)^2)`. Use its square root with a two-sided t test and 95% t interval with N-1 degrees of freedom. A missing full/basic case cell, an empty leave-one-out cell, fewer than three participant clusters or zero observed jackknife variance produces an explicit non-estimable result. The point estimate is retained when it can be calculated. Cases are not dropped to obtain an interval.

A conditional bootstrap interval is a sensitivity result. Resample whole participant records within the frozen allocation profiles, retaining each profile's observed size and reissuing repeated cluster identities conceptually. Keep the twelve case weights fixed. Use 10,000 prespecified attempts without silent retries, and report attempted, valid and failed draws with reasons and profile sizes. If any observed allocation profile is a singleton, within-profile variability is unavailable and the bootstrap interval is withheld with its profile counts. The main jackknife inference remains separately reported.

A prespecified first-period-only equal-case risk difference and interval describe possible generic cross-tool learning. Its empty-cell counts and non-estimability are reported when applicable. This sensitivity and task-stratum summaries are descriptive and add no confirmatory hypothesis or sample-size claim.

## Supporting and secondary results

The supporting GLMM uses `error ~ condition + period + experience + caseId + (1 + full + genetonic || participantId)`. Fixed case effects absorb task type. Nonconverged or singular models successively remove the GeneTonic participant slope and then the full-PNV slope. If the random-intercept model still fails, the supporting odds ratio is unavailable. The primary risk-difference test and estimand remain the same throughout.

Secondary contrasts use the same finite-case estimator for full versus GeneTonic errors, full versus basic penalized time, and full versus basic confidence Brier score. Apply Holm correction across these three prespecified tests. A recorded incorrect/failed trial receives the four-minute time penalty; a correct completed trial uses elapsed time capped at four minutes. Missing trials contribute no artificial time. Brier analyses report missing-confidence denominators and any unavailable case cells.

## Withdrawal, partial loss and analysis set

The coordinator closes a disposition roster for every randomized participant. Allowed states are `completed`, `stopped_retain`, `technical_loss`, `missing_unknown`, `no_data` and `withdrawn_delete`. `active` marks an ongoing session and prevents final outcome preparation. Loss states require an administrative explanation. The roster documents actual data-use permission.

A full withdrawal with deletion removes the participant from use before purging their responses, ratings and private rating keys in the named active files. The removal command retains a minimal administrative receipt and signals that prior aggregates require reanalysis. The coordinator applies the institutionally approved procedure to other copies, correspondence, backups and the identity linkage. The approved retention details and withdrawal window remain actual institutional fields to be completed before enrollment.

A participant may stop while permitting use of already submitted answers. Consented partial observations are retained in the analysis, and unobserved scheduled trials are enumerated separately. A documented partial technical loss is handled the same way. Unknown missingness is explicitly labelled. All retained observed trials are analyzed according to assigned condition. A retained incomplete participant is not silently excluded, and a missing trial is not converted to a failure. Empty-cell inference is reported as unavailable rather than repaired with fabricated outcomes.

## Fixed recruitment and stopping

The final power calculation fixes target N. The prospective default attrition allowance is 20%, subject to pilot review and freeze. The maximum randomized count is `6 * ceil((N / (1-attritionFraction)) / 6)`. Initially enroll N participants. After the current participants have closed dispositions, release a whole six-person reserve block only if fewer than N participants have four retained observed records in each primary condition. Completion here counts recorded availability, including recorded task failures, without consulting correctness, answers, confidence or the estimated effect.

Stop at a block boundary when the availability target is reached or the fixed maximum is reached. The cap is not expanded after outcomes. If the cap is reached with a shortfall, report the achieved data and its uncertainty. The analysis includes every consented observed record from the enrolled blocks, including partial records. Report randomized, authorized, observed, complete, partial, withdrawn and unavailable participant counts plus scheduled and observed trial counts. Report the task-cell denominators and the primary outcome's observed participant count.
