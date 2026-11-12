import { describe, expect, it } from 'vitest';
import { computeReplicationMetrics } from '../scripts/lib/paper_pipeline.mjs';
import { parseTsv } from '../scripts/lib/paper_pipeline.mjs';

describe('computeReplicationMetrics', () => {
  it('computes replicated pathway counts and leading-edge overlap against the primary cohort', () => {
    const primaryRows = [
      {
        pathway_name: 'Cell Cycle',
        nes: '2.8',
        padj: '0.001',
        leading_edge_genes: 'MKI67;TOP2A;CDK1',
      },
      {
        pathway_name: 'Interferon Signaling',
        nes: '2.4',
        padj: '0.01',
        leading_edge_genes: 'STAT1;IFI27',
      },
    ];
    const cohortRows = [
      {
        pathway_name: 'Cell Cycle',
        nes: '2.1',
        padj: '0.02',
        leading_edge_genes: 'MKI67;TOP2A;CDC20',
      },
      {
        pathway_name: 'Interferon Signaling',
        nes: '-1.9',
        padj: '0.03',
        leading_edge_genes: 'STAT1;IFI27',
      },
    ];

    const metrics = computeReplicationMetrics(primaryRows, cohortRows);

    expect(metrics.sharedSignificantPathways).toBe(2);
    expect(metrics.directionConsistency).toBeCloseTo(0.5, 6);
    expect(metrics.leadingEdgeOverlapScore).toBeCloseTo((0.5 + 1) / 2, 6);
    expect(metrics.overlapRows[0]?.pathway_name).toBe('Cell Cycle');
    expect(metrics.overlapRows[1]?.same_direction).toBe('no');
  });
});

describe('cross-context summary CLI', () => {
  it('writes blank undefined summaries and never hardcodes primary self-consistency', async () => {
    // Keep Node-only fixture dependencies out of the browser-facing TS module graph.
    const loadNodeModule = (name: string) => import(/* @vite-ignore */ name);
    const [{ default: fs }, { default: path }, { execFileSync }, { default: process }] = await Promise.all([
      loadNodeModule('node:fs'), loadNodeModule('node:path'), loadNodeModule('node:child_process'), loadNodeModule('node:process'),
    ]);
    fs.mkdirSync(path.resolve('.cache'), { recursive: true });
    const directory = fs.mkdtempSync(path.resolve('.cache/paper-summary-test-'));
    const relative = (file: string) => path.relative(process.cwd(), path.join(directory, file));
    try {
      fs.writeFileSync(path.join(directory, 'primary.tsv'), 'pathway_id\tpathway_name\tNES\tpadj\tleadingEdge\nR1\tMissing P value\t1\t\tA;B\nR2\tUntestable direction\tNA\t0.01\tNA\n');
      fs.writeFileSync(path.join(directory, 'comparison.tsv'), 'pathway_id\tpathway_name\tNES\tpadj\tleadingEdge\nR1\tMissing P value\t1\tNA\tA;B\nR2\tUntestable direction\t\t0.02\t\n');
      fs.writeFileSync(path.join(directory, 'samples.tsv'), 'sample\tgroup\nS1\tA\nS2\tB\n');
      const cohorts = [
        { key: 'primary', role: 'primary', pathwayTablePath: relative('primary.tsv'), sampleMetadataPath: relative('samples.tsv') },
        { key: 'comparison', role: 'extension', pathwayTablePath: relative('comparison.tsv'), sampleMetadataPath: relative('samples.tsv') },
      ];
      fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ outputRoot: relative('outputs'), primaryCohortKey: 'primary', cohorts }));
      execFileSync(process.execPath, ['scripts/build_replication_summary.mjs', relative('manifest.json')], { stdio: 'pipe' });
      const rows = parseTsv(fs.readFileSync(path.join(directory, 'outputs/benchmarks/cohort_summary.tsv'), 'utf8'));
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.significant_pathways).toBe('1');
        expect(row.replicated_pathways).toBe('1');
        expect(row.direction_consistency).toBe('');
        expect(row.leading_edge_overlap_score).toBe('');
        expect(row.direction_comparable_pathways).toBe('0');
        expect(row.leading_edge_comparable_pathways).toBe('0');
        expect(row.comparison_scope).toBe('conditional_cross_context_overlap');
      }
      const legacyNamedOutput = parseTsv(fs.readFileSync(path.join(directory, 'outputs/benchmarks/pathway_replication_summary.tsv'), 'utf8'));
      expect(legacyNamedOutput[0].comparison_scope).toBe('conditional_cross_context_overlap');
      expect(legacyNamedOutput[1].direction_consistency).toBe('');
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
