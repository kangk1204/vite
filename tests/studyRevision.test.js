// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { buildAssignments, validateResponses, prepareAnalysisRows, appendAssignments } from '../scripts/study/protocol.mjs';
import { retentionSummary, recruitmentDecision, redactParticipant } from '../scripts/study/study_retention.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { main } from '../scripts/study/run_study.mjs';

const cases = Array.from({length:12},(_,i)=>({id:`C${i}`,familyId:`F${i}`,contextId:`X${i}`,exposureKeys:[`pathway:P${i}`,`gene:G${i}`],taskType:i%2?'audit':'ordinary',sourcePacketId:`S${i}`}));
const participants=Array.from({length:6},(_,i)=>({id:`P${i}`,experience:i%2?'novice':'experienced'}));
function fixture() {
  const schedule=buildAssignments(participants,cases,{phase:'dry_run'});
  const responses=schedule.assignments.map(r=>({...r,status:'completed',elapsedMs:1000,answer:'synthetic response',confidence:.7,phase:'dry_run',dataOrigin:'synthetic'}));
  const dispositions=participants.map(p=>({participantId:p.id,status:'completed',allowUse:true}));
  const ratings=responses.flatMap(r=>['A','B'].map(raterId=>({participantId:r.participantId,trialId:r.trialId,raterId,correct:true})));
  return {schedule,responses,dispositions,ratings};
}

describe('revised study retention and target exposure',()=>{
  it('detects context reuse even when question and family identifiers differ',()=>{
    expect(()=>buildAssignments(participants,cases.map((c,i)=>i===1?{...c,exposureKeys:cases[0].exposureKeys}:c),{phase:'dry_run'})).toThrow(/exposure/);
    const schedule=buildAssignments(participants,cases,{phase:'dry_run'});
    for(const p of participants){const rows=schedule.assignments.filter(r=>r.participantId===p.id);expect(new Set(rows.map(r=>r.contextId)).size).toBe(12);}
  });
  it('excludes full withdrawal and retains only observed rows after documented technical loss',()=>{
    const f=fixture();const dispositions=f.dispositions.map(p=>p.participantId==='P0'?{...p,status:'withdrawn_delete',allowUse:false}:p.participantId==='P1'?{...p,status:'technical_loss',reason:'Two trial records lost'}:p);
    const responses=f.responses.filter(r=>r.participantId!=='P0' && !(r.participantId==='P1'&&['T01','T02'].includes(r.trialId)));
    expect(validateResponses(f.schedule,responses,{dispositions})).toEqual([]);
    const rows=prepareAnalysisRows(f.schedule,responses,f.ratings,{phase:'dry_run',dispositions});
    expect(rows).toHaveLength(58);expect(rows.some(r=>r.participantId==='P0')).toBe(false);expect(rows.some(r=>r.status==='missing')).toBe(false);
    const summary=retentionSummary(f.schedule,responses,dispositions);
    expect(summary).toMatchObject({randomizedParticipants:6,withdrawnDeleteParticipants:1,observedParticipants:5,observedTrials:58,unobservedRetainedTrials:2});
  });
  it('requires an explicit disposition for missing records and redacts withdrawn answers and ratings',()=>{
    const f=fixture();expect(validateResponses(f.schedule,f.responses.slice(1),{dispositions:f.dispositions}).some(e=>e.includes('Missing'))).toBe(true);
    const data=redactParticipant({responses:f.responses,ratings:f.ratings,ratingKey:[]},'P0');
    expect(data.responses).toHaveLength(60);expect(data.ratings).toHaveLength(120);expect(data.responses.some(r=>r.participantId==='P0')).toBe(false);
  });
  it('uses only administrative completeness to release a capped replacement block',()=>{
    const f=fixture();const recruitment={targetCompletePrimary:6,attritionFraction:.2,blockSize:6,maxRandomized:12};const schedule={...f.schedule,recruitment};
    expect(recruitmentDecision(schedule,f.responses,f.dispositions).action).toBe('stop_target_reached');
    const dispositions=f.dispositions.map(p=>p.participantId==='P0'?{...p,status:'withdrawn_delete',allowUse:false}:p);
    const responses=f.responses.filter(r=>r.participantId!=='P0');
    expect(recruitmentDecision(schedule,responses,dispositions).action).toBe('enroll_next_block');
    expect(recruitmentDecision(schedule,responses.map(r=>({...r,answer:'different',confidence:0})),dispositions).action).toBe('enroll_next_block');
    const added=participants.map(p=>({...p,id:`NEXT_${p.id}`}));const next=appendAssignments(schedule,added,cases,{dispositions,responses});
    expect(next.participants).toHaveLength(12);expect(next.assignments.slice(0,72)).toEqual(schedule.assignments);
    const allDispositions=[...dispositions,...added.map(p=>({participantId:p.id,status:'no_data',allowUse:true,reason:'Lost session'}))];
    expect(recruitmentDecision(next,responses,allDispositions).action).toBe('stop_cap_reached');
  });
  it('runs actual preparation and R analysis with withdrawal and partial technical loss',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-retention-'));
    try {
      const cohort=Array.from({length:24},(_,i)=>({id:`SIM${i}`,experience:i%2?'novice':'experienced'}));
      const schedule=buildAssignments(cohort,cases,{phase:'dry_run',seed:20261116});
      let state=31;const random=()=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state/4294967296;};
      const responses=schedule.assignments.map(r=>({...r,status:'completed',elapsedMs:1000,answer:'synthetic',confidence:.7,phase:'dry_run',dataOrigin:'synthetic'}));
      const ratings=responses.flatMap(r=>{const correct=random()>.3;return ['A','B'].map(raterId=>({participantId:r.participantId,trialId:r.trialId,raterId,correct}));});
      const disposition=cohort.map(p=>({participantId:p.id,status:p.id==='SIM1'?'technical_loss':'completed',allowUse:true,...(p.id==='SIM1'?{reason:'Two unavailable records'}:{})}));
      const input={schedule,responses:responses.filter(r=>!(r.participantId==='SIM1'&&['T01','T02'].includes(r.trialId))),ratings,disposition,protocol:{seed:20261116,timeoutMs:240000,gates:{}}};
      for(const [name,value] of Object.entries(input))fs.writeFileSync(path.join(root,`${name}.json`),JSON.stringify(value));
      main(['withdraw','--assignments',path.join(root,'schedule.json'),'--responses',path.join(root,'responses.json'),'--ratings',path.join(root,'ratings.json'),'--dispositions',path.join(root,'disposition.json'),'--participant','SIM0','--out',path.join(root,'withdrawal.json')]);
      const prepared=path.join(root,'prepared.json');
      main(['prepare','--protocol',path.join(root,'protocol.json'),'--assignments',path.join(root,'schedule.json'),'--responses',path.join(root,'responses.json'),'--ratings',path.join(root,'ratings.json'),'--dispositions',path.join(root,'disposition.json'),'--phase','dry_run','--out',prepared]);
      const p=JSON.parse(fs.readFileSync(prepared));expect(p.rows).toHaveLength(274);expect(p.analysisFlow.roster.some(r=>r.participantId==='SIM0')).toBe(false);
      const output=path.join(root,'analysis.json');const run=spawnSync('Rscript',['scripts/study/analyze_study.R',prepared,output,'--dry-run'],{encoding:'utf8',timeout:90000});
      expect(run.status,run.stderr).toBe(0);const result=JSON.parse(fs.readFileSync(output));
      expect(result).toMatchObject({dataOrigin:'synthetic',participants:23,trials:274});
      expect(result.analysisFlow).toMatchObject({withdrawnDeleteParticipants:1,unobservedRetainedTrials:2});
      expect(result.primary.caseIds).toHaveLength(12);expect(result.primary.method).toContain('jackknife');
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  },95000);
  it('runs actual analysis with no authorized observations after complete withdrawal',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-withdraw-all-'));
    try {
      const f=fixture();const dispositions=f.dispositions.map(row=>({...row,status:'withdrawn_delete',allowUse:false}));
      const prepared={schemaVersion:2,phase:'dry_run',dataOrigin:'synthetic',timeoutMs:f.schedule.timeoutMs,
        taskPool:f.schedule.taskPool,analysisFlow:{...retentionSummary(f.schedule,[],dispositions),roster:[]},recruitmentDecision:{action:'dry_run'},
        rows:prepareAnalysisRows(f.schedule,[],[],{phase:'dry_run',dispositions})};
      const input=path.join(root,'prepared.json'),output=path.join(root,'analysis.json');
      fs.writeFileSync(input,JSON.stringify(prepared));
      const result=spawnSync('Rscript',['scripts/study/analyze_study.R',input,output,'--dry-run'],{encoding:'utf8',timeout:30000});
      expect(result.status,result.stderr).toBe(0);
      const analysis=JSON.parse(fs.readFileSync(output));
      expect(analysis).toMatchObject({participants:0,trials:0,primary:{status:'not-estimable',pvalue:null}});
      expect(analysis.primary.emptyCells).toHaveLength(24);
      expect(analysis.analysisFlow.withdrawnDeleteParticipants).toBe(6);
      expect(JSON.stringify(analysis)).not.toContain('"P0"');
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  },35000);
  it('retains recorded failures when every confidence value is missing',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-failure-records-'));
    try {
      const f=fixture();const responses=f.responses.map(row=>({...row,status:'timeout',elapsedMs:240000,confidence:null,answer:''}));
      const prepared={schemaVersion:2,phase:'dry_run',dataOrigin:'synthetic',timeoutMs:f.schedule.timeoutMs,taskPool:f.schedule.taskPool,
        analysisFlow:retentionSummary(f.schedule,responses,f.dispositions),recruitmentDecision:{action:'dry_run'},
        rows:prepareAnalysisRows(f.schedule,responses,[],{phase:'dry_run',dispositions:f.dispositions})};
      const input=path.join(root,'prepared.json'),output=path.join(root,'analysis.json');fs.writeFileSync(input,JSON.stringify(prepared));
      const run=spawnSync('Rscript',['scripts/study/analyze_study.R',input,output,'--dry-run'],{encoding:'utf8',timeout:30000});
      expect(run.status,run.stderr).toBe(0);const analysis=JSON.parse(fs.readFileSync(output));
      expect(analysis).toMatchObject({participants:6,trials:72});
      expect(analysis.secondary.confidenceBrierDifference).toMatchObject({status:'not-estimable',observedRows:0});
      expect(analysis.primary.estimate).toBe(0);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  },35000);
});
