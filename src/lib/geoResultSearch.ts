import type { GeoSearchResult } from './geoSearch';

const QUERY_RESULT_CACHE_LIMIT = 24;
const QUERY_TOKEN_CACHE_LIMIT = 72;
const QUERY_RESULT_CACHEABLE_MATCH_LIMIT = 1400;
const STATUS_SNAPSHOT_CACHE_LIMIT = 12;
const FULL_INDEX_RESULT_LIMIT = 240;
const ON_DEMAND_TEXT_CACHE_LIMIT = 640;
const ON_DEMAND_TEXT_CACHE_MIN = 160;
const MIN_QUERY_TOKEN_LENGTH = 2;
const MAX_QUERY_TOKENS = 14;
const TOKEN_PREFIX_LENGTH = 3;
const MIN_PREFIX_TOKEN_LENGTH = 2;
const MAX_PREFIXES_PER_RESULT = 64;
const MAX_EXACT_TOKENS_PER_RESULT = 96;
const MIN_ACCESSION_PREFIX_LENGTH = 4;
const MAX_POSTING_LIST_SIZE = 768;
const TYPED_POSTING_LIST_MIN_LENGTH = 32;
const MAX_INTERSECTION_MERGES = 6;
const INTERSECTION_TARGET_CANDIDATES = 96;
const MAX_FILTER_TERMS = 24;
const NON_ALPHANUMERIC_REGEX = /[^a-z0-9]+/g;
const MULTISPACE_REGEX = /\s+/g;
type PostingList = number[] | Uint32Array;
type SearchField = 'accession' | 'title' | 'summary' | 'organism' | 'pmid';

interface FieldConstraintPlan {
  field: SearchField;
  includeTokens: string[];
  excludeTokens: string[];
  includePhrases: string[];
  excludePhrases: string[];
}

interface ParsedQueryPlan {
  cacheKey: string;
  includeTokens: string[];
  excludeTokens: string[];
  includePhrases: string[];
  excludePhrases: string[];
  includeByField: Record<SearchField, string[]>;
  excludeByField: Record<SearchField, string[]>;
  includePhrasesByField: Record<SearchField, string[]>;
  excludePhrasesByField: Record<SearchField, string[]>;
  hasConstraints: boolean;
  hasFieldFilters: boolean;
  constrainedFields: SearchField[];
  fieldConstraintPlans: FieldConstraintPlan[];
  isSimpleIncludeOnly: boolean;
  seedTokens: string[];
}

interface NormalizedSearchFields {
  accession: string;
  title: string;
  summary: string;
  organism: string;
  pmid: string;
}

const QUERY_FIELD_ALIASES: Record<string, SearchField> = {
  accession: 'accession',
  acc: 'accession',
  gse: 'accession',
  title: 'title',
  summary: 'summary',
  abstract: 'summary',
  organism: 'organism',
  species: 'organism',
  pmid: 'pmid',
};
const QUERY_FIELDS: SearchField[] = ['accession', 'title', 'summary', 'organism', 'pmid'];
const QUERY_TOKEN_REGEX = /(-)?([a-z]+:)?(?:"([^"]+)"|(\S+))/gi;

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_REGEX, ' ')
    .replace(MULTISPACE_REGEX, ' ')
    .trim();
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

function getIndexTextLimit(resultCount: number): number {
  if (resultCount >= 1600) {
    return 280;
  }
  if (resultCount >= 800) {
    return 360;
  }
  if (resultCount >= 400) {
    return 480;
  }
  return 720;
}

function truncateIndexText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return '';
  }
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return trimmed.slice(0, maxLength);
}

function buildResultSearchTextFromFields(
  accession: string,
  normalizedTitle: string,
  normalizedSummary: string,
  normalizedOrganism: string,
  normalizedPmid: string,
): string {
  let merged = '';
  if (accession) {
    merged = accession;
  }
  if (normalizedTitle) {
    merged = merged ? `${merged} ${normalizedTitle}` : normalizedTitle;
  }
  if (normalizedSummary) {
    merged = merged ? `${merged} ${normalizedSummary}` : normalizedSummary;
  }
  if (normalizedOrganism) {
    merged = merged ? `${merged} ${normalizedOrganism}` : normalizedOrganism;
  }
  if (normalizedPmid) {
    merged = merged ? `${merged} ${normalizedPmid}` : normalizedPmid;
  }
  return merged;
}

function collectTokenPrefixes(
  normalizedText: string,
  target: Set<string>,
  maxTokens: number,
): void {
  if (!normalizedText || target.size >= maxTokens) {
    return;
  }
  const length = normalizedText.length;
  let cursor = 0;
  while (cursor < length && target.size < maxTokens) {
    while (cursor < length && normalizedText[cursor] === ' ') {
      cursor += 1;
    }
    if (cursor >= length) {
      break;
    }
    const start = cursor;
    while (cursor < length && normalizedText[cursor] !== ' ') {
      cursor += 1;
    }
    const tokenLength = cursor - start;
    if (tokenLength < MIN_PREFIX_TOKEN_LENGTH) {
      continue;
    }
    const end = start + Math.min(TOKEN_PREFIX_LENGTH, tokenLength);
    target.add(normalizedText.slice(start, end));
  }
}

function collectExactTokens(
  normalizedText: string,
  target: Set<string>,
  maxTokens: number,
): void {
  if (!normalizedText || target.size >= maxTokens) {
    return;
  }
  const length = normalizedText.length;
  let cursor = 0;
  while (cursor < length && target.size < maxTokens) {
    while (cursor < length && normalizedText[cursor] === ' ') {
      cursor += 1;
    }
    if (cursor >= length) {
      break;
    }
    const start = cursor;
    while (cursor < length && normalizedText[cursor] !== ' ') {
      cursor += 1;
    }
    const tokenLength = cursor - start;
    if (tokenLength < MIN_PREFIX_TOKEN_LENGTH) {
      continue;
    }
    target.add(normalizedText.slice(start, cursor));
  }
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

function normalizeQuery(query: string): string {
  return normalizeSearchText(query);
}

function createEmptyFieldTokenRecord(): Record<SearchField, string[]> {
  return {
    accession: [],
    title: [],
    summary: [],
    organism: [],
    pmid: [],
  };
}

function hasAdvancedQuerySyntax(query: string): boolean {
  const length = query.length;
  for (let index = 0; index < length; index += 1) {
    const char = query[index];
    if (char === '"' || char === ':') {
      return true;
    }
    if (
      char === '-' &&
      (index === 0 || query[index - 1] === ' ') &&
      index + 1 < length &&
      query[index + 1] !== ' '
    ) {
      return true;
    }
  }
  return false;
}

function buildSimpleParsedQueryPlan(query: string): ParsedQueryPlan {
  const normalized = normalizeQuery(query);
  const includeTokens = tokenizeQuery(normalized);
  const cacheTokens = [...includeTokens];
  cacheTokens.sort();
  const seedTokens = [...includeTokens].sort((left, right) => right.length - left.length);
  return {
    cacheKey: cacheTokens.join(','),
    includeTokens,
    excludeTokens: [],
    includePhrases: [],
    excludePhrases: [],
    includeByField: createEmptyFieldTokenRecord(),
    excludeByField: createEmptyFieldTokenRecord(),
    includePhrasesByField: createEmptyFieldTokenRecord(),
    excludePhrasesByField: createEmptyFieldTokenRecord(),
    hasConstraints: includeTokens.length > 0,
    hasFieldFilters: false,
    constrainedFields: [],
    fieldConstraintPlans: [],
    isSimpleIncludeOnly: includeTokens.length > 0,
    seedTokens,
  };
}

function buildParsedQueryPlan(query: string): ParsedQueryPlan {
  if (!hasAdvancedQuerySyntax(query)) {
    return buildSimpleParsedQueryPlan(query);
  }
  const includeTokens: string[] = [];
  const excludeTokens: string[] = [];
  const includePhrases: string[] = [];
  const excludePhrases: string[] = [];
  const includeByField = createEmptyFieldTokenRecord();
  const excludeByField = createEmptyFieldTokenRecord();
  const includePhrasesByField = createEmptyFieldTokenRecord();
  const excludePhrasesByField = createEmptyFieldTokenRecord();
  const includeTokenSet = new Set<string>();
  const excludeTokenSet = new Set<string>();
  const includePhraseSet = new Set<string>();
  const excludePhraseSet = new Set<string>();
  const includeFieldTokenSets: Record<SearchField, Set<string>> = {
    accession: new Set<string>(),
    title: new Set<string>(),
    summary: new Set<string>(),
    organism: new Set<string>(),
    pmid: new Set<string>(),
  };
  const excludeFieldTokenSets: Record<SearchField, Set<string>> = {
    accession: new Set<string>(),
    title: new Set<string>(),
    summary: new Set<string>(),
    organism: new Set<string>(),
    pmid: new Set<string>(),
  };
  const includeFieldPhraseSets: Record<SearchField, Set<string>> = {
    accession: new Set<string>(),
    title: new Set<string>(),
    summary: new Set<string>(),
    organism: new Set<string>(),
    pmid: new Set<string>(),
  };
  const excludeFieldPhraseSets: Record<SearchField, Set<string>> = {
    accession: new Set<string>(),
    title: new Set<string>(),
    summary: new Set<string>(),
    organism: new Set<string>(),
    pmid: new Set<string>(),
  };
  let totalTerms = 0;
  QUERY_TOKEN_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = QUERY_TOKEN_REGEX.exec(query)) !== null && totalTerms < MAX_FILTER_TERMS) {
    const isExcluded = Boolean(match[1]);
    const fieldLabel = (match[2] ?? '').slice(0, -1).toLowerCase();
    const valueRaw = (match[3] ?? match[4] ?? '').trim();
    if (!valueRaw) {
      continue;
    }
    const normalizedValue = normalizeQuery(valueRaw);
    if (!normalizedValue) {
      continue;
    }
    const isQuotedPhrase = Boolean(match[3]);
    const field = fieldLabel ? QUERY_FIELD_ALIASES[fieldLabel] : undefined;
    if (isQuotedPhrase) {
      if (field) {
        if (isExcluded) {
          const seen = excludeFieldPhraseSets[field];
          if (seen.has(normalizedValue)) {
            continue;
          }
          seen.add(normalizedValue);
          excludePhrasesByField[field].push(normalizedValue);
        } else {
          const seen = includeFieldPhraseSets[field];
          if (seen.has(normalizedValue)) {
            continue;
          }
          seen.add(normalizedValue);
          includePhrasesByField[field].push(normalizedValue);
        }
        totalTerms += 1;
        continue;
      }
      if (isExcluded) {
        if (excludePhraseSet.has(normalizedValue)) {
          continue;
        }
        excludePhraseSet.add(normalizedValue);
        excludePhrases.push(normalizedValue);
        totalTerms += 1;
        continue;
      }
      if (includePhraseSet.has(normalizedValue)) {
        continue;
      }
      includePhraseSet.add(normalizedValue);
      includePhrases.push(normalizedValue);
      totalTerms += 1;
      continue;
    }
    const normalizedTerms = tokenizeQuery(normalizedValue);
    if (!normalizedTerms.length) {
      continue;
    }
    for (let termIndex = 0; termIndex < normalizedTerms.length && totalTerms < MAX_FILTER_TERMS; termIndex += 1) {
      const term = normalizedTerms[termIndex];
      if (field) {
        if (isExcluded) {
          const seen = excludeFieldTokenSets[field];
          if (seen.has(term)) {
            continue;
          }
          seen.add(term);
          excludeByField[field].push(term);
        } else {
          const seen = includeFieldTokenSets[field];
          if (seen.has(term)) {
            continue;
          }
          seen.add(term);
          includeByField[field].push(term);
        }
        totalTerms += 1;
        continue;
      }
      if (isExcluded) {
        if (excludeTokenSet.has(term)) {
          continue;
        }
        excludeTokenSet.add(term);
        excludeTokens.push(term);
      } else {
        if (includeTokenSet.has(term)) {
          continue;
        }
        includeTokenSet.add(term);
        includeTokens.push(term);
      }
      totalTerms += 1;
    }
  }
  const hasFieldFilters = QUERY_FIELDS.some((field) => (
    includeByField[field].length > 0 ||
    excludeByField[field].length > 0 ||
    includePhrasesByField[field].length > 0 ||
    excludePhrasesByField[field].length > 0
  ));
  const constrainedFields: SearchField[] = [];
  const fieldConstraintPlans: FieldConstraintPlan[] = [];
  if (hasFieldFilters) {
    for (let fieldIndex = 0; fieldIndex < QUERY_FIELDS.length; fieldIndex += 1) {
      const field = QUERY_FIELDS[fieldIndex];
      const includeTokensByField = includeByField[field];
      const excludeTokensByField = excludeByField[field];
      const includePhrasesForField = includePhrasesByField[field];
      const excludePhrasesForField = excludePhrasesByField[field];
      if (
        includeTokensByField.length > 0 ||
        excludeTokensByField.length > 0 ||
        includePhrasesForField.length > 0 ||
        excludePhrasesForField.length > 0
      ) {
        constrainedFields.push(field);
        fieldConstraintPlans.push({
          field,
          includeTokens: includeTokensByField,
          excludeTokens: excludeTokensByField,
          includePhrases: includePhrasesForField,
          excludePhrases: excludePhrasesForField,
        });
      }
    }
  }
  const seedTokens = [...includeTokens];
  const seenSeedTokens = new Set(seedTokens);
  for (let phraseIndex = 0; phraseIndex < includePhrases.length; phraseIndex += 1) {
    const phraseTokens = tokenizeQuery(includePhrases[phraseIndex] ?? '');
    const first = phraseTokens[0];
    if (first && !seenSeedTokens.has(first)) {
      seenSeedTokens.add(first);
      seedTokens.push(first);
    }
  }
  for (let fieldIndex = 0; fieldIndex < QUERY_FIELDS.length; fieldIndex += 1) {
    const field = QUERY_FIELDS[fieldIndex];
    const fieldPhrases = includePhrasesByField[field];
    for (let phraseIndex = 0; phraseIndex < fieldPhrases.length; phraseIndex += 1) {
      const phraseTokens = tokenizeQuery(fieldPhrases[phraseIndex] ?? '');
      const first = phraseTokens[0];
      if (first && !seenSeedTokens.has(first)) {
        seenSeedTokens.add(first);
        seedTokens.push(first);
      }
    }
  }
  seedTokens.sort((left, right) => right.length - left.length);
  return {
    cacheKey: [
      includeTokens.join(','),
      excludeTokens.join(','),
      includePhrases.join(','),
      excludePhrases.join(','),
      QUERY_FIELDS.map((field) => includeByField[field].join(',')).join('|'),
      QUERY_FIELDS.map((field) => excludeByField[field].join(',')).join('|'),
      QUERY_FIELDS.map((field) => includePhrasesByField[field].join(',')).join('|'),
      QUERY_FIELDS.map((field) => excludePhrasesByField[field].join(',')).join('|'),
    ].join('||'),
    includeTokens,
    excludeTokens,
    includePhrases,
    excludePhrases,
    includeByField,
    excludeByField,
    includePhrasesByField,
    excludePhrasesByField,
    hasConstraints: (
      includeTokens.length > 0 ||
      excludeTokens.length > 0 ||
      includePhrases.length > 0 ||
      excludePhrases.length > 0 ||
      hasFieldFilters
    ),
    hasFieldFilters,
    constrainedFields,
    fieldConstraintPlans,
    isSimpleIncludeOnly: (
      includeTokens.length > 0 &&
      !excludeTokens.length &&
      !includePhrases.length &&
      !excludePhrases.length &&
      !hasFieldFilters
    ),
    seedTokens,
  };
}

export interface GeoResultSearchEngine {
  filterSnapshot: (
    query: string,
    statusByIndexOverride?: GeoResultStatusSource,
    statusSourceCacheKey?: string,
  ) => GeoResultFilterSnapshot;
  filterIndices: (
    query: string,
    statusFilter?: 'all' | GeoSearchResult['eligibilityStatus'],
    statusByIndexOverride?: GeoResultStatusSource,
    statusSourceCacheKey?: string,
  ) => number[];
}

export interface GeoResultFilterSnapshot {
  allIndices: number[];
  statusIndices: Record<GeoSearchResult['eligibilityStatus'], number[]>;
  counts: {
    all: number;
    eligible: number;
    checking: number;
    excluded: number;
  };
}

export type GeoResultStatusSource =
  | GeoSearchResult['eligibilityStatus'][]
  | ((index: number) => GeoSearchResult['eligibilityStatus'] | undefined);

const EMPTY_INDICES: number[] = [];
const EMPTY_GEO_FILTER_SNAPSHOT: GeoResultFilterSnapshot = {
  allIndices: EMPTY_INDICES,
  statusIndices: {
    eligible: EMPTY_INDICES,
    checking: EMPTY_INDICES,
    excluded: EMPTY_INDICES,
  },
  counts: {
    all: 0,
    eligible: 0,
    checking: 0,
    excluded: 0,
  },
};

function readStatusFromSource(
  statusSource: GeoResultStatusSource,
  index: number,
): GeoSearchResult['eligibilityStatus'] | undefined {
  if (typeof statusSource === 'function') {
    return statusSource(index);
  }
  return statusSource[index];
}

export function createGeoResultSearchEngine(results: GeoSearchResult[]): GeoResultSearchEngine {
  const queryResultCache = new Map<string, number[]>();
  const queryPlanCache = new Map<string, ParsedQueryPlan>();
  const onDemandTextCacheLimit = Math.min(
    ON_DEMAND_TEXT_CACHE_LIMIT,
    Math.max(ON_DEMAND_TEXT_CACHE_MIN, Math.ceil(results.length * 0.2)),
  );
  const indexTextLimit = getIndexTextLimit(results.length);
  const accessionIndex = new Map<string, number[]>();
  const accessionPrefixIndex = new Map<string, number[]>();
  const usePrecomputedText = results.length <= FULL_INDEX_RESULT_LIMIT;
  const searchableTextByIndex = usePrecomputedText ? new Array<string>(results.length) : null;
  const searchableFieldsByIndex = usePrecomputedText ? new Array<NormalizedSearchFields>(results.length) : null;
  const onDemandTextCache = usePrecomputedText ? null : new Map<number, string>();
  const onDemandFieldCache = usePrecomputedText ? null : new Map<number, NormalizedSearchFields>();
  const prefixIndex = new Map<string, number[]>();
  const exactTokenIndex = new Map<string, number[]>();
  const saturatedAccessionPrefixes = new Set<string>();
  const saturatedPrefixTokens = new Set<string>();
  const saturatedExactTokens = new Set<string>();
  const allIndices = new Array<number>(results.length);
  const statusByIndex = new Array<GeoSearchResult['eligibilityStatus']>(results.length);
  const statusSnapshotCacheByIndices = new WeakMap<number[], Map<string, GeoResultFilterSnapshot>>();
  const prefixScratch = new Set<string>();
  const exactScratch = new Set<string>();

  for (let index = 0; index < results.length; index += 1) {
    const result = results[index];
    allIndices[index] = index;
    const normalizedAccession = normalizeSearchText(result.accession);
    const normalizedTitle = normalizeSearchText(truncateIndexText(result.title, indexTextLimit));
    const normalizedSummary = normalizeSearchText(truncateIndexText(result.summary, indexTextLimit));
    const normalizedOrganism = normalizeSearchText(truncateIndexText(result.organism, indexTextLimit));
    const normalizedPmid = normalizeSearchText(result.pubmedId ?? '');
    if (searchableFieldsByIndex) {
      searchableFieldsByIndex[index] = {
        accession: normalizedAccession,
        title: normalizedTitle,
        summary: normalizedSummary,
        organism: normalizedOrganism,
        pmid: normalizedPmid,
      };
    }
    if (searchableTextByIndex) {
      searchableTextByIndex[index] = buildResultSearchTextFromFields(
        normalizedAccession,
        normalizedTitle,
        normalizedSummary,
        normalizedOrganism,
        normalizedPmid,
      );
    }
    statusByIndex[index] = result.eligibilityStatus;
    const accessionPosting = accessionIndex.get(normalizedAccession);
    if (accessionPosting) {
      accessionPosting.push(index);
    } else {
      accessionIndex.set(normalizedAccession, [index]);
    }
    for (
      let prefixLength = MIN_ACCESSION_PREFIX_LENGTH;
      prefixLength < normalizedAccession.length;
      prefixLength += 1
    ) {
      const prefix = normalizedAccession.slice(0, prefixLength);
      appendPostingWithLimit(accessionPrefixIndex, saturatedAccessionPrefixes, prefix, index);
    }

    prefixScratch.clear();
    collectTokenPrefixes(normalizedAccession, prefixScratch, MAX_PREFIXES_PER_RESULT);
    collectTokenPrefixes(normalizedTitle, prefixScratch, MAX_PREFIXES_PER_RESULT);
    collectTokenPrefixes(normalizedSummary, prefixScratch, MAX_PREFIXES_PER_RESULT);
    collectTokenPrefixes(normalizedOrganism, prefixScratch, MAX_PREFIXES_PER_RESULT);
    collectTokenPrefixes(normalizedPmid, prefixScratch, MAX_PREFIXES_PER_RESULT);
    for (const prefix of prefixScratch) {
      appendPostingWithLimit(prefixIndex, saturatedPrefixTokens, prefix, index);
    }

    exactScratch.clear();
    collectExactTokens(normalizedAccession, exactScratch, MAX_EXACT_TOKENS_PER_RESULT);
    collectExactTokens(normalizedTitle, exactScratch, MAX_EXACT_TOKENS_PER_RESULT);
    collectExactTokens(normalizedSummary, exactScratch, MAX_EXACT_TOKENS_PER_RESULT);
    collectExactTokens(normalizedOrganism, exactScratch, MAX_EXACT_TOKENS_PER_RESULT);
    collectExactTokens(normalizedPmid, exactScratch, MAX_EXACT_TOKENS_PER_RESULT);
    for (const token of exactScratch) {
      appendPostingWithLimit(exactTokenIndex, saturatedExactTokens, token, index);
    }
  }
  const compactPrefixIndex = compactPostingIndex(prefixIndex);
  const compactExactTokenIndex = compactPostingIndex(exactTokenIndex);

  const getNormalizedFieldsByIndex = (index: number): NormalizedSearchFields => {
    if (searchableFieldsByIndex) {
      return searchableFieldsByIndex[index] ?? {
        accession: '',
        title: '',
        summary: '',
        organism: '',
        pmid: '',
      };
    }
    if (!onDemandFieldCache) {
      return {
        accession: '',
        title: '',
        summary: '',
        organism: '',
        pmid: '',
      };
    }
    const cached = getLruEntry(onDemandFieldCache, index);
    if (cached !== undefined) {
      return cached;
    }
    const result = results[index];
    if (!result) {
      return {
        accession: '',
        title: '',
        summary: '',
        organism: '',
        pmid: '',
      };
    }
    const built = {
      accession: normalizeSearchText(result.accession),
      title: normalizeSearchText(truncateIndexText(result.title, indexTextLimit)),
      summary: normalizeSearchText(truncateIndexText(result.summary, indexTextLimit)),
      organism: normalizeSearchText(truncateIndexText(result.organism, indexTextLimit)),
      pmid: normalizeSearchText(result.pubmedId ?? ''),
    };
    updateLruEntry(onDemandFieldCache, index, built, onDemandTextCacheLimit);
    return built;
  };

  const getSearchTextByIndex = (index: number): string => {
    if (searchableTextByIndex) {
      return searchableTextByIndex[index] ?? '';
    }
    if (!onDemandTextCache) {
      return '';
    }
    const cached = getLruEntry(onDemandTextCache, index);
    if (cached !== undefined) {
      return cached;
    }
    const fields = getNormalizedFieldsByIndex(index);
    const built = buildResultSearchTextFromFields(
      fields.accession,
      fields.title,
      fields.summary,
      fields.organism,
      fields.pmid,
    );
    updateLruEntry(onDemandTextCache, index, built, onDemandTextCacheLimit);
    return built;
  };

  const buildSnapshotFromIndices = (
    indices: number[],
    statusByIndexSource: GeoResultStatusSource = statusByIndex,
  ): GeoResultFilterSnapshot => {
    if (!indices.length) {
      return EMPTY_GEO_FILTER_SNAPSHOT;
    }
    const perStatus: Record<GeoSearchResult['eligibilityStatus'], number[]> = {
      eligible: [],
      checking: [],
      excluded: [],
    };
    for (let i = 0; i < indices.length; i += 1) {
      const index = indices[i];
      const status = readStatusFromSource(statusByIndexSource, index);
      if (status) {
        perStatus[status].push(index);
      }
    }
    return {
      allIndices: indices,
      statusIndices: perStatus,
      counts: {
        all: indices.length,
        eligible: perStatus.eligible.length,
        checking: perStatus.checking.length,
        excluded: perStatus.excluded.length,
      },
    };
  };
  const defaultAllSnapshot = buildSnapshotFromIndices(allIndices, statusByIndex);
  let lastQueryCacheKey = '';
  let lastMatchedIndices = allIndices;
  let lastSnapshot: GeoResultFilterSnapshot | null = defaultAllSnapshot;
  let lastSnapshotStatusSource: GeoResultStatusSource | null = statusByIndex;
  let lastSnapshotStatusCacheKey: string | null = null;

  const getCachedStatusSnapshot = (
    matchedIndices: number[],
    statusSourceCacheKey: string,
  ): GeoResultFilterSnapshot | undefined => {
    const keyedSnapshots = statusSnapshotCacheByIndices.get(matchedIndices);
    if (!keyedSnapshots) {
      return undefined;
    }
    return getLruEntry(keyedSnapshots, statusSourceCacheKey);
  };

  const cacheStatusSnapshot = (
    matchedIndices: number[],
    statusSourceCacheKey: string,
    snapshot: GeoResultFilterSnapshot,
  ): void => {
    const keyedSnapshots = statusSnapshotCacheByIndices.get(matchedIndices);
    if (keyedSnapshots) {
      updateLruEntry(keyedSnapshots, statusSourceCacheKey, snapshot, STATUS_SNAPSHOT_CACHE_LIMIT);
      return;
    }
    statusSnapshotCacheByIndices.set(
      matchedIndices,
      new Map([[statusSourceCacheKey, snapshot]]),
    );
  };

  const buildAndRememberSnapshot = (
    normalizedQuery: string,
    matchedIndices: number[],
    activeStatusSource: GeoResultStatusSource,
    activeStatusSourceCacheKey?: string,
  ): GeoResultFilterSnapshot => {
    if (!normalizedQuery && matchedIndices === allIndices && activeStatusSource === statusByIndex) {
      lastQueryCacheKey = '';
      lastMatchedIndices = allIndices;
      lastSnapshot = defaultAllSnapshot;
      lastSnapshotStatusSource = statusByIndex;
      lastSnapshotStatusCacheKey = null;
      return defaultAllSnapshot;
    }
    if (activeStatusSource !== statusByIndex && activeStatusSourceCacheKey) {
      const cached = getCachedStatusSnapshot(matchedIndices, activeStatusSourceCacheKey);
      if (cached) {
        lastQueryCacheKey = normalizedQuery;
        lastMatchedIndices = matchedIndices;
        lastSnapshot = cached;
        lastSnapshotStatusSource = activeStatusSource;
        lastSnapshotStatusCacheKey = activeStatusSourceCacheKey;
        return cached;
      }
    }
    lastQueryCacheKey = normalizedQuery;
    lastMatchedIndices = matchedIndices;
    const snapshot = buildSnapshotFromIndices(matchedIndices, activeStatusSource);
    lastSnapshot = snapshot;
    lastSnapshotStatusSource = activeStatusSource;
    lastSnapshotStatusCacheKey = activeStatusSourceCacheKey ?? null;
    if (activeStatusSource !== statusByIndex && activeStatusSourceCacheKey) {
      cacheStatusSnapshot(matchedIndices, activeStatusSourceCacheKey, snapshot);
    }
    return snapshot;
  };

  return {
    filterSnapshot(
      query: string,
      statusByIndexOverride?: GeoResultStatusSource,
      statusSourceCacheKey?: string,
    ): GeoResultFilterSnapshot {
      const activeStatusByIndex = statusByIndexOverride ?? statusByIndex;
      const normalizedStatusSourceCacheKey =
        activeStatusByIndex === statusByIndex ? undefined : statusSourceCacheKey;
      let parsedQuery = getLruEntry(queryPlanCache, query);
      if (!parsedQuery) {
        const built = buildParsedQueryPlan(query);
        parsedQuery = built;
        updateLruEntry(queryPlanCache, query, built, QUERY_TOKEN_CACHE_LIMIT);
        if (built.cacheKey && built.cacheKey !== query) {
          updateLruEntry(queryPlanCache, built.cacheKey, built, QUERY_TOKEN_CACHE_LIMIT);
        }
      }
      const normalizedQuery = parsedQuery.cacheKey;
      if (
        normalizedQuery === lastQueryCacheKey &&
        lastSnapshot &&
        (
          activeStatusByIndex === lastSnapshotStatusSource
          || (
            Boolean(normalizedStatusSourceCacheKey)
            && normalizedStatusSourceCacheKey === lastSnapshotStatusCacheKey
          )
        )
      ) {
        return lastSnapshot;
      }
      if (!normalizedQuery) {
        return buildAndRememberSnapshot('', allIndices, activeStatusByIndex, normalizedStatusSourceCacheKey);
      }
      if (!parsedQuery.hasConstraints) {
        return buildAndRememberSnapshot('', allIndices, activeStatusByIndex, normalizedStatusSourceCacheKey);
      }
      const singularAccessionQuery = (
        parsedQuery.includeTokens.length === 1 &&
        !parsedQuery.excludeTokens.length &&
        !parsedQuery.includePhrases.length &&
        !parsedQuery.excludePhrases.length &&
        !parsedQuery.hasFieldFilters
      ) ? parsedQuery.includeTokens[0] : '';
      const isAccessionLikeQuery = /^gse\d+$/i.test(singularAccessionQuery);
      const accessionMatched = accessionIndex.get(singularAccessionQuery);
      if (isAccessionLikeQuery && accessionMatched) {
        return buildAndRememberSnapshot(
          normalizedQuery,
          accessionMatched,
          activeStatusByIndex,
          normalizedStatusSourceCacheKey,
        );
      }
      if (isAccessionLikeQuery && singularAccessionQuery.length >= MIN_ACCESSION_PREFIX_LENGTH) {
        const accessionPrefixMatched = accessionPrefixIndex.get(singularAccessionQuery);
        if (accessionPrefixMatched) {
          return buildAndRememberSnapshot(
            normalizedQuery,
            accessionPrefixMatched,
            activeStatusByIndex,
            normalizedStatusSourceCacheKey,
          );
        }
        if (!saturatedAccessionPrefixes.has(singularAccessionQuery)) {
          return buildAndRememberSnapshot(
            normalizedQuery,
            EMPTY_INDICES,
            activeStatusByIndex,
            normalizedStatusSourceCacheKey,
          );
        }
      }

      const cached = getLruEntry(queryResultCache, normalizedQuery);
      if (cached !== undefined) {
        return buildAndRememberSnapshot(
          normalizedQuery,
          cached,
          activeStatusByIndex,
          normalizedStatusSourceCacheKey,
        );
      }

      const queryTokens = parsedQuery.seedTokens;
      let candidateIndices: PostingList | number[] | null = null;
      const seedPostingLists: PostingList[] = [];
      for (const token of queryTokens) {
        const exactPosting = compactExactTokenIndex.get(token);
        if (exactPosting?.length) {
          seedPostingLists.push(exactPosting);
          continue;
        }
        if (token.length < MIN_PREFIX_TOKEN_LENGTH) {
          continue;
        }
        const prefix = token.slice(0, Math.min(TOKEN_PREFIX_LENGTH, token.length));
        const prefixPosting = compactPrefixIndex.get(prefix);
        if (!prefixPosting?.length) {
          if (!saturatedPrefixTokens.has(prefix) && !saturatedExactTokens.has(token)) {
            candidateIndices = [];
            break;
          }
          continue;
        }
        seedPostingLists.push(prefixPosting);
      }
      for (const token of parsedQuery.includeByField.accession) {
        const exactPosting = accessionIndex.get(token);
        if (exactPosting?.length) {
          seedPostingLists.push(exactPosting);
          continue;
        }
        if (token.length >= MIN_ACCESSION_PREFIX_LENGTH) {
          const prefixPosting = accessionPrefixIndex.get(token);
          if (prefixPosting?.length) {
            seedPostingLists.push(prefixPosting);
            continue;
          }
          if (!saturatedAccessionPrefixes.has(token)) {
            candidateIndices = [];
            break;
          }
        }
      }
      if (candidateIndices?.length === 0) {
        return buildAndRememberSnapshot(
          normalizedQuery,
          EMPTY_INDICES,
          activeStatusByIndex,
          normalizedStatusSourceCacheKey,
        );
      }
      if (seedPostingLists.length) {
        seedPostingLists.sort((left, right) => left.length - right.length);
        candidateIndices = seedPostingLists[0];
        const mergeLimit = Math.min(MAX_INTERSECTION_MERGES, seedPostingLists.length);
        for (let index = 1; index < mergeLimit; index += 1) {
          if (!candidateIndices.length) {
            break;
          }
          if (candidateIndices.length <= INTERSECTION_TARGET_CANDIDATES) {
            break;
          }
          candidateIndices = intersectSortedIndices(candidateIndices, seedPostingLists[index]);
        }
      }

      const finalCandidateIndices =
        candidateIndices ??
        (lastQueryCacheKey && normalizedQuery.startsWith(lastQueryCacheKey)
          ? lastMatchedIndices
          : allIndices);
      const matched: number[] = [];
      if (parsedQuery.isSimpleIncludeOnly) {
        const includeTokens = parsedQuery.includeTokens;
        for (const index of finalCandidateIndices) {
          const searchable = getSearchTextByIndex(index);
          let matches = true;
          for (let tokenIndex = 0; tokenIndex < includeTokens.length; tokenIndex += 1) {
            if (!searchable.includes(includeTokens[tokenIndex])) {
              matches = false;
              break;
            }
          }
          if (matches) {
            matched.push(index);
          }
        }
        if (matched.length <= QUERY_RESULT_CACHEABLE_MATCH_LIMIT) {
          updateLruEntry(queryResultCache, normalizedQuery, matched, QUERY_RESULT_CACHE_LIMIT);
        }
        return buildAndRememberSnapshot(
          normalizedQuery,
          matched,
          activeStatusByIndex,
          normalizedStatusSourceCacheKey,
        );
      }
      for (const index of finalCandidateIndices) {
        const searchable = getSearchTextByIndex(index);
        let matches = true;
        for (let tokenIndex = 0; tokenIndex < queryTokens.length; tokenIndex += 1) {
          if (!searchable.includes(queryTokens[tokenIndex])) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          continue;
        }
        for (let tokenIndex = 0; tokenIndex < parsedQuery.excludeTokens.length; tokenIndex += 1) {
          if (searchable.includes(parsedQuery.excludeTokens[tokenIndex])) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          continue;
        }
        for (let phraseIndex = 0; phraseIndex < parsedQuery.includePhrases.length; phraseIndex += 1) {
          if (!searchable.includes(parsedQuery.includePhrases[phraseIndex])) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          continue;
        }
        for (let phraseIndex = 0; phraseIndex < parsedQuery.excludePhrases.length; phraseIndex += 1) {
          if (searchable.includes(parsedQuery.excludePhrases[phraseIndex])) {
            matches = false;
            break;
          }
        }
        if (!matches) {
          continue;
        }
        if (parsedQuery.hasFieldFilters) {
          const fields = getNormalizedFieldsByIndex(index);
          const fieldConstraints = parsedQuery.fieldConstraintPlans;
          for (let fieldIndex = 0; fieldIndex < fieldConstraints.length && matches; fieldIndex += 1) {
            const fieldPlan = fieldConstraints[fieldIndex];
            const fieldText = fields[fieldPlan.field];
            for (let tokenIndex = 0; tokenIndex < fieldPlan.includeTokens.length; tokenIndex += 1) {
              if (!fieldText.includes(fieldPlan.includeTokens[tokenIndex])) {
                matches = false;
                break;
              }
            }
            if (!matches) {
              break;
            }
            for (let tokenIndex = 0; tokenIndex < fieldPlan.excludeTokens.length; tokenIndex += 1) {
              if (fieldText.includes(fieldPlan.excludeTokens[tokenIndex])) {
                matches = false;
                break;
              }
            }
            if (!matches) {
              break;
            }
            for (let tokenIndex = 0; tokenIndex < fieldPlan.includePhrases.length; tokenIndex += 1) {
              if (!fieldText.includes(fieldPlan.includePhrases[tokenIndex])) {
                matches = false;
                break;
              }
            }
            if (!matches) {
              break;
            }
            for (let tokenIndex = 0; tokenIndex < fieldPlan.excludePhrases.length; tokenIndex += 1) {
              if (fieldText.includes(fieldPlan.excludePhrases[tokenIndex])) {
                matches = false;
                break;
              }
            }
          }
        }
        if (matches) {
          matched.push(index);
        }
      }

      if (matched.length <= QUERY_RESULT_CACHEABLE_MATCH_LIMIT) {
        updateLruEntry(queryResultCache, normalizedQuery, matched, QUERY_RESULT_CACHE_LIMIT);
      }
      return buildAndRememberSnapshot(
        normalizedQuery,
        matched,
        activeStatusByIndex,
        normalizedStatusSourceCacheKey,
      );
    },
    filterIndices(
      query: string,
      statusFilter = 'all',
      statusByIndexOverride?: GeoResultStatusSource,
      statusSourceCacheKey?: string,
    ): number[] {
      const snapshot = this.filterSnapshot(query, statusByIndexOverride, statusSourceCacheKey);
      if (statusFilter === 'all') {
        return snapshot.allIndices;
      }
      return snapshot.statusIndices[statusFilter];
    },
  };
}
