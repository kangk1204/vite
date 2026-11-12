// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import XLSX from 'xlsx';
import { buildReport, parseCliArgs } from '../scripts/build_report_from_workbook.mjs';
import { describeArtifact } from '../scripts/lib/provenance.mjs';

const roots = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-report-contract-'));
  roots.push(root);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ project_title: 'CLI study', contrast_name: 'B_vs_A', condition_a: 'A', condition_b: 'B', species: 'human' }]), 'Project');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ gene_symbol: 'TP53', log2fc: null, padj: null, pvalue: null, rank_metric: null, condition_a_mean: 1, condition_b_mean: 1, missing_reason: 'not_estimable' }]), 'Genes');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ pathway_id: 'R1', pathway_name: 'Unknown pathway', collection: 'Custom', nes: null, padj: null, leading_edge_genes: 'TP53', missing_reason: 'no_rank_variation' }]), 'Pathways');
  const input = path.join(root, 'input.xlsx');
  fs.writeFileSync(input, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
  const evidence = {
    runId: 'test-run', analysis: { method: 'external', versions: {}, contrast: { conditionA: 'A', conditionB: 'B' }, designFormula: null, seed: null, alpha: 0.05, geneHypothesisCount: 1, pathwayHypothesisCount: 1, filterRule: null, rankMetric: null, lfcMethod: null, adjustment: null },
    verification: { status: 'verified_against_supplied_artifacts', checks: [], limitations: [] },
    artifacts: [describeArtifact('workbook', 'input.xlsx', { root })], pathways: {},
  };
  const sidecar = path.join(root, 'evidence.json');
  fs.writeFileSync(sidecar, JSON.stringify({ schemaVersion: 2, evidence }));
  return { root, input, sidecar, evidence };
}

describe('canonical report CLI', () => {
  it('validates options before execution', () => {
    expect(parseCliArgs(['x.xlsx', 'r.html', '--condition', 'basic']).options.condition).toBe('basic');
    expect(() => parseCliArgs(['--condition', 'unknown'])).toThrow(/condition/);
    expect(() => parseCliArgs(['--trust-evidence', 'yes'])).toThrow(/Unknown/);
    expect(() => parseCliArgs(['--evidence'])).toThrow(/Missing/);
    expect(() => parseCliArgs(['a', 'b', 'c'])).toThrow(/Expected/);
  });

  it('never overwrites an input or its evidence sidecar', async () => {
    const { input, sidecar, root } = fixture();
    await expect(buildReport(input, input)).rejects.toThrow(/overwrite/);
    await expect(buildReport(input, sidecar, { evidence: sidecar })).rejects.toThrow(/evidence sidecar/);
    await expect(buildReport(input, path.join(root, 'report.html'), { evidence: sidecar, 'viewer-json': sidecar })).rejects.toThrow(/evidence sidecar/);
  });

  it('uses the canonical nullable parser and refuses to trust claimed source verification', async () => {
    const { input, sidecar, root } = fixture();
    const output = path.join(root, 'report.html'), json = path.join(root, 'viewer.json');
    const result = await buildReport(input, output, { evidence: sidecar, 'viewer-json': json, condition: 'basic' });
    expect(result.viewerData.evidence.verification.status).toBe('internally_consistent');
    expect(result.viewerData.pathways[0].padj).toBeNull();
    expect(result.viewerData.pathways[0].statisticsReason).toBe('no_rank_variation');
    expect(result.viewerData.pathways[0].nodes[0].statisticsReason).toBe('not_estimable');
    expect(result.viewerData.reportCondition).toBe('basic');
    expect(JSON.parse(fs.readFileSync(json, 'utf8')).schemaVersion).toBe(2);
    expect(fs.readFileSync(output, 'utf8').includes('window.__PNV_DATA__')).toBe(true);
  }, 30000);

  it('flags evidence attached to a different workbook', async () => {
    const { input, sidecar, root, evidence } = fixture();
    evidence.artifacts[0].sha256 = '0'.repeat(64);
    fs.writeFileSync(sidecar, JSON.stringify({ schemaVersion: 2, evidence }));
    const result = await buildReport(input, path.join(root, 'report.html'), { evidence: sidecar });
    expect(result.viewerData.evidence.verification.status).toBe('mismatch');
    expect(result.viewerData.evidence.verification.checks.some(check => check.id === 'rendered_input' && check.status === 'fail')).toBe(true);
  }, 30000);

  it('builds two reports concurrently without opening a network listener or logging WebSocket errors', async () => {
    const inputs = [fixture(), fixture()];
    const listen = vi.spyOn(net.Server.prototype, 'listen');
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const results = await Promise.all(inputs.map(({ input, sidecar, root }) =>
        buildReport(input, path.join(root, 'report.html'), { evidence: sidecar }),
      ));
      expect(results.map(result => result.viewerData.pathways.length)).toEqual([1, 1]);
      expect(listen).not.toHaveBeenCalled();
      expect(errors.mock.calls.flat().some(value => /WebSocket server error|EADDRINUSE/.test(String(value)))).toBe(false);
    } finally {
      listen.mockRestore();
      errors.mockRestore();
    }
  }, 30000);
});
