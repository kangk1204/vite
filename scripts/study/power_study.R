#!/usr/bin/env Rscript
# Execution checks use the prospective finite-task primary test. Recruitment N is selected after the pilot freeze.
args <- commandArgs(trailingOnly=TRUE)
if(length(args)<2)stop('Usage: power_study.R power-config.json output.json [--smoke]')
script <- sub('^--file=','',grep('^--file=',commandArgs(),value=TRUE)[1])
source(file.path(dirname(normalizePath(script)),'model.R'))
source(file.path(dirname(normalizePath(script)),'power_helpers.R'))
config <- jsonlite::fromJSON(args[1]);smoke <- '--smoke'%in%args
for(field in c('baselineError','participantSD','taskSD','slopeSD','taskConditionSD')) {
  value <- config[[field]]
  if(!is.numeric(value)||!length(value)||any(!is.finite(value))||any(value<0))stop(field,' must be a nonempty finite numeric grid with nonnegative values.')
}
if(!is.data.frame(config$attritionScenarios)||!nrow(config$attritionScenarios)||
   !all(c('name','withdrawalProbability','partialLossProbability')%in%names(config$attritionScenarios)))stop('At least one fully specified availability scenario is required.')
case_rows <- jsonlite::fromJSON(config$casesPath)
held_out <- case_rows[case_rows$split=='held_out',]
if(nrow(held_out)!=12 || anyDuplicated(held_out$id))stop('Power requires the exact twelve frozen held-out tasks.')
reviewed <- vapply(held_out$reviewers,function(x)length(x)==2&&is.character(x)&&!anyNA(x)&&all(nzchar(trimws(x)))&&length(unique(x))==2,logical(1))
if(!smoke) {
  if(any(held_out$adjudicationStatus!='adjudicated')||any(!held_out$evidenceReady)||!all(reviewed))stop('Final planning requires independently adjudicated held-out cases.')
  pilot <- config$pilotAssumptions
  if(!isTRUE(pilot$frozen)||pilot$completedParticipants!=6||is.null(pilot$recordPath)||!file.exists(pilot$recordPath)||
     !identical(digest::digest(file=pilot$recordPath,algo='sha256'),pilot$recordSha256))stop('Final planning requires the actual six-person pilot assumptions and a verified frozen record.')
}
if(!identical(config$calibrationTypeIUpper,.06)||!identical(config$calibrationCoverageLower,.94))stop('The prospective calibration tolerances are type-I upper .06 and coverage lower .94.')
if(!identical(config$alpha,.05)||!identical(config$targetPower,.8)||!identical(config$errorReduction,.1))stop('The prospective specification fixes alpha .05, power .80 and reduction .10.')
if(any(config$baselineError<=config$errorReduction)||any(config$baselineError>=1))stop('Invalid baseline probability.')
if(length(config$plannedAttritionFraction)!=1||!is.finite(config$plannedAttritionFraction)||config$plannedAttritionFraction<0||config$plannedAttritionFraction>=1)stop('Attrition allowance must be finite in [0,1).')
if(!smoke&&(config$simulations<1000||config$calibrationSimulations<10000))stop('Final power needs >=1000 alternative simulations and >=10000 null calibration simulations.')
nsim <- if(smoke)3L else as.integer(config$simulations)
ncal <- if(smoke)3L else as.integer(config$calibrationSimulations)
code_record <- jsonlite::fromJSON(paste(system2('node',c(shQuote(file.path(dirname(normalizePath(script)),'run_study.mjs')),'code-hash'),stdout=TRUE),collapse='\n'))
case_ids <- sort(as.character(held_out$id))
scenarios <- expand.grid(baseline=config$baselineError,participantSD=config$participantSD,taskSD=config$taskSD,
  slopeSD=config$slopeSD,taskConditionSD=config$taskConditionSD,attritionIndex=seq_len(nrow(config$attritionScenarios)))
if(smoke)scenarios <- scenarios[scenarios$baseline==config$baselineError[1]&scenarios$participantSD==config$participantSD[1]&scenarios$taskSD==config$taskSD[1]&scenarios$slopeSD==config$slopeSD[1],]
models <- lapply(seq_len(nrow(scenarios)),function(i){
  scenario <- as.list(scenarios[i,]);attrition <- config$attritionScenarios[scenario$attritionIndex,]
  scenario$withdrawalProbability <- attrition$withdrawalProbability
  scenario$partialLossProbability <- attrition$partialLossProbability
  if(any(!is.finite(unlist(scenario)))||any(unlist(scenario)<0)||scenario$withdrawalProbability+scenario$partialLossProbability>=1)stop('Invalid variance or loss scenario.')
  list(scenario=scenario,null=calibrate_finite_dgp(case_ids,scenario,0,config$seed),alternative=calibrate_finite_dgp(case_ids,scenario,config$errorReduction,config$seed))
})
n <- as.integer(config$startN)
if(n<6||n%%6)stop('Start N must be a multiple of six.')
records <- list();selected_n <- NULL
repeat {
  cap <- 6*ceiling(n/(1-config$plannedAttritionFraction)/6)
  stdout <- system2('node',c(shQuote(file.path(dirname(normalizePath(script)),'power_design.mjs')),cap,config$seed,shQuote(config$casesPath)),stdout=TRUE)
  if(!is.null(attr(stdout,'status')))stop('Shared allocation generator failed.')
  design <- read.delim(text=paste(stdout,collapse='\n'),stringsAsFactors=FALSE)
  alternatives <- lapply(seq_along(models),function(i) {
    model <- models[[i]]
    simulate_rd_test(design,model$alternative,model$scenario,n,nsim,config$seed+n*10000+i*1000000+500000,config$alpha)
  })
  power_candidate <- all(vapply(alternatives,function(x)x$rejection$interval[1]>=config$targetPower,logical(1)))
  passed <- logical(length(models))
  for(i in seq_along(models)) {
    model <- models[[i]]
    alternative <- alternatives[[i]]
    calibration <- if(smoke||power_candidate) simulate_rd_test(design,model$null,model$scenario,n,ncal,config$seed+n*10000+i*1000000,config$alpha) else NULL
    calibrated <- !is.null(calibration) && calibration$rejection$interval[2]<=config$calibrationTypeIUpper && calibration$coverage$interval[1]>=config$calibrationCoverageLower
    passed[i] <- calibrated && alternative$rejection$interval[1]>=config$targetPower
    records[[length(records)+1]] <- list(n=n,maxRandomized=cap,scenario=model$scenario,
      fixedTaskEffects=list(caseIds=case_ids,intercepts=model$null$taskIntercepts,fullOffsets=model$null$taskFullOffsets,genetonicOffsets=model$null$taskGenetonicOffsets),
      achievedNullRD=model$null$achievedRiskDifference,achievedAlternativeRD=model$alternative$achievedRiskDifference,
      calibration=calibration,calibrationStatus=if(is.null(calibration))'deferred-until-power-candidate' else 'executed',
      alternative=alternative,calibrationPassed=calibrated,selectionCriterionPassed=passed[i])
    cat('N',n,'task-condition SD',model$scenario$taskConditionSD,'power',alternative$rejection$estimate,
      'null calibration',if(is.null(calibration))'deferred' else paste('type-I',calibration$rejection$estimate,'coverage',calibration$coverage$estimate),'\n')
  }
  if(all(passed)&&!smoke)selected_n<-n
  output <- list(schemaVersion=2,estimand='finite-task-equal-weight-risk-difference',
    status=if(smoke)'smoke-not-for-recruitment' else if(!is.null(selected_n))'power-selected' else 'search-in-progress',
    selectedN=selected_n,config=config,results=records,casesSha256=digest::digest(file=config$casesPath,algo='sha256'),
    studyCodeSha256=code_record$studyCodeSha256,analysisEnvironment=list(R=R.version.string,lme4=as.character(utils::packageVersion('lme4'))),
    generatingModel='Logistic participant intercept/slope mixture with fixed case and case-by-condition offsets. Both null and alternative are calibrated to the equal-case marginal RD.',
    inference='Exact same participant-cluster jackknife t test and interval as the main observed-data analysis.',
    recruitment='Fixed initial target followed by whole six-person blocks according to retained primary-record availability, bounded by the prespecified attrition allowance.',
    uncertaintyScope='Conditional on this frozen finite task pool. Task-effect scenarios are sensitivity analyses and do not establish performance on new tasks.',
    selectionRule='Minimum evaluated N with alternative power lower95 >=.80, null type-I upper95 <=.06 and null coverage lower95 >=.94 in every fixed scenario. Non-estimable repeats remain in all denominators.',
    sessionInfo=capture.output(sessionInfo()))
  dir.create(dirname(args[2]),recursive=TRUE,showWarnings=FALSE)
  jsonlite::write_json(output,args[2],pretty=TRUE,auto_unbox=TRUE,na='null',null='null',digits=NA)
  if(smoke||!is.null(selected_n))break
  n<-n+6L
}
