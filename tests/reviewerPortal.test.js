import { describe, expect, it } from 'vitest';
import { checkFigureExample, extractExample, compactViewer, renderSourceRows } from '../scripts/lib/reviewer_example.mjs';

const id = 'R-HSA-449147';
const pathway = { pathway_id: id, pathway_name: 'Signaling by Interleukins', NES: '2.312', padj: '2.6475e-16', size: '390' };
const camera = { pathway: `${id} :: Signaling by Interleukins`, direction: 'Up', pvalue: '0.07', padj: '0.833' };
const bootstrap = { requested: 500, valid: 500, selected: 473, directionMatches: 498, selectionFrequency: 0.946, directionConsistency: 0.996 };
const fixture = () => ({
  primaryRows: [{ ...pathway, pathway_id: 'another' }, pathway], cameraRows: [camera],
  evidence: { analysis: { pathwayHypothesisCount: 2, alpha: 0.05 }, runId: 'a'.repeat(64),
    verification: { status: 'verified_against_supplied_artifacts' },
    pathways: { [id]: { source: { table: 'pathways', row: 2 }, camera: { direction: 'Up', pvalue: 0.07, padj: 0.833 }, bootstrap } },
    sourceTables: { pathways: { columns: Object.keys(pathway), rows: [Object.values({ ...pathway, pathway_id: 'another' }), Object.values(pathway)] },
      camera: { columns: Object.keys(camera), rows: [Object.values(camera)] } } },
});

describe('public reviewer example', () => {
  it('links explicit one-based rows and preserves the exact primary and alternative statistics', () => {
    const example = extractExample(fixture());
    expect(example.primary.row).toBe(2);
    expect(example.camera.row).toBe(1);
    expect(example.primary.values.padj).toBe('2.6475e-16');
    expect(example.bootstrap.selected).toBe(473);
    expect(example.camera.values.direction).toBe('Up');
  });

  it('refuses a source-row drift, changed CAMERA FDR, missing statistics, and impossible resampling counts', () => {
    for (const alter of [
      f => { f.evidence.pathways[id].source.row = 1; },
      f => { f.evidence.pathways[id].camera.padj = 0.05; },
      f => { f.primaryRows = f.primaryRows.map(row => ({ ...row, padj: '' })); },
      f => { f.evidence.pathways[id].bootstrap = { ...bootstrap, valid: 470 }; },
    ]) {
      const f = fixture(); alter(f);
      expect(() => extractExample(f)).toThrow();
    }
  });

  it('keeps the full rank universe for the enrichment curve and remaps the selected network edges', () => {
    const f = fixture();
    const input = { project: { projectTitle: 'PD' }, rankedGenes: [{ gene: 'A', metric: 1 }, { gene: 'B', metric: 0 }],
      sampleValuesByGene: { A: { S1: 2 }, B: { S1: 3 } }, sharedEdges: [{ source: 'X', target: 'Y' }, { source: 'A', target: 'A' }],
      pathways: [{ pathwayId: id, nodes: [{ id: 'A' }], edges: [], edgeIndices: [1] }, { pathwayId: 'other' }], evidence: f.evidence };
    const compact = compactViewer(input, id);
    expect(compact.pathways).toHaveLength(1);
    expect(compact.rankedGenes).toEqual(input.rankedGenes);
    expect(compact.evidence.rankedGenes).toEqual(input.rankedGenes);
    expect(compact.sampleValuesByGene).toEqual({ A: { S1: 2 } });
    expect(compact.sharedEdges).toEqual([input.sharedEdges[1]]);
    expect(compact.pathways[0].edgeIndices).toEqual([0]);
    expect(compact.evidence.analysis.pathwayHypothesisCount).toBe(2);
    expect(compact.evidence.verification.status).toBe('internally_consistent');
    expect(input.evidence.verification.status).toBe('verified_against_supplied_artifacts');
  });

  it('escapes values when rendering a recorded source row', () => {
    const html = renderSourceRows({ pathway_id: '<script>alert(1)</script>', NES: '2' });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('detects a figure/source discrepancy even for very small adjusted P-values', () => {
    const e = extractExample(fixture());
    const row = { pathway_id: id, original_fdr: e.primary.values.padj, primary_nes: e.primary.values.NES,
      source_row: 2, camera_row: 1, camera_fdr: e.camera.values.padj, camera_direction: 'Up',
      valid: 500, requested: 500, selected: 473, direction_matches: 498, selection_frequency: 0.946 };
    expect(() => checkFigureExample([row], e)).not.toThrow();
    expect(() => checkFigureExample([{ ...row, original_fdr: '2e-17' }], e)).toThrow(/original_fdr/);
    expect(() => checkFigureExample([{ ...row, selected: 474 }], e)).toThrow(/selected/);
  });
});
