# Finite-task generating model and outcome-independent recruitment policy.
marginal_probabilities <- function(locations, variance) {
  vapply(locations,function(location) integrate(function(z) plogis(location+sqrt(variance)*z)*dnorm(z),
    -10,10,rel.tol=1e-11,abs.tol=1e-12)$value,numeric(1))
}

calibrate_finite_dgp <- function(case_ids, scenario, reduction, seed) {
  set.seed(seed)
  standardized <- matrix(rnorm(length(case_ids)*3),ncol=3)
  standardized <- sweep(standardized,2,colMeans(standardized))
  standardized <- sweep(standardized,2,apply(standardized,2,sd),'/')
  task_intercepts <- standardized[,1]*scenario$taskSD
  full_offsets <- standardized[,2]*scenario$taskConditionSD
  gt_offsets <- standardized[,3]*scenario$taskConditionSD
  variance <- scenario$participantSD^2
  intercept <- uniroot(function(x) mean(marginal_probabilities(x+task_intercepts,variance))-scenario$baseline,
    c(-20,20),tol=1e-10)$root
  full <- uniroot(function(x) mean(marginal_probabilities(intercept+x+task_intercepts+full_offsets,
    variance+scenario$slopeSD^2))-(scenario$baseline-reduction),c(-20,20),tol=1e-10)$root
  gt <- uniroot(function(x) mean(marginal_probabilities(intercept+x+task_intercepts+gt_offsets,
    variance+scenario$slopeSD^2))-scenario$baseline,c(-20,20),tol=1e-10)$root
  baseline <- marginal_probabilities(intercept+task_intercepts,variance)
  alternative <- marginal_probabilities(intercept+full+task_intercepts+full_offsets,variance+scenario$slopeSD^2)
  list(caseIds=case_ids,intercept=intercept,fullCoefficient=full,genetonicCoefficient=gt,
    taskIntercepts=task_intercepts,taskFullOffsets=full_offsets,taskGenetonicOffsets=gt_offsets,
    participantSD=scenario$participantSD,slopeSD=scenario$slopeSD,
    baselineCaseProbabilities=baseline,fullCaseProbabilities=alternative,
    targetRiskDifference=-reduction,achievedRiskDifference=mean(alternative-baseline),taskOffsetSeed=seed)
}

simulate_retained_trials <- function(design,dgp,scenario,target_n,seed) {
  set.seed(seed)
  participants <- unique(as.character(design$participantId))
  individual <- match(as.character(design$participantId),participants)
  task <- match(as.character(design$caseId),dgp$caseIds)
  intercepts <- rnorm(length(participants),sd=dgp$participantSD)
  full_slopes <- rnorm(length(participants),sd=dgp$slopeSD)
  gt_slopes <- rnorm(length(participants),sd=dgp$slopeSD)
  eta <- dgp$intercept+dgp$taskIntercepts[task]+intercepts[individual]+
    as.numeric(design$condition=='pnv_full')*(dgp$fullCoefficient+dgp$taskFullOffsets[task]+full_slopes[individual])+
    as.numeric(design$condition=='genetonic')*(dgp$genetonicCoefficient+dgp$taskGenetonicOffsets[task]+gt_slopes[individual])
  observed <- design
  observed$error <- rbinom(nrow(design),1,plogis(eta))
  disposition <- runif(length(participants))
  withdrawn <- disposition < scenario$withdrawalProbability
  partial <- !withdrawn & disposition < scenario$withdrawalProbability+scenario$partialLossProbability
  available <- !withdrawn[individual]
  for(i in which(partial)) {
    candidate <- which(individual==i)
    lost <- candidate[sample.int(length(candidate),min(2,length(candidate)))]
    available[lost] <- FALSE
  }
  complete_primary <- vapply(seq_along(participants),function(i) {
    rows <- individual==i
    sum(available & rows & design$condition=='pnv_full')==4 && sum(available & rows & design$condition=='pnv_basic')==4
  },logical(1))
  enrollment <- length(participants)
  for(n in seq(target_n,length(participants),by=6)) {
    if(sum(complete_primary[seq_len(n)])>=target_n) {enrollment<-n;break}
  }
  used <- individual<=enrollment
  list(rows=observed[available&used,,drop=FALSE],randomized=enrollment,
    withdrawn=sum(withdrawn[seq_len(enrollment)]),partial=sum(partial[seq_len(enrollment)]),
    completePrimary=sum(complete_primary[seq_len(enrollment)]),observedTrials=sum(available&used))
}

simulate_rd_test <- function(design,dgp,scenario,target_n,simulations,seed,alpha=.05) {
  rejected <- covered <- estimable <- logical(simulations)
  observed_n <- observed_trials <- randomized_n <- numeric(simulations)
  reasons <- character()
  for(index in seq_len(simulations)) {
    simulated <- simulate_retained_trials(design,dgp,scenario,target_n,seed+index)
    result <- finite_task_inference(simulated$rows,'error',dgp$caseIds,alpha=alpha)
    randomized_n[index] <- simulated$randomized
    observed_n[index] <- result$participants
    observed_trials[index] <- simulated$observedTrials
    estimable[index] <- result$status=='estimable'
    if(!estimable[index]) {reasons<-c(reasons,result$reason);next}
    rejected[index] <- result$pvalue<alpha
    covered[index] <- result$interval[1]<=dgp$achievedRiskDifference && result$interval[2]>=dgp$achievedRiskDifference
  }
  proportion <- function(values) list(count=sum(values),total=simulations,estimate=mean(values),
    interval=unname(binom.test(sum(values),simulations)$conf.int))
  list(simulations=simulations,rejection=proportion(rejected),coverage=proportion(covered),
    estimable=sum(estimable),unestimable=simulations-sum(estimable),failureReasons=as.list(table(reasons)),
    observedParticipantsRange=range(observed_n),observedTrialsRange=range(observed_trials),randomizedParticipantsRange=range(randomized_n))
}
