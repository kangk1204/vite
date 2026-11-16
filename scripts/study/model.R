# Prospective revision: finite frozen task-pool risk difference with participant-cluster inference.
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

# These working models provide a supporting conditional odds ratio for this finite case set.
study_formulas <- function() list(
  error ~ condition + period + experience + caseId + (1 + full + genetonic || participantId),
  error ~ condition + period + experience + caseId + (1 + full || participantId),
  error ~ condition + period + experience + caseId + (1 | participantId)
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
  list(fit = NULL, model = "supporting-model-unavailable", attempts = attempts)
}

finite_cells <- function(rows, outcome, case_ids, condition = "pnv_full", reference = "pnv_basic") {
  if (!length(case_ids) || anyDuplicated(case_ids)) stop("A unique frozen case pool is required.")
  if (!all(c("participantId", "caseId", "condition", outcome) %in% names(rows))) stop("Missing observed outcome columns.")
  if (any(!as.character(rows$caseId) %in% case_ids)) stop("An observed case is outside the frozen task pool.")
  if (anyDuplicated(paste(rows$participantId, rows$caseId, sep = "\r"))) stop("A participant has duplicate observed case rows.")
  data <- rows[as.character(rows$condition) %in% c(reference, condition) & is.finite(rows[[outcome]]), , drop = FALSE]
  ids <- unique(as.character(data$participantId))
  cells <- as.vector(outer(case_ids, c(reference, condition), paste, sep = "|"))
  counts <- sums <- matrix(0, nrow = length(ids), ncol = length(cells), dimnames = list(ids, cells))
  if (nrow(data)) {
    positions <- cbind(match(as.character(data$participantId), ids), match(paste(data$caseId, data$condition, sep = "|"), cells))
    counts[positions] <- 1
    sums[positions] <- data[[outcome]]
  }
  profiles <- vapply(ids, function(id) {
    values <- if ("allocationProfile" %in% names(data)) unique(as.character(data$allocationProfile[data$participantId == id])) else "legacy-unspecified"
    if (length(values) != 1 || is.na(values) || !nzchar(values)) stop("Inconsistent allocation profile for a participant.")
    values
  }, character(1))
  list(sums = sums, counts = counts, participants = ids, cases = case_ids, cells = cells, profiles = profiles)
}

finite_task_inference <- function(rows, outcome = "error", case_ids = unique(as.character(rows$caseId)),
                                  condition = "pnv_full", reference = "pnv_basic", alpha = 0.05) {
  cells <- finite_cells(rows, outcome, case_ids, condition, reference)
  n <- nrow(cells$counts)
  k <- length(case_ids)
  total <- colSums(cells$sums)
  count <- colSums(cells$counts)
  empty <- cells$cells[count == 0]
  common <- list(estimand = "Equal-case-weight outcome difference conditional on the frozen task pool",
    condition = condition, reference = reference, caseIds = case_ids, caseWeight = 1 / k,
    participants = n, observedRows = sum(count), cellCounts = as.list(setNames(count, cells$cells)),
    method = "Leave-one-participant-cluster-out jackknife with t(N-1) inference")
  unavailable <- function(reason, estimate = NULL, empty_cells = character()) {
    c(common, list(status = "not-estimable", reason = reason, estimate = estimate,
      standardError = NULL, interval = c(NA_real_, NA_real_), pvalue = NULL, degreesOfFreedom = max(0, n-1), emptyCells = empty_cells))
  }
  if (length(empty)) return(unavailable("One or more frozen case-condition cells contain no observed data", empty_cells = empty))
  difference <- function(value) mean(value[(k+1):(2*k)] - value[seq_len(k)])
  estimate <- difference(total / count)
  if (n < 3) return(unavailable("At least three observed participant clusters are required", estimate))
  remaining <- matrix(count, nrow = n, ncol = 2*k, byrow = TRUE) - cells$counts
  if (any(remaining == 0)) return(unavailable("A leave-one-participant-out case-condition cell is empty", estimate,
    cells$cells[colSums(remaining == 0) > 0]))
  means <- (matrix(total, nrow = n, ncol = 2*k, byrow = TRUE) - cells$sums) / remaining
  jackknife <- rowMeans(means[, (k+1):(2*k), drop = FALSE] - means[, seq_len(k), drop = FALSE])
  se <- sqrt((n-1)/n * sum((jackknife - mean(jackknife))^2))
  if (!is.finite(se) || se <= .Machine$double.eps) return(unavailable("The observed participant jackknife variance is zero", estimate))
  limit <- qt(1-alpha/2, df = n-1) * se
  c(common, list(status = "estimable", reason = NULL, estimate = estimate, standardError = se,
    interval = estimate + c(-limit, limit), pvalue = 2*pt(-abs(estimate/se), df = n-1),
    degreesOfFreedom = n-1, emptyCells = character()))
}

participant_bootstrap <- function(rows, outcome = "error", case_ids, attempts = 10000L, seed = 20261116,
                                  condition = "pnv_full", reference = "pnv_basic") {
  cells <- finite_cells(rows, outcome, case_ids, condition, reference)
  if (!is.numeric(attempts) || attempts < 1 || attempts %% 1) stop("Bootstrap attempts must be a positive integer.")
  groups <- split(seq_along(cells$participants), cells$profiles)
  sizes <- vapply(groups,length,integer(1))
  if (!length(groups) || any(sizes<2L)) {
    return(list(scope="Participant clusters within fixed allocation profiles and fixed cases",
      requestedAttempts=attempts,attempts=0L,valid=0L,failed=0L,
      failureReason="Within-profile variability is unavailable for an empty or singleton allocation profile",
      profileParticipants=as.list(sizes),singletonProfiles=sum(sizes<2L),interval=c(NA_real_,NA_real_),seed=seed))
  }
  values <- rep(NA_real_, attempts)
  set.seed(seed)
  k <- length(case_ids)
  for (iteration in seq_len(attempts)) {
    chosen <- unlist(lapply(groups, function(group) group[sample.int(length(group), length(group), replace = TRUE)]), use.names = FALSE)
    weights <- tabulate(chosen, nbins = nrow(cells$counts))
    totals <- colSums(cells$sums * weights)
    counts <- colSums(cells$counts * weights)
    if (!length(counts) || any(counts == 0)) next
    means <- totals/counts
    values[iteration] <- mean(means[(k+1):(2*k)] - means[seq_len(k)])
  }
  finite <- values[is.finite(values)]
  list(scope = "Participant clusters resampled within frozen allocation profiles, conditional on fixed cases",
    requestedAttempts=attempts,attempts = attempts, valid = length(finite), failed = attempts-length(finite),
    failureReason = if (length(finite) < attempts) "empty case-condition cell in resampled observations" else NULL,
    profileParticipants = as.list(vapply(groups,length,integer(1))),
    singletonProfiles = sum(vapply(groups,length,integer(1))<2L),
    interval = if (length(finite) >= 2) unname(quantile(finite,c(.025,.975))) else c(NA_real_,NA_real_),
    seed = seed)
}

model_contrast <- function(fit, coefficient) {
  coefficients <- coef(summary(fit))
  if (!coefficient %in% rownames(coefficients)) return(NULL)
  estimate <- coefficients[coefficient, "Estimate"]
  se <- coefficients[coefficient, "Std. Error"]
  list(logOddsRatio = estimate, oddsRatio = exp(estimate), interval = exp(estimate + c(-1, 1) * qnorm(0.975) * se),
    pvalue = coefficients[coefficient, "Pr(>|z|)"])
}
