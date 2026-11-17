#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import{createHash}from'node:crypto';import{fileURLToPath}from'node:url';
import{readTsvFile}from'../lib/paper_pipeline.mjs';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const hash=data=>createHash('sha256').update(data).digest('hex');
const inside=(base,file)=>{const rel=path.relative(base,file);return rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel)};
export function copyBoundArtifact(root,output,item){
 const destination=path.resolve(output,item.path);
 if(path.isAbsolute(item.path)||!inside(path.resolve(output),destination))throw Error('Companion output path escapes its root.');
 const source=path.resolve(root,item.source);
 if(!inside(fs.realpathSync(root),fs.realpathSync(source))||fs.lstatSync(source).isSymbolicLink())throw Error('Companion source path escapes its root.');
 const data=fs.readFileSync(source);if(hash(data)!==item.sha256)throw Error('Original artifact digest differs: '+item.source);
 fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,data,{flag:'wx'});
 return {role:item.role,path:item.path,sha256:hash(data),sizeBytes:data.length,sourcePath:item.source};
}
export function targetRow(rows,id){
 const matches=rows.flatMap((row,i)=>String(row.pathway_id||row.pathway||'').split(' :: ')[0]===id?[i+1]:[]);
 if(matches.length!==1)throw Error('Expected exactly one target source row: '+id);return matches[0];
}
function writeData(output,role,name,value){
 const data=Buffer.from(JSON.stringify(value,null,2)+'\n');fs.writeFileSync(path.join(output,name),data,{flag:'wx'});
 return {role,path:name,sha256:hash(data),sizeBytes:data.length};
}
export function buildPdCompanion(fixtureArg,outputArg){
 const fixture=path.resolve(fixtureArg),output=path.resolve(outputArg),receipt=JSON.parse(fs.readFileSync(fixture+'.json'));
 if(hash(fs.readFileSync(fixture))!==receipt.fixtureSha256)throw Error('Matched fixture digest differs.');
 if(fs.existsSync(output)&&fs.readdirSync(output).length)throw Error('Choose a new companion directory.');fs.mkdirSync(output,{recursive:true});
 const sourceNames=Object.keys(receipt.sourceHashes),evidenceName=sourceNames.find(n=>n.endsWith('_report_evidence.json'));
 const snapshotName=sourceNames.find(n=>n.endsWith('_reference_input.rds'));
 const evidenceFile=path.resolve(ROOT,evidenceName),e=JSON.parse(fs.readFileSync(evidenceFile)).evidence;
 const entries=[];
 const copy=(role,source,name,sha)=>entries.push(copyBoundArtifact(ROOT,output,{role,source,path:name,sha256:sha||hash(fs.readFileSync(path.resolve(ROOT,source)))}));
 copy('report_evidence',evidenceName,'report-evidence.json',receipt.sourceHashes[evidenceName]);
 copy('reference_snapshot',snapshotName,'reference-input.rds',receipt.sourceHashes[snapshotName]);
 const resolved=a=>a.path.startsWith('project:')?a.path.slice(8):path.relative(ROOT,path.resolve(path.dirname(evidenceFile),a.path));
 for(const a of e.executionCapture.artifacts)copy(a.role,resolved(a),'inputs/'+resolved(a),a.sha256);
 const roles={gene_results:['genes','genes.tsv'],pathway_results:['primary_pathways','pathways.tsv'],included_sample_metadata:['metadata','metadata.tsv'],camera:['camera','camera.tsv']};
 for(const[original,[role,name]]of Object.entries(roles)){
  const a=e.artifacts.find(a=>a.role===original);if(!a)throw Error('Missing original artifact role '+original);copy(role,resolved(a),name,a.sha256);
 }
 const group=e.artifacts.find(a=>a.role==='design_sensitivity'&&a.path.endsWith('_fgsea_reactome.tsv'));
 if(!group)throw Error('Missing original group-only table.');copy('group_only_pathways',resolved(group),'group-only-pathways.tsv',group.sha256);
 for(const a of e.artifacts.filter(a=>a.role==='design_sensitivity'&&a.path.endsWith('_evidence.json')))copy('group_only_evidence',resolved(a),'group-only-evidence.json',a.sha256);
 const annotations=fixture+'.native-annotations.tsv';copy('native_input_fields',path.relative(ROOT,annotations),'native-input-fields.tsv');
 copy('fixture_parity',path.relative(ROOT,fixture+'.parity.json'),'reconstruction-parity.json');
 const ranks=e.rankedGenes;if(!Array.isArray(ranks)||!ranks.length)throw Error('Exact retained rank universe is missing.');
 const ranked='rank\tgene\tstat\n'+ranks.map((r,i)=>`${i+1}\t${r.gene}\t${r.metric}`).join('\n')+'\n';
 fs.writeFileSync(path.join(output,'ranked-genes.tsv'),ranked,{flag:'wx'});entries.push({role:'ranked_genes',path:'ranked-genes.tsv',sha256:hash(ranked),sizeBytes:Buffer.byteLength(ranked),sourceKey:'evidence.rankedGenes'});
 const rows=readTsvFile(annotations),byId=new Map(rows.map(r=>[r.supplied_pathway_identifier,r]));
 const membership=Object.fromEntries(Object.entries(e.pathways).map(([id,v])=>{const r=byId.get(id);if(!r||!Array.isArray(v.testedGenes)||v.testedGenes.length!==v.testedSize)throw Error('Missing exact tested membership.');return[id,{testedGenes:v.testedGenes,testedSize:v.testedSize,originalEs:v.originalEs,reconstructedEs:Number(r.supplied_reconstructed_ES),absoluteDifference:Number(r.supplied_ES_absolute_difference),tolerance:1e-8}]}));
 entries.push(writeData(output,'tested_membership','tested-membership.json',membership));
 entries.push(writeData(output,'bootstrap','bootstrap.json',Object.fromEntries(Object.entries(e.pathways).map(([id,v])=>[id,v.bootstrap]))));
 entries.push(writeData(output,'model','model.json',{analysis:e.analysis,excludedSamples:e.excludedSamples,bootstrap:e.bootstrap,runId:e.runId}));
 entries.push(writeData(output,'artifact_records','artifact-records.json',{runId:e.runId,artifacts:e.artifacts,executionCapture:e.executionCapture}));
 const id=receipt.target.pathwayId;
 const manifest={schemaVersion:1,scope:'original_common_evidence_not_task_answer_key',sharedAcross:['PNV','GeneTonic 3.4.0','RNAmel 0.18.1'],
  runId:e.runId,target:{pathwayId:id,pathway:receipt.target.pathway,rows:{primary_pathways:targetRow(readTsvFile(path.join(output,'pathways.tsv')),id),camera:targetRow(readTsvFile(path.join(output,'camera.tsv')),id),group_only_pathways:targetRow(readTsvFile(path.join(output,'group-only-pathways.tsv')),id)},keys:{tested_membership:id,bootstrap:id,report_evidence:'evidence.pathways.'+id},rowNumbers:'one-based data rows excluding header'},
  fixtureSha256:receipt.fixtureSha256,originalSnapshotSha256:receipt.sourceHashes[snapshotName],files:entries};
 const bytes=Buffer.from(JSON.stringify(manifest,null,2)+'\n');fs.writeFileSync(path.join(output,'manifest.json'),bytes,{flag:'wx'});
 console.log(JSON.stringify({manifest:path.relative(ROOT,path.join(output,'manifest.json')),sha256:hash(bytes),files:entries.length}));return manifest;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url))buildPdCompanion(process.argv[2],process.argv[3]);
