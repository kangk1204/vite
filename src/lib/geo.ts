import * as XLSX from 'xlsx';
import pathwayIndex from '../reference/generated/pathways.json';
import ncbiGeneMap from '../reference/generated/ncbi_gene_map.json';
import { lookupCanonicalSymbol } from '../reference';
import type {
  ReferencePathway,
  ReferencePathwayIndex,
  ValidationIssue,
  ViewerSampleMeta,
  WorkbookParseResult,
} from '../types';
import { parseWorkbookBuffer } from './workbook';
import { normalizeSymbolToken } from './utils';

const EUTILS_BASE = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const GEO_BASE = 'https://www.ncbi.nlm.nih.gov';
const SAMPLE_COLUMN_PREFIX = 'sample_';
const MIN_PATHWAY_OVERLAP = 3;
const MAX_PATHWAY_ROWS = 220;
const SMALL = 1e-12;
const MAX_GEO_SAMPLES = 1500;
const MAX_GEO_MATRIX_CELLS = 45_000_000;
const geneIdToSymbol = ncbiGeneMap as Record<string, string>;
const referencePathways = Object.values((pathwayIndex as ReferencePathwayIndex).byId);

interface ESearchResponse {
  esearchresult?: {
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

interface GeneStat {
  symbol: string;
  log2fc: number;
  rankMetric: number;
  pvalue: number;
  padj: number;
  meanA: number;
  meanB: number;
  sampleValues: Record<string, number>;
}

interface PathwayScore {
  pathway: ReferencePathway;
  nes: number;
  pvalue: number;
  padj: number;
  leadingEdge: string[];
}

interface RawCountParseResult {
  sampleIds: string[];
  countsBySymbol: Map<string, Float64Array>;
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
  isEligible: boolean;
  eligibilityReason?: string;
}

export interface GeoSearchResponse {
  results: GeoSearchResult[];
  rawHitCount: number;
  eligibleCount: number;
  excludedCount: number;
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

function parseTabLine(line: string): string[] {
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

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while requesting ${url}`);
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

async function fetchTextMaybeGzip(url: string, label: string): Promise<string> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return maybeGunzip(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(
        `Failed to download ${label}. Browser CORS blocked access to ${url}. Download the files manually and use "Analyze from files".`,
      );
    }
    throw error;
  }
}

async function readTextMaybeGzipFromFile(file: File): Promise<string> {
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
): string | undefined {
  for (const candidate of candidates) {
    const classified = classifyRnaSeqFile(candidate.filename);
    if (classified === key) {
      return candidate.url;
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

    if (!/type=rnaseq_counts/i.test(href) || !/format=file/i.test(href) || !/[?&]file=/i.test(href)) {
      continue;
    }
    const filenameMatch = href.match(/[?&]file=([^&]+)/i);
    const filename = filenameMatch?.[1] ? safeDecodeURIComponent(filenameMatch[1]) : '';
    if (!filename) {
      continue;
    }
    rnaseqCandidates.push({ filename, url: href });
  }

  const rawCountsUrl = firstMatchByHeuristic(rnaseqCandidates, 'raw_counts');
  const tpmUrl = firstMatchByHeuristic(rnaseqCandidates, 'tpm');
  const fpkmUrl = firstMatchByHeuristic(rnaseqCandidates, 'fpkm');
  const annotationUrl = firstMatchByHeuristic(rnaseqCandidates, 'annot');
  const rawCountsFilename = rawCountsUrl
    ? safeDecodeURIComponent(rawCountsUrl.match(/[?&]file=([^&]+)/i)?.[1] ?? '')
    : undefined;

  return {
    hasNcbiGeneratedRawCounts: Boolean(rawCountsUrl),
    rawCountsUrl,
    rawCountsFilename,
    seriesMatrixUrl,
    tpmUrl,
    fpkmUrl,
    annotationUrl,
  };
}

function simplifySummary(summary: string): string {
  const compact = summary.replace(/\s+/g, ' ').trim();
  if (compact.length <= 240) {
    return compact;
  }
  return `${compact.slice(0, 237).trimEnd()}...`;
}

function formatSeriesMatrixUrl(ftplink: string | undefined, accession: string): string | undefined {
  const ftp = sanitizeText(ftplink);
  if (!ftp) {
    return undefined;
  }
  const normalized = normalizeGeoHref(`${ftp.replace(/\/+$/, '')}/matrix/${accession}_series_matrix.txt.gz`);
  return normalized || undefined;
}

async function enrichSearchResult(base: GeoSearchResult): Promise<GeoSearchResult> {
  try {
    const downloadHtml = await fetchTextMaybeGzip(`${base.downloadUrl}&format=text`, `download page (${base.accession})`);
    const links = parseGeoDownloadLinksFromHtml(downloadHtml);
    const enriched = {
      ...base,
      ...links,
      seriesMatrixUrl: links.seriesMatrixUrl ?? base.seriesMatrixUrl,
    };
    return finalizeGeoSearchResult(enriched);
  } catch {
    return finalizeGeoSearchResult(base);
  }
}

function getGeoEligibilityReason(result: GeoSearchResult): string | undefined {
  if (!/homo sapiens|human/i.test(result.organism)) {
    return 'Excluded: non-human study';
  }
  if (!result.hasNcbiGeneratedRawCounts) {
    return 'Excluded: NCBI-generated raw counts unavailable';
  }
  if (!result.seriesMatrixUrl) {
    return 'Excluded: series matrix metadata unavailable';
  }
  return undefined;
}

function finalizeGeoSearchResult(result: GeoSearchResult): GeoSearchResult {
  const eligibilityReason = getGeoEligibilityReason(result);
  return {
    ...result,
    isEligible: !eligibilityReason,
    eligibilityReason,
  };
}

export async function searchGeoDatasets(query: string, limit = 8): Promise<GeoSearchResponse> {
  const normalized = query.trim();
  if (!normalized) {
    return {
      results: [],
      rawHitCount: 0,
      eligibleCount: 0,
      excludedCount: 0,
    };
  }

  const term = /^GSE\d+$/i.test(normalized)
    ? `${normalized}[ACCN] AND gse[ETYP]`
    : `${normalized} AND gse[ETYP]`;

  const retmax = Math.max(limit * 8, 40);
  const esearchUrl = `${EUTILS_BASE}/esearch.fcgi?db=gds&retmode=json&retmax=${retmax}&term=${encodeURIComponent(term)}`;
  const searchPayload = await fetchJson<ESearchResponse>(esearchUrl);
  const ids = searchPayload.esearchresult?.idlist?.filter(Boolean) ?? [];
  if (!ids.length) {
    return {
      results: [],
      rawHitCount: 0,
      eligibleCount: 0,
      excludedCount: 0,
    };
  }

  const esummaryUrl = `${EUTILS_BASE}/esummary.fcgi?db=gds&retmode=json&id=${encodeURIComponent(ids.join(','))}`;
  const summaryPayload = await fetchJson<ESummaryResponse>(esummaryUrl);
  const uidList = summaryPayload.result?.uids ?? [];
  const baseResults: GeoSearchResult[] = [];

  for (const uid of uidList) {
    const entry = summaryPayload.result?.[uid];
    if (!entry || Array.isArray(entry)) {
      continue;
    }
    const accession = sanitizeText(entry.accession);
    if (!/^GSE\d+$/i.test(accession)) {
      continue;
    }

    const base: GeoSearchResult = {
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
      seriesMatrixUrl: formatSeriesMatrixUrl(entry.ftplink, accession),
      isEligible: false,
      eligibilityReason: undefined,
    };

    baseResults.push(base);
  }

  const inspectedResults: GeoSearchResult[] = [];
  let eligibleCount = 0;
  const batchSize = 6;

  for (let index = 0; index < baseResults.length; index += batchSize) {
    const batch = await Promise.all(baseResults.slice(index, index + batchSize).map((item) => enrichSearchResult(item)));
    inspectedResults.push(...batch);
    eligibleCount += batch.filter((item) => item.isEligible).length;
    if (eligibleCount >= limit) {
      break;
    }
  }

  inspectedResults.sort(
    (left, right) =>
      Number(right.isEligible) - Number(left.isEligible) ||
      Number(right.hasNcbiGeneratedRawCounts) - Number(left.hasNcbiGeneratedRawCounts) ||
      right.sampleCount - left.sampleCount,
  );

  return {
    results: inspectedResults,
    rawHitCount: baseResults.length,
    eligibleCount: inspectedResults.filter((item) => item.isEligible).length,
    excludedCount: inspectedResults.filter((item) => !item.isEligible).length,
  };
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
    let score = minCount * 10;
    if (/(genotype|variation|disease|condition|status|group|phenotype)/i.test(factorName)) {
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
    const fields = parseTabLine(rawLine);
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

  const inferredGroups = chooseBinaryFactor(sampleIds, factors);
  if (!inferredGroups) {
    throw new Error(
      'Could not infer a binary comparison from series metadata. Please provide series matrix with clear 2-group sample annotations.',
    );
  }

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

function resolveGeneSymbol(identifier: string): string | null {
  const token = stripQuotes(identifier);
  if (!token) {
    return null;
  }
  const normalized = normalizeSymbolToken(token);
  const noVersion = normalized.replace(/\.\d+$/g, '');
  const mapped = geneIdToSymbol[noVersion] ?? geneIdToSymbol[normalized];
  const canonical = mapped ? lookupCanonicalSymbol(mapped) : lookupCanonicalSymbol(noVersion);
  return canonical ?? mapped ?? null;
}

function parseRawCountsMatrix(rawCountsText: string): RawCountParseResult {
  const lines = rawCountsText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    throw new Error('Raw counts file is empty or malformed.');
  }

  const header = parseTabLine(lines[0]).map(stripQuotes);
  if (header.length < 3) {
    throw new Error('Raw counts header must include GeneID and at least two samples.');
  }

  const sampleIds = header.slice(1).map(normalizeCategory);
  if (sampleIds.length > MAX_GEO_SAMPLES) {
    throw new Error(
      `Dataset has ${sampleIds.length.toLocaleString()} samples. Browser-side analysis is capped around ${MAX_GEO_SAMPLES.toLocaleString()} samples. Please run DESeq2 on a high-memory workstation/server and import the result workbook.`,
    );
  }
  const estimatedCells = sampleIds.length * Math.max(lines.length - 1, 0);
  if (estimatedCells > MAX_GEO_MATRIX_CELLS) {
    throw new Error(
      `Raw count matrix is too large for browser memory (${estimatedCells.toLocaleString()} cells). Use a high-memory environment for DESeq2 (for example R on workstation/HPC) and then load the workbook output here.`,
    );
  }
  const countsBySymbol = new Map<string, Float64Array>();

  for (let rowIndex = 1; rowIndex < lines.length; rowIndex += 1) {
    const fields = parseTabLine(lines[rowIndex]);
    if (fields.length < sampleIds.length + 1) {
      continue;
    }
    const symbol = resolveGeneSymbol(fields[0]);
    if (!symbol) {
      continue;
    }

    const counts = countsBySymbol.get(symbol) ?? new Float64Array(sampleIds.length);
    for (let sampleIndex = 0; sampleIndex < sampleIds.length; sampleIndex += 1) {
      const value = Number(fields[sampleIndex + 1]);
      if (Number.isFinite(value)) {
        counts[sampleIndex] += Math.max(0, value);
      }
    }
    countsBySymbol.set(symbol, counts);
  }

  if (!countsBySymbol.size) {
    throw new Error('No mappable genes were found in raw counts.');
  }

  return { sampleIds, countsBySymbol };
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

function trimDesignLabel(value: string | undefined, fallback: string): string {
  const cleaned = sanitizeText(value);
  return cleaned || fallback;
}

function applyGroupDesign(
  seriesMetadata: ParsedSeriesMetadata,
  design: GeoAnalysisDesign | undefined,
): ParsedGroupInfo {
  const conditionA = trimDesignLabel(design?.conditionA, seriesMetadata.inferredGroups.conditionA);
  const conditionB = trimDesignLabel(design?.conditionB, seriesMetadata.inferredGroups.conditionB);
  if (conditionA === conditionB) {
    throw new Error('Condition A and condition B must be different labels.');
  }

  const groupBySample: Record<string, 'A' | 'B'> = {};
  let groupACount = 0;
  let groupBCount = 0;
  for (const sampleId of seriesMetadata.sampleIds) {
    const requestedGroup = design?.groupBySample?.[sampleId];
    const inferredGroup = seriesMetadata.inferredGroups.groupBySample[sampleId];
    const group = requestedGroup === 'A' || requestedGroup === 'B' ? requestedGroup : inferredGroup;
    if (group === 'A') {
      groupACount += 1;
      groupBySample[sampleId] = 'A';
    } else if (group === 'B') {
      groupBCount += 1;
      groupBySample[sampleId] = 'B';
    }
  }

  if (groupACount < 2 || groupBCount < 2) {
    throw new Error(
      `Assigned groups are too small after setup (A=${groupACount}, B=${groupBCount}). Set at least 2 samples per group.`,
    );
  }

  return {
    factorName: trimDesignLabel(design?.groupFactorName, seriesMetadata.inferredGroups.factorName),
    conditionA,
    conditionB,
    groupBySample,
  };
}

function applyBatchDesign(
  sampleIds: string[],
  groupInfo: ParsedGroupInfo,
  design: GeoAnalysisDesign | undefined,
): { batchBySample: Record<string, string>; batchFactorName?: string } | null {
  if (!design?.batchBySample) {
    return null;
  }

  const batchBySample: Record<string, string> = {};
  for (const sampleId of sampleIds) {
    const group = groupInfo.groupBySample[sampleId];
    if (!group) {
      continue;
    }
    const rawValue = design.batchBySample[sampleId];
    const value = sanitizeText(rawValue) || 'Batch_1';
    batchBySample[sampleId] = value;
  }

  const uniqueBatches = Array.from(new Set(Object.values(batchBySample)));
  if (uniqueBatches.length < 2) {
    return null;
  }

  return {
    batchBySample,
    batchFactorName: sanitizeText(design.batchFactorName) || undefined,
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

export async function previewGeoSeriesDesignFromNcbi(dataset: GeoSearchResult): Promise<GeoSeriesDesignPreview> {
  const seriesMatrixUrl =
    dataset.seriesMatrixUrl ??
    normalizeGeoHref(
      `https://ftp.ncbi.nlm.nih.gov/geo/series/${dataset.accession.slice(0, -3)}nnn/${dataset.accession}/matrix/${dataset.accession}_series_matrix.txt.gz`,
    );
  const seriesMatrixText = await fetchTextMaybeGzip(
    seriesMatrixUrl,
    `Series matrix metadata (${dataset.accession})`,
  );
  return previewGeoSeriesDesignFromText(seriesMatrixText);
}

function mean(values: number[]): number {
  if (!values.length) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

function variance(values: number[], valuesMean: number): number {
  if (values.length <= 1) {
    return 0;
  }
  const sumSquares = values.reduce((acc, value) => acc + (value - valuesMean) ** 2, 0);
  return sumSquares / (values.length - 1);
}

function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const t = 1 / (1 + p * absX);
  const y = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX));
  return sign * y;
}

function normalCdf(value: number): number {
  return 0.5 * (1 + erf(value / Math.SQRT2));
}

function benjaminiHochberg(values: number[]): number[] {
  const indexed = values.map((value, index) => ({ value: Number.isFinite(value) ? value : 1, index }));
  indexed.sort((left, right) => left.value - right.value);

  const adjusted = new Array(values.length).fill(1);
  let prev = 1;
  for (let rank = indexed.length; rank >= 1; rank -= 1) {
    const entry = indexed[rank - 1];
    const candidate = Math.min(prev, (entry.value * indexed.length) / rank);
    prev = candidate;
    adjusted[entry.index] = Math.max(0, Math.min(1, candidate));
  }
  return adjusted;
}

function toSafeContrastToken(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || 'Condition';
}

interface BuildGeneStatsResult {
  stats: GeneStat[];
  batchApplied: boolean;
  batchLevelCount: number;
  batchSkippedReason?: string;
}

function invertMatrix(matrix: number[][]): number[][] | null {
  const n = matrix.length;
  if (!n || matrix.some((row) => row.length !== n)) {
    return null;
  }

  const augmented: number[][] = matrix.map((row, rowIndex) => [
    ...row.map((value) => (Number.isFinite(value) ? value : 0)),
    ...new Array(n).fill(0).map((_, colIndex) => (rowIndex === colIndex ? 1 : 0)),
  ]);

  for (let pivot = 0; pivot < n; pivot += 1) {
    let maxRow = pivot;
    let maxValue = Math.abs(augmented[pivot][pivot]);
    for (let row = pivot + 1; row < n; row += 1) {
      const candidate = Math.abs(augmented[row][pivot]);
      if (candidate > maxValue) {
        maxValue = candidate;
        maxRow = row;
      }
    }

    if (maxValue <= SMALL) {
      return null;
    }

    if (maxRow !== pivot) {
      const tmp = augmented[pivot];
      augmented[pivot] = augmented[maxRow];
      augmented[maxRow] = tmp;
    }

    const pivotValue = augmented[pivot][pivot];
    for (let col = 0; col < n * 2; col += 1) {
      augmented[pivot][col] /= pivotValue;
    }

    for (let row = 0; row < n; row += 1) {
      if (row === pivot) {
        continue;
      }
      const factor = augmented[row][pivot];
      if (Math.abs(factor) <= SMALL) {
        continue;
      }
      for (let col = 0; col < n * 2; col += 1) {
        augmented[row][col] -= factor * augmented[pivot][col];
      }
    }
  }

  return augmented.map((row) => row.slice(n));
}

function multiplyMatrixVector(matrix: number[][], vector: number[]): number[] {
  return matrix.map((row) => row.reduce((acc, value, index) => acc + value * (vector[index] ?? 0), 0));
}

function computeLinearModelStat(
  expression: number[],
  groups: Array<'A' | 'B'>,
  batches: string[],
): { effect: number; tStat: number; pvalue: number; appliedBatch: boolean; skippedReason?: string } {
  const batchLevels = Array.from(new Set(batches));
  if (batchLevels.length < 2) {
    return {
      effect: 0,
      tStat: 0,
      pvalue: 1,
      appliedBatch: false,
      skippedReason: 'Batch had <2 levels.',
    };
  }

  const batchReference = batchLevels[0];
  const p = 2 + (batchLevels.length - 1);
  if (expression.length <= p) {
    return {
      effect: 0,
      tStat: 0,
      pvalue: 1,
      appliedBatch: false,
      skippedReason: `Not enough samples for batch-adjusted model (n=${expression.length}, p=${p}).`,
    };
  }

  const x: number[][] = expression.map((_, sampleIndex) => {
    const row = [1, groups[sampleIndex] === 'B' ? 1 : 0];
    for (let batchIndex = 1; batchIndex < batchLevels.length; batchIndex += 1) {
      row.push(batches[sampleIndex] === batchLevels[batchIndex] ? 1 : 0);
    }
    return row;
  });

  const xtx: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const xty: number[] = new Array(p).fill(0);
  for (let row = 0; row < expression.length; row += 1) {
    for (let i = 0; i < p; i += 1) {
      xty[i] += x[row][i] * expression[row];
      for (let j = 0; j < p; j += 1) {
        xtx[i][j] += x[row][i] * x[row][j];
      }
    }
  }

  const invXtx = invertMatrix(xtx);
  if (!invXtx) {
    return {
      effect: 0,
      tStat: 0,
      pvalue: 1,
      appliedBatch: false,
      skippedReason: 'Batch and group covariates were collinear.',
    };
  }

  const beta = multiplyMatrixVector(invXtx, xty);
  const fitted = x.map((row) => row.reduce((acc, value, index) => acc + value * (beta[index] ?? 0), 0));
  let rss = 0;
  for (let row = 0; row < expression.length; row += 1) {
    rss += (expression[row] - fitted[row]) ** 2;
  }
  const df = expression.length - p;
  if (df <= 0) {
    return {
      effect: 0,
      tStat: 0,
      pvalue: 1,
      appliedBatch: false,
      skippedReason: 'No residual degrees of freedom after batch adjustment.',
    };
  }

  const sigma2 = rss / df;
  const groupVariance = invXtx[1]?.[1] ?? 0;
  const standardError = Math.sqrt(Math.max(sigma2 * groupVariance, 0));
  if (!Number.isFinite(standardError) || standardError <= SMALL) {
    return {
      effect: beta[1] ?? 0,
      tStat: 0,
      pvalue: 1,
      appliedBatch: false,
      skippedReason: 'Group effect standard error collapsed after batch adjustment.',
    };
  }

  const tStat = (beta[1] ?? 0) / standardError;
  const pvalue = Math.max(SMALL, Math.min(1, 2 * (1 - normalCdf(Math.abs(tStat)))));
  return {
    effect: beta[1] ?? 0,
    tStat,
    pvalue,
    appliedBatch: true,
  };
}

function buildGeneStats(
  parsedCounts: RawCountParseResult,
  groupInfo: ParsedGroupInfo,
  batchBySample?: Record<string, string>,
): BuildGeneStatsResult {
  const sampleIndexById = new Map(parsedCounts.sampleIds.map((id, index) => [id, index]));
  const groupAIndices: number[] = [];
  const groupBIndices: number[] = [];
  const includedSampleIds: string[] = [];
  const includedSampleIndices: number[] = [];
  const includedGroups: Array<'A' | 'B'> = [];
  const includedBatches: string[] = [];

  for (const sampleId of parsedCounts.sampleIds) {
    const group = groupInfo.groupBySample[sampleId];
    const sampleIndex = sampleIndexById.get(sampleId);
    if (!group || sampleIndex === undefined) {
      continue;
    }
    includedSampleIds.push(sampleId);
    includedSampleIndices.push(sampleIndex);
    includedGroups.push(group);
    includedBatches.push(sanitizeText(batchBySample?.[sampleId]) || 'Batch_1');
    if (group === 'A') {
      groupAIndices.push(sampleIndex);
    } else {
      groupBIndices.push(sampleIndex);
    }
  }

  if (groupAIndices.length < 2 || groupBIndices.length < 2) {
    throw new Error(
      `Detected groups are too small (A=${groupAIndices.length}, B=${groupBIndices.length}). Need at least 2 samples per group.`,
    );
  }

  const librarySizes = new Float64Array(parsedCounts.sampleIds.length);
  for (const counts of parsedCounts.countsBySymbol.values()) {
    for (let sampleIndex = 0; sampleIndex < counts.length; sampleIndex += 1) {
      librarySizes[sampleIndex] += counts[sampleIndex];
    }
  }
  for (let sampleIndex = 0; sampleIndex < librarySizes.length; sampleIndex += 1) {
    if (librarySizes[sampleIndex] <= 0) {
      librarySizes[sampleIndex] = 1;
    }
  }

  const stats: GeneStat[] = [];
  const pvalues: number[] = [];
  const batchLevels = Array.from(new Set(includedBatches));
  const batchRequested = Boolean(batchBySample && Object.keys(batchBySample).length);
  const canAttemptBatch = batchRequested && batchLevels.length >= 2;
  let batchAppliedCount = 0;
  let batchSkippedReason: string | undefined;

  for (const [symbol, counts] of parsedCounts.countsBySymbol.entries()) {
    const maxCount = Math.max(...Array.from(counts));
    if (!Number.isFinite(maxCount) || maxCount < 8) {
      continue;
    }

    const expression = parsedCounts.sampleIds.map((_, sampleIndex) =>
      Math.log2((counts[sampleIndex] / librarySizes[sampleIndex]) * 1_000_000 + 1),
    );
    const groupAValues = groupAIndices.map((sampleIndex) => expression[sampleIndex]);
    const groupBValues = groupBIndices.map((sampleIndex) => expression[sampleIndex]);

    const meanA = mean(groupAValues);
    const meanB = mean(groupBValues);
    const varA = variance(groupAValues, meanA);
    const varB = variance(groupBValues, meanB);
    const denominator = Math.sqrt(varA / groupAValues.length + varB / groupBValues.length);
    let effect = meanB - meanA;
    let tStat = denominator > SMALL ? effect / denominator : 0;
    let pvalue = Math.max(SMALL, Math.min(1, 2 * (1 - normalCdf(Math.abs(tStat)))));
    if (canAttemptBatch) {
      const includedExpression = includedSampleIndices.map((sampleIndex) => expression[sampleIndex]);
      const batchModel = computeLinearModelStat(includedExpression, includedGroups, includedBatches);
      if (batchModel.appliedBatch) {
        effect = batchModel.effect;
        tStat = batchModel.tStat;
        pvalue = batchModel.pvalue;
        batchAppliedCount += 1;
      } else if (!batchSkippedReason && batchModel.skippedReason) {
        batchSkippedReason = batchModel.skippedReason;
      }
    } else if (batchRequested && !batchSkippedReason) {
      batchSkippedReason = 'Batch covariate had only one level after group assignment.';
    }

    const sampleValues: Record<string, number> = {};
    for (let localIndex = 0; localIndex < includedSampleIndices.length; localIndex += 1) {
      const sampleIndex = includedSampleIndices[localIndex];
      const sampleId = includedSampleIds[localIndex];
      sampleValues[`${SAMPLE_COLUMN_PREFIX}${sampleId}`] = Number(
        expression[sampleIndex].toFixed(4),
      );
    }

    stats.push({
      symbol,
      log2fc: Number(effect.toFixed(6)),
      rankMetric: Number(tStat.toFixed(6)),
      pvalue,
      padj: 1,
      meanA: Number(meanA.toFixed(6)),
      meanB: Number(meanB.toFixed(6)),
      sampleValues,
    });
    pvalues.push(pvalue);
  }

  const padj = benjaminiHochberg(pvalues);
  for (let index = 0; index < stats.length; index += 1) {
    stats[index].padj = padj[index];
  }

  return {
    stats: stats.sort((left, right) => right.rankMetric - left.rankMetric || left.symbol.localeCompare(right.symbol)),
    batchApplied: canAttemptBatch && batchAppliedCount > 0,
    batchLevelCount: canAttemptBatch ? batchLevels.length : 0,
    batchSkippedReason: canAttemptBatch && batchAppliedCount === 0 ? batchSkippedReason : undefined,
  };
}

function scorePathways(geneStats: GeneStat[]): PathwayScore[] {
  const rankByGene = new Map(geneStats.map((gene) => [gene.symbol, gene.rankMetric]));
  const rankValues = geneStats.map((gene) => gene.rankMetric);
  const rankMean = mean(rankValues);
  const rankVariance = variance(rankValues, rankMean);
  const rankSd = Math.sqrt(rankVariance || 1);

  const pathways: PathwayScore[] = [];
  const pathwayPvalues: number[] = [];

  for (const pathway of referencePathways) {
    const overlap: Array<{ gene: string; metric: number }> = [];
    for (const gene of pathway.genes) {
      const metric = rankByGene.get(gene);
      if (metric !== undefined && Number.isFinite(metric)) {
        overlap.push({ gene, metric });
      }
    }

    if (overlap.length < MIN_PATHWAY_OVERLAP) {
      continue;
    }

    const overlapMean = mean(overlap.map((entry) => entry.metric));
    const nes = (Math.sqrt(overlap.length) * overlapMean) / Math.max(rankSd, SMALL);
    const pvalue = Math.max(SMALL, Math.min(1, 2 * (1 - normalCdf(Math.abs(nes)))));
    const sortedOverlap = overlap.sort((left, right) =>
      nes >= 0 ? right.metric - left.metric : left.metric - right.metric,
    );
    const leadingEdge = sortedOverlap.slice(0, Math.min(25, sortedOverlap.length)).map((entry) => entry.gene);

    pathways.push({ pathway, nes, pvalue, padj: 1, leadingEdge });
    pathwayPvalues.push(pvalue);
  }

  const pathwayPadj = benjaminiHochberg(pathwayPvalues);
  for (let index = 0; index < pathways.length; index += 1) {
    pathways[index].padj = pathwayPadj[index];
  }

  const sorted = pathways.sort((left, right) => left.padj - right.padj || Math.abs(right.nes) - Math.abs(left.nes));
  if (sorted.length) {
    return sorted.slice(0, MAX_PATHWAY_ROWS);
  }

  const topUp = geneStats.slice(0, 40).map((gene) => gene.symbol);
  const topDown = [...geneStats].reverse().slice(0, 40).map((gene) => gene.symbol);
  const fallback: PathwayScore[] = [];
  if (topUp.length >= 6) {
    fallback.push({
      pathway: {
        id: 'AutoDerived::UP',
        name: 'AutoDerived Upregulated Signature',
        collection: 'AutoDerived',
        genes: topUp,
      },
      nes: 2.5,
      pvalue: 0.0001,
      padj: 0.0002,
      leadingEdge: topUp.slice(0, 25),
    });
  }
  if (topDown.length >= 6) {
    fallback.push({
      pathway: {
        id: 'AutoDerived::DOWN',
        name: 'AutoDerived Downregulated Signature',
        collection: 'AutoDerived',
        genes: topDown,
      },
      nes: -2.5,
      pvalue: 0.0001,
      padj: 0.0002,
      leadingEdge: topDown.slice(0, 25),
    });
  }
  return fallback;
}

function buildWorkbookBufferFromGeo(
  accession: string,
  title: string,
  organism: string,
  groupInfo: ParsedGroupInfo,
  geneStats: GeneStat[],
  pathwayScores: PathwayScore[],
): ArrayBuffer {
  const projectTitle = `${accession} ${title}`.trim();
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        project_title: projectTitle,
        contrast_name: `${toSafeContrastToken(groupInfo.conditionB)}_vs_${toSafeContrastToken(groupInfo.conditionA)}`,
        condition_a: groupInfo.conditionA,
        condition_b: groupInfo.conditionB,
        species: /human/i.test(organism) ? 'human' : organism || 'human',
      },
    ]),
    'Project',
  );

  const genesRows = geneStats.map((gene) => ({
    gene_symbol: gene.symbol,
    log2fc: gene.log2fc,
    padj: gene.padj,
    pvalue: gene.pvalue,
    rank_metric: gene.rankMetric,
    condition_a_mean: gene.meanA,
    condition_b_mean: gene.meanB,
    ...gene.sampleValues,
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(genesRows), 'Genes');

  const pathwaysRows = pathwayScores.map((pathwayScore) => ({
    pathway_id: pathwayScore.pathway.id.split('::').at(-1) ?? pathwayScore.pathway.id,
    pathway_name: pathwayScore.pathway.name,
    collection: pathwayScore.pathway.collection,
    nes: pathwayScore.nes,
    padj: pathwayScore.padj,
    leading_edge_genes: pathwayScore.leadingEdge.join(';'),
  }));
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(pathwaysRows), 'Pathways');

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

function appendGeoIssues(result: WorkbookParseResult, issues: ValidationIssue[]): WorkbookParseResult {
  const mergedIssues = [...issues, ...result.issues];
  const output: WorkbookParseResult = {
    ...result,
    issues: mergedIssues,
  };
  if (output.viewerData) {
    output.viewerData = {
      ...output.viewerData,
      issues: mergedIssues,
    };
  }
  return output;
}

function buildViewerSampleMetadata(
  seriesMetadata: ParsedSeriesMetadata,
  groupInfo: ParsedGroupInfo,
  batchDesign: { batchBySample: Record<string, string>; batchFactorName?: string } | null,
): Record<string, ViewerSampleMeta> {
  const samplesById: Record<string, ViewerSampleMeta> = {};

  seriesMetadata.sampleIds.forEach((sampleId) => {
    const sampleKey = `${SAMPLE_COLUMN_PREFIX}${sampleId}`;
    const groupKey = groupInfo.groupBySample[sampleId] ?? 'U';
    samplesById[sampleKey] = {
      id: sampleKey,
      label: seriesMetadata.sampleTitles[sampleId] || sampleId,
      groupKey,
      groupLabel:
        groupKey === 'A'
          ? groupInfo.conditionA
          : groupKey === 'B'
            ? groupInfo.conditionB
            : 'Unassigned',
      batch: batchDesign?.batchBySample[sampleId] || undefined,
    };
  });

  return samplesById;
}

function appendViewerSampleMetadata(
  result: WorkbookParseResult,
  samplesById: Record<string, ViewerSampleMeta>,
): WorkbookParseResult {
  if (!result.viewerData || !Object.keys(samplesById).length) {
    return result;
  }

  return {
    ...result,
    viewerData: {
      ...result.viewerData,
      samplesById: {
        ...(result.viewerData.samplesById ?? {}),
        ...samplesById,
      },
    },
  };
}

export function analyzeGeoDatasetFromText(options: AnalyzeGeoFromTextOptions): WorkbookParseResult {
  try {
    const accession = sanitizeText(options.accession) || 'GSE_AUTO';
    const title = sanitizeText(options.title) || 'GEO auto-analysis';
    const organism = sanitizeText(options.organism) || 'human';

    const seriesMetadata = parseSeriesMatrix(options.seriesMatrixText);
    const groupInfo = applyGroupDesign(seriesMetadata, options.design);
    const batchDesign = applyBatchDesign(seriesMetadata.sampleIds, groupInfo, options.design);
    const parsedCounts = parseRawCountsMatrix(options.rawCountsText);

    const missingSamples = seriesMetadata.sampleIds.filter((sampleId) => !parsedCounts.sampleIds.includes(sampleId));
    if (missingSamples.length) {
      throw new Error(
        `Raw counts matrix is missing ${missingSamples.length} sample(s) from series metadata (first: ${missingSamples[0]}).`,
      );
    }

    const geneStatsResult = buildGeneStats(parsedCounts, groupInfo, batchDesign?.batchBySample);
    const geneStats = geneStatsResult.stats;
    if (!geneStats.length) {
      throw new Error('No genes passed expression filters for differential analysis.');
    }

    const pathwayScores = scorePathways(geneStats);
    if (!pathwayScores.length) {
      throw new Error('No pathways were scored. Verify that the dataset is human RNA-seq with mappable gene IDs.');
    }

    const workbookBuffer = buildWorkbookBufferFromGeo(
      accession,
      title,
      organism,
      groupInfo,
      geneStats,
      pathwayScores,
    );
    const parsedWorkbook = appendViewerSampleMetadata(
      parseWorkbookBuffer(workbookBuffer),
      buildViewerSampleMetadata(seriesMetadata, groupInfo, batchDesign),
    );

    const infoIssues: ValidationIssue[] = [
      {
        level: 'info',
        message:
          'GEO auto-analysis uses browser-side approximations (logCPM + Welch/linear-model statistics + pathway z-score ranking).',
        context: 'GEO Auto',
      },
      {
        level: 'info',
        message: `Comparison from "${groupInfo.factorName}": ${groupInfo.conditionB} vs ${groupInfo.conditionA}.`,
        context: 'GEO Auto',
      },
    ];

    if (batchDesign) {
      if (geneStatsResult.batchApplied) {
        infoIssues.push({
          level: 'info',
          message: `Batch-aware linear model was applied (${geneStatsResult.batchLevelCount} batch levels${
            batchDesign.batchFactorName ? ` from "${batchDesign.batchFactorName}"` : ''
          }).`,
          context: 'GEO Auto',
        });
      } else if (geneStatsResult.batchSkippedReason) {
        infoIssues.push({
          level: 'warning',
          message: `Batch covariate was provided but not applied: ${geneStatsResult.batchSkippedReason}`,
          context: 'GEO Auto',
        });
      }
    }

    const estimatedCells = parsedCounts.sampleIds.length * geneStats.length;
    if (estimatedCells > 18_000_000) {
      infoIssues.push({
        level: 'warning',
        message:
          'Large dataset detected. For final publication DESeq2 models, prefer high-memory workstation/HPC execution and import curated workbook outputs.',
        context: 'GEO Auto',
      });
    }

    return appendGeoIssues(parsedWorkbook, infoIssues);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof RangeError || /memory|allocation|out of memory|invalid array length/i.test(message)) {
      throw new Error(
        'Analysis stopped due to browser memory limits. Use a high-memory workstation/server for DESeq2 processing, then import the workbook into this viewer.',
      );
    }
    throw error;
  }
}

export async function analyzeGeoDatasetFromFiles(options: AnalyzeGeoFromFilesOptions): Promise<WorkbookParseResult> {
  const rawCountsText = await readTextMaybeGzipFromFile(options.rawCountsFile);
  const seriesMatrixText = await readTextMaybeGzipFromFile(options.seriesMatrixFile);
  return analyzeGeoDatasetFromText({
    accession: options.accession,
    title: options.title,
    organism: options.organism,
    rawCountsText,
    seriesMatrixText,
    design: options.design,
  });
}

export async function analyzeGeoDatasetFromNcbi(
  dataset: GeoSearchResult,
  design?: GeoAnalysisDesign,
): Promise<WorkbookParseResult> {
  if (!dataset.rawCountsUrl) {
    throw new Error(`No NCBI-generated raw count link was detected for ${dataset.accession}.`);
  }

  const rawCountsText = await fetchTextMaybeGzip(
    dataset.rawCountsUrl,
    `NCBI raw counts (${dataset.accession})`,
  );
  const seriesMatrixUrl =
    dataset.seriesMatrixUrl ??
    normalizeGeoHref(
      `https://ftp.ncbi.nlm.nih.gov/geo/series/${dataset.accession.slice(0, -3)}nnn/${dataset.accession}/matrix/${dataset.accession}_series_matrix.txt.gz`,
    );
  const seriesMatrixText = await fetchTextMaybeGzip(
    seriesMatrixUrl,
    `Series matrix metadata (${dataset.accession})`,
  );

  return analyzeGeoDatasetFromText({
    accession: dataset.accession,
    title: dataset.title,
    organism: dataset.organism,
    rawCountsText,
    seriesMatrixText,
    design,
  });
}
