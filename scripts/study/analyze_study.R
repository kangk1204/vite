#!/usr/bin/env Rscript
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) stop("Usage: analyze_study.R prepared-analysis.json output.json [--dry-run]")
script <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
source(file.path(dirname(normalizePath(script)), "model.R"))
input <- jsonlite::fromJSON(args[1])
dry_run <- "--dry-run" %in% args
if (!dry_run && (!identical(input$dataOrigin, "human") || !identical(input$phase, "main"))) stop("Only preregistered main human records can enter the main analysis.")
if (dry_run && (!identical(input$dataOrigin, "synthetic") || !identical(input$phase, "dry_run"))) stop("Dry-run analysis requires explicitly synthetic dry_run data.")
rows <- input$rows
required_record <- c("phase", "dataOrigin", "status", "elapsedMs", "penalizedTimeMs", "confidence", "brier")
if (!all(required_record %in% names(rows))) stop("Missing per-trial origin/status/time/confidence fields.")
if (any(!rows$status %in% c("completed", "timeout", "abandoned", "system_error")) || any(!is.finite(rows$elapsedMs)) || any(rows$elapsedMs < 0) ||
    any(!is.na(rows$confidence) & (!is.finite(rows$confidence) | rows$confidence < 0 | rows$confidence > 1))) stop("Invalid trial status/time/confidence values.")
if (!nrow(rows) || any(rows$dataOrigin != input$dataOrigin) || any(rows$phase != input$phase)) stop("Empty or mixed-origin analysis data.")
if (!dry_run && (is.null(input$plannedSampleSize) || length(unique(rows$participantId)) != input$plannedSampleSize ||
    is.null(input$protocolSha256) || !grepl("^[a-f0-9]{64}$", input$protocolSha256) ||
    is.null(input$powerArtifactSha256) || !grepl("^[a-f0-9]{64}$", input$powerArtifactSha256))) stop("Analysis requires the complete frozen sample and protocol/power identity.")
if (!dry_run && (is.null(input$timeoutMs) || input$timeoutMs <= 0 || any(rows$status == "completed" & rows$elapsedMs > input$timeoutMs))) stop("Completed trials must respect the frozen time limit.")
if (!dry_run) {
  code_record <- jsonlite::fromJSON(paste(system2("node", c(shQuote(file.path(dirname(normalizePath(script)), "run_study.mjs")), "code-hash"), stdout = TRUE), collapse = "\n"))
  if (!identical(input$studyCodeSha256, code_record$studyCodeSha256)) stop("Study code differs from the frozen power/assignment implementation.")
  if (!identical(input$analysisEnvironment$R, R.version.string) || !identical(input$analysisEnvironment$lme4, as.character(utils::packageVersion("lme4")))) stop("Analysis environment differs from the power-selected environment.")
}
counts <- table(rows$participantId, rows$condition)
if (ncol(counts) != 3 || any(counts != 4)) stop("Each participant must have all twelve scheduled trials; failures are records, not exclusions.")
rows <- study_prepare(rows)
fit <- study_fit(rows)
primary <- paired_effect(rows, "error")
primary$pvalue <- NULL
primary$inferentialTest <- study_primary_test(fit, rows)
secondary <- list(
  externalErrorDifference = paired_effect(rows, "error", reference = "genetonic"),
  penalizedTimeDifferenceMs = paired_effect(rows, "penalizedTimeMs"),
  confidenceBrierDifference = paired_effect(rows, "brier")
)
pvalues <- vapply(secondary, function(x) if (is.null(x$pvalue)) NA_real_ else x$pvalue, numeric(1))
adjusted <- p.adjust(pvalues, method = "holm")
for (name in names(secondary)) secondary[[name]]$holmPvalue <- adjusted[[name]]
strata <- lapply(split(rows, rows$taskType), function(x) paired_effect(x, "error"))
output <- list(schemaVersion = 1, dataOrigin = input$dataOrigin, phase = input$phase,
  status = if (dry_run) "software-smoke-only-not-human-evidence" else "main-analysis",
  participants = length(unique(rows$participantId)), trials = nrow(rows), modelAttempts = fit$attempts,
  primary = primary, secondary = secondary, descriptiveTaskStrata = strata,
  missingConfidenceTrials = sum(is.na(rows$brier)),
  interpretation = "Bootstrap intervals resample participants; descriptive task strata are not additional confirmatory tests. Negative error differences favor full PNV. No biology or general FDR claim.",
  sessionInfo = capture.output(sessionInfo()))
dir.create(dirname(args[2]), recursive = TRUE, showWarnings = FALSE)
jsonlite::write_json(output, args[2], pretty = TRUE, auto_unbox = TRUE, na = "null", null = "null", digits = NA)
cat("Study analysis written; origin:", input$dataOrigin, "\n")
