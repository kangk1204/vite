import fs from 'node:fs';
import path from 'node:path';
import {describeArtifact,resolveArtifactPath} from '../lib/provenance.mjs';
import {analysisRecordFromViewer,inspectDeliveryFiles} from '../lib/delivery_inspection.mjs';
import {sha256} from './matched_task_contract.mjs';

const escape=value=>String(value??'Not supplied').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export const writeJson=(file,value)=>fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n');

export function prepareDeliveryFiles({directory,files,analysisRecord,kind,target,contractSha256,deliveryId='D01'}) {
  if (!['base','consistent','contrast_conflict','missing_required_file'].includes(kind)) throw new Error('Unknown delivery kind.');
  for (const role of Object.keys(files)) if (!/^[a-z][a-z0-9_-]*$/i.test(role)) throw new Error('Source role must be a simple identifier.');
  fs.mkdirSync(path.join(directory,'files'),{recursive:true});
  const required=[];
  for (const [key,input] of Object.entries(files)) {
    const source=typeof input==='string'?input:input.path;
    const role=typeof input==='string'?key:input.role;
    if (!/^[a-z][a-z0-9_-]*$/i.test(role)) throw new Error('Source role must be a simple identifier.');
    const name=key+path.extname(source);
    const descriptor=describeArtifact(role,path.basename(source),{root:path.dirname(source)});
    const file='files/'+name;
    required.push({...descriptor,path:file});
    if (kind==='missing_required_file'&&role==='raw_counts') continue;
    fs.copyFileSync(source,path.join(directory,file));
  }
  if (!required.some(file=>file.role==='raw_counts')) throw new Error('The frozen missing-file task requires the declared raw-count input.');
  const contrast={conditionA:analysisRecord.conditionA,conditionB:analysisRecord.conditionB};
  const claims=kind==='contrast_conflict'?{conditionA:contrast.conditionB,conditionB:contrast.conditionA}:contrast;
  const request={schemaVersion:1,targetPathwayId:target,claims,artifacts:required,additionalRecords:[]};
  writeJson(path.join(directory,'handoff.json'),request);
  writeJson(path.join(directory,'analysis-record.json'),{schemaVersion:1,analysisRecord});
  const delivered=required.filter(file=>fs.existsSync(path.join(directory,file.path)));
  const manifest={schemaVersion:1,deliveryId,contractSha256,requiredArtifacts:required,deliveredFiles:delivered,
    absentFiles:required.filter(file=>!fs.existsSync(path.join(directory,file.path))).map(file=>({role:file.role,path:file.path}))};
  writeJson(path.join(directory,'manifest.json'),manifest);
  return {directory,request,manifest,analysisRecord};
}

export function prepareCoherentRecords(directory,contractSha256) {
  fs.mkdirSync(directory,{recursive:true});
  const labels='specimen_id\tdeclared_group\nS01\tA\nS02\tA\nS03\tB\nS04\tB\n';
  fs.writeFileSync(path.join(directory,'symbolic-labels.tsv'),labels);
  const analysisRecord={conditionA:'Symbolic group A',conditionB:'Symbolic group B',sampleCountA:2,sampleCountB:2};
  writeJson(path.join(directory,'analysis-record.json'),{schemaVersion:1,analysisRecord});
  const artifacts=['symbolic-labels.tsv','analysis-record.json'].map(file=>describeArtifact(file,file,{root:directory}));
  const request={schemaVersion:1,claims:analysisRecord,artifacts,additionalRecords:[]};
  writeJson(path.join(directory,'handoff.json'),request);
  const manifest={schemaVersion:1,deliveryId:'D04',contractSha256,requiredArtifacts:artifacts,deliveredFiles:artifacts,independentSpecimenLabelRecords:[]};
  writeJson(path.join(directory,'manifest.json'),manifest);
  return {directory,request,manifest,analysisRecord};
}

export function inspectPreparedDelivery(delivery) {
  return inspectDeliveryFiles({handoffPath:path.join(delivery.directory,'handoff.json'),
    analysisRecordPath:path.join(delivery.directory,'analysis-record.json'),root:delivery.directory});
}

/** A neutral file/record viewer shared byte-for-byte by every comparator. It contains no expected-answer or diagnosis labels. */
export function writeCompanionPage(directory,{title,manifest,sections=[]}) {
  for (const file of manifest.deliveredFiles||manifest.files||[]) {
    if (typeof file.path!=='string'||/^[a-z][a-z0-9+.-]*:/i.test(file.path)||/[\\?#\x00-\x1f]/.test(file.path)||file.path.startsWith('//')) throw new Error('Companion file path must be local and relative.');
    resolveArtifactPath(file.path,{root:directory});
  }
  const links=(manifest.deliveredFiles||manifest.files||[]).map(file=>`<tr><td>${escape(file.role)}</td><td><a href="${escape(file.path)}">${escape(file.path)}</a></td><td>${file.sizeBytes}</td><td><code>${escape(file.sha256)}</code></td></tr>`).join('');
  const content=sections.map(section=>`<section id="${escape(section.id)}"><h2>${escape(section.title)}</h2><p>${escape(section.source||'')}</p><pre>${escape(typeof section.value==='string'?section.value:JSON.stringify(section.value,null,2))}</pre></section>`).join('');
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
  <style>body{font:16px/1.5 system-ui,sans-serif;color:#172637;background:#f8fafc;margin:0}main{max-width:1120px;margin:auto;padding:24px}section{margin:20px 0;padding:16px;background:white;border:1px solid #d6dee8}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:13px/1.5 ui-monospace,monospace}table{border-collapse:collapse;width:100%;font-size:13px}td,th{text-align:left;vertical-align:top;padding:8px;border-bottom:1px solid #d6dee8;overflow-wrap:anywhere}a{color:#175ea5}.files{overflow:auto}</style></head><body><main>
  <h1>${escape(title)}</h1><p>The same files and records on this page are supplied to PNV, GeneTonic and RNAmel.</p>
  <nav>${sections.map(section=>`<a href="#${escape(section.id)}">${escape(section.title)}</a>`).join(' · ')}</nav>
  <section><h2>Delivered files</h2><div class="files"><table><thead><tr><th>Role</th><th>File</th><th>Bytes</th><th>SHA-256</th></tr></thead><tbody>${links}</tbody></table></div><a href="manifest.json">Delivery manifest</a></section>${content}</main></body></html>`;
  fs.writeFileSync(path.join(directory,'index.html'),html);
  return {path:path.join(directory,'index.html'),sha256:sha256(html)};
}

export function recordForViewer(viewer) {
  return analysisRecordFromViewer(viewer,{targetPathwayId:'R-HSA-449147'});
}
