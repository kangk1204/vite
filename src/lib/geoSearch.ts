const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const GEO_BASE = 'https://www.ncbi.nlm.nih.gov';
const GEO_QUERY_CACHE_TTL_MS = 10 * 60 * 1000;
const GEO_ACCESSION_CACHE_TTL_MS = 30 * 60 * 1000;
const GEO_QUERY_CACHE_MAX_ENTRIES = 32;
const GEO_QUERY_CACHE_MAX_RESULTS = 320;
const GEO_ACCESSION_CACHE_MAX_ENTRIES = 320;
const GEO_CACHE_PERSIST_DEBOUNCE_MS = 300;
const GEO_MIN_REQUEST_INTERVAL_MS = 350;
const GEO_REQUEST_RETRY_MAX_ATTEMPTS = 2;
const GEO_REQUEST_RETRY_BASE_DELAY_MS = 600;
const GEO_REQUEST_RETRY_MAX_DELAY_MS = 8_000;
const GEO_QUERY_CACHE_STORAGE_KEY = 'pnv.geo.query-cache.v3';
const GEO_ACCESSION_CACHE_STORAGE_KEY = 'pnv.geo.accession-cache.v3';
const GEO_METADATA_ORGANISM_FILTER = '"Homo sapiens"[Organism]';
const GEO_METADATA_DATASET_TYPE_FILTER = '"expression profiling by high throughput sequencing"[DataSet Type]';
const SHARED_GEO_CACHE_ENDPOINT = import.meta.env.VITE_GEO_CACHE_ENDPOINT?.trim().replace(/\/+$/, '') ?? '';
let geoRequestGate = Promise.resolve();
let nextGeoRequestStartAt = 0;

interface ESearchResponse {
  esearchresult?: {
    count?: string;
    idlist?: string[];
  };
}

interface ESummaryRecord {
  accession?: string;
  title?: string;
  summary?: string;
  taxon?: string;
  n_samples?: number;
  pubmedids?: string[];
  ftplink?: string;
}

interface ESummaryResponse {
  result?: {
    uids?: string[];
    [uid: string]: ESummaryRecord | string[] | undefined;
  };
}

export interface GeoSearchResult {
  accession: string;
  title: string;
  summary: string;
  organism: string;
  sampleCount: number;
  pubmedId?: string;
  geoUrl: string;
  downloadUrl: string;
  hasNcbiGeneratedRawCounts: boolean;
  rawCountsUrl?: string;
  rawCountsFilename?: string;
  seriesMatrixUrl?: string;
  tpmUrl?: string;
  fpkmUrl?: string;
  annotationUrl?: string;
  eligibilityStatus: 'checking' | 'eligible' | 'excluded';
  isEligible: boolean;
  eligibilityReason?: string;
  availabilityCheckFailed?: boolean;
}

export interface GeoSearchResponse {
  results: GeoSearchResult[];
  rawHitCount: number;
  inspectedCount: number;
  checkingCount: number;
  eligibleCount: number;
  excludedCount: number;
  complete: boolean;
}

export interface GeoSearchSession {
  initialResponse: GeoSearchResponse;
  completion: Promise<GeoSearchResponse>;
}

export interface GeoSearchOptions {
  signal?: AbortSignal;
  onProgress?: (response: GeoSearchResponse) => void;
  initialPageSize?: number;
}

type DownloadLinks = Pick<
  GeoSearchResult,
  | 'hasNcbiGeneratedRawCounts'
  | 'rawCountsUrl'
  | 'rawCountsFilename'
  | 'seriesMatrixUrl'
  | 'tpmUrl'
  | 'fpkmUrl'
  | 'annotationUrl'
>;

const geoQueryCache = new Map<string, { expiresAt: number; response: GeoSearchResponse }>();
const geoAccessionCache = new Map<string, { expiresAt: number; result: GeoSearchResult }>();
const inFlightAccessionHydration = new Map<string, Promise<GeoSearchResult>>();
let geoQueryCacheLoaded = false;
let geoAccessionCacheLoaded = false;
let geoCachePersistTimer: number | null = null;
let geoQueryCacheHitCount = 0;
let geoQueryCacheMissCount = 0;
let geoAccessionCacheHitCount = 0;
let geoAccessionCacheMissCount = 0;

export interface GeoSearchCacheStats {
  queryCacheHits: number;
  queryCacheMisses: number;
  accessionCacheHits: number;
  accessionCacheMisses: number;
  queryEntries: number;
  accessionEntries: number;
}

function sanitizeText(value: unknown): string {
  return String(value ?? '').trim();
}

function stripQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replace(/""/g, '"').trim();
  }
  return trimmed;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === 'AbortError'
    : error instanceof Error && error.name === 'AbortError';
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new DOMException('The operation was aborted.', 'AbortError');
  }
}

function canUseStorage(): boolean {
  if (import.meta.env.MODE === 'test') {
    return false;
  }
  if (typeof navigator !== 'undefined' && /jsdom/i.test(navigator.userAgent)) {
    return false;
  }
  return (
    typeof window !== 'undefined' &&
    typeof window.localStorage !== 'undefined' &&
    typeof window.localStorage.getItem === 'function' &&
    typeof window.localStorage.setItem === 'function' &&
    typeof window.localStorage.removeItem === 'function'
  );
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldThrottleGeoRequests(): boolean {
  return import.meta.env.MODE !== 'test';
}

async function waitForGeoRequestSlot(signal?: AbortSignal): Promise<void> {
  if (!shouldThrottleGeoRequests()) {
    return;
  }
  const slot = geoRequestGate;
  let releaseSlot = () => {};
  geoRequestGate = new Promise<void>((resolve) => {
    releaseSlot = resolve;
  });
  await slot;
  try {
    throwIfAborted(signal);
    const now = Date.now();
    const startAt = Math.max(now, nextGeoRequestStartAt);
    const waitMs = startAt - now;
    if (waitMs > 0) await sleep(waitMs);
    throwIfAborted(signal);
    nextGeoRequestStartAt = Math.max(now, startAt) + GEO_MIN_REQUEST_INTERVAL_MS;
  } finally {
    releaseSlot();
  }
}

function parseRetryAfterHeader(response: Response): number | null {
  const header = response.headers.get('retry-after');
  if (!header) {
    return null;
  }
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = new Date(header).getTime();
  if (Number.isFinite(date)) {
    return Math.max(0, date - Date.now());
  }
  return null;
}

function calculateRetryDelayMs(attempt: number, response: Response | null): number {
  if (response) {
    const retryAfterMs = parseRetryAfterHeader(response);
    if (retryAfterMs !== null) {
      return Math.min(Math.max(retryAfterMs, 0), GEO_REQUEST_RETRY_MAX_DELAY_MS);
    }
  }
  return Math.min(GEO_REQUEST_RETRY_BASE_DELAY_MS * 2 ** attempt, GEO_REQUEST_RETRY_MAX_DELAY_MS);
}

function formatGeoRequestError(status: number, url: string): string {
  if (status === 429) {
    return `HTTP 429 (rate limited) while requesting ${url}. Slow down or use an API key.`;
  }
  return `HTTP ${status} while requesting ${url}`;
}

async function fetchWithRateLimit(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  let attempt = 0;
  while (true) {
    await waitForGeoRequestSlot(signal);
    throwIfAborted(signal);
    try {
      const response = await fetch(url, init);
      if (
        (response.status === 429 || (response.status >= 500 && response.status < 600)) &&
        attempt < GEO_REQUEST_RETRY_MAX_ATTEMPTS
      ) {
        await sleep(calculateRetryDelayMs(attempt, response));
        attempt += 1;
        continue;
      }
      return response;
    } catch (error) {
      if (isAbortError(error) || attempt >= GEO_REQUEST_RETRY_MAX_ATTEMPTS) {
        throw error;
      }
      await sleep(calculateRetryDelayMs(attempt, null));
      attempt += 1;
    }
  }
}

function cloneGeoSearchResult(result: GeoSearchResult): GeoSearchResult {
  return { ...result };
}

function normalizeCachedGeoSearchResult(result: GeoSearchResult): GeoSearchResult {
  const eligibilityStatus =
    result.eligibilityStatus ?? (result.isEligible ? 'eligible' : result.eligibilityReason ? 'excluded' : 'checking');
  return {
    ...result,
    eligibilityStatus,
    isEligible: eligibilityStatus === 'eligible',
    eligibilityReason:
      result.eligibilityReason ?? (eligibilityStatus === 'checking' ? 'Checking NCBI-generated raw counts…' : undefined),
  };
}

function cloneGeoSearchResponse(response: GeoSearchResponse): GeoSearchResponse {
  const normalizedResults = response.results.map(normalizeCachedGeoSearchResult);
  let inspectedCount = 0;
  let eligibleCount = 0;
  let excludedCount = 0;
  normalizedResults.forEach((item) => {
    if (item.eligibilityStatus !== 'checking') {
      inspectedCount += 1;
    }
    if (item.eligibilityStatus === 'eligible') {
      eligibleCount += 1;
      return;
    }
    if (item.eligibilityStatus === 'excluded') {
      excludedCount += 1;
    }
  });
  const checkingCount = normalizedResults.length - inspectedCount;
  return {
    ...response,
    results: normalizedResults.map(cloneGeoSearchResult),
    inspectedCount,
    checkingCount,
    eligibleCount,
    excludedCount,
    complete: response.complete !== false,
  };
}

function pruneCacheMap<T extends { expiresAt: number }>(cache: Map<string, T>, maxEntries: number): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
  while (cache.size > maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) {
      break;
    }
    cache.delete(oldestKey);
  }
}

function touchCacheEntry<T>(cache: Map<string, T>, key: string, entry: T): void {
  cache.delete(key);
  cache.set(key, entry);
}

function loadGeoCaches(): void {
  if (!canUseStorage()) {
    geoQueryCacheLoaded = true;
    geoAccessionCacheLoaded = true;
    return;
  }
  try {
    if (!geoQueryCacheLoaded) {
      geoQueryCacheLoaded = true;
      const rawQueryCache = window.localStorage.getItem(GEO_QUERY_CACHE_STORAGE_KEY);
      if (rawQueryCache) {
        const entries = JSON.parse(rawQueryCache) as Array<[string, { expiresAt: number; response: GeoSearchResponse }]>
        entries.forEach(([key, entry]) => {
          if (entry?.expiresAt > Date.now()) {
            geoQueryCache.set(key, entry);
          }
        });
        pruneCacheMap(geoQueryCache, GEO_QUERY_CACHE_MAX_ENTRIES);
      }
    }
    if (!geoAccessionCacheLoaded) {
      geoAccessionCacheLoaded = true;
      const rawAccessionCache = window.localStorage.getItem(GEO_ACCESSION_CACHE_STORAGE_KEY);
      if (rawAccessionCache) {
        const entries = JSON.parse(rawAccessionCache) as Array<[string, { expiresAt: number; result: GeoSearchResult }]>
        entries.forEach(([key, entry]) => {
          if (entry?.expiresAt > Date.now()) {
            geoAccessionCache.set(key, entry);
          }
        });
        pruneCacheMap(geoAccessionCache, GEO_ACCESSION_CACHE_MAX_ENTRIES);
      }
    }
  } catch {
    // Ignore corrupted persistent cache state.
  }
}

function persistGeoCachesNow(): void {
  if (!canUseStorage()) {
    return;
  }
  try {
    pruneCacheMap(geoQueryCache, GEO_QUERY_CACHE_MAX_ENTRIES);
    pruneCacheMap(geoAccessionCache, GEO_ACCESSION_CACHE_MAX_ENTRIES);
    window.localStorage.setItem(
      GEO_QUERY_CACHE_STORAGE_KEY,
      JSON.stringify(Array.from(geoQueryCache.entries())),
    );
    window.localStorage.setItem(
      GEO_ACCESSION_CACHE_STORAGE_KEY,
      JSON.stringify(Array.from(geoAccessionCache.entries())),
    );
  } catch {
    // Ignore storage quota failures.
  }
}

function schedulePersistGeoCaches(): void {
  if (!canUseStorage()) {
    return;
  }
  if (geoCachePersistTimer !== null) {
    return;
  }
  if (typeof window === 'undefined' || typeof window.setTimeout !== 'function') {
    persistGeoCachesNow();
    return;
  }
  geoCachePersistTimer = window.setTimeout(() => {
    geoCachePersistTimer = null;
    persistGeoCachesNow();
  }, GEO_CACHE_PERSIST_DEBOUNCE_MS);
}

function cancelScheduledGeoCachePersist(): void {
  if (geoCachePersistTimer === null) {
    return;
  }
  if (typeof window !== 'undefined' && typeof window.clearTimeout === 'function') {
    window.clearTimeout(geoCachePersistTimer);
  }
  geoCachePersistTimer = null;
}

function canUseSharedGeoCache(): boolean {
  return Boolean(SHARED_GEO_CACHE_ENDPOINT);
}

async function fetchSharedGeoCacheJson<T>(
  path: string,
  init: RequestInit = {},
  signal?: AbortSignal,
): Promise<T | null> {
  if (!canUseSharedGeoCache()) {
    return null;
  }
  try {
    throwIfAborted(signal);
    const response = await fetch(`${SHARED_GEO_CACHE_ENDPOINT}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...(init.headers ?? {}),
      },
      signal,
    });
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    return null;
  }
}

async function getSharedGeoQuery(queryKey: string, signal?: AbortSignal): Promise<GeoSearchResponse | null> {
  const payload = await fetchSharedGeoCacheJson<{ response?: GeoSearchResponse }>(
    `/api/geo-cache/query?key=${encodeURIComponent(queryKey)}`,
    {},
    signal,
  );
  return payload?.response ? cloneGeoSearchResponse(payload.response) : null;
}

async function setSharedGeoQuery(queryKey: string, response: GeoSearchResponse): Promise<void> {
  await fetchSharedGeoCacheJson(
    `/api/geo-cache/query?key=${encodeURIComponent(queryKey)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ response }),
    },
  );
}

async function getSharedGeoAccessionBatch(
  accessions: string[],
  signal?: AbortSignal,
): Promise<Record<string, GeoSearchResult>> {
  if (!accessions.length) {
    return {};
  }
  const payload = await fetchSharedGeoCacheJson<{ items?: Record<string, GeoSearchResult> }>(
    '/api/geo-cache/accessions/lookup',
    {
      method: 'POST',
      body: JSON.stringify({ accessions }),
    },
    signal,
  );
  if (!payload?.items) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(payload.items).map(([accession, result]) => [accession, normalizeCachedGeoSearchResult(result)]),
  );
}

async function setSharedGeoAccession(result: GeoSearchResult): Promise<void> {
  await fetchSharedGeoCacheJson(
    `/api/geo-cache/accession?key=${encodeURIComponent(result.accession)}`,
    {
      method: 'PUT',
      body: JSON.stringify({ result }),
    },
  );
}

function getCachedGeoQuery(queryKey: string): GeoSearchResponse | null {
  loadGeoCaches();
  const entry = geoQueryCache.get(queryKey);
  if (!entry) {
    geoQueryCacheMissCount += 1;
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    geoQueryCache.delete(queryKey);
    schedulePersistGeoCaches();
    geoQueryCacheMissCount += 1;
    return null;
  }
  geoQueryCacheHitCount += 1;
  touchCacheEntry(geoQueryCache, queryKey, entry);
  return cloneGeoSearchResponse(entry.response);
}

function setCachedGeoQuery(queryKey: string, response: GeoSearchResponse): void {
  loadGeoCaches();
  if (response.results.length > GEO_QUERY_CACHE_MAX_RESULTS) {
    if (geoQueryCache.delete(queryKey)) {
      schedulePersistGeoCaches();
    }
    return;
  }
  touchCacheEntry(geoQueryCache, queryKey, {
    expiresAt: Date.now() + GEO_QUERY_CACHE_TTL_MS,
    response: cloneGeoSearchResponse(response),
  });
  pruneCacheMap(geoQueryCache, GEO_QUERY_CACHE_MAX_ENTRIES);
  schedulePersistGeoCaches();
}

function getCachedGeoAccession(accession: string): GeoSearchResult | null {
  loadGeoCaches();
  const entry = geoAccessionCache.get(accession);
  if (!entry) {
    geoAccessionCacheMissCount += 1;
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    geoAccessionCache.delete(accession);
    schedulePersistGeoCaches();
    geoAccessionCacheMissCount += 1;
    return null;
  }
  geoAccessionCacheHitCount += 1;
  touchCacheEntry(geoAccessionCache, accession, entry);
  return cloneGeoSearchResult(entry.result);
}

function setCachedGeoAccession(result: GeoSearchResult): void {
  loadGeoCaches();
  touchCacheEntry(geoAccessionCache, result.accession, {
    expiresAt: Date.now() + GEO_ACCESSION_CACHE_TTL_MS,
    result: cloneGeoSearchResult(result),
  });
  pruneCacheMap(geoAccessionCache, GEO_ACCESSION_CACHE_MAX_ENTRIES);
  schedulePersistGeoCaches();
}

export function __resetGeoSearchCachesForTests(): void {
  cancelScheduledGeoCachePersist();
  geoQueryCache.clear();
  geoAccessionCache.clear();
  geoQueryCacheLoaded = false;
  geoAccessionCacheLoaded = false;
  geoQueryCacheHitCount = 0;
  geoQueryCacheMissCount = 0;
  geoAccessionCacheHitCount = 0;
  geoAccessionCacheMissCount = 0;
  if (canUseStorage()) {
    window.localStorage.removeItem(GEO_QUERY_CACHE_STORAGE_KEY);
    window.localStorage.removeItem(GEO_ACCESSION_CACHE_STORAGE_KEY);
  }
}

export function getGeoSearchCacheStats(): GeoSearchCacheStats {
  loadGeoCaches();
  return {
    queryCacheHits: geoQueryCacheHitCount,
    queryCacheMisses: geoQueryCacheMissCount,
    accessionCacheHits: geoAccessionCacheHitCount,
    accessionCacheMisses: geoAccessionCacheMissCount,
    queryEntries: geoQueryCache.size,
    accessionEntries: geoAccessionCache.size,
  };
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetchWithRateLimit(url, { signal }, signal);
  if (!response.ok) {
    throw new Error(formatGeoRequestError(response.status, url));
  }
  return (await response.json()) as T;
}

async function maybeGunzip(bytes: Uint8Array): Promise<string> {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error(
        'This browser does not support gzip decompression (DecompressionStream). Please update the browser.',
      );
    }
    const byteBuffer =
      bytes.buffer instanceof ArrayBuffer
        ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
        : Uint8Array.from(bytes).buffer;
    const stream = new Blob([byteBuffer]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Response(stream).text();
  }
  return new TextDecoder().decode(bytes);
}

async function fetchTextMaybeGzip(url: string, label: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetchWithRateLimit(url, { signal }, signal);
    if (!response.ok) {
      throw new Error(formatGeoRequestError(response.status, url));
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return maybeGunzip(bytes);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new Error(
        `Failed to download ${label}. Browser or network access failed for ${url}. Download the files manually and use Private analysis.`,
      );
    }
    throw error;
  }
}

function normalizeGeoHref(rawHref: string): string {
  const href = stripQuotes(rawHref).replace(/&amp;/g, '&');
  if (!href) {
    return '';
  }
  if (href.startsWith('//')) {
    return `https:${href}`;
  }
  if (href.startsWith('/')) {
    return `${GEO_BASE}${href}`;
  }
  if (href.startsWith('ftp://ftp.ncbi.nlm.nih.gov/')) {
    return href.replace('ftp://ftp.ncbi.nlm.nih.gov/', 'https://ftp.ncbi.nlm.nih.gov/');
  }
  if (href.startsWith('http://ftp.ncbi.nlm.nih.gov/')) {
    return href.replace('http://ftp.ncbi.nlm.nih.gov/', 'https://ftp.ncbi.nlm.nih.gov/');
  }
  if (href.startsWith('http://')) {
    return `https://${href.slice('http://'.length)}`;
  }
  return href;
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractDownloadFilenameFromHref(href: string): string {
  const fileMatch = href.match(/[?&]file=([^&]+)/i);
  if (fileMatch?.[1]) {
    return safeDecodeURIComponent(fileMatch[1]);
  }

  const path = href.split(/[?#]/, 1)[0];
  const lastSegment = path.split('/').filter(Boolean).pop();
  if (!lastSegment) {
    return '';
  }
  return safeDecodeURIComponent(lastSegment);
}

function classifyRnaSeqFile(filename: string): 'raw_counts' | 'tpm' | 'fpkm' | 'annot' | null {
  const lower = filename.toLowerCase();
  if (!lower) {
    return null;
  }
  if (lower.includes('annot') && lower.endsWith('.tsv.gz')) {
    return 'annot';
  }
  if (lower.includes('norm_counts_tpm') || lower.includes('tpm')) {
    return 'tpm';
  }
  if (lower.includes('norm_counts_fpkm') || lower.includes('fpkm')) {
    return 'fpkm';
  }
  if (
    lower.includes('raw_counts') ||
    ((lower.includes('count') || lower.endsWith('_counts.tsv.gz')) &&
      !lower.includes('tpm') &&
      !lower.includes('fpkm') &&
      !lower.includes('norm'))
  ) {
    return 'raw_counts';
  }
  return null;
}

function firstMatchByHeuristic(
  candidates: Array<{ filename: string; url: string }>,
  key: 'raw_counts' | 'tpm' | 'fpkm' | 'annot',
): { filename: string; url: string } | undefined {
  for (const candidate of candidates) {
    const classified = classifyRnaSeqFile(candidate.filename);
    if (classified === key) {
      return candidate;
    }
  }
  return undefined;
}

export function parseGeoDownloadLinksFromHtml(html: string): DownloadLinks {
  const rnaseqCandidates: Array<{ filename: string; url: string }> = [];
  let seriesMatrixUrl: string | undefined;
  for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>`]+))/gi)) {
    const rawHref = match[1] || match[2] || match[3] || '';
    const href = normalizeGeoHref(rawHref.replace(/&amp;/g, '&'));
    if (!href) {
      continue;
    }
    if (!seriesMatrixUrl && /series_matrix\.txt\.gz/i.test(href)) {
      seriesMatrixUrl = href;
    }

    const filename = extractDownloadFilenameFromHref(href);
    const classification = classifyRnaSeqFile(filename);
    if (!classification) {
      continue;
    }
    rnaseqCandidates.push({ filename, url: href });
  }

  const rawCountsMatch = firstMatchByHeuristic(rnaseqCandidates, 'raw_counts');
  const tpmMatch = firstMatchByHeuristic(rnaseqCandidates, 'tpm');
  const fpkmMatch = firstMatchByHeuristic(rnaseqCandidates, 'fpkm');
  const annotationMatch = firstMatchByHeuristic(rnaseqCandidates, 'annot');

  return {
    hasNcbiGeneratedRawCounts: Boolean(rawCountsMatch),
    rawCountsUrl: rawCountsMatch?.url,
    rawCountsFilename: rawCountsMatch?.filename,
    seriesMatrixUrl,
    tpmUrl: tpmMatch?.url,
    fpkmUrl: fpkmMatch?.url,
    annotationUrl: annotationMatch?.url,
  };
}

function simplifySummary(summary: string): string {
  const compact = summary.replace(/\s+/g, ' ').trim();
  if (compact.length <= 240) {
    return compact;
  }
  return `${compact.slice(0, 237).trimEnd()}...`;
}

function parseSearchCount(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function buildGeoSearchTerm(query: string): string {
  const baseTerm = /^GSE\d+$/i.test(query) ? `${query}[ACCN]` : `(${query})`;
  return [baseTerm, 'gse[ETYP]', GEO_METADATA_ORGANISM_FILTER, GEO_METADATA_DATASET_TYPE_FILTER].join(' AND ');
}

function getGeoImmediateExclusionReason(result: GeoSearchResult): string | undefined {
  if (!/homo sapiens|human/i.test(result.organism)) {
    return 'Excluded: non-human study';
  }
  return undefined;
}

function getGeoEligibilityReason(result: GeoSearchResult): string | undefined {
  return (
    getGeoImmediateExclusionReason(result) ??
    (!result.seriesMatrixUrl ? 'Excluded: series matrix metadata unavailable' : undefined) ??
    (!result.hasNcbiGeneratedRawCounts ? 'Excluded: NCBI-generated raw counts unavailable' : undefined)
  );
}

function finalizeGeoSearchResult(result: GeoSearchResult): GeoSearchResult {
  const eligibilityReason = getGeoEligibilityReason(result);
  return {
    ...result,
    eligibilityStatus: eligibilityReason ? 'excluded' : 'eligible',
    isEligible: !eligibilityReason,
    eligibilityReason,
  };
}

function createCheckingGeoSearchResult(base: GeoSearchResult): GeoSearchResult {
  return {
    ...base,
    eligibilityStatus: 'checking',
    isEligible: false,
    eligibilityReason: 'Checking NCBI-generated raw counts…',
  };
}

function compareGeoResults(left: GeoSearchResult, right: GeoSearchResult): number {
  const rankByStatus = { eligible: 2, checking: 1, excluded: 0 } as const;
  return (
    rankByStatus[right.eligibilityStatus] - rankByStatus[left.eligibilityStatus] ||
    Number(right.hasNcbiGeneratedRawCounts) - Number(left.hasNcbiGeneratedRawCounts) ||
    right.sampleCount - left.sampleCount
  );
}

function sortGeoResults(results: GeoSearchResult[]): void {
  results.sort(compareGeoResults);
}

function buildGeoSearchResponseFromSorted(
  sortedResults: GeoSearchResult[],
  rawHitCount: number,
  complete: boolean,
): GeoSearchResponse {
  const responseResults = sortedResults.slice();
  let inspectedCount = 0;
  let eligibleCount = 0;
  let excludedCount = 0;
  responseResults.forEach((item) => {
    if (item.eligibilityStatus !== 'checking') {
      inspectedCount += 1;
    }
    if (item.eligibilityStatus === 'eligible') {
      eligibleCount += 1;
      return;
    }
    if (item.eligibilityStatus === 'excluded') {
      excludedCount += 1;
    }
  });
  const checkingCount = responseResults.length - inspectedCount;
  return {
    results: responseResults,
    rawHitCount,
    inspectedCount,
    checkingCount,
    eligibleCount,
    excludedCount,
    complete,
  };
}

function buildGeoSearchResponse(results: GeoSearchResult[], rawHitCount: number, complete: boolean): GeoSearchResponse {
  const sortedResults = results.slice();
  sortGeoResults(sortedResults);
  return buildGeoSearchResponseFromSorted(sortedResults, rawHitCount, complete);
}

function emitGeoSearchProgress(
  onProgress: ((response: GeoSearchResponse) => void) | undefined,
  results: GeoSearchResult[],
  rawHitCount: number,
): void {
  if (!onProgress) {
    return;
  }
  const progressResults = results.slice();
  sortGeoResults(progressResults);
  onProgress(buildGeoSearchResponseFromSorted(progressResults, rawHitCount, false));
}

function buildSingleResultResponse(result: GeoSearchResult): GeoSearchResponse {
  return buildGeoSearchResponse([result], 1, true);
}

function buildGeoBaseResult(entry: ESummaryRecord): GeoSearchResult | null {
  const accession = sanitizeText(entry.accession);
  if (!/^GSE\d+$/i.test(accession)) {
    return null;
  }
  return {
    accession,
    title: sanitizeText(entry.title) || accession,
    summary: simplifySummary(sanitizeText(entry.summary)),
    organism: sanitizeText(entry.taxon) || 'Unknown',
    sampleCount: Number(entry.n_samples ?? 0),
    pubmedId: entry.pubmedids?.[0],
    geoUrl: `${GEO_BASE}/geo/query/acc.cgi?acc=${encodeURIComponent(accession)}`,
    downloadUrl: `${GEO_BASE}/geo/download/?acc=${encodeURIComponent(accession)}`,
    hasNcbiGeneratedRawCounts: false,
    rawCountsUrl: undefined,
    rawCountsFilename: undefined,
    seriesMatrixUrl: undefined,
    tpmUrl: undefined,
    fpkmUrl: undefined,
    annotationUrl: undefined,
    eligibilityStatus: 'checking',
    isEligible: false,
    eligibilityReason: undefined,
  };
}

function applyKnownGeoStatus(result: GeoSearchResult): GeoSearchResult {
  const cached = getCachedGeoAccession(result.accession);
  if (cached) {
    return {
      ...result,
      ...cached,
      seriesMatrixUrl: cached.seriesMatrixUrl ?? result.seriesMatrixUrl,
    };
  }
  const preExcludedReason = getGeoImmediateExclusionReason(result);
  if (preExcludedReason) {
    return {
      ...result,
      eligibilityStatus: 'excluded',
      isEligible: false,
      eligibilityReason: preExcludedReason,
    };
  }
  return createCheckingGeoSearchResult(result);
}

async function verifyFtpDownloads(rawCountsUrl: string, accession: string, signal?: AbortSignal): Promise<DownloadLinks | null> {
  const seriesMatrixUrl = `https://ftp.ncbi.nlm.nih.gov/geo/series/${accession.slice(0, -3)}nnn/${accession}/matrix/${accession}_series_matrix.txt.gz`;
  const [counts, matrix] = await Promise.all([
    fetchWithRateLimit(rawCountsUrl, { method: 'HEAD', signal }, signal),
    fetchWithRateLimit(seriesMatrixUrl, { method: 'HEAD', signal }, signal),
  ]);
  if (!counts.ok || !matrix.ok) return null;
  return { hasNcbiGeneratedRawCounts: true, rawCountsUrl, rawCountsFilename: extractDownloadFilenameFromHref(rawCountsUrl), seriesMatrixUrl };
}

async function tryNcbiFtpCountLinks(base: GeoSearchResult, signal?: AbortSignal): Promise<DownloadLinks | null> {
  try {
    const directoryUrl = `https://ftp.ncbi.nlm.nih.gov/geo/rnaseq_counts/${base.accession.slice(0, -3)}nnn/`;
    const listing = await fetchTextMaybeGzip(directoryUrl, `NCBI count directory (${base.accession})`, signal);
    for (const match of listing.matchAll(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>`]+))/gi)) {
      const rawHref = match[1] || match[2] || match[3] || '';
      const url = new URL(rawHref.replace(/&amp;/g, '&'), directoryUrl);
      const filename = extractDownloadFilenameFromHref(url.href);
      if (url.origin !== 'https://ftp.ncbi.nlm.nih.gov' || !url.href.startsWith(directoryUrl)) continue;
      if (!filename.toUpperCase().startsWith(`${base.accession.toUpperCase()}_`) || classifyRnaSeqFile(filename) !== 'raw_counts') continue;
      return await verifyFtpDownloads(url.href, base.accession, signal);
    }
    return null;
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

async function trySoftDownloadLinks(base: GeoSearchResult, signal?: AbortSignal): Promise<DownloadLinks | null> {
  try {
    const soft = await fetchTextMaybeGzip(
      `${base.geoUrl}&targ=self&form=text&view=full`, `SOFT metadata (${base.accession})`, signal,
    );
    const rawCountsUrl = soft.split(/\r?\n/)
      .filter((line) => line.startsWith('!Series_supplementary_file = '))
      .map((line) => normalizeGeoHref(line.slice(line.indexOf('=') + 1).trim()))
      .find((url) => /^https:\/\/ftp\.ncbi\.nlm\.nih\.gov\/geo\/series\//i.test(url)
        && classifyRnaSeqFile(extractDownloadFilenameFromHref(url)) === 'raw_counts');
    if (!rawCountsUrl) return null;
    return await verifyFtpDownloads(rawCountsUrl, base.accession, signal);
  } catch (error) {
    if (isAbortError(error)) throw error;
    return null;
  }
}

async function enrichSearchResult(base: GeoSearchResult, signal?: AbortSignal): Promise<GeoSearchResult> {
  const cached = getCachedGeoAccession(base.accession);
  if (cached) {
    return {
      ...base,
      ...cached,
      seriesMatrixUrl: cached.seriesMatrixUrl ?? base.seriesMatrixUrl,
    };
  }
  const existingHydration = inFlightAccessionHydration.get(base.accession);
  if (existingHydration) {
    const resolved = await existingHydration;
    return {
      ...base,
      ...resolved,
      seriesMatrixUrl: resolved.seriesMatrixUrl ?? base.seriesMatrixUrl,
    };
  }

  const hydrationPromise = (async (): Promise<GeoSearchResult> => {
    try {
      const downloadHtml = await fetchTextMaybeGzip(`${base.downloadUrl}&format=text`, `download page (${base.accession})`, signal);
      const links = parseGeoDownloadLinksFromHtml(downloadHtml);
      const finalized = finalizeGeoSearchResult({
        ...base,
        ...links,
        seriesMatrixUrl: links.seriesMatrixUrl ?? base.seriesMatrixUrl,
      });
      setCachedGeoAccession(finalized);
      void setSharedGeoAccession(finalized);
      return finalized;
    } catch (error) {
      if (isAbortError(error)) {
        throw error;
      }
      const fallback = await tryNcbiFtpCountLinks(base, signal) ?? await trySoftDownloadLinks(base, signal);
      if (fallback) {
        const finalized = finalizeGeoSearchResult({ ...base, ...fallback });
        setCachedGeoAccession(finalized);
        void setSharedGeoAccession(finalized);
        return finalized;
      }
      return {
        ...base,
        eligibilityStatus: 'excluded',
        isEligible: false,
        availabilityCheckFailed: true,
        eligibilityReason: 'Availability check failed: browser/network access could not verify raw-count files. Retry the search, or open GEO and upload downloaded files with Private analysis.',
      };
    }
  })();
  inFlightAccessionHydration.set(base.accession, hydrationPromise);
  try {
    const resolved = await hydrationPromise;
    return {
      ...base,
      ...resolved,
      seriesMatrixUrl: resolved.seriesMatrixUrl ?? base.seriesMatrixUrl,
    };
  } finally {
    if (inFlightAccessionHydration.get(base.accession) === hydrationPromise) {
      inFlightAccessionHydration.delete(base.accession);
    }
  }
}

async function fetchGeoSummaryPage(
  term: string,
  retstart: number,
  retmax: number,
  seenAccessions: Set<string>,
  signal?: AbortSignal,
): Promise<{ rawHitCount: number; nextRetstart: number; results: GeoSearchResult[] }> {
  const esearchUrl = `${EUTILS_BASE}/esearch.fcgi?db=gds&retmode=json&retmax=${retmax}&retstart=${retstart}&term=${encodeURIComponent(term)}`;
  const searchPayload = await fetchJson<ESearchResponse>(esearchUrl, signal);
  const searchResult = searchPayload.esearchresult;
  const ids = searchResult?.idlist?.filter(Boolean) ?? [];
  const rawHitCount = parseSearchCount(searchResult?.count, retstart + ids.length);
  if (!ids.length) {
    return {
      rawHitCount,
      nextRetstart: retstart,
      results: [],
    };
  }

  const esummaryUrl = `${EUTILS_BASE}/esummary.fcgi?db=gds&retmode=json&id=${encodeURIComponent(ids.join(','))}`;
  const summaryPayload = await fetchJson<ESummaryResponse>(esummaryUrl, signal);
  const uidList = summaryPayload.result?.uids ?? [];
  const results: GeoSearchResult[] = [];
  for (const uid of uidList) {
    const entry = summaryPayload.result?.[uid];
    if (!entry || Array.isArray(entry)) {
      continue;
    }
    const baseResult = buildGeoBaseResult(entry);
    if (!baseResult || seenAccessions.has(baseResult.accession)) {
      continue;
    }
    seenAccessions.add(baseResult.accession);
    results.push(baseResult);
  }
  return {
    rawHitCount,
    nextRetstart: retstart + ids.length,
    results,
  };
}

async function hydrateGeoResults(
  pendingResults: GeoSearchResult[],
  existingResults: GeoSearchResult[],
  rawHitCount: number,
  onProgress: ((response: GeoSearchResponse) => void) | undefined,
  signal?: AbortSignal,
): Promise<GeoSearchResult[]> {
  const nextResults = existingResults.slice();
  const resultIndexByAccession = new Map<string, number>();
  nextResults.forEach((item, index) => {
    resultIndexByAccession.set(item.accession, index);
  });
  const sharedCachedResults = await getSharedGeoAccessionBatch(
    pendingResults.map((item) => item.accession),
    signal,
  );
  const remainingResults = pendingResults.filter((item) => {
    const sharedCached = sharedCachedResults[item.accession];
    if (!sharedCached) {
      return true;
    }
    const existingIndex = resultIndexByAccession.get(item.accession);
    const merged = {
      ...item,
      ...sharedCached,
      seriesMatrixUrl: sharedCached.seriesMatrixUrl ?? item.seriesMatrixUrl,
    };
    setCachedGeoAccession(merged);
    if (typeof existingIndex === 'number') {
      nextResults[existingIndex] = merged;
    } else {
      resultIndexByAccession.set(merged.accession, nextResults.length);
      nextResults.push(merged);
    }
    return false;
  });
  if (remainingResults.length !== pendingResults.length) {
    emitGeoSearchProgress(onProgress, nextResults, rawHitCount);
  }
  const batchSize = 6;
  for (let index = 0; index < remainingResults.length; index += batchSize) {
    throwIfAborted(signal);
    const batch = await Promise.all(
      remainingResults.slice(index, index + batchSize).map((item) => enrichSearchResult(item, signal)),
    );
    batch.forEach((resolvedItem) => {
      const existingIndex = resultIndexByAccession.get(resolvedItem.accession);
      if (typeof existingIndex === 'number') {
        nextResults[existingIndex] = resolvedItem;
      } else {
        resultIndexByAccession.set(resolvedItem.accession, nextResults.length);
        nextResults.push(resolvedItem);
      }
    });
    emitGeoSearchProgress(onProgress, nextResults, rawHitCount);
  }
  sortGeoResults(nextResults);
  return nextResults;
}

export async function startGeoDatasetSearch(
  query: string,
  limit = 8,
  options: GeoSearchOptions = {},
): Promise<GeoSearchSession> {
  const normalized = query.trim();
  if (!normalized) {
    const empty: GeoSearchResponse = {
      results: [],
      rawHitCount: 0,
      inspectedCount: 0,
      checkingCount: 0,
      eligibleCount: 0,
      excludedCount: 0,
      complete: true,
    };
    return {
      initialResponse: empty,
      completion: Promise.resolve(empty),
    };
  }

  const queryKey = normalized.toLowerCase();
  const cachedResponse = getCachedGeoQuery(queryKey);
  if (cachedResponse) {
    return {
      initialResponse: cachedResponse,
      completion: Promise.resolve(cachedResponse),
    };
  }
  const directAccession = /^GSE\d+$/i.test(normalized) ? normalized.toUpperCase() : null;
  if (directAccession) {
    const cachedAccession = getCachedGeoAccession(directAccession);
    if (cachedAccession) {
      const single = buildSingleResultResponse(normalizeCachedGeoSearchResult(cachedAccession));
      setCachedGeoQuery(queryKey, single);
      return {
        initialResponse: single,
        completion: Promise.resolve(single),
      };
    }
    const sharedAccessionMap = await getSharedGeoAccessionBatch([directAccession], options.signal);
    const sharedAccession = sharedAccessionMap[directAccession];
    if (sharedAccession) {
      setCachedGeoAccession(sharedAccession);
      const single = buildSingleResultResponse(sharedAccession);
      setCachedGeoQuery(queryKey, single);
      return {
        initialResponse: single,
        completion: Promise.resolve(single),
      };
    }
  }
  const sharedCachedResponse = await getSharedGeoQuery(queryKey, options.signal);
  if (sharedCachedResponse) {
    setCachedGeoQuery(queryKey, sharedCachedResponse);
    return {
      initialResponse: sharedCachedResponse,
      completion: Promise.resolve(sharedCachedResponse),
    };
  }

  const term = buildGeoSearchTerm(normalized);
  const initialPageSize = Math.max(options.initialPageSize ?? limit, 12);
  const backgroundPageSize = Math.max(limit, 18);
  const seenAccessions = new Set<string>();

  const initialPage = await fetchGeoSummaryPage(term, 0, initialPageSize, seenAccessions, options.signal);
  const initialResults = initialPage.results.map(applyKnownGeoStatus);
  sortGeoResults(initialResults);
  const initialResponse = buildGeoSearchResponseFromSorted(initialResults, initialPage.rawHitCount, false);

  const completion = (async () => {
    let currentResults = initialResults.slice();
    let currentRawHitCount = initialPage.rawHitCount;
    currentResults = await hydrateGeoResults(
      currentResults.filter((item) => item.eligibilityStatus === 'checking'),
      currentResults,
      currentRawHitCount,
      options.onProgress,
      options.signal,
    );

    let nextRetstart = initialPage.nextRetstart;
    let eligibleCount = currentResults.reduce(
      (count, item) => count + (item.eligibilityStatus === 'eligible' ? 1 : 0),
      0,
    );
    while (eligibleCount < limit) {
      throwIfAborted(options.signal);
      if (nextRetstart >= currentRawHitCount) {
        break;
      }
      const page = await fetchGeoSummaryPage(term, nextRetstart, backgroundPageSize, seenAccessions, options.signal);
      nextRetstart = page.nextRetstart;
      currentRawHitCount = Math.max(currentRawHitCount, page.rawHitCount);
      if (!page.results.length) {
        break;
      }
      const pageResults = page.results.map(applyKnownGeoStatus);
      currentResults = currentResults.concat(pageResults);
      emitGeoSearchProgress(options.onProgress, currentResults, currentRawHitCount);
      currentResults = await hydrateGeoResults(
        pageResults.filter((item) => item.eligibilityStatus === 'checking'),
        currentResults,
        currentRawHitCount,
        options.onProgress,
        options.signal,
      );
      eligibleCount = currentResults.reduce(
        (count, item) => count + (item.eligibilityStatus === 'eligible' ? 1 : 0),
        0,
      );
    }

    sortGeoResults(currentResults);
    const finalResponse = buildGeoSearchResponseFromSorted(currentResults, currentRawHitCount, true);
    if (!finalResponse.results.some((item) => item.availabilityCheckFailed)) {
      setCachedGeoQuery(queryKey, finalResponse);
      void setSharedGeoQuery(queryKey, finalResponse);
    }
    options.onProgress?.(finalResponse);
    return finalResponse;
  })();

  return {
    initialResponse,
    completion,
  };
}

export async function searchGeoDatasets(
  query: string,
  limit = 8,
  options: GeoSearchOptions = {},
): Promise<GeoSearchResponse> {
  const session = await startGeoDatasetSearch(query, limit, options);
  return session.completion;
}
