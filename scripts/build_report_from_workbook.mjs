#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const SIGNIFICANCE_THRESHOLD = 0.25;

const aliases = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/reference/generated/aliases.json'), 'utf8'),
);
const pathways = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/reference/generated/pathways.json'), 'utf8'),
);
const rawAdjacency = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/reference/generated/ppi.json'), 'utf8'),
);
const metadata = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'src/reference/generated/metadata.json'), 'utf8'),
);

const adjacency = Object.fromEntries(
  Object.entries(rawAdjacency).map(([gene, neighbors]) => [
    gene,
    neighbors.map(([neighbor, score]) => [neighbor, Number(score)]),
  ]),
);

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

function normalizeSymbolToken(value) {
  return String(value ?? '')
    .trim()
    .replace(/^["']|["']$/g, '')
    .toUpperCase();
}

function normalizePathwayName(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeCollectionName(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();

  if (normalized.includes('hallmark')) {
    return 'Hallmark';
  }

  if (normalized.includes('reactome')) {
    return 'Reactome';
  }

  return String(value ?? '').trim() || 'Unknown';
}

function parseNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = Number(String(value ?? '').trim());
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function splitGeneList(value) {
  return String(value ?? '')
    .split(/[;,]/g)
    .map((gene) => normalizeSymbolToken(gene))
    .filter(Boolean);
}

function dedupe(values) {
  return Array.from(new Set(values));
}

function hasRequiredColumns(rows, requiredColumns) {
  const headers = new Set(rows.flatMap((row) => Object.keys(row)));
  return requiredColumns.filter((column) => !headers.has(column));
}

function sheetRows(workbook, sheetName) {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    return [];
  }
  return XLSX.utils.sheet_to_json(sheet, {
    defval: '',
    raw: false,
  });
}

function pushIssue(issues, level, message, context) {
  issues.push({ level, message, context });
}

function lookupCanonicalSymbol(symbol) {
  const normalized = normalizeSymbolToken(symbol);
  if (!normalized) {
    return null;
  }
  return aliases[normalized] ?? normalized;
}

function findReferencePathway(collectionRaw, pathwayIdRaw, pathwayNameRaw) {
  const collection = normalizeCollectionName(collectionRaw);
  const pathwayId = String(pathwayIdRaw ?? '').trim();

  if (pathwayId) {
    const exactId = `${collection}::${pathwayId.toUpperCase()}`;
    if (pathways.byId[exactId]) {
      return pathways.byId[exactId];
    }
  }

  const key = `${collection.toLowerCase()}::${normalizePathwayName(pathwayNameRaw)}`;
  const matchedId = pathways.byKey[key];
  return matchedId ? pathways.byId[matchedId] ?? null : null;
}

function buildEdgeKey(source, target) {
  return [source, target].sort().join('::');
}

function buildViewerNodes(genes, genesBySymbol, leadingEdge) {
  return genes
    .map((symbol) => {
      const gene = genesBySymbol.get(symbol);
      if (!gene) {
        return null;
      }

      return {
        id: gene.symbol,
        label: gene.label ?? gene.symbol,
        labelPriority: gene.labelPriority ?? 0,
        log2fc: gene.log2fc,
        padj: gene.padj,
        pvalue: gene.pvalue,
        sizeMetric: Math.min(12, -Math.log10(Math.max(gene.padj || gene.pvalue || 1, 1e-12))),
        conditionAMean: gene.conditionAMean,
        conditionBMean: gene.conditionBMean,
        sampleValues: gene.sampleValues,
        isLeadingEdge: leadingEdge.has(gene.symbol),
      };
    })
    .filter(Boolean)
    .sort((left, right) => right.sizeMetric - left.sizeMetric || right.labelPriority - left.labelPriority);
}

function buildNetworkEdges(genes, customPpi) {
  const geneSet = new Set(genes);
  const edges = new Map();

  genes.forEach((gene) => {
    for (const [neighbor, score] of adjacency[gene] ?? []) {
      if (!geneSet.has(neighbor) || gene === neighbor) {
        continue;
      }

      const key = buildEdgeKey(gene, neighbor);
      const existing = edges.get(key);
      if (!existing || score > existing.score) {
        edges.set(key, { source: gene, target: neighbor, score });
      }
    }
  });

  for (const [key, edge] of customPpi.entries()) {
    if (geneSet.has(edge.source) && geneSet.has(edge.target)) {
      edges.set(key, { ...edge, isCustom: true });
    }
  }

  return Array.from(edges.values()).sort((left, right) => right.score - left.score);
}

function buildEnrichmentCurve(rankedGenes, geneSet) {
  if (!rankedGenes.length || !geneSet.size) {
    return { points: [{ index: 0, value: 0 }], hitIndices: [], maxAbsValue: 0 };
  }

  const hits = rankedGenes.filter((gene) => geneSet.has(gene.symbol));
  if (!hits.length) {
    return {
      points: rankedGenes.map((_, index) => ({ index, value: 0 })),
      hitIndices: [],
      maxAbsValue: 0,
    };
  }

  const hitWeight =
    hits.reduce((sum, gene) => sum + Math.abs(gene.rankMetric || 1), 0) || 1;
  const missWeight = rankedGenes.length === hits.length ? 0 : 1 / (rankedGenes.length - hits.length);

  let running = 0;
  let maxAbsValue = 0;
  const points = [{ index: 0, value: 0 }];
  const hitIndices = [];

  rankedGenes.forEach((gene, idx) => {
    if (geneSet.has(gene.symbol)) {
      running += Math.abs(gene.rankMetric || 1) / hitWeight;
      hitIndices.push(idx + 1);
    } else {
      running -= missWeight;
    }

    maxAbsValue = Math.max(maxAbsValue, Math.abs(running));
    points.push({
      index: idx + 1,
      value: Number(running.toFixed(6)),
      gene: gene.symbol,
      isHit: geneSet.has(gene.symbol),
    });
  });

  return { points, hitIndices, maxAbsValue };
}

function mergeGeneRecord(existing, incoming, issues) {
  if (!existing) {
    return incoming;
  }

  pushIssue(
    issues,
    'warning',
    `Duplicate gene row detected for ${incoming.symbol}; retained the more significant entry.`,
    'Genes',
  );

  const keepExisting = existing.padj <= incoming.padj;
  const winner = keepExisting ? existing : incoming;
  const loser = keepExisting ? incoming : existing;

  return {
    ...winner,
    sampleValues: {
      ...loser.sampleValues,
      ...winner.sampleValues,
    },
    label: winner.label ?? loser.label,
    labelPriority: Math.max(winner.labelPriority ?? 0, loser.labelPriority ?? 0) || undefined,
  };
}

function parseWorkbook(inputPath) {
  const workbook = XLSX.readFile(inputPath);
  const issues = [];
  const summary = {
    totalGenes: 0,
    totalPathways: 0,
    significantPathways: 0,
    fallbackPathways: 0,
    unknownGenes: 0,
  };

  const projectRows = sheetRows(workbook, 'Project');
  const genesRows = sheetRows(workbook, 'Genes');
  const pathwayRows = sheetRows(workbook, 'Pathways');
  const sampleRows = sheetRows(workbook, 'Samples');
  const labelRows = sheetRows(workbook, 'GeneLabels');
  const customPpiRows = sheetRows(workbook, 'CustomPPI');

  if (!projectRows.length) {
    pushIssue(issues, 'error', 'Missing required sheet: Project');
  }
  if (!genesRows.length) {
    pushIssue(issues, 'error', 'Missing required sheet: Genes');
  }
  if (!pathwayRows.length) {
    pushIssue(issues, 'error', 'Missing required sheet: Pathways');
  }

  const projectMissing = hasRequiredColumns(projectRows, REQUIRED_PROJECT_COLUMNS);
  if (projectMissing.length) {
    pushIssue(issues, 'error', `Project sheet is missing columns: ${projectMissing.join(', ')}`, 'Project');
  }

  const projectRow = projectRows.find((row) => Object.values(row).some((value) => String(value).trim()));
  if (!projectRow) {
    pushIssue(issues, 'error', 'Project sheet is empty.', 'Project');
  }

  const project = projectRow
    ? {
        projectTitle: String(projectRow.project_title || 'Pathway Network Viewer Study').trim(),
        contrastName: String(projectRow.contrast_name || 'Condition_B_vs_A').trim(),
        conditionA: String(projectRow.condition_a || 'Condition A').trim(),
        conditionB: String(projectRow.condition_b || 'Condition B').trim(),
        species: String(projectRow.species || 'human').trim().toLowerCase() || 'human',
      }
    : null;

  if (project?.species && project.species !== 'human') {
    pushIssue(
      issues,
      'warning',
      `Species "${project.species}" is not fully supported in v1; the viewer will treat the study as human.`,
      'Project',
    );
    project.species = 'human';
  }

  const missingGeneColumns = hasRequiredColumns(genesRows, REQUIRED_GENE_COLUMNS);
  if (missingGeneColumns.length) {
    pushIssue(issues, 'error', `Genes sheet is missing columns: ${missingGeneColumns.join(', ')}`, 'Genes');
  }

  const missingPathwayColumns = hasRequiredColumns(pathwayRows, REQUIRED_PATHWAY_COLUMNS);
  if (missingPathwayColumns.length) {
    pushIssue(issues, 'error', `Pathways sheet is missing columns: ${missingPathwayColumns.join(', ')}`, 'Pathways');
  }

  if (!project || issues.some((issue) => issue.level === 'error')) {
    return { viewerData: null, issues, summary };
  }

  const labelMap = new Map();
  labelRows.forEach((row) => {
    const canonical = lookupCanonicalSymbol(row.gene_symbol);
    if (!canonical) {
      return;
    }
    labelMap.set(canonical, {
      label: String(row.label || canonical).trim() || canonical,
      priority: parseNumber(row.priority) || 0,
    });
  });

  const genesBySymbol = new Map();
  const unknownGenes = new Set();

  genesRows.forEach((row, index) => {
    const originalSymbol = String(row.gene_symbol || '').trim();
    if (!originalSymbol) {
      return;
    }

    const canonicalSymbol = lookupCanonicalSymbol(originalSymbol);
    if (!canonicalSymbol) {
      unknownGenes.add(originalSymbol);
      pushIssue(issues, 'warning', `Unrecognized gene symbol "${originalSymbol}" skipped.`, `Genes row ${index + 2}`);
      return;
    }

    const sampleValues = Object.fromEntries(
      Object.entries(row)
        .filter(
          ([key, value]) =>
            !REQUIRED_GENE_COLUMNS.includes(key) &&
            key !== 'gene_symbol' &&
            value !== '' &&
            Number.isFinite(parseNumber(value)),
        )
        .map(([key, value]) => [key, parseNumber(value)]),
    );

    const labelEntry = labelMap.get(canonicalSymbol);
    const geneRecord = {
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
      [geneRecord.log2fc, geneRecord.padj, geneRecord.pvalue, geneRecord.rankMetric].some((value) =>
        Number.isNaN(value),
      )
    ) {
      pushIssue(issues, 'warning', `Gene row for ${canonicalSymbol} has non-numeric statistics.`, 'Genes');
    }

    if (canonicalSymbol !== normalizeSymbolToken(originalSymbol)) {
      pushIssue(
        issues,
        'info',
        `Normalized gene symbol "${originalSymbol}" to "${canonicalSymbol}".`,
        'Genes',
      );
    }

    genesBySymbol.set(
      canonicalSymbol,
      mergeGeneRecord(genesBySymbol.get(canonicalSymbol), geneRecord, issues),
    );
  });

  sampleRows.forEach((row) => {
    const canonical = lookupCanonicalSymbol(row.gene_symbol);
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
        gene.sampleValues[key] = numeric;
      }
    });
  });

  const customPpi = new Map();
  customPpiRows.forEach((row, index) => {
    const source = lookupCanonicalSymbol(row.gene_a);
    const target = lookupCanonicalSymbol(row.gene_b);
    const score = parseNumber(row.score);
    if (!source || !target || !Number.isFinite(score) || source === target) {
      pushIssue(issues, 'warning', 'Invalid CustomPPI row ignored.', `CustomPPI row ${index + 2}`);
      return;
    }
    customPpi.set(buildEdgeKey(source, target), { source, target, score, isCustom: true });
  });

  const rankedGenes = Array.from(genesBySymbol.values()).sort(
    (left, right) => right.rankMetric - left.rankMetric || left.symbol.localeCompare(right.symbol),
  );

  const parsedPathways = [];
  pathwayRows.forEach((row, index) => {
    const pathwayName = String(row.pathway_name || '').trim();
    if (!pathwayName) {
      return;
    }

    const collection = normalizeCollectionName(row.collection);
    const pathwayId = String(row.pathway_id || '').trim() || undefined;
    const referencePathway = findReferencePathway(collection, pathwayId, pathwayName);

    const leadingEdgeGenes = dedupe(
      splitGeneList(row.leading_edge_genes).flatMap((gene) => {
        const canonical = lookupCanonicalSymbol(gene);
        if (!canonical) {
          unknownGenes.add(gene);
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
    const allGenes = dedupe([...referenceGenes, ...leadingEdgeGenes]).filter((symbol) =>
      genesBySymbol.has(symbol),
    );
    const availableLeadingEdge = leadingEdgeGenes.filter((symbol) => genesBySymbol.has(symbol));
    const missingGenes = dedupe([...referenceGenes, ...leadingEdgeGenes]).filter(
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

    const visibleGenes = allGenes.length ? allGenes : availableLeadingEdge;
    const nodes = buildViewerNodes(visibleGenes, genesBySymbol, new Set(availableLeadingEdge));
    const edges = buildNetworkEdges(visibleGenes, customPpi);
    const pathwayGeneSet = new Set(referencePathway ? allGenes : availableLeadingEdge);

    parsedPathways.push({
      key: `${collection}::${pathwayId ?? pathwayName}`,
      pathwayId,
      pathwayName,
      collection,
      nes: parseNumber(row.nes),
      padj: parseNumber(row.padj),
      leadingEdgeGenes: availableLeadingEdge,
      allGenes: visibleGenes,
      hasReferenceMembership: Boolean(referencePathway),
      fallbackToLeadingEdge: !referencePathway,
      missingGenes,
      nodes,
      edges,
      enrichment: buildEnrichmentCurve(rankedGenes, pathwayGeneSet),
    });

    if (!referencePathway) {
      pushIssue(
        issues,
        'info',
        `Pathway "${pathwayName}" uses leading-edge genes only because no built-in membership match was found.`,
        'Pathways',
      );
    }
  });

  parsedPathways.sort((left, right) => {
    const leftSig = left.padj <= SIGNIFICANCE_THRESHOLD ? 1 : 0;
    const rightSig = right.padj <= SIGNIFICANCE_THRESHOLD ? 1 : 0;
    return (
      rightSig - leftSig ||
      right.nes - left.nes ||
      left.pathwayName.localeCompare(right.pathwayName)
    );
  });

  summary.totalGenes = genesBySymbol.size;
  summary.totalPathways = parsedPathways.length;
  summary.significantPathways = parsedPathways.filter((pathway) => pathway.padj <= SIGNIFICANCE_THRESHOLD).length;
  summary.fallbackPathways = parsedPathways.filter((pathway) => pathway.fallbackToLeadingEdge).length;
  summary.unknownGenes = unknownGenes.size;

  if (!parsedPathways.length) {
    pushIssue(issues, 'error', 'No pathways were successfully parsed from the workbook.', 'Pathways');
    return { viewerData: null, issues, summary };
  }

  return {
    viewerData: {
      project,
      builtAt: new Date().toISOString(),
      significantPadjThreshold: SIGNIFICANCE_THRESHOLD,
      referenceSummary: metadata,
      issues,
      pathways: parsedPathways,
    },
    issues,
    summary,
  };
}

function safeHtmlScriptPayload(value) {
  return value.replace(/<\/script/gi, '<\\/script');
}

function createReportHtml(viewerData) {
  const styles = fs.readFileSync(path.join(ROOT, 'src/report/styles.css'), 'utf8').replace(/<\/style/gi, '<\\/style');
  const runtime = safeHtmlScriptPayload(fs.readFileSync(path.join(ROOT, 'src/report/runtime.js'), 'utf8'));
  const vendors = [
    'src/vendor/cytoscape.min.js',
    'src/vendor/cytoscape-svg.js',
    'src/vendor/layout-base.js',
    'src/vendor/cose-base.js',
    'src/vendor/cytoscape-fcose.js',
    'src/vendor/elk.bundled.js',
    'src/vendor/cytoscape-elk.js',
    'src/vendor/plotly.min.js',
    'src/vendor/jspdf.umd.min.js',
    'src/vendor/svg2pdf.umd.min.js',
  ]
    .map((relativePath) => safeHtmlScriptPayload(fs.readFileSync(path.join(ROOT, relativePath), 'utf8')))
    .map((source) => `    <script>${source}</script>`)
    .join('\n');
  const title = `${viewerData.project.projectTitle} — Pathway Network Viewer`;
  const serializedData = JSON.stringify(viewerData).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>${styles}</style>
  </head>
  <body>
    <div id="app"></div>
${vendors}
    <script>
      window.cytoscapeSvg && window.cytoscapeSvg(window.cytoscape);
      window.__PNV_DATA__ = ${serializedData};
    </script>
    <script>${runtime}</script>
  </body>
</html>`;
}

function defaultOutputPath(inputPath) {
  const baseName = path.basename(inputPath, path.extname(inputPath));
  return path.join(path.dirname(inputPath), `${baseName}.report.html`);
}

function main() {
  const inputPath = process.argv[2] || path.join(ROOT, 'results/psoriasis_pathway_viewer_input.xlsx');
  const outputPath = process.argv[3] || defaultOutputPath(inputPath);

  if (!fs.existsSync(inputPath)) {
    console.error(`Input workbook not found: ${inputPath}`);
    process.exit(1);
  }

  const parsed = parseWorkbook(inputPath);
  if (!parsed.viewerData || parsed.issues.some((issue) => issue.level === 'error')) {
    console.error(`Failed to parse workbook: ${inputPath}`);
    parsed.issues.forEach((issue) => {
      console.error(`[${issue.level}] ${issue.context ? `${issue.context}: ` : ''}${issue.message}`);
    });
    process.exit(1);
  }

  const html = createReportHtml(parsed.viewerData);
  fs.writeFileSync(outputPath, html, 'utf8');

  const levelCounts = parsed.issues.reduce((accumulator, issue) => {
    accumulator[issue.level] = (accumulator[issue.level] ?? 0) + 1;
    return accumulator;
  }, {});

  console.log(`Wrote report: ${outputPath}`);
  console.log(
    `Summary: ${parsed.summary.totalGenes} genes, ${parsed.summary.totalPathways} pathways, ${parsed.summary.significantPathways} significant pathways`,
  );
  console.log(
    `Issues: errors=${levelCounts.error ?? 0} warnings=${levelCounts.warning ?? 0} info=${levelCounts.info ?? 0}`,
  );
}

main();
