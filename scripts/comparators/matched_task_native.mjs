import fs from 'node:fs';
import path from 'node:path';
import {arrayIdentity} from './matched_task_sources.mjs';
import {numericValue,compareDisplay,compareRanks,sameFormula} from './matched_task_contract.mjs';
import {compact,visibleObservation,unavailable,nativeTableRow,observeTableField,downloadPnvEvidence,pnvSourceRow} from './matched_task_browser.mjs';

const NUMBER='([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?|NA)';
const UPSTREAM='Frozen upstream R result supplied to the report';
const ANNOTATION='Frozen upstream value supplied through a documented native annotation input';
const PNV_CHECK='PNV local report-preparation/inspection workflow before HTML opening';
const derived='auditor_comparison_of_visible_inputs';
const withValue=(record,value,extra={})=>({...record,observed:value,...extra});

function capture(text,pattern,label) {
  const result=pattern.exec(text);
  if(!result)throw new Error('Expected visible label was absent: '+label);
  return result;
}

export async function observePnvBase(session,facts,output) {
  const page=session.page,target=facts.fields.pathway_identifier.expected;
  await page.locator('#pathway-search').fill(facts.primary.values.pathway_name);
  await page.locator('[data-pathway-key]').filter({hasText:facts.primary.values.pathway_name}).first().click();
  const summary=await visibleObservation(session,'#current-pathway-summary','primary-summary',output);
  const result=capture(summary.displayText,new RegExp('NES '+NUMBER+' · FDR '+NUMBER,'i'),'NES/FDR');
  const observed={
    original_NES:withValue(summary,result[1],{numeric_agreement:compareDisplay(result[1],facts.fields.original_NES.expected)}),
    original_adjusted_pvalue:withValue(summary,result[2],{numeric_agreement:compareDisplay(result[2],facts.fields.original_adjusted_pvalue.expected)}),
  };
  const exportData=await downloadPnvEvidence(session,output),record=exportData.value;
  const exportField=(value,key)=>withValue(exportData.record,value,{key});
  const detail=record.pathways[target];
  observed.group_label_mapping=exportField({A:record.analysis.contrast.conditionA,B:record.analysis.contrast.conditionB},'analysis.contrast');
  const header=await visibleObservation(session,'.header-condition-line','contrast',output);
  observed.contrast_direction=withValue(header,header.displayText);
  const evidenceHeader=await visibleObservation(session,'#evidence-summary','method',output);
  const design=capture(evidenceHeader.displayText,/Design:\s*(.*?)\s*· Rank:/,'Design');
  observed.actual_design=withValue(evidenceHeader,design[1]);
  observed.tested_gene_count=exportField(detail.testedSize,'pathways.'+target+'.testedSize');
  observed.exact_tested_gene_identifiers=exportField(arrayIdentity(detail.testedGenes,false),'pathways.'+target+'.testedGenes');
  observed.original_rank_universe={...exportField(arrayIdentity(record.rankedGenes),'rankedGenes'),rank_comparison:compareRanks(record.rankedGenes,facts.evidence.rankedGenes)};
  observed.CAMERA_test_identity=exportField(record.analysis.camera,'analysis.camera');
  const source=await pnvSourceRow(session,page.locator('#pathway-evidence [data-source-table]').first(),output,'original-row');
  observed.pathway_identifier=withValue(source.record,source.values.pathway_id);
  observed.original_ES=withValue(source.record,source.values.ES,{numeric_agreement:compareDisplay(source.values.ES,facts.fields.original_ES.expected)});
  observed.tested_gene_count=withValue(source.record,source.values.size);
  const caption=await visibleObservation(session,'#plot-caption','ES-agreement',output,{origin:PNV_CHECK,computed:true});
  observed.reconstruction_agreement=withValue(caption,{agrees:/ES matches recorded/i.test(caption.displayText)},{native_computation_scope:PNV_CHECK});
  const panel=await visibleObservation(session,'#pathway-evidence','sensitivity',output);
  const group=capture(panel.displayText,new RegExp('Design sensitivity:\\s*(.*?)\\s*· NES '+NUMBER+' · FDR '+NUMBER,'i'),'group-only sensitivity');
  observed.group_only_design=withValue(panel,group[1]);
  observed.group_only_NES=withValue(panel,group[2],{numeric_agreement:compareDisplay(group[2],facts.fields.group_only_NES.expected)});
  observed.group_only_adjusted_pvalue=withValue(panel,group[3],{numeric_agreement:compareDisplay(group[3],facts.fields.group_only_adjusted_pvalue.expected)});
  const groupButton=await visibleObservation(session,page.getByRole('button',{name:/^Design source row /}),'group-only-row',output);
  observed.group_only_source_row=withValue(groupButton,Number(capture(groupButton.displayText,/row (\d+)/,'group-only source row')[1]));
  const camera=capture(panel.displayText,new RegExp('CAMERA sensitivity: direction (.*?) · FDR '+NUMBER,'i'),'CAMERA');
  observed.CAMERA_direction=withValue(panel,camera[1]);
  observed.CAMERA_adjusted_pvalue=withValue(panel,camera[2],{numeric_agreement:compareDisplay(camera[2],facts.fields.CAMERA_adjusted_pvalue.expected)});
  const cameraButton=await visibleObservation(session,page.getByRole('button',{name:/^CAMERA source row /}),'CAMERA-row',output);
  observed.CAMERA_source_row=withValue(cameraButton,Number(capture(cameraButton.displayText,/row (\d+)/,'CAMERA source row')[1]));
  const selected=capture(panel.displayText,/Sample resampling selection (\d+)\/(\d+)/,'selection denominator');
  const valid=capture(panel.displayText,/Testable (\d+)\/(\d+) repetitions/,'testable denominator');
  const direction=capture(panel.displayText,/Direction retained (\d+)\/(\d+)/,'direction count');
  observed.selected_count=withValue(panel,Number(selected[1]));
  observed.testable_count=withValue(panel,Number(valid[1]));
  observed.requested_repetitions=withValue(panel,Number(valid[2]));
  observed.direction_agreement_count=withValue(panel,Number(direction[1]));
  observed.conditional_frequency_meaning=withValue(panel,capture(panel.displayText,/(Frequencies are conditional on testable repetitions\.)/,'conditional frequency')[1]);
  if(/CAMERA/.test(panel.displayText)&&/TMM/.test(panel.displayText)&&/voom/.test(panel.displayText))observed.CAMERA_test_identity=withValue(panel,panel.displayText);
  const primaryTable=record.sourceTables.pathways;
  const primaryValues=Object.fromEntries(primaryTable.columns.map((key,index)=>[key,primaryTable.rows[detail.source.row-1][index]]));
  const designRecord=detail.designSensitivity[0];
  const extra={
    pathway_identifier:exportField(primaryValues.pathway_id,'sourceTables.pathways[source row].pathway_id'),
    original_NES:exportField(primaryValues.NES,'sourceTables.pathways[source row].NES'),
    original_adjusted_pvalue:exportField(primaryValues.padj,'sourceTables.pathways[source row].padj'),
    actual_design:exportField(record.analysis.designFormula,'analysis.designFormula'),
    tested_gene_count:exportField(detail.testedSize,'pathways.'+target+'.testedSize'),
    original_ES:exportField(primaryValues.ES,'sourceTables.pathways[source row].ES'),
    group_only_design:exportField(designRecord.designFormula,'pathways.'+target+'.designSensitivity[0].designFormula'),
    group_only_NES:exportField(designRecord.nes,'pathways.'+target+'.designSensitivity[0].nes'),
    group_only_adjusted_pvalue:exportField(designRecord.padj,'pathways.'+target+'.designSensitivity[0].padj'),
    group_only_source_row:exportField(designRecord.source.row,'pathways.'+target+'.designSensitivity[0].source.row'),
    CAMERA_direction:exportField(detail.camera.direction,'pathways.'+target+'.camera.direction'),
    CAMERA_adjusted_pvalue:exportField(detail.camera.padj,'pathways.'+target+'.camera.padj'),
    CAMERA_test_identity:exportField(record.analysis.camera,'analysis.camera'),
    selected_count:exportField(detail.bootstrap.selected,'pathways.'+target+'.bootstrap.selected'),
    testable_count:exportField(detail.bootstrap.valid,'pathways.'+target+'.bootstrap.valid'),
    requested_repetitions:exportField(detail.bootstrap.requested,'pathways.'+target+'.bootstrap.requested'),
    direction_agreement_count:exportField(detail.bootstrap.directionMatches,'pathways.'+target+'.bootstrap.directionMatches'),
    conditional_frequency_meaning:exportField(detail.bootstrap.interpretation,'pathways.'+target+'.bootstrap.interpretation'),
  };
  for(const [component,alternative]of Object.entries(extra))if(observed[component]?.route!==alternative.route)observed[component].alternatives=[alternative];
  return observed;
}

const GT_FIELDS={
  pathway_identifier:'supplied_pathway_identifier',original_NES:'gs_NES',original_adjusted_pvalue:'gs_adj_pvalue',
  actual_design:'supplied_design',tested_gene_count:'supplied_tested_gene_count',exact_tested_gene_identifiers:'supplied_tested_genes',
  original_ES:'supplied_original_ES',group_only_design:'supplied_group_only_design',group_only_NES:'supplied_group_only_NES',
  group_only_adjusted_pvalue:'supplied_group_only_FDR',group_only_source_row:'supplied_group_only_source_row',
  CAMERA_direction:'supplied_CAMERA_direction',CAMERA_adjusted_pvalue:'supplied_CAMERA_FDR',CAMERA_test_identity:'supplied_CAMERA_test',CAMERA_source_row:'supplied_CAMERA_source_row',
  selected_count:'supplied_bootstrap_selected',testable_count:'supplied_bootstrap_testable',requested_repetitions:'supplied_bootstrap_requested',
  direction_agreement_count:'supplied_bootstrap_direction_agreement',conditional_frequency_meaning:'supplied_bootstrap_meaning',
};

export async function observeGeneTonicBase(session,facts,output,selectedId) {
  const table=await nativeTableRow(session.page,selectedId),observed={};
  if(!table)throw new Error('Native GeneTonic enrichment table is unavailable.');
  for(const [component,column] of Object.entries(GT_FIELDS)){
    let record=await observeTableField(session,table,column,component,output,{origin:column.startsWith('supplied_')?ANNOTATION:UPSTREAM});
    if(record.route==='visible_native_report'){
      if(component==='exact_tested_gene_identifiers')record=withValue(record,arrayIdentity(record.displayText.split(';').filter(Boolean),false));
      if(facts.fields[component].kind==='number')record={...record,numeric_agreement:compareDisplay(record.displayText,facts.fields[component].expected)};
    }
    observed[component]=record;
  }
  const mapping=await observeTableField(session,table,'supplied_group_A','group-labels',output,{origin:ANNOTATION});
  observed.group_label_mapping=withValue(mapping,{A:table.values.supplied_group_A,B:table.values.supplied_group_B});
  const contrast=await observeTableField(session,table,'supplied_positive_contrast','positive-contrast',output,{origin:ANNOTATION});
  observed.contrast_direction=withValue(contrast,{direction:table.values.supplied_positive_contrast,conditionA:table.values.supplied_group_A,conditionB:table.values.supplied_group_B});
  observed.original_rank_universe=unavailable(session,'original_rank_universe','The supplied native cell exposes rank-universe size and companion filename, not the complete ordered rank values.',
    {size:table.values.supplied_rank_universe_size,file:table.values.supplied_rank_universe_file});
  const agreement=await observeTableField(session,table,'supplied_ES_absolute_difference','ES-agreement',output,{origin:ANNOTATION,derivation:derived});
  observed.reconstruction_agreement=withValue(agreement,{agrees:numericValue(table.values.supplied_ES_absolute_difference)<=numericValue(table.values.supplied_ES_tolerance),
    absoluteDifference:numericValue(table.values.supplied_ES_absolute_difference),tolerance:numericValue(table.values.supplied_ES_tolerance),
    method:table.values.supplied_ES_reconstruction_method},{derivation:derived});
  return {observed,table};
}

export async function observeRnamelBase(session,facts,output) {
  const pre=session.page.locator('pre').first();
  const code=await visibleObservation(session,pre,'native-generated-script',output,{origin:'Native generated recipe from saved RNAmel settings'});
  const observed={};
  for(const component of Object.keys(facts.fields)){
    observed[component]=unavailable(session,component,'The stock prepared RNAmel HTML sections do not expose this original pathway component. Shared source records are supplied.',
      {headings:session.inventory.headings.map(h=>h.text)});
  }
  // Claim only the actual fitted formula when the visible native recipe contains it.
  const formula=/design\s*=\s*(~[^,]+)/.exec(code.displayText)?.[1]?.trim();
  if(formula&&sameFormula(formula,facts.fields.actual_design.expected))observed.actual_design=withValue(code,formula);
  else observed.actual_design={...observed.actual_design,partial_inputs:{visibleGeneratedRecipe:code.displayText,scope:'This generated recipe does not identify the frozen fitted formula.'}};
  const contrast=/contrast\s*=\s*c\(\s*["']group["']\s*,\s*["']([AB])["']\s*,\s*["']([AB])["']\s*\)/.exec(code.displayText);
  if(contrast)observed.contrast_direction=withValue(code,{numerator:contrast[1],denominator:contrast[2]});
  return observed;
}

function deriveContext(context,statistics) {
  const {requestedContrast:requested,actualContrast:actual,declaredFiles,deliveredFiles}=context;
  const missing=declaredFiles.filter(file=>!deliveredFiles.some(candidate=>candidate.path===file.path));
  const same=declaredFiles.every(file=>deliveredFiles.some(candidate=>candidate.path===file.path&&candidate.sha256===file.sha256&&Number(candidate.sizeBytes)===Number(file.sizeBytes)));
  const agrees=requested.conditionA===actual.conditionA&&requested.conditionB===actual.conditionB;
  return {
    file_agreement:{allDeclaredFilesPresent:missing.length===0,allHashesAgree:same},
    contrast_agreement:{agrees,requested,actual},verification_scope:'supplied_file_byte_identity_and_recorded_fields',
    requested_contrast:requested,actual_contrast:actual,conflict_state:{conflict:!agrees,requested,actual},
    original_statistics_preserved:statistics,
    omitted_required_artifact:missing.map(({role,path})=>({role,path})),
    unverifiable_state:{unverifiable:missing.length>0,reason:'required_artifact_not_delivered'},
  };
}

export async function observeGeneTonicDelivery(session,facts,output,selectedId) {
  const table=await nativeTableRow(session.page,selectedId);
  const requests=await observeTableField(session,table,'supplied_requested_group_A','requested-fields',output,{origin:ANNOTATION,derivation:derived});
  const inventory=await observeTableField(session,table,'supplied_delivered_files','file-inventory',output,{origin:ANNOTATION,derivation:derived});
  const declared=await observeTableField(session,table,'supplied_declared_files','declared-files',output,{origin:ANNOTATION,derivation:derived});
  const stats=await observeTableField(session,table,'gs_NES','case-original-statistics',output,{origin:UPSTREAM,derivation:derived});
  const context={requestedContrast:{conditionA:table.values.supplied_requested_group_A,conditionB:table.values.supplied_requested_group_B},
    actualContrast:{conditionA:table.values.supplied_group_A,conditionB:table.values.supplied_group_B},
    declaredFiles:JSON.parse(table.values.supplied_declared_files),deliveredFiles:JSON.parse(table.values.supplied_delivered_files)};
  const values=deriveContext(context,{NES:table.values.gs_NES,padj:table.values.gs_adj_pvalue});
  return Object.fromEntries(Object.entries(values).map(([component,value])=>{
    const record=component==='original_statistics_preserved'?stats:['requested_contrast','actual_contrast','contrast_agreement','conflict_state'].includes(component)?requests:inventory;
    return [component,withValue(record,value,{derivation:['requested_contrast','actual_contrast'].includes(component)?undefined:derived,raw_inputs:context,additional_screenshots:[declared.screenshot],native_computation:false})];
  }));
}

export function observeExportedDelivery(exported) {
  const context=exported.data.caseContext,p=exported.data.pathway;
  const values=deriveContext(context,{NES:p.NES,padj:p.padj});
  return Object.fromEntries(Object.entries(values).map(([component,value])=>[component,{...exported.base,observed:value,key:'enrichment.supplied_case_context',
    raw_inputs:context,derivation:['requested_contrast','actual_contrast'].includes(component)?undefined:'auditor_comparison_of_exported_inputs',native_computation:false}]));
}

export function pnvComputedValues(record,values) {
  const artifacts=record.result.checks.filter(check=>check.id.startsWith('artifact:'));
  const contrasts=record.result.checks.filter(check=>['claim:conditionA','claim:conditionB'].includes(check.id));
  return {...values,
    file_agreement:{allDeclaredFilesPresent:artifacts.every(check=>check.status!=='unknown'),allHashesAgree:artifacts.length>0&&artifacts.every(check=>check.status==='pass')},
    contrast_agreement:{...values.contrast_agreement,agrees:contrasts.length===2&&contrasts.every(check=>check.status==='pass')},
    conflict_state:{...values.conflict_state,conflict:contrasts.some(check=>check.status==='fail')},
    omitted_required_artifact:artifacts.filter(check=>check.status==='unknown').map(check=>{
      const file=record.result.files[Number(check.id.split(':')[1])];return{role:file.role,path:file.path};
    }),
    unverifiable_state:{...values.unverifiable_state,unverifiable:record.result.predicted==='unverifiable'},
  };
}

export async function observePnvDelivery(session,facts,output) {
  const page=session.page;
  await page.locator('#pathway-search').fill(facts.primary.values.pathway_name);
  await page.locator('[data-pathway-key]').filter({hasText:facts.primary.values.pathway_name}).first().click();
  const diagnostics=await visibleObservation(session,'#delivery-diagnostics','delivery-checks',output,{origin:PNV_CHECK,computed:true});
  const raw=page.locator('#delivery-observations');
  if(await raw.getAttribute('open')===null)await raw.locator(':scope > summary').click();
  const details=raw.locator('details');
  if(await details.getAttribute('open')===null)await details.locator('summary').click();
  const exported=JSON.parse(await details.locator('pre').innerText());
  const nativeRecord=await visibleObservation(session,details.locator('pre'),'visible-delivery-record',output,{origin:PNV_CHECK,computed:true});
  const context={requestedContrast:{conditionA:exported.request.claims.conditionA,conditionB:exported.request.claims.conditionB},
    actualContrast:{conditionA:exported.analysisRecord.conditionA,conditionB:exported.analysisRecord.conditionB},
    declaredFiles:exported.result.files.map(file=>({role:file.role,path:file.path,sha256:file.recordedSha256,sizeBytes:file.recordedSize})),
    deliveredFiles:exported.result.files.filter(file=>file.suppliedSha256!==null).map(file=>({role:file.role,path:file.path,sha256:file.suppliedSha256,sizeBytes:file.suppliedSize}))};
  const summary=await visibleObservation(session,'#current-pathway-summary','case-original-statistics',output,{origin:UPSTREAM,derivation:derived});
  const match=capture(summary.displayText,new RegExp('NES '+NUMBER+' · FDR '+NUMBER,'i'),'case NES/FDR');
  const values=pnvComputedValues(exported,deriveContext(context,{NES:match[1],padj:match[2]}));
  if(exported.scope!=='supplied-files-and-recorded-fields')throw new Error('Unexpected visible PNV verification scope.');
  const explicit=new Set(['file_agreement','contrast_agreement','conflict_state','omitted_required_artifact','unverifiable_state']);
  return Object.fromEntries(Object.entries(values).map(([component,value])=>{
    const record=component==='original_statistics_preserved'?summary:explicit.has(component)?diagnostics:nativeRecord;
    return [component,withValue(record,value,{raw_inputs:context,native_computation:explicit.has(component),
      native_computation_scope:explicit.has(component)?PNV_CHECK:undefined,
      check_recorded_at:exported.checkedAt,tool_check_records:explicit.has(component)?exported.result.checks:undefined,
      derivation:component==='original_statistics_preserved'?derived:undefined})];
  }));
}
