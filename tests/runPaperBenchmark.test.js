import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  canReuseCohortOutputs,
  normalizeJobCommands,
  resolveRootPath,
  describeJobFingerprint,
  collectCohortArtifacts,
  canReuseRecordedOutputs,
  shouldRebuildReport,
  prepareJobInputs,
} from '../scripts/run_paper_benchmark.mjs';

function makeTempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-paper-benchmark-'));
}

describe('run_paper_benchmark hardening helpers', () => {
  it('rejects shell-string manifest commands', () => {
    expect(() =>
      normalizeJobCommands({
        key: 'unsafe',
        command: 'echo unsafe',
      }),
    ).toThrow(/argv array/);
  });

  it('rejects non-allowlisted executables', () => {
    expect(() =>
      normalizeJobCommands({
        key: 'unsafe',
        command: ['bash', '-lc', 'echo unsafe'],
      }),
    ).toThrow(/not allowed/);
    expect(() => normalizeJobCommands({ key: 'inline', command: ['Rscript', '-e', 'bad()'] })).toThrow(/repository script/);
    expect(normalizeJobCommands({key:'legacy-python',command:['.venv/bin/python','scripts/render_psoriasis_pathway_figure.py']})).toHaveLength(1);
  });

  it('keeps repository-relative paths inside the selected root', () => {
    const root = makeTempRoot();

    expect(resolveRootPath('paper/cohort_manifest.json', root)).toBe(
      path.join(root, 'paper/cohort_manifest.json'),
    );
    expect(() => resolveRootPath('../outside.json', root)).toThrow(/escapes repository root/);
    const outside = makeTempRoot();
    fs.symlinkSync(outside, path.join(root, 'escape'));
    expect(() => resolveRootPath('escape/new-output.json', root)).toThrow(/escapes/);
    fs.rmSync(root, { recursive: true });
    fs.rmSync(outside, { recursive: true });
  });

  it('does not reuse cohort outputs when a required artifact is empty', () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'results'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'results/workbook.xlsx'), 'not-empty');
    fs.writeFileSync(path.join(root, 'reports/report.html'), '');

    expect(
      canReuseCohortOutputs(
        {
          workbookPath: 'results/workbook.xlsx',
          reportPath: 'reports/report.html',
        },
        root,
      ),
    ).toBe(false);
  });

  it('is safe to use through an Array.every wrapper over cohort rows', () => {
    const root = makeTempRoot();
    fs.mkdirSync(path.join(root, 'results'), { recursive: true });
    fs.mkdirSync(path.join(root, 'reports'), { recursive: true });
    fs.writeFileSync(path.join(root, 'results/workbook.xlsx'), 'not-empty');
    fs.writeFileSync(path.join(root, 'reports/report.html'), 'not-empty');

    const cohorts = [
      {
        workbookPath: 'results/workbook.xlsx',
        reportPath: 'reports/report.html',
      },
    ];

    expect(cohorts.every((cohort) => canReuseCohortOutputs(cohort, root))).toBe(true);
  });
});

describe('paper pipeline content invalidation', () => {
  it('materializes explicit preparation outputs before the analysis input fingerprint', () => {
    const root=makeTempRoot();
    fs.mkdirSync(path.join(root,'scripts'),{recursive:true});fs.mkdirSync(path.join(root,'paper'),{recursive:true});
    fs.writeFileSync(path.join(root,'paper/manifest.json'),'{}');
    fs.writeFileSync(path.join(root,'scripts/analysis.R'),'# analysis');
    fs.writeFileSync(path.join(root,'paper/config.json'),JSON.stringify({rawCountsPath:'counts.tsv',sampleMetadataPath:'samples.tsv'}));
    const job={key:'fresh-airway',prepareCommands:[['Rscript','scripts/prepare_airway_case.R','prepared']],command:['Rscript','scripts/analysis.R','paper/config.json']};
    prepareJobInputs(job,{root,execute:()=>{fs.writeFileSync(path.join(root,'counts.tsv'),'counts');fs.writeFileSync(path.join(root,'samples.tsv'),'samples');}});
    const descriptor=describeJobFingerprint(job,[],path.join(root,'paper/manifest.json'),'git','ref',{root});
    expect(descriptor.inputs.find(input=>input.path==='counts.tsv').sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(descriptor.inputs.find(input=>input.path==='samples.tsv').sha256).toMatch(/^[a-f0-9]{64}$/);
    fs.rmSync(root,{recursive:true});
  });
  it('invalidates changed raw counts, reference bytes and dirty R source despite unchanged paths', () => {
    const root = makeTempRoot();
    for (const directory of ['scripts/lib', 'paper/configs', 'data/reference']) fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, 'paper/manifest.json'), '{}');
    fs.writeFileSync(path.join(root, 'scripts/analysis.R'), '# original');
    fs.writeFileSync(path.join(root, 'scripts/lib/core.R'), '# core');
    fs.writeFileSync(path.join(root, 'counts.tsv'), 'counts');
    fs.writeFileSync(path.join(root, 'data/reference/ReactomePathways.gmt.zip'), 'ref');
    fs.writeFileSync(path.join(root, 'paper/configs/cohort.json'), JSON.stringify({ rawCountsPath: 'counts.tsv' }));
    const job = { key: 'test', command: ['Rscript', 'scripts/analysis.R', 'paper/configs/cohort.json'] };
    const describe = () => describeJobFingerprint(job, [], path.join(root, 'paper/manifest.json'), 'same-commit', 'same-reference-count', { root });
    const before = describe();
    fs.writeFileSync(path.join(root, 'counts.tsv'), 'changed-counts');
    const afterCounts = describe();
    expect(afterCounts.fingerprint).not.toBe(before.fingerprint);
    fs.writeFileSync(path.join(root, 'scripts/lib/core.R'), '# changed without commit');
    const afterCode = describe();
    expect(afterCode.fingerprint).not.toBe(afterCounts.fingerprint);
    fs.writeFileSync(path.join(root, 'data/reference/ReactomePathways.gmt.zip'), 'changed-reference');
    const afterReference = describe();
    expect(afterReference.fingerprint).not.toBe(afterCode.fingerprint);
    fs.writeFileSync(path.join(root, 'requirements.lock.txt'), 'pandas==2.0');
    expect(describe().fingerprint).not.toBe(afterReference.fingerprint);
    expect(before.complete).toBe(false); // Required environment/reference artifacts are absent.
    fs.rmSync(root, { recursive: true });
  });

  it('requires recorded content digests, not just non-empty files, for reuse', () => {
    const root = makeTempRoot();
    fs.writeFileSync(path.join(root, 'workbook.xlsx'), 'original');
    fs.writeFileSync(path.join(root, 'report.html'), 'report');
    const cohort = { workbookPath: 'workbook.xlsx', reportPath: 'report.html' };
    const recorded = collectCohortArtifacts(cohort, root);
    expect(canReuseRecordedOutputs(cohort, recorded, root)).toBe(true);
    expect(canReuseRecordedOutputs(cohort, undefined, root)).toBe(false);
    fs.writeFileSync(path.join(root, 'workbook.xlsx'), 'tampered');
    expect(canReuseRecordedOutputs(cohort, recorded, root)).toBe(false);
    fs.rmSync(root, { recursive: true });
  });

  it('regenerates a report after R reruns even if all old report files still exist', () => {
    expect(shouldRebuildReport({ jobReran: true, forceRerun: false, outputsMatch: true, fingerprint: 'same', previousFingerprint: 'same' })).toBe(true);
    expect(shouldRebuildReport({ jobReran: false, forceRerun: false, outputsMatch: true, fingerprint: 'same', previousFingerprint: 'same' })).toBe(false);
    expect(shouldRebuildReport({ jobReran: false, forceRerun: false, outputsMatch: true, fingerprint: 'new-code', previousFingerprint: 'old-code' })).toBe(true);
    expect(shouldRebuildReport({ jobReran: false, forceRerun: false, outputsMatch: false, fingerprint: 'same', previousFingerprint: 'same' })).toBe(true);
  });

  it('invalidates deleted viewer JSON and tampered v2 sensitivity outputs', () => {
    const root = makeTempRoot();
    const cohort = { workbookPath: 'case_pathway_viewer_input.xlsx', reportPath: 'case.report.html' };
    for (const filename of ['case_pathway_viewer_input.xlsx', 'case.report.html', 'case.report.viewer.json', 'case.report.ro-crate.json', 'case_evidence.json', 'case_camera.tsv']) fs.writeFileSync(path.join(root, filename), 'original');
    const recorded = collectCohortArtifacts(cohort, root);
    expect(canReuseRecordedOutputs(cohort, recorded, root)).toBe(true);
    fs.unlinkSync(path.join(root, 'case.report.viewer.json'));
    expect(canReuseRecordedOutputs(cohort, recorded, root)).toBe(false);
    fs.writeFileSync(path.join(root, 'case.report.viewer.json'), 'original');
    fs.writeFileSync(path.join(root, 'case_camera.tsv'), 'tampered');
    expect(canReuseRecordedOutputs(cohort, recorded, root)).toBe(false);
    fs.rmSync(root, { recursive: true });
  });
});
