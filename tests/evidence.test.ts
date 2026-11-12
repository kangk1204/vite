import { describe, expect, it } from 'vitest';
import { adaptViewerData, parseEvidenceSidecar, parseViewerDataJson } from '../src/lib/evidence';
import type { ViewerData } from '../src/types';

const legacy = (): ViewerData => ({
  project: { projectTitle: 'External study', contrastName: 'B_vs_A', conditionA: 'A', conditionB: 'B', species: 'human' },
  builtAt: '2026-01-01T00:00:00Z', significantPadjThreshold: 0.05,
  referenceSummary: { reactomePathways: 0, hallmarkPathways: 0, ppiGenes: 0, ppiEdges: 0, hallmarkMode: 'stub', stringScoreCutoff: 700 },
  issues: [], pathways: [],
});

function completeViewer(): ViewerData {
  return {
    ...legacy(), provenance: { datasetIdentifier: 'GSE_TEST' },
    samplesById: { S1: { id: 'S1', groupKey: 'A', batch: 'B1' } },
    pathways: [{ key: 'Reactome::R1', pathwayId: 'R1', pathwayName: 'Test pathway', collection: 'Reactome',
      nes: null, padj: null, source: { table: 'Pathways', row: 1 }, leadingEdgeGenes: ['TP53'], allGenes: ['TP53'], missingGenes: [],
      hasReferenceMembership: true, fallbackToLeadingEdge: false,
      nodes: [{ id: 'TP53', label: 'TP53', labelPriority: 0, log2fc: null, padj: null, pvalue: null, sizeMetric: 0,
        conditionAMean: 2, conditionBMean: 2, sampleValues: { S1: 2 }, isLeadingEdge: true }],
      edges: [{ source: 'TP53', target: 'MDM2', score: 800 }],
      enrichment: { points: [{ index: 0, value: 0, gene: 'TP53' }], hitIndices: [0], maxAbsValue: 0 },
    }],
  };
}

function completeEvidence() {
  const evidence = adaptViewerData(legacy()).evidence!;
  evidence.runId = 'run-1'; evidence.analysis.versions = { DESeq2: '1.50.2' };
  evidence.analysis.alpha = 0.05; evidence.analysis.seed = 123;
  evidence.verification = { status: 'internally_consistent', checks: [{ id: 'schema', status: 'pass', message: 'Valid structure' }], limitations: [] };
  evidence.artifacts = [{ role: 'workbook', path: 'result.xlsx', sha256: 'a'.repeat(64), sizeBytes: 100 }];
  evidence.pathways.R1 = { source: { table: 'Pathways', row: 1 }, camera: { pvalue: 0.1, padj: 0.2, direction: 'Up' },
    bootstrap: { requested: 500, valid: 400, selected: 200, directionMatches: 300, selectionFrequency: 0.5, directionConsistency: 0.75, validFraction: 0.8, warning: 'Incomplete fits' } };
  evidence.sourceTables = { Pathways: { columns: ['id', 'NES'], rows: [['R1', null]] } };
  return evidence;
}

describe('report evidence contract', () => {
  it('adapts legacy results without inventing the original method or provenance', () => {
    const source = legacy();
    const adapted = adaptViewerData(source);
    expect(adapted.schemaVersion).toBe(2);
    expect(adapted.evidence?.analysis.method).toBe('external');
    expect(adapted.evidence?.analysis.seed).toBeNull();
    expect(adapted.evidence?.verification.status).toBe('unverifiable');
    expect(source).not.toHaveProperty('schemaVersion');
  });

  it('does not trust an imported claim of supplied-artifact verification', () => {
    const evidence = adaptViewerData(legacy()).evidence!;
    evidence.verification.status = 'verified_against_supplied_artifacts';
    const parsed = parseEvidenceSidecar({ schemaVersion: 2, evidence });
    expect(parsed.verification.status).toBe('unverifiable');
    expect(parsed.verification.limitations.join(' ')).toMatch(/not.*rechecked/i);
  });

  it('rejects malformed v2 evidence and impossible bootstrap denominators', () => {
    expect(() => parseEvidenceSidecar({ schemaVersion: 2, evidence: {} })).toThrow(/analysis/);
    const evidence = adaptViewerData(legacy()).evidence!;
    evidence.pathways.R1 = { bootstrap: { requested: 500, valid: 450, selected: 480, directionMatches: 400, selectionFrequency: 0.96, directionConsistency: 0.8, validFraction: 0.9, warning: null } };
    expect(() => parseEvidenceSidecar({ schemaVersion: 2, evidence })).toThrow(/selected/);
  });

  it('retains the full raw evidence for both presentation conditions', () => {
    const source = adaptViewerData(legacy());
    source.evidence!.sourceTables = { statistics: { columns: ['gene', 'padj'], rows: [['TP53', null]] } };
    const basic = adaptViewerData({ ...source, reportCondition: 'basic' });
    expect(basic.evidence?.sourceTables).toEqual(source.evidence?.sourceTables);
    expect(basic.reportCondition).toBe('basic');
  });

  it('rejects source-table width mismatches, unsafe keys, and out-of-range probabilities', () => {
    const evidence = adaptViewerData(legacy()).evidence!;
    evidence.sourceTables = { stats: { columns: ['gene'], rows: [['TP53', 0.5]] } };
    expect(() => parseEvidenceSidecar({ schemaVersion: 2, evidence })).toThrow(/width/);
    const unsafe = JSON.parse(JSON.stringify(adaptViewerData(legacy()).evidence));
    unsafe.pathways = JSON.parse('{"__proto__":{}}');
    expect(() => parseEvidenceSidecar({ schemaVersion: 2, evidence: unsafe })).toThrow(/key/);
    const invalid = adaptViewerData(legacy()).evidence!;
    invalid.pathways.R1 = { camera: { pvalue: -0.1, padj: 0.1, direction: 'Up' } };
    expect(() => parseEvidenceSidecar({ schemaVersion: 2, evidence: invalid })).toThrow(/pvalue/);
  });

  it('accepts complete evidence while retaining null direction for untestable baselines', () => {
    const evidence = completeEvidence();
    expect(parseEvidenceSidecar({ schemaVersion: 2, evidence })).toEqual(evidence);
    evidence.pathways.R1.bootstrap!.directionMatches = null;
    evidence.pathways.R1.bootstrap!.directionConsistency = null;
    expect(parseEvidenceSidecar({ schemaVersion: 2, evidence }).pathways.R1.bootstrap?.directionConsistency).toBeNull();
    evidence.pathways.R1.bootstrap = { requested: 0, valid: 0, selected: 0, directionMatches: null, selectionFrequency: null, directionConsistency: null, validFraction: 0, warning: null };
    expect(parseEvidenceSidecar({ schemaVersion: 2, evidence }).pathways.R1.bootstrap?.valid).toBe(0);
  });

  it('retains explicit failures even when an import claims consistency', () => {
    const evidence = completeEvidence();
    evidence.verification.checks[0].status = 'fail';
    expect(parseEvidenceSidecar({ schemaVersion: 2, evidence }).verification.status).toBe('mismatch');
  });

  it.each([
    ['analysis.method', 2], ['analysis.versions', []], ['analysis.versions.DESeq2', 4], ['analysis.seed', -1],
    ['analysis.alpha', 1.2], ['analysis.geneHypothesisCount', 1.1], ['verification.status', 'trusted'],
    ['verification.checks', {}], ['verification.checks.0.status', 'trusted'], ['verification.checks.0.message', 2],
    ['verification.limitations', [2]], ['artifacts.0.sha256', 'abc'], ['artifacts.0.sizeBytes', null],
    ['artifacts.0.path', 1], ['pathways.R1.source.row', 0], ['pathways.R1.camera.direction', 3],
    ['pathways.R1.bootstrap.requested', null], ['pathways.R1.bootstrap.valid', 501],
    ['pathways.R1.bootstrap.directionMatches', 401], ['pathways.R1.bootstrap.selectionFrequency', 0.9],
    ['pathways.R1.bootstrap.directionConsistency', 0.5], ['pathways.R1.bootstrap.validFraction', 0.5],
    ['sourceTables.Pathways.rows', [[{}]]], ['sourceTables.Pathways.rows', [['R1', {}]]],
  ])('rejects invalid evidence field %s', (field, value) => {
    const evidence: any = completeEvidence();
    const segments = field.split('.');
    const target = segments.slice(0, -1).reduce((object, key) => object[key], evidence);
    target[segments.at(-1)!] = value;
    expect(() => parseEvidenceSidecar({ schemaVersion: 2, evidence })).toThrow();
  });

  it('validates the viewer at the import boundary and downgrades supplied-artifact claims', () => {
    const source = completeViewer();
    const restored = parseViewerDataJson(JSON.parse(JSON.stringify(source)));
    expect(restored.pathways[0].nodes[0].padj).toBeNull();
    expect(restored.schemaVersion).toBe(2);
    const evidence = completeEvidence();
    evidence.verification.status = 'verified_against_supplied_artifacts';
    const imported = parseViewerDataJson({ ...source, schemaVersion: 2, evidence, reportCondition: 'basic' });
    expect(imported.evidence?.verification.status).toBe('unverifiable');
    expect(imported.reportCondition).toBe('basic');
  });

  it('detects a contrast contradiction instead of silently changing the original labels', () => {
    const evidence = completeEvidence();
    evidence.analysis.contrast.conditionA = 'Other';
    const result = parseViewerDataJson({ ...completeViewer(), schemaVersion: 2, evidence });
    expect(result.project.conditionA).toBe('A');
    expect(result.evidence?.verification.status).toBe('mismatch');
  });

  it.each([
    ['schemaVersion', 3], ['project', null], ['project.conditionA', 1], ['builtAt', 1], ['reportCondition', 'hidden'],
    ['significantPadjThreshold', null], ['referenceSummary.ppiEdges', null], ['issues', [{ level: 'fatal', message: 'no' }]],
    ['provenance', { method: 1 }], ['samplesById.S1.groupKey', 'C'], ['pathways.0.nes', '1'], ['pathways.0.padj', -1],
    ['pathways.0.leadingEdgeGenes', [1]], ['pathways.0.hasReferenceMembership', null], ['pathways.0.source.row', null],
    ['pathways.0.nodes.0.padj', 2], ['pathways.0.nodes.0.labelPriority', null], ['pathways.0.nodes.0.isLeadingEdge', 1],
    ['pathways.0.nodes.0.sampleValues.S1', null], ['pathways.0.edges.0.score', null], ['pathways.0.edges.0.score', -1],
    ['pathways.0.enrichment.maxAbsValue', -1], ['pathways.0.enrichment.points.0.value', null], ['pathways.0.enrichment.hitIndices', [null]],
  ])('rejects unsafe or malformed viewer field %s', (field, value) => {
    const source: any = completeViewer();
    const segments = field.split('.');
    const target = segments.slice(0, -1).reduce((object, key) => object[key], source);
    target[segments.at(-1)!] = value;
    expect(() => parseViewerDataJson(source)).toThrow();
  });

  it('rejects duplicate pathway keys and missing v2 evidence', () => {
    const source = completeViewer();
    expect(() => parseViewerDataJson({ ...source, pathways: [...source.pathways, ...source.pathways] })).toThrow(/Duplicate/);
    expect(() => parseViewerDataJson({ ...source, schemaVersion: 2 })).toThrow(/evidence/);
    expect(() => parseEvidenceSidecar({ schemaVersion: 1, evidence: completeEvidence() })).toThrow(/schemaVersion/);
    expect(() => parseViewerDataJson(null)).toThrow(/object/);
  });

  it('validates shared ranked values, expression and edge references without expanding duplicates', () => {
    const source = completeViewer();
    source.rankedGenes = [{ gene: 'TP53', metric: 2 }];
    source.sampleValuesByGene = { TP53: { S1: 2 } };
    source.sharedEdges = source.pathways[0].edges;
    source.pathways[0].edges = [];
    source.pathways[0].edgeIndices = [0];
    source.pathways[0].nodes[0].sampleValues = {};
    source.pathways[0].enrichment = { representation: 'ranked-hits-v1', points: [], hitIndices: [1], maxAbsValue: 1 };
    expect(parseViewerDataJson(source).rankedGenes).toEqual(source.rankedGenes);
    const variants = [
      { ...source, rankedGenes: undefined },
      { ...source, rankedGenes: [{ gene: 'TP53', metric: null }] },
      { ...source, rankedGenes: [...source.rankedGenes, ...source.rankedGenes] },
      { ...source, sampleValuesByGene: { TP53: { S1: null } } },
      { ...source, sharedEdges: [] },
    ];
    for (const invalid of variants) expect(() => parseViewerDataJson(invalid)).toThrow();
    source.pathways[0].enrichment.hitIndices = [2];
    expect(() => parseViewerDataJson(source)).toThrow(/ranked universe/);
    source.pathways[0].enrichment.representation = 'unknown' as never;
    expect(() => parseViewerDataJson(source)).toThrow(/representation/);
  });

  it('rejects source-row markup before the runtime ever renders it', () => {
    const source = completeViewer();
    source.pathways[0].source = { table: 'Pathways', row: '<img src=x onerror=alert(1)>' as never };
    expect(() => parseViewerDataJson(source)).toThrow(/source.row/);
  });

  it('keeps design sensitivity separate and rejects malformed adjusted probabilities', () => {
    const evidence = completeEvidence();
    evidence.pathways.R1.designSensitivity = [{ designFormula: '~ group', nes: -1.2, padj: null, source: { table: 'group_only_pathways', row: 1 } }];
    expect(parseEvidenceSidecar({ schemaVersion: 2, evidence }).pathways.R1.designSensitivity?.[0].nes).toBe(-1.2);
    evidence.pathways.R1.designSensitivity[0].padj = 1.2;
    expect(() => parseEvidenceSidecar({ schemaVersion: 2, evidence })).toThrow(/padj/);
  });
});
