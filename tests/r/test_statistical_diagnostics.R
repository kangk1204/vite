#!/usr/bin/env Rscript
source("scripts/lib/analysis_core.R")

# Cook suppression, adjusted-p independent filtering and model failure have different causes.
genes <- data.frame(gene = c("COOK", "FILTER", "MODEL", "ZERO", "FINITE_FAILED", "OK"),
  baseMean = c(10, 1, 5, 0, 20, 30), stat = c(2, 1, NA, NA, 3, 1),
  pvalue = c(NA, 0.1, NA, NA, 0.03, 0.2), padj = c(NA, NA, NA, NA, 0.1, 0.4))
raw <- genes; raw$pvalue <- c(.04, .1, NA, NA, .03, .2)
metadata <- data.frame(betaConv = c(TRUE, TRUE, FALSE, NA, FALSE, TRUE),
  maxCooks = c(100, 0, NA, NA, 0, 0), allZero = c(FALSE, FALSE, FALSE, TRUE, FALSE, FALSE))
classified <- pnv_gene_diagnostics(genes, raw, metadata, 10)
stopifnot(identical(classified$missingReason, c("DESeq2_cooks_outlier", "DESeq2_independent_filter",
  "DESeq2_model_not_estimable", "DESeq2_all_zero", NA_character_, NA_character_)),
  identical(classified$rankingIncluded, c(TRUE, TRUE, FALSE, FALSE, TRUE, TRUE)),
  classified$rankingReason[1] == "included_finite_wald_cooks_withheld",
  classified$rankingReason[2] == "included_finite_wald_independent_filtered",
  classified$rankingReason[5] == "included_finite_wald_model_nonconverged")
policy <- pnv_ranking_policy(classified)
stopifnot(policy$includedGeneCount == 4, policy$excludedNonFiniteCount == 2,
  policy$includedCookOutlierCount == 1, policy$includedIndependentFilterCount == 1,
  policy$includedNonconvergedCount == 1)

zero <- pnv_wilson_interval(0, 500)
all <- pnv_wilson_interval(500, 500)
half <- pnv_wilson_interval(250, 500)
stopifnot(zero$lower == 0, zero$upper > 0, all$upper == 1, all$lower < 1,
  half$lower < 0.5, half$upper > 0.5,
  is.na(pnv_wilson_interval(0, 0)$lower), is.na(pnv_wilson_interval(NA_integer_, 5)$upper),
  pnv_wilson_interval(473, 500)$lower > .92)
for (n in c(1L, 2L, 5L, 10L, 100L, 500L)) {
  for (selected in 0:n) {
    interval <- pnv_wilson_interval(selected, n)
    score <- suppressWarnings(stats::prop.test(selected, n, correct = FALSE)$conf.int)
    stopifnot(max(abs(c(interval$lower, interval$upper) - score)) < 1e-12)
  }
}

summaries <- pnv_summarize_bootstrap(c("P1", "P2"), c(1, NA),
  list(data.frame(pathway = c("P1", "P2"), NES = c(1, -2), padj = c(.01, .2)),
       data.frame(pathway = "P1", NES = NA_real_, padj = .01),
       data.frame(pathway = character(), NES = numeric(), padj = numeric()), NULL), 4, .05)
stopifnot(summaries$P1$valid == 1, summaries$P1$selectionInterval$denominator == 1,
  summaries$P1$denominatorReasons$fitFailed == 1,
  summaries$P1$denominatorReasons$notEligible == 1,
  summaries$P1$denominatorReasons$nonFiniteStatistic == 1,
  is.na(summaries$P2$directionInterval$lower),
  summaries$P1$interpretation == "conditional_on_testable_resamples")

captured <- pnv_capture_conditions({ warning("optimizer line search failed"); 7 },
  "apeglm", "display_effect_estimation")
stopifnot(captured$value == 7, length(captured$conditions) == 1,
  captured$conditions[[1]]$geneAttribution == "not_provided_by_upstream",
  is.null(captured$conditions[[1]]$affectedGeneIds),
  captured$conditions[[1]]$affectedQuantity == "display_effect_estimation")

set.seed(661)
counts <- matrix(rnbinom(600*6, mu = 60, size = 8), 600,
  dimnames = list(paste0("G", 1:600), paste0("S", 1:6)))
counts[1, 1] <- 100000L
samples <- data.frame(sample = colnames(counts), group = rep(c("A", "B"), each = 3))
pathways <- list("P1" = rownames(counts)[1:30], "P2" = rownames(counts)[100:160])
result <- pnv_analyze_counts(counts, samples, pathways,
  list(designFormula = "~ group", camera = TRUE, bootstrapReplicates = 0L))
stopifnot(all(c("betaConv", "maxCooks", "cooksOutlier", "rankingIncluded", "rankingReason",
  "shrinkConvergenceCode", "shrinkConverged") %in% names(result$geneResults)),
  all(c("NGenes", "Correlation") %in% names(result$cameraResults)),
  result$geneResults$cooksOutlier[1], is.na(result$geneResults$pvalue[1]),
  result$geneResults$rankingIncluded[1], result$fitDiagnostics$rankingPolicy$id == "finite_original_wald_v1")
direct <- limma::camera(limma::voom(edgeR::calcNormFactors(edgeR::DGEList(counts = counts[result$geneResults$gene, ])),
  design = result$designMatrix, plot = FALSE), index = lapply(pathways, function(g)match(g,result$geneResults$gene)),
  design = result$designMatrix, contrast = which(colnames(result$designMatrix)=="groupB"),
  inter.gene.cor = NA, use.ranks = FALSE, allow.neg.cor = FALSE, trend.var = FALSE, directional = TRUE, sort = FALSE)
stopifnot(identical(result$cameraResults$NGenes, as.integer(direct$NGenes)),
  isTRUE(all.equal(result$cameraResults$Correlation, direct$Correlation, tolerance=1e-12)))
cat("PASS: missingness/ranking distinctions, model and shrink diagnostics, exact CAMERA fields, conditional Wilson intervals\n")
