#!/usr/bin/env Rscript
# Real GLMM Monte Carlo power, using simr. --smoke does not choose a recruitment target.
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) stop("Usage: power_study.R power-config.json output.json [--smoke]")
script <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
source(file.path(dirname(normalizePath(script)), "model.R"))
if (!requireNamespace("simr", quietly = TRUE)) stop("Install the locked simr dependency.")
config <- jsonlite::fromJSON(args[1])
smoke <- "--smoke" %in% args
case_rows <- jsonlite::fromJSON(config$casesPath)
if (!all(c("split", "adjudicationStatus", "evidenceReady", "reviewers") %in% names(case_rows))) stop("Case manifest lacks adjudication/split fields.")
held_out <- case_rows[case_rows$split == "held_out", ]
reviewed <- vapply(held_out$reviewers, function(x) length(x) == 2 && is.character(x) && !anyNA(x) && all(nzchar(trimws(x))) && length(unique(x)) == 2, logical(1))
if (!smoke && (nrow(held_out) < 12 || anyNA(held_out$adjudicationStatus) || any(held_out$adjudicationStatus != "adjudicated") || anyNA(held_out$evidenceReady) || any(!held_out$evidenceReady) || !all(reviewed))) stop("Final power requires the frozen independently adjudicated held-out case pool.")
if (any(config$baselineError <= config$errorReduction) || config$errorReduction <= 0 || config$targetPower <= 0 || config$targetPower >= 1) stop("Invalid planning probabilities.")
if (!identical(config$alpha, 0.05) || !identical(config$targetPower, 0.8) || !identical(config$errorReduction, 0.1)) stop("This registered design fixes alpha=.05, target power=.80 and marginal error reduction=.10.")
code_record <- jsonlite::fromJSON(paste(system2("node", c(shQuote(file.path(dirname(normalizePath(script)), "run_study.mjs")), "code-hash"), stdout = TRUE), collapse = "\n"))
nsim <- if (smoke) 3L else as.integer(config$simulations)
if (!smoke && nsim < 1000) stop("Final planning requires at least 1000 simulations per scenario.")
make_design <- function(n) {
  stdout <- system2("node", c(shQuote(file.path(dirname(normalizePath(script)), "power_design.mjs")), n, config$seed, shQuote(config$casesPath)), stdout = TRUE)
  if (!is.null(attr(stdout, "status"))) stop("Shared assignment generator failed.")
  rows <- read.delim(text = paste(stdout, collapse = "\n"), stringsAsFactors = FALSE)
  rows$error <- rep(c(0L, 1L), length.out = nrow(rows))
  study_prepare(rows)
}
marginal_intercept <- function(probability, variance) {
  uniroot(function(mu) integrate(function(x) plogis(mu + sqrt(variance) * x) * dnorm(x), -9, 9)$value - probability, c(-15, 15))$root
}
scenarios <- expand.grid(baseline = config$baselineError, participantSD = config$participantSD,
  taskSD = config$taskSD, slopeSD = config$slopeSD)
if (smoke) scenarios <- scenarios[1, , drop = FALSE]
records <- list()
n <- as.integer(config$startN)
if (n < 6 || n %% 6) stop("startN must be a positive multiple of six.")
selected_n <- NULL
repeat {
  data <- make_design(n)
  scenario_pass <- logical(nrow(scenarios))
  for (index in seq_len(nrow(scenarios))) {
    scenario <- scenarios[index, ]
    baseline_variance <- scenario$participantSD^2 + scenario$taskSD^2
    intercept <- marginal_intercept(scenario$baseline, baseline_variance)
    full_intercept <- marginal_intercept(scenario$baseline - config$errorReduction, baseline_variance + scenario$slopeSD^2)
    fixed <- c(intercept, full_intercept - intercept, 0, 0, 0, 0, 0)
    model <- simr::makeGlmer(study_formulas()[[1]], family = binomial(), fixef = fixed,
      VarCorr = list(scenario$participantSD^2, scenario$slopeSD^2, scenario$slopeSD^2, scenario$taskSD^2), data = data)
    pvalues <- rep(NA_real_, nsim)
    model_usage <- integer(4)
    for (replicate in seq_len(nsim)) {
      set.seed(config$seed + n * 10000L + index * nsim + replicate)
      outcome <- tryCatch(simr::doSim(model), error = identity)
      if (inherits(outcome, "error")) next
      replicated <- data
      replicated$error <- as.numeric(outcome)
      fit <- tryCatch(study_fit(replicated), error = identity)
      if (inherits(fit, "error")) next
      test <- study_primary_test(fit, replicated, seed = config$seed + replicate)
      pvalues[replicate] <- if (is.null(test$pvalue)) NA_real_ else test$pvalue
      chosen <- if (is.numeric(fit$model)) fit$model else 4L
      model_usage[chosen] <- model_usage[chosen] + 1L
    }
    # Simulation/refit failures remain in the denominator, conservatively counting as non-rejections.
    successes <- sum(is.finite(pvalues) & pvalues < config$alpha)
    interval <- unname(binom.test(successes, nsim)$conf.int)
    record <- list(n = n, scenario = as.list(scenario), successes = successes, simulations = nsim,
      estimatedPower = successes / nsim, interval = interval, simulationErrors = sum(!is.finite(pvalues)),
      analysisModelUsage = as.list(setNames(model_usage, c("all_slopes", "full_slope", "intercepts", "participant_paired"))))
    records[[length(records) + 1]] <- record
    scenario_pass[index] <- interval[1] >= config$targetPower
    cat("N", n, "scenario", index, "power", successes / nsim, "\n")
  }
  if (all(scenario_pass) && !smoke) selected_n <- n
  output <- list(schemaVersion = 1, status = if (smoke) "smoke-not-for-recruitment" else if (!is.null(selected_n)) "power-selected" else "search-in-progress",
    selectedN = selected_n, config = config, results = records, casesSha256 = digest::digest(file = config$casesPath, algo = "sha256"),
    studyCodeSha256 = code_record$studyCodeSha256, analysisEnvironment = list(R = R.version.string, lme4 = as.character(utils::packageVersion("lme4"))),
    assignmentGenerator = "scripts/study/protocol.mjs::buildAssignments, held_out case pool, 50:50 experience planning assumption",
    criterion = "Smallest evaluated N in multiples of six with lower 95% binomial power bound >= target in every scenario; no recruitment cap.",
    sessionInfo = capture.output(sessionInfo()))
  dir.create(dirname(args[2]), recursive = TRUE, showWarnings = FALSE)
  jsonlite::write_json(output, args[2], pretty = TRUE, auto_unbox = TRUE, na = "null", null = "null", digits = NA)
  if (smoke || !is.null(selected_n)) break
  n <- n + 6L
}
