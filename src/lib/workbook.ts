import * as XLSX from 'xlsx';
import {
  findReferencePathway,
  getHuriPpiNeighbors,
  getStringPpiNeighbors,
  getReferenceSummary,
  lookupCanonicalSymbol,
} from '../reference';
import type {
  BuilderSummary,
  EnrichmentCurve,
  EnrichmentPoint,
  GeneRecord,
  PathwayRecord,
  ProjectMeta,
  ValidationIssue,
  ViewerData,
  ViewerEdge,
  ViewerNode,
  ViewerSampleMeta,
  WorkbookParseResult,
} from '../types';
import {
  dedupe,
  hasRequiredColumns,
  normalizeCollectionName,
  normalizeSheetRows,
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
const REQUIRED_GENE_COLUMN_SET = new Set(REQUIRED_GENE_COLUMNS);
const SIGNIFICANCE_THRESHOLD = 0.25;
const MAX_ISSUES = 400;
const HURI_EDGE_SCORE = 850;
const MAX_SAMPLE_VALUES_PER_GENE = 160;

type SheetRow = Record<string, unknown>;

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
  if (!sampleId) {
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
  const merged = { ...existing };
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
      return gene.padj;
    }
    if (Number.isFinite(gene.pvalue)) {
      return gene.pvalue;
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
  rankedGenes: GeneRecord[],
  geneSet: Set<string>,
): EnrichmentCurve {
  if (!rankedGenes.length || !geneSet.size) {
    return { points: [{ index: 0, value: 0 }], hitIndices: [], maxAbsValue: 0 };
  }

  let hitCount = 0;
  let hitWeight = 0;
  const isHitByIndex = new Array<boolean>(rankedGenes.length);
  rankedGenes.forEach((gene, index) => {
    const isHit = geneSet.has(gene.symbol);
    isHitByIndex[index] = isHit;
    if (!isHit) {
      return;
    }
    hitCount += 1;
    hitWeight += Math.abs(gene.rankMetric || 1);
  });

  if (!hitCount) {
    return {
      points: rankedGenes.map((_, index) => ({ index, value: 0 })),
      hitIndices: [],
      maxAbsValue: 0,
    };
  }

  const normalizedHitWeight = hitWeight || 1;
  const missWeight = rankedGenes.length === hitCount ? 0 : 1 / (rankedGenes.length - hitCount);

  let running = 0;
  let maxAbsValue = 0;
  const points: EnrichmentPoint[] = [{ index: 0, value: 0 }];
  const hitIndices: number[] = [];

  rankedGenes.forEach((gene, idx) => {
    if (isHitByIndex[idx]) {
      running += Math.abs(gene.rankMetric || 1) / normalizedHitWeight;
      hitIndices.push(idx + 1);
    } else {
      running -= missWeight;
    }

    maxAbsValue = Math.max(maxAbsValue, Math.abs(running));
    points.push({
      index: idx + 1,
      value: Number(running.toFixed(6)),
      gene: gene.symbol,
      isHit: isHitByIndex[idx],
    });
  });

  return { points, hitIndices, maxAbsValue };
}

function buildEdgeKey(source: string, target: string): string {
  return [source, target].sort().join('::');
}

function buildNetworkEdges(
  genes: string[],
  customPpi: Map<string, ViewerEdge>,
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
    for (const [neighbor, score] of getStringPpiNeighbors(gene)) {
      if (!geneSet.has(neighbor) || gene === neighbor) {
        continue;
      }
      mergeEdge(gene, neighbor, score, { isString: true, isHuRI: false, isCustom: false });
    }
    for (const [neighbor] of getHuriPpiNeighbors(gene)) {
      if (!geneSet.has(neighbor) || gene === neighbor) {
        continue;
      }
      mergeEdge(gene, neighbor, HURI_EDGE_SCORE, { isString: false, isHuRI: true, isCustom: false });
    }
  });

  for (const [, edge] of customPpi) {
    if (geneSet.has(edge.source) && geneSet.has(edge.target)) {
      mergeEdge(edge.source, edge.target, edge.score, { isString: false, isHuRI: false, isCustom: true });
    }
  }

  return Array.from(edges.values()).sort((a, b) => b.score - a.score);
}

function buildViewerNodes(
  genes: string[],
  genesBySymbol: Map<string, GeneRecord>,
  leadingEdge: Set<string>,
): ViewerNode[] {
  return genes
    .map((symbol) => {
      const gene = genesBySymbol.get(symbol);
      if (!gene) {
        return null;
      }

      const significanceValue = Number.isFinite(gene.padj)
        ? gene.padj
        : Number.isFinite(gene.pvalue)
          ? gene.pvalue
          : 1;

      return {
        id: gene.symbol,
        label: gene.label ?? gene.symbol,
        labelPriority: gene.labelPriority ?? 0,
        log2fc: gene.log2fc,
        padj: gene.padj,
        pvalue: gene.pvalue,
        sizeMetric: Math.min(12, -Math.log10(Math.max(significanceValue, 1e-12))),
        conditionAMean: gene.conditionAMean,
        conditionBMean: gene.conditionBMean,
        sampleValues: gene.sampleValues,
        isLeadingEdge: leadingEdge.has(gene.symbol),
      } satisfies ViewerNode;
    })
    .filter((node): node is ViewerNode => Boolean(node))
    .sort((a, b) => b.sizeMetric - a.sizeMetric || b.labelPriority - a.labelPriority);
}

function parseProjectSheet(rows: SheetRow[], issues: ValidationIssue[]): ProjectMeta | null {
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

  return project;
}

export async function parseWorkbookFile(file: File): Promise<WorkbookParseResult> {
  const buffer = await file.arrayBuffer();
  return parseWorkbookBuffer(buffer);
}

export function parseWorkbookBuffer(buffer: ArrayBuffer): WorkbookParseResult {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const issues: ValidationIssue[] = [];
  const summary: BuilderSummary = {
    totalGenes: 0,
    totalPathways: 0,
    significantPathways: 0,
    fallbackPathways: 0,
    unknownGenes: 0,
  };

  const projectRows = normalizeSheetRows(sheetRows(workbook, 'Project'));
  const genesRows = normalizeSheetRows(sheetRows(workbook, 'Genes'));
  const pathwayRows = normalizeSheetRows(sheetRows(workbook, 'Pathways'));
  const sampleRows = normalizeSheetRows(sheetRows(workbook, 'Samples'));
  const labelRows = normalizeSheetRows(sheetRows(workbook, 'GeneLabels'));
  const customPpiRows = normalizeSheetRows(sheetRows(workbook, 'CustomPPI'));
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
  if (!pathwayRows.length) {
    pushIssue(issues, 'error', 'Missing required sheet: Pathways');
  }

  const project = parseProjectSheet(projectRows, issues);
  if (!project) {
    return { viewerData: null, issues, summary };
  }

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

  const genesBySymbol = new Map<string, GeneRecord>();
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
      const unknownKey = normalizeSymbolToken(originalSymbol);
      if (unknownKey && !warnedUnknownGeneSymbols.has(unknownKey)) {
        warnedUnknownGeneSymbols.add(unknownKey);
        pushIssue(issues, 'warning', `Unrecognized gene symbol "${originalSymbol}" skipped.`, `Genes row ${index + 2}`);
      }
      return;
    }

    const sampleValues: Record<string, number> = {};
    let sampleValueCount = 0;
    let truncatedGeneSamples = false;
    for (const [key, value] of Object.entries(row)) {
      if (REQUIRED_GENE_COLUMN_SET.has(key) || value === '') {
        continue;
      }
      const numeric = parseNumber(value);
      if (Number.isFinite(numeric)) {
        upsertSampleMetadata(samplesById, key);
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
      log2fc: parseNumber(row.log2fc),
      padj: parseNumber(row.padj),
      pvalue: parseNumber(row.pvalue),
      rankMetric: parseNumber(row.rank_metric),
      conditionAMean: parseNumber(row.condition_a_mean),
      conditionBMean: parseNumber(row.condition_b_mean),
      sampleValues,
      label: labelEntry?.label,
      labelPriority: labelEntry?.priority,
    };

    if (
      [geneRecord.log2fc, geneRecord.padj, geneRecord.pvalue, geneRecord.rankMetric].some(
        (value) => Number.isNaN(value),
      )
    ) {
      pushIssue(issues, 'warning', `Gene row for ${canonicalSymbol} has non-numeric statistics.`, 'Genes');
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
      if (key === 'gene_symbol' || key === 'sample_group') {
        return;
      }
      const numeric = parseNumber(value);
      if (Number.isFinite(numeric)) {
        upsertSampleMetadata(samplesById, key);
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

  const rankedGenes = Array.from(genesBySymbol.values()).sort(
    (left, right) => right.rankMetric - left.rankMetric || left.symbol.localeCompare(right.symbol),
  );

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
        `Pathway "${pathwayName}" has no genes present in the Genes sheet and was skipped.`,
        'Pathways',
      );
      return;
    }

    const nodes = buildViewerNodes(
      allGenes.length ? allGenes : availableLeadingEdge,
      genesBySymbol,
      new Set(availableLeadingEdge),
    );
    const edges = buildNetworkEdges(
      allGenes.length ? allGenes : availableLeadingEdge,
      customPpi,
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

    const parsedNes = parseNumber(row.nes);
    const parsedPadj = parseNumber(row.padj);
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
    const leftPadj = Number.isFinite(left.padj) ? left.padj : Number.POSITIVE_INFINITY;
    const rightPadj = Number.isFinite(right.padj) ? right.padj : Number.POSITIVE_INFINITY;
    const leftSig = leftPadj <= SIGNIFICANCE_THRESHOLD ? 1 : 0;
    const rightSig = rightPadj <= SIGNIFICANCE_THRESHOLD ? 1 : 0;
    const leftNes = Number.isFinite(left.nes) ? left.nes : Number.NEGATIVE_INFINITY;
    const rightNes = Number.isFinite(right.nes) ? right.nes : Number.NEGATIVE_INFINITY;
    return rightSig - leftSig || rightNes - leftNes || left.pathwayName.localeCompare(right.pathwayName);
  });

  summary.totalGenes = genesBySymbol.size;
  summary.totalPathways = pathways.length;
  let significantPathwayCount = 0;
  let fallbackPathwayCount = 0;
  for (const pathway of pathways) {
    if (Number.isFinite(pathway.padj) && pathway.padj <= SIGNIFICANCE_THRESHOLD) {
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
    pushIssue(issues, 'error', 'No pathways were successfully parsed from the workbook.', 'Pathways');
    return { viewerData: null, issues, summary };
  }

  const viewerData: ViewerData = {
    project,
    builtAt: new Date().toISOString(),
    significantPadjThreshold: SIGNIFICANCE_THRESHOLD,
    referenceSummary: getReferenceSummary(),
    issues,
    pathways,
    samplesById: Object.keys(samplesById).length ? samplesById : undefined,
  };

  return { viewerData, issues, summary };
}
