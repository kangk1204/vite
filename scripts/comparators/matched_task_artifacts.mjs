import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from './matched_task_contract.mjs';
import {writeJson} from './matched_task_deliveries.mjs';

const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function writeAuditIndex(output,results) {
  const root=process.cwd(),link=file=>path.relative(output,path.resolve(root,file)).split(path.sep).join('/');
  const rows=results.taskSummary.map(row=>{
    const components=results.observations.filter(item=>item.tool===row.tool&&item.task_id===row.task_id);
    const native=components[0].native,run=results.nativeRuns.find(item=>item.tool===row.tool&&item.delivery===row.delivery);
    const exports=[...new Map(components.flatMap(item=>[item.native,...(item.native.alternatives||[])]).filter(item=>item.route==='documented_native_export').map(item=>[item.file,item])).values()];
    const observedLinks=[...(native.screenshot?[`<a href="${escape(link(native.screenshot))}">Observed screen</a>`]:[]),...exports.map(item=>`<a href="${escape(link(item.file))}">Native export${item.requires_R?' (R required)':''}</a>`)];
    return `<tr><td>${escape(row.tool)}</td><td>${escape(row.task_id)} · ${escape(row.task_label)}</td><td>${escape(JSON.stringify(row.native_routes))}</td><td>${run?`<a href="${escape(link(run.report.path))}">Native report</a>`:'Record-only control'}</td><td><a href="${escape(link(components[0].companion.page))}">Common evidence</a> · <a href="${escape(link(components[0].companion.file))}">Source file</a></td><td>${observedLinks.join(' · ')||'Not assessed'}</td></tr>`;
  }).join('');
  fs.writeFileSync(path.join(output,'index.html'),`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Matched pathway-report task audit</title><style>body{font:15px/1.5 system-ui,sans-serif;color:#172638;max-width:1280px;margin:auto;padding:24px}table{width:100%;border-collapse:collapse}td,th{text-align:left;vertical-align:top;border-bottom:1px solid #d7e0e9;padding:9px}a{color:#165c97}code{overflow-wrap:anywhere}</style><h1>Matched pathway-report task audit</h1><p>GSE68719 · R-HSA-449147 · 10 predefined tasks,37 components,3 tools. The same case evidence is supplied to every tool. Routes describe the prepared reports and documented exports.</p><p>Values supplied through annotations remain upstream inputs. Tool-produced checks and auditor comparisons are identified separately. No participant performance, task-time effect or overall tool score was measured.</p><p><a href="results.json">Complete observations and source bindings</a> · <a href="observations.tsv">Component table</a> · <a href="task-summary.tsv">Task summary</a> · <a href="task-contract.json">Frozen task contract</a></p><table><thead><tr><th>Tool</th><th>Task</th><th>Primary observed routes</th><th>Report</th><th>Evidence</th><th>Observation</th></tr></thead><tbody>${rows}</tbody></table></html>`);
}

export function writeArtifactManifest(output,results,state,observationDirectory) {
  const selected=new Map(),root=process.cwd();
  const add=(file,role)=>{
    const absolute=path.resolve(file);
    if(!fs.existsSync(absolute)||!fs.statSync(absolute).isFile())throw new Error('Required audit artifact is missing: '+file);
    if(!selected.has(absolute))selected.set(absolute,{role,path:path.relative(root,absolute).split(path.sep).join('/'),sha256:sha256(fs.readFileSync(absolute)),sizeBytes:fs.statSync(absolute).size});
    else if(role==='actual_documented_native_export')selected.set(absolute,{...selected.get(absolute),role});
  };
  for(const name of ['results.json','observations.tsv','task-summary.tsv','index.html','task-contract.json','task-contract-freeze.json','case-preparation.json','original-numeric-reference.json','companion-allocation.json'])add(path.join(output,name),'audit_record');
  for(const item of results.executedSources){add(item.path,'executed_audit_source');add(item.original,'audit_source');}
  add('tests/comparators/matched-tasks.test.js','audit_regression_tests');
  add(results.fairness.primaryFixtureReceipt.path,'primary_fixture_receipt');add(results.fairness.parityReceipt.path,'primary_array_parity');
  for(const delivery of results.fairness.deliveries){
    add(delivery.manifest.path,'common_delivery_manifest');
    const directory=path.dirname(path.resolve(delivery.manifest.path));
    for(const file of delivery.deliveredFiles)add(path.join(directory,file.path),'common_evidence');
  }
  for(const run of results.nativeRuns){
    add(run.report.path,'native_report');
    if(run.metrics){
      add(run.metrics.path,'native_execution_receipt');add(run.inputMapping.path,'native_input_mapping');
      const directory=path.dirname(path.resolve(run.metrics.path));
      for(const name of ['native-api-calls.json','native-script-scope.json','runner.snapshot.R','fixture_support.R'])if(fs.existsSync(path.join(directory,name)))add(path.join(directory,name),'native_execution_source_or_record');
    }
  }
  for(const item of results.pnvPreparation){
    add(item.receiptPath,'pnv_generation_receipt');add(item.input.path,'pnv_original_viewer_input');
    add(path.join(path.dirname(item.receiptPath),'pnv-generation.log'),'pnv_generation_log');
  }
  for(const file of fs.readdirSync(observationDirectory))if(fs.statSync(path.join(observationDirectory,file)).isFile())add(path.join(observationDirectory,file),'browser_or_export_observation');
  for(const row of results.observations)for(const record of [row.native,...(row.native.alternatives||[])]){
    if(record.route==='documented_native_export')add(record.file,'actual_documented_native_export');
  }
  for(const item of results.supplementalNativeExports||[])for(const file of [item.receipt,item.file,item.screenshot])add(file,'supplemental_native_export_inspection');
  if(results.closure)add(results.closure.source,'audit_closure_source');
  const manifest={schemaVersion:1,scope:'Explicit public matched-task audit artifact allowlist',pathsRelativeTo:'repository root',
    generator:{path:path.relative(root,fileURLToPath(import.meta.url)),sha256:sha256(fs.readFileSync(fileURLToPath(import.meta.url)))},
    resultsSha256:sha256(fs.readFileSync(path.join(output,'results.json'))),files:[...selected.values()]};
  writeJson(path.join(output,'artifact-manifest.json'),manifest);
  return manifest;
}
