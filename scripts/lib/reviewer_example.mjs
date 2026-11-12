export const EXAMPLE_ID = 'R-HSA-449147';

export function escapeText(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

function numeric(value, name) {
  if (value == null || String(value).trim() === '' || !Number.isFinite(Number(value))) throw new Error(`Missing numeric ${name}`);
  return Number(value);
}

function requireProbability(value, name) {
  const number = numeric(value, name);
  if (number < 0 || number > 1) throw new Error(`Invalid ${name}`);
  return number;
}

function uniqueRow(rows, predicate, table) {
  const matches = rows.map((values, index) => ({ values, row: index + 1 })).filter(item => predicate(item.values));
  if (matches.length !== 1) throw new Error(`Expected exactly one ${EXAMPLE_ID} record in ${table}`);
  return matches[0];
}

function checkTableRow(sourceTables, tableName, source, columns) {
  const table = sourceTables[tableName];
  const cells = table?.rows[source.row - 1];
  if (!cells) throw new Error(`Missing recorded ${tableName} row ${source.row}`);
  for (const column of columns) {
    const index = table.columns.indexOf(column);
    if (index < 0 || String(cells[index]) !== String(source.values[column])) throw new Error(`Recorded ${tableName}.${column} differs at row ${source.row}`);
  }
}

export function extractExample({ primaryRows, cameraRows, evidence }) {
  if (evidence.verification.status !== 'verified_against_supplied_artifacts') throw new Error('The full cohort evidence must have passed supplied-artifact verification');
  const detail = evidence.pathways[EXAMPLE_ID];
  const primary = uniqueRow(primaryRows, row => row.pathway_id === EXAMPLE_ID, 'fgsea');
  const camera = uniqueRow(cameraRows, row => row.pathway.split(' :: ')[0] === EXAMPLE_ID, 'CAMERA');
  if (detail?.source?.table !== 'pathways' || detail.source.row !== primary.row) throw new Error('Pathway source-row mismatch');
  checkTableRow(evidence.sourceTables, 'pathways', primary, ['pathway_id', 'NES', 'padj', 'size']);
  checkTableRow(evidence.sourceTables, 'camera', camera, ['pathway', 'pvalue', 'padj', 'direction']);
  requireProbability(primary.values.padj, 'fgsea adjusted P'); numeric(primary.values.NES, 'NES');
  if (requireProbability(camera.values.padj, 'CAMERA adjusted P') !== detail.camera?.padj ||
      numeric(camera.values.pvalue, 'CAMERA P') !== detail.camera.pvalue || camera.values.direction !== detail.camera.direction) throw new Error('CAMERA TSV and evidence differ');
  if (primaryRows.length !== evidence.analysis.pathwayHypothesisCount) throw new Error('Primary table and tested pathway count differ');
  const b = detail.bootstrap;
  if (!b || ![b.requested, b.valid, b.selected, b.directionMatches].every(Number.isInteger) || b.valid <= 0 || b.valid > b.requested ||
      b.selected < 0 || b.selected > b.valid || b.directionMatches < 0 || b.directionMatches > b.valid ||
      Math.abs(b.selectionFrequency - b.selected / b.valid) > 1e-8 || Math.abs(b.directionConsistency - b.directionMatches / b.valid) > 1e-8) throw new Error('Invalid bootstrap denominators or frequencies');
  return { id: EXAMPLE_ID, name: primary.values.pathway_name, primary, camera, bootstrap: { ...b }, analysis: evidence.analysis, runId: evidence.runId };
}

export function compactViewer(viewer, id = EXAMPLE_ID) {
  const pathway = viewer.pathways.find(record => record.pathwayId === id);
  if (!pathway || !viewer.evidence.pathways[id]) throw new Error(`Missing displayed pathway ${id}`);
  const edges = pathway.edgeIndices ? pathway.edgeIndices.map(index => viewer.sharedEdges[index]) : pathway.edges;
  if (edges.some(edge => !edge)) throw new Error('Missing shared edge in pathway example');
  const genes = new Set(pathway.nodes.map(node => node.id));
  const tables = viewer.evidence.sourceTables || {};
  const detail = viewer.evidence.pathways[id];
  const tableNames = new Set(['genes', 'pathways', 'camera', detail.source?.table, ...(detail.designSensitivity || []).map(test => test.source?.table)]);
  return {
    ...viewer,
    project: { ...viewer.project, projectTitle: `${viewer.project.projectTitle} (one-pathway example)` },
    provenance: { ...viewer.provenance, notes: `This excerpt displays ${pathway.pathwayName || id}. The enrichment curve uses the full original gene ranks and the adjusted P-values use the full tested pathway family.` },
    pathways: [{ ...pathway, edges: [], edgeIndices: edges.map((_, index) => index) }],
    sharedEdges: edges,
    sampleValuesByGene: Object.fromEntries(Object.entries(viewer.sampleValuesByGene || {}).filter(([gene]) => genes.has(gene))),
    evidence: { runId: viewer.evidence.runId, analysis: viewer.evidence.analysis,
      rankedGenes: viewer.evidence.rankedGenes || viewer.rankedGenes,
      rankedGenesSha256: viewer.evidence.rankedGenesSha256,
      referenceMatching: viewer.evidence.referenceMatching,
      verification: { status: 'internally_consistent', checks: [{ id: 'reviewer-excerpt', status: 'pass', message: 'The displayed pathway and its source rows were checked against the finalized cohort export.' }],
        limitations: ['This one-pathway excerpt records internal consistency. The complete cohort report contains the original supplied-artifact checks.'] },
      artifacts: [], pathways: { [id]: detail }, sourceTables: Object.fromEntries(Object.entries(tables).filter(([name]) => tableNames.has(name))),
    },
  };
}

export function renderSourceRows(values) {
  return `<dl class="record">${Object.entries(values).map(([key, value]) => `<div><dt>${escapeText(key)}</dt><dd>${escapeText(value === '' || value == null ? '—' : value)}</dd></div>`).join('')}</dl>`;
}

export function checkFigureExample(rows, example) {
  const row = uniqueRow(rows, record => record.pathway_id === example.id, 'Figure 1B').values;
  const expected = { original_fdr: example.primary.values.padj, primary_nes: example.primary.values.NES,
    source_row: example.primary.row, camera_row: example.camera.row, camera_fdr: example.camera.values.padj,
    selected: example.bootstrap.selected, valid: example.bootstrap.valid, requested: example.bootstrap.requested,
    direction_matches: example.bootstrap.directionMatches, selection_frequency: example.bootstrap.selectionFrequency };
  for (const [key, value] of Object.entries(expected)) {
    const actual = numeric(row[key], `Figure 1B ${key}`), reference = Number(value);
    if (Math.abs(actual - reference) > Math.abs(reference) * 1e-9) throw new Error(`Figure 1B ${key} differs from the review example`);
  }
  if (row.camera_direction !== example.camera.values.direction) throw new Error('Figure 1B CAMERA direction differs from the source row');
}
