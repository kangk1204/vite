// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { assertCameraTable, collectComparators, collectFigure, collectLinuxProbe, collectProvenanceValidation, collectStatistics, resolveReviewerPaths } from '../scripts/build_reviewer_portal.mjs';
import { renderPages } from '../scripts/lib/reviewer_pages.mjs';

const folders=[];
afterEach(() => folders.splice(0).forEach(dir => fs.rmSync(dir,{recursive:true,force:true})));
describe('version-bound reviewer package paths', () => {
  it('preserves external provenance receipts and refuses changed normalized receipt bytes', async () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-provenance-receipt-'));folders.push(root);
    fs.mkdirSync(path.join(root,'provenance-validation'));
    const data='{"passed":true}',file=path.join(root,'provenance-validation/consumer.json');fs.writeFileSync(file,data);
    fs.writeFileSync(path.join(root,'provenance-validation/validation.json'),JSON.stringify({cases:[{receipts:[{path:'consumer.json',sha256:createHash('sha256').update(data).digest('hex')}]}]}));
    const collected=await collectProvenanceValidation(path.join(root,'stage'),root);
    expect(collected.files).toEqual(['provenance-validation/consumer.json']);
    fs.writeFileSync(file,'changed');
    await expect(collectProvenanceValidation(path.join(root,'stage'),root)).rejects.toThrow(/digest/);
  });
  it('collects an outputs-only figure manifest and refuses changed source input bytes', async () => {
    fs.mkdirSync(path.join(process.cwd(), '.cache'), { recursive: true });
    const root = fs.mkdtempSync(path.join(process.cwd(), '.cache/reviewer-figure-test-')); folders.push(root);
    fs.mkdirSync(path.join(root,'figures'));
    const base='figure2_delivery_validation', outputs=[];
    for (const ext of ['pdf','png','svg','source.tsv','source.xlsx','legend.txt','legend.docx']) {
      const name=`${base}.${ext}`, data=`payload ${ext}`;
      fs.writeFileSync(path.join(root,'figures',name),data);
      outputs.push({path:name,sha256:createHash('sha256').update(data).digest('hex')});
    }
    const input=path.join(root,'input.json');fs.writeFileSync(input,'{}');
    fs.writeFileSync(path.join(root,'figures',`${base}.manifest.json`),JSON.stringify({outputs,inputs:[{path:path.relative(process.cwd(),input),sha256:createHash('sha256').update('{}').digest('hex')}]}));
    await collectFigure(path.join(root,'stage'),root,base);
    expect(fs.existsSync(path.join(root,'stage/figures',`${base}.png`))).toBe(true);
    fs.writeFileSync(input,'changed');
    await expect(collectFigure(path.join(root,'stage'),root,base)).rejects.toThrow(/input|source|digest/);
  });
  it('copies only indexed statistical supplements, rejecting checkpoint payloads and stale digests', async () => {
    fs.mkdirSync(path.join(process.cwd(), '.cache'), { recursive: true });
    const root = fs.mkdtempSync(path.join(process.cwd(), '.cache/reviewer-statistics-test-')); folders.push(root);
    const directory=path.join(root,'statistics');fs.mkdirSync(directory);
    const input=path.join(directory,'summary.tsv');fs.writeFileSync(input,'key\tvalue\nx\t1\n');
    const item={path:path.relative(process.cwd(),input),bytes:fs.statSync(input).size,sha256:createHash('sha256').update(fs.readFileSync(input)).digest('hex')};
    const index=path.join(directory,'artifact-index.json');fs.writeFileSync(index,JSON.stringify({files:[item]}));
    const result=await collectStatistics(path.join(root,'stage'),path.relative(process.cwd(),index));
    expect(result.files).toEqual(['statistics/summary.tsv']);
    fs.writeFileSync(input,'changed');
    await expect(collectStatistics(path.join(root,'stage'),path.relative(process.cwd(),index))).rejects.toThrow(/digest|size/);
    fs.writeFileSync(index,JSON.stringify({files:[{...item,path:path.relative(process.cwd(),path.join(directory,'bootstrap_checkpoints/0001.rds'))}]}));
    await expect(collectStatistics(path.join(root,'stage'),path.relative(process.cwd(),index))).rejects.toThrow(/checkpoint|payload/);
  });
  it('binds public Linux evidence to the selected source and verifies every copied support file', async () => {
    fs.mkdirSync(path.join(process.cwd(), '.cache'), { recursive: true });
    const root = fs.mkdtempSync(path.join(process.cwd(), '.cache/linux-receipt-test-')); folders.push(root);
    const contents = '{"status":"pass"}\n';
    fs.writeFileSync(path.join(root,'support.json'),contents);
    const source = { sourceSnapshot:'a'.repeat(64),sha256:'b'.repeat(64) };
    const proof = { status:'completed',sourceSnapshot:source.sourceSnapshot,sourceArchiveSha256:source.sha256,
      evidenceFiles:{'support.json':{sha256:createHash('sha256').update(contents).digest('hex'),bytes:Buffer.byteLength(contents)}} };
    const receipt = path.join(root,'probe.json');fs.writeFileSync(receipt,JSON.stringify(proof));
    const copied = await collectLinuxProbe(path.join(root,'stage'),path.relative(process.cwd(),receipt),source);
    expect(copied.receipt).toBe('linux-replay/ordinary-airway-results.json');
    expect(fs.readFileSync(path.join(root,'stage/linux-replay/support.json'),'utf8')).toBe(contents);
    await expect(collectLinuxProbe(path.join(root,'stage'),path.relative(process.cwd(),receipt),{...source,sha256:'c'.repeat(64)})).rejects.toThrow(/source/);
    fs.writeFileSync(path.join(root,'support.json'),'changed');
    await expect(collectLinuxProbe(path.join(root,'stage'),path.relative(process.cwd(),receipt),source)).rejects.toThrow(/digest|size/);
  });
  it('requires comparator executed sources and runner identity to agree with the artifact inventory', async () => {
    fs.mkdirSync(path.join(process.cwd(), '.cache'), { recursive: true });
    const root = fs.mkdtempSync(path.join(process.cwd(), '.cache/reviewer-receipt-test-')); folders.push(root);
    const valid = ['GeneTonic:matched','GeneTonic:defaults','RNAmel:matched','RNAmel:defaults'].map(value => {
      const [tool, mode] = value.split(':');
      return { tool, mode, completed: true, offlineBrowserVerified: true, runnerSha256: 'a'.repeat(64),
        executedSources: [{path:'runner.R',sha256:'a'.repeat(64)},{path:'helper.R',sha256:'b'.repeat(64)}],
        artifacts: [{path:'runner.R',sha256:'a'.repeat(64)},{path:'helper.R',sha256:'b'.repeat(64)}] };
    });
    fs.mkdirSync(path.join(root,'genetonic-matched'));
    for (const first of [
      {...valid[0], executedSources: [{path:'../runner.R',sha256:'a'.repeat(64)},valid[0].executedSources[1]]},
      {...valid[0], runnerSha256:'c'.repeat(64)},
    ]) {
      fs.writeFileSync(path.join(root,'benchmark.json'),JSON.stringify({results:[first,...valid.slice(1)]}));
      fs.writeFileSync(path.join(root,'genetonic-matched/metrics.json'),JSON.stringify(first));
      await expect(collectComparators(path.join(root,'stage'),path.relative(process.cwd(),path.join(root,'benchmark.json')))).rejects.toThrow(/executed source|runner digest/);
    }
  });
  it('compares estimated CAMERA correlation as a serialized R double while preserving NGenes exactly', () => {
    const rows = [{ pathway: 'R1', pvalue: '0.1', padj: '0.2', direction: 'Up', NGenes: '20', Correlation: '0.0166027903272348' }];
    const source = { columns: Object.keys(rows[0]), rows: [['R1', 0.1, 0.2, 'Up', 20, 0.0166027903272347]] };
    expect(() => assertCameraTable(rows, source)).not.toThrow();
    expect(() => assertCameraTable([{ ...rows[0], Correlation: '0.017' }], source)).toThrow(/Correlation/);
    expect(() => assertCameraTable([{ ...rows[0], NGenes: '21' }], source)).toThrow(/NGenes/);
    expect(() => assertCameraTable([{ ...rows[0], Correlation: '' }], source)).toThrow(/Correlation/);
  });
  it('derives all default package paths from the selected publication manifest', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-reviewer-path-'));folders.push(root);
    fs.mkdirSync(path.join(root,'paper/manifests'),{recursive:true});
    fs.writeFileSync(path.join(root,'paper/manifests/revision.json'),JSON.stringify({outputRoot:'paper/outputs/revision',cohorts:[]}));
    const result=resolveReviewerPaths({manifestPath:'paper/manifests/revision.json'},root);
    expect(result.publication).toBe(path.join(root,'paper/outputs/revision'));
    expect(result.releaseReceipt).toBe(path.join(root,'paper/outputs/revision/release/source-snapshot.json'));
    expect(result.destination).toBe(path.join(root,'paper/outputs/revision/reviewer'));
  });
  it('rejects a publication output outside the repository root', () => {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-reviewer-path-'));folders.push(root);
    fs.writeFileSync(path.join(root,'manifest.json'),JSON.stringify({outputRoot:'../other'}));
    expect(()=>resolveReviewerPaths({manifestPath:'manifest.json'},root)).toThrow(/escape|outside/);
  });
  it('prints the selected source, config and output version in reviewer reproduction commands', () => {
    const pages = renderPages({
      example: { id:'R1', primary:{row:1,values:{padj:0.001,NES:2,size:20}}, camera:{row:1,values:{padj:0.3,direction:'Up'}},
        bootstrap:{selected:200,valid:500,requested:500,selectionFrequency:0.4}, analysis:{alpha:0.05,pathwayHypothesisCount:100}, runId:'run' },
      cohorts:[], source:{name:'source.zip',sourceSnapshot:'a'.repeat(64),sha256:'b'.repeat(64)}, figureBases:[['figure2_delivery_validation','Figure 2']], pdCount:29,controlCount:44,exampleBytes:100,fullBytes:200,
      statistics:{index:'statistics/artifact-index.json',files:['statistics/validation/artifact-consistency.json']},
      publication:{manifestPath:'paper/manifests/revision.json',outputRoot:'paper/outputs/revision',primaryConfigPath:'paper/configs/revision/pd.json',primarySnapshotPath:'paper/outputs/revision/pd/ref.rds'},
    });
    expect(pages['reproduce.html']).toContain('paper/configs/revision/pd.json');
    expect(pages['reproduce.html']).toContain('paper/outputs/revision/pd/ref.rds');
    expect(pages['reproduce.html']).toContain('paper/manifests/revision.json');
    expect(pages['reproduce.html']).not.toContain('publication_v2');
    expect(pages['files.html']).toContain('figures/figure2_delivery_validation.png');
    expect(pages['files.html']).toContain('statistics/validation/artifact-consistency.json');
  });
});
