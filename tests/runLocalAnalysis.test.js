import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runLocalAnalysis, parseLocalArgs } from '../scripts/run_local_analysis.mjs';
import { REFERENCE_INPUTS } from '../scripts/lib/provenance_pipeline.mjs';

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-run-local-'));
  roots.push(root);
  const input = path.join(root, 'input.json');
  fs.writeFileSync(input, JSON.stringify({
    schemaVersion: 1, kind: 'pnv-local-analysis-input',
    project: { title: 'Test', accession: 'GSE_TEST', organism: 'human', conditionA: 'Control', conditionB: 'Treatment' },
    rawCountsText: 'gene\tA1\tA2\tB1\tB2\nTP53\t1\t2\t3\t4\n',
    seriesMatrixText: '!Sample_geo_accession\tA1\tA2\tB1\tB2\n!Sample_title\tA1\tA2\tB1\tB2',
    design: { groupBySample: { A1: 'A', A2: 'A', B1: 'B', B2: 'B' } },
  }));
  return { root, input, output: path.join(root, 'output') };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('local analysis execution boundaries', () => {
  it('requires explicit output and rejects arbitrary options', () => {
    expect(() => parseLocalArgs(['input.json'])).toThrow(/output/);
    expect(() => parseLocalArgs(['input.json', '--output', 'out', '--exec', 'sh'])).toThrow(/unknown/i);
    expect(parseLocalArgs(['input.json', '--output', 'out', '--condition', 'basic'])).toMatchObject({ inputPath: 'input.json', outputPath: 'out', condition: 'basic' });
  });

  it('does not replace an unmanaged output directory', () => {
    const f = fixture();
    fs.mkdirSync(f.output);
    fs.writeFileSync(path.join(f.output, 'user-notes.txt'), 'keep');
    expect(() => runLocalAnalysis(f.input, f.output, { environment: {} })).toThrow(/unmanaged/i);
    expect(fs.readFileSync(path.join(f.output, 'user-notes.txt'), 'utf8')).toBe('keep');
  });

  it('does not publish partial outputs if R fails', () => {
    const f = fixture();
    const execute = () => { throw new Error('R analysis failed'); };
    expect(() => runLocalAnalysis(f.input, f.output, { environment: {}, execute })).toThrow(/R analysis failed/);
    expect(fs.existsSync(f.output)).toBe(false);
    expect(fs.readdirSync(f.root).filter(name => name.startsWith('.pnv-stage'))).toEqual([]);
  });

  it('rejects an output alias resolving to the project itself', () => {
    const f = fixture();
    const alias = path.join(f.root, 'alias');
    fs.symlinkSync(process.cwd(), alias);
    expect(() => runLocalAnalysis(f.input, alias, { environment: {} })).toThrow(/symlink|project root/);
  });

  it('reuses only intact managed outputs and keeps the prior run when a rebuild fails', () => {
    const f = fixture();
    for (const filename of [...REFERENCE_INPUTS, 'renv.lock', 'package-lock.json', 'scripts/run_local_analysis.R', 'scripts/run_local_analysis.mjs', 'scripts/build_report_from_workbook.mjs']) {
      fs.mkdirSync(path.dirname(path.join(f.root, filename)), { recursive: true });
      fs.writeFileSync(path.join(f.root, filename), 'fixture');
    }
    let calls = 0;
    const execute = (command, args) => {
      calls += 1;
      if (command === 'Rscript') {
        const config = JSON.parse(fs.readFileSync(args[1], 'utf8'));
        const out = config.outputDir;
        fs.writeFileSync(path.join(out, 'analysis_pathway_viewer_input.xlsx'), 'workbook');
        fs.writeFileSync(path.join(out, 'analysis_deseq2.tsv'), 'gene\tstat\nTP53\t1\n');
        fs.writeFileSync(path.join(out, 'analysis_fgsea_reactome.tsv'), 'pathway\tNES\nR-TEST\t1\n');
        fs.writeFileSync(path.join(out, 'analysis_evidence.json'), JSON.stringify({ schemaVersion: 2, evidence: {
          analysis: { method: 'fixture' }, verification: { checks: [], limitations: [] },
        } }));
      } else {
        fs.writeFileSync(args[2], 'rendered report');
        fs.writeFileSync(args[args.indexOf('--viewer-json') + 1], JSON.stringify({ evidence: { verification: { status: 'verified_against_supplied_artifacts' } } }));
      }
    };
    const options = { root: f.root, environment: { R: 'fixture' }, execute };
    expect(runLocalAnalysis(f.input, f.output, options).reused).toBe(false);
    expect(calls).toBe(2);
    expect(runLocalAnalysis(f.input, f.output, options).reused).toBe(true);
    expect(calls).toBe(2);
    fs.writeFileSync(path.join(f.output, 'analysis.viewer.json'), 'tampered');
    expect(runLocalAnalysis(f.input, f.output, options).reused).toBe(false);
    expect(calls).toBe(4);
    fs.writeFileSync(path.join(f.root, 'renv.lock'), 'changed environment lock');
    expect(() => runLocalAnalysis(f.input, f.output, { ...options, execute: () => { throw new Error('rebuild failed'); } })).toThrow(/rebuild failed/);
    expect(fs.readFileSync(path.join(f.output, 'analysis.report.html'), 'utf8')).toBe('rendered report');
    expect(() => runLocalAnalysis(f.input, f.output, { ...options, execute: (command,args) => {
      execute(command,args);
      if(command==='Rscript') fs.writeFileSync(path.join(f.root,'scripts/build_report_from_workbook.mjs'),'mid-run source change');
    } })).toThrow(/changed during R analysis/);
    expect(fs.readFileSync(path.join(f.output,'analysis.report.html'),'utf8')).toBe('rendered report');
    expect(() => runLocalAnalysis(f.input, f.output, { ...options, execute: (command,args) => {
      execute(command,args);
      if(command==='node') fs.appendFileSync(f.input,'\n');
    } })).toThrow(/Original input bundle changed/);
    expect(fs.readFileSync(path.join(f.output,'analysis.report.html'),'utf8')).toBe('rendered report');
  });
});
