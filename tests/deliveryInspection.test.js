import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { describeArtifact } from '../scripts/lib/provenance.mjs';
import { inspectDelivery, createDeliveryInspection, analysisRecordFromViewer, inspectDeliveryFiles } from '../scripts/lib/delivery_inspection.mjs';

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-delivery-'));
  roots.push(root);
  const artifacts = ['raw_counts', 'sample_metadata', 'analysis_code', 'reference', 'environment'].map(role => {
    fs.writeFileSync(path.join(root, `${role}.txt`), role);
    return describeArtifact(role, `${role}.txt`, { root });
  });
  const request = { schemaVersion: 1, claims: { conditionA: 'Control', conditionB: 'Case', sampleCountA: '2' }, artifacts, additionalRecords: [] };
  const record = { conditionA: 'Control', conditionB: 'Case', sampleCountA: 2 };
  return { root, request, record };
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('public delivery inspection', () => {
  it('derives normal, mismatch and unknown from supplied bytes and declared fields', () => {
    const { root, request, record } = fixture();
    expect(inspectDelivery(request, record, root).predicted).toBe('normal');
    expect(inspectDelivery({ ...request, claims: { conditionB: 'Other' } }, record, root)).toMatchObject({ predicted: 'mismatch' });
    fs.unlinkSync(path.join(root, 'raw_counts.txt'));
    expect(inspectDelivery(request, record, root).predicted).toBe('unverifiable');
    fs.writeFileSync(path.join(root, 'raw_counts.txt'), 'replacement');
    const result = inspectDelivery(request, record, root);
    expect(result.predicted).toBe('mismatch');
    expect(result.files[0].suppliedSha256).not.toBe(request.artifacts[0].sha256);
  });

  it('rejects invalid requests, unsafe paths and undeclared claim fields', () => {
    const { root, request, record } = fixture();
    expect(() => inspectDelivery({ ...request, predicted: 'normal' }, record, root)).toThrow(/unsupported/i);
    expect(() => inspectDelivery({ ...request, claims: { truth: 'normal' } }, record, root)).toThrow(/claim/i);
    expect(() => inspectDelivery({ ...request, artifacts: [{ ...request.artifacts[0], path: '../secret' }] }, record, root)).toThrow(/path|escape/i);
    expect(() => inspectDelivery({ ...request, additionalRecords: [{ name: 'Record', path: 'https://example.com/a' }] }, record, root)).toThrow(/relative/i);
    expect(() => inspectDelivery({ ...request, claims: { sampleCountA: -1 } }, record, root)).toThrow(/integer/i);
    fs.symlinkSync(os.tmpdir(), path.join(root, 'outside'));
    expect(() => inspectDelivery({ ...request, artifacts: [{ ...request.artifacts[0], path: 'outside/record' }] }, record, root)).toThrow(/escape|outside/i);
  });

  it('records document availability without treating directories or empty files as records', () => {
    const { root, request, record } = fixture();
    fs.mkdirSync(path.join(root, 'document'));
    const withDocument = { ...request, additionalRecords: [{ name: 'Independent record', path: 'document' }] };
    expect(inspectDelivery(withDocument, record, root).predicted).toBe('unverifiable');
    fs.rmSync(path.join(root, 'document'), { recursive: true });
    fs.writeFileSync(path.join(root, 'document'), '');
    expect(inspectDelivery(withDocument, record, root).documents[0].available).toBe(false);
    fs.writeFileSync(path.join(root, 'document'), 'provided document');
    expect(inspectDelivery(withDocument, record, root).documents[0]).toMatchObject({ available: true, sizeBytes: 17 });
  });

  it('builds a fresh product envelope and derives actual fields from viewer metadata', () => {
    const { root, request, record } = fixture();
    const envelope = createDeliveryInspection(request, record, { root, checkedAt: '2026-11-16T00:00:00Z' });
    expect(envelope).toMatchObject({ schemaVersion: 1, checker: 'pnv-delivery-v1', verificationMode: 'supplied-files', result: { predicted: 'normal' } });
    const viewer = { project: { conditionA: 'Control', conditionB: 'Case' }, provenance: { datasetIdentifier: 'GSE1' }, evidence: { analysis: { designFormula: '~ group', pathwayHypothesisCount: 42, lfcMethod: 'apeglm' }, pathways: { P1: { testedSize: 15 } } }, samplesById: { a: { groupKey: 'A' }, b: { groupKey: 'B' } } };
    expect(analysisRecordFromViewer(viewer, { targetPathwayId: 'P1' })).toMatchObject({ conditionA: 'Control', conditionB: 'Case', sampleCountA: 1, sampleCountB: 1, testedSize: 15, pathwayHypothesisCount: 42 });
    expect(analysisRecordFromViewer({ project: viewer.project, evidence: { analysis: {} } }).sampleCountA).toBeNull();
    const aliases = { ...viewer, samplesById: { a: { groupKey: 'A' }, sample_a: { groupKey: 'A' }, b: { groupKey: 'B' }, sample_b: { groupKey: 'B' } }, evidence: { ...viewer.evidence, sourceTables: { Samples: { columns: ['sample_id', 'group'], rows: [['a', 'A'], ['b', 'B']] } } } };
    expect(analysisRecordFromViewer(aliases)).toMatchObject({ sampleCountA: 1, sampleCountB: 1 });
  });

  it('compares a supplied analysis record against the report actually being built', () => {
    const { root, request } = fixture();
    const handoff = path.join(root, 'handoff.json');
    const recordFile = path.join(root, 'record.json');
    fs.writeFileSync(handoff, JSON.stringify(request));
    fs.writeFileSync(recordFile, JSON.stringify({ schemaVersion: 1, analysisRecord: { conditionA: 'Control', conditionB: 'Incorrect', sampleCountA: 2 } }));
    const actual = { conditionA: 'Control', conditionB: 'Case', sampleCountA: 2 };
    const envelope = inspectDeliveryFiles({ handoffPath: handoff, analysisRecordPath: recordFile, observed: actual });
    expect(envelope.result.predicted).toBe('mismatch');
    expect(envelope.result.checks.some(check => check.id === 'analysis-record:conditionB' && check.status === 'fail')).toBe(true);
    expect(envelope.sources.map(source => source.role)).toContain('analysis_record');
    fs.writeFileSync(recordFile, JSON.stringify({ schemaVersion: 1, analysisRecord: { ...actual, testedSize: null } }));
    expect(inspectDeliveryFiles({ handoffPath: handoff, analysisRecordPath: recordFile, observed: actual }).result.predicted).toBe('normal');
  });
});
