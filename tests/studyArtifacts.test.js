import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createSessionHtml } from '../scripts/study/session_html.mjs';
import { protocolDigest, main } from '../scripts/study/run_study.mjs';

describe('study artifact boundaries', () => {
  it('hashes protocol content canonically and detects changed timing', () => {
    const protocol = { timeoutMs: 240000, gates: { protocolSha256: null, plannedSampleSize: 24 } };
    expect(protocolDigest(protocol)).toBe(protocolDigest({ gates: { plannedSampleSize: 24, protocolSha256: 'a'.repeat(64) }, timeoutMs: 240000 }));
    expect(protocolDigest({ ...protocol, timeoutMs: 60000 })).not.toBe(protocolDigest(protocol));
  });
  it('refuses development and duplicate cases in final detector metrics', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-study-detector-'));
    try {
      const file = path.join(root, 'cases.json');
      const row = { id: 'C1', split: 'development', truth: 'normal', predicted: 'normal', adjudicationStatus: 'adjudicated', reviewers: ['A', 'B'] };
      fs.writeFileSync(file, JSON.stringify([row]));
      expect(() => main(['detector', '--cases', file, '--out', path.join(root, 'result.json')])).toThrow(/held_out/);
      fs.writeFileSync(file, JSON.stringify([{ ...row, split: 'held_out' }, { ...row, split: 'held_out' }]));
      expect(() => main(['detector', '--cases', file, '--out', path.join(root, 'result.json')])).toThrow(/unique/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
  it('escapes task text and refuses executable task links in session HTML', () => {
    const schedule = { participants: [{ id: 'P' }], phase: 'dry_run', dataOrigin: 'synthetic', timeoutMs: 1000,
      assignments: Array.from({ length: 12 }, (_, i) => ({ participantId: 'P', caseId: `C${i}`, condition: 'pnv_full', period: Math.floor(i / 4) + 1 })) };
    const cases = schedule.assignments.map(row => ({ id: row.caseId, prompt: '</script><img src=x onerror=alert(1)>', reportUrls: { pnv_full: 'report.html' }, rawEvidenceUrl: 'evidence.tsv' }));
    const html = createSessionHtml(schedule, cases, 'P');
    expect(html).not.toContain('</script><img');
    expect(html).toContain('\\u003c/script>');
    expect(() => createSessionHtml(schedule, cases.map(item => ({ ...item, rawEvidenceUrl: 'javascript:alert(1)' })), 'P')).toThrow(/links/);
    expect(() => createSessionHtml(schedule, cases.map(item => ({ ...item, rawEvidenceUrl: ' javascript:alert(1)' })), 'P')).toThrow(/links/);
    expect(() => createSessionHtml(schedule, cases.map(item => ({ ...item, rawEvidenceUrl: 'java\nscript:alert(1)' })), 'P')).toThrow(/links/);
    expect(() => createSessionHtml({ ...schedule, dataOrigin: 'human' }, cases, 'P')).toThrow(/separate training/);
  });
  it('refuses synthetic user effects for manuscript figure export before writing any output', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-study-figure-'));
    try {
      const file = path.join(root, 'synthetic.json');
      fs.writeFileSync(file, JSON.stringify({ status: 'software-smoke-only-not-human-evidence', dataOrigin: 'synthetic', participants: 24, primary: { estimate: -0.1, interval: [-0.2, 0] } }));
      const out = path.join(root, 'figures');
      const result = spawnSync('python3', ['scripts/study/export_figures.py', file, out, '--kind', 'user'], { encoding: 'utf8' });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain('completed main human results');
      expect(fs.existsSync(out)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
