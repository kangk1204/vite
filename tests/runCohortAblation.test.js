import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildAblationConfigPath,
  jaccard,
  significantGeneSet,
  makeAblationConfig,
  formatOptionalMetric,
} from '../scripts/run_cohort_ablation.mjs';

describe('run_cohort_ablation helpers', () => {
  it('counts only finite significant genes above the log2 fold-change threshold', () => {
    const genes = significantGeneSet([
      { gene: 'A', padj: '0.01', log2FoldChange: '1.2' },
      { gene: 'B', padj: '0.01', log2FoldChange: '1.0' },
      { gene: 'C', padj: 'NaN', log2FoldChange: '2' },
      { gene: 'INVALID', padj: '-0.1', log2FoldChange: '2' },
      { gene: 'MISSING', padj: '', log2FoldChange: '2' },
      { gene: '', padj: '0.01', log2FoldChange: '2' },
      { gene: 'A', padj: '0.02', log2FoldChange: '-3' },
    ]);

    expect([...genes]).toEqual(['A']);
  });

  it('returns unavailable Jaccard similarity for two empty sets', () => {
    expect(jaccard(new Set(), new Set())).toBeNull();
    expect(formatOptionalMetric(jaccard(new Set(),new Set()))).toBe('');
    expect(formatOptionalMetric(NaN)).toBe('');
    expect(formatOptionalMetric(0)).toBe(0);
    expect(formatOptionalMetric(0.123456)).toBe(0.1235);
  });

  it('rejects ablation result prefixes that would escape the runtime config directory', () => {
    expect(() => buildAblationConfigPath('../escape')).toThrow(/Unsafe ablation resultPrefix/);
    const safePath = buildAblationConfigPath('safe_prefix');
    expect(path.basename(safePath)).toBe('safe_prefix.json');
  });

  it('does not inherit 500 bootstrap repetitions into group-only sensitivity runs', () => {
    const original = { bootstrapReplicates: 500, designFormula: '~ age + group', resultPrefix: 'primary' };
    const ablation = makeAblationConfig(original, { designFormula: '~ group', resultPrefix: 'group_only' }, { sampleMetadataPath: 'results/primary_sample_metadata.tsv' });
    expect(ablation.bootstrapReplicates).toBe(0);
    expect(ablation.sampleMetadataPath).toBe('results/primary_sample_metadata.tsv');
    expect(ablation.designFormula).toBe('~ group');
    expect(original.bootstrapReplicates).toBe(500);
    expect(makeAblationConfig(original, { bootstrapReplicates: 500 }).bootstrapReplicates).toBe(0);
  });
});
