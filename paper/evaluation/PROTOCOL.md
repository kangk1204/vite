# Prespecified evaluation protocol draft

Status: not preregistered; no participants recruited. Date: 2026-11-10.

## Estimand and information equivalence

The primary estimand is the change in participant interpretation error proportion for full versus basic PNV on the sampled task distribution. Both conditions and GeneTonic receive the same original statistics, source manifests and sensitivity tables. Basic PNV removes integrated summaries/links only. Do not suppress inconvenient raw evidence in a comparator. Inference correctness is held constant.

Tasks mix ordinary interpretation and artifact/uncertainty audit 1:1. Correct responses may explicitly abstain for insufficient evidence. No participant sees the same case family in multiple conditions. Six condition permutations and orthogonal case-block assignments balance both case-by-condition and case-by-period exposure in every complete six-person block; each condition has four trials (two per task stratum). Identical ten-minute condition-specific training precedes testing. Each task has a four-minute limit. Participant IDs are pseudonyms; names and consent forms are stored separately by the research team.

## Adjudication and separation

Two implementation-independent experts create/check case truth before evaluation. The supplied seed manifest has no accepted truth or ready evidence. Freeze case contents and development/held-out partitions before scoring. Final detector evaluation uses new variants/cohort contexts of declared error types; unseen error families are exploratory, not a promised detection capability. Include normal controls and consistently wrong biological labels that cannot be resolved from supplied artifacts.

Two independent raters receive shuffled opaque response IDs with case prompts and answers; participant, period and sequential trial identifiers remain in a separate private mapping. Disagreements require a recorded resolution before condition-unblinded analysis. Participant timeouts, abandonment and software failure count as task failures in the primary endpoint; their frequencies are also reported separately.

## Pilot and sample size

Six pilot participants are excluded from the main cohort. Pilot work tests usability, difficulty and nuisance-variance assumptions, not the treatment effect. Before main recruitment, freeze the grid in `power-config.json`: baseline errors 0.20/0.35/0.50, participant and task random-intercept SD 0.5/1.0, condition-slope SD 0.25/0.5 on the logit scale. The target is a marginal 10-percentage-point error reduction, an investigator-chosen practical effect, not an expected observation.

`power_study.R` uses real binomial GLMM outcomes simulated through SIMR and refits each replicate through the same prespecified model/fallback code as the main analysis, 1,000 repetitions per scenario, alpha 0.05. It integrates the logistic-normal distribution to calibrate the marginal target under the scenario variances. Candidates start at N=24 in multiples of six, with no cap. Choose the first N whose lower 95% binomial power bound is >=0.80 for every scenario; fit errors count as failures. A smoke run cannot define N. Any nuisance-grid amendment requires a dated rationale and must precede preregistration/main data.

## Main analysis and fallback

`error ~ condition + period + experience + taskType + (1 + full + genetonic || participantId) + (1 | caseId)` uses basic PNV as reference. The full-versus-basic Wald contrast is the primary test (two-sided alpha 0.05). Report its odds ratio/95% interval plus participant-level mean error difference with participant bootstrap interval.

Nonconverged or singular models use this fixed order: remove the GeneTonic participant slope; remove the full-PNV participant slope; if the random-intercept model is still singular/nonconvergent, use a participant-paired mean difference with 10,000 sign flips and a 10,000-resample participant bootstrap interval. Report every model attempt and the final method. The sign-flip fallback assumes symmetric paired differences and is not claimed to generalize over an unsampled universe of tasks.

Secondary contrasts are full versus GeneTonic errors, full versus basic penalized time, and full versus basic confidence Brier score; apply Holm across those three tests. A failed/incorrect trial receives the four-minute time penalty; correct trials use elapsed time capped at four minutes. Raw status/time are retained. Brier scores use confidence in the submitted answer and correctness; missing confidence is reported with its denominator. Task-stratum summaries are descriptive. No post-hoc endpoint selection or recruitment extension is allowed.

## Reporting and limitations

Report effect sizes and intervals even when the effect is null or unfavorable. Do not claim universal correctness, biological discoveries, new GSEA inference or broad superiority. Direct standard-package parity is an integration test. Hash-based checking cannot establish label truth. Publish permitted deidentified data, code, frozen assignments and analysis decisions with the study, preserving participant confidentiality.

Institutional determination, consent, preregistration URL and actual hashes remain unset in `protocol.json` until real external records exist.
