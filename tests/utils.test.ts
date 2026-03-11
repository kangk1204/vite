import { describe, expect, it } from 'vitest';
import { slugify } from '../src/lib/utils';

describe('slugify', () => {
  it('keeps non-Latin letters for export-safe readable slugs', () => {
    expect(slugify('건선 연구 2026')).toBe('건선-연구-2026');
  });

  it('normalizes punctuation and trims separators', () => {
    expect(slugify('  Study: TP53/AKT1 (v2)  ')).toBe('study-tp53-akt1-v2');
  });
});
