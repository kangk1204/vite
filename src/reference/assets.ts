import aliasesAssetUrl from './generated/aliases.json?url';
import pathwaysAssetUrl from './generated/pathways.json?url';
import ppiAssetUrl from './generated/ppi.json?url';
import huriAssetUrl from './generated/huri.json?url';
import metadata from './generated/metadata.json';
import type { ReferencePathwayIndex, ReferenceSummary } from '../types';

export interface ReferenceAssets {
  aliases: Record<string, string>;
  pathways: ReferencePathwayIndex;
  summary: ReferenceSummary;
  stringAdjacency: Record<string, Array<[string, number]>>;
  huriAdjacency: Record<string, Array<[string, number]>>;
}

let referenceAssetsCache: ReferenceAssets | null = null;
let referenceAssetsPromise: Promise<ReferenceAssets> | null = null;

function cacheReferenceAssets(assets: ReferenceAssets): ReferenceAssets {
  referenceAssetsCache = assets;
  return assets;
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: 'force-cache' });
  if (!response.ok) {
    throw new Error(`Failed to load reference asset: ${url}`);
  }
  return await response.json() as T;
}

function castAdjacency(
  source: Record<string, Array<[string, number | string]>>,
): Record<string, Array<[string, number]>> {
  return source as unknown as Record<string, Array<[string, number]>>;
}

async function loadReferenceAssetsForTest(): Promise<ReferenceAssets> {
  const [aliasesModule, pathwaysModule, ppiModule, huriModule] = await Promise.all([
    import('./generated/aliases.json'),
    import('./generated/pathways.json'),
    import('./generated/ppi.json'),
    import('./generated/huri.json'),
  ]);

  return {
    aliases: aliasesModule.default as Record<string, string>,
    pathways: pathwaysModule.default as ReferencePathwayIndex,
    summary: metadata as ReferenceSummary,
    stringAdjacency: castAdjacency(
      ppiModule.default as unknown as Record<string, Array<[string, number | string]>>,
    ),
    huriAdjacency: castAdjacency(
      huriModule.default as unknown as Record<string, Array<[string, number | string]>>,
    ),
  };
}

async function loadReferenceAssetsForRuntime(): Promise<ReferenceAssets> {
  const [aliases, pathways, stringAdjacencyRaw, huriAdjacencyRaw] = await Promise.all([
    fetchJson<Record<string, string>>(aliasesAssetUrl),
    fetchJson<ReferencePathwayIndex>(pathwaysAssetUrl),
    fetchJson<Record<string, Array<[string, number | string]>>>(ppiAssetUrl),
    fetchJson<Record<string, Array<[string, number | string]>>>(huriAssetUrl),
  ]);

  return {
    aliases,
    pathways,
    summary: metadata as ReferenceSummary,
    stringAdjacency: castAdjacency(stringAdjacencyRaw),
    huriAdjacency: castAdjacency(huriAdjacencyRaw),
  };
}

function createReferenceAssetsPromise(): Promise<ReferenceAssets> {
  return (
    import.meta.env.MODE === 'test'
      ? loadReferenceAssetsForTest()
      : loadReferenceAssetsForRuntime()
  ).then(cacheReferenceAssets);
}

if (import.meta.env.MODE === 'test') {
  referenceAssetsPromise = createReferenceAssetsPromise();
  void referenceAssetsPromise.catch(() => {});
}

export async function ensureReferenceAssetsLoaded(): Promise<ReferenceAssets> {
  if (referenceAssetsCache) {
    return referenceAssetsCache;
  }

  if (!referenceAssetsPromise) {
    referenceAssetsPromise = createReferenceAssetsPromise();
  }

  return await referenceAssetsPromise;
}

export function getLoadedReferenceAssetsOrThrow(): ReferenceAssets {
  if (!referenceAssetsCache) {
    throw new Error('Reference assets are not loaded. Call ensureReferenceAssetsLoaded() first.');
  }
  return referenceAssetsCache;
}
