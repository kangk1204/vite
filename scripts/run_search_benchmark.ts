#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

import { buildGeoResultIndexOrders, orderFilteredGeoIndices } from '../src/lib/geoResultOrdering.ts';
import { createGeoResultSearchEngine } from '../src/lib/geoResultSearch.ts';
import { createSampleSearchEngine } from '../src/lib/sampleSearch.ts';

type ResultStatus = 'eligible' | 'checking' | 'excluded';

interface CliOptions {
  output: string;
  repeats: number;
  warmup: number;
  geoSizes: number[];
  sampleSizes: number[];
  seed: number;
}

interface TimingRecord {
  query: string;
  scenario: string;
  repeats: number;
  minMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
  meanMs: number;
  throughputQps: number;
}

interface BenchSuiteSection {
  repeats: number;
  warmup: number;
  scenarios: TimingRecord[];
  constructionMs: number;
  memoryBeforeMb: number;
  memoryAfterMb: number;
}

interface GeoBenchmarkResult extends BenchSuiteSection {
  size: number;
  indexModes: string[];
}

interface SampleBenchmarkResult extends BenchSuiteSection {
  size: number;
}

interface ScriptResult {
  generatedAt: string;
  node: string;
  platform: string;
  seed: number;
  geo: GeoBenchmarkResult[];
  sample: SampleBenchmarkResult[];
}

interface GeoSearchResult {
  accession: string;
  title: string;
  summary: string;
  organism: string;
  sampleCount: number;
  pubmedId: string;
  geoUrl: string;
  downloadUrl: string;
  hasNcbiGeneratedRawCounts: boolean;
  eligibilityStatus: ResultStatus;
  isEligible: boolean;
  eligibilityReason?: string;
  rawCountsUrl?: string;
  rawCountsFilename?: string;
  seriesMatrixUrl?: string;
  tpmUrl?: string;
  fpkmUrl?: string;
  annotationUrl?: string;
}

interface GeoSeriesPreview {
  sampleIds: string[];
  sampleTitles: Record<string, string>;
  factors: Array<{
    id: string;
    label: string;
    uniqueValues: string[];
    valuesBySample: Record<string, string>;
    orderedBinaryValues?: string[];
  }>;
  defaultGroupFactorId: string;
  defaultConditionA: string;
  defaultConditionB: string;
  defaultGroupBySample: Record<string, 'A' | 'B' | '' | undefined>;
}

const DEFAULT_OUTPUT = path.join('paper', 'outputs', 'benchmarks', 'search_engine_performance.json');
const DEFAULT_GEO_SIZES = [600, 2_400, 9_600];
const DEFAULT_SAMPLE_SIZES = [1_200, 4_800];
const DEFAULT_REPEATS = 120;
const DEFAULT_WARMUP = 20;
const DEFAULT_SEED = 0x5e0dd;
const SAMPLE_TEXT_TOKENS = [
  'bulk', 'rna', 'seq', 'skin', 'lesional', 'control',
  'healthy', 'paired', 'cohort', 'human', 'mouse',
  'expression', 'counts', 'meta', 'immune', 'signal',
];
const SAMPLE_ORGANISMS = ['Homo sapiens', 'Mus musculus', 'Rattus norvegicus'];
const GEO_STATUSES: ResultStatus[] = ['eligible', 'checking', 'excluded'];
const GRADE_TITLES = ['lesional', 'healthy', 'cohort', 'paired', 'time-series', 'replicate'];
const GRADE_SUMMARY_TOKENS = [
  'transcriptome', 'profiling', 'dataset', 'comparative', 'regulation',
  'immune', 'interferon', 'cell-cycle', 'splicing', 'stress',
];
const SORT_MODES: Array<'ranked' | 'samples' | 'accession'> = ['ranked', 'samples', 'accession'];

function parseCliArgs(argv: string[]): CliOptions {
  const outputFlag = parseStringFlag(argv, '--output');
  const repeats = parsePositiveInt(parseStringFlag(argv, '--repeats'), DEFAULT_REPEATS, 5000);
  const warmup = parsePositiveInt(parseStringFlag(argv, '--warmup'), DEFAULT_WARMUP, 2_000);
  const seed = parsePositiveInt(parseStringFlag(argv, '--seed'), DEFAULT_SEED, Number.MAX_SAFE_INTEGER);
  const geoSizes = parseSizeFlag(parseStringFlag(argv, '--geo-sizes')) ?? DEFAULT_GEO_SIZES;
  const sampleSizes = parseSizeFlag(parseStringFlag(argv, '--sample-sizes')) ?? DEFAULT_SAMPLE_SIZES;
  const output = outputFlag && outputFlag.trim().length > 0 ? outputFlag : DEFAULT_OUTPUT;

  return {
    output,
    repeats,
    warmup,
    geoSizes,
    sampleSizes,
    seed: Number.isFinite(seed) ? seed : DEFAULT_SEED,
  };
}

function parsePositiveInt(raw: string | null, fallback: number, max: number): number {
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return Math.min(parsed, max);
}

function parseSizeFlag(raw?: string): number[] | null {
  if (!raw) {
    return null;
  }
  const parsed = raw
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isFinite(value) && value > 0)
    .map((value) => Math.floor(value));

  return parsed.length ? parsed : null;
}

function parseStringFlag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index < 0 || index === argv.length - 1) {
    return null;
  }
  return argv[index + 1];
}

function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function pick<T>(rng: () => number, values: T[]): T {
  const index = Math.floor(rng() * values.length);
  return values[index];
}

function readBytes(ms: NodeJS.MemoryUsage): number {
  return ms.heapUsed / (1024 * 1024);
}

function forceGc(): void {
  if (typeof globalThis.gc === 'function') {
    globalThis.gc();
  }
}

function nowMs(): number {
  const [seconds, nanoseconds] = process.hrtime();
  return seconds * 1_000 + nanoseconds / 1_000_000;
}

function percentile(values: number[], ratio: number): number {
  if (!values.length) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.max(0, Math.min(0.999, ratio));
  const index = Math.floor(clamped * (sorted.length - 1));
  return Number(sorted[index].toFixed(4));
}

function timingStats(name: string, query: string, repeats: number, samples: number[]): TimingRecord {
  if (!samples.length) {
    return {
      query,
      scenario: name,
      repeats: 0,
      minMs: 0,
      p50Ms: 0,
      p95Ms: 0,
      p99Ms: 0,
      maxMs: 0,
      meanMs: 0,
      throughputQps: 0,
    };
  }
  const minMs = Number(Math.min(...samples).toFixed(4));
  const maxMs = Number(Math.max(...samples).toFixed(4));
  const p50Ms = percentile(samples, 0.5);
  const p95Ms = percentile(samples, 0.95);
  const p99Ms = percentile(samples, 0.99);
  const meanMs = Number((samples.reduce((sum, value) => sum + value, 0) / samples.length).toFixed(4));
  const throughputQps = Number((1000 * repeats / samples.reduce((sum, value) => sum + value, 0)).toFixed(2));
  return {
    query,
    scenario: name,
    repeats,
    minMs,
    p50Ms,
    p95Ms,
    p99Ms,
    maxMs,
    meanMs,
    throughputQps,
  };
}

function runMeasured<T>(
  label: string,
  query: string,
  repeats: number,
  warmup: number,
  runner: () => T,
  blackhole: { value: number },
): TimingRecord {
  const runs = repeats + warmup;
  const samples: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = nowMs();
    const result = runner();
    const elapsed = nowMs() - start;
    blackhole.value +=
      typeof result === 'number'
        ? result
        : Array.isArray(result)
          ? result.length
          : 1;
    if (index >= warmup) {
      samples.push(elapsed);
    }
  }
  return timingStats(label, query, repeats, samples);
}

function buildGeoResults(size: number, seed: number): GeoSearchResult[] {
  const rng = makeRng(seed);
  const results: GeoSearchResult[] = new Array(size);
  for (let index = 0; index < size; index += 1) {
    const accession = `GSE${String(100_000 + index + 1).padStart(6, '0')}`;
    const tokenA = pick(rng, SAMPLE_TEXT_TOKENS).toUpperCase();
    const tokenB = pick(rng, SAMPLE_TEXT_TOKENS);
    const title = `Bulk ${tokenA} RNA-seq ${GRADE_TITLES[index % GRADE_TITLES.length]} cohort ${index}`;
    const summary = `A ${pick(rng, GRADE_SUMMARY_TOKENS)} and ${pick(rng, SAMPLE_TEXT_TOKENS)} profile for ${tokenB} samples.`;
    const organism = pick(rng, SAMPLE_ORGANISMS);
    const sampleCount = 12 + Math.floor(rng() * 260);
    const status = GEO_STATUSES[index % GEO_STATUSES.length];

    results[index] = {
      accession,
      title,
      summary,
      organism,
      sampleCount,
      pubmedId: `${1_000_000 + index}`,
      geoUrl: `https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=${accession}`,
      downloadUrl: `https://www.ncbi.nlm.nih.gov/geo/download/?acc=${accession}`,
      hasNcbiGeneratedRawCounts: status !== 'excluded',
      eligibilityStatus: status,
      isEligible: status === 'eligible',
      eligibilityReason: status === 'excluded' ? 'Benchmark synthetic sample' : undefined,
      rawCountsUrl: `https://www.ncbi.nlm.nih.gov/geo/download/${accession}_raw.tsv`,
      rawCountsFilename: `${accession}_raw_counts.txt`,
      seriesMatrixUrl: `https://www.ncbi.nlm.nih.gov/geo/download/${accession}_matrix.txt`,
    };
  }
  return results;
}

function buildSamplePreview(size: number, seed: number): GeoSeriesPreview {
  const rng = makeRng(seed);
  const sampleIds = new Array<string>(size);
  const sampleTitles: Record<string, string> = Object.create(null);
  const conditionBySample: Record<string, string> = Object.create(null);
  const batchBySample: Record<string, string> = Object.create(null);
  const tissueBySample: Record<string, string> = Object.create(null);
  const defaultGroupBySample: Record<string, 'A' | 'B' | '' | undefined> = Object.create(null);

  for (let index = 0; index < size; index += 1) {
    const sampleId = `GSM${String(index + 1).padStart(6, '0')}`;
    sampleIds[index] = sampleId;
    sampleTitles[sampleId] = `Sample ${index} ${pick(rng, SAMPLE_TEXT_TOKENS)} cohort`;
    conditionBySample[sampleId] = index % 2 === 0 ? 'healthy' : 'treated';
    batchBySample[sampleId] = `batch_${index % 4 + 1}`;
    tissueBySample[sampleId] = `tissue_${index % 5 + 1}`;
    defaultGroupBySample[sampleId] = index % 2 === 0 ? 'A' : 'B';
  }

  return {
    sampleIds,
    sampleTitles,
    factors: [
      {
        id: 'characteristic:condition',
        label: 'Condition',
        uniqueValues: ['healthy', 'treated'],
        valuesBySample: conditionBySample,
      },
      {
        id: 'characteristic:batch',
        label: 'Batch',
        uniqueValues: ['batch_1', 'batch_2', 'batch_3', 'batch_4'],
        valuesBySample: batchBySample,
      },
      {
        id: 'characteristic:tissue',
        label: 'Tissue',
        uniqueValues: ['tissue_1', 'tissue_2', 'tissue_3', 'tissue_4', 'tissue_5'],
        valuesBySample: tissueBySample,
      },
    ],
    defaultGroupFactorId: 'characteristic:condition',
    defaultConditionA: 'healthy',
    defaultConditionB: 'treated',
    defaultGroupBySample,
  };
}

function makeGeoQueries(size: number, results: GeoSearchResult[]): string[] {
  const sample = results[Math.floor(size * 0.25)] ?? results[0];
  const sample2 = results[Math.floor(size * 0.75)] ?? results[size - 1];
  const sampleAcc = sample?.accession ?? 'GSE000001';
  const sampleTitleTokens = sample?.title.split(' ') ?? [];
  const sampleSummaryTokens = sample?.summary.split(' ') ?? [];
  const titleToken = sampleTitleTokens[2] ?? 'bulk';
  const summaryToken = sampleSummaryTokens[2] ?? 'transcriptome';
  const organismToken = (sample?.organism ?? 'homo sapiens').split(' ')[0] ?? 'homo';

  return [
    '',
    'a',
    `accession:${sampleAcc.slice(0, 6)}`,
    sampleAcc,
    titleToken,
    `${organismToken} organism:${organismToken}`,
    `-"${summaryToken}" ${titleToken}`,
    `${titleToken} ${summaryToken}`,
    `"${titleToken} ${summaryToken}"`,
    `summary:${summaryToken} ${sample2?.organism.includes('Homo') ? 'homo' : 'mus'}`,
  ];
}

function makeSampleQueries(preview: GeoSeriesPreview): string[] {
  const first = preview.sampleIds[0] ?? 'GSM000001';
  const second = preview.sampleIds[1] ?? 'GSM000002';
  return [
    '',
    'a',
    first,
    `${first.slice(0, 4)}`,
    'healthy',
    `${second} batch_1`,
    'tissue_3 treated',
    'paired',
    'nonexistent',
  ];
}

function runGeoBenchmark(
  size: number,
  repeats: number,
  warmup: number,
  seed: number,
): GeoBenchmarkResult {
  const blackhole: { value: number } = { value: 0 };
  forceGc();
  const memoryBefore = readBytes(process.memoryUsage());
  const startedAt = nowMs();

  const results = buildGeoResults(size, seed + size);
  const indexOrders = buildGeoResultIndexOrders(results);
  const statusByIndex = results.map((result) => result.eligibilityStatus);
  const statusAccessor = (index: number) => statusByIndex[index];
  const statusSignature = `${size}-${results.length}-${seed}`;
  const engine = createGeoResultSearchEngine(results);
  const constructionMs = Number((nowMs() - startedAt).toFixed(4));

  forceGc();
  const memoryAfter = readBytes(process.memoryUsage());
  const queries = makeGeoQueries(size, results);
  const scenarios: TimingRecord[] = [];

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    scenarios.push(
      runMeasured('filter-snapshot', query, repeats, warmup, () => {
        const snapshot = engine.filterSnapshot(query);
        return snapshot.counts.all;
      }, blackhole),
      runMeasured('filter-snapshot-accessor', query, repeats, warmup, () => {
        const snapshot = engine.filterSnapshot(query, statusAccessor, statusSignature);
        return snapshot.allIndices.length;
      }, blackhole),
      runMeasured('filter-indices', query, repeats, warmup, () => {
        const filtered = engine.filterIndices(query, 'all');
        return filtered.length;
      }, blackhole),
      runMeasured('filter-indices-eligible', query, repeats, warmup, () => {
        const filtered = engine.filterIndices(query, 'eligible');
        return filtered.length;
      }, blackhole),
    );
    for (let modeIndex = 0; modeIndex < SORT_MODES.length; modeIndex += 1) {
      const sortMode = SORT_MODES[modeIndex];
      scenarios.push(
        runMeasured(
          `sort-${sortMode}`,
          query,
          repeats,
          warmup,
          () => {
            const filtered = engine.filterIndices(query, 'all');
            return orderFilteredGeoIndices(filtered, sortMode, indexOrders).length;
          },
          blackhole,
        ),
      );
    }
  }
  const _ = blackhole.value;
  void _;

  return {
    size,
    repeats,
    warmup,
    indexModes: SORT_MODES,
    constructionMs,
    memoryBeforeMb: Number(memoryBefore.toFixed(2)),
    memoryAfterMb: Number(memoryAfter.toFixed(2)),
    scenarios,
  };
}

function runSampleBenchmark(
  size: number,
  repeats: number,
  warmup: number,
  seed: number,
): SampleBenchmarkResult {
  const blackhole: { value: number } = { value: 0 };
  forceGc();
  const memoryBefore = readBytes(process.memoryUsage());
  const startedAt = nowMs();
  const preview = buildSamplePreview(size, seed + size * 3);
  const engine = createSampleSearchEngine(preview);
  const constructionMs = Number((nowMs() - startedAt).toFixed(4));
  forceGc();
  const memoryAfter = readBytes(process.memoryUsage());
  const queries = makeSampleQueries(preview);
  const scenarios: TimingRecord[] = [];

  for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
    const query = queries[queryIndex];
    scenarios.push(
      runMeasured('sample-filter', query, repeats, warmup, () => {
        return engine.filter(query).length;
      }, blackhole),
    );
  }

  const _ = blackhole.value;
  void _;
  return {
    size,
    repeats,
    warmup,
    constructionMs,
    memoryBeforeMb: Number(memoryBefore.toFixed(2)),
    memoryAfterMb: Number(memoryAfter.toFixed(2)),
    scenarios,
  };
}

function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const runStartedAt = new Date().toISOString();
  const geo: GeoBenchmarkResult[] = options.geoSizes.map((size) =>
    runGeoBenchmark(size, options.repeats, options.warmup, options.seed),
  );
  const sample: SampleBenchmarkResult[] = options.sampleSizes.map((size) =>
    runSampleBenchmark(size, options.repeats, options.warmup, options.seed),
  );
  const result: ScriptResult = {
    generatedAt: runStartedAt,
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    seed: options.seed,
    geo,
    sample,
  };

  fs.mkdirSync(path.dirname(options.output), { recursive: true });
  fs.writeFileSync(options.output, JSON.stringify(result, null, 2), 'utf8');

  console.log(`Search performance benchmark complete: ${options.output}`);
  console.log(`Generated ${geo.length} GEO suites and ${sample.length} sample suites`);
  for (const suite of geo) {
  const best = suite.scenarios.reduce(
    (acc, next) => (acc.p50Ms <= next.p50Ms ? acc : next),
    suite.scenarios[0],
  );
    console.log(
      `GEO size=${suite.size} construction=${suite.constructionMs}ms memory=${suite.memoryAfterMb - suite.memoryBeforeMb}MB p50=${best ? best.p50Ms : 0}ms (${best ? best.scenario : 'n/a'})`,
    );
  }
}

main();
