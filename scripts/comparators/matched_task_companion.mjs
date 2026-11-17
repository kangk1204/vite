import fs from 'node:fs';
import path from 'node:path';
import {describeArtifact,resolveArtifactPath} from '../lib/provenance.mjs';
import {sha256,assertFairEvidence} from './matched_task_contract.mjs';
import {writeJson,writeCompanionPage} from './matched_task_deliveries.mjs';

export function verifyManifest(directory,manifest) {
  const files=manifest.files||manifest.deliveredFiles;
  for(const file of files){
    const actual=describeArtifact(file.role,file.path,{root:directory});
    if(actual.sha256!==file.sha256||actual.sizeBytes!==file.sizeBytes)throw new Error('Shared evidence changed: '+file.path);
  }
  return files;
}

export function completeDeliveryManifest(directory,manifest) {
  const files=[...(manifest.files||manifest.deliveredFiles)];
  for(const [role,file]of[['source_manifest','manifest.json'],['handoff','handoff.json'],['analysis_record','analysis-record.json'],['native_context','native-context.json'],['companion_page','index.html']]){
    if(fs.existsSync(path.join(directory,file))&&!files.some(item=>item.path===file))files.push(describeArtifact(role,file,{root:directory}));
  }
  const result={schemaVersion:1,scope:'Actual source files and supplied declarations delivered identically to all three tools',files};
  writeJson(path.join(directory,'delivery-manifest.json'),result);
  return result;
}

export function prepareCompanions(sharedDirectory,output,facts) {
  const sourceManifest=JSON.parse(fs.readFileSync(path.join(sharedDirectory,'manifest.json'),'utf8'));
  verifyManifest(sharedDirectory,sourceManifest);
  const base=path.join(output,'companions','base');
  fs.mkdirSync(base,{recursive:true});
  for(const file of sourceManifest.files){
    const destination=resolveArtifactPath(file.path,{root:base});
    fs.mkdirSync(path.dirname(destination),{recursive:true});
    if(!fs.existsSync(destination))fs.copyFileSync(resolveArtifactPath(file.path,{root:sharedDirectory}),destination);
  }
  fs.copyFileSync(path.join(sharedDirectory,'manifest.json'),path.join(base,'manifest.json'));
  const e=facts.evidence,d=facts.detail;
  writeCompanionPage(base,{title:'Shared PD source records',manifest:sourceManifest,sections:[
    {id:'primary',title:'Original pathway source row',source:'One-based source data row '+facts.primary.row,value:facts.primary.values},
    {id:'model',title:'Captured analysis metadata',source:'report-evidence.json / evidence.analysis',value:e.analysis},
    {id:'membership',title:'Original tested membership',source:'report-evidence.json / evidence.pathways.R-HSA-449147',value:{testedSize:d.testedSize,testedGenes:d.testedGenes,originalEs:d.originalEs}},
    {id:'ranks',title:'Ordered original rank universe',source:'Complete ordered values are supplied in ranked-genes.tsv.',value:{rankedGenesFile:sourceManifest.files.find(f=>f.role==='ranked_genes').path}},
    {id:'group-only',title:'Group-only source row',source:'One-based source data row '+facts.groupOnly.row,value:facts.groupOnly.values},
    {id:'camera',title:'CAMERA source row',source:'One-based source data row '+facts.camera.row,value:facts.camera.values},
    {id:'bootstrap',title:'Captured resampling records',source:'report-evidence.json / evidence.pathways.R-HSA-449147.bootstrap',value:d.bootstrap},
  ]});
  const deliveries={base:{directory:base,manifest:sourceManifest}};
  for(const [id,kind]of[['D01','consistent'],['D02','contrast_conflict'],['D03','missing_required_file'],['D04','coherent_record_only']]){
    const directory=path.join(output,'deliveries',id),manifest=JSON.parse(fs.readFileSync(path.join(directory,'manifest.json')));
    const request=JSON.parse(fs.readFileSync(path.join(directory,'handoff.json'))),record=JSON.parse(fs.readFileSync(path.join(directory,'analysis-record.json')));
    verifyManifest(directory,manifest);
    const sections=[
      {id:'request',title:'Requested handoff',source:'handoff.json',value:request},
      {id:'analysis',title:'Supplied analysis record',source:'analysis-record.json',value:record},
      {id:'inventory',title:'Required and delivered file inventory',source:'manifest.json',value:manifest},
    ];
    if(kind==='coherent_record_only')sections.push({id:'labels',title:'Supplied symbolic label table',source:'symbolic-labels.tsv',value:fs.readFileSync(path.join(directory,'symbolic-labels.tsv'),'utf8')});
    else sections.push({id:'primary',title:'Original pathway source row',source:'files/pathway_results.tsv / data row '+facts.primary.row,value:facts.primary.values});
    writeCompanionPage(directory,{title:'Shared delivery records '+id,manifest,sections});
    deliveries[kind]={directory,manifest,request,record:record.analysisRecord};
  }
  const fairness=Object.entries(deliveries).map(([id,delivery])=>{
    const complete=completeDeliveryManifest(delivery.directory,delivery.manifest);
    const files=verifyManifest(delivery.directory,complete);
    assertFairEvidence({PNV:files,GeneTonic:files,RNAmel:files});
    const file=path.join(delivery.directory,'delivery-manifest.json'),digest=sha256(fs.readFileSync(file));
    return{id,manifest:{path:path.relative(output,file),sha256:digest},receivedByTool:{PNV:digest,GeneTonic:digest,RNAmel:digest},equalBytes:true,deliveredFiles:files};
  });
  writeJson(path.join(output,'companion-allocation.json'),{deliveries:fairness,scope:'One identical companion directory and manifest is assigned to every tool per delivery.'});
  return{deliveries,fairness};
}

export function deliveryFacts(delivery,kind,originalStats) {
  const {directory,manifest,request,record}=delivery;
  const source=(file,key)=>({file:path.join(directory,file),sha256:sha256(fs.readFileSync(path.join(directory,file))),key});
  const files=manifest.requiredArtifacts.map(file=>{
    const target=resolveArtifactPath(file.path,{root:directory}),present=fs.existsSync(target);
    if(present!==manifest.deliveredFiles.some(item=>item.path===file.path))throw new Error('Manifest and physical case directory disagree.');
    const actual=present?describeArtifact(file.role,file.path,{root:directory}):null;
    return{role:file.role,path:file.path,declaredSha256:file.sha256,declaredSize:file.sizeBytes,suppliedSha256:actual?.sha256??null,suppliedSize:actual?.sizeBytes??null};
  });
  const requested={conditionA:request.claims.conditionA,conditionB:request.claims.conditionB},actual={conditionA:record.conditionA,conditionB:record.conditionB};
  const missing=files.filter(file=>file.suppliedSha256===null),hashesAgree=files.every(file=>file.declaredSha256===file.suppliedSha256&&file.declaredSize===file.suppliedSize);
  const contrastAgrees=JSON.stringify(requested)===JSON.stringify(actual);
  if(kind==='missing_required_file'&&(missing.length!==1||missing[0].role!=='raw_counts'))throw new Error('The missing-file transformation was not preserved.');
  if(kind==='contrast_conflict'&&contrastAgrees)throw new Error('The contrast-conflict transformation was not preserved.');
  const bindings=[source('manifest.json','requiredArtifacts/deliveredFiles'),source('handoff.json','claims'),source('analysis-record.json','analysisRecord')];
  const fact=value=>({expected:value,kind:'record',sources:bindings});
  return{raw:{files,requested,actual},fields:{
    file_agreement:fact({allDeclaredFilesPresent:missing.length===0,allHashesAgree:hashesAgree}),
    contrast_agreement:fact({agrees:contrastAgrees,requested,actual}),
    verification_scope:fact('supplied_file_byte_identity_and_recorded_fields'),
    requested_contrast:fact(requested),actual_contrast:fact(actual),
    conflict_state:fact({conflict:!contrastAgrees,requested,actual}),
    original_statistics_preserved:fact(originalStats),
    omitted_required_artifact:fact(missing.map(({role,path})=>({role,path}))),
    unverifiable_state:fact({unverifiable:missing.length>0,reason:'required_artifact_not_delivered'}),
    internal_consistency:fact({labelsAgree:contrastAgrees,allHashesAgree:hashesAgree}),
    absence_of_independent_label_evidence:fact({suppliedRecords:manifest.independentSpecimenLabelRecords||[]}),
    biological_truth_not_established:fact('indeterminate_from_supplied_records'),
  }};
}
