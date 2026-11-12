import type { GeoSeriesDesignPreview } from './geo';

const FULL_INDEX_SAMPLE_LIMIT = 2500;
const QUERY_RESULT_CACHE_LIMIT = 24;
const QUERY_TOKEN_CACHE_LIMIT = 72;
const QUERY_RESULT_CACHEABLE_MATCH_LIMIT = 1200;
const ON_DEMAND_TEXT_CACHE_LIMIT = 1024;
const ON_DEMAND_TEXT_CACHE_MIN = 224;
const MIN_QUERY_TOKEN_LENGTH = 2;
const MAX_QUERY_TOKENS = 14;
const TOKEN_PREFIX_LENGTH = 3;
const MIN_PREFIX_TOKEN_LENGTH = 2;
const MAX_PREFIXES_PER_SAMPLE = 48;
const MAX_EXACT_TOKENS_PER_SAMPLE = 64;
const MAX_POSTING_LIST_SIZE = 768;
const TYPED_POSTING_LIST_MIN_LENGTH = 32;
const MAX_INTERSECTION_MERGES = 6;
const INTERSECTION_TARGET_CANDIDATES = 128;
const MIN_SAMPLE_ID_PREFIX_LENGTH = 4;
const NON_ALPHANUMERIC_REGEX = /[^a-z0-9]+/g;
const MULTISPACE_REGEX = /\s+/g;
const SAMPLE_ID_LIKE_REGEX = /^[a-z]{2,6}[a-z0-9]*\d[a-z0-9]*$/;
type PostingList = number[] | Uint32Array;

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_REGEX, ' ')
    .replace(MULTISPACE_REGEX, ' ')
    .trim();
}

function normalizeQuery(query: string): string {
  return normalizeSearchText(query);
}

function tokenizeQuery(query: string): string[] {
  if (!query) {
    return [];
  }
  const tokens: string[] = [];
  const seen = new Set<string>();
  const length = query.length;
  let cursor = 0;
  while (cursor < length && tokens.length < MAX_QUERY_TOKENS) {
    while (cursor < length && query[cursor] === ' ') {
      cursor += 1;
    }
    if (cursor >= length) {
      break;
    }
    const start = cursor;
    while (cursor < length && query[cursor] !== ' ') {
      cursor += 1;
    }
    const tokenLength = cursor - start;
    if (tokenLength < MIN_QUERY_TOKEN_LENGTH) {
      if (tokenLength !== 1) {
        continue;
      }
      const charCode = query.charCodeAt(start);
      if (charCode < 48 || charCode > 57) {
        continue;
      }
    }
    const token = query.slice(start, cursor);
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function buildSampleSearchText(preview: GeoSeriesDesignPreview, sampleId: string): string {
  const parts: string[] = [sampleId];
  const sampleTitle = preview.sampleTitles[sampleId];
  if (sampleTitle) {
    parts.push(sampleTitle);
  }
  for (const factor of preview.factors) {
    const value = factor.valuesBySample[sampleId];
    if (value) {
      parts.push(value);
    }
  }
  return normalizeSearchText(parts.join('\n'));
}

function buildSampleSearchArtifacts(
  preview: GeoSeriesDesignPreview,
  sampleId: string,
): {
  searchText: string;
  prefixes: string[];
  exactTokens: string[];
} {
  const parts: string[] = [sampleId];
  const sampleTitle = preview.sampleTitles[sampleId];
  if (sampleTitle) {
    parts.push(sampleTitle);
  }
  for (const factor of preview.factors) {
    const value = factor.valuesBySample[sampleId];
    if (value) {
      parts.push(value);
    }
  }

  const normalized = normalizeSearchText(parts.join('\n'));
  const prefixes = new Set<string>();
  const exactTokens = new Set<string>();

  const length = normalized.length;
  let cursor = 0;
  while (cursor < length) {
    while (cursor < length && normalized[cursor] === ' ') {
      cursor += 1;
    }
    if (cursor >= length) {
      break;
    }
    const start = cursor;
    while (cursor < length && normalized[cursor] !== ' ') {
      cursor += 1;
    }
    const tokenLength = cursor - start;
    if (tokenLength < MIN_PREFIX_TOKEN_LENGTH) {
      continue;
    }
    if (prefixes.size < MAX_PREFIXES_PER_SAMPLE) {
      prefixes.add(normalized.slice(start, start + Math.min(TOKEN_PREFIX_LENGTH, tokenLength)));
    }
    if (exactTokens.size < MAX_EXACT_TOKENS_PER_SAMPLE) {
      exactTokens.add(normalized.slice(start, cursor));
    }
    if (
      prefixes.size >= MAX_PREFIXES_PER_SAMPLE &&
      exactTokens.size >= MAX_EXACT_TOKENS_PER_SAMPLE
    ) {
      break;
    }
  }

  return {
    searchText: normalized,
    prefixes: Array.from(prefixes),
    exactTokens: Array.from(exactTokens),
  };
}

function updateLruEntry<K, T>(cache: Map<K, T>, key: K, value: T, maxEntries: number): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > maxEntries) {
    const firstKey = cache.keys().next().value;
    if (firstKey === undefined) {
      break;
    }
    cache.delete(firstKey);
  }
}

function getLruEntry<K, T>(cache: Map<K, T>, key: K): T | undefined {
  const value = cache.get(key);
  if (value === undefined) {
    return undefined;
  }
  updateLruEntry(cache, key, value, cache.size + 1);
  return value;
}

function intersectSortedIndices(left: PostingList, right: PostingList): number[] {
  if (!left.length || !right.length) {
    return [];
  }
  const matched: number[] = [];
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftValue = left[leftIndex];
    const rightValue = right[rightIndex];
    if (leftValue === rightValue) {
      matched.push(leftValue);
      leftIndex += 1;
      rightIndex += 1;
      continue;
    }
    if (leftValue < rightValue) {
      leftIndex += 1;
      continue;
    }
    rightIndex += 1;
  }
  return matched;
}

function appendPostingWithLimit(
  indexMap: Map<string, number[]>,
  saturatedKeys: Set<string>,
  key: string,
  value: number,
): void {
  if (saturatedKeys.has(key)) {
    return;
  }
  const postingList = indexMap.get(key);
  if (!postingList) {
    indexMap.set(key, [value]);
    return;
  }
  if (postingList.length >= MAX_POSTING_LIST_SIZE) {
    indexMap.delete(key);
    saturatedKeys.add(key);
    return;
  }
  postingList.push(value);
}

function compactPostingIndex(indexMap: Map<string, number[]>): Map<string, PostingList> {
  const compacted = new Map<string, PostingList>();
  for (const [key, postingList] of indexMap.entries()) {
    if (postingList.length >= TYPED_POSTING_LIST_MIN_LENGTH) {
      compacted.set(key, Uint32Array.from(postingList));
      continue;
    }
    compacted.set(key, postingList);
  }
  return compacted;
}

export interface SampleSearchEngine {
  filter: (query: string) => string[];
}

export function createSampleSearchEngine(preview: GeoSeriesDesignPreview): SampleSearchEngine {
  const allSampleIds = preview.sampleIds;
  const queryResultCache = new Map<string, string[]>();
  const queryTokenCache = new Map<string, string[]>();
  const onDemandTextCacheLimit = Math.min(
    ON_DEMAND_TEXT_CACHE_LIMIT,
    Math.max(ON_DEMAND_TEXT_CACHE_MIN, Math.ceil(allSampleIds.length * 0.22)),
  );
  const useFullIndex = allSampleIds.length <= FULL_INDEX_SAMPLE_LIMIT;
  const sampleTextIndex = useFullIndex ? new Map<string, string>() : null;
  const onDemandTextCache = useFullIndex ? null : new Map<string, string>();
  const sampleIdIndex = new Map<string, number[]>();
  const sampleIdPrefixIndex = new Map<string, number[]>();
  const prefixIndex = new Map<string, number[]>();
  const exactTokenIndex = new Map<string, number[]>();
  const saturatedSampleIdPrefixes = new Set<string>();
  const saturatedPrefixTokens = new Set<string>();
  const saturatedExactTokens = new Set<string>();

  for (let index = 0; index < allSampleIds.length; index += 1) {
    const sampleId = allSampleIds[index];
    if (!sampleId) {
      continue;
    }
    const normalizedSampleId = normalizeSearchText(sampleId);
    const exactSampleIdPosting = sampleIdIndex.get(normalizedSampleId);
    if (exactSampleIdPosting) {
      exactSampleIdPosting.push(index);
    } else {
      sampleIdIndex.set(normalizedSampleId, [index]);
    }
    for (
      let prefixLength = MIN_SAMPLE_ID_PREFIX_LENGTH;
      prefixLength < normalizedSampleId.length;
      prefixLength += 1
    ) {
      const prefix = normalizedSampleId.slice(0, prefixLength);
      appendPostingWithLimit(sampleIdPrefixIndex, saturatedSampleIdPrefixes, prefix, index);
    }
    const artifacts = buildSampleSearchArtifacts(preview, sampleId);
    for (let prefixPosition = 0; prefixPosition < artifacts.prefixes.length; prefixPosition += 1) {
      const prefix = artifacts.prefixes[prefixPosition];
      if (!prefix) {
        continue;
      }
      appendPostingWithLimit(prefixIndex, saturatedPrefixTokens, prefix, index);
    }
    for (let tokenIndex = 0; tokenIndex < artifacts.exactTokens.length; tokenIndex += 1) {
      const token = artifacts.exactTokens[tokenIndex];
      if (!token) {
        continue;
      }
      appendPostingWithLimit(exactTokenIndex, saturatedExactTokens, token, index);
    }
    if (sampleTextIndex) {
      sampleTextIndex.set(sampleId, artifacts.searchText);
    }
  }
  const compactPrefixIndex = compactPostingIndex(prefixIndex);
  const compactExactTokenIndex = compactPostingIndex(exactTokenIndex);

  const getSearchText = (sampleId: string): string => {
    if (sampleTextIndex) {
      return sampleTextIndex.get(sampleId) ?? normalizeSearchText(sampleId);
    }
    if (!onDemandTextCache) {
      return normalizeSearchText(sampleId);
    }
    const cached = getLruEntry(onDemandTextCache, sampleId);
    if (cached !== undefined) {
      return cached;
    }
    const built = buildSampleSearchText(preview, sampleId);
    updateLruEntry(onDemandTextCache, sampleId, built, onDemandTextCacheLimit);
    return built;
  };

  let lastNormalizedQuery = '';
  let lastMatched: string[] = allSampleIds;

  const selectSeedFromTokens = (tokens: string[]): string[] | null => {
    const postingLists: PostingList[] = [];
    for (const token of tokens) {
      if (token.length < MIN_PREFIX_TOKEN_LENGTH) {
        continue;
      }
      const exactPostingList = compactExactTokenIndex.get(token);
      if (exactPostingList?.length) {
        postingLists.push(exactPostingList);
        continue;
      }
      const prefix = token.slice(0, Math.min(TOKEN_PREFIX_LENGTH, token.length));
      const postingList = compactPrefixIndex.get(prefix);
      if (!postingList || !postingList.length) {
        if (!saturatedPrefixTokens.has(prefix) && !saturatedExactTokens.has(token)) {
          return [];
        }
        continue;
      }
      postingLists.push(postingList);
    }
    if (!postingLists.length) {
      return null;
    }
    postingLists.sort((left, right) => left.length - right.length);
    let candidateIndices = postingLists[0];
    const mergeLimit = Math.min(MAX_INTERSECTION_MERGES, postingLists.length);
    for (let index = 1; index < mergeLimit; index += 1) {
      if (!candidateIndices.length) {
        break;
      }
      if (candidateIndices.length <= INTERSECTION_TARGET_CANDIDATES) {
        break;
      }
      candidateIndices = intersectSortedIndices(candidateIndices, postingLists[index]);
    }

    const candidates: string[] = [];
    for (let index = 0; index < candidateIndices.length; index += 1) {
      const sampleIndex = candidateIndices[index];
      const sampleId = allSampleIds[sampleIndex];
      if (sampleId !== undefined) {
        candidates.push(sampleId);
      }
    }
    return candidates;
  };

  return {
    filter(query: string): string[] {
      const normalizedQuery = normalizeQuery(query);
      if (!normalizedQuery) {
        lastNormalizedQuery = '';
        lastMatched = allSampleIds;
        return allSampleIds;
      }
      if (normalizedQuery.length < MIN_QUERY_TOKEN_LENGTH) {
        lastNormalizedQuery = '';
        lastMatched = allSampleIds;
        return allSampleIds;
      }
      if (normalizedQuery === lastNormalizedQuery) {
        return lastMatched;
      }
      const singularSampleIdQuery = normalizedQuery.includes(' ') ? '' : normalizedQuery;
      if (singularSampleIdQuery && SAMPLE_ID_LIKE_REGEX.test(singularSampleIdQuery)) {
        const exactSampleIdMatches = sampleIdIndex.get(singularSampleIdQuery);
        if (exactSampleIdMatches?.length) {
          const matched = exactSampleIdMatches
            .map((index) => allSampleIds[index])
            .filter((sampleId): sampleId is string => Boolean(sampleId));
          lastNormalizedQuery = normalizedQuery;
          lastMatched = matched;
          if (matched.length <= QUERY_RESULT_CACHEABLE_MATCH_LIMIT) {
            updateLruEntry(queryResultCache, normalizedQuery, matched, QUERY_RESULT_CACHE_LIMIT);
          }
          return matched;
        }
        if (singularSampleIdQuery.length >= MIN_SAMPLE_ID_PREFIX_LENGTH) {
          const prefixSampleIdMatches = sampleIdPrefixIndex.get(singularSampleIdQuery);
          if (prefixSampleIdMatches?.length) {
            const matched = prefixSampleIdMatches
              .map((index) => allSampleIds[index])
              .filter((sampleId): sampleId is string => Boolean(sampleId));
            lastNormalizedQuery = normalizedQuery;
            lastMatched = matched;
            if (matched.length <= QUERY_RESULT_CACHEABLE_MATCH_LIMIT) {
              updateLruEntry(queryResultCache, normalizedQuery, matched, QUERY_RESULT_CACHE_LIMIT);
            }
            return matched;
          }
          if (!saturatedSampleIdPrefixes.has(singularSampleIdQuery)) {
            lastNormalizedQuery = normalizedQuery;
            lastMatched = [];
            updateLruEntry(queryResultCache, normalizedQuery, lastMatched, QUERY_RESULT_CACHE_LIMIT);
            return lastMatched;
          }
        }
      }

      const cached = getLruEntry(queryResultCache, normalizedQuery);
      if (cached !== undefined) {
        lastNormalizedQuery = normalizedQuery;
        lastMatched = cached;
        return cached;
      }

      const cachedQueryTokens = getLruEntry(queryTokenCache, normalizedQuery);
      const tokens = cachedQueryTokens
        ?? (() => {
          const built = tokenizeQuery(normalizedQuery);
          built.sort((left, right) => right.length - left.length);
          updateLruEntry(queryTokenCache, normalizedQuery, built, QUERY_TOKEN_CACHE_LIMIT);
          return built;
        })();
      if (!tokens.length) {
        lastNormalizedQuery = '';
        lastMatched = allSampleIds;
        return allSampleIds;
      }
      const incrementalSeed =
        lastNormalizedQuery && normalizedQuery.startsWith(lastNormalizedQuery) ? lastMatched : null;
      const prefixSeedSamples = selectSeedFromTokens(tokens);
      const seedSamples = incrementalSeed ?? prefixSeedSamples ?? allSampleIds;
      const matched: string[] = [];

      for (const sampleId of seedSamples) {
        const searchableText = getSearchText(sampleId);
        let isMatch = true;
        for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
          if (!searchableText.includes(tokens[tokenIndex])) {
            isMatch = false;
            break;
          }
        }
        if (isMatch) {
          matched.push(sampleId);
        }
      }

      if (matched.length <= QUERY_RESULT_CACHEABLE_MATCH_LIMIT) {
        updateLruEntry(queryResultCache, normalizedQuery, matched, QUERY_RESULT_CACHE_LIMIT);
      }
      lastNormalizedQuery = normalizedQuery;
      lastMatched = matched;
      return matched;
    },
  };
}
