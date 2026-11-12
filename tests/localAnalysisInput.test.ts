import { describe, expect, it } from 'vitest';
import { createLocalAnalysisInput, localAnalysisInputFilename } from '../src/lib/localAnalysisInput';
import { alignGeoInputSamples } from '../src/lib/geo';

const seriesMatrixText = [
  '!Sample_geo_accession\t"GSM_A1"\t"GSM_A2"\t"GSM_B1"\t"GSM_B2"\t"GSM_X"',
  '!Sample_title\t"control one"\t"control two"\t"treated one"\t"treated two"\t"excluded"',
  '!Sample_characteristics_ch1\t"group: control"\t"group: control"\t"group: treated"\t"group: treated"\t"group: unknown"',
].join('\n');
const rawCountsText = 'gene_symbol\tGSM_A1\tGSM_A2\tGSM_B1\tGSM_B2\tGSM_X\nA1BG-AS1\t100\t100\t100\t100\t100';
const design = { conditionA: 'Control', conditionB: 'Treated', groupBySample: {
  GSM_A1: 'A' as const, GSM_A2: 'A' as const, GSM_B1: 'B' as const, GSM_B2: 'B' as const, GSM_X: '' as const,
} };

describe('local analysis input', () => {
  it('preserves counts and explicit exclusions without computing statistics', () => {
    const input = createLocalAnalysisInput({ accession: 'GSE_TEST', rawCountsText, seriesMatrixText, design });
    expect(input.kind).toBe('pnv-local-analysis-input');
    expect(input.schemaVersion).toBe(1);
    expect(input.rawCountsText).toBe(rawCountsText);
    expect(input.design.groupBySample.GSM_X).toBe('U');
    expect(input.project.conditionB).toBe('Treated');
    expect(input).not.toHaveProperty('pathways');
    expect(input).not.toHaveProperty('viewerData');
    expect(design.groupBySample.GSM_X).toBe('');
  });

  it('accepts uniquely title-matched count columns and keeps metadata IDs', () => {
    const titledCounts = rawCountsText.replace('GSM_A1\tGSM_A2\tGSM_B1\tGSM_B2\tGSM_X', 'control one\tcontrol two\ttreated one\ttreated two\texcluded');
    const input = createLocalAnalysisInput({ rawCountsText: titledCounts, seriesMatrixText, design });
    expect(input.design.groupBySample.GSM_A1).toBe('A');
    expect(input.rawCountsText).toBe(titledCounts);
  });

  it('rejects incomplete assignments rather than silently inferring excluded samples', () => {
    const { GSM_A2: _removed, ...partial } = design.groupBySample;
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: { ...design, groupBySample: partial } })).toThrow(/assignment.*GSM_A2/i);
  });

  it('rejects too-small groups and unmatched count headers', () => {
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: { ...design, groupBySample: { ...design.groupBySample, GSM_A2: '' } } })).toThrow(/at least 2/i);
    expect(() => createLocalAnalysisInput({ rawCountsText: rawCountsText.replace('GSM_A1', 'missing'), seriesMatrixText, design })).toThrow(/align.*GSM_A1/i);
  });

  it('rejects duplicate metadata and count sample IDs', () => {
    expect(() => createLocalAnalysisInput({ rawCountsText: rawCountsText.replace('GSM_A2', 'GSM_A1'), seriesMatrixText, design })).toThrow(/duplicate/i);
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText: seriesMatrixText.replace('GSM_A2', 'GSM_A1'), design })).toThrow(/duplicate/i);
  });

  it('requires explicit complete batch values and rejects fully confounded batch', () => {
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: { ...design, batchBySample: { GSM_A1: 'one' } } })).toThrow(/batch.*GSM_A2/i);
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: { ...design, batchBySample: { GSM_A1: 'one', GSM_A2: 'one', GSM_B1: 'two', GSM_B2: 'two' } } })).toThrow(/confound/i);
  });

  it('copies complete batch metadata without inventing a model formula', () => {
    const input = createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: { ...design, batchFactorName: 'batch', batchBySample: { GSM_A1: 'one', GSM_A2: 'two', GSM_B1: 'one', GSM_B2: 'two' } } });
    expect(input.design.batchBySample).toEqual({ GSM_A1: 'one', GSM_A2: 'two', GSM_B1: 'one', GSM_B2: 'two' });
    expect(input.design).not.toHaveProperty('designFormula');
  });

  it('rejects unsupported species, identical labels, invalid counts and oversized inputs', () => {
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design, organism: 'mouse' })).toThrow(/human/i);
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: { ...design, conditionB: 'Control' } })).toThrow(/different/i);
    expect(() => createLocalAnalysisInput({ rawCountsText: rawCountsText.replace('100\t100', '-1\t100'), seriesMatrixText, design })).toThrow(/non-negative integer/i);
    const sampleIds = Array.from({ length: 1501 }, (_, i) => `GSM_${i}`);
    expect(() => createLocalAnalysisInput({ rawCountsText: `gene\t${sampleIds.join('\t')}\nX\t${sampleIds.map(() => 1).join('\t')}`, seriesMatrixText, design })).toThrow(/memory/i);
  });

  it('uses a safe deterministic download filename', () => {
    expect(localAnalysisInputFilename('GSE / Demo')).toBe('gse-demo.local-analysis.json');
    expect(localAnalysisInputFilename('')).toBe('local-analysis.local-analysis.json');
  });

  it.each([
    ['', /header/],
    ['gene\tA1\tA2', /header/],
    ['gene\tA1\t\nTP53\t1\t2', /sample IDs/],
    ['gene\tA1\tA2\nTP53\t1', /match the sample header/],
    ['gene\tA1\tA2\n\t1\t2', /match the sample header/],
    ['gene\tA1\tA2\nTP53\t0.5\t1', /non-negative integer/],
    ['gene\tA1\tA2\nTP53\tNaN\t1', /non-negative integer/],
  ])('rejects malformed count input before any inference (%j)', (text, reason) => {
    expect(() => createLocalAnalysisInput({ rawCountsText: text, seriesMatrixText, design })).toThrow(reason);
  });

  it('rejects byte and cell limits before allocating a numeric matrix', () => {
    const excessiveText = 'x'.repeat(128 * 1024 * 1024 + 1);
    expect(() => createLocalAnalysisInput({ rawCountsText: excessiveText, seriesMatrixText, design })).toThrow(/memory/);
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText: excessiveText, design })).toThrow(/memory/);
    const header = Array.from({ length: 1500 }, (_, index) => `S${index}`).join('\t');
    const excessiveCells = `gene\t${header}\n${'X\n'.repeat(30001)}`;
    expect(() => createLocalAnalysisInput({ rawCountsText: excessiveCells, seriesMatrixText, design })).toThrow(/memory/);
  });

  it('rejects a constant batch factor or saturated design', () => {
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: { ...design,
      batchBySample: { GSM_A1: 'one', GSM_A2: 'one', GSM_B1: 'one', GSM_B2: 'one' },
    } })).toThrow(/at least two levels/);
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: { ...design,
      batchBySample: { GSM_A1: 'shared', GSM_A2: 'two', GSM_B1: 'shared', GSM_B2: 'three' },
    } })).toThrow(/residual degrees of freedom/);
  });

  it('does not require a count column for an explicitly excluded metadata sample', () => {
    const countsWithoutExcluded = rawCountsText.replace('\tGSM_X', '').replace(/\t100$/, '');
    const input = createLocalAnalysisInput({ rawCountsText: countsWithoutExcluded, seriesMatrixText, design });
    expect(input.design.groupBySample.GSM_X).toBe('U');
  });

  it('prepares inferred binary groups only when no explicit design was supplied', () => {
    const series = '!Sample_geo_accession\t"A1"\t"A2"\t"B1"\t"B2"\n!Sample_characteristics_ch1\t"group: control"\t"group: control"\t"group: treated"\t"group: treated"';
    const counts = 'gene\tA1\tA2\tB1\tB2\nTP53\t1\t1\t1\t1';
    const input = createLocalAnalysisInput({ rawCountsText: counts, seriesMatrixText: series });
    expect(input.project).toMatchObject({ conditionA: 'control', conditionB: 'treated', accession: 'USER_DATA' });
    expect(input.design.groupBySample).toEqual({ A1: 'A', A2: 'A', B1: 'B', B2: 'B' });
  });

  it('rejects unexpected group assignment values', () => {
    const invalidDesign = { ...design, groupBySample: { ...design.groupBySample, GSM_A1: 'C' } };
    expect(() => createLocalAnalysisInput({ rawCountsText, seriesMatrixText, design: invalidDesign as never })).toThrow(/Invalid group assignment/);
  });

  it('reserves exact accession matches before using another sample title', () => {
    const series = '!Sample_geo_accession\t"GSM1"\t"GSM2"\t"GSM3"\t"GSM4"\n!Sample_title\t"GSM2"\t"A"\t"T3"\t"T4"';
    const alignment = alignGeoInputSamples(series, ['GSM2', 'A', 'GSM3', 'GSM4']);
    expect(alignment.seriesToRawSampleId.get('GSM2')).toBe('GSM2');
    expect(alignment.seriesToRawSampleId.has('GSM1')).toBe(false);
    expect(alignment.unresolvedSeriesSampleIds).toEqual(['GSM1']);
    const options = { rawCountsText: 'gene\tGSM2\tA\tGSM3\tGSM4\nTP53\t1\t2\t3\t4', seriesMatrixText: series,
      design: { groupBySample: { GSM1: 'A' as const, GSM2: 'A' as const, GSM3: 'B' as const, GSM4: 'B' as const } },
    };
    expect(() => createLocalAnalysisInput(options)).toThrow(/align.*GSM1/);
  });

  it('leaves ambiguous title collisions unresolved regardless of metadata order', () => {
    const first = '!Sample_geo_accession\t"GSM1"\t"GSM2"\t"GSM3"\t"GSM4"\n!Sample_title\t"shared"\t"shared"\t"T3"\t"T4"';
    const reversed = '!Sample_geo_accession\t"GSM2"\t"GSM1"\t"GSM4"\t"GSM3"\n!Sample_title\t"shared"\t"shared"\t"T4"\t"T3"';
    const headers = ['shared', 'other', 'GSM3', 'GSM4'];
    const a = alignGeoInputSamples(first, headers), b = alignGeoInputSamples(reversed, headers);
    expect([...a.seriesToRawSampleId.entries()].sort()).toEqual([['GSM3', 'GSM3'], ['GSM4', 'GSM4']]);
    expect([...b.seriesToRawSampleId.entries()].sort()).toEqual([...a.seriesToRawSampleId.entries()].sort());
    expect([...a.unresolvedSeriesSampleIds].sort()).toEqual(['GSM1', 'GSM2']);
    expect([...b.unresolvedSeriesSampleIds].sort()).toEqual(['GSM1', 'GSM2']);
  });
});
