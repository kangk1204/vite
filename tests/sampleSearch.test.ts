import { describe, expect, it } from 'vitest';
import { createSampleSearchEngine } from '../src/lib/sampleSearch';
import type { GeoSeriesDesignPreview } from '../src/lib/geo';

function createPreview(): GeoSeriesDesignPreview {
  return {
    sampleIds: ['GSM_A1', 'GSM_A2', 'GSM_B1'],
    sampleTitles: {
      GSM_A1: 'Healthy skin replicate 1',
      GSM_A2: 'Healthy skin replicate 2',
      GSM_B1: 'Psoriasis lesion replicate 1',
    },
    factors: [
      {
        id: 'characteristic:tissue',
        label: 'Tissue',
        uniqueValues: ['skin'],
        valuesBySample: {
          GSM_A1: 'skin',
          GSM_A2: 'skin',
          GSM_B1: 'skin',
        },
      },
      {
        id: 'characteristic:condition',
        label: 'Condition',
        uniqueValues: ['healthy', 'psoriasis'],
        valuesBySample: {
          GSM_A1: 'healthy',
          GSM_A2: 'healthy',
          GSM_B1: 'psoriasis',
        },
        orderedBinaryValues: ['healthy', 'psoriasis'],
      },
      {
        id: 'characteristic:batch',
        label: 'Batch',
        uniqueValues: ['Batch_1', 'Batch-2'],
        valuesBySample: {
          GSM_A1: 'Batch_1',
          GSM_A2: 'Batch-2',
          GSM_B1: 'Batch_1',
        },
      },
    ],
    defaultGroupFactorId: 'characteristic:condition',
    defaultConditionA: 'healthy',
    defaultConditionB: 'psoriasis',
    defaultGroupBySample: {
      GSM_A1: 'A',
      GSM_A2: 'A',
      GSM_B1: 'B',
    },
  };
}

describe('createSampleSearchEngine', () => {
  it('returns all samples for an empty query', () => {
    const engine = createSampleSearchEngine(createPreview());
    expect(engine.filter('')).toEqual(['GSM_A1', 'GSM_A2', 'GSM_B1']);
    expect(engine.filter('   ')).toEqual(['GSM_A1', 'GSM_A2', 'GSM_B1']);
  });

  it('matches by sample id, title, and metadata factors', () => {
    const engine = createSampleSearchEngine(createPreview());

    expect(engine.filter('gsm_b1')).toEqual(['GSM_B1']);
    expect(engine.filter('healthy replicate')).toEqual(['GSM_A1', 'GSM_A2']);
    expect(engine.filter('psoriasis skin')).toEqual(['GSM_B1']);
  });

  it('supports multi-token matching and narrowing queries', () => {
    const engine = createSampleSearchEngine(createPreview());

    expect(engine.filter('healthy')).toEqual(['GSM_A1', 'GSM_A2']);
    expect(engine.filter('healthy replicate 2')).toEqual(['GSM_A2']);
  });

  it('supports partial token queries with punctuation-insensitive matching', () => {
    const engine = createSampleSearchEngine(createPreview());

    expect(engine.filter('psor')).toEqual(['GSM_B1']);
    expect(engine.filter('gsm a2')).toEqual(['GSM_A2']);
    expect(engine.filter('batch 2')).toEqual(['GSM_A2']);
    expect(engine.filter('batch_1')).toEqual(['GSM_A1', 'GSM_B1']);
  });

  it('keeps single-character queries non-filtering during incremental input', () => {
    const engine = createSampleSearchEngine(createPreview());

    expect(engine.filter('a')).toEqual(['GSM_A1', 'GSM_A2', 'GSM_B1']);
  });

  it('deduplicates repeated query tokens without changing matches', () => {
    const engine = createSampleSearchEngine(createPreview());

    expect(engine.filter('healthy healthy')).toEqual(['GSM_A1', 'GSM_A2']);
    expect(engine.filter('psoriasis psoriasis skin')).toEqual(['GSM_B1']);
  });

  it('supports fast exact and prefix matching for accession-like sample ids', () => {
    const preview: GeoSeriesDesignPreview = {
      sampleIds: ['GSM1001', 'GSM1002', 'GSM2001'],
      sampleTitles: {
        GSM1001: 'Healthy replicate 1',
        GSM1002: 'Healthy replicate 2',
        GSM2001: 'Psoriasis replicate 1',
      },
      factors: [],
      defaultGroupFactorId: 'none',
      defaultConditionA: 'A',
      defaultConditionB: 'B',
      defaultGroupBySample: {
        GSM1001: 'A',
        GSM1002: 'A',
        GSM2001: 'B',
      },
    };
    const engine = createSampleSearchEngine(preview);
    expect(engine.filter('gsm1002')).toEqual(['GSM1002']);
    expect(engine.filter('gsm10')).toEqual(['GSM1001', 'GSM1002']);
    expect(engine.filter('gsm9999')).toEqual([]);
  });

  it('keeps search correctness when high-frequency tokens are dropped from posting indexes', () => {
    const sampleIds = Array.from({ length: 860 }, (_value, index) => `GSM_${index + 1}`);
    const preview: GeoSeriesDesignPreview = {
      sampleIds,
      sampleTitles: Object.fromEntries(sampleIds.map((sampleId, index) => [sampleId, `shared tissue sample ${index + 1}`])),
      factors: [
        {
          id: 'characteristic:condition',
          label: 'Condition',
          uniqueValues: ['shared'],
          valuesBySample: Object.fromEntries(sampleIds.map((sampleId) => [sampleId, 'shared'])),
        },
      ],
      defaultGroupFactorId: 'characteristic:condition',
      defaultConditionA: 'shared',
      defaultConditionB: 'other',
      defaultGroupBySample: Object.fromEntries(sampleIds.map((sampleId) => [sampleId, 'A'])),
    };
    const engine = createSampleSearchEngine(preview);

    expect(engine.filter('shared').length).toBe(860);
    expect(engine.filter('shared 859')).toEqual(['GSM_859']);
  });
});
