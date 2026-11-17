#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright';
import {AUDIT_TOOLS,freezeContract,sha256,parseTsv,findSourceRow,numericValue} from './matched_task_contract.mjs';
import {openNative,nativeTableRow} from './matched_task_browser.mjs';
import {writeJson} from './matched_task_deliveries.mjs';
import {loadSourceFacts,readOriginalPrecision} from './matched_task_sources.mjs';
import {prepareMatchedDeliveries} from './prepare_matched_deliveries.mjs';
import {preparePnvReports} from './matched_task_pnv.mjs';
import {prepareCompanions,verifyManifest,deliveryFacts} from './matched_task_companion.mjs';
import {observePnvBase,observeGeneTonicBase,observeRnamelBase,observePnvDelivery,observeGeneTonicDelivery,observeExportedDelivery} from './matched_task_native.mjs';
import {readRnamelExport} from './matched_task_export.mjs';
import {verifyObservedValue,semanticAnswer,summarizeTasks,tsv} from './matched_task_results.mjs';
import {pathToFileURL} from 'node:url';
import {writeAuditIndex,writeArtifactManifest} from './matched_task_artifacts.mjs';

const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const contractFile=path.join(ROOT,'paper/evaluation/matched_tasks_2026_11_17.json');
const contract=JSON.parse(fs.readFileSync(contractFile,'utf8'));
const output=path.resolve(ROOT,contract.outputRoot,'matched_tasks');
const relative=file=>path.relative(ROOT,path.resolve(file)).split(path.sep).join('/');
const fileRecord=file=>({path:relative(file),sha256:sha256(fs.readFileSync(file)),sizeBytes:fs.statSync(file).size});
const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));

function prepareAudit() {
  const frozen=freezeContract(contractFile,output);
  if(contract.tasks.length!==10||contract.tasks.flatMap(task=>task.components).length!==37)throw new Error('Unexpected frozen task contract.');
  const shared=path.resolve(ROOT,contract.outputRoot,'shared-evidence'),manifest=read(path.join(shared,'manifest.json'));
  verifyManifest(shared,manifest);
  const files=Object.fromEntries(manifest.files.map(file=>[file.role,path.join(shared,file.path)]));
  const precision=readOriginalPrecision(files.reference_snapshot,contract.pathwayId,path.join(output,'original-numeric-reference.json'));
  const facts=loadSourceFacts(files,contract.pathwayId,ROOT,precision);
  const prepared=prepareMatchedDeliveries(contractFile,output);
  for(const item of prepared.cases){
    if(sha256(fs.readFileSync(item.contextPath))!==item.contextSha256)throw new Error('Frozen case context changed.');
    const context=read(item.contextPath),directory=path.dirname(item.contextPath);
    const request=read(path.join(directory,'handoff.json')),record=read(path.join(directory,'analysis-record.json')).analysisRecord;
    if(JSON.stringify(context.requestedContrast)!==JSON.stringify(request.claims))throw new Error('Requested contrast no longer matches the supplied native context.');
    if(context.actualContrast.conditionA!==record.conditionA||context.actualContrast.conditionB!==record.conditionB)throw new Error('Actual contrast no longer matches the supplied native context.');
  }
  const pnv=preparePnvReports(contract,output);
  const companions=prepareCompanions(shared,output,facts);
  const parityFile=path.resolve(ROOT,contract.outputRoot,'pd-matched.rds.parity.json');
  if(!read(parityFile).checks.every(check=>check.pass===true))throw new Error('Primary array parity has not passed.');
  const fairness={verified:true,contract:{path:relative(contractFile),sha256:frozen.sha256},
    sharedEvidenceManifest:fileRecord(path.join(shared,'manifest.json')),
    deliveries:companions.fairness.map(delivery=>({...delivery,manifest:{...delivery.manifest,path:relative(path.join(output,delivery.manifest.path))}})),
    primaryFixtureReceipt:fileRecord(path.resolve(ROOT,contract.outputRoot,'pd-matched.rds.json')),parityReceipt:fileRecord(parityFile)};
  const companionFiles=Object.fromEntries(manifest.files.map(file=>[file.role,path.join(companions.deliveries.base.directory,file.path)]));
  const companionFacts=loadSourceFacts(companionFiles,contract.pathwayId,ROOT);
  return{frozen,files,facts,companionFacts,prepared,pnv,companions,fairness};
}

function observeCompanion(state,task,component,delivery) {
  if(task.delivery==='base'){
    const fact=state.companionFacts.fields[component],source=fact.sources[0];
    return{route:'shared_companion',mechanism:'source_file',file:source.file,page:relative(path.join(delivery.directory,'index.html')),key:source.key||'data row '+source.row+' / '+source.column,
      observed:fact.expected,screenshot:delivery.screenshot,derivation:component==='reconstruction_agreement'?'audit_deterministic_reconstruction_from_supplied_ranks_and_membership':'direct_source_record',
      rank_comparison:component==='original_rank_universe'?{matches:true,scope:'Delivered source file bytes and original ordered source record are identical.'}:undefined};
  }
  const actual=deliveryFacts(delivery,task.delivery,{NES:state.facts.fields.original_NES.expected,padj:state.facts.fields.original_adjusted_pvalue.expected});
  let file='manifest.json',key='/requiredArtifacts and /deliveredFiles',value=actual.fields[component].expected;
  if(component==='requested_contrast'){file='handoff.json';key='/claims';}
  if(component==='actual_contrast'){file='analysis-record.json';key='/analysisRecord';}
  if(['contrast_agreement','conflict_state'].includes(component)){file='handoff.json';key='/claims compared with analysis-record.json#/analysisRecord';}
  if(component==='original_statistics_preserved'){
    const item=delivery.manifest.deliveredFiles.find(file=>file.role==='pathway_results');
    const row=findSourceRow(parseTsv(fs.readFileSync(path.join(delivery.directory,item.path),'utf8')),'pathway_id',contract.pathwayId);
    file=item.path;key='data row '+row.row+' / NES,padj';value={NES:numericValue(row.values.NES),padj:numericValue(row.values.padj)};
  }
  if(['absence_of_independent_label_evidence','biological_truth_not_established'].includes(component))key='/independentSpecimenLabelRecords';
  return{route:'shared_companion',mechanism:'source_file',file:relative(path.join(delivery.directory,file)),page:relative(path.join(delivery.directory,'index.html')),key,observed:value,
    screenshot:delivery.screenshot,derivation:['requested_contrast','actual_contrast'].includes(component)?'direct_source_record':'audit_comparison_of_supplied_case_records',
    underlying_artifact_state:task.delivery==='missing_required_file'&&['omitted_required_artifact','unverifiable_state'].includes(component)?'missing_from_delivery':undefined};
}

function resolveObservationFiles(record,directory) {
  const result={...record};
  for(const key of ['screenshot','export_receipt','file'])if(result[key])result[key]=relative(path.isAbsolute(result[key])?result[key]:path.join(directory,result[key]));
  if(result.additional_screenshots)result.additional_screenshots=result.additional_screenshots.map(file=>relative(path.join(directory,file)));
  if(result.alternatives)result.alternatives=result.alternatives.map(record=>resolveObservationFiles(record,directory));
  return result;
}

export function nativePaths(contract,delivery='D01') {
  const base=path.resolve(ROOT,contract.outputRoot);
  return {PNV:path.resolve(ROOT,contract.analysisRoot,'reports/gse68719_pd_primary.report.html'),
    GeneTonic:path.join(base,'native-deliveries',delivery,'genetonic-matched/genetonic.matched.html'),
    RNAmel:path.join(base,'native-rnamel-final',delivery,'rnamel-matched/rnamel.matched.html')};
}

export async function auditInventory() {
  const frozen=freezeContract(contractFile,output),directory=path.join(output,process.argv.includes('--inventory-final')?'inventory-final':'inventory');
  fs.mkdirSync(directory,{recursive:true});
  const reports=nativePaths(contract),browser=await chromium.launch({headless:true}),observations=[];
  try {
    for (const tool of AUDIT_TOOLS) {
      const session=await openNative(browser,reports[tool],tool,'D01',directory);
      if (tool==='GeneTonic') {
        const metrics=JSON.parse(fs.readFileSync(path.join(path.dirname(reports[tool]),'metrics.json'),'utf8'));
        const selected=Array.isArray(metrics.selectedPathways)?metrics.selectedPathways:[metrics.selectedPathways];
        const id=selected.find(value=>value.includes(contract.pathwayId));
        if (!id) throw new Error('The fixed pathway was not supplied to the native GeneTonic bookmark input.');
        const row=await nativeTableRow(session.page,id);
        writeJson(path.join(directory,'GeneTonic-target-row.json'),{headers:row.headers,values:row.values});
      }
      observations.push({tool,report:session.report,headings:session.inventory.headings,errors:session.errors,remote:session.remote});
      await session.context.close();
    }
  } finally {await browser.close();}
  writeJson(path.join(directory,'execution.json'),{contract:frozen,command:[process.execPath,...process.argv.slice(1)],
    sourceFiles:['audit_matched_tasks.mjs','matched_task_browser.mjs','matched_task_contract.mjs'].map(name=>({path:'scripts/comparators/'+name,sha256:sha256(fs.readFileSync(path.join(ROOT,'scripts/comparators',name)))})),observations});
  console.log(JSON.stringify({phase:'inventory',tools:observations.map(row=>({tool:row.tool,headings:row.headings.map(h=>h.text),errors:row.errors}))}));
}

export async function auditMatchedTasks() {
  const state=prepareAudit();
  const attempts=path.join(output,'observations');fs.mkdirSync(attempts,{recursive:true});
  const directory=path.join(attempts,'attempt-'+String(fs.readdirSync(attempts).length+1).padStart(3,'0'));fs.mkdirSync(directory);
  const sourceNames=['audit_matched_tasks.mjs','matched_task_browser.mjs','matched_task_contract.mjs','matched_task_sources.mjs','matched_task_deliveries.mjs','matched_task_companion.mjs','matched_task_pnv.mjs','matched_task_native.mjs','matched_task_export.mjs','matched_task_results.mjs','matched_task_artifacts.mjs','prepare_matched_deliveries.mjs','read_matched_rnamel_export.R'];
  const snapshot=path.join(directory,'executed_sources');fs.mkdirSync(snapshot);
  const executedSources=sourceNames.map(name=>{const source=path.join(ROOT,'scripts/comparators',name),destination=path.join(snapshot,name);fs.copyFileSync(source,destination);return{original:relative(source),...fileRecord(destination)};});
  writeJson(path.join(directory,'execution-start.json'),{startedAt:new Date().toISOString(),contract:state.frozen,command:[process.execPath,...process.argv.slice(1)],executedSources});
  const native={},runs=[],browser=await chromium.launch({headless:true});
  try{
    for(const [delivery,id]of[['base','D01'],['consistent','D01'],['contrast_conflict','D02'],['missing_required_file','D03']]){
      native[delivery]={};
      for(const tool of contract.tools){
        const report=tool==='PNV'?state.pnv.reports[delivery==='base'?'consistent':delivery]:nativePaths(contract,id)[tool];
        const session=await openNative(browser,report,tool,delivery,directory);
        let records;
        try{
          if(tool==='PNV')records=delivery==='base'?await observePnvBase(session,state.facts,directory):await observePnvDelivery(session,state.facts,directory);
          else if(tool==='GeneTonic'){
            const metrics=read(path.join(path.dirname(report),'metrics.json'));
            const selected=(Array.isArray(metrics.selectedPathways)?metrics.selectedPathways:[metrics.selectedPathways]).find(value=>value.includes(contract.pathwayId));
            if(!selected)throw new Error('Fixed target was not bookmarked.');
            records=delivery==='base'?(await observeGeneTonicBase(session,state.facts,directory,selected)).observed:await observeGeneTonicDelivery(session,state.facts,directory,selected);
          }else{
            const exported=readRnamelExport(path.dirname(report),contract.pathwayId,directory,session.prefix,state.facts);
            if(delivery==='base'){
              const visible=await observeRnamelBase(session,state.facts,directory);
              records=Object.fromEntries(Object.keys(state.facts.fields).map(component=>[component,
                visible[component].route==='visible_native_report'?{...visible[component],alternatives:[exported.observed[component]]}:{...exported.observed[component],html_inspection:visible[component]}]));
            }else records=observeExportedDelivery(exported);
          }
          if(session.errors.length||session.remote.length)throw new Error('Native report emitted browser errors or remote requests.');
          if(sha256(fs.readFileSync(report))!==session.report.sha256)throw new Error('Native report changed during observation.');
          native[delivery][tool]=Object.fromEntries(Object.entries(records).map(([component,record])=>[component,resolveObservationFiles(record,directory)]));
          const run={tool,delivery,report:{...session.report,path:relative(report)},browser:browser.version(),pageErrors:session.errors,remoteRequests:session.remote};
          if(tool!=='PNV'){
            run.metrics=fileRecord(path.join(path.dirname(report),'metrics.json'));
            run.inputMapping=fileRecord(path.join(path.dirname(report),'native-input-map.json'));
          }
          runs.push(run);
          writeJson(path.join(directory,session.prefix+'-observations.json'),native[delivery][tool]);
          console.log('Observed '+tool+' / '+delivery);
        }finally{await session.context.close();}
      }
    }
    // The companion page is the same physical page for all three assignments.
    for(const [delivery,value]of Object.entries(state.companions.deliveries)){
      const context=await browser.newContext({offline:true,viewport:{width:1440,height:1000}}),page=await context.newPage();
      try{
        await page.goto(pathToFileURL(path.resolve(value.directory,'index.html')).href);
        await page.screenshot({path:path.join(directory,'companion-'+delivery+'.png')});
        value.screenshot=relative(path.join(directory,'companion-'+delivery+'.png'));
      }finally{await context.close();}
    }
  }finally{await browser.close();}
  const originalStats={NES:state.facts.fields.original_NES.expected,padj:state.facts.fields.original_adjusted_pvalue.expected};
  const observations=[];
  for(const tool of contract.tools)for(const task of contract.tasks){
    const delivery=state.companions.deliveries[task.delivery];
    const fields=task.delivery==='base'?state.facts.fields:deliveryFacts(delivery,task.delivery,originalStats).fields;
    for(const component of task.components){
      const fact=fields[component];
      if(!fact)throw new Error('No source-defined component: '+component);
      const rawNative=task.delivery==='coherent_record_only'?{route:'not_assessed',mechanism:'none',reason:'Frozen record-only control for all tools; no native report was probed.',observed:null,native_computation:false}
        :native[task.delivery][tool][component];
      if(!rawNative)throw new Error('Missing actual native observation: '+tool+'/'+component);
      const verified=verifyObservedValue(component,fact,rawNative,state.facts);
      if(verified.alternatives)verified.alternatives=verified.alternatives.map(record=>verifyObservedValue(component,fact,record,state.facts));
      const companion=verifyObservedValue(component,fact,observeCompanion(state,task,component,delivery),state.facts);
      observations.push({tool,task_id:task.id,task_label:task.question,delivery:task.delivery,component_id:component,expected:fact.expected,
        source_bindings:fact.sources.map(source=>({...source,file:path.isAbsolute(source.file)?relative(source.file):source.file})),
        native:verified,companion,semantic_answer:semanticAnswer(component),
        limitation:verified.reason||'Access in the prepared configuration. Supplied annotations and exports are not new statistical calculations or measured human performance.'});
    }
  }
  if(observations.length!==111)throw new Error('Expected111 component observations.');
  const disagreements=observations.filter(row=>row.native.matches_source===false||row.companion.matches_source===false||row.native.alternatives?.some(record=>record.matches_source===false));
  const results={schemaVersion:1,contractSha256:state.frozen.sha256,pathsRelativeTo:'repository root',fairness:state.fairness,
    pathwayId:contract.pathwayId,sourceNumericExtraction:fileRecord(path.join(output,'original-numeric-reference.json')),
    observations,taskSummary:summarizeTasks(contract,observations),nativeRuns:runs,pnvPreparation:state.pnv.commands,
    command:[process.execPath,...process.argv.slice(1)],executedSources,completedAt:new Date().toISOString(),
    definitions:{native_computation:'A tool-produced verification/reconstruction judgment in its local report-preparation/inspection workflow, not an upstream supplied R statistic.',
      derivation:'Auditor comparisons of native visible/exported inputs are recorded separately from tool-produced checks.',
      routeSelection:'An observed route, not a proven unique or minimum required route. Other verified routes are retained in alternatives.',
      precision:'Visible numbers are assessed at rendered precision. Raw numeric-source/export agreement uses1e-8 absolute and relative tolerance.',
      humanOutcomes:'No task time, human effort, interpretation accuracy or diagnostic sensitivity/specificity was measured.'},
    verification:{componentObservations:111,taskSummaries:30,numericOrRecordDisagreements:disagreements.map(row=>({tool:row.tool,task:row.task_id,component:row.component_id})),passed:disagreements.length===0}};
  const uniqueCompanions=new Map(state.fairness.deliveries.flatMap(delivery=>delivery.deliveredFiles.map(file=>[file.sha256,file.sizeBytes])));
  results.storage={uniqueCompanionBytes:[...uniqueCompanions.values()].reduce((sum,bytes)=>sum+bytes,0),
    nativeHtml:runs.map(run=>({tool:run.tool,delivery:run.delivery,path:run.report.path,sizeBytes:fs.statSync(run.report.path).size})),
    interpretation:'Descriptive file sizes; no time, effort or performance inference.'};
  results.provenanceCorrections=['Direct requested/actual contrast lookups carry supplied-input origin without an auditor-comparison tag.'];
  writeJson(path.join(output,'results.json'),results);
  const rows=observations.map(row=>({tool:row.tool,task_id:row.task_id,task_label:row.task_label,delivery:row.delivery,component_id:row.component_id,
    native_route:row.native.route,native_status:row.native.status,native_computation:row.native.native_computation===true,
    value_origin:row.native.value_origin,derivation:row.native.derivation,requires_R:row.native.requires_R===true,
    companion_route:row.companion.route,companion_status:row.companion.status,semantic_answer:row.semantic_answer,
    expected_json:row.expected,native_observed_json:row.native.observed,companion_observed_json:row.companion.observed,
    source_bindings_json:row.source_bindings,native_control:row.native.control,native_screenshot:row.native.screenshot,
    native_alternative_routes:row.native.alternatives||[],companion_file:row.companion.file,companion_key:row.companion.key,limitation:row.limitation}));
  fs.writeFileSync(path.join(output,'observations.tsv'),tsv(Object.keys(rows[0]),rows));
  fs.writeFileSync(path.join(output,'task-summary.tsv'),tsv(Object.keys(results.taskSummary[0]),results.taskSummary));
  writeAuditIndex(output,results);
  writeArtifactManifest(output,results,state,directory);
  console.log(JSON.stringify({observations:observations.length,taskSummaries:results.taskSummary.length,disagreements:results.verification.numericOrRecordDisagreements,output}));
  if(disagreements.length)throw new Error('Actual observed values disagree with their frozen source; inspect results before publication.');
  return results;
}

if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  if(process.argv.includes('--inventory')||process.argv.includes('--inventory-final'))await auditInventory();
  else await auditMatchedTasks();
}
