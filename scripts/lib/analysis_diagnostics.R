# Diagnostics annotate the original inference and explicitly document ranking decisions.
pnv_capture_conditions <- function(expression, stage, affected_quantity) {
  conditions <- list()
  record <- function(condition, type) {
    conditions[[length(conditions) + 1L]] <<- list(stage = stage, type = type,
      message = conditionMessage(condition), affectedQuantity = affected_quantity,
      geneAttribution = "not_provided_by_upstream", affectedGeneIds = NULL)
  }
  value <- withCallingHandlers(expression,
    warning = function(w) record(w, "warning"), message = function(m) record(m, "message"))
  list(value = value, conditions = conditions)
}

pnv_gene_diagnostics <- function(genes, no_cook_results, metadata, cooks_cutoff) {
  value <- function(name, fallback) if (name %in% names(metadata)) metadata[[name]] else rep(fallback, nrow(genes))
  genes$betaConv <- as.logical(value("betaConv", NA))
  genes$maxCooks <- as.numeric(value("maxCooks", NA_real_))
  genes$cooksCutoff <- rep(as.numeric(cooks_cutoff), nrow(genes))
  genes$cooksAboveCutoff <- is.finite(genes$maxCooks) & genes$maxCooks > cooks_cutoff
  genes$cooksOutlier <- is.na(genes$pvalue) & is.finite(no_cook_results$pvalue)
  genes$independentFiltered <- is.finite(genes$pvalue) & is.na(genes$padj)
  genes$allZero <- (!is.na(value("allZero", FALSE)) & value("allZero", FALSE)) |
    (is.finite(genes$baseMean) & genes$baseMean == 0)
  genes$countsReplaced <- !is.na(value("replace", FALSE)) & value("replace", FALSE)
  nonconverged <- !is.na(genes$betaConv) & !genes$betaConv
  reason <- rep(NA_character_, nrow(genes))
  reason[genes$independentFiltered] <- "DESeq2_independent_filter"
  reason[is.na(genes$pvalue)] <- "DESeq2_other_missing"
  reason[is.na(genes$pvalue) & (!is.finite(genes$stat) | nonconverged)] <- "DESeq2_model_not_estimable"
  reason[genes$cooksOutlier] <- "DESeq2_cooks_outlier"
  reason[genes$allZero] <- "DESeq2_all_zero"
  genes$missingReason <- reason
  genes$rankingIncluded <- is.finite(genes$stat)
  genes$rankingReason <- ifelse(genes$rankingIncluded, "included_finite_wald", "excluded_nonfinite_wald")
  genes$rankingReason[genes$rankingIncluded & genes$independentFiltered] <- "included_finite_wald_independent_filtered"
  genes$rankingReason[genes$rankingIncluded & nonconverged] <- "included_finite_wald_model_nonconverged"
  genes$rankingReason[genes$rankingIncluded & genes$cooksOutlier] <- "included_finite_wald_cooks_withheld"
  genes
}

pnv_ranking_policy <- function(genes) {
  included <- genes$rankingIncluded
  list(id = "finite_original_wald_v1",
    description = paste("All finite original DESeq2 Wald statistics are retained for preranked fgsea after the prespecified count filter.",
      "Cook-withheld p values and independent filtering do not remove a finite rank.",
      "Finite ranks from nonconverged models are flagged for review and retained under this fixed policy.",
      "A separate Cook-exclusion sensitivity assesses the effect of the retained outlier ranks."),
    includedGeneCount = sum(included), excludedNonFiniteCount = sum(!included),
    includedCookOutlierCount = sum(included & genes$cooksOutlier),
    includedIndependentFilterCount = sum(included & genes$independentFiltered),
    includedNonconvergedCount = sum(included & !is.na(genes$betaConv) & !genes$betaConv))
}

pnv_ranked_genes <- function(genes) {
  if (!"rankingIncluded" %in% names(genes) || !identical(genes$rankingIncluded, is.finite(genes$stat))) {
    stop("Gene ranking flags must implement the prespecified finite-Wald policy.", call. = FALSE)
  }
  setNames(genes$stat[genes$rankingIncluded], genes$gene[genes$rankingIncluded])
}

pnv_fit_diagnostics <- function(genes, conditions, shrink_evaluated) {
  summary <- list(totalGenes = nrow(genes), betaConverged = sum(genes$betaConv, na.rm = TRUE),
    betaNonconverged = sum(!genes$betaConv, na.rm = TRUE), betaConvergenceUnknown = sum(is.na(genes$betaConv)),
    cooksWithheld = sum(genes$cooksOutlier), cooksAboveCutoff = sum(genes$cooksAboveCutoff),
    independentFiltered = sum(genes$independentFiltered), allZero = sum(genes$allZero),
    modelNotEstimable = sum(genes$missingReason == "DESeq2_model_not_estimable", na.rm = TRUE),
    otherMissing = sum(genes$missingReason == "DESeq2_other_missing", na.rm = TRUE),
    countsReplaced = sum(genes$countsReplaced), rankingIncluded = sum(genes$rankingIncluded),
    rankingExcluded = sum(!genes$rankingIncluded), shrinkEvaluated = shrink_evaluated,
    shrinkConverged = if (shrink_evaluated) sum(genes$shrinkConverged, na.rm = TRUE) else NULL,
    shrinkNonconverged = if (shrink_evaluated) sum(!genes$shrinkConverged, na.rm = TRUE) else NULL,
    shrinkConvergenceUnknown = if (shrink_evaluated) sum(is.na(genes$shrinkConverged)) else NULL,
    warningCount = sum(vapply(conditions, function(x) x$type == "warning", logical(1))),
    messageCount = sum(vapply(conditions, function(x) x$type == "message", logical(1))))
  list(summary = summary, rankingPolicy = pnv_ranking_policy(genes), warnings = conditions,
    interpretation = "Completed fits may contain gene-level convergence, Cook or effect-estimation diagnostics. Gene flags are recorded in the genes source table.")
}

pnv_camera_options <- function() {
  list(interGeneCorrelation = "estimated_per_set", allowNegativeCorrelation = FALSE,
    useRanks = FALSE, trendVar = FALSE, directional = TRUE, sort = FALSE,
    adjustment = "BH", normalization = "TMM", transformation = "voom")
}

pnv_wilson_interval <- function(successes, denominator, level = 0.95) {
  if (length(denominator) != 1L || !is.finite(denominator) || denominator < 0 || denominator != floor(denominator)) {
    stop("A Monte Carlo denominator must be a non-negative integer.")
  }
  if (!is.na(successes) && (!is.finite(successes) || successes < 0 || successes > denominator || successes != floor(successes))) {
    stop("A Monte Carlo numerator must be an integer between zero and the denominator.")
  }
  lower <- upper <- NA_real_
  if (denominator > 0 && !is.na(successes)) {
    z <- stats::qnorm((1 + level) / 2)
    fraction <- successes / denominator
    scale <- 1 + z^2 / denominator
    center <- (fraction + z^2 / (2 * denominator)) / scale
    half <- z * sqrt(fraction * (1 - fraction) / denominator + z^2 / (4 * denominator^2)) / scale
    lower <- if (successes == 0) 0 else max(0, center - half)
    upper <- if (successes == denominator) 1 else min(1, center + half)
  }
  list(method = "wilson", level = level, lower = lower, upper = upper, denominator = denominator)
}
