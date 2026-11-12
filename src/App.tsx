import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useReducer, useRef, useState, useTransition } from 'react';
import { downloadBlob } from './lib/utils';
import { createLocalAnalysisInput, localAnalysisInputFilename } from './lib/localAnalysisInput';
import type {
  GeoSearchResult,
  GeoSearchResponse,
  GeoSearchCacheStats,
} from './lib/geoSearch';
import type {
  GeoAnalysisDesign,
  GeoGroupAssignment,
} from './lib/geo';
import type { WorkbookParseResult } from './types';
import { getReferenceSummaryLite } from './reference/summary';
import { createSampleSearchEngine } from './lib/sampleSearch';
import { createGeoResultSearchEngine } from './lib/geoResultSearch';
import {
  buildGeoResultIndexOrders,
  orderFilteredGeoIndices,
  type GeoResultSortMode,
} from './lib/geoResultOrdering';
import {
  createDesignSession,
  createInitialDraftAnalysisState,
  draftAnalysisReducer,
  type DesignSession,
  findFactorById,
  type IntakeMode,
  NO_BATCH_FACTOR,
} from './lib/builderState';

const NON_ALPHANUMERIC_REGEX = /[^a-z0-9]+/g;
const MULTISPACE_REGEX = /\s+/g;
const GEO_HIGHLIGHT_MAX_TOKENS = 8;
const GEO_HIGHLIGHT_MIN_TOKEN_LENGTH = 2;
const MATCHED_GEO_FIELD_QUERY_CACHE_LIMIT = 18;
const GEO_FILTER_META_TOKENS = new Set(['accession', 'acc', 'gse', 'title', 'summary', 'abstract', 'organism', 'species', 'pmid']);
const EMPTY_MATCHED_FIELDS: string[] = [];

function normalizeSearchText(value: string): string {
  return value
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_REGEX, ' ')
    .replace(MULTISPACE_REGEX, ' ')
    .trim();
}

function tokenizeSearchQuery(query: string): string[] {
  const normalized = normalizeSearchText(query);
  if (!normalized) {
    return [];
  }
  const tokens: string[] = [];
  const seen = new Set<string>();
  const length = normalized.length;
  let cursor = 0;
  while (cursor < length && tokens.length < GEO_HIGHLIGHT_MAX_TOKENS) {
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
    if (cursor - start < GEO_HIGHLIGHT_MIN_TOKEN_LENGTH) {
      continue;
    }
    const token = normalized.slice(start, cursor);
    if (GEO_FILTER_META_TOKENS.has(token)) {
      continue;
    }
    if (seen.has(token)) {
      continue;
    }
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function buildHighlightRegex(tokens: string[]): RegExp | null {
  if (!tokens.length) {
    return null;
  }
  const pattern = tokens
    .filter((token) => token.length >= GEO_HIGHLIGHT_MIN_TOKEN_LENGTH)
    .sort((left, right) => right.length - left.length)
    .map((token) => escapeRegExp(token))
    .join('|');
  if (!pattern) {
    return null;
  }
  return new RegExp(`(${pattern})`, 'ig');
}

function highlightText(value: string, regex: RegExp | null) {
  if (!value || !regex) {
    return value;
  }
  regex.lastIndex = 0;
  if (!regex.test(value)) {
    regex.lastIndex = 0;
    return value;
  }
  regex.lastIndex = 0;
  const parts = value.split(regex);
  if (parts.length <= 1) {
    return value;
  }
  return (
    <>
      {parts.map((part, index) => (
        index % 2 === 1
          ? <mark key={`${part}-${index}`} className="geo-highlight">{part}</mark>
          : <span key={`${part}-${index}`}>{part}</span>
      ))}
    </>
  );
}

function findMatchedGeoFields(dataset: GeoSearchResult, tokens: string[]): string[] {
  if (!tokens.length) {
    return [];
  }
  const normalizedFields = getNormalizedGeoFields(dataset);
  let matchedAccession = false;
  let matchedTitle = false;
  let matchedSummary = false;
  let matchedOrganism = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!matchedAccession && normalizedFields.accession.includes(token)) {
      matchedAccession = true;
    }
    if (!matchedTitle && normalizedFields.title.includes(token)) {
      matchedTitle = true;
    }
    if (!matchedSummary && normalizedFields.summary.includes(token)) {
      matchedSummary = true;
    }
    if (!matchedOrganism && normalizedFields.organism.includes(token)) {
      matchedOrganism = true;
    }
    if (matchedAccession && matchedTitle && matchedSummary && matchedOrganism) {
      break;
    }
  }
  const matched: string[] = [];
  if (matchedAccession) {
    matched.push('accession');
  }
  if (matchedTitle) {
    matched.push('title');
  }
  if (matchedSummary) {
    matched.push('summary');
  }
  if (matchedOrganism) {
    matched.push('organism');
  }
  return matched;
}

interface NormalizedGeoFields {
  accession: string;
  title: string;
  summary: string;
  organism: string;
}

interface GeoSearchProgressSummary {
  rawHitCount: number;
  inspectedCount: number;
  checkingCount: number;
  eligibleCount: number;
  excludedCount: number;
  complete: boolean;
}

interface GeoResultStatusArtifacts {
  signature: string;
}

const normalizedGeoFieldCache = new WeakMap<GeoSearchResult, NormalizedGeoFields>();
const matchedGeoFieldCache = new WeakMap<GeoSearchResult, Map<string, string[]>>();
const GEO_SUMMARY_COMPACT_LIMIT = 220;
const GEO_SUMMARY_COMFORTABLE_LIMIT = 440;
const EMPTY_GEO_RESULT_STATUS_ARTIFACTS: GeoResultStatusArtifacts = {
  signature: '0:0',
};

function getNormalizedGeoFields(dataset: GeoSearchResult): NormalizedGeoFields {
  const cached = normalizedGeoFieldCache.get(dataset);
  if (cached) {
    return cached;
  }
  const normalized: NormalizedGeoFields = {
    accession: normalizeSearchText(dataset.accession),
    title: normalizeSearchText(dataset.title),
    summary: normalizeSearchText(dataset.summary),
    organism: normalizeSearchText(dataset.organism),
  };
  normalizedGeoFieldCache.set(dataset, normalized);
  return normalized;
}

function getCachedMatchedGeoFields(dataset: GeoSearchResult, tokens: string[]): string[] {
  if (!tokens.length) {
    return EMPTY_MATCHED_FIELDS;
  }
  const cacheKey = tokens.join(' ');
  let perDatasetCache = matchedGeoFieldCache.get(dataset);
  if (!perDatasetCache) {
    perDatasetCache = new Map<string, string[]>();
    matchedGeoFieldCache.set(dataset, perDatasetCache);
  }
  const cached = perDatasetCache.get(cacheKey);
  if (cached) {
    perDatasetCache.delete(cacheKey);
    perDatasetCache.set(cacheKey, cached);
    return cached;
  }
  const matched = findMatchedGeoFields(dataset, tokens);
  if (perDatasetCache.size >= MATCHED_GEO_FIELD_QUERY_CACHE_LIMIT) {
    const lruKey = perDatasetCache.keys().next().value;
    if (lruKey !== undefined) {
      perDatasetCache.delete(lruKey);
    }
  }
  perDatasetCache.set(cacheKey, matched);
  return matched;
}

interface SampleDesignRowProps {
  rowIndex: number;
  sampleId: string;
  sampleTitle: string;
  groupValue: GeoGroupAssignment;
  batchValue: string;
  conditionA: string;
  conditionB: string;
  disableGroupEdit: boolean;
  disableBatchEdit: boolean;
  onUpdateGroup: (sampleId: string, value: GeoGroupAssignment) => void;
  onUpdateBatch: (sampleId: string, value: string) => void;
}

const SampleDesignRow = memo(function SampleDesignRow({
  rowIndex,
  sampleId,
  sampleTitle,
  groupValue,
  batchValue,
  conditionA,
  conditionB,
  disableGroupEdit,
  disableBatchEdit,
  onUpdateGroup,
  onUpdateBatch,
}: SampleDesignRowProps) {
  return (
    <div className={`design-row ${rowIndex % 2 === 1 ? 'design-row-alt' : ''}`}>
      <span className="design-cell design-cell-id" title={sampleId}>{sampleId}</span>
      <span className="design-cell design-cell-title" title={sampleTitle || sampleId}>{sampleTitle || '-'}</span>
      <span>
        <select
          value={groupValue}
          disabled={disableGroupEdit}
          onChange={(event) => {
            onUpdateGroup(sampleId, event.target.value as GeoGroupAssignment);
          }}
        >
          <option value="A">A ({conditionA || 'Condition A'})</option>
          <option value="B">B ({conditionB || 'Condition B'})</option>
          <option value="">Exclude</option>
        </select>
      </span>
      <span>
        <input
          type="text"
          value={batchValue}
          placeholder="Batch_1"
          disabled={disableBatchEdit}
          onChange={(event) => {
            onUpdateBatch(sampleId, event.target.value);
          }}
        />
      </span>
    </div>
  );
});

interface GeoResultCardProps {
  dataset: GeoSearchResult;
  isActive: boolean;
  resultPosition: number;
  cardHeight: number;
  isActionDisabled: boolean;
  isPreparingDesign: boolean;
  activeGeoActionKey: string;
  queryTokens: string[];
  highlightRegex: RegExp | null;
  density: GeoResultDensity;
  onActivatePosition: (position: number) => void;
  onPrepare: (dataset: GeoSearchResult) => Promise<void>;
}

const GeoResultCard = memo(function GeoResultCard({
  dataset,
  isActive,
  resultPosition,
  cardHeight,
  isActionDisabled,
  isPreparingDesign,
  activeGeoActionKey,
  queryTokens,
  highlightRegex,
  density,
  onActivatePosition,
  onPrepare,
}: GeoResultCardProps) {
  const hasQuery = queryTokens.length > 0;
  const summaryText = useMemo(() => {
    if (dataset.availabilityCheckFailed) return dataset.eligibilityReason || 'Availability check failed. Retry or open GEO and use private file upload.';
    const summary = dataset.summary || 'No abstract summary available.';
    if (hasQuery) {
      return summary;
    }
    const maxLength = density === 'compact' ? GEO_SUMMARY_COMPACT_LIMIT : GEO_SUMMARY_COMFORTABLE_LIMIT;
    if (summary.length <= maxLength) {
      return summary;
    }
    return `${summary.slice(0, maxLength).trimEnd()}…`;
  }, [dataset.summary, dataset.availabilityCheckFailed, dataset.eligibilityReason, density, hasQuery]);
  const matchedFields = useMemo(
    () => (hasQuery ? getCachedMatchedGeoFields(dataset, queryTokens) : EMPTY_MATCHED_FIELDS),
    [dataset, hasQuery, queryTokens],
  );
  const copyAccession = useCallback(() => {
    if (typeof navigator === 'undefined') {
      return;
    }
    const clipboard = navigator.clipboard;
    if (!clipboard?.writeText) {
      return;
    }
    void clipboard.writeText(dataset.accession).catch(() => {
      // Ignore clipboard permission/runtime failures in non-secure contexts.
    });
  }, [dataset.accession]);

  return (
    <article
      className={`geo-result-card ${density === 'compact' ? 'geo-result-card-compact' : ''} ${isActive ? 'geo-result-card-active' : ''}`}
      style={{ height: `${cardHeight}px` }}
      onMouseEnter={() => {
        onActivatePosition(resultPosition);
      }}
    >
      <div className="geo-result-head">
        <strong>{highlightText(dataset.accession, highlightRegex)}</strong>
        <span
          className={`status-tag ${
            dataset.eligibilityStatus === 'eligible'
              ? 'status-tag-ok'
              : dataset.eligibilityStatus === 'checking'
                ? 'status-tag-pending'
                : 'status-tag-muted'
          }`}
        >
          {dataset.eligibilityStatus === 'eligible'
            ? 'Eligible for builder analysis'
            : dataset.availabilityCheckFailed ? 'Availability check failed' : dataset.eligibilityReason || 'Excluded'}
        </span>
      </div>
      {hasQuery && matchedFields.length > 0 && (
        <p className="geo-match-hint" aria-label={`Matched fields: ${matchedFields.join(', ')}`}>
          Matched in: {matchedFields.join(' · ')}
        </p>
      )}
      <p className="geo-result-title">{highlightText(dataset.title, highlightRegex)}</p>
      <p className="muted-text" title={dataset.summary || 'No abstract summary available.'}>
        {highlightText(summaryText, highlightRegex)}
      </p>
      <p className="muted-text">
        {highlightText(dataset.organism, highlightRegex)} · {dataset.sampleCount.toLocaleString()} samples
        {dataset.pubmedId ? ` · PMID ${dataset.pubmedId}` : ''}
      </p>
      <div className="geo-result-actions">
        <button
          className="file-button"
          disabled={dataset.eligibilityStatus !== 'eligible' || isActionDisabled}
          onClick={() => {
            void onPrepare(dataset);
          }}
        >
          {dataset.eligibilityStatus === 'checking'
            ? 'Checking eligibility…'
            : dataset.availabilityCheckFailed
              ? 'Check unavailable'
              : !dataset.isEligible
              ? 'Excluded from builder'
              : isPreparingDesign && activeGeoActionKey === `setup:${dataset.accession}`
                ? 'Loading samples…'
                : 'Select and setup'}
        </button>
        <a className="link-button" href={dataset.geoUrl} target="_blank" rel="noreferrer">
          Open GEO
        </a>
        <button className="secondary-button" type="button" onClick={copyAccession}>
          Copy accession
        </button>
      </div>
    </article>
  );
});

const DESIGN_TABLE_VIEWPORT_FALLBACK_HEIGHT = 560;
const DESIGN_ROW_HEIGHT = 60;
const DESIGN_ROW_OVERSCAN = 8;
const GEO_RESULTS_VIEWPORT_FALLBACK_HEIGHT = 660;
const GEO_RESULT_CARD_HEIGHT_COMFORTABLE = 224;
const GEO_RESULT_CARD_HEIGHT_COMPACT = 184;
const GEO_RESULT_CARD_HEIGHT_FILTER_BONUS = 32;
const GEO_RESULT_OVERSCAN = 6;
const GEO_PROGRESS_UPDATE_DEBOUNCE_MS = 140;
const GEO_PROGRESS_SIGNATURE_SAMPLE_LIMIT = 192;
const GEO_RESULT_UI_PREFERENCE_STORAGE_KEY = 'pnv.geo.resultUi.v1';
type GeoResultStatusFilter = 'all' | 'eligible' | 'checking' | 'excluded';
type GeoResultDensity = 'comfortable' | 'compact';
type GeoResultUiPreferences = {
  sortMode: GeoResultSortMode;
  density: GeoResultDensity;
};
const DEFAULT_GEO_RESULT_UI_PREFERENCES: GeoResultUiPreferences = {
  sortMode: 'ranked',
  density: 'comfortable',
};
const GEO_RESULT_FILTER_PRESETS: ReadonlyArray<{
  label: string;
  query: string;
  status?: GeoResultStatusFilter;
}> = [
  { label: 'Human cohorts', query: 'organism:homo' },
  { label: 'Raw-count ready', query: 'summary:"raw counts"', status: 'eligible' },
  { label: 'Eligible human RNA-seq', query: 'organism:homo summary:rna', status: 'eligible' },
  { label: 'Large cohorts (100+)', query: 'summary:cohort organism:homo' },
  { label: 'Psoriasis focus', query: 'psoriasis skin', status: 'eligible' },
];

function toDateStamp(now: Date): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}${month}${day}`;
}

function toSafeFilenameToken(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
}

function readGeoResultUiPreferences(): GeoResultUiPreferences {
  if (typeof window === 'undefined' || !window.localStorage) {
    return DEFAULT_GEO_RESULT_UI_PREFERENCES;
  }
  try {
    const raw = window.localStorage.getItem(GEO_RESULT_UI_PREFERENCE_STORAGE_KEY);
    if (!raw) {
      return DEFAULT_GEO_RESULT_UI_PREFERENCES;
    }
    const parsed = JSON.parse(raw) as Partial<GeoResultUiPreferences>;
    const sortMode: GeoResultSortMode =
      parsed.sortMode === 'samples' || parsed.sortMode === 'accession' || parsed.sortMode === 'ranked'
        ? parsed.sortMode
        : DEFAULT_GEO_RESULT_UI_PREFERENCES.sortMode;
    const density: GeoResultDensity =
      parsed.density === 'compact' || parsed.density === 'comfortable'
        ? parsed.density
        : DEFAULT_GEO_RESULT_UI_PREFERENCES.density;
    return { sortMode, density };
  } catch {
    return DEFAULT_GEO_RESULT_UI_PREFERENCES;
  }
}

function buildGeoResultCorpusSignature(results: GeoSearchResult[]): string {
  if (!results.length) {
    return '0:0:0';
  }
  let hash = 2166136261;
  for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
    const accession = results[resultIndex]?.accession ?? '';
    for (let charIndex = 0; charIndex < accession.length; charIndex += 1) {
      hash ^= accession.charCodeAt(charIndex);
      hash = Math.imul(hash, 16777619);
    }
    hash ^= 31;
    hash = Math.imul(hash, 16777619);
  }
  const first = results[0]?.accession ?? '';
  const last = results[results.length - 1]?.accession ?? '';
  return `${results.length}:${hash >>> 0}:${first}:${last}`;
}

function buildGeoProgressSignature(response: GeoSearchResponse): string {
  let hash = 2166136261;
  const totalResults = response.results.length;
  if (totalResults <= GEO_PROGRESS_SIGNATURE_SAMPLE_LIMIT) {
    for (let resultIndex = 0; resultIndex < totalResults; resultIndex += 1) {
      const result = response.results[resultIndex];
      if (!result) {
        continue;
      }
      const accession = result.accession;
      for (let charIndex = 0; charIndex < accession.length; charIndex += 1) {
        hash ^= accession.charCodeAt(charIndex);
        hash = Math.imul(hash, 16777619);
      }
      const statusCode =
        result.eligibilityStatus === 'eligible'
          ? 3
          : result.eligibilityStatus === 'checking'
            ? 2
            : 1;
      hash ^= statusCode;
      hash = Math.imul(hash, 16777619);
      hash ^= result.sampleCount & 0xffff;
      hash = Math.imul(hash, 16777619);
    }
  } else {
    const stride = Math.max(1, Math.floor(totalResults / GEO_PROGRESS_SIGNATURE_SAMPLE_LIMIT));
    for (
      let sampleCursor = 0;
      sampleCursor < GEO_PROGRESS_SIGNATURE_SAMPLE_LIMIT;
      sampleCursor += 1
    ) {
      const sampledIndex = Math.min(sampleCursor * stride, totalResults - 1);
      const result = response.results[sampledIndex];
      if (!result) {
        continue;
      }
      const accession = result.accession;
      for (let charIndex = 0; charIndex < accession.length; charIndex += 1) {
        hash ^= accession.charCodeAt(charIndex);
        hash = Math.imul(hash, 16777619);
      }
      const statusCode =
        result.eligibilityStatus === 'eligible'
          ? 3
          : result.eligibilityStatus === 'checking'
            ? 2
            : 1;
      hash ^= statusCode;
      hash = Math.imul(hash, 16777619);
      hash ^= result.sampleCount & 0xffff;
      hash = Math.imul(hash, 16777619);
      hash ^= sampledIndex & 0xffff;
      hash = Math.imul(hash, 16777619);
    }
  }
  return [
    response.complete ? '1' : '0',
    response.rawHitCount,
    totalResults,
    response.inspectedCount,
    response.checkingCount,
    response.eligibleCount,
    response.excludedCount,
    hash >>> 0,
  ].join(':');
}

function buildGeoResultStatusArtifacts(results: GeoSearchResult[]): GeoResultStatusArtifacts {
  if (!results.length) {
    return EMPTY_GEO_RESULT_STATUS_ARTIFACTS;
  }
  let hash = 2166136261;
  for (let index = 0; index < results.length; index += 1) {
    const status = results[index]?.eligibilityStatus ?? 'excluded';
    const statusCode = status === 'eligible' ? 3 : status === 'checking' ? 2 : 1;
    hash ^= statusCode;
    hash = Math.imul(hash, 16777619);
    hash ^= index & 0xffff;
    hash = Math.imul(hash, 16777619);
  }
  return {
    signature: `${results.length}:${hash >>> 0}`,
  };
}

function toGeoSearchProgressSummary(response: GeoSearchResponse): GeoSearchProgressSummary {
  return {
    rawHitCount: response.rawHitCount,
    inspectedCount: response.inspectedCount,
    checkingCount: response.checkingCount,
    eligibleCount: response.eligibleCount,
    excludedCount: response.excludedCount,
    complete: response.complete,
  };
}

function readTimeNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function isTypingContext(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  );
}

function getGlobalKeydownTarget(): Document | Window {
  if (typeof document !== 'undefined') {
    return document;
  }
  return window;
}

export function App() {
  const geoResultUiPreferences = useMemo(() => readGeoResultUiPreferences(), []);
  const [mode, setMode] = useState<IntakeMode>('public');
  const [isParsing, setIsParsing] = useState(false);
  const [isPreparingDesign, setIsPreparingDesign] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isGeoSearching, setIsGeoSearching] = useState(false);
  const [isGeoHydrating, setIsGeoHydrating] = useState(false);
  const [draftState, dispatch] = useReducer(draftAnalysisReducer, undefined, createInitialDraftAnalysisState);
  const [appError, setAppError] = useState<string>('');
  const [geoError, setGeoError] = useState<string>('');
  const [geoSearchMessage, setGeoSearchMessage] = useState<string>('');
  const [geoQuery, setGeoQuery] = useState<string>('');
  const [geoResults, setGeoResults] = useState<GeoSearchResult[]>([]);
  const [geoResultSearchInput, setGeoResultSearchInput] = useState<string>('');
  const [geoResultStatusFilter, setGeoResultStatusFilter] = useState<GeoResultStatusFilter>('all');
  const [geoResultSortMode, setGeoResultSortMode] = useState<GeoResultSortMode>(geoResultUiPreferences.sortMode);
  const [geoResultDensity, setGeoResultDensity] = useState<GeoResultDensity>(geoResultUiPreferences.density);
  const [geoResultKeyboardCursor, setGeoResultKeyboardCursor] = useState(-1);
  const [geoSearchSummary, setGeoSearchSummary] = useState<GeoSearchProgressSummary | null>(null);
  const [geoResultStatusArtifacts, setGeoResultStatusArtifacts] = useState<GeoResultStatusArtifacts>(
    EMPTY_GEO_RESULT_STATUS_ARTIFACTS,
  );
  const [geoSearchCacheStats, setGeoSearchCacheStats] = useState<GeoSearchCacheStats>({
    queryCacheHits: 0,
    queryCacheMisses: 0,
    accessionCacheHits: 0,
    accessionCacheMisses: 0,
    queryEntries: 0,
    accessionEntries: 0,
  });
  const [activeGeoActionKey, setActiveGeoActionKey] = useState<string>('');
  const [geoRawCountsFile, setGeoRawCountsFile] = useState<File | null>(null);
  const [geoSeriesMatrixFile, setGeoSeriesMatrixFile] = useState<File | null>(null);
  const [geoAccessionInput, setGeoAccessionInput] = useState<string>('');
  const [geoTitleInput, setGeoTitleInput] = useState<string>('');
  const [geoOrganismInput, setGeoOrganismInput] = useState<string>('human');
  const [preparedInput, setPreparedInput] = useState<{ filename: string; revision: number } | null>(null);
  const [sampleFilterInput, setSampleFilterInput] = useState<string>('');
  const [tableScrollTop, setTableScrollTop] = useState(0);
  const [geoResultsScrollTop, setGeoResultsScrollTop] = useState(0);
  const [designTableViewportHeight, setDesignTableViewportHeight] = useState(DESIGN_TABLE_VIEWPORT_FALLBACK_HEIGHT);
  const [geoResultsViewportHeight, setGeoResultsViewportHeight] = useState(GEO_RESULTS_VIEWPORT_FALLBACK_HEIGHT);
  const [isSampleFilterPending, startSampleFilterTransition] = useTransition();
  const isGeoSetupActionDisabled = isParsing || isPreparingDesign || isGeneratingReport;

  const parseRequestIdRef = useRef(0);
  const geoSearchRequestIdRef = useRef(0);
  const geoSearchAbortRef = useRef<AbortController | null>(null);
  const designTableViewportRef = useRef<HTMLDivElement | null>(null);
  const geoResultsViewportRef = useRef<HTMLDivElement | null>(null);
  const designPanelRef = useRef<HTMLElement | null>(null);
  const sampleFilterInputRef = useRef<HTMLInputElement | null>(null);
  const geoSearchInputRef = useRef<HTMLInputElement | null>(null);
  const geoResultFilterInputRef = useRef<HTMLInputElement | null>(null);
  const tableScrollAnimationFrameRef = useRef<number | null>(null);
  const geoResultsScrollAnimationFrameRef = useRef<number | null>(null);
  const geoProgressUpdateTimerRef = useRef<number | null>(null);
  const pendingGeoProgressRef = useRef<GeoSearchResponse | null>(null);
  const pendingDesignPanelRevealRef = useRef(false);
  const pendingGeoResultsRevealRef = useRef(false);
  const lastGeoProgressSignatureRef = useRef<string>('');
  const latestTableScrollTopRef = useRef(0);
  const latestGeoResultsScrollTopRef = useRef(0);
  const geoResultKeyboardCursorRef = useRef(-1);
  const referenceSummary = useMemo(() => getReferenceSummaryLite(), []);
  const {
    designSession,
    result,
    loadedFileName,
    bulkBatchValue,
    groupCounts,
    isDirtySinceLastRun,
  } = draftState;
  const deferredSampleFilter = useDeferredValue(sampleFilterInput);
  const deferredGeoResultSearch = useDeferredValue(geoResultSearchInput);
  const geoResultQueryTokens = useMemo(
    () => tokenizeSearchQuery(deferredGeoResultSearch),
    [deferredGeoResultSearch],
  );
  const geoResultHighlightRegex = useMemo(
    () => buildHighlightRegex(geoResultQueryTokens),
    [geoResultQueryTokens],
  );
  const updateSampleGroup = useCallback((sampleId: string, value: GeoGroupAssignment) => {
    dispatch({ type: 'update_sample_group', sampleId, value });
  }, []);
  const updateSampleBatch = useCallback((sampleId: string, value: string) => {
    dispatch({ type: 'update_sample_batch', sampleId, value });
  }, []);
  const updateGeoResultKeyboardCursor = useCallback(
    (updater: number | ((current: number) => number)) => {
      setGeoResultKeyboardCursor((current) => {
        const next = typeof updater === 'function'
          ? (updater as (value: number) => number)(current)
          : updater;
        geoResultKeyboardCursorRef.current = next;
        return next;
      });
    },
    [],
  );
  const activateGeoResultCursor = useCallback((position: number) => {
    updateGeoResultKeyboardCursor(position);
  }, [updateGeoResultKeyboardCursor]);

  const sampleSearchEngine = useMemo(() => {
    if (!designSession) {
      return null;
    }
    return createSampleSearchEngine(designSession.preview);
  }, [designSession]);
  const geoResultSearchCorpusKey = useMemo(
    () => buildGeoResultCorpusSignature(geoResults),
    [geoResults],
  );
  const geoResultIndexByAccession = useMemo(() => {
    const map = new Map<string, number>();
    for (let index = 0; index < geoResults.length; index += 1) {
      const item = geoResults[index];
      if (!item) {
        continue;
      }
      map.set(item.accession.toUpperCase(), index);
    }
    return map;
  }, [geoResultSearchCorpusKey]);
  const geoResultStatusSignature = geoResultStatusArtifacts.signature;
  const geoResultStatusAccessor = useCallback(
    (index: number) => geoResults[index]?.eligibilityStatus,
    [geoResults],
  );
  const geoResultIndexOrders = useMemo(
    () => buildGeoResultIndexOrders(geoResults),
    [geoResultSearchCorpusKey],
  );
  const geoResultSearchEngine = useMemo(
    () => createGeoResultSearchEngine(geoResults),
    [geoResultSearchCorpusKey],
  );
  const geoFilterState = useMemo(() => {
    const startedAt = readTimeNowMs();
    const snapshot = geoResultSearchEngine.filterSnapshot(
      deferredGeoResultSearch,
      geoResultStatusAccessor,
      geoResultStatusSignature,
    );
    return {
      snapshot,
      elapsedMs: Math.max(0, readTimeNowMs() - startedAt),
    };
  }, [deferredGeoResultSearch, geoResultSearchEngine, geoResultStatusAccessor, geoResultStatusSignature]);
  const geoFilterSnapshot = geoFilterState.snapshot;
  const filteredGeoIndices = useMemo(
    () => (
      geoResultStatusFilter === 'all'
        ? geoFilterSnapshot.allIndices
        : geoFilterSnapshot.statusIndices[geoResultStatusFilter]
    ),
    [geoFilterSnapshot, geoResultStatusFilter],
  );
  const sortedGeoFilterState = useMemo(() => {
    const startedAt = readTimeNowMs();
    const indices = orderFilteredGeoIndices(filteredGeoIndices, geoResultSortMode, geoResultIndexOrders);
    return {
      indices,
      elapsedMs: Math.max(0, readTimeNowMs() - startedAt),
    };
  }, [filteredGeoIndices, geoResultIndexOrders, geoResultSortMode]);
  const sortedFilteredGeoIndices = sortedGeoFilterState.indices;
  const filteredGeoResultCount = sortedFilteredGeoIndices.length;
  const geoResultStatusCounts = geoFilterSnapshot.counts;
  const geoSearchTotalLatencyMs = geoFilterState.elapsedMs + sortedGeoFilterState.elapsedMs;
  const geoLatencyBadge = useMemo(() => {
    if (geoSearchTotalLatencyMs < 8) {
      return { label: 'Realtime', tone: 'fast' as const };
    }
    if (geoSearchTotalLatencyMs < 24) {
      return { label: 'Smooth', tone: 'good' as const };
    }
    return { label: 'Heavy', tone: 'slow' as const };
  }, [geoSearchTotalLatencyMs]);
  const firstEligibleFilteredGeoDataset = useMemo(() => {
    for (const index of sortedFilteredGeoIndices) {
      const candidate = geoResults[index];
      if (candidate?.eligibilityStatus === 'eligible') {
        return candidate;
      }
    }
    return null;
  }, [geoResults, sortedFilteredGeoIndices]);
  const firstFilteredGeoDataset = useMemo(() => {
    const firstIndex = sortedFilteredGeoIndices[0];
    return firstIndex === undefined ? null : geoResults[firstIndex] ?? null;
  }, [geoResults, sortedFilteredGeoIndices]);
  const exactGeoResultAccessionQuery = useMemo(() => {
    const candidate = geoResultSearchInput.trim().toUpperCase();
    return /^GSE\d+$/.test(candidate) ? candidate : '';
  }, [geoResultSearchInput]);
  const exactGeoResultAccessionUrl = useMemo(() => {
    if (!exactGeoResultAccessionQuery) {
      return '';
    }
    const matchedIndex = geoResultIndexByAccession.get(exactGeoResultAccessionQuery);
    const matched = matchedIndex === undefined ? undefined : geoResults[matchedIndex];
    if (matched) {
      return matched.geoUrl;
    }
    return `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${encodeURIComponent(exactGeoResultAccessionQuery)}`;
  }, [exactGeoResultAccessionQuery, geoResultIndexByAccession, geoResults]);
  const applyGeoResultFilterPreset = useCallback(
    (query: string, status?: GeoResultStatusFilter) => {
      setGeoResultSearchInput(query);
      if (status) {
        setGeoResultStatusFilter(status);
      }
      setGeoResultKeyboardCursor(-1);
    },
    [],
  );
  const copyFilteredGeoAccessions = useCallback(() => {
    if (typeof navigator === 'undefined') {
      return;
    }
    const lines: string[] = [];
    for (let index = 0; index < sortedFilteredGeoIndices.length; index += 1) {
      const resultIndex = sortedFilteredGeoIndices[index];
      const accession = geoResults[resultIndex]?.accession;
      if (accession) {
        lines.push(accession);
      }
    }
    if (!lines.length) {
      return;
    }
    const payload = lines.join('\n');
    const clipboard = navigator.clipboard;
    if (clipboard?.writeText) {
      void clipboard.writeText(payload).catch(() => {
        // Ignore clipboard failures in restricted contexts.
      });
      return;
    }
    if (typeof document !== 'undefined') {
      const textarea = document.createElement('textarea');
      textarea.value = payload;
      textarea.setAttribute('readonly', 'true');
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      try {
        document.execCommand('copy');
      } catch {
        // Ignore copy failures.
      }
      document.body.removeChild(textarea);
    }
  }, [geoResults, sortedFilteredGeoIndices]);
  const downloadFilteredGeoTsv = useCallback(() => {
    if (!sortedFilteredGeoIndices.length) {
      return;
    }
    const lines = [
      [
        'accession',
        'title',
        'organism',
        'sample_count',
        'eligibility_status',
        'eligibility_reason',
        'pubmed_id',
        'geo_url',
      ].join('\t'),
    ];
    for (let index = 0; index < sortedFilteredGeoIndices.length; index += 1) {
      const resultIndex = sortedFilteredGeoIndices[index];
      const dataset = geoResults[resultIndex];
      if (!dataset) {
        continue;
      }
      lines.push([
        dataset.accession,
        dataset.title,
        dataset.organism,
        String(dataset.sampleCount),
        dataset.eligibilityStatus,
        dataset.eligibilityReason ?? '',
        dataset.pubmedId ?? '',
        dataset.geoUrl,
      ].map((value) => value.replace(/\t/g, ' ').replace(/\r?\n/g, ' ')).join('\t'));
    }
    const queryToken = toSafeFilenameToken(geoResultSearchInput);
    const statusToken = geoResultStatusFilter === 'all' ? '' : `-${geoResultStatusFilter}`;
    const sortToken = geoResultSortMode === 'ranked' ? '' : `-${geoResultSortMode}`;
    const filename = [
      'geo-filtered',
      queryToken || 'all',
      `${toDateStamp(new Date())}${statusToken}${sortToken}`,
    ].join('_') + '.tsv';
    downloadBlob(filename, new Blob([lines.join('\n')], { type: 'text/tab-separated-values;charset=utf-8' }));
  }, [geoResultSearchInput, geoResultSortMode, geoResultStatusFilter, geoResults, sortedFilteredGeoIndices]);

  const sampleFilterState = useMemo(() => {
    const startedAt = readTimeNowMs();
    if (!designSession || !sampleSearchEngine) {
      return {
        sampleIds: [] as string[],
        elapsedMs: Math.max(0, readTimeNowMs() - startedAt),
      };
    }
    const sampleIds = sampleSearchEngine.filter(deferredSampleFilter);
    return {
      sampleIds,
      elapsedMs: Math.max(0, readTimeNowMs() - startedAt),
    };
  }, [deferredSampleFilter, designSession, sampleSearchEngine]);
  const filteredSampleIds = sampleFilterState.sampleIds;
  const sampleFilterLatencyBadge = useMemo(() => {
    if (sampleFilterState.elapsedMs < 5) {
      return { label: 'Instant', tone: 'fast' as const };
    }
    if (sampleFilterState.elapsedMs < 14) {
      return { label: 'Responsive', tone: 'good' as const };
    }
    return { label: 'Heavy', tone: 'slow' as const };
  }, [sampleFilterState.elapsedMs]);

  const visibleRowCapacity = Math.ceil(designTableViewportHeight / DESIGN_ROW_HEIGHT);
  const virtualStartIndex = Math.max(Math.floor(tableScrollTop / DESIGN_ROW_HEIGHT) - DESIGN_ROW_OVERSCAN, 0);
  const virtualEndIndex = Math.min(
    filteredSampleIds.length,
    virtualStartIndex + visibleRowCapacity + DESIGN_ROW_OVERSCAN * 2,
  );
  const virtualSampleIds = filteredSampleIds.slice(virtualStartIndex, virtualEndIndex);
  const virtualPaddingTop = virtualStartIndex * DESIGN_ROW_HEIGHT;
  const virtualPaddingBottom = Math.max((filteredSampleIds.length - virtualEndIndex) * DESIGN_ROW_HEIGHT, 0);
  const geoResultCardHeightBase =
    geoResultDensity === 'compact' ? GEO_RESULT_CARD_HEIGHT_COMPACT : GEO_RESULT_CARD_HEIGHT_COMFORTABLE;
  const geoResultCardHeight =
    geoResultCardHeightBase + (geoResultQueryTokens.length > 0 ? GEO_RESULT_CARD_HEIGHT_FILTER_BONUS : 0);
  const visibleGeoResultCapacity = Math.ceil(geoResultsViewportHeight / geoResultCardHeight);
  const virtualGeoStartIndex = Math.max(
    Math.floor(geoResultsScrollTop / geoResultCardHeight) - GEO_RESULT_OVERSCAN,
    0,
  );
  const virtualGeoEndIndex = Math.min(
    filteredGeoResultCount,
    virtualGeoStartIndex + visibleGeoResultCapacity + GEO_RESULT_OVERSCAN * 2,
  );
  const virtualGeoIndices = sortedFilteredGeoIndices.slice(virtualGeoStartIndex, virtualGeoEndIndex);
  const virtualGeoPaddingTop = virtualGeoStartIndex * geoResultCardHeight;
  const virtualGeoPaddingBottom = Math.max(
    (filteredGeoResultCount - virtualGeoEndIndex) * geoResultCardHeight,
    0,
  );
  const resetGeoResultsScroll = useCallback(() => {
    latestGeoResultsScrollTopRef.current = 0;
    setGeoResultsScrollTop(0);
    if (geoResultsViewportRef.current) {
      geoResultsViewportRef.current.scrollTop = 0;
    }
    if (geoResultsScrollAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(geoResultsScrollAnimationFrameRef.current);
      geoResultsScrollAnimationFrameRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => {
      geoSearchAbortRef.current?.abort();
      if (geoProgressUpdateTimerRef.current !== null) {
        window.clearTimeout(geoProgressUpdateTimerRef.current);
        geoProgressUpdateTimerRef.current = null;
      }
      if (tableScrollAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(tableScrollAnimationFrameRef.current);
      }
      if (geoResultsScrollAnimationFrameRef.current !== null) {
        window.cancelAnimationFrame(geoResultsScrollAnimationFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (mode !== 'public') {
      geoSearchAbortRef.current?.abort();
      setIsGeoSearching(false);
      setIsGeoHydrating(false);
      setActiveGeoActionKey((current) => (current.startsWith('setup:') ? '' : current));
      if (geoProgressUpdateTimerRef.current !== null) {
        window.clearTimeout(geoProgressUpdateTimerRef.current);
        geoProgressUpdateTimerRef.current = null;
      }
      pendingGeoProgressRef.current = null;
    }
  }, [mode]);

  useEffect(() => {
    setSampleFilterInput('');
  }, [designSession]);

  useEffect(() => {
    if (typeof window === 'undefined' || !window.localStorage) {
      return;
    }
    try {
      window.localStorage.setItem(
        GEO_RESULT_UI_PREFERENCE_STORAGE_KEY,
        JSON.stringify({
          sortMode: geoResultSortMode,
          density: geoResultDensity,
        }),
      );
    } catch {
      // Ignore localStorage quota/privacy mode failures.
    }
  }, [geoResultDensity, geoResultSortMode]);

  useEffect(() => {
    if (!designSession || (mode === 'public' && geoResults.length > 0)) {
      return;
    }
    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      if (event.key !== '/') {
        return;
      }
      if (isTypingContext(event.target)) {
        return;
      }
      event.preventDefault();
      sampleFilterInputRef.current?.focus();
      sampleFilterInputRef.current?.select();
    };
    const keyTarget = getGlobalKeydownTarget();
    keyTarget.addEventListener('keydown', onKeyDown);
    return () => {
      keyTarget.removeEventListener('keydown', onKeyDown);
    };
  }, [designSession, geoResults.length, mode]);

  useEffect(() => {
    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        geoSearchInputRef.current?.focus();
        geoSearchInputRef.current?.select();
      }
    };
    const keyTarget = getGlobalKeydownTarget();
    keyTarget.addEventListener('keydown', onKeyDown);
    return () => {
      keyTarget.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (mode !== 'public') {
      return;
    }
    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        if (isTypingContext(event.target)) {
          return;
        }
        if (!geoResultFilterInputRef.current) {
          return;
        }
        event.preventDefault();
        geoResultFilterInputRef.current?.focus();
        geoResultFilterInputRef.current?.select();
      }
    };
    const keyTarget = getGlobalKeydownTarget();
    keyTarget.addEventListener('keydown', onKeyDown);
    return () => {
      keyTarget.removeEventListener('keydown', onKeyDown);
    };
  }, [mode]);

  useEffect(() => {
    if (mode !== 'public') {
      return;
    }
    const onKeyDown = (event: Event) => {
      if (!(event instanceof KeyboardEvent)) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      if (event.key !== '/') {
        return;
      }
      if (isTypingContext(event.target)) {
        return;
      }
      if (!geoResultFilterInputRef.current) {
        return;
      }
      event.preventDefault();
      geoResultFilterInputRef.current?.focus();
      geoResultFilterInputRef.current?.select();
    };
    const keyTarget = getGlobalKeydownTarget();
    keyTarget.addEventListener('keydown', onKeyDown);
    return () => {
      keyTarget.removeEventListener('keydown', onKeyDown);
    };
  }, [mode]);

  useEffect(() => {
    const viewport = designTableViewportRef.current;
    if (!viewport) {
      return;
    }
    const updateHeight = () => {
      const next = Math.max(1, viewport.clientHeight || DESIGN_TABLE_VIEWPORT_FALLBACK_HEIGHT);
      setDesignTableViewportHeight((current) => (current === next ? current : next));
    };
    updateHeight();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [designSession]);

  useEffect(() => {
    const viewport = geoResultsViewportRef.current;
    if (!viewport) {
      return;
    }
    const updateHeight = () => {
      const next = Math.max(1, viewport.clientHeight || GEO_RESULTS_VIEWPORT_FALLBACK_HEIGHT);
      setGeoResultsViewportHeight((current) => (current === next ? current : next));
    };
    updateHeight();
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    const observer = new ResizeObserver(() => {
      updateHeight();
    });
    observer.observe(viewport);
    return () => {
      observer.disconnect();
    };
  }, [geoResults.length, mode]);

  useEffect(() => {
    if (mode !== 'public' || !geoResults.length || !pendingGeoResultsRevealRef.current) return;
    const viewport = geoResultsViewportRef.current;
    if (!viewport) return;
    pendingGeoResultsRevealRef.current = false;
    viewport.scrollIntoView?.({ behavior: 'auto', block: 'start' });
  }, [geoResults.length, mode]);

  useEffect(() => {
    latestTableScrollTopRef.current = 0;
    setTableScrollTop(0);
    if (designTableViewportRef.current) {
      designTableViewportRef.current.scrollTop = 0;
    }
    if (tableScrollAnimationFrameRef.current !== null) {
      window.cancelAnimationFrame(tableScrollAnimationFrameRef.current);
      tableScrollAnimationFrameRef.current = null;
    }
  }, [deferredSampleFilter, designSession]);

  useEffect(() => {
    if (!designSession || !pendingDesignPanelRevealRef.current) {
      return;
    }
    pendingDesignPanelRevealRef.current = false;

    const revealPanel = () => {
      const panel = designPanelRef.current;
      if (!panel) {
        return;
      }
      panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      try {
        panel.focus({ preventScroll: true });
      } catch {
        panel.focus();
      }
    };

    if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') {
      revealPanel();
      return;
    }

    let outerFrame: number | null = null;
    let innerFrame: number | null = null;
    outerFrame = window.requestAnimationFrame(() => {
      outerFrame = null;
      innerFrame = window.requestAnimationFrame(() => {
        innerFrame = null;
        revealPanel();
      });
    });

    return () => {
      if (outerFrame !== null) {
        window.cancelAnimationFrame(outerFrame);
      }
      if (innerFrame !== null) {
        window.cancelAnimationFrame(innerFrame);
      }
    };
  }, [designSession]);

  useEffect(() => {
    resetGeoResultsScroll();
  }, [deferredGeoResultSearch, geoResultSortMode, geoResultStatusFilter, resetGeoResultsScroll]);

  useEffect(() => {
    if (!filteredGeoResultCount) {
      updateGeoResultKeyboardCursor(-1);
      return;
    }
    updateGeoResultKeyboardCursor((current) => {
      if (current < 0) {
        return 0;
      }
      if (current >= filteredGeoResultCount) {
        return filteredGeoResultCount - 1;
      }
      return current;
    });
  }, [filteredGeoResultCount, updateGeoResultKeyboardCursor]);

  useEffect(() => {
    if (geoResultKeyboardCursor < 0 || !geoResultsViewportRef.current) {
      return;
    }
    const top = geoResultKeyboardCursor * geoResultCardHeight;
    const bottom = top + geoResultCardHeight;
    const viewport = geoResultsViewportRef.current;
    const viewportTop = viewport.scrollTop;
    const viewportBottom = viewportTop + geoResultsViewportHeight;
    if (top < viewportTop) {
      viewport.scrollTop = top;
      return;
    }
    if (bottom > viewportBottom) {
      viewport.scrollTop = bottom - geoResultsViewportHeight;
    }
  }, [geoResultCardHeight, geoResultKeyboardCursor, geoResultsViewportHeight]);

  const syncGeoSearchResultState = useCallback((response: GeoSearchResponse) => {
    const signature = buildGeoProgressSignature(response);
    if (lastGeoProgressSignatureRef.current === signature) {
      return;
    }
    lastGeoProgressSignatureRef.current = signature;
    startTransition(() => {
      setGeoSearchSummary(toGeoSearchProgressSummary(response));
      setGeoResults(response.results);
      setGeoResultStatusArtifacts(buildGeoResultStatusArtifacts(response.results));
    });
  }, []);

  const syncGeoSearchMessage = useCallback((response: GeoSearchResponse) => {
    if (!response.rawHitCount) {
      setGeoSearchMessage('No GEO series matched this query.');
      return;
    }
    const failedChecks = response.results.filter((item) => item.availabilityCheckFailed).length;
    if (response.complete && failedChecks) {
      setGeoSearchMessage(`${failedChecks} availability check(s) failed. This does not establish that raw counts or metadata are absent. Retry the search, or open GEO and use Private analysis with downloaded files.`);
      return;
    }
    if (response.complete && !response.eligibleCount) {
      setGeoSearchMessage(`Found ${response.rawHitCount} GEO hit(s), but none met the current builder constraints.`);
      return;
    }
    setGeoSearchMessage('');
  }, []);

  const applyGeoSearchProgress = useCallback((response: GeoSearchResponse) => {
    syncGeoSearchResultState(response);
    setIsGeoHydrating(!response.complete);
    syncGeoSearchMessage(response);
  }, [syncGeoSearchMessage, syncGeoSearchResultState]);

  const flushPendingGeoProgress = useCallback(() => {
    const pending = pendingGeoProgressRef.current;
    pendingGeoProgressRef.current = null;
    if (geoProgressUpdateTimerRef.current !== null) {
      window.clearTimeout(geoProgressUpdateTimerRef.current);
      geoProgressUpdateTimerRef.current = null;
    }
    if (!pending) {
      return;
    }
    applyGeoSearchProgress(pending);
  }, [applyGeoSearchProgress]);

  const scheduleGeoProgress = useCallback((response: GeoSearchResponse, immediate = false) => {
    pendingGeoProgressRef.current = response;
    if (immediate) {
      flushPendingGeoProgress();
      return;
    }
    if (geoProgressUpdateTimerRef.current !== null) {
      return;
    }
    geoProgressUpdateTimerRef.current = window.setTimeout(() => {
      flushPendingGeoProgress();
    }, GEO_PROGRESS_UPDATE_DEBOUNCE_MS);
  }, [flushPendingGeoProgress]);

  const handleSearchGeo = useCallback(async () => {
    const query = geoQuery.trim();
    if (!query) {
      setGeoSearchMessage('Enter a keyword or GSE accession first (example: GSE157951).');
      return;
    }
    if (isGeoSearching || isParsing || isGeneratingReport || isPreparingDesign) {
      return;
    }

    geoSearchAbortRef.current?.abort();
    if (geoProgressUpdateTimerRef.current !== null) {
      window.clearTimeout(geoProgressUpdateTimerRef.current);
      geoProgressUpdateTimerRef.current = null;
    }
    pendingGeoProgressRef.current = null;
    const controller = new AbortController();
    geoSearchAbortRef.current = controller;
    const requestId = geoSearchRequestIdRef.current + 1;
    geoSearchRequestIdRef.current = requestId;

    setIsGeoSearching(true);
    pendingGeoResultsRevealRef.current = true;
    setIsGeoHydrating(false);
    setGeoResults([]);
    setGeoResultStatusArtifacts(EMPTY_GEO_RESULT_STATUS_ARTIFACTS);
    setGeoSearchSummary(null);
    setGeoResultSearchInput('');
    setGeoResultStatusFilter('all');
    setGeoResultSortMode('ranked');
    setGeoError('');
    setGeoSearchMessage('');
    setGeoSearchCacheStats({
      queryCacheHits: 0,
      queryCacheMisses: 0,
      accessionCacheHits: 0,
      accessionCacheMisses: 0,
      queryEntries: 0,
      accessionEntries: 0,
    });
    lastGeoProgressSignatureRef.current = '';
    resetGeoResultsScroll();
    let refreshCacheStats: (() => void) | null = null;
    try {
      const { startGeoDatasetSearch, getGeoSearchCacheStats } = await import('./lib/geoSearch');
      refreshCacheStats = () => {
        if (controller.signal.aborted || geoSearchRequestIdRef.current !== requestId) {
          return;
        }
        setGeoSearchCacheStats(getGeoSearchCacheStats());
      };
      const searchSession = await startGeoDatasetSearch(query, 12, {
        signal: controller.signal,
        onProgress: (response) => {
          if (controller.signal.aborted || geoSearchRequestIdRef.current !== requestId) {
            return;
          }
          scheduleGeoProgress(response);
        },
      });
      if (controller.signal.aborted || geoSearchRequestIdRef.current !== requestId) {
        return;
      }
      scheduleGeoProgress(searchSession.initialResponse, true);
      refreshCacheStats();
      setIsGeoSearching(false);
      void searchSession.completion
        .then((response) => {
          if (controller.signal.aborted || geoSearchRequestIdRef.current !== requestId) {
            return;
          }
          scheduleGeoProgress(response, true);
          refreshCacheStats?.();
          setIsGeoHydrating(false);
        })
        .catch((error) => {
          if (controller.signal.aborted || geoSearchRequestIdRef.current !== requestId) {
            return;
          }
          setIsGeoHydrating(false);
          setGeoSearchMessage(
            error instanceof Error ? `GEO eligibility checks failed: ${error.message}` : 'GEO eligibility checks failed.',
          );
          refreshCacheStats?.();
        });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return;
      }
      setGeoResults([]);
      setGeoResultStatusArtifacts(EMPTY_GEO_RESULT_STATUS_ARTIFACTS);
      setGeoSearchSummary(null);
      pendingGeoProgressRef.current = null;
      if (geoProgressUpdateTimerRef.current !== null) {
        window.clearTimeout(geoProgressUpdateTimerRef.current);
        geoProgressUpdateTimerRef.current = null;
      }
      setIsGeoHydrating(false);
      setGeoSearchMessage(
        error instanceof Error
          ? `GEO search failed: ${error.message}`
          : 'GEO search failed due to an unknown error.',
      );
    } finally {
      if (geoSearchRequestIdRef.current === requestId) {
        flushPendingGeoProgress();
        refreshCacheStats?.();
        setIsGeoSearching(false);
      }
    }
  }, [flushPendingGeoProgress, geoQuery, isGeoSearching, isGeneratingReport, isParsing, isPreparingDesign, resetGeoResultsScroll, scheduleGeoProgress]);

  const handlePrepareGeoDesignFromNcbi = useCallback(async (dataset: GeoSearchResult) => {
    if (isParsing || isGeneratingReport || isPreparingDesign) {
      return;
    }

    pendingDesignPanelRevealRef.current = true;
    setIsPreparingDesign(true);
    setActiveGeoActionKey(`setup:${dataset.accession}`);
    setAppError('');
    setGeoError('');

    try {
      const { previewGeoSeriesDesignFromNcbi } = await import('./lib/geo');
      const preview = await previewGeoSeriesDesignFromNcbi(dataset);
      setPreparedInput(null);
      dispatch({
        type: 'setup_session',
        session: createDesignSession(preview, 'ncbi', { dataset }),
        loadedFileName: `${dataset.accession} (setup ready)`,
      });
    } catch (error) {
      setGeoError(
        error instanceof Error
          ? `Failed to load sample metadata: ${error.message}`
          : 'Failed to load sample metadata due to an unknown error.',
      );
    } finally {
      setIsPreparingDesign(false);
      setActiveGeoActionKey('');
    }
  }, [isGeneratingReport, isParsing, isPreparingDesign]);

  const runGeoDatasetPrimaryAction = useCallback((dataset: GeoSearchResult): boolean => {
    if (!dataset) {
      return false;
    }
    if (dataset.eligibilityStatus === 'eligible' && !isGeoSetupActionDisabled) {
      void handlePrepareGeoDesignFromNcbi(dataset);
      return true;
    }
    window.open(dataset.geoUrl, '_blank', 'noopener,noreferrer');
    return true;
  }, [handlePrepareGeoDesignFromNcbi, isGeoSetupActionDisabled]);

  const handleQuickGeoResultAction = useCallback((): boolean => {
    if (!exactGeoResultAccessionQuery) {
      return false;
    }
    const matchedIndex = geoResultIndexByAccession.get(exactGeoResultAccessionQuery);
    const matched = matchedIndex === undefined ? undefined : geoResults[matchedIndex];
    if (!matched) {
      window.open(exactGeoResultAccessionUrl, '_blank', 'noopener,noreferrer');
      return true;
    }
    return runGeoDatasetPrimaryAction(matched);
  }, [
    exactGeoResultAccessionQuery,
    exactGeoResultAccessionUrl,
    geoResultIndexByAccession,
    geoResults,
    runGeoDatasetPrimaryAction,
  ]);

  const handlePreparePrivateDesign = async () => {
    if (isParsing || isGeneratingReport || isPreparingDesign) {
      return;
    }
    if (!geoRawCountsFile) {
      setGeoError('Select a raw counts file first (.tsv/.txt/.gz).');
      return;
    }
    if (!geoSeriesMatrixFile) {
      setGeoError('Select a series matrix file first (.txt/.tsv/.gz).');
      return;
    }

    pendingDesignPanelRevealRef.current = true;
    setIsPreparingDesign(true);
    setActiveGeoActionKey('setup:files');
    setGeoError('');
    setAppError('');

    try {
      const { previewGeoSeriesDesignFromFile } = await import('./lib/geo');
      const preview = await previewGeoSeriesDesignFromFile(geoSeriesMatrixFile);
      setPreparedInput(null);
      dispatch({
        type: 'setup_session',
        session: createDesignSession(preview, 'files', {
          rawCountsFile: geoRawCountsFile,
          seriesMatrixFile: geoSeriesMatrixFile,
          accession: geoAccessionInput.trim() || undefined,
          title: geoTitleInput.trim() || undefined,
          organism: geoOrganismInput.trim() || undefined,
        }),
        loadedFileName: `${geoRawCountsFile.name} + ${geoSeriesMatrixFile.name} (setup ready)`,
      });
    } catch (error) {
      setGeoError(
        error instanceof Error
          ? `Failed to parse uploaded series metadata: ${error.message}`
          : 'Failed to parse uploaded series metadata due to an unknown error.',
      );
    } finally {
      setIsPreparingDesign(false);
      setActiveGeoActionKey('');
    }
  };

  const handlePrepareLocalAnalysis = async () => {
    if (!designSession || isParsing || isPreparingDesign || isGeneratingReport) {
      return;
    }

    if (groupCounts.A < 2 || groupCounts.B < 2) {
      setAppError(
        `Need at least 2 samples in each group before preparing local analysis (A=${groupCounts.A}, B=${groupCounts.B}).`,
      );
      return;
    }

    const requestId = parseRequestIdRef.current + 1;
    parseRequestIdRef.current = requestId;
    setIsParsing(true);
    setAppError('');
    setGeoError('');
    setActiveGeoActionKey('run:analysis');

    try {
      const groupFactorLabel =
        findFactorById(designSession.preview, designSession.groupFactorId)?.label ?? designSession.groupFactorId;
      const analysisDesign: GeoAnalysisDesign = {
        conditionA: designSession.conditionA,
        conditionB: designSession.conditionB,
        groupBySample: designSession.groupBySample,
        groupFactorName: groupFactorLabel,
      };

      if (designSession.batchFactorId !== NO_BATCH_FACTOR) {
        analysisDesign.batchBySample = designSession.batchBySample;
        analysisDesign.batchFactorName =
          findFactorById(designSession.preview, designSession.batchFactorId)?.label ??
          designSession.batchFactorId;
      }

      const { loadGeoInputFromFiles, loadGeoInputFromNcbi } = await import('./lib/geo');
      let inputOptions: import('./lib/geo').AnalyzeGeoFromTextOptions;
      if (designSession.source === 'ncbi' && designSession.dataset) {
        inputOptions = await loadGeoInputFromNcbi(designSession.dataset, analysisDesign);
      } else if (
        designSession.source === 'files' &&
        designSession.rawCountsFile &&
        designSession.seriesMatrixFile
      ) {
        inputOptions = await loadGeoInputFromFiles({
          accession: designSession.accession,
          title: designSession.title,
          organism: designSession.organism,
          rawCountsFile: designSession.rawCountsFile,
          seriesMatrixFile: designSession.seriesMatrixFile,
          design: analysisDesign,
        });
      } else {
        throw new Error('Configured analysis source is incomplete. Re-open setup and try again.');
      }

      if (requestId !== parseRequestIdRef.current) {
        return;
      }

      const bundle = createLocalAnalysisInput(inputOptions);
      const filename = localAnalysisInputFilename(bundle.project.accession);
      downloadBlob(filename, new Blob([JSON.stringify(bundle)], { type: 'application/json;charset=utf-8' }));
      setPreparedInput({ filename, revision: draftState.analysisRevision });

    } catch (error) {
      if (requestId !== parseRequestIdRef.current) {
        return;
      }
      setAppError(
        error instanceof Error
          ? `Input preparation failed: ${error.message}`
          : 'Input preparation failed due to an unknown error.',
      );
    } finally {
      if (requestId === parseRequestIdRef.current) {
        setIsParsing(false);
        setActiveGeoActionKey('');
      }
    }
  };

  const handleImportResults = async (file: File) => {
    if (isParsing || isPreparingDesign || isGeneratingReport) return;
    const requestId = ++parseRequestIdRef.current;
    setIsParsing(true);
    setAppError('');
    dispatch({ type: 'reset' });
    setPreparedInput(null);
    try {
      if (file.size > 128 * 1024 * 1024) throw new Error('Result file exceeds the 128 MiB browser import limit.');
      let parsed: WorkbookParseResult;
      if (/\.json$/i.test(file.name)) {
        const { parseViewerDataJson } = await import('./lib/evidence');
        const viewerData = parseViewerDataJson(JSON.parse(await file.text()));
        parsed = {
          viewerData,
          issues: viewerData.issues,
          summary: {
            totalGenes: new Set(viewerData.pathways.flatMap((pathway) => pathway.nodes.map((node) => node.id))).size,
            totalPathways: viewerData.pathways.length,
            significantPathways: viewerData.pathways.filter((pathway) => pathway.padj !== null && Number.isFinite(pathway.padj) && pathway.padj < viewerData.significantPadjThreshold).length,
            fallbackPathways: viewerData.pathways.filter((pathway) => pathway.fallbackToLeadingEdge).length,
            unknownGenes: 0,
          },
        };
      } else if (/\.xlsx?$/i.test(file.name)) {
        const { parseWorkbookFile } = await import('./lib/workbook');
        parsed = await parseWorkbookFile(file);
      } else {
        throw new Error('Choose a result workbook (.xlsx/.xls) or viewer JSON (.json).');
      }
      if (requestId !== parseRequestIdRef.current) return;
      dispatch({ type: 'import_result', result: parsed, loadedFileName: file.name });
    } catch (error) {
      if (requestId === parseRequestIdRef.current) {
        setAppError(`Failed to import results: ${error instanceof Error ? error.message : 'Unknown file error.'}`);
      }
    } finally {
      if (requestId === parseRequestIdRef.current) setIsParsing(false);
    }
  };

  const handleGenerateReport = async () => {
    if (!result?.viewerData) {
      return;
    }

    setIsGeneratingReport(true);
    setAppError('');
    try {
      const { createReportHtml, reportFilenameForProject } = await import('./lib/reportHtml');
      const html = await createReportHtml(result.viewerData);
      downloadBlob(
        reportFilenameForProject(result.viewerData.project.projectTitle),
        new Blob([html], { type: 'text/html;charset=utf-8' }),
      );
    } catch (error) {
      setAppError(
        error instanceof Error
          ? `Failed to generate report: ${error.message}`
          : 'Failed to generate report due to an unknown error.',
      );
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const setGroupFactor = (factorId: string) => {
    dispatch({ type: 'set_group_factor', factorId });
  };

  const setBatchFactor = (factorId: string) => {
    dispatch({ type: 'set_batch_factor', factorId });
  };

  const assignFilteredGroup = (value: GeoGroupAssignment) => {
    if (!designSession || !filteredSampleIds.length) {
      return;
    }
    dispatch({ type: 'assign_filtered_group', sampleIds: filteredSampleIds, value });
  };

  const assignFilteredBatch = () => {
    const value = bulkBatchValue.trim();
    if (!designSession || designSession.batchFactorId === NO_BATCH_FACTOR || !filteredSampleIds.length || !value) {
      return;
    }
    dispatch({ type: 'assign_filtered_batch', sampleIds: filteredSampleIds, value });
  };

  const binaryGroupFactors = designSession
    ? designSession.preview.factors.filter((factor) => Boolean(factor.orderedBinaryValues))
    : [];
  const isBatchEnabled = Boolean(designSession && designSession.batchFactorId !== NO_BATCH_FACTOR);
  const isReportDownloadDisabled =
    !result?.viewerData || isDirtySinceLastRun || isGeneratingReport || isParsing || isPreparingDesign;

  return (
    <main className="page-shell">
      <section className="hero-card launch-card">
        <div className="launch-header">
          <p className="eyebrow">Pathway Network Viewer</p>
          <h1>Prepare local RNA-seq analysis or explore completed results</h1>
          <p className="hero-copy">
            Statistical analysis runs locally in R. Use this builder to find data, assign samples, import results, and
            export a standalone <code>report.html</code>.
          </p>
        </div>

        <div className="mode-toggle" role="group" aria-label="Analysis mode">
          <button
            type="button"
            aria-pressed={mode === 'public'}
            className={`mode-chip ${mode === 'public' ? 'is-active' : ''}`}
            onClick={() => setMode('public')}
            disabled={isParsing || isPreparingDesign || isGeneratingReport}
          >
            Search - GSE analysis
          </button>
          <button
            type="button"
            aria-pressed={mode === 'private'}
            className={`mode-chip ${mode === 'private' ? 'is-active' : ''}`}
            onClick={() => setMode('private')}
            disabled={isParsing || isPreparingDesign || isGeneratingReport}
          >
            Private analysis
          </button>
        </div>

        {mode === 'public' ? (
          <div className="launch-search-block">
            <div className="launch-search-row">
              <input
                ref={geoSearchInputRef}
                className="launch-search-input"
                type="text"
                inputMode="search"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={geoQuery}
                placeholder="Search human GEO studies (example: GSE157951 or psoriasis skin)"
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    if (!geoQuery) {
                      return;
                    }
                    event.preventDefault();
                    setGeoQuery('');
                    return;
                  }
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleSearchGeo();
                  }
                }}
              />
              <button
                className="primary-button"
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  void handleSearchGeo();
                }}
              >
                {isGeoSearching ? 'Searching…' : 'Search GEO'}
              </button>
            </div>
            <p className="muted-text">
              Searches live GEO metadata with <strong>human bulk RNA-seq</strong> filters first, then checks raw-count
              eligibility on the top candidates.
            </p>
            <p className="muted-text">
              Shortcut: <code>Ctrl/Cmd + K</code> focuses this GEO search box.
            </p>
            <p className="muted-text">
              Press <code>Esc</code> in search inputs to clear quickly.
            </p>
            {geoSearchSummary && (
              <p className="muted-text" aria-live="polite">
                Search hits: <strong>{geoSearchSummary.rawHitCount.toLocaleString()}</strong> raw GEO series ·{' '}
                <strong>{geoSearchSummary.inspectedCount.toLocaleString()}</strong> resolved ·{' '}
                <strong>{geoSearchSummary.checkingCount.toLocaleString()}</strong> checking ·{' '}
                <strong>{geoSearchSummary.eligibleCount.toLocaleString()}</strong> eligible ·{' '}
                <strong>{geoSearchSummary.excludedCount.toLocaleString()}</strong> not ready (excluded or check failed)
              </p>
            )}
            {geoSearchSummary && isGeoHydrating && (
              <p className="muted-text">Eligibility checks continue in the background. You can start a new search now.</p>
            )}
            {geoSearchSummary && geoSearchSummary.rawHitCount > 0 && (
              <p className="muted-text">Results are ranked by builder eligibility first, then sample count.</p>
            )}
          </div>
        ) : (
          <div className="private-intake-grid">
            <label className="file-input-field">
              <span>Raw counts file</span>
              <input
                type="file"
                accept=".tsv,.txt,.gz"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoRawCountsFile(event.target.files?.[0] ?? null);
                  dispatch({ type: 'reset' });
                  setPreparedInput(null);
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Series matrix file</span>
              <input
                type="file"
                accept=".txt,.tsv,.gz"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoSeriesMatrixFile(event.target.files?.[0] ?? null);
                  dispatch({ type: 'reset' });
                  setPreparedInput(null);
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Accession (optional)</span>
              <input
                type="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={geoAccessionInput}
                placeholder="GSE157951"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoAccessionInput(event.target.value);
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Project title (optional)</span>
              <input
                type="text"
                value={geoTitleInput}
                placeholder="Psoriasis RNA-seq"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoTitleInput(event.target.value);
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Organism</span>
              <input
                type="text"
                value={geoOrganismInput}
                placeholder="human"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoOrganismInput(event.target.value);
                }}
              />
            </label>
            <div className="private-intake-actions">
              <button
                className="primary-button"
                disabled={!geoRawCountsFile || !geoSeriesMatrixFile || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  void handlePreparePrivateDesign();
                }}
              >
                {isPreparingDesign && activeGeoActionKey === 'setup:files'
                  ? 'Preparing setup…'
                  : 'Prepare sample setup'}
              </button>
            </div>
          </div>
        )}

        {(geoError || geoSearchMessage) && <p className="issue warning">{geoError || geoSearchMessage}</p>}
      </section>

      <section className="panel result-import-panel">
        <h2>Import completed results</h2>
        <p className="muted-text">Load the viewer JSON produced by the local R workflow, or an external result workbook. Missing analysis methods or provenance remain unverified.</p>
        <label className="file-input-field">
          <span>Import analysis results</span>
          <input type="file" accept=".xlsx,.xls,.json" disabled={isParsing || isPreparingDesign || isGeneratingReport}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleImportResults(file);
              event.target.value = '';
            }} />
        </label>
      </section>

      {mode === 'public' && geoResults.length > 0 && (
        <section className="panel geo-panel">
          <h2>GEO datasets</h2>
          <div className="geo-results-toolbar">
            <div className="bulk-filter-row">
              <input
                ref={geoResultFilterInputRef}
                className="geo-search-input"
                type="text"
                inputMode="search"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={geoResultSearchInput}
                placeholder="Filter current GEO results (accession/title/summary/organism)"
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoResultSearchInput(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Home') {
                    if (!filteredGeoResultCount) {
                      return;
                    }
                    event.preventDefault();
                    updateGeoResultKeyboardCursor(0);
                    return;
                  }
                  if (event.key === 'End') {
                    if (!filteredGeoResultCount) {
                      return;
                    }
                    event.preventDefault();
                    updateGeoResultKeyboardCursor(filteredGeoResultCount - 1);
                    return;
                  }
                  if (event.key === 'PageDown') {
                    if (!filteredGeoResultCount) {
                      return;
                    }
                    event.preventDefault();
                    const pageStep = Math.max(1, visibleGeoResultCapacity - 1);
                    updateGeoResultKeyboardCursor((current) => (
                      Math.min(current + pageStep, filteredGeoResultCount - 1)
                    ));
                    return;
                  }
                  if (event.key === 'PageUp') {
                    if (!filteredGeoResultCount) {
                      return;
                    }
                    event.preventDefault();
                    const pageStep = Math.max(1, visibleGeoResultCapacity - 1);
                    updateGeoResultKeyboardCursor((current) => Math.max(current - pageStep, 0));
                    return;
                  }
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    updateGeoResultKeyboardCursor((current) => {
                      if (!filteredGeoResultCount) {
                        return -1;
                      }
                      return Math.min(current + 1, filteredGeoResultCount - 1);
                    });
                    return;
                  }
                  if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    updateGeoResultKeyboardCursor((current) => {
                      if (!filteredGeoResultCount) {
                        return -1;
                      }
                      return Math.max(current - 1, 0);
                    });
                    return;
                  }
                  if (event.key === 'Escape') {
                    if (!geoResultSearchInput) {
                      return;
                    }
                    event.preventDefault();
                    setGeoResultSearchInput('');
                    return;
                  }
                  if (event.key !== 'Enter') {
                    return;
                  }
                  if (event.metaKey || event.ctrlKey) {
                    event.preventDefault();
                    if (handleQuickGeoResultAction()) {
                      return;
                    }
                    if (firstEligibleFilteredGeoDataset && !isGeoSetupActionDisabled) {
                      void handlePrepareGeoDesignFromNcbi(firstEligibleFilteredGeoDataset);
                      return;
                    }
                    if (firstFilteredGeoDataset) {
                      runGeoDatasetPrimaryAction(firstFilteredGeoDataset);
                    }
                    return;
                  }
                  const liveCursor = geoResultKeyboardCursorRef.current;
                  const liveResultIndex =
                    liveCursor >= 0 && liveCursor < sortedFilteredGeoIndices.length
                      ? sortedFilteredGeoIndices[liveCursor]
                      : -1;
                  const liveActiveFilteredGeoResult = liveResultIndex >= 0 ? geoResults[liveResultIndex] : null;
                  if (liveActiveFilteredGeoResult && runGeoDatasetPrimaryAction(liveActiveFilteredGeoResult)) {
                    event.preventDefault();
                    return;
                  }
                  if (handleQuickGeoResultAction()) {
                    event.preventDefault();
                  }
                }}
              />
              <div className="bulk-filter-actions">
                <button
                  className="secondary-button bulk-clear-button"
                  disabled={!geoResultSearchInput || isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                  onClick={() => {
                    setGeoResultSearchInput('');
                  }}
                >
                  Clear
                </button>
                <button
                  className="secondary-button"
                  disabled={!exactGeoResultAccessionUrl || isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                  onClick={() => {
                    if (!exactGeoResultAccessionUrl) {
                      return;
                    }
                    window.open(exactGeoResultAccessionUrl, '_blank', 'noopener,noreferrer');
                  }}
                >
                  Open accession
                </button>
              </div>
            </div>
            <div className="geo-preset-row" role="group" aria-label="Quick GEO filter presets">
              {GEO_RESULT_FILTER_PRESETS.map((preset) => (
                <button
                  key={preset.label}
                  className="status-filter-chip"
                  disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                  onClick={() => {
                    applyGeoResultFilterPreset(preset.query, preset.status);
                  }}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="geo-results-actions-row">
              <div className="geo-results-sort-toggle" role="group" aria-label="Sort GEO results">
                <button
                  className={`status-filter-chip ${geoResultSortMode === 'ranked' ? 'is-active' : ''}`}
                  disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                  onClick={() => {
                    setGeoResultSortMode('ranked');
                  }}
                >
                  Ranked
                </button>
                <button
                  className={`status-filter-chip ${geoResultSortMode === 'samples' ? 'is-active' : ''}`}
                  disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                  onClick={() => {
                    setGeoResultSortMode('samples');
                  }}
                >
                  Samples
                </button>
                <button
                  className={`status-filter-chip ${geoResultSortMode === 'accession' ? 'is-active' : ''}`}
                  disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                  onClick={() => {
                    setGeoResultSortMode('accession');
                  }}
                >
                  Accession
                </button>
              </div>
              <div className="geo-results-sort-toggle" role="group" aria-label="GEO result card density">
                <button
                  className={`status-filter-chip ${geoResultDensity === 'comfortable' ? 'is-active' : ''}`}
                  disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                  onClick={() => {
                    setGeoResultDensity('comfortable');
                  }}
                >
                  Comfortable
                </button>
                <button
                  className={`status-filter-chip ${geoResultDensity === 'compact' ? 'is-active' : ''}`}
                  disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                  onClick={() => {
                    setGeoResultDensity('compact');
                  }}
                >
                  Compact
                </button>
              </div>
              <button
                className="secondary-button"
                disabled={!firstEligibleFilteredGeoDataset || isGeoSetupActionDisabled}
                onClick={() => {
                  if (!firstEligibleFilteredGeoDataset) {
                    return;
                  }
                  void handlePrepareGeoDesignFromNcbi(firstEligibleFilteredGeoDataset);
                }}
              >
                Setup Top Eligible
              </button>
              <button
                className="secondary-button"
                disabled={!filteredGeoResultCount || isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={copyFilteredGeoAccessions}
              >
                Copy filtered accessions
              </button>
              <button
                className="secondary-button"
                disabled={!filteredGeoResultCount || isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={downloadFilteredGeoTsv}
              >
                Download filtered TSV
              </button>
            </div>
            <div className="geo-results-status-toggle" role="group" aria-label="Filter GEO results by status">
              <button
                className={`status-filter-chip ${geoResultStatusFilter === 'all' ? 'is-active' : ''}`}
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  setGeoResultStatusFilter('all');
                }}
              >
                All ({geoResultStatusCounts.all.toLocaleString()})
              </button>
              <button
                className={`status-filter-chip status-filter-chip-ok ${geoResultStatusFilter === 'eligible' ? 'is-active' : ''}`}
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  setGeoResultStatusFilter('eligible');
                }}
              >
                Eligible ({geoResultStatusCounts.eligible.toLocaleString()})
              </button>
              <button
                className={`status-filter-chip status-filter-chip-pending ${geoResultStatusFilter === 'checking' ? 'is-active' : ''}`}
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  setGeoResultStatusFilter('checking');
                }}
              >
                Checking ({geoResultStatusCounts.checking.toLocaleString()})
              </button>
              <button
                className={`status-filter-chip status-filter-chip-muted ${geoResultStatusFilter === 'excluded' ? 'is-active' : ''}`}
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  setGeoResultStatusFilter('excluded');
                }}
              >
                Not ready ({geoResultStatusCounts.excluded.toLocaleString()})
              </button>
            </div>
            <div className="geo-status-meter" aria-hidden="true">
              <span
                className="geo-status-meter-segment geo-status-meter-eligible"
                style={{
                  width: `${geoResultStatusCounts.all ? (geoResultStatusCounts.eligible / geoResultStatusCounts.all) * 100 : 0}%`,
                }}
              />
              <span
                className="geo-status-meter-segment geo-status-meter-checking"
                style={{
                  width: `${geoResultStatusCounts.all ? (geoResultStatusCounts.checking / geoResultStatusCounts.all) * 100 : 0}%`,
                }}
              />
              <span
                className="geo-status-meter-segment geo-status-meter-excluded"
                style={{
                  width: `${geoResultStatusCounts.all ? (geoResultStatusCounts.excluded / geoResultStatusCounts.all) * 100 : 0}%`,
                }}
              />
            </div>
            <p className="muted-text geo-results-shortcuts">
              Shortcuts: <code>Ctrl/Cmd + F</code> focus filter, <code>Arrow Up/Down</code> move selection,{' '}
              <code>PageUp/PageDown</code> fast-jump, <code>Home/End</code> edge jump, <code>Enter</code> run action,{' '}
              <code>Esc</code> clear, <code>/</code> focus filter.
            </p>
          </div>
          <p className="muted-text table-footnote">
            Showing {filteredGeoResultCount.toLocaleString()} of {geoResults.length.toLocaleString()} filtered GEO candidates.
          </p>
          <p className="muted-text table-footnote">
            GEO cache: query {geoSearchCacheStats.queryCacheHits.toLocaleString()} hit /{' '}
            {geoSearchCacheStats.queryCacheMisses.toLocaleString()} miss · accession{' '}
            {geoSearchCacheStats.accessionCacheHits.toLocaleString()} hit /{' '}
            {geoSearchCacheStats.accessionCacheMisses.toLocaleString()} miss ·
            in-memory entries {geoSearchCacheStats.queryEntries.toLocaleString()}/{geoSearchCacheStats.accessionEntries.toLocaleString()}
          </p>
          <p className="muted-text table-footnote geo-performance-footnote">
            <span className={`geo-latency-badge geo-latency-badge-${geoLatencyBadge.tone}`}>
              {geoLatencyBadge.label}
            </span>{' '}
            Search latency: <strong>{geoFilterState.elapsedMs.toFixed(2)} ms</strong> filter +{' '}
            <strong>{sortedGeoFilterState.elapsedMs.toFixed(2)} ms</strong> sort · Tokens:{' '}
            <strong>{geoResultQueryTokens.length}</strong>
          </p>
          <p className="muted-text table-footnote">
            Sort mode: <strong>{geoResultSortMode === 'ranked' ? 'Builder ranking' : geoResultSortMode === 'samples' ? 'Largest sample count first' : 'Accession order'}</strong>
          </p>
          <p className="muted-text table-footnote">
            Card density: <strong>{geoResultDensity === 'compact' ? 'Compact (faster scan)' : 'Comfortable (more context)'}</strong>
          </p>
          <p className="muted-text table-footnote">
            Shortcut: <code>Ctrl/Cmd + F</code> focuses this result filter.
          </p>
          <p className="muted-text table-footnote">
            Tip: type an exact <code>GSE</code> accession, then press <code>Enter</code> or click <strong>Open accession</strong>.
          </p>
          <p className="muted-text table-footnote">
            Advanced filter: <code>field:value</code>, <code>-exclude</code>, exact phrase <code>"..."</code> (fields: <code>accession</code>, <code>title</code>, <code>summary</code>, <code>organism</code>, <code>pmid</code>).
          </p>
          <p className="muted-text table-footnote">
            Keyboard: <code>↑/↓</code> move selection, <code>PgUp/PgDn</code> page jump, <code>Home/End</code> edge jump,{' '}
            <code>Enter</code> opens selected card (or setup if eligible).
          </p>
          <p className="muted-text table-footnote">
            Shortcut: <code>Ctrl/Cmd + Enter</code> runs <strong>Setup Top Eligible</strong> from this filter box.
          </p>
          <div
            ref={geoResultsViewportRef}
            className="geo-results-viewport"
            onScroll={(event) => {
              latestGeoResultsScrollTopRef.current = event.currentTarget.scrollTop;
              if (geoResultsScrollAnimationFrameRef.current !== null) {
                return;
              }
              geoResultsScrollAnimationFrameRef.current = window.requestAnimationFrame(() => {
                geoResultsScrollAnimationFrameRef.current = null;
                setGeoResultsScrollTop(latestGeoResultsScrollTopRef.current);
              });
            }}
          >
            <div className="geo-results">
              <div style={{ height: `${virtualGeoPaddingTop}px` }} />
              {virtualGeoIndices.map((resultIndex, visibleIndex) => {
                const dataset = geoResults[resultIndex];
                if (!dataset) {
                  return null;
                }
                const filteredPosition = virtualGeoStartIndex + visibleIndex;
                return (
                  <GeoResultCard
                    key={dataset.accession}
                    dataset={dataset}
                    isActive={geoResultKeyboardCursor === filteredPosition}
                    resultPosition={filteredPosition}
                    cardHeight={geoResultCardHeight}
                    isActionDisabled={isGeoSetupActionDisabled}
                    isPreparingDesign={isPreparingDesign}
                    activeGeoActionKey={activeGeoActionKey}
                    queryTokens={geoResultQueryTokens}
                    highlightRegex={geoResultHighlightRegex}
                    density={geoResultDensity}
                    onActivatePosition={activateGeoResultCursor}
                    onPrepare={handlePrepareGeoDesignFromNcbi}
                  />
                );
              })}
              <div style={{ height: `${virtualGeoPaddingBottom}px` }} />
              {!filteredGeoResultCount && (
                <p className="empty-state">No GEO candidates match the current result filter.</p>
              )}
            </div>
          </div>
          {filteredGeoResultCount > visibleGeoResultCapacity && (
            <p className="muted-text table-footnote">
              Virtualized rendering active: {virtualGeoIndices.length.toLocaleString()} cards mounted for{' '}
              {filteredGeoResultCount.toLocaleString()} filtered GEO results.
            </p>
          )}
        </section>
      )}

      {designSession && (
        <section ref={designPanelRef} className="panel design-panel" tabIndex={-1}>
          <div className="panel-header">
            <div>
              <h2>Sample group and batch setup</h2>
              <p className="muted-text">
                {designSession.source === 'ncbi'
                  ? `${designSession.dataset?.accession ?? 'GEO'} selected`
                  : 'Private files selected'}
                {' · '}
                A={groupCounts.A} / B={groupCounts.B} / Excluded={groupCounts.excluded}
              </p>
            </div>
            <div className="panel-actions">
              <button
                className="secondary-button"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  void handlePrepareLocalAnalysis();
                }}
              >
                {isParsing && activeGeoActionKey === 'run:analysis' ? 'Preparing input…' : 'Prepare local analysis'}
              </button>
              <button
                className="secondary-button"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  dispatch({ type: 'reset' });
                  setPreparedInput(null);
                  setActiveGeoActionKey('');
                  setAppError('');
                  setGeoError('');
                }}
              >
                Reset setup
              </button>

            </div>
          </div>

          {isDirtySinceLastRun && (
            <p className="issue warning">
              Current sample setup has changed. Prepare a new input bundle and rerun the local R command.
            </p>
          )}

          <div className="local-run-instructions">
            <p>Download the input bundle, then run this command from the project directory:</p>
            <code>npm run analyze:local -- {preparedInput?.filename || 'input.json'} --output results/local</code>
            <p>Import the generated viewer JSON above. The standalone report can also be opened directly without a server.</p>
            {preparedInput && <p className={preparedInput.revision === draftState.analysisRevision ? 'status-pill' : 'issue warning'} aria-live="polite">
              {preparedInput.revision === draftState.analysisRevision
                ? `Prepared ${preparedInput.filename}. No statistical analysis has run in this browser.`
                : 'Sample setup changed after the download. Prepare a new bundle before running R.'}
            </p>}
          </div>

          {designSession.groupFactorId === 'manual' && (
            <p className="issue info">No biological comparison was selected automatically. Assign samples to A/B or choose a documented comparison factor; unrelated binary metadata are not treated as the study contrast.</p>
          )}

          <div className="design-controls-grid">
            <label className="file-input-field">
              <span>Condition A label</span>
              <input
                type="text"
                value={designSession.conditionA}
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  dispatch({ type: 'set_condition_label', key: 'A', value: event.target.value });
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Condition B label</span>
              <input
                type="text"
                value={designSession.conditionB}
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  dispatch({ type: 'set_condition_label', key: 'B', value: event.target.value });
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Group factor (binary)</span>
              <select
                value={designSession.groupFactorId}
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGroupFactor(event.target.value);
                }}
              >
                <option value="manual">Manual sample assignments</option>
                {binaryGroupFactors.map((factor) => (
                  <option key={factor.id} value={factor.id}>
                    {factor.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="file-input-field">
              <span>Batch factor (optional)</span>
              <select
                value={designSession.batchFactorId}
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setBatchFactor(event.target.value);
                }}
              >
                <option value={NO_BATCH_FACTOR}>No batch adjustment</option>
                {designSession.preview.factors.map((factor) => (
                  <option key={factor.id} value={factor.id}>
                    {factor.label} ({factor.uniqueValues.length} levels)
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="bulk-tools">
            <div className="bulk-filter-row">
              <input
                ref={sampleFilterInputRef}
                className="geo-search-input"
                type="text"
                inputMode="search"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={sampleFilterInput}
                placeholder="Filter samples by ID/title/metadata (shortcut: /)"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  const nextValue = event.target.value;
                  startSampleFilterTransition(() => {
                    setSampleFilterInput(nextValue);
                  });
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Escape') {
                    return;
                  }
                  if (!sampleFilterInput) {
                    return;
                  }
                  event.preventDefault();
                  setSampleFilterInput('');
                }}
              />
              <button
                className="secondary-button bulk-clear-button"
                disabled={!sampleFilterInput || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  setSampleFilterInput('');
                  sampleFilterInputRef.current?.focus();
                }}
              >
                Clear
              </button>
            </div>
            <p className="muted-text table-footnote geo-performance-footnote" aria-live="polite">
              <span className={`geo-latency-badge geo-latency-badge-${sampleFilterLatencyBadge.tone}`}>
                {sampleFilterLatencyBadge.label}
              </span>
              Filter latency: <strong>{sampleFilterState.elapsedMs.toFixed(2)} ms</strong>.{' '}
              {filteredSampleIds.length.toLocaleString()} of {designSession.preview.sampleIds.length.toLocaleString()}{' '}
              samples match the current filter.
              {isSampleFilterPending ? ' Updating…' : ''}
            </p>
            <div className="bulk-actions">
              <button
                className="secondary-button"
                disabled={!filteredSampleIds.length || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => assignFilteredGroup('A')}
              >
                Filtered -&gt; A
              </button>
              <button
                className="secondary-button"
                disabled={!filteredSampleIds.length || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => assignFilteredGroup('B')}
              >
                Filtered -&gt; B
              </button>
              <button
                className="secondary-button"
                disabled={!filteredSampleIds.length || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => assignFilteredGroup('')}
              >
                Filtered -&gt; Exclude
              </button>
            </div>
            <div className="bulk-batch-row">
              <input
                className="geo-search-input"
                type="text"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                value={bulkBatchValue}
                placeholder="Batch label for filtered samples (example: Batch_2)"
                disabled={!isBatchEnabled || isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  dispatch({ type: 'set_bulk_batch_value', value: event.target.value });
                }}
              />
              <button
                className="secondary-button"
                disabled={
                  !isBatchEnabled ||
                  !filteredSampleIds.length ||
                  !bulkBatchValue.trim() ||
                  isParsing ||
                  isPreparingDesign ||
                  isGeneratingReport
                }
                onClick={assignFilteredBatch}
              >
                Apply batch label
              </button>
            </div>
            {!isBatchEnabled && (
              <p className="muted-text">Batch adjustment is off. Select a batch factor to enable batch labels.</p>
            )}
          </div>

          <div className="design-table-wrap">
            <div className="design-table">
              <div className="design-row design-head">
                <span>Sample</span>
                <span>Title</span>
                <span>Group</span>
                <span>Batch</span>
              </div>
              <div
                ref={designTableViewportRef}
                className="design-table-viewport"
                onScroll={(event) => {
                  latestTableScrollTopRef.current = event.currentTarget.scrollTop;
                  if (tableScrollAnimationFrameRef.current !== null) {
                    return;
                  }
                  tableScrollAnimationFrameRef.current = window.requestAnimationFrame(() => {
                    tableScrollAnimationFrameRef.current = null;
                    setTableScrollTop(latestTableScrollTopRef.current);
                  });
                }}
              >
                <div style={{ height: `${virtualPaddingTop}px` }} />
                {virtualSampleIds.map((sampleId, index) => (
                  <SampleDesignRow
                    key={sampleId}
                    rowIndex={virtualStartIndex + index}
                    sampleId={sampleId}
                    sampleTitle={designSession.preview.sampleTitles[sampleId] ?? ''}
                    groupValue={designSession.groupBySample[sampleId] ?? ''}
                    batchValue={designSession.batchBySample[sampleId] ?? ''}
                    conditionA={designSession.conditionA}
                    conditionB={designSession.conditionB}
                    disableGroupEdit={isParsing || isPreparingDesign || isGeneratingReport}
                    disableBatchEdit={!isBatchEnabled || isParsing || isPreparingDesign || isGeneratingReport}
                    onUpdateGroup={updateSampleGroup}
                    onUpdateBatch={updateSampleBatch}
                  />
                ))}
                <div style={{ height: `${virtualPaddingBottom}px` }} />
              </div>
            </div>
            {filteredSampleIds.length > visibleRowCapacity && (
              <p className="muted-text table-footnote">
                Virtualized rendering active: {virtualSampleIds.length.toLocaleString()} rows mounted for{' '}
                {filteredSampleIds.length.toLocaleString()} filtered samples.
              </p>
            )}
          </div>
        </section>
      )}

      <section className="grid-layout">
        <article className="panel">
          <h2>Data routes</h2>
          <ul className="compact-list">
            <li>
              Public route: search GEO, pick human dataset with NCBI-generated raw counts, assign groups/batch,
              prepare a local R input bundle.
            </li>
            <li>
              Private route: upload raw counts + series matrix, assign groups/batch, download the input bundle and run the local R command.
            </li>
            <li>
              For large cohorts, filter + bulk assign tools speed up manual editing.
            </li>
            <li>
              Memory guard: very large matrices are stopped early with guidance for high-memory DESeq2 execution.
            </li>
          </ul>
        </article>

        <article className="panel">
          <h2>Built-in reference assets</h2>
          <div className="stats-grid">
            <div className="stat-card">
              <span>Reactome pathways</span>
              <strong>{referenceSummary.reactomePathways.toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>Hallmark pathways</span>
              <strong>{referenceSummary.hallmarkPathways.toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>PPI genes</span>
              <strong>{referenceSummary.ppiGenes.toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>PPI edges (total)</span>
              <strong>{referenceSummary.ppiEdges.toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>STRING edges</span>
              <strong>{(referenceSummary.stringPpiEdges ?? referenceSummary.ppiEdges).toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>HuRI edges</span>
              <strong>{(referenceSummary.huriPpiEdges ?? 0).toLocaleString()}</strong>
            </div>
          </div>
          <p className="muted-text">
            Hallmark mode: <strong>{referenceSummary.hallmarkMode}</strong> · STRING cutoff:{' '}
            <strong>{referenceSummary.stringScoreCutoff}</strong>
          </p>
        </article>
      </section>

      <section className="panel result-panel">
        <div className="panel-header">
          <div>
            <h2>Analysis snapshot</h2>
            <p className="muted-text">
              {result && loadedFileName ? `Imported results: ${loadedFileName}` : 'Import completed local R results or an external workbook.'}
            </p>
          </div>
          {result?.viewerData ? (
            <button
              className="file-button"
              onClick={() => {
                void handleGenerateReport();
              }}
              disabled={isReportDownloadDisabled}
            >
              {isGeneratingReport
                ? 'Generating report…'
                : isDirtySinceLastRun
                  ? 'Import fresh local results'
                  : 'Download report.html'}
            </button>
          ) : null}
        </div>

        {result?.viewerData?.evidence && (
          <p className={`issue ${result.viewerData.evidence.verification.status === 'mismatch' ? 'error' : 'info'}`}>
            Source verification: {{
              verified_against_supplied_artifacts: 'Matched against supplied artifacts',
              internally_consistent: 'Internal consistency only',
              unverifiable: 'Not verified',
              mismatch: 'Mismatch detected',
            }[result.viewerData.evidence.verification.status]}
            {' · '}Analysis method: {result.viewerData.evidence.analysis.method}
          </p>
        )}

        {isParsing && (
          <p className="status-pill" aria-live="polite">
            Reading or preparing files…
          </p>
        )}
        {!isParsing && result && isDirtySinceLastRun && (
          <p className="issue warning">
            The visible design draft no longer matches the last analysis snapshot. Rerun locally and import fresh results.
          </p>
        )}
        {!isParsing && appError && <p className="issue error">{appError}</p>}

        {!isParsing && !result && (
          <p className="empty-state">
            Prepare an input bundle from GEO or private files, run the local R command, then import the resulting viewer JSON.
          </p>
        )}

        {result && (
          <>
            <div className="stats-grid">
              <div className="stat-card">
                <span>Genes</span>
                <strong>{result.summary.totalGenes.toLocaleString()}</strong>
              </div>
              <div className="stat-card">
                <span>Pathways</span>
                <strong>{result.summary.totalPathways.toLocaleString()}</strong>
              </div>
              <div className="stat-card">
                <span>Significant pathways</span>
                <strong>{result.summary.significantPathways.toLocaleString()}</strong>
              </div>
              <div className="stat-card">
                <span>Leading-edge fallback</span>
                <strong>{result.summary.fallbackPathways.toLocaleString()}</strong>
              </div>
            </div>

            <div className="issues-block">
              <h3>Validation report</h3>
              <ul className="issue-list">
                {result.issues.length ? (
                  result.issues.map((issue, index) => (
                    <li key={`${issue.message}-${index}`} className={`issue ${issue.level}`}>
                      <strong>{issue.level.toUpperCase()}</strong> {issue.message}
                      {issue.context ? <span> · {issue.context}</span> : null}
                    </li>
                  ))
                ) : (
                  <li className="issue success">No validation issues detected.</li>
                )}
              </ul>
            </div>

            {result.viewerData && (
              <div className="pathway-preview">
                <h3>Top pathways</h3>
                <div className="preview-table">
                  <div className="preview-row preview-head">
                    <span>Pathway</span>
                    <span>Collection</span>
                    <span>NES</span>
                    <span>FDR</span>
                    <span>Genes</span>
                  </div>
                  {result.viewerData.pathways.slice(0, 8).map((pathway) => (
                    <div className="preview-row" key={pathway.key}>
                      <span>{pathway.pathwayName}</span>
                      <span>{pathway.collection}</span>
                      <span>{pathway.nes == null ? 'Not tested' : pathway.nes.toFixed(2)}</span>
                      <span>{pathway.padj == null ? 'Not tested' : pathway.padj.toExponential(2)}</span>
                      <span>{pathway.allGenes.length}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
