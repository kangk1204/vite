/** Study administration helpers. These validate records; they do not supply human evidence. */
import { randomUUID } from 'node:crypto';
import { authorizedResponses, dispositionMap, recruitmentDecision, recruitmentPlan } from './study_retention.mjs';
export const CONDITIONS = ['pnv_full', 'pnv_basic', 'genetonic'];
export const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const STATUSES = ['completed', 'timeout', 'abandoned', 'system_error'];

function requireUnique(values, label) {
  if (values.some(value => typeof value !== 'string' || !value.trim()) || new Set(values).size !== values.length) {
    throw new Error(`${label} must be non-empty and unique.`);
  }
}

function twoIdentities(values) {
  return Array.isArray(values) && values.length === 2 && values.every(value => typeof value === 'string' && value.trim()) && new Set(values).size === 2;
}

function permutation(length, seed) {
  let state = Number(seed) >>> 0;
  const ranked = Array.from({ length }, (_, index) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return { index, rank: state };
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.index);
}

export function assertStudyGates(gates = {}, phase) {
  if (phase === 'dry_run') return;
  if (!['pilot', 'main'].includes(phase)) throw new Error('phase must be pilot, main, or dry_run.');
  if (!['approved', 'exempt'].includes(gates.institutionalDetermination)) throw new Error('An institutional determination is required.');
  if (!gates.institutionalReference) throw new Error('An institutional reference is required.');
  if (gates.consentMaterialsApproved !== true) throw new Error('Approved consent materials are required.');
  if (phase === 'main') {
    if (!/^https:\/\//.test(gates.preregistrationUrl ?? '') || !/^[a-f0-9]{64}$/.test(gates.protocolSha256 ?? '')) throw new Error('A frozen preregistration and protocol hash are required.');
    if (gates.completedPilotParticipants !== 6) throw new Error('Six completed pilot participants, excluded from the main study, are required.');
    if (!Number.isInteger(gates.plannedSampleSize) || gates.plannedSampleSize < 6 || gates.plannedSampleSize % 6) throw new Error('A power-selected sample size in multiples of six is required.');
    if (!/^[a-f0-9]{64}$/.test(gates.powerArtifactSha256 ?? '')) throw new Error('A frozen power artifact is required.');
  }
}

export function buildAssignments(participants, cases, options = {}) {
  const { phase = 'main', gates = {}, seed = 20261110, timeoutMs = 240000, startIndex = 0 } = options;
  assertStudyGates(gates, phase);
  if (!Number.isInteger(seed) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid seed or timeout.');
  if (!Array.isArray(participants) || !participants.length || !Array.isArray(cases)) throw new Error('Participant and case arrays are required.');
  requireUnique(participants.map(p => p.id), 'Participant identifiers');
  requireUnique(cases.map(c => c.id), 'Case identifiers');
  if (phase !== 'dry_run' && participants.some(p => p.consent !== true)) throw new Error('Every participant requires recorded consent.');
  if (participants.some(p => !['novice', 'experienced'].includes(p.experience))) throw new Error('Experience must be novice or experienced.');
  if (phase === 'main' && participants.some(p => p.wasPilot !== false)) throw new Error('Main participants require explicit wasPilot:false eligibility.');
  if (phase === 'main' && !options.replacement && participants.length !== gates.plannedSampleSize) throw new Error('Initial main roster must equal the frozen planned sample size.');
  if (phase === 'pilot' && participants.length !== 6) throw new Error('Pilot roster must contain exactly six participants.');
  const splitByFamily = new Map();
  for (const item of cases) {
    if (splitByFamily.has(item.familyId) && splitByFamily.get(item.familyId) !== item.split) throw new Error('Case family leaks across development and held-out splits.');
    splitByFamily.set(item.familyId, item.split);
  }
  const eligible = phase === 'dry_run' ? cases : cases.filter(c => c.split === (phase === 'main' ? 'held_out' : 'development'));
  requireUnique(eligible.map(c => c.familyId), 'Eligible case families');
  const contexts=eligible.filter(c=>c.contextId!==undefined||c.exposureKeys!==undefined);
  if (contexts.length && contexts.length!==eligible.length) throw new Error('All cases need the same analysis-context metadata contract.');
  if (contexts.length) {
    requireUnique(contexts.map(c=>c.contextId),'Analysis contexts');
    const exposure=new Set();
    for (const item of contexts) {
      if (!Array.isArray(item.exposureKeys)||!item.exposureKeys.length) throw new Error('Context exposure keys are required.');
      for (const key of item.exposureKeys) {
        if (typeof key!=='string'||!key.trim()||exposure.has(key)) throw new Error(`Repeated or invalid target exposure: ${key}`);
        exposure.add(key);
      }
    }
  }
  if (phase !== 'dry_run' && !contexts.length) throw new Error('Real assignments require revised analysis-context exposure metadata.');
  if (phase !== 'dry_run' && eligible.some(c => c.adjudicationStatus !== 'adjudicated' || c.evidenceReady !== true || !twoIdentities(c.reviewers))) {
    throw new Error('Cases require evidence packets and two independent expert adjudicators.');
  }
  const pools = Object.fromEntries(['ordinary', 'audit'].map(type => {
    const pool = eligible.filter(c => c.taskType === type);
    requireUnique(pool.map(c => c.familyId), `${type} case families`);
    if (pool.length < 6) throw new Error(`At least six distinct ${type} case families are required.`);
    return [type, permutation(pool.length, seed + (type === 'audit' ? 1 : 0)).map(i => pool[i])];
  }));
  const orderPermutation = permutation(6, seed);
  const rosterOrder = participants.flatMap((_,i)=>i%6 ? [] : permutation(Math.min(6,participants.length-i),seed+7+Math.floor((startIndex+i)/6)).map(j=>participants[i+j]));
  const ordered = rosterOrder.map((participant, i) => ({
    ...participant, order: ORDERS[orderPermutation[(startIndex+i) % 6]].map(index => CONDITIONS[index]),
    caseBlockRotation: Math.floor((startIndex+i)/6)%3,
  }));
  const assignments = ordered.flatMap((participant, participantIndex) => {
    const used = new Set();
    return participant.order.flatMap((condition, periodIndex) => ['ordinary', 'ordinary', 'audit', 'audit'].map((taskType, taskIndex) => {
      const pool = pools[taskType];
      const first = CONDITIONS.indexOf(participant.order[0]);
      const orientation = (CONDITIONS.indexOf(participant.order[1]) - first + 3) % 3;
      const block = (first - orientation * periodIndex + participant.caseBlockRotation + 6) % 3;
      const offset = Math.floor((startIndex+participantIndex) / 6) * 6 + block * 2 + taskIndex % 2;
      const selected = pool[offset % pool.length];
      if (used.has(selected.familyId)) throw new Error('A case family would repeat within a participant.');
      used.add(selected.familyId);
      return {
        participantId: participant.id, experience: participant.experience,
        trialId: `T${String(periodIndex * 4 + taskIndex + 1).padStart(2, '0')}`,
        condition, period: periodIndex + 1, taskType, caseId: selected.id,
        familyId: selected.familyId, sourcePacketId: selected.sourcePacketId,
        contextId: selected.contextId ?? selected.familyId, exposureKeys: selected.exposureKeys ?? [],
        allocationProfile: `${participant.order.join('|')}|rotation-${participant.caseBlockRotation}`,
      };
    }));
  });
  return { schemaVersion: 2, phase, dataOrigin: phase === 'dry_run' ? 'synthetic' : 'human', seed, timeoutMs,
    taskPool:eligible.map(c=>({caseId:c.id,contextId:c.contextId??c.familyId,taskType:c.taskType})),
    estimand:'Equal-case-weight full-minus-basic risk difference, conditional on the frozen held-out task pool',
    recruitment:phase==='main'?recruitmentPlan(gates.plannedSampleSize,options.attritionFraction??.2):null,
    plannedSampleSize: phase === 'main' ? gates.plannedSampleSize : null,
    protocolSha256: phase === 'main' ? gates.protocolSha256 : null,
    powerArtifactSha256: phase === 'main' ? gates.powerArtifactSha256 : null,
    participants: ordered, assignments };
}

export function appendAssignments(schedule, participants, cases, options = {}) {
  const decision=recruitmentDecision(schedule,options.responses,options.dispositions);
  if (decision.action!=='enroll_next_block' || participants.length!==decision.nextBlockSize) throw new Error('The prespecified administrative rule does not permit this replacement block.');
  const prior=new Set(schedule.participants.map(p=>p.id));
  if (participants.some(p=>prior.has(p.id))) throw new Error('Replacement participant identifiers must be new.');
  const block=buildAssignments(participants,cases,{...options,phase:schedule.phase,seed:schedule.seed,timeoutMs:schedule.timeoutMs,
    startIndex:schedule.participants.length,replacement:true});
  if (JSON.stringify(block.taskPool)!==JSON.stringify(schedule.taskPool)) throw new Error('Replacement task pool differs from the frozen schedule.');
  return {...schedule,participants:[...schedule.participants,...block.participants],assignments:[...schedule.assignments,...block.assignments]};
}

export function auditAssignments(schedule) {
  const contexts=[];
  for(const person of schedule.participants){
    const rows=schedule.assignments.filter(row=>row.participantId===person.id);
    const keys=rows.flatMap(row=>row.exposureKeys??[]);
    contexts.push({participantId:person.id,taskCount:rows.length,uniqueContexts:new Set(rows.map(row=>row.contextId)).size,
      contextMetadataComplete:rows.every(row=>Array.isArray(row.exposureKeys)&&row.exposureKeys.length>0),
      exposureCollisions:keys.length-new Set(keys).size});
  }
  const ids=[...new Set(schedule.assignments.map(row=>row.caseId))];
  const cells=ids.map(caseId=>{
    const rows=schedule.assignments.filter(row=>row.caseId===caseId);
    const condition=CONDITIONS.map(value=>rows.filter(row=>row.condition===value).length);
    const period=[1,2,3].map(value=>rows.filter(row=>row.period===value).length);
    const threeWay=CONDITIONS.flatMap(value=>[1,2,3].map(p=>({condition:value,period:p,count:rows.filter(row=>row.condition===value&&row.period===p).length})));
    return {caseId,conditionCounts:condition,periodCounts:period,pairwiseBalanced:new Set(condition).size===1&&new Set(period).size===1,
      threeWay,threeWayBalanced:new Set(threeWay.map(row=>row.count)).size===1};
  });
  return {participants:contexts,cases:cells,allTargetsUnique:contexts.every(row=>row.taskCount===12&&row.uniqueContexts===12&&row.contextMetadataComplete&&row.exposureCollisions===0),
    pairwiseBalanced:cells.every(row=>row.pairwiseBalanced),threeWayBalanced:cells.every(row=>row.threeWayBalanced),
    threeWayCountRange:[Math.min(...cells.flatMap(row=>row.threeWay.map(x=>x.count))),Math.max(...cells.flatMap(row=>row.threeWay.map(x=>x.count)))]};
}

export function validateResponses(schedule, responses, options = {}) {
  if (!Array.isArray(responses) || !Array.isArray(schedule?.assignments)) return ['Invalid schedule or response array.'];
  const expected = new Map(schedule.assignments.map(row => [`${row.participantId}:${row.trialId}`, row]));
  const seen = new Set();
  const errors = [];
  const dispositions=dispositionMap(schedule,options.dispositions);
  for (const response of responses) {
    const key = `${response.participantId}:${response.trialId}`;
    const assignment = expected.get(key);
    if (!assignment) { errors.push(`Unscheduled response: ${key}`); continue; }
    if (!dispositions.get(response.participantId).allowUse) continue;
    if (seen.has(key)) errors.push(`Duplicate response: ${key}`);
    seen.add(key);
    for (const field of ['condition', 'period', 'caseId']) if (response[field] !== assignment[field]) errors.push(`${field} differs from assignment for ${key}`);
    if (response.dataOrigin !== schedule.dataOrigin || response.phase !== schedule.phase) errors.push(`Origin or phase mismatch for ${key}`);
    if (!STATUSES.includes(response.status)) errors.push(`Invalid status for ${key}`);
    if (!Number.isFinite(response.elapsedMs) || response.elapsedMs < 0) errors.push(`Invalid elapsedMs for ${key}`);
    if (response.status === 'completed' && response.elapsedMs > schedule.timeoutMs) errors.push(`Completed trial exceeds frozen time limit for ${key}`);
    if (response.confidence !== null && (!Number.isFinite(response.confidence) || response.confidence < 0 || response.confidence > 1)) errors.push(`confidence must be in [0,1] for ${key}`);
    if (response.status === 'completed' && (typeof response.answer !== 'string' || !response.answer.trim() || response.confidence === null)) errors.push(`Completed trial lacks answer/confidence for ${key}`);
    if(response.selfReportedPriorExposure!==undefined&&!['yes','no','unsure'].includes(response.selfReportedPriorExposure))errors.push(`Invalid prior-exposure report for ${key}`);
    if(response.priorTargetVisits!==undefined&&(!Number.isInteger(response.priorTargetVisits)||response.priorTargetVisits<0))errors.push(`Invalid context visit count for ${key}`);
  }
  for (const [key,assignment] of expected) {
    const disposition=dispositions.get(assignment.participantId);
    if (disposition.allowUse && disposition.status==='completed' && !seen.has(key)) errors.push(`Missing scheduled trial: ${key}`);
  }
  return errors;
}

export function blindResponses(responses) {
  return createBlindedPacket(responses).rows;
}

export function createBlindedPacket(responses) {
  const key = responses.map(({ participantId, trialId }) => ({ ratingId: randomUUID(), participantId, trialId }));
  const rows = responses.map(({ caseId, answer }, index) => ({ ratingId: key[index].ratingId, caseId, answer })).sort((a, b) => a.ratingId.localeCompare(b.ratingId));
  return { rows, key };
}

export function prepareAnalysisRows(schedule, responses, ratings, options = {}) {
  const { phase = 'main', timeoutMs = schedule.timeoutMs } = options;
  if (timeoutMs !== schedule.timeoutMs) throw new Error('Analysis time limit differs from the frozen assignment.');
  if (phase !== 'dry_run' && (schedule.dataOrigin !== 'human' || responses.some(r => r.dataOrigin !== 'human'))) throw new Error('Cannot analyze synthetic responses as human data.');
  if (schedule.phase !== phase || (phase === 'main' && schedule.participants.some(p => p.wasPilot))) throw new Error('Main and pilot records must remain separate.');
  if (phase === 'main' && (!options.ratingKey || !options.dispositions || !/^[a-f0-9]{64}$/.test(schedule.protocolSha256 ?? ''))) throw new Error('Main analysis requires opaque rating keys, dispositions and frozen protocol metadata.');
  const dispositions=dispositionMap(schedule,options.dispositions);
  if ([...dispositions.values()].some(row=>row.status==='active')) throw new Error('Close the administrative disposition roster before preparing outcomes.');
  const keyedRatings = options.ratingKey ? ratings.map(rating => {
    const match = options.ratingKey.filter(item => item.ratingId === rating.ratingId);
    if (match.length !== 1) throw new Error('Missing or duplicate opaque rating key.');
    return { ...rating, participantId: match[0].participantId, trialId: match[0].trialId };
  }) : ratings;
  const errors = validateResponses(schedule, responses,{dispositions:options.dispositions});
  if (errors.length) throw new Error(errors.join('\n'));
  return authorizedResponses(schedule,responses,options.dispositions).map(response => {
    const assignment = schedule.assignments.find(a => a.participantId === response.participantId && a.trialId === response.trialId);
    const judgments = keyedRatings.filter(r => r.participantId === response.participantId && r.trialId === response.trialId);
    if (response.status==='completed' && (!twoIdentities(judgments.map(r => r.raterId)) || judgments.some(r => typeof r.correct !== 'boolean'))) throw new Error(`Exactly two independent ratings required for ${response.participantId}:${response.trialId}`);
    if (response.status==='completed' && judgments[0].correct !== judgments[1].correct) throw new Error(`Unresolved rating disagreement for ${response.participantId}:${response.trialId}`);
    const correct = response.status === 'completed' && judgments[0].correct;
    return {
      ...assignment, phase, dataOrigin: schedule.dataOrigin, status: response.status,
      error: correct ? 0 : 1, elapsedMs: response.elapsedMs,
      penalizedTimeMs: correct ? Math.min(response.elapsedMs, timeoutMs) : timeoutMs,
      confidence: response.confidence, brier: response.confidence === null ? null : (response.confidence - Number(correct)) ** 2,
      priorTargetVisits:response.priorTargetVisits??null,selfReportedPriorExposure:response.selfReportedPriorExposure??'unrecorded',
    };
  });
}

function proportion(successes, total) {
  if (!total) return { successes, total, estimate: null, interval: [null, null] };
  const z = 1.959963984540054;
  const p = successes / total;
  const scale = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / scale;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / scale;
  return { successes, total, estimate: p, interval: [Math.max(0, center - half), Math.min(1, center + half)] };
}

export function evaluateDetector(rows) {
  if (rows.some(r => !['normal', 'mismatch', 'unverifiable'].includes(r.truth) || !['normal', 'mismatch', 'unverifiable'].includes(r.predicted))) throw new Error('Unknown detector label.');
  const positives = rows.filter(r => r.truth === 'mismatch');
  const negatives = rows.filter(r => r.truth === 'normal');
  const unknown = rows.filter(r => r.truth === 'unverifiable');
  return {
    sensitivity: proportion(positives.filter(r => r.predicted === 'mismatch').length, positives.length),
    specificity: proportion(negatives.filter(r => r.predicted === 'normal').length, negatives.length),
    unverifiable: { total: unknown.length, correctlyAbstained: unknown.filter(r => r.predicted === 'unverifiable').length },
    intervalMethod: 'Wilson 95%; case is the observational unit',
  };
}
