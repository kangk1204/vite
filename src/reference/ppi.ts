import { getLoadedReferenceAssetsOrThrow } from './assets';

export function getPpiNeighbors(symbol: string): Array<[string, number]> {
  return getLoadedReferenceAssetsOrThrow().stringAdjacency[symbol] ?? [];
}

export function getStringPpiNeighbors(symbol: string): Array<[string, number]> {
  return getLoadedReferenceAssetsOrThrow().stringAdjacency[symbol] ?? [];
}

export function getHuriPpiNeighbors(symbol: string): Array<[string, number]> {
  return getLoadedReferenceAssetsOrThrow().huriAdjacency[symbol] ?? [];
}
