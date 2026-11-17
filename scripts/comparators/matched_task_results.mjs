import {compareDisplay,compareNumeric,sameFormula,validateAccessObservation} from './matched_task_contract.mjs';

const canonical=value=>JSON.stringify(value,(_,item)=>item&&typeof item==='object'&&!Array.isArray(item)?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a.localeCompare(b))):item);
const lower=value=>String(value??'').replace(/\s+/g,' ').trim().toLowerCase();

export function verifyObservedValue(component,fact,observation,facts) {
  validateAccessObservation(observation);
  if(!['visible_native_report','documented_native_export','shared_companion','embedded_machine_record'].includes(observation.route))return{...observation,status:observation.route,matches_source:null};
  const value=observation.observed,expected=fact.expected;
  let matches,numericAgreement;
  if(fact.kind==='number'){
    numericAgreement=observation.route==='visible_native_report'?compareDisplay(value,expected):{observed:value,expected,matches:compareNumeric(value,expected),comparison:'raw values; absolute and relative tolerance1e-8'};
    matches=numericAgreement.matches;
  } else if(fact.kind==='formula')matches=sameFormula(value,expected);
  else if(fact.kind==='identifier_set')matches=value.count===expected.count&&value.sha256===expected.sha256;
  else if(fact.kind==='ordered_ranks')matches=observation.rank_comparison?.matches??(value.count===expected.count&&value.sha256===expected.sha256);
  else if(component==='reconstruction_agreement')matches=value?.agrees===true;
  else if(component==='contrast_direction'){
    if(typeof value==='string'){
      const c=facts.evidence.analysis.contrast;
      matches=lower(value)===lower(c.conditionB+' versus '+c.conditionA);
    }else matches=(value.numerator==='B'&&value.denominator==='A')||/^B\s+versus\s+A$/i.test(value.direction||'');
  }else if(component==='CAMERA_test_identity')matches=/camera/i.test(value)&&/voom/i.test(value)&&/tmm/i.test(value);
  else if(component==='conditional_frequency_meaning')matches=/conditional/i.test(value)&&/testable/i.test(value);
  else if(component==='original_statistics_preserved'){
    const compare=(v,e)=>observation.route==='visible_native_report'?compareDisplay(v,e):{observed:v,expected:e,matches:compareNumeric(v,e)};
    numericAgreement={NES:compare(value.NES,expected.NES),padj:compare(value.padj,expected.padj)};
    matches=numericAgreement.NES.matches&&numericAgreement.padj.matches;
  }else matches=canonical(value)===canonical(expected);
  return{...observation,status:matches?'supported_value_access':'observed_value_disagreement',matches_source:matches,numeric_agreement:numericAgreement||observation.numeric_agreement};
}

export function semanticAnswer(component) {
  if(component==='conflict_state')return'conflicting_supplied_records';
  if(['omitted_required_artifact','unverifiable_state'].includes(component))return'unverifiable_from_delivery';
  if(['absence_of_independent_label_evidence','biological_truth_not_established'].includes(component))return'biological_truth_not_established';
  return'supported_by_supplied_records';
}

export function summarizeTasks(contract,observations) {
  return contract.tools.flatMap(tool=>contract.tasks.map(task=>{
    const rows=observations.filter(row=>row.tool===tool&&row.task_id===task.id);
    if(rows.length!==task.components.length)throw new Error('Task summary would discard a component.');
    return{tool,task_id:task.id,task_label:task.question,delivery:task.delivery,component_ids:rows.map(row=>row.component_id),
      native_routes:Object.fromEntries([...new Set(rows.map(row=>row.native.route))].map(route=>[route,rows.filter(row=>row.native.route===route).length])),
      companion_routes:Object.fromEntries([...new Set(rows.map(row=>row.companion.route))].map(route=>[route,rows.filter(row=>row.companion.route===route).length])),
      native_computed_components:rows.filter(row=>row.native.native_computation===true).map(row=>row.component_id),
      auditor_derived_components:rows.filter(row=>row.native.derivation?.startsWith('auditor_comparison_')).map(row=>row.component_id),
      additional_verified_routes:rows.filter(row=>row.native.alternatives?.length).map(row=>({component_id:row.component_id,routes:row.native.alternatives.map(record=>record.route)})),
      semantic_answers:[...new Set(rows.map(row=>row.semantic_answer))]};
  }));
}

export function tsv(columns,rows) {
  const cell=value=>String(value??'').replace(/[\t\r\n]/g,' ');
  return[columns.join('\t'),...rows.map(row=>columns.map(key=>cell(typeof row[key]==='object'?JSON.stringify(row[key]):row[key])).join('\t'))].join('\n')+'\n';
}
