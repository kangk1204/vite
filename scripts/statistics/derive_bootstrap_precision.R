#!/usr/bin/env Rscript
# Derive finite Monte Carlo precision from immutable, identified checkpoints.
source("scripts/lib/analysis_core.R")
source("scripts/lib/analysis_io.R")

read_complete_checkpoints <- function(directory, fingerprint, requested, seed) {
  paths <- file.path(directory, fingerprint, sprintf("rep-%05d.rds", seq_len(requested)))
  if (!all(file.exists(paths))) stop("The recorded bootstrap sequence is incomplete.")
  manifest <- repetitions <- vector("list", requested)
  for (iteration in seq_len(requested)) {
    saved <- readRDS(paths[[iteration]])
    expected_seed <- as.integer((as.double(seed) + 104729 * iteration) %% (.Machine$integer.max - 1) + 1)
    if (!identical(saved$fingerprint, fingerprint) || saved$iteration != iteration || saved$seed != expected_seed) {
      stop("Checkpoint identity, iteration or seed differs from the original run.")
    }
    repetitions[iteration] <- list(if (is.null(saved$result)) NULL else saved$result[, c("pathway", "NES", "padj"), drop = FALSE])
    manifest[[iteration]] <- list(iteration = iteration, seed = saved$seed, fingerprint = fingerprint,
      path = paths[[iteration]], sha256 = digest::digest(file = paths[[iteration]], algo = "sha256"),
      fitStatus = if (is.null(saved$error)) "completed" else "failed",
      detailedFitDiagnostics = if (is.null(saved$fitDiagnostics)) "not_recorded_in_this_checkpoint" else "recorded")
  }
  list(repetitions = repetitions, manifest = manifest)
}

precision_table <- function(primary, summaries) {
  do.call(rbind, lapply(seq_len(nrow(primary)), function(i) {
    original <- primary[i, ]
    value <- summaries[[original$pathway]]
    data.frame(pathway_id = original$pathway_id, pathway_name = original$pathway_name,
      primary_nes = original$NES, primary_padj = original$padj,
      originally_significant = is.finite(original$padj) && original$padj < .05,
      requested = value$requested, valid = value$valid, selected = value$selected,
      selection_frequency = value$selectionFrequency, selection_lower = value$selectionInterval$lower,
      selection_upper = value$selectionInterval$upper, direction_matches = value$directionMatches,
      direction_frequency = value$directionConsistency, direction_lower = value$directionInterval$lower,
      direction_upper = value$directionInterval$upper, valid_fraction = value$validFraction,
      fit_failed = value$denominatorReasons$fitFailed, not_eligible = value$denominatorReasons$notEligible,
      nonfinite_statistic = value$denominatorReasons$nonFiniteStatistic,
      crosses_half = is.finite(value$selectionInterval$lower) && value$selectionInterval$lower <= .5 && value$selectionInterval$upper >= .5,
      below_half = is.finite(value$selectionFrequency) && value$selectionFrequency < .5,
      warning = pnv_default(value$warning, NA_character_), stringsAsFactors = FALSE)
  }))
}

derive_one_cohort <- function(key, prefix, source_root, checkpoint_root, output_root, source_kind) {
  root <- file.path(source_root, key)
  evidence_path <- file.path(root, paste0(prefix, "_evidence.json"))
  pathway_path <- file.path(root, paste0(prefix, "_fgsea_reactome.tsv"))
  evidence <- jsonlite::fromJSON(evidence_path, simplifyVector = FALSE)$evidence
  primary <- data.table::fread(pathway_path, data.table = FALSE)
  requested <- as.integer(evidence$bootstrap$requested)
  if (requested != 500L) stop("This diagnostic expects the complete prespecified 500-replicate run.")
  captured <- read_complete_checkpoints(checkpoint_root, evidence$bootstrap$fingerprint, requested, evidence$analysis$seed)
  summarize <- function(indices) pnv_summarize_bootstrap(primary$pathway, primary$NES,
    captured$repetitions[indices], length(indices), .05)
  full <- precision_table(primary, summarize(seq_len(requested)))
  for (i in seq_len(nrow(full))) {
    recorded <- evidence$pathways[[full$pathway_id[[i]]]]$bootstrap
    observed <- c(full$valid[[i]], full$selected[[i]], full$direction_matches[[i]])
    expected <- c(recorded$valid, recorded$selected, pnv_default(recorded$directionMatches, NA_integer_))
    if (!identical(is.na(observed), is.na(expected)) || any(observed != expected, na.rm = TRUE)) {
      stop("Checkpoint-derived point counts differ from the original sidecar.")
    }
  }
  cumulative <- do.call(rbind, lapply(seq(50L, requested, by = 50L), function(n) {
    table <- precision_table(primary, summarize(seq_len(n)))
    significant <- table[table$originally_significant, ]
    data.frame(replicates = n, originally_significant = nrow(significant),
      below_half = sum(significant$below_half), intervals_crossing_half = sum(significant$crosses_half),
      valid_min = min(significant$valid), valid_median = median(significant$valid), valid_max = max(significant$valid))
  }))
  first <- precision_table(primary, summarize(seq_len(requested / 2)))
  second <- precision_table(primary, summarize(seq(requested / 2 + 1, requested)))
  split <- data.frame(pathway_id = full$pathway_id, pathway_name = full$pathway_name,
    originally_significant = full$originally_significant, first_valid = first$valid, last_valid = second$valid,
    first_frequency = first$selection_frequency, last_frequency = second$selection_frequency,
    first_below_half = first$below_half, last_below_half = second$below_half,
    classification_changed = ifelse(is.finite(first$selection_frequency) & is.finite(second$selection_frequency),
      first$below_half != second$below_half, NA))
  significant <- full[full$originally_significant, ]
  thresholds <- do.call(rbind, lapply(c(.25, .40, .45, .50, .55, .60, .75, .90), function(cutoff) {
    data.frame(threshold = cutoff, originally_significant = nrow(significant),
      frequency_below = sum(significant$selection_frequency < cutoff, na.rm = TRUE),
      interval_entirely_below = sum(significant$selection_upper < cutoff, na.rm = TRUE),
      interval_entirely_above = sum(significant$selection_lower > cutoff, na.rm = TRUE),
      interval_crossing = sum(significant$selection_lower <= cutoff & significant$selection_upper >= cutoff, na.rm = TRUE))
  }))
  dir.create(output_root, recursive = TRUE, showWarnings = FALSE)
  outputs <- list(precision = full, convergence = cumulative, split = split, thresholds = thresholds)
  for (name in names(outputs)) data.table::fwrite(outputs[[name]], file.path(output_root, paste0(key, "_", name, ".tsv")), sep = "\t", na = "")
  source_files <- c(evidence_path, pathway_path, "scripts/statistics/derive_bootstrap_precision.R",
    "scripts/lib/analysis_diagnostics.R", "scripts/lib/analysis_bootstrap.R", "renv.lock")
  provenance <- list(derivation = "Checkpoint-only conditional Monte Carlo diagnostics", sourceKind = source_kind,
    originalRunId = evidence$runId, originalBootstrapFingerprint = evidence$bootstrap$fingerprint,
    additionalFits = 0L, files = lapply(source_files, function(p) list(path = p, sha256 = digest::digest(file = p, algo = "sha256"))),
    checkpoints = captured$manifest, definitions = list(interval = "Unadjusted 95% Wilson interval for a conditional Monte Carlo proportion",
      selection = "fgsea BH-adjusted p value < 0.05 within a testable resample",
      nearHalfEndpointRule = "Inclusive exact count comparison with valid > 0: 45 * valid <= 100 * selected <= 55 * valid",
      validity = "Pathway is returned with finite NES and adjusted p value",
      uncertainty = "Both sample draws and fgsea stochastic calculations vary. These are not simultaneous intervals or biological-replication probabilities."),
    summary = list(pathways = nrow(full), originallySignificant = nrow(significant),
      belowHalf = sum(significant$below_half), nearHalf45to55 = sum(significant$valid > 0 & 45 * significant$valid <= 100 * significant$selected &
        100 * significant$selected <= 55 * significant$valid),
      intervalsCrossingHalf = sum(significant$crosses_half), firstHalfBelow = sum(first$below_half & first$originally_significant),
      secondHalfBelow = sum(second$below_half & second$originally_significant),
      splitClassificationChanges = sum(split$classification_changed & split$originally_significant, na.rm = TRUE),
      fitFailureOccurrences = sum(full$fit_failed), notEligibleOccurrences = sum(full$not_eligible),
      nonfiniteStatisticOccurrences = sum(full$nonfinite_statistic), validityBelow90 = sum(full$valid_fraction < .9)))
  jsonlite::write_json(provenance, file.path(output_root, paste0(key, "_derivation.json")), auto_unbox = TRUE,
    pretty = TRUE, null = "null", na = "null", digits = NA)
  provenance$summary
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  source_root <- if (length(args)) args[[1]] else "paper/outputs/publication_v2"
  checkpoint_root <- if (length(args) >= 2) args[[2]] else ".cache/bootstrap/publication-v2"
  output <- if (length(args) >= 3) args[[3]] else "paper/outputs/publication_2026_11_16/statistics/historical-bootstrap"
  kind <- if (length(args) >= 4) args[[4]] else "historical_2026_11_10"
  summary <- list()
  for (pair in list(c("gse68719_pd_primary", "gse68719_pd_vs_control"), c("gse102556_mdd_extension", "gse102556_mdd_vs_control_dlpfc"))) {
    summary[[pair[[1]]]] <- derive_one_cohort(pair[[1]], pair[[2]], source_root, checkpoint_root, output, kind)
  }
  jsonlite::write_json(summary, file.path(output, "summary.json"), auto_unbox = TRUE, pretty = TRUE, na = "null")
  print(summary)
}
