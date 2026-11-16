const CLOSED_STATES = ['completed','stopped_retain','technical_loss','missing_unknown','no_data','withdrawn_delete'];
const OBSERVED_STATUSES = ['completed','timeout','abandoned','system_error'];

export function dispositionMap(schedule, dispositions) {
  const rows = dispositions ?? schedule.participants.map(p=>({participantId:p.id,status:'completed',allowUse:true}));
  if (!Array.isArray(rows) || rows.length !== schedule.participants.length) throw new Error('Disposition roster must cover every randomized participant.');
  const ids = new Set(schedule.participants.map(p=>p.id));
  const map = new Map();
  for (const row of rows) {
    if (!ids.has(row.participantId) || map.has(row.participantId)) throw new Error('Unknown or duplicate participant in disposition roster.');
    if (![...CLOSED_STATES,'active'].includes(row.status) || typeof row.allowUse !== 'boolean') throw new Error('Invalid participant disposition or data-use permission.');
    if ((row.status === 'withdrawn_delete') !== (row.allowUse === false)) throw new Error('Withdrawal-delete must remove permission to use the records.');
    if (['technical_loss','missing_unknown','no_data'].includes(row.status) && (typeof row.reason !== 'string' || !row.reason.trim())) throw new Error('Loss or unknown missingness requires an administrative reason.');
    map.set(row.participantId,{...row});
  }
  return map;
}

export function authorizedResponses(schedule, responses, dispositions) {
  const allowed = dispositionMap(schedule, dispositions);
  return responses.filter(row=>allowed.get(row.participantId)?.allowUse === true);
}

export function retentionSummary(schedule, responses, dispositions) {
  const status=dispositionMap(schedule,dispositions);
  const expected=new Set(schedule.assignments.map(r=>`${r.participantId}:${r.trialId}`));
  const seen=new Set();
  for (const row of responses) {
    const key=`${row.participantId}:${row.trialId}`;
    if (!expected.has(key) || seen.has(key)) throw new Error('Unknown or duplicate trial in retention records.');
    seen.add(key);
  }
  const authorized=authorizedResponses(schedule,responses,dispositions);
  if(authorized.some(row=>status.get(row.participantId).status==='no_data')) throw new Error('A no-data disposition conflicts with retained response records.');
  const roster=schedule.participants.map(participant=>{
    const disposition=status.get(participant.id);
    const observed=authorized.filter(row=>row.participantId===participant.id);
    const counts=Object.fromEntries(['pnv_full','pnv_basic','genetonic'].map(condition=>[condition,observed.filter(row=>row.condition===condition && OBSERVED_STATUSES.includes(row.status)).length]));
    return {participantId:participant.id,...disposition,observedTrials:observed.length,observedByCondition:counts,
      completePrimary:disposition.allowUse && counts.pnv_full===4 && counts.pnv_basic===4};
  });
  return {
    randomizedParticipants:roster.length,
    authorizedParticipants:roster.filter(row=>row.allowUse).length,
    observedParticipants:roster.filter(row=>row.observedTrials>0).length,
    completePrimaryParticipants:roster.filter(row=>row.completePrimary).length,
    completeAllConditionsParticipants:roster.filter(row=>row.observedTrials===12).length,
    partialParticipants:roster.filter(row=>row.observedTrials>0&&row.observedTrials<12).length,
    withdrawnDeleteParticipants:roster.filter(row=>row.status==='withdrawn_delete').length,
    technicalLossParticipants:roster.filter(row=>row.status==='technical_loss').length,
    unknownMissingnessParticipants:roster.filter(row=>row.status==='missing_unknown').length,
    scheduledTrials:schedule.assignments.length,observedTrials:authorized.length,
    unobservedRetainedTrials:roster.filter(row=>row.allowUse).reduce((sum,row)=>sum+12-row.observedTrials,0),
    removedFromUseTrials:responses.length-authorized.length,roster,
  };
}

export function recruitmentPlan(target, attritionFraction=.2) {
  if (!Number.isSafeInteger(target)||target<6||target%6||!Number.isFinite(attritionFraction)||attritionFraction<0||attritionFraction>=1) throw new Error('Invalid fixed recruitment target or attrition allowance.');
  return {targetCompletePrimary:target,attritionFraction,blockSize:6,maxRandomized:6*Math.ceil(target/(1-attritionFraction)/6)};
}

export function recruitmentDecision(schedule,responses,dispositions) {
  const flow=retentionSummary(schedule,responses,dispositions);
  const plan=schedule.recruitment;
  if (!plan) throw new Error('A prespecified recruitment plan is required.');
  if (flow.roster.some(row=>row.status==='active')) return {action:'await_current_block',flow,plan};
  if (flow.completePrimaryParticipants>=plan.targetCompletePrimary) return {action:'stop_target_reached',flow,plan};
  if (flow.randomizedParticipants>=plan.maxRandomized) return {action:'stop_cap_reached',flow,plan};
  return {action:'enroll_next_block',nextBlockSize:Math.min(6,plan.maxRandomized-flow.randomizedParticipants),flow,plan};
}

export function redactParticipant(records, participantId) {
  const removedIds=new Set((records.ratingKey??[]).filter(row=>row.participantId===participantId).map(row=>row.ratingId));
  return {
    responses:(records.responses??[]).filter(row=>row.participantId!==participantId),
    ratings:(records.ratings??[]).filter(row=>row.participantId!==participantId&&!removedIds.has(row.ratingId)),
    ratingKey:(records.ratingKey??[]).filter(row=>row.participantId!==participantId),
  };
}
