import type { WorkbookParseResult } from '../types';

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const GEO_BASE = 'https://www.ncbi.nlm.nih.gov';
const MAX_GEO_FILE_BYTES = 128 * 1024 * 1024;
const GEO_QUERY_CACHE_TTL_MS = 10 * 60 * 1000;
const GEO_ACCESSION_CACHE_TTL_MS = 30 * 60 * 1000;
const GEO_QUERY_CACHE_MAX_ENTRIES = 32;
const GEO_ACCESSION_CACHE_MAX_ENTRIES = 320;
const GEO_CACHE_PERSIST_DEBOUNCE_MS = 300;
const GEO_MIN_REQUEST_INTERVAL_MS = 350;
const GEO_REQUEST_RETRY_MAX_ATTEMPTS = 2;
const GEO_REQUEST_RETRY_BASE_DELAY_MS = 600;
const GEO_REQUEST_RETRY_MAX_DELAY_MS = 8_000;
const GEO_QUERY_CACHE_STORAGE_KEY = 'pnv.geo.query-cache.v2';
const GEO_ACCESSION_CACHE_STORAGE_KEY = 'pnv.geo.accession-cache.v2';
const GEO_METADATA_ORGANISM_FILTER = '"Homo sapiens"[Organism]';
const GEO_METADATA_DATASET_TYPE_FILTER = '"expression profiling by high throughput sequencing"[DataSet Type]';
const SHARED_GEO_CACHE_ENDPOINT = import.meta.env.VITE_GEO_CACHE_ENDPOINT?.trim().replace(/\/+$/, '') ?? '';
let geoRequestGate = Promise.resolve();
let nextGeoRequestStartAt = 0;
const geoQueryCache = new Map<string, { expiresAt: number; response: GeoSearchResponse }>();
const geoAccessionCache = new Map<string, { expiresAt: number; result: GeoSearchResult }>();
let geoQueryCacheLoaded = false;
let geoAccessionCacheLoaded = false;
let geoCachePersistTimer: number | null = null;
interface ESearchResponse {
  esearchresult?: {
    count?: string;
    idlist?: string[];
  };
}

interface ESummaryRecord {
  uid?: string;
  accession?: string;
  title?: string;
  summary?: string;
  taxon?: string;
  entrytype?: string;
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

interface GeoSearchOptions {
  signal?: AbortSignal;
  onProgress?: (response: GeoSearchResponse) => void;
  initialPageSize?: number;
}

interface ParsedGroupInfo {
  factorName: string;
  conditionA: string;
  conditionB: string;
  groupBySample: Record<string, 'A' | 'B'>;
}

interface ParsedSeriesFactor {
  id: string;
  label: string;
  values: string[];
  uniqueValues: string[];
  orderedBinaryValues?: [string, string];
}

interface ParsedSeriesMetadata {
  sampleIds: string[];
  sampleTitles: Record<string, string>;
  inferredGroups: ParsedGroupInfo;
  factors: ParsedSeriesFactor[];
}

interface SeriesSampleAlignment {
  seriesToRawSampleId: Map<string, string>;
  unresolvedSeriesSampleIds: string[];
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

export interface AnalyzeGeoFromTextOptions {
  accession?: string;
  title?: string;
  organism?: string;
  rawCountsText: string;
  seriesMatrixText: string;
  design?: GeoAnalysisDesign;
}

export interface AnalyzeGeoFromFilesOptions {
  accession?: string;
  title?: string;
  organism?: string;
  rawCountsFile: File;
  seriesMatrixFile: File;
  design?: GeoAnalysisDesign;
}

export type GeoGroupAssignment = 'A' | 'B' | '';

export interface GeoSeriesFactorOption {
  id: string;
  label: string;
  uniqueValues: string[];
  valuesBySample: Record<string, string>;
  orderedBinaryValues?: [string, string];
}

export interface GeoSeriesDesignPreview {
  sampleIds: string[];
  sampleTitles: Record<string, string>;
  factors: GeoSeriesFactorOption[];
  defaultGroupFactorId: string;
  defaultBatchFactorId?: string;
  defaultConditionA: string;
  defaultConditionB: string;
  defaultGroupBySample: Record<string, GeoGroupAssignment>;
}

export interface GeoAnalysisDesign {
  conditionA?: string;
  conditionB?: string;
  groupBySample?: Record<string, GeoGroupAssignment | undefined>;
  groupFactorName?: string;
  batchBySample?: Record<string, string | undefined>;
  batchFactorName?: string;
}

function sanitizeText(value: unknown): string {
  return String(value ?? '').trim();
}

export function parseGeoTabLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];

    if (char === '"') {
      if (inQuotes && line[index + 1] === '"') {
        current += '"';
        index += 1;
        continue;
      }
      inQuotes = !inQuotes;
      continue;
    }

    if (char === '\t' && !inQuotes) {
      fields.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  fields.push(current);
  return fields.map((value) => value.trim());
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
  throwIfAborted(signal);
  const now = Date.now();
  const startAt = Math.max(now, nextGeoRequestStartAt);
  const waitMs = startAt - now;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
  nextGeoRequestStartAt = Math.max(now, nextGeoRequestStartAt) + GEO_MIN_REQUEST_INTERVAL_MS;
  releaseSlot();
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
        const entries = JSON.parse(rawQueryCache) as Array<[string, { expiresAt: number; response: GeoSearchResponse }]>;
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
        const entries = JSON.parse(rawAccessionCache) as Array<[string, { expiresAt: number; result: GeoSearchResult }]>;
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
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    geoQueryCache.delete(queryKey);
    schedulePersistGeoCaches();
    return null;
  }
  touchCacheEntry(geoQueryCache, queryKey, entry);
  return cloneGeoSearchResponse(entry.response);
}

function setCachedGeoQuery(queryKey: string, response: GeoSearchResponse): void {
  loadGeoCaches();
  geoQueryCache.set(queryKey, {
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
    return null;
  }
  if (entry.expiresAt <= Date.now()) {
    geoAccessionCache.delete(accession);
    schedulePersistGeoCaches();
    return null;
  }
  touchCacheEntry(geoAccessionCache, accession, entry);
  return cloneGeoSearchResult(entry.result);
}

function setCachedGeoAccession(result: GeoSearchResult): void {
  loadGeoCaches();
  geoAccessionCache.set(result.accession, {
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
  if (canUseStorage()) {
    window.localStorage.removeItem(GEO_QUERY_CACHE_STORAGE_KEY);
    window.localStorage.removeItem(GEO_ACCESSION_CACHE_STORAGE_KEY);
  }
}

export function __getGeoSearchCacheSizesForTests(): { queryEntries: number; accessionEntries: number } {
  return {
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

async function readBoundedStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array<ArrayBuffer>> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_GEO_FILE_BYTES) {
        await reader.cancel();
        throw new Error('Input exceeds the 128 MiB browser memory limit. Use the local R workflow directly.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function maybeGunzip(bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > MAX_GEO_FILE_BYTES) throw new Error('Input exceeds the 128 MiB browser memory limit.');
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
    return new TextDecoder().decode(await readBoundedStream(stream));
  }
  return new TextDecoder().decode(bytes);
}

async function fetchTextMaybeGzip(url: string, label: string, signal?: AbortSignal): Promise<string> {
  try {
    const response = await fetchWithRateLimit(url, { signal }, signal);
    if (!response.ok) {
      throw new Error(formatGeoRequestError(response.status, url));
    }
    if (Number(response.headers.get('content-length')) > MAX_GEO_FILE_BYTES) {
      await response.body?.cancel();
      throw new Error('Download exceeds the 128 MiB browser memory limit. Use the local R workflow directly.');
    }
    const bytes = response.body ? await readBoundedStream(response.body) : new Uint8Array(await response.arrayBuffer());
    return maybeGunzip(bytes);
  } catch (error) {
    if (isAbortError(error)) {
      throw error;
    }
    if (error instanceof TypeError) {
      throw new Error(
        `Failed to download ${label}. Browser CORS blocked access to ${url}. Download the files manually and use private file upload.`,
      );
    }
    throw error;
  }
}

async function readTextMaybeGzipFromFile(file: File): Promise<string> {
  if (file.size > MAX_GEO_FILE_BYTES) throw new Error('Input file exceeds the 128 MiB browser memory limit. Use the local R workflow directly.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (/\.gz$/i.test(file.name) || (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b)) {
    return maybeGunzip(bytes);
  }
  return new TextDecoder().decode(bytes);
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
  const hrefMatches = html.matchAll(/\bhref\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'<>`]+))/gi);
  const hrefs = Array.from(hrefMatches, (match) => {
    const href = match[1] || match[2] || match[3] || '';
    return normalizeGeoHref(href.replace(/&amp;/g, '&'));
  }).filter(Boolean);

  const rnaseqCandidates: Array<{ filename: string; url: string }> = [];
  let seriesMatrixUrl: string | undefined;
  for (const href of hrefs) {
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
  return [
    baseTerm,
    'gse[ETYP]',
    GEO_METADATA_ORGANISM_FILTER,
    GEO_METADATA_DATASET_TYPE_FILTER,
  ].join(' AND ');
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

function buildGeoSearchResponse(results: GeoSearchResult[], rawHitCount: number, complete: boolean): GeoSearchResponse {
  const sortedResults = results.slice().sort(compareGeoResults);
  let inspectedCount = 0;
  let checkingCount = 0;
  let eligibleCount = 0;
  let excludedCount = 0;
  for (const item of sortedResults) {
    if (item.eligibilityStatus === 'checking') {
      checkingCount += 1;
      continue;
    }
    inspectedCount += 1;
    if (item.eligibilityStatus === 'eligible') {
      eligibleCount += 1;
      continue;
    }
    excludedCount += 1;
  }
  return {
    results: sortedResults,
    rawHitCount,
    inspectedCount,
    checkingCount,
    eligibleCount,
    excludedCount,
    complete,
  };
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

async function enrichSearchResult(base: GeoSearchResult, signal?: AbortSignal): Promise<GeoSearchResult> {
  const cached = getCachedGeoAccession(base.accession);
  if (cached) {
    return {
      ...base,
      ...cached,
      seriesMatrixUrl: cached.seriesMatrixUrl ?? base.seriesMatrixUrl,
    };
  }
  try {
    const downloadHtml = await fetchTextMaybeGzip(
      `${base.downloadUrl}&format=text`,
      `download page (${base.accession})`,
      signal,
    );
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
    const finalized = finalizeGeoSearchResult(base);
    setCachedGeoAccession(finalized);
    void setSharedGeoAccession(finalized);
    return finalized;
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
  const sharedCachedResults = await getSharedGeoAccessionBatch(
    pendingResults.map((item) => item.accession),
    signal,
  );
  const remainingResults = pendingResults.filter((item) => {
    const sharedCached = sharedCachedResults[item.accession];
    if (!sharedCached) {
      return true;
    }
    const existingIndex = nextResults.findIndex((candidate) => candidate.accession === item.accession);
    const merged = {
      ...item,
      ...sharedCached,
      seriesMatrixUrl: sharedCached.seriesMatrixUrl ?? item.seriesMatrixUrl,
    };
    setCachedGeoAccession(merged);
    if (existingIndex >= 0) {
      nextResults[existingIndex] = merged;
    } else {
      nextResults.push(merged);
    }
    return false;
  });
  if (remainingResults.length !== pendingResults.length) {
    onProgress?.(buildGeoSearchResponse(nextResults, rawHitCount, false));
  }
  const batchSize = 6;
  for (let index = 0; index < remainingResults.length; index += batchSize) {
    throwIfAborted(signal);
    const batch = await Promise.all(
      remainingResults.slice(index, index + batchSize).map((item) => enrichSearchResult(item, signal)),
    );
    batch.forEach((resolvedItem) => {
      const existingIndex = nextResults.findIndex((item) => item.accession === resolvedItem.accession);
      if (existingIndex >= 0) {
        nextResults[existingIndex] = resolvedItem;
      } else {
        nextResults.push(resolvedItem);
      }
    });
    onProgress?.(buildGeoSearchResponse(nextResults, rawHitCount, false));
  }
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
  const initialResponse = buildGeoSearchResponse(initialResults, initialPage.rawHitCount, false);

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
    while (currentResults.filter((item) => item.eligibilityStatus === 'eligible').length < limit) {
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
      options.onProgress?.(buildGeoSearchResponse(currentResults, currentRawHitCount, false));
      currentResults = await hydrateGeoResults(
        pageResults.filter((item) => item.eligibilityStatus === 'checking'),
        currentResults,
        currentRawHitCount,
        options.onProgress,
        options.signal,
      );
    }

    const finalResponse = buildGeoSearchResponse(currentResults, currentRawHitCount, true);
    setCachedGeoQuery(queryKey, finalResponse);
    void setSharedGeoQuery(queryKey, finalResponse);
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

function parseCharacteristic(value: string): { key: string; parsedValue: string } {
  const clean = stripQuotes(value).replace(/\s+/g, ' ').trim();
  const match = clean.match(/^([^:]+):\s*(.+)$/);
  if (!match) {
    return { key: 'characteristic', parsedValue: clean || 'NA' };
  }
  return {
    key: match[1].trim().toLowerCase(),
    parsedValue: match[2].trim() || 'NA',
  };
}

function normalizeCategory(value: string): string {
  const normalized = stripQuotes(value)
    .replace(/\s+/g, ' ')
    .trim();
  return normalized || 'NA';
}

function isControlLike(label: string): boolean {
  return /\b(control|healthy|normal|untreated|vehicle|wild[\s-]?type|wt|baseline|sham)\b/i.test(label);
}

function isCaseLike(label: string): boolean {
  return /\b(disease|lesional|treated|ko|knockout|mutant|case|tumou?r|cancer|infected)\b/i.test(label);
}

function orderConditions(left: string, right: string): [string, string] {
  if (isControlLike(left) && !isControlLike(right)) {
    return [left, right];
  }
  if (isControlLike(right) && !isControlLike(left)) {
    return [right, left];
  }
  if (isCaseLike(left) && !isCaseLike(right)) {
    return [right, left];
  }
  if (isCaseLike(right) && !isCaseLike(left)) {
    return [left, right];
  }
  return [left, right].sort((a, b) => a.localeCompare(b)) as [string, string];
}

function chooseBinaryFactor(sampleIds: string[], factors: Map<string, string[]>): ParsedGroupInfo | null {
  let best:
    | {
        score: number;
        factorName: string;
        labels: [string, string];
        values: string[];
      }
    | null = null;

  for (const [factorName, rawValues] of factors) {
    if (rawValues.length !== sampleIds.length) {
      continue;
    }

    const values = rawValues.map(normalizeCategory);
    const unique = Array.from(new Set(values));
    if (unique.length !== 2) {
      continue;
    }

    const counts = unique.map((label) => values.filter((value) => value === label).length);
    const minCount = Math.min(...counts);
    if (minCount < 2) {
      continue;
    }

    const [conditionA, conditionB] = orderConditions(unique[0], unique[1]);
    const explicitContrastFactor = /(?:^|[: _-])(group|condition|disease|diagnosis|phenotype|genotype|treatment)(?:$|[ _-])/i.test(factorName);
    const explicitContrastLabels = isControlLike(conditionA) && isCaseLike(conditionB);
    if (!explicitContrastFactor && !explicitContrastLabels) continue;
    let score = minCount * 10;
    if (explicitContrastFactor) {
      score += 25;
    }
    if (/(title|source)/i.test(factorName)) {
      score += 6;
    }
    if (/(time|hour|min|day)/i.test(factorName)) {
      score -= 10;
    }
    if (isControlLike(conditionA)) {
      score += 6;
    }

    if (!best || score > best.score) {
      best = {
        score,
        factorName,
        labels: [conditionA, conditionB],
        values,
      };
    }
  }

  if (!best) {
    return null;
  }

  const groupBySample: Record<string, 'A' | 'B'> = {};
  for (let index = 0; index < sampleIds.length; index += 1) {
    const sampleId = sampleIds[index];
    const value = best.values[index];
    groupBySample[sampleId] = value === best.labels[0] ? 'A' : 'B';
  }

  return {
    factorName: best.factorName,
    conditionA: best.labels[0],
    conditionB: best.labels[1],
    groupBySample,
  };
}

function humanizeFactorName(name: string): string {
  return name
    .replace(/^characteristic:/i, 'Characteristic: ')
    .replace(/^sample_/i, '')
    .replace(/^source_name/i, 'Source name')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function chooseBatchFactor(sampleIds: string[], factors: ParsedSeriesFactor[], groupFactorId: string): string | undefined {
  let best:
    | {
        score: number;
        factorId: string;
      }
    | undefined;

  for (const factor of factors) {
    if (factor.id === groupFactorId) {
      continue;
    }
    if (factor.values.length !== sampleIds.length) {
      continue;
    }
    const uniqueCount = factor.uniqueValues.length;
    if (uniqueCount < 2 || uniqueCount >= sampleIds.length) {
      continue;
    }

    const valueCounts = factor.uniqueValues.map(
      (value) => factor.values.filter((entry) => entry === value).length,
    );
    const minCount = Math.min(...valueCounts);
    if (minCount < 2) {
      continue;
    }

    let score = 0;
    if (/(batch|lane|run|center|platform|library|instrument|flowcell)/i.test(factor.id)) {
      score += 18;
    }
    if (/(title|source)/i.test(factor.id)) {
      score -= 6;
    }
    score += Math.min(uniqueCount, 8);
    score += Math.min(minCount, 5);

    if (!best || score > best.score) {
      best = { score, factorId: factor.id };
    }
  }

  return best?.factorId;
}

function mapFactorValuesBySample(sampleIds: string[], values: string[]): Record<string, string> {
  const bySample: Record<string, string> = {};
  for (let index = 0; index < sampleIds.length; index += 1) {
    bySample[sampleIds[index]] = values[index] ?? 'NA';
  }
  return bySample;
}

function parseSeriesMatrix(text: string): ParsedSeriesMetadata {
  const lines = text.split(/\r?\n/);
  const sampleColumns = new Map<string, string[]>();
  const characteristicsColumns: string[][] = [];
  const sampleTitles: Record<string, string> = {};

  for (const rawLine of lines) {
    if (!rawLine.startsWith('!Sample_')) {
      continue;
    }
    const fields = parseGeoTabLine(rawLine);
    if (fields.length < 2) {
      continue;
    }
    const columnName = fields[0].slice('!Sample_'.length).toLowerCase();
    const values = fields.slice(1).map(stripQuotes);
    if (columnName === 'characteristics_ch1') {
      characteristicsColumns.push(values);
      continue;
    }
    sampleColumns.set(columnName, values);
  }

  const sampleIds = sampleColumns.get('geo_accession')?.map(normalizeCategory) ?? [];
  if (!sampleIds.length) {
    throw new Error('Series matrix file is missing !Sample_geo_accession entries.');
  }
  if (sampleIds.some((id) => !id) || new Set(sampleIds).size !== sampleIds.length) {
    throw new Error('Series metadata contains empty or duplicate sample IDs.');
  }

  const factors = new Map<string, string[]>();
  const titles = sampleColumns.get('title');
  if (titles?.length === sampleIds.length) {
    factors.set('sample_title', titles.map(normalizeCategory));
  }
  const sources = sampleColumns.get('source_name_ch1');
  if (sources?.length === sampleIds.length) {
    factors.set('source_name', sources.map(normalizeCategory));
  }

  characteristicsColumns.forEach((columnValues, columnIndex) => {
    if (columnValues.length !== sampleIds.length) {
      return;
    }
    const parsed = columnValues.map((value) => parseCharacteristic(value));
    const key = parsed.find((entry) => entry.key !== 'characteristic')?.key ?? `characteristics_${columnIndex + 1}`;
    factors.set(
      `characteristic:${key}`,
      parsed.map((entry) => normalizeCategory(entry.parsedValue)),
    );
  });

  const inferredGroups = chooseBinaryFactor(sampleIds, factors) ?? {
    factorName: 'manual', conditionA: 'Condition A', conditionB: 'Condition B', groupBySample: {},
  };

  if (titles?.length === sampleIds.length) {
    for (let index = 0; index < sampleIds.length; index += 1) {
      sampleTitles[sampleIds[index]] = normalizeCategory(titles[index]);
    }
  }

  const parsedFactors: ParsedSeriesFactor[] = Array.from(factors.entries())
    .map(([id, values]) => {
      const normalizedValues = values.map(normalizeCategory);
      const uniqueValues = Array.from(new Set(normalizedValues));
      const orderedBinaryValues =
        uniqueValues.length === 2 ? orderConditions(uniqueValues[0], uniqueValues[1]) : undefined;
      return {
        id,
        label: humanizeFactorName(id),
        values: normalizedValues,
        uniqueValues,
        orderedBinaryValues,
      } satisfies ParsedSeriesFactor;
    })
    .sort((left, right) => left.label.localeCompare(right.label));

  return { sampleIds, sampleTitles, inferredGroups, factors: parsedFactors };
}

function normalizeSampleMatchKey(value: string): string {
  const trimmed = stripQuotes(value).trim();
  if (!trimmed) {
    return '';
  }
  const withoutCommonSuffix = trimmed
    .replace(/\.(?:fastq|fq|bam|sam|txt|tsv|csv)(?:\.gz)?$/i, '')
    .replace(/\.(?:counts|count)$/i, '');
  return withoutCommonSuffix.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function buildCandidateIndex(
  values: string[],
  keyOf: (value: string) => string,
): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const value of values) {
    const key = keyOf(value);
    if (!key) {
      continue;
    }
    const current = index.get(key);
    if (current) {
      current.push(value);
      continue;
    }
    index.set(key, [value]);
  }
  return index;
}

function pickUniqueUnusedCandidate(candidates: string[] | undefined, usedRawSampleIds: Set<string>): string | undefined {
  if (!candidates?.length) {
    return undefined;
  }
  let resolved: string | undefined;
  for (const candidate of candidates) {
    if (usedRawSampleIds.has(candidate)) {
      continue;
    }
    if (resolved && resolved !== candidate) {
      return undefined;
    }
    resolved = candidate;
  }
  return resolved;
}

function alignSeriesSamplesToRawSamples(
  seriesMetadata: ParsedSeriesMetadata,
  rawSampleIds: string[],
): SeriesSampleAlignment {
  const exactKey = (value: string) => normalizeCategory(value).toUpperCase();
  const exactIndex = buildCandidateIndex(rawSampleIds, exactKey);
  const normalizedIndex = buildCandidateIndex(rawSampleIds, normalizeSampleMatchKey);
  const usedRawSampleIds = new Set<string>();
  const seriesToRawSampleId = new Map<string, string>();

  // Resolve one priority level globally before considering weaker evidence.
  // Conflicting proposals remain unresolved instead of depending on metadata order.
  const assignUniqueMatches = (index: Map<string, string[]>, keyOf: (sampleId: string) => string) => {
    const proposals = new Map<string, string[]>();
    for (const sampleId of seriesMetadata.sampleIds) {
      if (seriesToRawSampleId.has(sampleId)) continue;
      const candidate = pickUniqueUnusedCandidate(index.get(keyOf(sampleId)), usedRawSampleIds);
      if (candidate) proposals.set(candidate, [...(proposals.get(candidate) ?? []), sampleId]);
    }
    for (const [rawSampleId, owners] of proposals) {
      if (owners.length !== 1) continue;
      seriesToRawSampleId.set(owners[0], rawSampleId);
      usedRawSampleIds.add(rawSampleId);
    }
  };

  assignUniqueMatches(exactIndex, exactKey);
  assignUniqueMatches(normalizedIndex, normalizeSampleMatchKey);
  assignUniqueMatches(exactIndex, (sampleId) => exactKey(seriesMetadata.sampleTitles[sampleId] ?? ''));
  assignUniqueMatches(normalizedIndex, (sampleId) => normalizeSampleMatchKey(seriesMetadata.sampleTitles[sampleId] ?? ''));
  return {
    seriesToRawSampleId,
    unresolvedSeriesSampleIds: seriesMetadata.sampleIds.filter((sampleId) => !seriesToRawSampleId.has(sampleId)),
  };
}

function buildSeriesDesignPreview(seriesMetadata: ParsedSeriesMetadata): GeoSeriesDesignPreview {
  const defaultGroupBySample: Record<string, GeoGroupAssignment> = {};
  for (const sampleId of seriesMetadata.sampleIds) {
    defaultGroupBySample[sampleId] = seriesMetadata.inferredGroups.groupBySample[sampleId] ?? '';
  }

  const defaultGroupFactorId = seriesMetadata.inferredGroups.factorName;
  const defaultBatchFactorId = chooseBatchFactor(
    seriesMetadata.sampleIds,
    seriesMetadata.factors,
    defaultGroupFactorId,
  );

  return {
    sampleIds: seriesMetadata.sampleIds,
    sampleTitles: seriesMetadata.sampleTitles,
    factors: seriesMetadata.factors.map((factor) => ({
      id: factor.id,
      label: factor.label,
      uniqueValues: factor.uniqueValues,
      orderedBinaryValues: factor.orderedBinaryValues,
      valuesBySample: mapFactorValuesBySample(seriesMetadata.sampleIds, factor.values),
    })),
    defaultGroupFactorId,
    defaultBatchFactorId,
    defaultConditionA: seriesMetadata.inferredGroups.conditionA,
    defaultConditionB: seriesMetadata.inferredGroups.conditionB,
    defaultGroupBySample,
  };
}

export function previewGeoSeriesDesignFromText(seriesMatrixText: string): GeoSeriesDesignPreview {
  const metadata = parseSeriesMatrix(seriesMatrixText);
  return buildSeriesDesignPreview(metadata);
}

export async function previewGeoSeriesDesignFromFile(seriesMatrixFile: File): Promise<GeoSeriesDesignPreview> {
  const seriesMatrixText = await readTextMaybeGzipFromFile(seriesMatrixFile);
  return previewGeoSeriesDesignFromText(seriesMatrixText);
}

async function resolveSeriesMatrixTextFromNcbi(dataset: GeoSearchResult): Promise<string> {
  const candidateUrls: string[] = [];
  if (dataset.seriesMatrixUrl) {
    candidateUrls.push(normalizeGeoHref(dataset.seriesMatrixUrl));
  }

  let firstError: Error | null = null;
  for (const url of candidateUrls) {
    try {
      return await fetchTextMaybeGzip(url, `Series matrix metadata (${dataset.accession})`);
    } catch (error) {
      if (!firstError && error instanceof Error) {
        firstError = error;
      }
    }
  }

  const downloadHtml = await fetchTextMaybeGzip(
    `${dataset.downloadUrl}&format=text`,
    `download page (${dataset.accession})`,
  );
  const parsedLinks = parseGeoDownloadLinksFromHtml(downloadHtml);
  const resolvedSeriesMatrixUrl = parsedLinks.seriesMatrixUrl ? normalizeGeoHref(parsedLinks.seriesMatrixUrl) : '';
  if (resolvedSeriesMatrixUrl && !candidateUrls.includes(resolvedSeriesMatrixUrl)) {
    return fetchTextMaybeGzip(resolvedSeriesMatrixUrl, `Series matrix metadata (${dataset.accession})`);
  }

  if (firstError) {
    throw firstError;
  }
  throw new Error(
    `Series matrix metadata is unavailable for ${dataset.accession}. Choose a dataset with an exposed series matrix file or use private file upload.`,
  );
}

export async function previewGeoSeriesDesignFromNcbi(dataset: GeoSearchResult): Promise<GeoSeriesDesignPreview> {
  const seriesMatrixText = await resolveSeriesMatrixTextFromNcbi(dataset);
  return previewGeoSeriesDesignFromText(seriesMatrixText);
}

/** Compatibility boundary: inference is performed exclusively by the local R engine. */
export async function analyzeGeoDatasetFromText(_options: AnalyzeGeoFromTextOptions): Promise<WorkbookParseResult> {
  throw new Error('Browser inference has been removed. Prepare an input bundle and run local R analysis with npm run analyze:local.');
}

export async function analyzeGeoDatasetFromFiles(_options: AnalyzeGeoFromFilesOptions): Promise<WorkbookParseResult> {
  throw new Error('Browser inference has been removed. Prepare an input bundle and run local R analysis with npm run analyze:local.');
}

export async function analyzeGeoDatasetFromNcbi(_dataset: GeoSearchResult, _design?: GeoAnalysisDesign): Promise<WorkbookParseResult> {
  throw new Error('Browser inference has been removed. Prepare an input bundle and run local R analysis with npm run analyze:local.');
}

export function alignGeoInputSamples(seriesMatrixText: string, rawSampleIds: string[]): SeriesSampleAlignment {
  return alignSeriesSamplesToRawSamples(parseSeriesMatrix(seriesMatrixText), rawSampleIds);
}

export async function loadGeoInputFromFiles(options: AnalyzeGeoFromFilesOptions): Promise<AnalyzeGeoFromTextOptions> {
  const [rawCountsText, seriesMatrixText] = await Promise.all([
    readTextMaybeGzipFromFile(options.rawCountsFile),
    readTextMaybeGzipFromFile(options.seriesMatrixFile),
  ]);
  return { accession: options.accession, title: options.title, organism: options.organism,
    design: options.design, rawCountsText, seriesMatrixText };
}

export async function loadGeoInputFromNcbi(dataset: GeoSearchResult, design?: GeoAnalysisDesign): Promise<AnalyzeGeoFromTextOptions> {
  if (!dataset.rawCountsUrl) {
    throw new Error(`No NCBI-generated raw count link was detected for ${dataset.accession}.`);
  }
  const [rawCountsText, seriesMatrixText] = await Promise.all([
    fetchTextMaybeGzip(dataset.rawCountsUrl, `NCBI raw counts (${dataset.accession})`),
    resolveSeriesMatrixTextFromNcbi(dataset),
  ]);
  return { accession: dataset.accession, title: dataset.title, organism: dataset.organism,
    design, rawCountsText, seriesMatrixText };
}
