import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareDeliveryFiles,prepareCoherentRecords,writeJson} from './matched_task_deliveries.mjs';
import {freezeContract,sha256} from './matched_task_contract.mjs';
import {resolveArtifactPath,describeArtifact} from '../lib/provenance.mjs';

export function prepareMatchedDeliveries(contractFile,outputDirectory) {
  const frozen=freezeContract(contractFile,outputDirectory);
  const contract=JSON.parse(fs.readFileSync(contractFile,'utf8'));
  const receiptFile=path.join(outputDirectory,'case-preparation.json');
  if (fs.existsSync(receiptFile)) {
    const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
    if (receipt.contractSha256!==frozen.sha256) throw new Error('Prepared cases belong to another task contract.');
    return receipt;
  }
  const source=path.resolve(contract.analysisRoot,'gse68719_pd_primary/gse68719_pd_vs_control_report_evidence.json');
  const bytes=fs.readFileSync(source),evidence=JSON.parse(bytes).evidence;
  const table=evidence.sourceTables.metadata,groupColumn=table.columns.indexOf('group');
  if (groupColumn<0) throw new Error('Original source sample groups are required.');
  const analysisRecord={datasetIdentifier:contract.dataset,...evidence.analysis.contrast,designFormula:evidence.analysis.designFormula,
    sampleCountA:table.rows.filter(row=>row[groupColumn]==='A').length,sampleCountB:table.rows.filter(row=>row[groupColumn]==='B').length,
    rankMetric:evidence.analysis.rankMetric,lfcMethod:evidence.analysis.lfcMethod,adjustment:evidence.analysis.adjustment,
    pathwayHypothesisCount:evidence.analysis.pathwayHypothesisCount,testedSize:evidence.pathways[contract.pathwayId].testedSize};
  const excluded=new Set(['reference_snapshot','workbook']),counters={},files={};
  for (const artifact of evidence.artifacts) {
    if (excluded.has(artifact.role)) continue;
    const input=resolveArtifactPath(artifact.path,{root:path.dirname(source),projectRoot:process.cwd()});
    const actual=describeArtifact(artifact.role,path.basename(input),{root:path.dirname(input)});
    if (actual.sha256!==artifact.sha256||actual.sizeBytes!==artifact.sizeBytes) throw new Error('Original source artifact changed: '+artifact.path);
    const count=counters[artifact.role]||0;counters[artifact.role]=count+1;
    files[artifact.role+(count?'_'+count:'')]={role:artifact.role,path:input};
  }
  files.report_evidence={role:'report_evidence',path:source};
  const cases=[];
  for (const [deliveryId,kind] of [['D01','consistent'],['D02','contrast_conflict'],['D03','missing_required_file']]) {
    const directory=path.join(outputDirectory,'deliveries',deliveryId);
    const delivery=prepareDeliveryFiles({directory,files,analysisRecord,kind,deliveryId,target:contract.pathwayId,contractSha256:frozen.sha256});
    const context={protocolVersion:1,contractSha256:frozen.sha256,deliveryId,targetPathwayId:contract.pathwayId,
      requestedContrast:delivery.request.claims,actualContrast:evidence.analysis.contrast,actualDesign:evidence.analysis.designFormula,
      declaredFiles:delivery.manifest.requiredArtifacts,deliveredFiles:delivery.manifest.deliveredFiles};
    const contextPath=path.join(directory,'native-context.json');
    writeJson(contextPath,context);
    cases.push({deliveryId,kind,contextPath,contextSha256:sha256(fs.readFileSync(contextPath)),manifestPath:path.join(directory,'manifest.json')});
  }
  const recordOnly=prepareCoherentRecords(path.join(outputDirectory,'deliveries','D04'),frozen.sha256);
  const receipt={contractSha256:frozen.sha256,sourceEvidence:{path:source,sha256:sha256(bytes)},target:contract.pathwayId,cases,
    recordOnly:{deliveryId:'D04',directory:recordOnly.directory,nativeReportScope:'not_assessed_for_all_tools'},
    sourceCode:[import.meta.url,new URL('./matched_task_deliveries.mjs',import.meta.url).href].map(url=>({path:fileURLToPath(url),sha256:sha256(fs.readFileSync(fileURLToPath(url)))})),
    command:[process.execPath,...process.argv.slice(1)],preparedAt:new Date().toISOString()};
  writeJson(receiptFile,receipt);
  return receipt;
}

if (process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const contract=process.argv[2]||'paper/evaluation/matched_tasks_2026_11_17.json';
  const output=process.argv[3]||'paper/outputs/publication_2026_11_17/comparators/matched_tasks';
  const receipt=prepareMatchedDeliveries(contract,output);
  console.log(JSON.stringify({cases:receipt.cases,recordOnly:receipt.recordOnly}));
}
