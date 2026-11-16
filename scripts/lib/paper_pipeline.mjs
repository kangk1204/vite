import fs from 'node:fs';

export function parseTsv(text) {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return [];
  }
  const [headerLine, ...lines] = normalized.split(/\r?\n/);
  const headers = headerLine.split('\t');
  return lines
    .filter((line) => line.trim())
    .map((line) => {
      const values = line.split('\t');
      return Object.fromEntries(headers.map((header, index) => [header, values[index] ?? '']));
    });
}

export function readTsvFile(filePath) {
  return parseTsv(fs.readFileSync(filePath, 'utf8'));
}

export function metricTableToObject(rows) {
  return Object.fromEntries(rows.map((row) => [String(row.metric || '').trim(), row.value]));
}

export function normalizePathwayKey(row) {
  const pathwayId = String(row.pathway_id || '').trim();
  if (pathwayId) {
    return pathwayId.toUpperCase();
  }
  return String(row.pathway_name || '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function splitLeadingEdge(value) {
  return Array.from(
    new Set(
      String(value || '')
        .split(/[;,|]/g)
        .map((token) => token.trim().toUpperCase())
        .filter((token) => token && !/^(?:NA|N\/A|NaN|null|undefined)$/i.test(token)),
    ),
  );
}

export function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : Number.NaN;
  if (typeof value !== 'string') return Number.NaN;
  const trimmed = value.trim();
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(trimmed)) return Number.NaN;
  const numeric = Number(trimmed);
  return Number.isFinite(numeric) ? numeric : Number.NaN;
}

function indexPathways(rows) {
  return new Map(rows.map((row) => [normalizePathwayKey(row), { ...row, key: normalizePathwayKey(row) }])
    .filter(([key]) => Boolean(key)));
}

function isSignificant(row, threshold) {
  const padj = toNumber(row.padj);
  return Number.isFinite(padj) && padj >= 0 && padj <= 1 && padj < threshold;
}

function comparePathway(primary, cohort, key) {
  const primaryNes = toNumber(primary.NES ?? primary.nes);
  const cohortNes = toNumber(cohort.NES ?? cohort.nes);
  const directionComparable = Number.isFinite(primaryNes) && Number.isFinite(cohortNes) && primaryNes !== 0 && cohortNes !== 0;
  const sameDirection = directionComparable ? Math.sign(primaryNes) === Math.sign(cohortNes) : null;
  const primaryLeadingEdge = new Set(splitLeadingEdge(primary.leadingEdge ?? primary.leading_edge_genes));
  const cohortLeadingEdge = new Set(splitLeadingEdge(cohort.leadingEdge ?? cohort.leading_edge_genes));
  const intersection = [...primaryLeadingEdge].filter((gene) => cohortLeadingEdge.has(gene));
  const unionSize = new Set([...primaryLeadingEdge, ...cohortLeadingEdge]).size;
  const jaccard = primaryLeadingEdge.size && cohortLeadingEdge.size ? intersection.length / unionSize : null;
  return {
    directionComparable,
    sameDirection,
    jaccard,
    row: {
      comparison_scope: 'conditional_cross_context_overlap',
      pathway_key: key,
      pathway_name: String(cohort.pathway_name || primary.pathway_name || key),
      primary_nes: Number.isFinite(primaryNes) ? primaryNes : null,
      cohort_nes: Number.isFinite(cohortNes) ? cohortNes : null,
      primary_padj: toNumber(primary.padj),
      cohort_padj: toNumber(cohort.padj),
      same_direction: sameDirection === null ? 'not_evaluable' : sameDirection ? 'yes' : 'no',
      leading_edge_jaccard: jaccard === null ? null : Number(jaccard.toFixed(4)),
      shared_leading_edge_genes: intersection.join(';'),
    },
  };
}

/** Legacy function name retained; these are conditional cross-context overlaps, not biological replication estimates. */
export function computeReplicationMetrics(primaryRows, cohortRows, significanceThreshold = 0.05) {
  if (!Number.isFinite(significanceThreshold) || significanceThreshold < 0 || significanceThreshold > 1) {
    throw new Error('Significance threshold must be a finite probability between 0 and 1.');
  }
  const primaryByKey = indexPathways(primaryRows);
  const cohortByKey = indexPathways(cohortRows);
  const primarySignificant = [...primaryByKey.values()].filter((row) => isSignificant(row, significanceThreshold));
  const cohortSignificant = [...cohortByKey.values()].filter((row) => isSignificant(row, significanceThreshold));
  const primarySignificantKeys = new Set(primarySignificant.map((row) => row.key));
  const sharedKeys = cohortSignificant.map((row) => row.key).filter((key) => primarySignificantKeys.has(key));
  const comparisons = sharedKeys.map((key) => comparePathway(primaryByKey.get(key), cohortByKey.get(key), key));
  const directionComparisons = comparisons.filter((item) => item.directionComparable);
  const leadingEdgeComparisons = comparisons.filter((item) => item.jaccard !== null);
  return {
    comparisonScope: 'conditional_cross_context_overlap',
    significantPathwaysPrimary: primarySignificant.length,
    significantPathwaysCohort: cohortSignificant.length,
    sharedSignificantPathways: sharedKeys.length,
    directionComparablePathways: directionComparisons.length,
    leadingEdgeComparablePathways: leadingEdgeComparisons.length,
    directionConsistency: directionComparisons.length
      ? directionComparisons.filter((item) => item.sameDirection).length / directionComparisons.length : null,
    leadingEdgeOverlapScore: leadingEdgeComparisons.length
      ? leadingEdgeComparisons.reduce((sum, item) => sum + item.jaccard, 0) / leadingEdgeComparisons.length : null,
    overlapRows: comparisons.map((item) => item.row),
  };
}

export function toTsv(rows) {
  if (!rows.length) {
    return '';
  }
  const headers = Object.keys(rows[0]);
  const lines = [headers.join('\t')];
  for (const row of rows) {
    lines.push(headers.map((header) => (typeof row[header] === 'number' && !Number.isFinite(row[header]) ? '' : String(row[header] ?? '')).replace(/[\t\r\n]+/g, ' ')).join('\t'));
  }
  return `${lines.join('\n')}\n`;
}

export function countTableRows(filePath) {
  if (!fs.existsSync(filePath)) {
    return 0;
  }
  const rows = parseTsv(fs.readFileSync(filePath, 'utf8'));
  return rows.length;
}
