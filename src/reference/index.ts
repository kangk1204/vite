import aliasToSymbol from './generated/aliases.json';
import pathwayIndex from './generated/pathways.json';
import ppiAdjacency from './generated/ppi.json';
import huriAdjacency from './generated/huri.json';
import metadata from './generated/metadata.json';
import type { ReferencePathway, ReferencePathwayIndex, ReferenceSummary } from '../types';
import { normalizeCollectionName, normalizePathwayName, normalizeSymbolToken } from '../lib/utils';

const aliases = aliasToSymbol as Record<string, string>;
const pathways = pathwayIndex as ReferencePathwayIndex;
const rawStringAdjacency = ppiAdjacency as unknown as Record<string, Array<[string, number | string]>>;
const rawHuriAdjacency = huriAdjacency as unknown as Record<string, Array<[string, number | string]>>;
const stringAdjacency = rawStringAdjacency as Record<string, Array<[string, number]>>;
const huriAdjacencyByGene = rawHuriAdjacency as Record<string, Array<[string, number]>>;
const summary = metadata as ReferenceSummary;
const knownCanonicalSymbols = new Set<string>();

function registerKnownSymbol(symbol: string | null | undefined): void {
  const normalized = normalizeSymbolToken(symbol);
  if (normalized) {
    knownCanonicalSymbols.add(normalized);
  }
}

Object.keys(aliases).forEach(registerKnownSymbol);
Object.values(aliases).forEach(registerKnownSymbol);
Object.values(pathways.byId).forEach((pathway) => {
  pathway.genes.forEach(registerKnownSymbol);
});
Object.entries(stringAdjacency).forEach(([gene, neighbors]) => {
  registerKnownSymbol(gene);
  neighbors.forEach(([neighbor]) => registerKnownSymbol(neighbor));
});
Object.entries(huriAdjacencyByGene).forEach(([gene, neighbors]) => {
  registerKnownSymbol(gene);
  neighbors.forEach(([neighbor]) => registerKnownSymbol(neighbor));
});

export function getReferenceSummary(): ReferenceSummary {
  return summary;
}

export function isKnownGeneSymbol(symbol: string): boolean {
  const normalized = normalizeSymbolToken(symbol);
  if (!normalized) {
    return false;
  }
  return Boolean(aliases[normalized]) || knownCanonicalSymbols.has(normalized);
}

export function lookupCanonicalSymbol(symbol: string): string | null {
  const normalized = normalizeSymbolToken(symbol);
  if (!normalized) {
    return null;
  }
  if (aliases[normalized]) {
    return aliases[normalized];
  }
  return knownCanonicalSymbols.has(normalized) ? normalized : null;
}

export function findReferencePathway(
  collectionRaw: string,
  pathwayIdRaw: string | undefined,
  pathwayNameRaw: string,
): ReferencePathway | null {
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

export function getPpiNeighbors(symbol: string): Array<[string, number]> {
  return stringAdjacency[symbol] ?? [];
}

export function getStringPpiNeighbors(symbol: string): Array<[string, number]> {
  return stringAdjacency[symbol] ?? [];
}

export function getHuriPpiNeighbors(symbol: string): Array<[string, number]> {
  return huriAdjacencyByGene[symbol] ?? [];
}

export function getCollectionsStatus(): Record<string, boolean> {
  return {
    Reactome: summary.reactomePathways > 0,
    Hallmark: summary.hallmarkPathways > 0,
  };
}
