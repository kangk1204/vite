#!/usr/bin/env Rscript
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) stop("Usage: analyze_study.R prepared-analysis.json output.json [--dry-run]")
script <- sub("^--file=", "", grep("^--file=", commandArgs(), value = TRUE)[1])
source(file.path(dirname(normalizePath(script)), "model.R"))
input <- jsonlite::fromJSON(args[1])
dry_run <- "--dry-run" %in% args
if (!dry_run && (!identical(input$dataOrigin, "human") || !identical(input$phase, "main"))) stop("Main analysis requires main human records.")
if (dry_run && (!identical(input$dataOrigin, "synthetic") || !identical(input$phase, "dry_run"))) stop("Execution checks require synthetic dry-run records.")
if (!is.list(input$analysisFlow) || !is.data.frame(input$taskPool)) stop("Prepared data require a disposition-based analysis roster and a frozen task pool.")
case_ids <- as.character(input$taskPool$caseId)
if (length(case_ids) != 12 || anyDuplicated(case_ids)) stop("The primary estimand requires the twelve frozen task cases.")
if (!dry_run) {
  code_record <- jsonlite::fromJSON(paste(system2("node", c(shQuote(file.path(dirname(normalizePath(script)), "run_study.mjs")), "code-hash"), stdout = TRUE), collapse = "\n"))
  if (!identical(input$studyCodeSha256, code_record$studyCodeSha256)) stop("Study code changed after the power/assignment freeze.")
  if (!identical(input$analysisEnvironment$R, R.version.string) || !identical(input$analysisEnvironment$lme4, as.character(utils::packageVersion("lme4")))) stop("Analysis environment changed after power selection.")
  if (!all(vapply(input[c("protocolSha256", "powerArtifactSha256")], function(x) is.character(x) && length(x)==1 && grepl("^[a-f0-9]{64}$",x), logical(1)))) stop("Missing frozen protocol/power identity.")
  if (!input$recruitmentDecision$action %in% c("stop_target_reached", "stop_cap_reached")) stop("Close recruitment using the outcome-independent stopping rule before main analysis.")
}
rows <- input$rows
flow <- input$analysisFlow
if (is.list(flow$roster) && !length(flow$roster) && flow$authorizedParticipants==0) {
  flow$roster <- data.frame(participantId=character(),allowUse=logical())
}
if (!is.data.frame(flow$roster)) stop("Analysis roster is missing.")
allowed <- flow$roster$participantId[flow$roster$allowUse]
if (is.data.frame(rows) && nrow(rows)) {
  required <- c("participantId","trialId","caseId","condition","period","experience","taskType","error","phase","dataOrigin","status","elapsedMs","penalizedTimeMs","confidence","brier","allocationProfile")
  if (!all(required %in% names(rows))) stop("Missing observed-trial fields.")
  if (any(!rows$participantId %in% allowed)) stop("Withdrawn or unapproved participant observations reached analysis.")
  if (any(!rows$status %in% c("completed","timeout","abandoned","system_error")) || any(!is.finite(rows$elapsedMs)) || any(rows$elapsedMs<0)) stop("Invalid observed trial records.")
  if (any(rows$dataOrigin!=input$dataOrigin) || any(rows$phase!=input$phase)) stop("Mixed data origins/phases.")
  if (any(!is.na(rows$confidence)&(!is.finite(rows$confidence)|rows$confidence<0|rows$confidence>1))) stop("Invalid confidence.")
  if (is.null(input$timeoutMs)||input$timeoutMs<=0||any(rows$status=="completed"&rows$elapsedMs>input$timeoutMs)) stop("Trial time limit mismatch.")
  if (anyDuplicated(paste(rows$participantId,rows$trialId)) || any(table(rows$participantId,rows$condition)>4)) stop("Duplicate or excess observed trials.")
  if (nrow(rows)!=flow$observedTrials || length(unique(rows$participantId))!=flow$observedParticipants) stop("Observed data disagree with the retention roster.")
  rows <- study_prepare(rows)
  primary <- finite_task_inference(rows,"error",case_ids)
  primary$bootstrapSensitivity <- participant_bootstrap(rows,"error",case_ids, attempts=if(dry_run)200L else 10000L)
  secondary <- list(externalErrorDifference=finite_task_inference(rows,"error",case_ids,reference="genetonic"),
    penalizedTimeDifferenceMs=finite_task_inference(rows,"penalizedTimeMs",case_ids),
    confidenceBrierDifference=finite_task_inference(rows,"brier",case_ids))
  adjusted <- p.adjust(vapply(secondary,function(x) if(is.null(x$pvalue))NA_real_ else x$pvalue,numeric(1)),method="holm",n=3)
  for (name in names(secondary)) secondary[[name]]$holmPvalue <- adjusted[[name]]
  fitted <- study_fit(rows)
  supporting <- list(attempts=fitted$attempts,conditionalOddsRatio=if(is.null(fitted$fit))NULL else model_contrast(fitted$fit,"conditionpnv_full"),scope="Supporting common-logit model conditional on fixed cases")
  strata <- lapply(split(input$taskPool,input$taskPool$taskType),function(pool)finite_task_inference(rows[as.character(rows$caseId)%in%pool$caseId,],"error",pool$caseId))
  first_period <- finite_task_inference(rows[as.character(rows$period)=='1',,drop=FALSE],"error",case_ids)
  first_period$pvalue <- NULL
  first_period$interpretation <- "Prespecified descriptive first-period contrast conditional on the same fixed task pool. Empty cells or leave-one-out cells are reported explicitly."
  observed_participants <- length(unique(rows$participantId))
} else {
  if (flow$observedTrials != 0) stop("Empty records disagree with the retention roster.")
  empty <- data.frame(participantId=character(),caseId=character(),condition=character(),error=numeric())
  primary <- finite_task_inference(empty,"error",case_ids)
  first_period <- primary
  secondary <- supporting <- strata <- NULL
  observed_participants <- 0L
}
output <- list(schemaVersion=2,dataOrigin=input$dataOrigin,phase=input$phase,
  status=if(dry_run)"software-smoke-only-not-human-evidence" else "main-analysis",
  estimand="Equal-case-weight full-minus-basic error-risk difference for the fixed twelve held-out tasks",
  uncertaintyScope="Participant-cluster uncertainty conditional on the frozen task pool and observed authorized data",
  participants=observed_participants,trials=flow$observedTrials,analysisFlow=flow,recruitmentDecision=input$recruitmentDecision,
  primary=primary,secondary=secondary,supportingGlmm=supporting,descriptiveTaskStrata=strata,
  descriptiveFirstPeriod=first_period,
  missingDataAssumption="Interpretation assumes missingness is ignorable conditional on recorded design/context. Informative withdrawal or technical loss may change the target population and bias observed-data estimates.",
  inputSha256=digest::digest(file=args[1],algo="sha256"),studyCodeSha256=input$studyCodeSha256,
  sessionInfo=capture.output(sessionInfo()))
dir.create(dirname(args[2]),recursive=TRUE,showWarnings=FALSE)
jsonlite::write_json(output,args[2],pretty=TRUE,auto_unbox=TRUE,na="null",null="null",digits=NA)
cat("Study analysis written with observed participant count",observed_participants,"and origin",input$dataOrigin,"\n")
