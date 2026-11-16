import { describe, expect, it } from 'vitest';
import { normalizeSheetRows, slugify } from '../src/lib/utils';

describe('slugify', () => {
  it('keeps non-Latin letters for export-safe readable slugs', () => {
    expect(slugify('건선 연구 2026')).toBe('건선-연구-2026');
  });

  it('normalizes punctuation and trims separators', () => {
    expect(slugify('  Study: TP53/AKT1 (v2)  ')).toBe('study-tp53-akt1-v2');
  });
});

describe('normalizeSheetRows', () => {
  it('ignores prototype-polluting column names', () => {
    const [row] = normalizeSheetRows([
      {
        gene_symbol: 'TP53',
        __proto__: 'polluted',
        constructor: 'polluted',
        prototype: 'polluted',
      },
    ]);

    expect(row.gene_symbol).toBe('TP53');
    expect(Object.prototype.hasOwnProperty.call(row, '__proto__')).toBe(false);
    expect(Object.getPrototypeOf(row)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
