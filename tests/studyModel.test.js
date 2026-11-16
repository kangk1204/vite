// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';

function run(code) {
  const result=spawnSync('Rscript',['-e',code],{encoding:'utf8',timeout:60000});
  expect(result.status,result.stderr).toBe(0);
  return result.stdout;
}

describe('finite-task participant-cluster inference',()=>{
  it('matches equal-case estimates and a direct leave-one-participant-out jackknife with partial rows',()=>{
    const output=run(`source('scripts/study/model.R');set.seed(31);d<-expand.grid(participantId=paste0('P',1:24),caseId=paste0('C',1:12));d$condition<-c('pnv_basic','pnv_full','genetonic')[(as.integer(factor(d$participantId))+as.integer(factor(d$caseId)))%%3+1];d$error<-rbinom(nrow(d),1,ifelse(d$condition=='pnv_full',.2,.35));d$allocationProfile<-paste0('profile',as.integer(factor(d$participantId))%%6);d<-d[-c(1,5,8),];cases<-paste0('C',1:12);estimate<-function(x)mean(vapply(cases,function(id)mean(x$error[x$caseId==id&x$condition=='pnv_full'])-mean(x$error[x$caseId==id&x$condition=='pnv_basic']),numeric(1)));out<-finite_task_inference(d,'error',cases);manual<-vapply(unique(d$participantId),function(id)estimate(d[d$participantId!=id,]),numeric(1));n<-length(manual);se<-sqrt((n-1)/n*sum((manual-mean(manual))^2));stopifnot(out$status=='estimable',abs(out$estimate-estimate(d))<1e-12,abs(out$standardError-se)<1e-12,abs(out$pvalue-2*pt(-abs(out$estimate/se),n-1))<1e-12);bad<-d[!(d$caseId=='C1'&d$condition=='pnv_full'),];b<-finite_task_inference(bad,'error',cases);stopifnot(b$status=='not-estimable',is.null(b$pvalue),length(b$emptyCells)==1);boot<-participant_bootstrap(d,'error',cases,attempts=100);stopifnot(boot$attempts==100,boot$valid+boot$failed==100);cat('finite pool contract passed')`);
    expect(output).toContain('finite pool contract passed');
  },65000);
  it('calibrates both null and alternative equal-case marginal risk differences under task-condition variation',()=>{
    const output=run(`source('scripts/study/power_helpers.R');s<-list(baseline=.35,participantSD=1,taskSD=1,slopeSD=.5,taskConditionSD=.5);for(delta in c(0,.1)){d<-calibrate_finite_dgp(paste0('C',1:12),s,delta,20261116);stopifnot(abs(d$achievedRiskDifference+delta)<1e-8)};cat('marginal risk target passed')`);
    expect(output).toContain('marginal risk target passed');
  },65000);
  it('withholds a stratified bootstrap interval when a frozen allocation profile is a singleton',()=>{
    const output=run(`source('scripts/study/model.R');d<-expand.grid(participantId=paste0('P',1:6),caseId=paste0('C',1:12));d$condition<-c('pnv_basic','pnv_full','genetonic')[(as.integer(factor(d$participantId))+as.integer(factor(d$caseId)))%%3+1];d$error<-as.integer(seq_len(nrow(d))%%5==0);d$allocationProfile<-d$participantId;b<-participant_bootstrap(d,'error',paste0('C',1:12),attempts=10000);stopifnot(b$requestedAttempts==10000,b$attempts==0,b$valid==0,b$singletonProfiles==6,all(is.na(b$interval)),grepl('singleton',b$failureReason));cat('singleton interval unavailable')`);
    expect(output).toContain('singleton interval unavailable');
  },65000);
});
