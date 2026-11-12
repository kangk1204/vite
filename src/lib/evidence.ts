import type { ReportEvidence, ViewerData } from '../types';
import { applyTestedMembership } from './evidenceMembership';

const forbiddenKeys = new Set(['__proto__', 'prototype', 'constructor']);
const verificationStatuses = new Set(['verified_against_supplied_artifacts', 'internally_consistent', 'unverifiable', 'mismatch']);

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (forbiddenKeys.has(key)) throw new Error(`${label} contains an unsafe key.`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, nullable = false): void {
  if (nullable && (value === null || value === undefined)) return;
  if (typeof value !== 'string') throw new Error(`${label} must be text.`);
}

function numeric(value: unknown, label: string, probability = false, integer = false): void {
  if (value === null) return;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} must be a finite number or null.`);
  if (probability && (value < 0 || value > 1)) throw new Error(`${label} must be between 0 and 1.`);
  if (integer && (!Number.isInteger(value) || value < 0)) throw new Error(`${label} must be a nonnegative integer.`);
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array.`);
  return value;
}

function validateSource(value: unknown): void {
  const source = record(value, 'source');
  text(source.table, 'source.table');
  numeric(source.row, 'source.row', false, true);
  if (source.row === null || Number(source.row) < 1) throw new Error('source.row must be a positive data-row number.');
}

function validateEdge(value: unknown): void {
  const edge = record(value, 'edge'); text(edge.source, 'edge.source'); text(edge.target, 'edge.target');
  numeric(edge.score, 'edge.score');
  if (edge.score === null || Number(edge.score) < 0) throw new Error('edge.score must be nonnegative.');
}

export function createUnverifiedEvidence(viewerData: Pick<ViewerData, 'project'>): ReportEvidence {
  return {
    runId: null,
    analysis: {
      method: 'external', versions: {},
      contrast: { conditionA: viewerData.project.conditionA, conditionB: viewerData.project.conditionB },
      designFormula: null, seed: null, alpha: null, geneHypothesisCount: null,
      pathwayHypothesisCount: null, filterRule: null, rankMetric: null, lfcMethod: null, adjustment: null,
    },
    verification: { status: 'unverifiable', checks: [], limitations: ['Original analysis method and source artifacts were not supplied.'] },
    artifacts: [], pathways: {},
  };
}

export function parseEvidenceSidecar(input: unknown): ReportEvidence {
  const envelope = record(input, 'Evidence sidecar');
  if (envelope.schemaVersion !== 2) throw new Error('Evidence sidecar schemaVersion must be 2.');
  const evidence = record(envelope.evidence, 'evidence');
  const analysis = record(evidence.analysis, 'analysis');
  text(evidence.runId, 'runId', true);
  text(analysis.method, 'analysis.method');
  const versions = record(analysis.versions, 'analysis.versions');
  Object.values(versions).forEach(value => text(value, 'analysis.versions entry'));
  const contrast = record(analysis.contrast, 'analysis.contrast');
  text(contrast.conditionA, 'analysis.contrast.conditionA');
  text(contrast.conditionB, 'analysis.contrast.conditionB');
  for (const field of ['designFormula', 'filterRule', 'rankMetric', 'lfcMethod', 'adjustment']) text(analysis[field], `analysis.${field}`, true);
  for (const field of ['seed', 'geneHypothesisCount', 'pathwayHypothesisCount']) numeric(analysis[field], `analysis.${field}`, false, true);
  numeric(analysis.alpha, 'analysis.alpha', true);
  const verification = record(evidence.verification, 'verification');
  if (!verificationStatuses.has(String(verification.status))) throw new Error('Unknown verification status.');
  array(verification.checks, 'verification.checks').forEach(value => {
    const check = record(value, 'verification.check');
    text(check.id, 'check.id'); text(check.message, 'check.message');
    if (!['pass', 'fail', 'unknown'].includes(String(check.status))) throw new Error('Invalid verification check status.');
  });
  array(verification.limitations, 'verification.limitations').forEach(value => text(value, 'verification limitation'));
  array(evidence.artifacts, 'artifacts').forEach(value => {
    const artifact = record(value, 'artifact');
    text(artifact.role, 'artifact.role'); text(artifact.path, 'artifact.path');
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error('artifact.sha256 must be a SHA-256 digest.');
    numeric(artifact.sizeBytes, 'artifact.sizeBytes', false, true);
    if (artifact.sizeBytes === null) throw new Error('artifact.sizeBytes is required.');
  });
  const pathways = record(evidence.pathways, 'evidence.pathways');
  if (evidence.rankedGenes !== undefined) {
    const ids = new Set();
    array(evidence.rankedGenes, 'evidence.rankedGenes').forEach(value => {
      const entry = record(value, 'original ranked gene');
      text(entry.gene, 'original ranked gene ID'); numeric(entry.metric, 'original rank metric');
      if (!entry.gene || entry.metric === null || ids.has(entry.gene)) throw new Error('Original ranked genes require unique exact IDs and finite statistics.');
      ids.add(entry.gene);
    });
  }
  for (const value of Object.values(pathways)) {
    const pathway = record(value, 'pathway evidence');
    if (pathway.testedGenes !== undefined || pathway.testedSize !== undefined || pathway.originalEs !== undefined) {
      const genes = array(pathway.testedGenes, 'testedGenes');
      genes.forEach(gene => { text(gene, 'tested gene ID'); if (!gene) throw new Error('Tested gene IDs cannot be empty.'); });
      numeric(pathway.testedSize, 'testedSize', false, true); numeric(pathway.originalEs, 'originalEs');
      if (pathway.testedSize !== genes.length || new Set(genes).size !== genes.length) throw new Error('Tested size must equal the number of unique exact gene IDs.');
      if (pathway.originalEs !== null && Math.abs(Number(pathway.originalEs)) > 1 + 1e-8) throw new Error('Recorded ES is outside [-1, 1].');
    }
    if (pathway.camera !== undefined) {
      const camera = record(pathway.camera, 'camera');
      numeric(camera.pvalue, 'camera.pvalue', true); numeric(camera.padj, 'camera.padj', true);
      text(camera.direction, 'camera.direction', true);
    }
    if (pathway.source !== undefined) validateSource(pathway.source);
    if (pathway.designSensitivity !== undefined) {
      array(pathway.designSensitivity, 'designSensitivity').forEach(value => {
        const design = record(value, 'designSensitivity entry');
        text(design.designFormula, 'designSensitivity.designFormula');
        numeric(design.nes, 'designSensitivity.nes'); numeric(design.padj, 'designSensitivity.padj', true);
        if (design.source !== undefined) validateSource(design.source);
      });
    }
    if (pathway.bootstrap !== undefined) {
      const bootstrap = record(pathway.bootstrap, 'bootstrap');
      for (const field of ['requested', 'valid', 'selected']) {
        numeric(bootstrap[field], `bootstrap.${field}`, false, true);
        if (bootstrap[field] === null) throw new Error(`bootstrap.${field} is required.`);
      }
      numeric(bootstrap.directionMatches, 'bootstrap.directionMatches', false, true);
      for (const field of ['selectionFrequency', 'directionConsistency', 'validFraction']) numeric(bootstrap[field], `bootstrap.${field}`, true);
      const requested = Number(bootstrap.requested), valid = Number(bootstrap.valid);
      if (valid > requested) throw new Error('bootstrap.valid exceeds requested repetitions.');
      for (const field of ['selected', 'directionMatches']) if (Number(bootstrap[field]) > valid) throw new Error(`bootstrap.${field} exceeds valid repetitions.`);
      for (const [field, numerator, denominator] of [['selectionFrequency', bootstrap.selected, valid], ['directionConsistency', bootstrap.directionMatches, valid], ['validFraction', valid, requested]] as const) {
        const expected = numerator === null ? null : denominator ? Number(numerator) / denominator : field === 'validFraction' ? 0 : null;
        if (expected === null ? bootstrap[field] !== null : typeof bootstrap[field] !== 'number' || Math.abs(Number(bootstrap[field]) - expected) > 1e-6) throw new Error(`bootstrap.${field} does not match its recorded denominator.`);
      }
      text(bootstrap.warning, 'bootstrap.warning', true);
    }
  }
  if (evidence.sourceTables !== undefined) {
    const tables = record(evidence.sourceTables, 'sourceTables');
    for (const value of Object.values(tables)) {
      const table = record(value, 'source table');
      const columns = array(table.columns, 'source table columns');
      columns.forEach(value => text(value, 'source column'));
      for (const value of array(table.rows, 'source table rows')) {
        const row = array(value, 'source row');
        if (row.length !== columns.length) throw new Error('Source table row width differs from columns.');
        row.forEach(cell => { if (cell !== null && typeof cell !== 'string' && (typeof cell !== 'number' || !Number.isFinite(cell))) throw new Error('Invalid source table cell.'); });
      }
    }
  }
  const clone = JSON.parse(JSON.stringify(evidence)) as ReportEvidence;
  if (clone.verification.status === 'verified_against_supplied_artifacts') {
    clone.verification = {
      ...clone.verification, status: 'unverifiable',
      limitations: [...clone.verification.limitations, 'Source artifacts have not been rechecked during this import.'],
    };
  }
  if (clone.verification.checks.some(check => check.status === 'fail')) clone.verification.status = 'mismatch';
  return clone;
}

export function adaptViewerData(viewerData: ViewerData): ViewerData {
  return {
    ...viewerData, schemaVersion: 2, reportCondition: viewerData.reportCondition ?? 'full',
    evidence: viewerData.evidence ?? createUnverifiedEvidence(viewerData),
    pathways: viewerData.pathways.map(pathway => ({
      ...pathway,
      nes: Number.isFinite(pathway.nes) ? pathway.nes : null,
      padj: Number.isFinite(pathway.padj) ? pathway.padj : null,
      nodes: pathway.nodes.map(node => ({
        ...node,
        ...Object.fromEntries(['log2fc', 'padj', 'pvalue', 'conditionAMean', 'conditionBMean'].map(field => [field, Number.isFinite(node[field as keyof typeof node]) ? node[field as keyof typeof node] : null])),
      })),
    })),
  };
}

export function parseViewerDataJson(input: unknown): ViewerData {
  const viewer = record(input, 'Viewer data');
  if (viewer.schemaVersion !== undefined && viewer.schemaVersion !== 1 && viewer.schemaVersion !== 2) throw new Error('Unsupported viewer schema version.');
  const project = record(viewer.project, 'project');
  for (const key of ['projectTitle', 'contrastName', 'conditionA', 'conditionB', 'species']) text(project[key], `project.${key}`);
  text(viewer.builtAt, 'builtAt'); numeric(viewer.significantPadjThreshold, 'significantPadjThreshold', true);
  const reference = record(viewer.referenceSummary, 'referenceSummary');
  for (const field of ['reactomePathways', 'hallmarkPathways', 'ppiGenes', 'ppiEdges', 'stringScoreCutoff']) {
    numeric(reference[field], `referenceSummary.${field}`, false, true);
    if (reference[field] === null) throw new Error(`referenceSummary.${field} is required.`);
  }
  text(reference.hallmarkMode, 'referenceSummary.hallmarkMode');
  if (viewer.significantPadjThreshold === null) throw new Error('significantPadjThreshold is required.');
  array(viewer.issues, 'issues').forEach(value => {
    const issue = record(value, 'issue');
    if (!['error', 'warning', 'info'].includes(String(issue.level))) throw new Error('Invalid issue level.');
    text(issue.message, 'issue.message'); text(issue.context, 'issue.context', true);
  });
  if (viewer.provenance !== undefined) Object.values(record(viewer.provenance, 'provenance')).forEach(value => text(value, 'provenance value'));
  if (viewer.samplesById !== undefined) {
    for (const value of Object.values(record(viewer.samplesById, 'samplesById'))) {
      const sample = record(value, 'sample'); text(sample.id, 'sample.id');
      for (const field of ['label', 'groupLabel', 'batch']) text(sample[field], `sample.${field}`, true);
      if (sample.groupKey !== undefined && !['A', 'B', 'U'].includes(String(sample.groupKey))) throw new Error('Invalid sample groupKey.');
    }
  }
  const seenKeys = new Set();
  if (viewer.sharedEdges !== undefined) array(viewer.sharedEdges, 'sharedEdges').forEach(validateEdge);
  if (viewer.rankedGenes !== undefined) {
    const genes = new Set();
    array(viewer.rankedGenes, 'rankedGenes').forEach(value => {
      const entry = record(value, 'ranked gene'); text(entry.gene, 'ranked gene ID'); numeric(entry.metric, 'rank metric');
      if (entry.metric === null || genes.has(entry.gene)) throw new Error('Ranked genes require unique IDs and finite metrics.');
      genes.add(entry.gene);
    });
  }
  if (viewer.sampleValuesByGene !== undefined) {
    for (const value of Object.values(record(viewer.sampleValuesByGene, 'sampleValuesByGene'))) {
      for (const sample of Object.values(record(value, 'shared sample values'))) {
        numeric(sample, 'shared sample value');
        if (sample === null) throw new Error('Shared sample values must be finite.');
      }
    }
  }
  if (viewer.reportCondition !== undefined && !['full', 'basic'].includes(String(viewer.reportCondition))) throw new Error('Invalid report condition.');
  for (const value of array(viewer.pathways, 'pathways')) {
    const pathway = record(value, 'pathway');
    for (const field of ['key', 'pathwayName', 'collection']) text(pathway[field], `pathway.${field}`);
    if (seenKeys.has(pathway.key)) throw new Error('Duplicate pathway key.');
    seenKeys.add(pathway.key);
    for (const field of ['hasReferenceMembership', 'fallbackToLeadingEdge']) if (typeof pathway[field] !== 'boolean') throw new Error(`pathway.${field} must be boolean.`);
    text(pathway.pathwayId, 'pathway.pathwayId', true); text(pathway.statisticsReason, 'pathway.statisticsReason', true);
    if (pathway.source !== undefined) validateSource(pathway.source);
    numeric(pathway.nes, 'pathway.nes'); numeric(pathway.padj, 'pathway.padj', true);
    for (const field of ['leadingEdgeGenes', 'allGenes', 'missingGenes']) array(pathway[field], `pathway.${field}`).forEach(value => text(value, field));
    array(pathway.edges, 'pathway.edges').forEach(validateEdge);
    if (pathway.edgeIndices !== undefined) {
      const shared = array(viewer.sharedEdges, 'sharedEdges');
      array(pathway.edgeIndices, 'edgeIndices').forEach(index => {
        numeric(index, 'edge index', false, true);
        if (index === null || Number(index) >= shared.length) throw new Error('Edge index is outside the shared edge table.');
      });
    }
    const enrichment = record(pathway.enrichment, 'pathway.enrichment');
    if (enrichment.representation !== undefined && enrichment.representation !== 'ranked-hits-v1') throw new Error('Unknown enrichment representation.');
    if (enrichment.representation === 'ranked-hits-v1' && !Array.isArray(viewer.rankedGenes)) throw new Error('Compact enrichment requires the shared ranked-gene universe.');
    text(enrichment.unavailableReason, 'enrichment.unavailableReason', true);
    numeric(enrichment.maxAbsValue, 'enrichment.maxAbsValue');
    if (enrichment.maxAbsValue === null || Number(enrichment.maxAbsValue) < 0) throw new Error('enrichment.maxAbsValue must be nonnegative.');
    array(enrichment.points, 'enrichment.points').forEach(value => {
      const point = record(value, 'enrichment point'); numeric(point.index, 'point.index', false, true); numeric(point.value, 'point.value');
      if (point.index === null || point.value === null) throw new Error('Enrichment points must be finite.');
      text(point.gene, 'point.gene', true);
    });
    array(enrichment.hitIndices, 'enrichment.hitIndices').forEach(value => {
      numeric(value, 'hit index', false, true);
      if (value === null) throw new Error('Hit index must be finite.');
      if (enrichment.representation === 'ranked-hits-v1' && (Number(value) < 1 || Number(value) > (viewer.rankedGenes as unknown[]).length)) throw new Error('Compact enrichment hit is outside the ranked universe.');
    });
    for (const value of array(pathway.nodes, 'pathway.nodes')) {
      const node = record(value, 'node');
      text(node.id, 'node.id'); text(node.label, 'node.label');
      text(node.originalId, 'node.originalId', true);
      for (const field of ['labelPriority', 'sizeMetric']) { numeric(node[field], `node.${field}`); if (node[field] === null) throw new Error(`node.${field} is required.`); }
      if (typeof node.isLeadingEdge !== 'boolean') throw new Error('node.isLeadingEdge must be boolean.');
      text(node.statisticsReason, 'node.statisticsReason', true);
      for (const field of ['log2fc', 'conditionAMean', 'conditionBMean']) numeric(node[field], `node.${field}`);
      for (const field of ['padj', 'pvalue']) numeric(node[field], `node.${field}`, true);
      const samples = record(node.sampleValues, 'node.sampleValues');
      Object.values(samples).forEach(value => { numeric(value, 'sample value'); if (value === null) throw new Error('Sample values must be finite.'); });
    }
  }
  const clone = JSON.parse(JSON.stringify(viewer)) as ViewerData;
  if (viewer.schemaVersion === 2 || viewer.evidence !== undefined) clone.evidence = parseEvidenceSidecar({ schemaVersion: 2, evidence: viewer.evidence });
  if (clone.evidence && (clone.evidence.analysis.contrast.conditionA !== clone.project.conditionA || clone.evidence.analysis.contrast.conditionB !== clone.project.conditionB)) {
    clone.evidence.verification = { ...clone.evidence.verification, status: 'mismatch', checks: [...clone.evidence.verification.checks, { id: 'contrast', status: 'fail', message: 'Evidence contrast differs from the displayed project contrast.' }] };
  }
  return applyTestedMembership(adaptViewerData(clone));
}
