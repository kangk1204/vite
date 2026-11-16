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

function validateArtifacts(value: unknown): void {
  array(value, 'artifacts').forEach(value => {
    const artifact = record(value, 'artifact');
    text(artifact.role, 'artifact.role'); text(artifact.path, 'artifact.path');
    if (typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256)) throw new Error('Invalid artifact SHA-256.');
    numeric(artifact.sizeBytes, 'artifact.sizeBytes', false, true);
    if (artifact.sizeBytes === null) throw new Error('artifact.sizeBytes is required.');
  });
}

function validateDelivery(value: unknown): void {
  const delivery = record(value, 'deliveryInspection');
  if (delivery.schemaVersion !== 1 || delivery.checker !== 'pnv-delivery-v1' || delivery.scope !== 'supplied-files-and-recorded-fields') throw new Error('Unsupported delivery inspection schema.');
  text(delivery.checkedAt, 'deliveryInspection.checkedAt');
  if (!['supplied-files', 'recorded-only'].includes(String(delivery.verificationMode))) throw new Error('Invalid delivery verificationMode.');
  const request = record(delivery.request, 'delivery request');
  const countFields = ['sampleCountA', 'sampleCountB', 'pathwayHypothesisCount', 'testedSize'];
  const claimFields = ['datasetIdentifier', 'conditionA', 'conditionB', 'designFormula', 'rankMetric', 'lfcMethod', 'adjustment', ...countFields];
  for (const input of [request.claims, delivery.analysisRecord, ...(delivery.submittedAnalysisRecord === undefined ? [] : [delivery.submittedAnalysisRecord])]) {
    const values = record(input, 'delivery claims');
    Object.entries(values).forEach(([key, value]) => {
      if (!claimFields.includes(key)) throw new Error(`Unknown delivery claim field ${key}.`);
      if (countFields.includes(key)) numeric(value, `delivery.${key}`, false, true);
      else text(value, `delivery.${key}`, true);
    });
  }
  text(request.targetPathwayId, 'delivery targetPathwayId', true);
  validateArtifacts(request.artifacts); validateArtifacts(delivery.sources);
  array(request.additionalRecords, 'delivery additionalRecords').forEach(value => {
    const item = record(value, 'additionalRecord'); text(item.name, 'record.name'); text(item.path, 'record.path');
  });
  const result = record(delivery.result, 'delivery result');
  if (!['normal', 'mismatch', 'unverifiable'].includes(String(result.predicted)) || !verificationStatuses.has(String(result.integrityStatus))) throw new Error('Invalid delivery outcome.');
  array(result.checks, 'delivery checks').forEach(value => {
    const check = record(value, 'delivery check'); text(check.id, 'check.id'); text(check.message, 'check.message');
    if (!['pass', 'fail', 'unknown'].includes(String(check.status))) throw new Error('Invalid delivery check status.');
  });
  const checks = result.checks as Array<{status: string}>;
  const expectedOutcome = checks.some(check => check.status === 'fail') ? 'mismatch'
    : result.integrityStatus !== 'verified_against_supplied_artifacts' || checks.some(check => check.status === 'unknown') ? 'unverifiable' : 'normal';
  if (result.predicted !== expectedOutcome) throw new Error('Delivery outcome disagrees with its recorded checks.');
  array(result.files, 'delivery files').forEach(value => {
    const file = record(value, 'delivery file'); text(file.role, 'file.role'); text(file.path, 'file.path');
    for (const field of ['recordedSha256', 'suppliedSha256']) {
      if (field === 'suppliedSha256' && file[field] === null) continue;
      if (typeof file[field] !== 'string' || !/^[a-f0-9]{64}$/i.test(String(file[field]))) throw new Error('Invalid delivery file SHA-256.');
    }
    numeric(file.recordedSize, 'file.recordedSize', false, true); numeric(file.suppliedSize, 'file.suppliedSize', false, true);
    if (file.recordedSize === null || (file.suppliedSha256 === null) !== (file.suppliedSize === null)) throw new Error('Inconsistent delivery file size observation.');
  });
  array(result.documents, 'delivery documents').forEach(value => {
    const item = record(value, 'delivery document'); text(item.name, 'document.name'); text(item.path, 'document.path');
    if (typeof item.available !== 'boolean') throw new Error('Invalid document observation.');
    numeric(item.sizeBytes, 'document.sizeBytes', false, true);
    if (item.available) {
      if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(item.sha256) || item.sizeBytes === null) throw new Error('Supplied document needs SHA-256 and size.');
    } else if (item.sha256 !== null || item.sizeBytes !== null) throw new Error('Unavailable document cannot have measured bytes.');
  });
}

function validateMonteCarloInterval(value: unknown, valid: number, numerator: unknown): void {
  const interval = record(value, 'Monte Carlo interval');
  if (interval.method !== 'wilson' || interval.level !== 0.95) throw new Error('Unsupported Monte Carlo interval method or level.');
  if (interval.denominator !== valid) throw new Error('Monte Carlo interval denominator must equal testable repetitions.');
  for (const key of ['lower', 'upper']) numeric(interval[key], `interval.${key}`, true);
  if (!valid || numerator === null) {
    if (interval.lower !== null || interval.upper !== null) throw new Error('Untestable Monte Carlo intervals must be null.');
    return;
  }
  const proportion = Number(numerator) / valid, z = 1.959963984540054;
  const divisor = 1 + z * z / valid;
  const center = (proportion + z * z / (2 * valid)) / divisor;
  const radius = z * Math.sqrt(proportion * (1 - proportion) / valid + z * z / (4 * valid * valid)) / divisor;
  if (interval.lower === null || interval.upper === null || Math.abs(Number(interval.lower) - Math.max(0, center - radius)) > 1e-6 || Math.abs(Number(interval.upper) - Math.min(1, center + radius)) > 1e-6) throw new Error('Monte Carlo interval disagrees with its recorded numerator and denominator.');
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
  if (analysis.rankingPolicy !== undefined) {
    const ranking = record(analysis.rankingPolicy, 'rankingPolicy');
    if (ranking.id !== 'finite_original_wald_v1') throw new Error('Unsupported ranking policy.');
    text(ranking.description, 'rankingPolicy.description');
    for (const key of ['includedGeneCount', 'excludedNonFiniteCount', 'includedCookOutlierCount', 'includedIndependentFilterCount', 'includedNonconvergedCount']) {
      numeric(ranking[key], `rankingPolicy.${key}`, false, true);
      if (ranking[key] === null) throw new Error('Ranking policy counts are required.');
    }
  }
  if (analysis.cameraOptions !== undefined) {
    const options = record(analysis.cameraOptions, 'cameraOptions');
    text(options.interGeneCorrelation, 'cameraOptions.interGeneCorrelation');
    for (const key of ['allowNegativeCorrelation', 'useRanks', 'trendVar', 'directional', 'sort']) if (typeof options[key] !== 'boolean') throw new Error(`cameraOptions.${key} must be boolean.`);
    for (const key of ['adjustment', 'normalization', 'transformation']) text(options[key], `cameraOptions.${key}`);
  }
  if (evidence.fitDiagnostics !== undefined) {
    const fit = record(evidence.fitDiagnostics, 'fitDiagnostics');
    for (const [key, count] of Object.entries(record(fit.summary, 'fitDiagnostics.summary'))) {
      if (key === 'shrinkEvaluated' && typeof count === 'boolean') continue;
      numeric(count, 'fit diagnostic count', false, true);
    }
    text(fit.interpretation, 'fitDiagnostics.interpretation', true);
    array(fit.warnings, 'fitDiagnostics.warnings').forEach(value => {
      const warning = record(value, 'fit warning');
      for (const key of ['stage', 'type', 'message', 'affectedQuantity', 'geneAttribution']) text(warning[key], `fit warning.${key}`);
      if (warning.affectedGeneIds !== null) array(warning.affectedGeneIds, 'affectedGeneIds').forEach(gene => text(gene, 'affected gene ID'));
    });
  }
  if (evidence.deliveryInspection !== undefined) validateDelivery(evidence.deliveryInspection);
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
      if (camera.nGenes !== undefined) { numeric(camera.nGenes, 'camera.nGenes', false, true); if (camera.nGenes === null) throw new Error('camera.nGenes cannot be null.'); }
      if (camera.correlation !== undefined) {
        numeric(camera.correlation, 'camera.correlation');
        if (camera.correlation !== null && Math.abs(Number(camera.correlation)) > 1) throw new Error('camera.correlation is outside [-1, 1].');
      }
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
      if (bootstrap.selectionInterval !== undefined) validateMonteCarloInterval(bootstrap.selectionInterval, valid, bootstrap.selected);
      if (bootstrap.directionInterval !== undefined) validateMonteCarloInterval(bootstrap.directionInterval, valid, bootstrap.directionMatches);
      if (bootstrap.denominatorReasons !== undefined) {
        const reasons = record(bootstrap.denominatorReasons, 'bootstrap.denominatorReasons');
        const counts = ['fitFailed', 'notEligible', 'nonFiniteStatistic'].map(key => reasons[key]);
        counts.forEach(count => { numeric(count, 'bootstrap.denominatorReasons count', false, true); if (count === null) throw new Error('Missing denominatorReasons count.'); });
        if (counts.reduce<number>((sum, count) => sum + Number(count), 0) !== requested - valid) throw new Error('bootstrap.denominatorReasons do not explain all untestable repetitions.');
      }
      if (bootstrap.interpretation !== undefined && bootstrap.interpretation !== 'conditional_on_testable_resamples') throw new Error('Unsupported bootstrap interpretation.');
      text(bootstrap.uncertaintyScope, 'bootstrap.uncertaintyScope', true);
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
        row.forEach(cell => { if (cell !== null && typeof cell !== 'string' && typeof cell !== 'boolean' && (typeof cell !== 'number' || !Number.isFinite(cell))) throw new Error('Invalid source table cell.'); });
      }
    }
  }
  const clone = JSON.parse(JSON.stringify(evidence)) as ReportEvidence;
  if (clone.deliveryInspection) clone.deliveryInspection = { ...clone.deliveryInspection, verificationMode: 'recorded-only' };
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
