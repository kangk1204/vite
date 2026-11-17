import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256} from './matched_task_contract.mjs';
import {writeJson} from './matched_task_deliveries.mjs';

export function extractViewerRecord(html) {
  const marker='window.__PNV_DATA__ = ',start=html.indexOf(marker),end=html.indexOf(';\n',start);
  if (start<0||end<start) throw new Error('PNV report has no recorded viewer assignment.');
  return JSON.parse(html.slice(start+marker.length,end));
}

export function preparePnvReports(contract,outputDirectory) {
  const input=path.resolve(contract.analysisRoot,'reports/gse68719_pd_primary.report.viewer.json');
  const baseline=path.resolve(contract.analysisRoot,'reports/gse68719_pd_primary.report.html');
  const original=JSON.parse(fs.readFileSync(input,'utf8'));
  const tableHash=sha256(JSON.stringify(original.evidence.sourceTables)),rankHash=sha256(JSON.stringify(original.evidence.rankedGenes));
  const outputs={base:baseline},commands=[];
  for (const [id,delivery] of [['D01','consistent'],['D02','contrast_conflict'],['D03','missing_required_file']]) {
    const directory=path.resolve(outputDirectory,'deliveries',id),file=path.join(directory,'pnv.report.html');
    const args=['scripts/build_report_from_workbook.mjs',input,file,'--handoff',path.join(directory,'handoff.json'),
      '--analysis-record',path.join(directory,'analysis-record.json'),'--delivery-root',directory,'--condition','full'];
    const receiptPath=path.join(directory,'pnv-generation.json');
    if (!fs.existsSync(receiptPath)) {
      const run=spawnSync(process.execPath,args,{encoding:'utf8',maxBuffer:8*1024*1024});
      fs.writeFileSync(path.join(directory,'pnv-generation.log'),String(run.stdout||'')+String(run.stderr||''));
      if (run.status!==0) throw new Error(`PNV normal entrypoint failed for ${id}: ${run.stderr||run.error}`);
      const html=fs.readFileSync(file,'utf8'),viewer=extractViewerRecord(html);
      const sourceTablesUnchanged=sha256(JSON.stringify(viewer.evidence.sourceTables))===tableHash;
      const ranksUnchanged=sha256(JSON.stringify(viewer.evidence.rankedGenes))===rankHash;
      if (!sourceTablesUnchanged||!ranksUnchanged) throw new Error('A delivery case changed original statistical arrays.');
      writeJson(receiptPath,{command:[process.execPath,...args],entrypointSha256:sha256(fs.readFileSync(args[0])),input:{path:input,sha256:sha256(fs.readFileSync(input))},
        report:{path:file,sha256:sha256(html),sizeBytes:Buffer.byteLength(html)},sourceTablesUnchanged,ranksUnchanged,
        verificationScope:'Machine-level source preservation; this extraction does not establish native-visible access.'});
    }
    const receipt=JSON.parse(fs.readFileSync(receiptPath,'utf8'));
    if (sha256(fs.readFileSync(file))!==receipt.report.sha256) throw new Error('Prepared PNV report changed.');
    outputs[delivery]=file;commands.push({receiptPath,...receipt});
  }
  return {reports:outputs,commands};
}
