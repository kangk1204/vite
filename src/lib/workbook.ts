import * as XLSX from 'xlsx';
import { adaptViewerData, createUnverifiedEvidence } from './evidence';
import {
  findReferencePathway,
  getReferenceAssetVersion,
  getReferenceSummary,
  lookupCanonicalSymbol,
} from '../reference/symbols';
import {
  getHuriPpiNeighbors,
  getStringPpiNeighbors,
} from '../reference/ppi';
import { ensureReferenceAssetsLoaded } from '../reference/assets';
import type {
  BuilderSummary,
  EnrichmentCurve,
  GeneRecord,
  PathwayRecord,
  ProjectMeta,
  ValidationIssue,
  ViewerData,
  ViewerEdge,
  ViewerNode,
  ViewerProvenance,
  ViewerSampleMeta,
  WorkbookParseResult,
} from '../types';
import {
  dedupe,
  hasRequiredColumns,
  normalizeCollectionName,
  normalizeColumnKey,
  normalizeSymbolToken,
  parseNumber,
  splitGeneList,
} from './utils';

const REQUIRED_PROJECT_COLUMNS = [
  'project_title',
  'contrast_name',
  'condition_a',
  'condition_b',
];
const REQUIRED_GENE_COLUMNS = [
  'gene_symbol',
  'log2fc',
  'padj',
  'pvalue',
  'rank_metric',
  'condition_a_mean',
  'condition_b_mean',
];
const REQUIRED_PATHWAY_COLUMNS = [
  'pathway_name',
  'collection',
  'nes',
  'padj',
  'leading_edge_genes',
];
const REQUIRED_GENE_COLUMN_SET = new Set([...REQUIRED_GENE_COLUMNS, 'statistics_reason', 'missing_reason', 'unshrunk_log2fc', 'lfc_se']);
const SIGNIFICANCE_THRESHOLD = 0.05;
const MAX_ISSUES = 400;
const HURI_EDGE_SCORE = 850;
const MAX_SAMPLE_VALUES_PER_GENE = 160;
const MAX_WORKBOOK_BYTES = 24 * 1024 * 1024;
const WORKBOOK_PARSE_OPTIONS: XLSX.ParsingOptions = {
  type: 'array',
  sheets: ['Project', 'Genes', 'Pathways', 'Samples', 'GeneLabels', 'CustomPPI'],
  cellFormula: false,
  cellHTML: false,
  cellNF: false,
  cellStyles: false,
  bookDeps: false,
  bookFiles: false,
  bookProps: false,
  bookSheets: false,
  bookVBA: false,
  WTF: false,
};
const PROVENANCE_PROJECT_COLUMNS = [
  'dataset_identifier',
  'contrast_definition',
  'sample_group_source',
  'batch_handling_rule',
  'analysis_timestamp',
  'git_commit',
  'reference_asset_version',
  'notes',
] as const;

// Schema headers are case-insensitive; sample identifiers are not. Applying the
// schema normalizer to arbitrary expression columns merges distinct samples.
const WORKBOOK_SCHEMAS: Record<string, ReadonlySet<string>> = {
  Project: new Set([...REQUIRED_PROJECT_COLUMNS, ...PROVENANCE_PROJECT_COLUMNS, 'species', 'schema_version', 'analysis_method']),
  Genes: REQUIRED_GENE_COLUMN_SET,
  Pathways: new Set([...REQUIRED_PATHWAY_COLUMNS, 'pathway_id', 'statistics_reason', 'missing_reason']),
  Samples: new Set(['sample_id', 'sample', 'id', 'group', 'sample_group', 'condition', 'label', 'title', 'group_label', 'batch', 'batch_id', 'gene_symbol']),
  GeneLabels: new Set(['gene_symbol', 'label', 'priority']),
  CustomPPI: new Set(['gene_a', 'gene_b', 'score']),
};
const UNSAFE_COLUMN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function lookupCanonicalSymbolForGeo(symbol: string): string | null {
  return lookupCanonicalSymbol(symbol);
}

export function getReferenceAssetVersionForGeo(): string {
  return getReferenceAssetVersion();
}

export async function ensureWorkbookRuntimeReady(): Promise<void> {
  await ensureReferenceAssetsLoaded();
}

interface ParsedProjectSheet {
  project: ProjectMeta;
  provenance?: ViewerProvenance;
}

type SheetRow = Record<string, unknown>;
export interface WorkbookSheetRowsInput {
  projectRows: SheetRow[];
  genesRows: SheetRow[];
  pathwayRows: SheetRow[];
  sampleRows?: SheetRow[];
  labelRows?: SheetRow[];
  customPpiRows?: SheetRow[];
}

function canonicalWorkbookColumn(sheetName: string, key: string): string {
  const normalized = normalizeColumnKey(key);
  return WORKBOOK_SCHEMAS[sheetName]?.has(normalized) ? normalized : key;
}

function validateColumnIdentities(sheetName: string, headers: string[], issues: ValidationIssue[]): void {
  const seen = new Map<string, string>();
  for (const header of headers) {
    if (!header.trim()) continue;
    const key = canonicalWorkbookColumn(sheetName, header);
    if (UNSAFE_COLUMN_KEYS.has(normalizeColumnKey(header))) {
      pushIssue(issues, 'error', `Unsafe column name "${header}".`, sheetName);
    } else if (seen.has(key)) {
      pushIssue(issues, 'error', `Duplicate column "${key}" after schema normalization ("${seen.get(key)}" and "${header}").`, sheetName);
    } else seen.set(key, header);
  }
}

function normalizeWorkbookRows(rows: SheetRow[], sheetName: string, issues: ValidationIssue[]): SheetRow[] {
  validateColumnIdentities(sheetName, dedupe(rows.flatMap(row => Object.keys(row))), issues);
  return rows.map(row => {
    const normalized: SheetRow = Object.create(null);
    for (const [key, value] of Object.entries(row)) {
      if (!UNSAFE_COLUMN_KEYS.has(normalizeColumnKey(key))) normalized[canonicalWorkbookColumn(sheetName, key)] = value;
    }
    return normalized;
  });
}

function resolveExpressionColumns(
  genesRows: SheetRow[], sampleRows: SheetRow[], samplesById: Record<string, ViewerSampleMeta>, issues: ValidationIssue[],
): Map<string, ViewerSampleMeta> {
  const exact = new Map(Object.values(samplesById).map(sample => [sample.id, sample]));
  const aliases = new Map<string, Map<string, ViewerSampleMeta>>();
  for (const sample of exact.values()) {
    for (const alias of [sample.id, `sample_${sample.id}`]) {
      const key = normalizeColumnKey(alias);
      const entries = aliases.get(key) ?? new Map<string, ViewerSampleMeta>();
      entries.set(sample.id, sample); aliases.set(key, entries);
    }
  }
  const numericColumns = (rows: SheetRow[], schema: ReadonlySet<string>) => rows.flatMap(row =>
    Object.entries(row).filter(([key, value]) => !schema.has(key) && Number.isFinite(parseNumber(value))).map(([key]) => key));
  const columns = dedupe([...numericColumns(genesRows, WORKBOOK_SCHEMAS.Genes), ...numericColumns(sampleRows.filter(row => row.gene_symbol), WORKBOOK_SCHEMAS.Samples)]);
  const resolved = new Map<string, ViewerSampleMeta>();
  for (const column of columns) {
    const direct = exact.get(column);
    const prefixed = /^sample_/i.test(column) ? exact.get(column.slice(7)) : undefined;
    const exactCandidates = new Map([direct, prefixed].filter((sample): sample is ViewerSampleMeta => Boolean(sample)).map(sample => [sample.id, sample]));
    const candidates = exactCandidates.size ? exactCandidates : aliases.get(normalizeColumnKey(column));
    if (candidates && candidates.size > 1) {
      pushIssue(issues, 'error', `Ambiguous sample expression column "${column}" matches multiple sample IDs: ${Array.from(candidates.keys()).join(', ')}. Use an exact, unambiguous sample identifier.`, 'Samples');
    } else if (candidates?.size === 1) resolved.set(column, candidates.values().next().value!);
  }
  return resolved;
}

function nullableStatistic(value: unknown, probability = false): number | null {
  const parsed = parseNumber(value);
  return Number.isFinite(parsed) && (!probability || (parsed >= 0 && parsed <= 1)) ? parsed : null;
}

function sheetRows(workbook: XLSX.WorkBook, sheetName: string): SheetRow[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return [];
  }

  return XLSX.utils.sheet_to_json<SheetRow>(sheet, {
    defval: '',
    raw: false,
  });
}

function pushIssue(
  issues: ValidationIssue[],
  level: ValidationIssue['level'],
  message: string,
  context?: string,
): void {
  if (issues.length >= MAX_ISSUES) {
    const alreadyNotified = issues.some(
      (issue) =>
        issue.level === 'warning' &&
        issue.message === `Issue log truncated after ${MAX_ISSUES.toLocaleString()} entries.`,
    );
    if (!alreadyNotified) {
      issues.push({
        level: 'warning',
        message: `Issue log truncated after ${MAX_ISSUES.toLocaleString()} entries.`,
        context: 'Validation',
      });
    }
    return;
  }
  issues.push({ level, message, context });
}

function upsertSampleMetadata(
  samplesById: Record<string, ViewerSampleMeta>,
  sampleId: string,
  nextFields: Partial<ViewerSampleMeta> = {},
): void {
  if (!sampleId || sampleId === '__proto__' || sampleId === 'constructor' || sampleId === 'prototype') {
    return;
  }
  const existing = samplesById[sampleId] ?? { id: sampleId };
  samplesById[sampleId] = {
    ...existing,
    ...nextFields,
    id: sampleId,
  };
}

function mergeSampleValues(
  existing: Record<string, number>,
  incoming: Record<string, number>,
): { sampleValues: Record<string, number>; sampleCount: number; truncated: boolean } {
  const merged: Record<string, number> = Object.assign(Object.create(null), existing);
  let sampleCount = Object.keys(merged).length;
  let truncated = false;

  Object.entries(incoming).forEach(([key, value]) => {
    if (Object.prototype.hasOwnProperty.call(merged, key)) {
      merged[key] = value;
      return;
    }
    if (sampleCount >= MAX_SAMPLE_VALUES_PER_GENE) {
      truncated = true;
      return;
    }
    merged[key] = value;
    sampleCount += 1;
  });

  return {
    sampleValues: merged,
    sampleCount,
    truncated,
  };
}

function mergeGeneRecord(
  existing: GeneRecord | undefined,
  incoming: GeneRecord,
  issues: ValidationIssue[],
): { gene: GeneRecord; truncated: boolean; sampleCount: number } {
  if (!existing) {
    return {
      gene: incoming,
      truncated: false,
      sampleCount: Object.keys(incoming.sampleValues).length,
    };
  }

  pushIssue(
    issues,
    'warning',
    `Duplicate gene row detected for ${incoming.symbol}; retained the more significant entry.`,
    'Genes',
  );

  const significanceScore = (gene: GeneRecord): number => {
    if (Number.isFinite(gene.padj)) {
      return gene.padj!;
    }
    if (Number.isFinite(gene.pvalue)) {
      return gene.pvalue!;
    }
    return Number.POSITIVE_INFINITY;
  };

  const existingScore = significanceScore(existing);
  const incomingScore = significanceScore(incoming);
  const keepExisting = existingScore <= incomingScore;
  const winner = keepExisting ? existing : incoming;
  const loser = keepExisting ? incoming : existing;
  const mergedSamples = mergeSampleValues(loser.sampleValues, winner.sampleValues);

  return {
    gene: {
      ...winner,
      sampleValues: mergedSamples.sampleValues,
      label: winner.label ?? loser.label,
      labelPriority: Math.max(winner.labelPriority ?? 0, loser.labelPriority ?? 0) || undefined,
    },
    truncated: mergedSamples.truncated,
    sampleCount: mergedSamples.sampleCount,
  };
}

function buildEnrichmentCurve(
  rankedGenes: Array<Pick<GeneRecord, 'symbol' | 'rankMetric'>>,
  geneSet: Set<string>,
): EnrichmentCurve {
  const hitIndices: number[] = [];
  let hitWeight = 0;
  rankedGenes.forEach((gene, index) => {
    if (geneSet.has(gene.symbol)) { hitIndices.push(index + 1); hitWeight += Math.abs(gene.rankMetric ?? 0); }
  });
  if (!hitIndices.length || !hitWeight) return {
    representation: 'ranked-hits-v1', points: [], hitIndices: [], maxAbsValue: 0,
    unavailableReason: 'The supplied rank universe has no nonzero pathway-hit weight.',
  };
  const hits = new Set(hitIndices);
  const missWeight = rankedGenes.length === hits.size ? 0 : 1 / (rankedGenes.length - hits.size);
  let running = 0, maxAbsValue = 0;
  rankedGenes.forEach((gene, index) => {
    running += hits.has(index + 1) ? Math.abs(gene.rankMetric ?? 0) / hitWeight : -missWeight;
    maxAbsValue = Math.max(maxAbsValue, Math.abs(running));
  });
  // Store the rank universe once at report level, not once per pathway.
  return { representation: 'ranked-hits-v1', points: [], hitIndices, maxAbsValue };
}

function buildEdgeKey(source: string, target: string): string {
  return [source, target].sort().join('::');
}

interface PathwayNetworkContext {
  knownGenes: Set<string>;
  stringNeighborsByGene: Map<string, Array<[string, number]>>;
  huriNeighborsByGene: Map<string, string[]>;
  customEdgesByGene: Map<string, ViewerEdge[]>;
}

function buildPathwayNetworkContext(
  genesBySymbol: Map<string, GeneRecord>,
  customPpi: Map<string, ViewerEdge>,
): PathwayNetworkContext {
  const knownGenes = new Set(genesBySymbol.keys());
  const stringNeighborsByGene = new Map<string, Array<[string, number]>>();
  const huriNeighborsByGene = new Map<string, string[]>();
  const customEdgesByGene = new Map<string, ViewerEdge[]>();

  for (const edge of customPpi.values()) {
    if (edge.source === edge.target || !knownGenes.has(edge.source) || !knownGenes.has(edge.target)) {
      continue;
    }
    const sourceEdges = customEdgesByGene.get(edge.source);
    if (sourceEdges) {
      sourceEdges.push(edge);
    } else {
      customEdgesByGene.set(edge.source, [edge]);
    }
    const targetEdges = customEdgesByGene.get(edge.target);
    if (targetEdges) {
      targetEdges.push(edge);
    } else {
      customEdgesByGene.set(edge.target, [edge]);
    }
  }

  return {
    knownGenes,
    stringNeighborsByGene,
    huriNeighborsByGene,
    customEdgesByGene,
  };
}

function getStringNeighborsForGene(
  context: PathwayNetworkContext,
  gene: string,
): Array<[string, number]> {
  const cached = context.stringNeighborsByGene.get(gene);
  if (cached !== undefined) {
    return cached;
  }
  const filtered = getStringPpiNeighbors(gene).filter(
    ([neighbor]) => neighbor !== gene && context.knownGenes.has(neighbor),
  );
  context.stringNeighborsByGene.set(gene, filtered);
  return filtered;
}

function getHuriNeighborsForGene(
  context: PathwayNetworkContext,
  gene: string,
): string[] {
  const cached = context.huriNeighborsByGene.get(gene);
  if (cached !== undefined) {
    return cached;
  }
  const filtered = getHuriPpiNeighbors(gene)
    .map(([neighbor]) => neighbor)
    .filter((neighbor) => neighbor !== gene && context.knownGenes.has(neighbor));
  context.huriNeighborsByGene.set(gene, filtered);
  return filtered;
}

function buildNetworkEdges(
  genes: string[],
  context: PathwayNetworkContext,
): ViewerEdge[] {
  const geneSet = new Set(genes);
  const edges = new Map<string, ViewerEdge>();

  const mergeEdge = (
    source: string,
    target: string,
    score: number,
    sourceFlags: Pick<ViewerEdge, 'isString' | 'isHuRI' | 'isCustom'>,
  ): void => {
    if (source === target) {
      return;
    }
    const key = buildEdgeKey(source, target);
    const existing = edges.get(key);
    if (!existing) {
      edges.set(key, {
        source,
        target,
        score,
        isString: Boolean(sourceFlags.isString),
        isHuRI: Boolean(sourceFlags.isHuRI),
        isCustom: Boolean(sourceFlags.isCustom),
      });
      return;
    }

    edges.set(key, {
      ...existing,
      score: Math.max(existing.score, score),
      isString: Boolean(existing.isString || sourceFlags.isString),
      isHuRI: Boolean(existing.isHuRI || sourceFlags.isHuRI),
      isCustom: Boolean(existing.isCustom || sourceFlags.isCustom),
    });
  };

  genes.forEach((gene) => {
    const stringNeighbors = getStringNeighborsForGene(context, gene);
    for (const [neighbor, score] of stringNeighbors) {
      if (!geneSet.has(neighbor)) {
        continue;
      }
      mergeEdge(gene, neighbor, score, { isString: true, isHuRI: false, isCustom: false });
    }

    const huriNeighbors = getHuriNeighborsForGene(context, gene);
    for (const neighbor of huriNeighbors) {
      if (!geneSet.has(neighbor)) {
        continue;
      }
      mergeEdge(gene, neighbor, HURI_EDGE_SCORE, { isString: false, isHuRI: true, isCustom: false });
    }

    const customEdges = context.customEdgesByGene.get(gene) ?? [];
    for (const edge of customEdges) {
      if (!geneSet.has(edge.source) || !geneSet.has(edge.target)) {
        continue;
      }
      mergeEdge(edge.source, edge.target, edge.score, { isString: false, isHuRI: false, isCustom: true });
    }
  });

  return Array.from(edges.values()).sort((a, b) => b.score - a.score);
}

function buildViewerNodes(
  genes: string[],
  genesBySymbol: Map<string, GeneRecord>,
  leadingEdge: Set<string>,
): ViewerNode[] {
  return genes
    .map<ViewerNode | null>((symbol) => {
      const gene = genesBySymbol.get(symbol);
      if (!gene) {
        return null;
      }

      const significanceValue = Number.isFinite(gene.padj) ? gene.padj! : 1;

      return {
        id: gene.symbol,
        originalId: gene.originalSymbol,
        label: gene.label ?? gene.symbol,
        labelPriority: gene.labelPriority ?? 0,
        log2fc: gene.log2fc,
        padj: gene.padj,
        pvalue: gene.pvalue,
        sizeMetric: Math.min(12, -Math.log10(Math.max(significanceValue, 1e-12))),
        conditionAMean: gene.conditionAMean,
        conditionBMean: gene.conditionBMean,
        statisticsReason: gene.statisticsReason,
        sampleValues: gene.sampleValues,
        isLeadingEdge: leadingEdge.has(gene.symbol),
      } satisfies ViewerNode;
    })
    .filter((node): node is ViewerNode => Boolean(node))
    .sort((a, b) => b.sizeMetric - a.sizeMetric || b.labelPriority - a.labelPriority);
}

function parseProjectSheet(rows: SheetRow[], issues: ValidationIssue[]): ParsedProjectSheet | null {
  if (!rows.length) {
    return null;
  }

  const missing = hasRequiredColumns(rows, REQUIRED_PROJECT_COLUMNS);
  if (missing.length) {
    pushIssue(issues, 'error', `Project sheet is missing columns: ${missing.join(', ')}`, 'Project');
    return null;
  }

  const row = rows.find((entry) => Object.values(entry).some((value) => String(value).trim()));
  if (!row) {
    pushIssue(issues, 'error', 'Project sheet is empty.', 'Project');
    return null;
  }

  const withFallback = (value: unknown, fallback: string): string => {
    const normalized = String(value ?? '').trim();
    return normalized || fallback;
  };

  const project: ProjectMeta = {
    projectTitle: withFallback(row.project_title, 'Pathway Network Viewer Study'),
    contrastName: withFallback(row.contrast_name, 'Condition_B_vs_A'),
    conditionA: withFallback(row.condition_a, 'Condition A'),
    conditionB: withFallback(row.condition_b, 'Condition B'),
    species: String(row.species || 'human').trim().toLowerCase() || 'human',
  };

  if (project.species !== 'human') {
    pushIssue(
      issues,
      'warning',
      `Species "${project.species}" is not fully supported in v1; the viewer will treat the study as human.`,
      'Project',
    );
    project.species = 'human';
  }

  const provenanceFields = Object.fromEntries(
    PROVENANCE_PROJECT_COLUMNS.map((key) => {
      const normalized = String(row[key] ?? '').trim();
      return [key, normalized || undefined];
    }),
  ) as Record<(typeof PROVENANCE_PROJECT_COLUMNS)[number], string | undefined>;

  const provenance: ViewerProvenance = {
    datasetIdentifier: provenanceFields.dataset_identifier,
    contrastDefinition:
      provenanceFields.contrast_definition || `${project.conditionB} versus ${project.conditionA}`,
    sampleGroupSource: provenanceFields.sample_group_source,
    batchHandlingRule: provenanceFields.batch_handling_rule,
    analysisTimestamp: provenanceFields.analysis_timestamp,
    gitCommit: provenanceFields.git_commit,
    referenceAssetVersion: provenanceFields.reference_asset_version || getReferenceAssetVersion(),
    notes: provenanceFields.notes,
  };

  return {
    project,
    provenance,
  };
}

export async function parseWorkbookFile(file: File): Promise<WorkbookParseResult> {
  await ensureWorkbookRuntimeReady();
  if (file.size > MAX_WORKBOOK_BYTES) {
    throw new Error(
      `Workbook is too large (${(file.size / (1024 * 1024)).toFixed(1)} MiB). ` +
        `Use a ${MAX_WORKBOOK_BYTES / (1024 * 1024)} MiB or smaller PathwayViewer workbook.`,
    );
  }
  const buffer = await file.arrayBuffer();
  return parseWorkbookBuffer(buffer);
}

export function parseWorkbookRows(rows: WorkbookSheetRowsInput): WorkbookParseResult {
  const issues: ValidationIssue[] = [];
  const summary: BuilderSummary = {
    totalGenes: 0,
    totalPathways: 0,
    significantPathways: 0,
    fallbackPathways: 0,
    unknownGenes: 0,
  };

  const projectRows = normalizeWorkbookRows(rows.projectRows ?? [], 'Project', issues);
  const genesRows = normalizeWorkbookRows(rows.genesRows ?? [], 'Genes', issues);
  const pathwayRows = normalizeWorkbookRows(rows.pathwayRows ?? [], 'Pathways', issues);
  const sampleRows = normalizeWorkbookRows(rows.sampleRows ?? [], 'Samples', issues);
  const labelRows = normalizeWorkbookRows(rows.labelRows ?? [], 'GeneLabels', issues);
  const customPpiRows = normalizeWorkbookRows(rows.customPpiRows ?? [], 'CustomPPI', issues);
  const canonicalSymbolCache = new Map<string, string | null>();
  const toCanonicalSymbol = (value: unknown): string | null => {
    const normalizedToken = normalizeSymbolToken(String(value ?? ''));
    if (!normalizedToken) {
      return null;
    }
    if (canonicalSymbolCache.has(normalizedToken)) {
      return canonicalSymbolCache.get(normalizedToken) ?? null;
    }
    const canonical = lookupCanonicalSymbol(normalizedToken);
    canonicalSymbolCache.set(normalizedToken, canonical);
    return canonical;
  };

  if (!projectRows.length) {
    pushIssue(issues, 'error', 'Missing required sheet: Project');
  }
  if (!genesRows.length) {
    pushIssue(issues, 'error', 'Missing required sheet: Genes');
  }

  const parsedProject = parseProjectSheet(projectRows, issues);
  if (!parsedProject) {
    return { viewerData: null, issues, summary };
  }
  const { project, provenance: parsedProvenance } = parsedProject;

  const missingGeneColumns = genesRows.length
    ? hasRequiredColumns(genesRows, REQUIRED_GENE_COLUMNS)
    : [];
  if (missingGeneColumns.length) {
    pushIssue(issues, 'error', `Genes sheet is missing columns: ${missingGeneColumns.join(', ')}`, 'Genes');
  }

  const missingPathwayColumns = pathwayRows.length
    ? hasRequiredColumns(pathwayRows, REQUIRED_PATHWAY_COLUMNS)
    : [];
  if (missingPathwayColumns.length) {
    pushIssue(
      issues,
      'error',
      `Pathways sheet is missing columns: ${missingPathwayColumns.join(', ')}`,
      'Pathways',
    );
  }

  if (issues.some((issue) => issue.level === 'error')) {
    return { viewerData: null, issues, summary };
  }

  const labelMap = new Map<string, { label: string; priority: number }>();
  const warnedUnknownGeneSymbols = new Set<string>();
  const warnedNormalizedSymbols = new Set<string>();
  const samplesById: Record<string, ViewerSampleMeta> = {};
  sampleRows.forEach((row) => {
    const sampleId = String(row.sample_id ?? row.sample ?? row.id ?? '').trim();
    if (!sampleId) {
      return;
    }
    if (UNSAFE_COLUMN_KEYS.has(sampleId) || Object.hasOwn(samplesById, sampleId)) {
      pushIssue(issues, 'error', `Duplicate or unsafe sample identifier "${sampleId}".`, 'Samples');
      return;
    }
    const groupRaw = String(row.group ?? row.sample_group ?? row.condition ?? '').trim();
    const groupKey =
      groupRaw === 'A' || groupRaw === 'B' || groupRaw === 'U'
        ? groupRaw
        : undefined;
    upsertSampleMetadata(samplesById, sampleId, {
      label: String(row.label ?? row.title ?? sampleId).trim() || sampleId,
      groupKey,
      groupLabel: String(row.group_label || groupRaw).trim() || undefined,
      batch: String(row.batch ?? row.batch_id ?? '').trim() || undefined,
    });
  });
  labelRows.forEach((row) => {
    const canonical = toCanonicalSymbol(row.gene_symbol);
    if (!canonical) {
      return;
    }
    labelMap.set(canonical, {
      label: String(row.label || canonical).trim() || canonical,
      priority: parseNumber(row.priority) || 0,
    });
  });

  const sampleByColumn = resolveExpressionColumns(genesRows, sampleRows, samplesById, issues);
  if (issues.some(issue => issue.level === 'error')) return { viewerData: null, issues, summary };
  const genesBySymbol = new Map<string, GeneRecord>();
  const unmappedRankedGenes = new Map<string, number>();
  const unknownGenes = new Set<string>();
  const genesWithTruncatedSamples = new Set<string>();
  const sampleValueCountByGene = new Map<string, number>();

  genesRows.forEach((row, index) => {
    const originalSymbol = String(row.gene_symbol || '').trim();
    if (!originalSymbol) {
      return;
    }
    const normalizedOriginalSymbol = normalizeSymbolToken(originalSymbol);

    const canonicalSymbol = toCanonicalSymbol(originalSymbol);
    if (!canonicalSymbol) {
      unknownGenes.add(originalSymbol);
      const metric = nullableStatistic(row.rank_metric);
      if (metric !== null) unmappedRankedGenes.set(originalSymbol, metric);
      const unknownKey = normalizeSymbolToken(originalSymbol);
      if (unknownKey && !warnedUnknownGeneSymbols.has(unknownKey)) {
        warnedUnknownGeneSymbols.add(unknownKey);
        pushIssue(issues, 'warning', `Unrecognized gene symbol "${originalSymbol}" omitted from the network; any finite rank remains in the ranked universe.`, `Genes row ${index + 2}`);
      }
      return;
    }

    const sampleValues: Record<string, number> = Object.create(null);
    let sampleValueCount = 0;
    let truncatedGeneSamples = false;
    for (const [key, value] of Object.entries(row)) {
      if (
        REQUIRED_GENE_COLUMN_SET.has(key) ||
        value === '' ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      ) {
        continue;
      }
      const numeric = parseNumber(value);
      if (Number.isFinite(numeric)) {
        upsertSampleMetadata(samplesById, key, sampleByColumn.get(key) ? { ...sampleByColumn.get(key), id: key } : {});
        if (Object.prototype.hasOwnProperty.call(sampleValues, key)) {
          sampleValues[key] = numeric;
          continue;
        }
        if (sampleValueCount >= MAX_SAMPLE_VALUES_PER_GENE) {
          truncatedGeneSamples = true;
          continue;
        }
        sampleValues[key] = numeric;
        sampleValueCount += 1;
      }
    }

    const labelEntry = labelMap.get(canonicalSymbol);
    const geneRecord: GeneRecord = {
      symbol: canonicalSymbol,
      originalSymbol,
      log2fc: nullableStatistic(row.log2fc),
      padj: nullableStatistic(row.padj, true),
      pvalue: nullableStatistic(row.pvalue, true),
      rankMetric: nullableStatistic(row.rank_metric),
      conditionAMean: nullableStatistic(row.condition_a_mean),
      conditionBMean: nullableStatistic(row.condition_b_mean),
      statisticsReason: String(row.statistics_reason || row.missing_reason || '').trim() || undefined,
      sampleValues,
      label: labelEntry?.label,
      labelPriority: labelEntry?.priority,
    };

    if (
      [geneRecord.log2fc, geneRecord.padj, geneRecord.pvalue, geneRecord.rankMetric].some(
        (value) => value === null,
      )
    ) {
      geneRecord.statisticsReason ||= 'One or more statistics were not supplied or could not be tested.';
      pushIssue(issues, 'warning', `Gene row for ${canonicalSymbol} has missing or invalid statistics; preserved as null.`, 'Genes');
    }

    if (
      canonicalSymbol !== normalizedOriginalSymbol &&
      !warnedNormalizedSymbols.has(normalizedOriginalSymbol)
    ) {
      warnedNormalizedSymbols.add(normalizedOriginalSymbol);
      pushIssue(
        issues,
        'info',
        `Normalized gene symbol "${originalSymbol}" to "${canonicalSymbol}".`,
        'Genes',
      );
    }

    if (truncatedGeneSamples) {
      genesWithTruncatedSamples.add(canonicalSymbol);
    }

    const merged = mergeGeneRecord(genesBySymbol.get(canonicalSymbol), geneRecord, issues);
    genesBySymbol.set(canonicalSymbol, merged.gene);
    sampleValueCountByGene.set(canonicalSymbol, merged.sampleCount);
    if (merged.truncated) {
      genesWithTruncatedSamples.add(canonicalSymbol);
    }
  });

  sampleRows.forEach((row) => {
    const canonical = toCanonicalSymbol(row.gene_symbol);
    if (!canonical) {
      return;
    }

    const gene = genesBySymbol.get(canonical);
    if (!gene) {
      return;
    }

    Object.entries(row).forEach(([key, value]) => {
      if (
        WORKBOOK_SCHEMAS.Samples.has(key) ||
        key === '__proto__' ||
        key === 'constructor' ||
        key === 'prototype'
      ) {
        return;
      }
      const numeric = parseNumber(value);
      if (Number.isFinite(numeric)) {
        upsertSampleMetadata(samplesById, key, sampleByColumn.get(key) ? { ...sampleByColumn.get(key), id: key } : {});
        const hasExistingValue = Object.prototype.hasOwnProperty.call(gene.sampleValues, key);
        const currentSampleValueCount = sampleValueCountByGene.get(canonical) ?? Object.keys(gene.sampleValues).length;
        if (!hasExistingValue && currentSampleValueCount >= MAX_SAMPLE_VALUES_PER_GENE) {
          genesWithTruncatedSamples.add(canonical);
          return;
        }
        gene.sampleValues[key] = numeric;
        if (!hasExistingValue) {
          sampleValueCountByGene.set(canonical, currentSampleValueCount + 1);
        }
      }
    });
  });

  if (genesWithTruncatedSamples.size) {
    pushIssue(
      issues,
      'info',
      `${genesWithTruncatedSamples.size.toLocaleString()} gene(s) exceeded ${MAX_SAMPLE_VALUES_PER_GENE} sample values; extra sample columns were omitted to keep report memory usage stable.`,
      'Samples',
    );
  }

  const customPpi = new Map<string, ViewerEdge>();
  customPpiRows.forEach((row, index) => {
    const source = toCanonicalSymbol(row.gene_a);
    const target = toCanonicalSymbol(row.gene_b);
    const score = parseNumber(row.score);
    if (!source || !target || !Number.isFinite(score) || source === target) {
      pushIssue(issues, 'warning', `Invalid CustomPPI row ignored.`, `CustomPPI row ${index + 2}`);
      return;
    }

    customPpi.set(buildEdgeKey(source, target), { source, target, score, isCustom: true });
  });

  const rankedGenes = [...Array.from(genesBySymbol.values()).filter(gene => gene.rankMetric !== null), ...Array.from(unmappedRankedGenes, ([symbol, rankMetric]) => ({ symbol, rankMetric }))].sort(
    (left, right) => right.rankMetric! - left.rankMetric! || left.symbol.localeCompare(right.symbol),
  );
  const networkContext = buildPathwayNetworkContext(genesBySymbol, customPpi);

  const pathways: PathwayRecord[] = [];
  const pathwayKeyCounts = new Map<string, number>();

  pathwayRows.forEach((row, index) => {
    const pathwayName = String(row.pathway_name || '').trim();
    if (!pathwayName) {
      return;
    }

    const collection = normalizeCollectionName(String(row.collection || ''));
    const pathwayId = String(row.pathway_id || '').trim() || undefined;
    const referencePathway = findReferencePathway(collection, pathwayId, pathwayName);

    const leadingEdgeGenes = dedupe(
      splitGeneList(row.leading_edge_genes).flatMap((gene) => {
        const canonical = toCanonicalSymbol(gene);
        if (!canonical) {
          unknownGenes.add(gene);
          const unknownKey = normalizeSymbolToken(gene);
          if (unknownKey && !warnedUnknownGeneSymbols.has(unknownKey)) {
            warnedUnknownGeneSymbols.add(unknownKey);
            pushIssue(
              issues,
              'warning',
              `Unrecognized leading-edge gene symbol "${gene}" skipped.`,
              `Pathways row ${index + 2}`,
            );
          }
          return [];
        }
        return [canonical];
      }),
    );

    if (!leadingEdgeGenes.length) {
      pushIssue(
        issues,
        'warning',
        `Pathway "${pathwayName}" has no valid leading-edge genes after normalization.`,
        `Pathways row ${index + 2}`,
      );
    }

    const referenceGenes = referencePathway?.genes ?? [];
    const candidateGenes = dedupe([...referenceGenes, ...leadingEdgeGenes]);
    const allGenes = candidateGenes.filter((symbol) =>
      genesBySymbol.has(symbol),
    );
    const availableLeadingEdge = leadingEdgeGenes.filter((symbol) => genesBySymbol.has(symbol));
    const missingGenes = candidateGenes.filter(
      (symbol) => !genesBySymbol.has(symbol),
    );

    if (!allGenes.length && !availableLeadingEdge.length) {
      pushIssue(
        issues,
        'warning',
        `Pathway "${pathwayName}" has no genes present in the Genes sheet; statistics are retained without network nodes.`,
        'Pathways',
      );
    }

    const nodes = buildViewerNodes(
      allGenes.length ? allGenes : availableLeadingEdge,
      genesBySymbol,
      new Set(availableLeadingEdge),
    );
    const edges = buildNetworkEdges(
      allGenes.length ? allGenes : availableLeadingEdge,
      networkContext,
    );

    const pathwayGeneSet = new Set(referencePathway ? allGenes : availableLeadingEdge);
    const enrichment = buildEnrichmentCurve(rankedGenes, pathwayGeneSet);

    const basePathwayKey = `${collection}::${pathwayId ?? pathwayName}`;
    const previousKeyCount = pathwayKeyCounts.get(basePathwayKey) ?? 0;
    const nextKeyCount = previousKeyCount + 1;
    pathwayKeyCounts.set(basePathwayKey, nextKeyCount);
    const pathwayKey = nextKeyCount === 1 ? basePathwayKey : `${basePathwayKey}::dup${nextKeyCount}`;
    if (nextKeyCount > 1) {
      pushIssue(
        issues,
        'warning',
        `Duplicate pathway identifier "${basePathwayKey}" detected; assigned "${pathwayKey}" to keep entries distinct.`,
        `Pathways row ${index + 2}`,
      );
    }

    const parsedNes = nullableStatistic(row.nes);
    const parsedPadj = nullableStatistic(row.padj, true);
    if (!Number.isFinite(parsedNes) || !Number.isFinite(parsedPadj)) {
      pushIssue(
        issues,
        'warning',
        `Pathway "${pathwayName}" has non-numeric NES or FDR value.`,
        `Pathways row ${index + 2}`,
      );
    }

    const pathway: PathwayRecord = {
      key: pathwayKey,
      pathwayId,
      pathwayName,
      collection,
      nes: parsedNes,
      padj: parsedPadj,
      statisticsReason: String(row.statistics_reason || row.missing_reason || '').trim() || (parsedNes === null || parsedPadj === null ? 'NES or FDR was not supplied or could not be tested.' : undefined),
      source: { table: 'Pathways', row: index + 1 },
      leadingEdgeGenes: availableLeadingEdge,
      allGenes: allGenes.length ? allGenes : availableLeadingEdge,
      hasReferenceMembership: Boolean(referencePathway),
      fallbackToLeadingEdge: !referencePathway,
      missingGenes,
      nodes,
      edges,
      enrichment,
    };

    if (pathway.fallbackToLeadingEdge) {
      pushIssue(
        issues,
        'info',
        `Pathway "${pathwayName}" uses leading-edge genes only because no built-in membership match was found.`,
        'Pathways',
      );
    }

    pathways.push(pathway);
  });

  pathways.sort((left, right) => {
    const leftPadj = Number.isFinite(left.padj) ? left.padj! : Number.POSITIVE_INFINITY;
    const rightPadj = Number.isFinite(right.padj) ? right.padj! : Number.POSITIVE_INFINITY;
    const leftSig = leftPadj <= SIGNIFICANCE_THRESHOLD ? 1 : 0;
    const rightSig = rightPadj <= SIGNIFICANCE_THRESHOLD ? 1 : 0;
    const leftNes = Number.isFinite(left.nes) ? left.nes! : Number.NEGATIVE_INFINITY;
    const rightNes = Number.isFinite(right.nes) ? right.nes! : Number.NEGATIVE_INFINITY;
    return rightSig - leftSig || rightNes - leftNes || left.pathwayName.localeCompare(right.pathwayName);
  });

  summary.totalGenes = genesBySymbol.size;
  summary.totalPathways = pathways.length;
  let significantPathwayCount = 0;
  let fallbackPathwayCount = 0;
  for (const pathway of pathways) {
    if (pathway.padj !== null && Number.isFinite(pathway.padj) && pathway.padj <= SIGNIFICANCE_THRESHOLD) {
      significantPathwayCount += 1;
    }
    if (pathway.fallbackToLeadingEdge) {
      fallbackPathwayCount += 1;
    }
  }
  summary.significantPathways = significantPathwayCount;
  summary.fallbackPathways = fallbackPathwayCount;
  summary.unknownGenes = unknownGenes.size;

  if (!pathways.length) {
    pushIssue(issues, 'info', 'No pathways were tested or supplied. No significance was inferred.', 'Pathways');
  }

  const viewerData: ViewerData = {
    project,
    builtAt: new Date().toISOString(),
    significantPadjThreshold: SIGNIFICANCE_THRESHOLD,
    referenceSummary: getReferenceSummary(),
    rankedGenes: rankedGenes.map(gene => ({ gene: gene.symbol, metric: gene.rankMetric! })),
    provenance: parsedProvenance,
    issues,
    pathways,
    samplesById: Object.keys(samplesById).length ? samplesById : undefined,
  };

  const evidence = createUnverifiedEvidence(viewerData);
  const toSourceTable = (rows: SheetRow[]) => {
    const columns = dedupe(rows.flatMap(row => Object.keys(row)));
    return { columns, rows: rows.map(row => columns.map(column => {
      const value = row[column];
      return value === undefined || value === null || value === '' ? null : typeof value === 'number' && Number.isFinite(value) ? value : String(value);
    })) };
  };
  evidence.sourceTables = { Project: toSourceTable(projectRows), Genes: toSourceTable(genesRows), Pathways: toSourceTable(pathwayRows), Samples: toSourceTable(sampleRows) };
  evidence.pathways = Object.fromEntries(pathways.map(pathway => [pathway.pathwayId || pathway.key, { source: pathway.source }]));
  return { viewerData: adaptViewerData({ ...viewerData, evidence }), issues, summary };
}

export function parseWorkbookBuffer(buffer: ArrayBuffer): WorkbookParseResult {
  if (buffer.byteLength > MAX_WORKBOOK_BYTES) {
    throw new Error(
      `Workbook is too large (${(buffer.byteLength / (1024 * 1024)).toFixed(1)} MiB). ` +
        `Use a ${MAX_WORKBOOK_BYTES / (1024 * 1024)} MiB or smaller PathwayViewer workbook.`,
    );
  }
  const workbook = XLSX.read(buffer, WORKBOOK_PARSE_OPTIONS);
  const headerIssues: ValidationIssue[] = [];
  for (const sheetName of Object.keys(WORKBOOK_SCHEMAS)) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) continue;
    const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1');
    const headerRange = { s: range.s, e: { r: range.s.r, c: range.e.c } };
    const headers = (XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, range: headerRange, raw: false, defval: '' })[0] ?? []).map(value => String(value ?? ''));
    validateColumnIdentities(sheetName, headers, headerIssues);
  }
  if (headerIssues.length) return { viewerData: null, issues: headerIssues, summary: { totalGenes: 0, totalPathways: 0, significantPathways: 0, fallbackPathways: 0, unknownGenes: 0 } };
  const missingSheets = ['Project', 'Genes', 'Pathways'].filter(name => !workbook.Sheets[name]);
  if (missingSheets.length) return { viewerData: null, issues: missingSheets.map(name => ({ level: 'error' as const, message: `Missing required sheet: ${name}` })), summary: { totalGenes: 0, totalPathways: 0, significantPathways: 0, fallbackPathways: 0, unknownGenes: 0 } };
  return parseWorkbookRows({
    projectRows: sheetRows(workbook, 'Project'),
    genesRows: sheetRows(workbook, 'Genes'),
    pathwayRows: sheetRows(workbook, 'Pathways'),
    sampleRows: sheetRows(workbook, 'Samples'),
    labelRows: sheetRows(workbook, 'GeneLabels'),
    customPpiRows: sheetRows(workbook, 'CustomPPI'),
  });
}
