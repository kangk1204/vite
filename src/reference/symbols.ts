import type { ReferencePathway, ReferenceSummary } from '../types';
import { normalizeCollectionName, normalizePathwayName, normalizeSymbolToken } from '../lib/utils';
import { getLoadedReferenceAssetsOrThrow } from './assets';

const knownCanonicalSymbols = new Set<string>();
let knownSymbolsInitialized = false;
let knownSymbolsInitializedWithAliasesSize = 0;

function registerKnownSymbol(symbol: string | null | undefined): void {
  const normalized = normalizeSymbolToken(symbol);
  if (normalized) {
    knownCanonicalSymbols.add(normalized);
  }
}

function ensureKnownSymbolsInitialized(): void {
  const assets = getLoadedReferenceAssetsOrThrow();
  if (knownSymbolsInitialized && knownSymbolsInitializedWithAliasesSize === Object.keys(assets.aliases).length) {
    return;
  }

  knownCanonicalSymbols.clear();
  Object.keys(assets.aliases).forEach(registerKnownSymbol);
  Object.values(assets.aliases).forEach(registerKnownSymbol);
  Object.values(assets.pathways.byId).forEach((pathway) => {
    pathway.genes.forEach(registerKnownSymbol);
  });

  knownSymbolsInitialized = true;
  knownSymbolsInitializedWithAliasesSize = Object.keys(assets.aliases).length;
}

export function getReferenceSummary(): ReferenceSummary {
  return getLoadedReferenceAssetsOrThrow().summary;
}

export function getReferenceAssetVersion(): string {
  const summary = getLoadedReferenceAssetsOrThrow().summary;
  return [
    `reactome-${summary.reactomePathways}`,
    `hallmark-${summary.hallmarkPathways}`,
    `string-${summary.stringScoreCutoff}`,
    `huri-${summary.huriPpiEdges ?? 0}`,
    `mode-${summary.hallmarkMode}`,
  ].join('.');
}

export function isKnownGeneSymbol(symbol: string): boolean {
  const normalized = normalizeSymbolToken(symbol);
  if (!normalized) {
    return false;
  }

  const { aliases } = getLoadedReferenceAssetsOrThrow();
  if (aliases[normalized]) {
    return true;
  }

  ensureKnownSymbolsInitialized();
  return knownCanonicalSymbols.has(normalized);
}

export function lookupCanonicalSymbol(symbol: string): string | null {
  const normalized = normalizeSymbolToken(symbol);
  if (!normalized) {
    return null;
  }

  const { aliases } = getLoadedReferenceAssetsOrThrow();
  if (aliases[normalized]) {
    return aliases[normalized];
  }

  ensureKnownSymbolsInitialized();
  return knownCanonicalSymbols.has(normalized) ? normalized : null;
}

export function findReferencePathway(
  collectionRaw: string,
  pathwayIdRaw: string | undefined,
  pathwayNameRaw: string,
): ReferencePathway | null {
  const { pathways } = getLoadedReferenceAssetsOrThrow();
  const collection = normalizeCollectionName(collectionRaw);
  const pathwayId = pathwayIdRaw?.trim();

  if (pathwayId) {
    const exactId = `${collection}::${pathwayId.toUpperCase()}`;
    if (pathways.byId[exactId]) {
      return pathways.byId[exactId];
    }
  }

  const key = `${collection.toLowerCase()}::${normalizePathwayName(pathwayNameRaw)}`;
  const matchedId = pathways.byKey[key];
  return matchedId ? pathways.byId[matchedId] ?? null : null;
}

export function getCollectionsStatus(): Record<string, boolean> {
  const summary = getLoadedReferenceAssetsOrThrow().summary;
  return {
    Reactome: summary.reactomePathways > 0,
    Hallmark: summary.hallmarkPathways > 0,
  };
}
