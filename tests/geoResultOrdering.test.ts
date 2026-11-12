import { describe, expect, it } from 'vitest';
import {
  buildGeoResultIndexOrders,
  orderFilteredGeoIndices,
  type GeoResultSortMode,
} from '../src/lib/geoResultOrdering';
import type { GeoSearchResult } from '../src/lib/geoSearch';

function createResult(
  accession: string,
  sampleCount: number,
  eligibilityStatus: GeoSearchResult['eligibilityStatus'] = 'eligible',
): GeoSearchResult {
  return {
    accession,
    title: `${accession} title`,
    summary: `${accession} summary`,
    organism: 'Homo sapiens',
    sampleCount,
    pubmedId: undefined,
    isEligible: eligibilityStatus === 'eligible',
    eligibilityStatus,
    eligibilityReason: undefined,
    geoUrl: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${accession}`,
    downloadUrl: `https://www.ncbi.nlm.nih.gov/geo/download/?acc=${accession}`,
    hasNcbiGeneratedRawCounts: eligibilityStatus === 'eligible',
  };
}

describe('geoResultOrdering', () => {
  const results: GeoSearchResult[] = [
    createResult('GSE300', 12),
    createResult('GSE100', 20),
    createResult('GSE200', 20),
    createResult('GSE150', 5),
  ];

  it('builds stable pre-sorted index orders', () => {
    const orders = buildGeoResultIndexOrders(results);

    expect(orders.ranked).toEqual([0, 1, 2, 3]);
    expect(orders.samples).toEqual([1, 2, 0, 3]);
    expect(orders.accession).toEqual([1, 3, 2, 0]);
    expect(Array.from(orders.sampleRankByIndex)).toEqual([2, 0, 1, 3]);
    expect(Array.from(orders.accessionRankByIndex)).toEqual([3, 0, 2, 1]);
  });

  it.each<[GeoResultSortMode, number[]]>([
    ['ranked', [2, 0, 3]],
    ['samples', [2, 0, 3]],
    ['accession', [3, 2, 0]],
  ])('orders filtered indices for %s mode', (mode, expected) => {
    const orders = buildGeoResultIndexOrders(results);
    const filtered = [2, 0, 3];
    const ordered = orderFilteredGeoIndices(filtered, mode, orders);
    expect(ordered).toEqual(expected);
  });

  it('returns the same array reference for ranked mode', () => {
    const orders = buildGeoResultIndexOrders(results);
    const filtered = [3, 1];
    const ordered = orderFilteredGeoIndices(filtered, 'ranked', orders);
    expect(ordered).toBe(filtered);
  });

  it('returns the same array reference when already sorted for selected mode', () => {
    const orders = buildGeoResultIndexOrders(results);
    const bySamples = [1, 2];
    const byAccession = [1, 3, 2];

    expect(orderFilteredGeoIndices(bySamples, 'samples', orders)).toBe(bySamples);
    expect(orderFilteredGeoIndices(byAccession, 'accession', orders)).toBe(byAccession);
  });

  it('does not mutate filtered indices for non-ranked modes', () => {
    const orders = buildGeoResultIndexOrders(results);
    const filtered = [2, 0, 3];
    const original = filtered.slice();
    orderFilteredGeoIndices(filtered, 'samples', orders);
    orderFilteredGeoIndices(filtered, 'accession', orders);
    expect(filtered).toEqual(original);
  });
});
