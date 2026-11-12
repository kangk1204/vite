import { describe, expect, it } from 'vitest';
import { applyTestedMembership, enrichmentFromHits } from '../src/lib/evidenceMembership';
import { createUnverifiedEvidence, parseViewerDataJson } from '../src/lib/evidence';
import { prepareViewerDataForReport } from '../src/lib/reportHtml';
import type { ViewerData } from '../src/types';

function fixture(): ViewerData {
  const viewer: ViewerData = {
    project: { projectTitle: 'Case-sensitive membership', contrastName: 'B_vs_A', conditionA: 'A', conditionB: 'B', species: 'human' },
    builtAt: '2026-01-01T00:00:00Z', significantPadjThreshold: 0.05,
    referenceSummary: { reactomePathways: 1, hallmarkPathways: 0, ppiGenes: 5, ppiEdges: 2, hallmarkMode: 'none', stringScoreCutoff: 700 },
    issues: [], rankedGenes: [{ gene: 'TAT', metric: 5 }, { gene: 'SGTA', metric: 4 }, { gene: 'C1ORF10', metric: 3 }, { gene: 'GENE', metric: 2 }, { gene: 'OTHER', metric: -1 }],
    pathways: [{ key: 'Reactome::R1', pathwayId: 'R1', pathwayName: 'Viral tat/vpu source pathway', collection: 'Reactome', nes: -1.3, padj: 0.02,
      leadingEdgeGenes: ['C1ORF10'], allGenes: ['TAT', 'SGTA', 'C1ORF10', 'GENE'], hasReferenceMembership: true, fallbackToLeadingEdge: false, missingGenes: [],
      nodes: ['TAT', 'SGTA', 'C1ORF10', 'GENE'].map(id => ({ id, originalId: id === 'C1ORF10' ? 'C1orf10' : id, label: id, labelPriority: 0,
        log2fc: 1, padj: 0.02, pvalue: 0.01, sizeMetric: 2, conditionAMean: 10, conditionBMean: 20, sampleValues: {}, isLeadingEdge: id === 'C1ORF10' })),
      edges: [{ source: 'TAT', target: 'C1ORF10', score: 900 }, { source: 'GENE', target: 'C1ORF10', score: 800 }],
      enrichment: { points: [], hitIndices: [1, 2, 3, 4], maxAbsValue: 1, representation: 'ranked-hits-v1' },
    }],
  };
  const evidence = createUnverifiedEvidence(viewer);
  evidence.rankedGenes = [{ gene: 'TAT', metric: 5 }, { gene: 'SGTA', metric: 4 }, { gene: 'C1orf10', metric: 3 }, { gene: 'GENE', metric: 2 }, { gene: 'OTHER', metric: -1 }];
  evidence.pathways.R1 = { testedGenes: ['C1orf10', 'GENE'], testedSize: 2, originalEs: -2 / 3, source: { table: 'pathways', row: 1 } };
  evidence.sourceTables = {
    Genes: { columns: ['gene_symbol', 'log2fc', 'padj', 'pvalue', 'condition_a_mean', 'condition_b_mean'], rows: [['TAT', 1, 0.02, 0.01, 10, 20], ['SGTA', 1, 0.02, 0.01, 10, 20], ['C1orf10', 1, 0.02, 0.01, 10, 20], ['GENE', 1, 0.02, 0.01, 10, 20]] },
    pathways: { columns: ['pathway_id', 'leadingEdge'], rows: [['R1', 'C1orf10']] },
  };
  return { ...viewer, schemaVersion: 2, evidence };
}

describe('exact tested pathway membership', () => {
  it('uses exact R membership without converting viral tat/vpu aliases into human hits', () => {
    const source = fixture();
    const result = applyTestedMembership(source);
    const pathway = result.pathways[0];
    expect(pathway.allGenes).toEqual(['C1orf10', 'GENE']);
    expect(pathway.leadingEdgeGenes).toEqual(['C1orf10']);
    expect(pathway.nodes.map(node => node.id)).toEqual(['C1orf10', 'GENE']);
    expect(pathway.edges).toEqual([{ source: 'GENE', target: 'C1orf10', score: 800 }]);
    expect(pathway.enrichment.hitIndices).toEqual([3, 4]);
    expect(pathway.enrichment.es).toBeCloseTo(-2 / 3, 12);
    expect(pathway.enrichment.validation).toBe('matches_recorded_es');
    expect(pathway.nes).toBe(-1.3);
    expect(pathway.padj).toBe(0.02);
    expect(source.pathways[0].allGenes).toContain('TAT');
  });

  it('applies the same exact membership checks on browser JSON import', () => {
    expect(parseViewerDataJson(fixture()).pathways[0].enrichment.hitIndices).toEqual([3, 4]);
  });

  it('supports the documented report-key fallback for evidence lookup', () => {
    const viewer = fixture();
    viewer.evidence!.pathways['Reactome::R1'] = viewer.evidence!.pathways.R1;
    delete viewer.evidence!.pathways.R1;
    expect(applyTestedMembership(viewer).pathways[0].enrichment.validation).toBe('matches_recorded_es');
  });

  it.each(['size', 'missing', 'duplicate', 'leading', 'es'])('rejects contradictory %s evidence', (kind) => {
    const viewer = fixture(), detail = viewer.evidence!.pathways.R1;
    if (kind === 'size') detail.testedSize = 3;
    if (kind === 'missing') detail.testedGenes = ['C1orf10', 'tat'];
    if (kind === 'duplicate') detail.testedGenes = ['C1orf10', 'C1orf10'];
    if (kind === 'leading') viewer.evidence!.sourceTables!.pathways.rows[0][1] = 'TAT';
    if (kind === 'es') detail.originalEs = 0.9;
    expect(() => applyTestedMembership(viewer)).toThrow();
  });

  it('marks legacy reconstruction as unverified instead of asserting exact membership', () => {
    const viewer = fixture();
    delete viewer.evidence!.pathways.R1.testedGenes;
    delete viewer.evidence!.pathways.R1.testedSize;
    delete viewer.evidence!.pathways.R1.originalEs;
    expect(applyTestedMembership(viewer).pathways[0].enrichment.validation).toBe('reconstructed_unverified');
  });

  it('handles zero hit weights and ties using the fgsea standard-score definition', () => {
    expect(enrichmentFromHits([{ gene: 'A', metric: 0 }, { gene: 'B', metric: 0 }, { gene: 'C', metric: 0 }], [2]).es).toBe(0);
    expect(enrichmentFromHits([{ gene: 'A', metric: 1 }], [1]).es).toBeNull();
    expect(enrichmentFromHits([{ gene: 'A', metric: 1 }], []).es).toBeNull();
    expect(() => enrichmentFromHits([{ gene: 'A', metric: 1 }], [2])).toThrow(/indices/);
    expect(() => enrichmentFromHits([{ gene: 'A', metric: 1 }], [1, 1])).toThrow(/indices/);
  });

  it('is idempotent across CLI compaction and browser import with shared edges/expression', () => {
    const viewer = fixture();
    viewer.evidence!.sourceTables!.Genes.columns.push('sample_A1');
    viewer.evidence!.sourceTables!.Genes.rows.forEach(row => row.push(42));
    const prepared = prepareViewerDataForReport(viewer);
    expect(prepared.sampleValuesByGene?.C1orf10.sample_A1).toBe(42);
    expect(prepareViewerDataForReport(prepared)).toEqual(prepared);
    const imported = parseViewerDataJson(JSON.parse(JSON.stringify(prepared)));
    expect(imported.pathways[0].nodes[0].sampleValues.sample_A1).toBe(42);
    expect(imported.pathways[0].edges).toEqual([{ source: 'GENE', target: 'C1orf10', score: 800 }]);
  });

  it('preserves unavailable original ES and does not manufacture a measured score', () => {
    const viewer = fixture();
    viewer.evidence!.pathways.R1.originalEs = null;
    expect(applyTestedMembership(viewer).pathways[0].enrichment).toMatchObject({ es: null, validation: 'unavailable' });
  });

  it('does not reuse legacy hit indices against a different exact rank universe', () => {
    const viewer = fixture();
    viewer.pathways.push({ ...viewer.pathways[0], key: 'Reactome::R2', pathwayId: 'R2' });
    expect(applyTestedMembership(viewer).pathways[1].enrichment).toMatchObject({ es: null, hitIndices: [], validation: 'unavailable' });
  });

  it.each(['ranking_missing', 'ranking_duplicate', 'ranking_invalid', 'source_id_column', 'source_duplicate', 'source_row', 'source_probability', 'missing_gene'])('rejects invalid exact source %s', (kind) => {
    const viewer = fixture();
    if (kind === 'ranking_missing') delete viewer.evidence!.rankedGenes;
    if (kind === 'ranking_duplicate') viewer.evidence!.rankedGenes!.push(viewer.evidence!.rankedGenes![0]);
    if (kind === 'ranking_invalid') viewer.evidence!.rankedGenes![0].metric = NaN;
    if (kind === 'source_id_column') viewer.evidence!.sourceTables!.Genes.columns[0] = 'unknown';
    if (kind === 'source_duplicate') viewer.evidence!.sourceTables!.Genes.rows.push(viewer.evidence!.sourceTables!.Genes.rows[0]);
    if (kind === 'source_row') viewer.evidence!.pathways.R1.source!.row = 100;
    if (kind === 'source_probability') viewer.evidence!.sourceTables!.Genes.rows[0][2] = -0.1;
    if (kind === 'missing_gene') {
      viewer.evidence!.pathways.R1.testedGenes = ['C1orf10', 'OTHER'];
      viewer.evidence!.pathways.R1.originalEs = null;
    }
    expect(() => applyTestedMembership(viewer)).toThrow();
  });

  it('can use already exact node records when original source tables are absent', () => {
    const viewer = applyTestedMembership(fixture());
    delete viewer.evidence!.sourceTables;
    expect(applyTestedMembership(viewer).pathways[0].enrichment.es).toBeCloseTo(-2 / 3, 12);
  });
});
