# Statistical revision diagnostics

The revised engine records Cook withholding, independent filtering, original Wald model convergence and apeglm effect diagnostics in every gene row. Its primary ranking policy is `finite_original_wald_v1`. After the prespecified count filter, all finite original Wald statistics enter the ranked gene universe. Gene-level p-value withholding and independent filtering remain visible alongside each inclusion decision. This preserves the complete continuous ranked list and documents the policy already used by the original main analysis. AKAP11's Cook-excluded list is a separately identified sensitivity. The code never selects its main policy by the number of significant pathways.

Cook withholding is identified by comparing the default result extraction with a `cooksCutoff=FALSE, independentFiltering=FALSE` diagnostic extraction from the same fitted object. The primary p values and adjusted p values remain the default extraction. `maxCooks > cooksCutoff` is also recorded as a separate flag because it differs from actual withholding under DESeq2's additional filtering rules. Model convergence is carried as `betaConv`; apeglm's per-gene `conv` code is carried as `shrinkConvergenceCode` with `shrinkConverged` equal to `conv==0`. An unavailable convergence code stays missing. Warnings retain stage, affected quantity and any available gene attribution. Upstream messages lacking gene IDs remain explicitly unattributed.

The numerical settings are DESeq2 Wald inference, `betaPrior=FALSE`, replacement minimum of seven replicates, `alpha=0.05`, BH adjustment and the default Cook threshold. Display effects use apeglm `nbinomCR`, adaptive prior and zero LFC threshold. CAMERA retains its returned `NGenes` and `Correlation` and records TMM, voom, `inter.gene.cor=NA`, `allow.neg.cor=FALSE`, `use.ranks=FALSE`, `trend.var=FALSE`, `directional=TRUE`, `sort=FALSE` and BH adjustment. These distinct tests have distinct null hypotheses. Their agreement is a descriptive sensitivity assessment.

## Fresh computations

The dated manifest is `paper/manifests/publication_2026_11_16.json`. Every cohort has a dedicated config under `paper/configs/publication_2026_11_16/`. The ordinary entrypoints are unchanged commands with those revised config paths. The PD and MDD configs request 500 fresh draws using three outer workers each, one fgsea worker per draw and independent index-derived seeds. Updated source fingerprints prevent reuse of the historical inference checkpoints.

```bash
Rscript scripts/analyze_neural_bulk_cohort.R paper/configs/publication_2026_11_16/gse68719_pd_primary.json
Rscript scripts/analyze_neural_bulk_cohort.R paper/configs/publication_2026_11_16/gse102556_mdd_extension.json
Rscript scripts/run_local_analysis.R paper/configs/publication_2026_11_16/airway_paired_reference.json
```

`scripts/validate_analysis_reference.R` makes independent direct package calls. Revised artifacts trigger 26 comparisons, including new model/rank/convergence indicators and CAMERA fields. Historical artifacts retain the comparisons supported by their original fields. The expected tolerance is absolute and relative `1e-8` within the same frozen environment.

## Derived evidence and figures

Run these after the relevant output files are complete.

```bash
Rscript scripts/statistics/derive_bootstrap_precision.R
Rscript scripts/statistics/akap11_cook_sensitivity.R
Rscript scripts/statistics/derive_bootstrap_precision.R paper/outputs/publication_2026_11_16 .cache/bootstrap/publication-2026-11-16 paper/outputs/publication_2026_11_16/statistics/revised-bootstrap revised_2026_11_16
Rscript scripts/statistics/summarize_revised_diagnostics.R
.venv/bin/python scripts/statistics/render_revision_figures.py --bootstrap-kind revised
```

The first command derives historical diagnostic tables from the original fingerprint-matched checkpoints. It records the original run identity, every checkpoint's SHA-256, the new derivation code hashes and `additionalFits=0`. It verifies original point counts before adding Wilson intervals. The later explicitly parameterized command derives the same diagnostics from the newly computed revision checkpoints.

`precision.tsv` contains all pathway numerators, valid denominators, Wilson intervals and missing-denominator reasons. `convergence.tsv` evaluates cumulative counts every 50 iterations. `split.tsv` compares first and last 250 iterations. `thresholds.tsv` records fixed diagnostic thresholds. The inclusive near-half count uses integer arithmetic `45*valid <= 100*selected <= 55*valid`.

Wilson intervals quantify the finite Monte Carlo precision of selected/valid and direction-matched/valid proportions. Validity requires a returned pathway with finite NES and adjusted p value. Entire fit failure, absent pathway and non-finite returned statistics have separate counters. Both sample draws and fgsea's stochastic calculation vary. Intervals are per pathway, conditional on testable draws and the observed dataset; pathway overlap prevents interpreting them as independent or simultaneous disease-level evidence.

The renderer exports PNG, PDF, SVG, a figure legend and a manifest of exact source/output hashes. All diagnostic tables remain available even when a figure selects near-boundary pathways for readability.

The score-interval calculation follows Wilson's binomial interval. Its use here concerns Monte Carlo selection proportions conditional on testable draws. [Wilson (1927)](https://doi.org/10.1080/01621459.1927.10502953) and [Brown, Cai and DasGupta (2001)](https://doi.org/10.1214/ss/1009213286) provide the method references.
