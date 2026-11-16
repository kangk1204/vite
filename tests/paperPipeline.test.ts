import { describe, expect, it } from 'vitest';
import {
  computeReplicationMetrics,
  splitLeadingEdge,
  toNumber,
  toTsv,
} from '../scripts/lib/paper_pipeline.mjs';

describe('computeReplicationMetrics', () => {
  it('reports overlap, direction consistency, and leading-edge Jaccard', () => {
    const primaryRows = [
      {
        pathway_id: 'R-HSA-1',
        pathway_name: 'Interferon Signaling',
        nes: '2.4',
        padj: '0.001',
        leading_edge_genes: 'IFI27;STAT1;IRF7',
      },
      {
        pathway_id: 'R-HSA-2',
        pathway_name: 'ECM Organization',
        nes: '-2.1',
        padj: '0.004',
        leading_edge_genes: 'COL1A1;COL1A2',
      },
    ];
    const cohortRows = [
      {
        pathway_id: 'R-HSA-1',
        pathway_name: 'Interferon Signaling',
        nes: '2.0',
        padj: '0.02',
        leading_edge_genes: 'IFI27;STAT1;CXCL10',
      },
      {
        pathway_id: 'R-HSA-2',
        pathway_name: 'ECM Organization',
        nes: '1.5',
        padj: '0.03',
        leading_edge_genes: 'COL1A1;FN1',
      },
    ];

    const metrics = computeReplicationMetrics(primaryRows, cohortRows);

    expect(metrics.significantPathwaysPrimary).toBe(2);
    expect(metrics.significantPathwaysCohort).toBe(2);
    expect(metrics.sharedSignificantPathways).toBe(2);
    expect(metrics.directionConsistency).toBe(0.5);
    expect(Number(metrics.leadingEdgeOverlapScore.toFixed(4))).toBe(0.4167);
    expect(metrics.overlapRows).toHaveLength(2);
  });

  it('requires significance in both primary and comparison cohorts for shared pathways', () => {
    const metrics = computeReplicationMetrics(
      [
        {
          pathway_id: 'R-HSA-1',
          pathway_name: 'Primary nonsignificant',
          nes: '1.5',
          padj: '0.2',
          leading_edge_genes: 'A;B',
        },
      ],
      [
        {
          pathway_id: 'R-HSA-1',
          pathway_name: 'Comparison significant',
          nes: '1.2',
          padj: '0.01',
          leading_edge_genes: 'A;C',
        },
      ],
    );

    expect(metrics.significantPathwaysPrimary).toBe(0);
    expect(metrics.significantPathwaysCohort).toBe(1);
    expect(metrics.sharedSignificantPathways).toBe(0);
    expect(metrics.directionConsistency).toBeNull();
    expect(metrics.leadingEdgeOverlapScore).toBeNull();
    expect(metrics.overlapRows).toEqual([]);
  });

  it('sanitizes embedded tabs and newlines when serializing TSV rows', () => {
    expect(toTsv([{ field: 'alpha\tbeta\ncharlie', value: 1 }])).toBe('field\tvalue\nalpha beta charlie\t1\n');
  });

  it('deduplicates uppercase leading-edge genes across supported delimiters', () => {
    expect(splitLeadingEdge('A; b,C|a')).toEqual(['A', 'B', 'C']);
  });

  it.each([undefined, null, '', ' ', 'NA', 'NaN', 'N/A', Number.NaN, Infinity, false, true, [], {}])(
    'does not interpret a missing or nonnumeric value as zero (%j)', (value) => {
      expect(Number.isNaN(toNumber(value))).toBe(true);
    },
  );

  it.each([undefined, null, '', ' ', 'NA', 'NaN', Number.NaN, -0.1, 1.1])(
    'never counts invalid adjusted p-values as significant (%j)', (padj) => {
      const row = { pathway_id: 'R1', padj, nes: 1, leading_edge_genes: 'A;B' };
      const metrics = computeReplicationMetrics([row], [row]);
      expect(metrics.significantPathwaysPrimary).toBe(0);
      expect(metrics.significantPathwaysCohort).toBe(0);
      expect(metrics.sharedSignificantPathways).toBe(0);
      expect(metrics.directionConsistency).toBeNull();
    },
  );

  it('preserves genuine numeric zero and finite scientific notation', () => {
    expect(toNumber(0)).toBe(0);
    expect(toNumber('0')).toBe(0);
    expect(toNumber(' 1e-5 ')).toBe(0.00001);
    const metrics = computeReplicationMetrics([{ pathway_id: 'R1', padj: 0, nes: 2 }], [{ pathway_id: 'R1', padj: '0', nes: -2 }]);
    expect(metrics.sharedSignificantPathways).toBe(1);
    expect(metrics.directionConsistency).toBe(0);
  });

  it('uses only finite nonzero NES pairs as the direction denominator', () => {
    const primary = [
      { pathway_id: 'R1', padj: 0.01, NES: null },
      { pathway_id: 'R2', padj: 0.01, NES: 2 },
      { pathway_id: 'R3', padj: 0.01, NES: 0 },
    ];
    const cohort = [
      { pathway_id: 'R1', padj: 0.01, NES: '' },
      { pathway_id: 'R2', padj: 0.01, NES: 1 },
      { pathway_id: 'R3', padj: 0.01, NES: 0 },
    ];
    const metrics = computeReplicationMetrics(primary, cohort);
    expect(metrics.sharedSignificantPathways).toBe(3);
    expect(metrics.directionComparablePathways).toBe(1);
    expect(metrics.directionConsistency).toBe(1);
    expect(metrics.overlapRows[0].primary_nes).toBeNull();
    expect(metrics.overlapRows[0].same_direction).toBe('not_evaluable');
    expect(metrics.overlapRows[2].same_direction).toBe('not_evaluable');
  });

  it('does not equate absent leading-edge lists with zero overlap', () => {
    const primary = [
      { pathway_id: 'R1', padj: 0.01, NES: 1, leadingEdge: '' },
      { pathway_id: 'R2', padj: 0.01, NES: 1, leadingEdge: 'NA' },
      { pathway_id: 'R3', padj: 0.01, NES: 1, leadingEdge: 'A;B' },
    ];
    const cohort = [
      { pathway_id: 'R1', padj: 0.01, NES: 1, leadingEdge: 'A' },
      { pathway_id: 'R2', padj: 0.01, NES: 1, leadingEdge: 'NA' },
      { pathway_id: 'R3', padj: 0.01, NES: 1, leadingEdge: 'A;B' },
    ];
    const metrics = computeReplicationMetrics(primary, cohort);
    expect(metrics.leadingEdgeComparablePathways).toBe(1);
    expect(metrics.leadingEdgeOverlapScore).toBe(1);
    expect(metrics.overlapRows[0].leading_edge_jaccard).toBeNull();
    expect(metrics.overlapRows[1].leading_edge_jaccard).toBeNull();
    expect(splitLeadingEdge(null)).toEqual([]);
    expect(splitLeadingEdge('NA;NaN;N/A')).toEqual([]);
  });

  it('does not match unidentified pathways or serialize nonfinite values as numbers', () => {
    const metrics = computeReplicationMetrics([{ padj: 0.01, NES: 1 }], [{ padj: 0.01, NES: 1 }]);
    expect(metrics.sharedSignificantPathways).toBe(0);
    expect(toTsv([{ key: 'R1', direction: null, overlap: Number.NaN, score: Infinity }])).toBe('key\tdirection\toverlap\tscore\nR1\t\t\t\n');
  });

  it.each([null, Number.NaN, -0.1, 1.1])('rejects an undefined or invalid comparison threshold (%j)', (threshold) => {
    expect(() => computeReplicationMetrics([], [], threshold)).toThrow(/threshold/);
  });
});
