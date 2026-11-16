#!/usr/bin/env Rscript
source("scripts/lib/analysis_core.R")
source("scripts/lib/analysis_io.R")

camera_summary <- function(cohort, camera, primary, matched) {
  camera_score <- ifelse(matched$direction == "Up", 1, -1) * -log10(pmax(matched$pvalue, 1e-300))
  data.frame(cohort = cohort, camera_tested = nrow(camera), fgsea_tested = nrow(primary),
    camera_significant = sum(camera$padj < .05, na.rm = TRUE), fgsea_significant = sum(primary$padj < .05, na.rm = TRUE),
    camera_up = sum(camera$direction == "Up"), camera_down = sum(camera$direction == "Down"),
    correlation_min = min(camera$Correlation, na.rm = TRUE),
    correlation_q25 = unname(quantile(camera$Correlation, .25, na.rm = TRUE)),
    correlation_median = median(camera$Correlation, na.rm = TRUE),
    correlation_q75 = unname(quantile(camera$Correlation, .75, na.rm = TRUE)),
    correlation_max = max(camera$Correlation, na.rm = TRUE),
    camera_padj_min = min(camera$padj, na.rm = TRUE), camera_padj_median = median(camera$padj, na.rm = TRUE),
    camera_ngenes_min = min(camera$NGenes), camera_ngenes_max = max(camera$NGenes),
    directional_rank_spearman = suppressWarnings(cor(camera_score, matched$NES, method = "spearman", use = "complete.obs")))
}

summarize_revised_diagnostics <- function(root, output) {
  cohorts <- list(c("PD", "gse68719_pd_primary", "gse68719_pd_vs_control"),
    c("AD", "gse159699_ad_replication", "gse159699_ad_vs_old_control"),
    c("MDD", "gse102556_mdd_extension", "gse102556_mdd_vs_control_dlpfc"),
    c("AKAP11", "gse290452_akap11_model_extension", "gse290452_akap11_hetko_vs_wt_unt"),
    c("airway", "airway_paired_reference/results", "airway_paired"))
  tables <- models <- sources <- summaries <- list()
  for (cohort in cohorts) {
    directory <- file.path(root, cohort[[2]])
    evidence_path <- file.path(directory, paste0(cohort[[3]], "_evidence.json"))
    camera_path <- file.path(directory, paste0(cohort[[3]], "_camera.tsv"))
    pathway_path <- file.path(directory, paste0(cohort[[3]], "_fgsea_reactome.tsv"))
    evidence <- jsonlite::fromJSON(evidence_path, simplifyVector = FALSE)$evidence
    camera <- data.table::fread(camera_path, data.table = FALSE)
    primary <- data.table::fread(pathway_path, data.table = FALSE)
    if (!all(c("Correlation", "NGenes") %in% names(camera))) stop("Revised CAMERA diagnostics are missing.")
    table <- merge(camera, primary[, c("pathway", "NES", "padj")], by = "pathway", all = TRUE,
      suffixes = c("_camera", "_fgsea"))
    table$cohort <- cohort[[1]]
    tables[[cohort[[1]]]] <- table
    value <- evidence$fitDiagnostics$summary
    models[[cohort[[1]]]] <- data.frame(cohort = cohort[[1]], total_genes = value$totalGenes,
      beta_nonconverged = value$betaNonconverged, beta_unknown = value$betaConvergenceUnknown,
      cook_withheld = value$cooksWithheld, independent_filtered = value$independentFiltered,
      model_not_estimable = value$modelNotEstimable, other_missing = value$otherMissing,
      shrink_nonconverged = value$shrinkNonconverged, shrink_unknown = value$shrinkConvergenceUnknown,
      ranking_included = value$rankingIncluded, ranking_excluded = value$rankingExcluded,
      primary_warning_count = value$warningCount, primary_message_count = value$messageCount)
    summaries[[cohort[[1]]]] <- camera_summary(cohort[[1]], camera, primary, table)
    sources[[cohort[[1]]]] <- list(runId = evidence$runId, options = evidence$analysis$cameraOptions,
      rankingPolicy = evidence$analysis$rankingPolicy, covariateTransformations = evidence$analysis$covariateTransformations,
      files = lapply(c(evidence_path, camera_path, pathway_path), function(p) list(path = p, sha256 = digest::digest(file = p, algo = "sha256"))))
  }
  dir.create(output, recursive = TRUE, showWarnings = FALSE)
  data.table::fwrite(do.call(rbind, tables), file.path(output, "camera_pathway_diagnostics.tsv"), sep = "\t", na = "")
  data.table::fwrite(do.call(rbind, summaries), file.path(output, "camera_cohort_summary.tsv"), sep = "\t", na = "")
  data.table::fwrite(do.call(rbind, models), file.path(output, "gene_fit_diagnostic_summary.tsv"), sep = "\t", na = "")
  jsonlite::write_json(list(cohorts = sources, interpretation = "Method sensitivity across distinct gene-set tests; concordance is descriptive.",
    script = list(path = "scripts/statistics/summarize_revised_diagnostics.R", sha256 = digest::digest(file = "scripts/statistics/summarize_revised_diagnostics.R", algo = "sha256"))),
    file.path(output, "diagnostic_sources.json"), auto_unbox = TRUE, pretty = TRUE, na = "null", null = "null", digits = NA)
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  root <- if (length(args)) args[[1]] else "paper/outputs/publication_2026_11_16"
  summarize_revised_diagnostics(root, file.path(root, "statistics/camera-and-fit"))
}
