# Prespecified models shared by the study analysis and its power simulation.
if (dir.exists(".cache/R/library")) .libPaths(unique(c(normalizePath(".cache/R/library"), .libPaths())))
study_prepare <- function(rows) {
  required <- c("participantId", "caseId", "condition", "period", "experience", "taskType", "error")
  if (!all(required %in% names(rows))) stop("Missing study analysis columns.")
  if (any(!rows$error %in% c(0, 1))) stop("error must be binary.")
  rows$condition <- factor(rows$condition, levels = c("pnv_basic", "pnv_full", "genetonic"))
  rows$participantId <- factor(rows$participantId)
  rows$caseId <- factor(rows$caseId)
  rows$period <- factor(rows$period, levels = 1:3)
  rows$experience <- factor(rows$experience, levels = c("novice", "experienced"))
  rows$taskType <- factor(rows$taskType, levels = c("ordinary", "audit"))
  rows$full <- as.numeric(rows$condition == "pnv_full")
  rows$genetonic <- as.numeric(rows$condition == "genetonic")
  if (anyNA(rows[required])) stop("Missing or invalid model values.")
  rows
}

study_formulas <- function() list(
  error ~ condition + period + experience + taskType + (1 + full + genetonic || participantId) + (1 | caseId),
  error ~ condition + period + experience + taskType + (1 + full || participantId) + (1 | caseId),
  error ~ condition + period + experience + taskType + (1 | participantId) + (1 | caseId)
)

study_fit <- function(rows) {
  if (!requireNamespace("lme4", quietly = TRUE)) stop("Install the locked lme4 dependency.")
  data <- study_prepare(rows)
  attempts <- list()
  for (index in seq_along(study_formulas())) {
    fit <- tryCatch(suppressWarnings(lme4::glmer(study_formulas()[[index]], data = data,
      family = binomial(), control = lme4::glmerControl(optimizer = "bobyqa", optCtrl = list(maxfun = 200000)))), error = identity)
    valid <- !inherits(fit, "error") && all(unlist(fit@optinfo$conv$opt) == 0) && is.null(fit@optinfo$conv$lme4$messages) && !lme4::isSingular(fit, tol = 1e-4)
    attempts[[index]] <- list(model = index, valid = valid,
      optimizerCode = if (inherits(fit, "error")) NULL else fit@optinfo$conv$opt,
      convergenceMessages = if (inherits(fit, "error")) NULL else fit@optinfo$conv$lme4$messages,
      reason = if (inherits(fit, "error")) conditionMessage(fit) else if (!valid) "singular or nonconverged" else "converged")
    if (valid) return(list(fit = fit, model = index, attempts = attempts))
  }
  list(fit = NULL, model = "participant_paired_randomization", attempts = attempts)
}

paired_effect <- function(rows, outcome, condition = "pnv_full", seed = 20261110, repeats = 10000, reference = "pnv_basic") {
  aggregated <- aggregate(rows[[outcome]], list(participant = rows$participantId, condition = rows$condition), mean, na.rm = TRUE)
  wide <- reshape(aggregated, idvar = "participant", timevar = "condition", direction = "wide")
  difference <- wide[[paste0("x.", condition)]] - wide[[paste0("x.", reference)]]
  difference <- difference[is.finite(difference)]
  if (length(difference) < 2) return(list(estimate = NULL, interval = c(NA_real_, NA_real_), pvalue = NULL, participants = length(difference)))
  set.seed(seed)
  draws <- replicate(repeats, mean(sample(difference, replace = TRUE)))
  randomized <- replicate(repeats, mean(difference * sample(c(-1, 1), length(difference), replace = TRUE)))
  list(estimate = mean(difference), interval = unname(quantile(draws, c(0.025, 0.975))),
    pvalue = (1 + sum(abs(randomized) >= abs(mean(difference)))) / (repeats + 1), participants = length(difference))
}

model_contrast <- function(fit, coefficient) {
  coefficients <- coef(summary(fit))
  if (!coefficient %in% rownames(coefficients)) return(NULL)
  estimate <- coefficients[coefficient, "Estimate"]
  se <- coefficients[coefficient, "Std. Error"]
  list(logOddsRatio = estimate, oddsRatio = exp(estimate), interval = exp(estimate + c(-1, 1) * qnorm(0.975) * se),
    pvalue = coefficients[coefficient, "Pr(>|z|)"])
}

study_primary_test <- function(fitted, rows, seed = 20261110) {
  if (!is.null(fitted$fit)) {
    result <- model_contrast(fitted$fit, "conditionpnv_full")
    if (!is.null(result) && is.finite(result$pvalue)) return(c(list(method = "mixed-model Wald contrast", model = fitted$model), result))
  }
  paired <- paired_effect(rows, "error", seed = seed)
  list(method = "participant paired sign-flip test", model = "participant_paired_randomization", pvalue = paired$pvalue)
}
