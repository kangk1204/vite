import type { GeoSearchResult } from './geoSearch';

export type GeoResultSortMode = 'ranked' | 'samples' | 'accession';

export interface GeoResultIndexOrders {
  ranked: number[];
  samples: number[];
  accession: number[];
  sampleRankByIndex: Int32Array;
  accessionRankByIndex: Int32Array;
}

export function buildGeoResultIndexOrders(results: GeoSearchResult[]): GeoResultIndexOrders {
  const ranked = results.map((_result, index) => index);
  const samples = ranked.slice();
  samples.sort((leftIndex, rightIndex) => {
    const left = results[leftIndex];
    const right = results[rightIndex];
    if (!left || !right) {
      return left ? -1 : right ? 1 : 0;
    }
    return right.sampleCount - left.sampleCount || left.accession.localeCompare(right.accession);
  });

  const accession = ranked.slice();
  accession.sort((leftIndex, rightIndex) => {
    const left = results[leftIndex];
    const right = results[rightIndex];
    if (!left || !right) {
      return left ? -1 : right ? 1 : 0;
    }
    return left.accession.localeCompare(right.accession);
  });

  const sampleRankByIndex = new Int32Array(results.length);
  for (let rank = 0; rank < samples.length; rank += 1) {
    sampleRankByIndex[samples[rank]] = rank;
  }

  const accessionRankByIndex = new Int32Array(results.length);
  for (let rank = 0; rank < accession.length; rank += 1) {
    accessionRankByIndex[accession[rank]] = rank;
  }

  return {
    ranked,
    samples,
    accession,
    sampleRankByIndex,
    accessionRankByIndex,
  };
}

export function orderFilteredGeoIndices(
  filteredIndices: number[],
  sortMode: GeoResultSortMode,
  orders: GeoResultIndexOrders,
): number[] {
  if (sortMode === 'ranked' || filteredIndices.length < 2) {
    return filteredIndices;
  }

  const rankByIndex = sortMode === 'samples' ? orders.sampleRankByIndex : orders.accessionRankByIndex;
  let isAlreadySorted = true;
  let previousRank = -1;
  for (let index = 0; index < filteredIndices.length; index += 1) {
    const currentRank = rankByIndex[filteredIndices[index]];
    if (currentRank < previousRank) {
      isAlreadySorted = false;
      break;
    }
    previousRank = currentRank;
  }
  if (isAlreadySorted) {
    return filteredIndices;
  }

  if (filteredIndices.length * 2 <= orders.ranked.length) {
    const sorted = filteredIndices.slice();
    sorted.sort((left, right) => rankByIndex[left] - rankByIndex[right]);
    return sorted;
  }

  const membership = new Uint8Array(orders.ranked.length);
  for (const index of filteredIndices) {
    if (index >= 0 && index < membership.length) {
      membership[index] = 1;
    }
  }

  const preferredOrder = sortMode === 'samples' ? orders.samples : orders.accession;
  const ordered: number[] = [];
  for (const index of preferredOrder) {
    if (membership[index]) {
      ordered.push(index);
    }
  }
  return ordered;
}
