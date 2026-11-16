import fs from 'node:fs';
import path from 'node:path';
import { describeArtifact, resolveArtifactPath, verifyArtifacts } from './provenance.mjs';

export const DELIVERY_CLAIMS = Object.freeze([
  'datasetIdentifier', 'conditionA', 'conditionB', 'designFormula',
  'sampleCountA', 'sampleCountB', 'rankMetric', 'lfcMethod', 'adjustment',
  'pathwayHypothesisCount', 'testedSize',
]);
const countFields = new Set(['sampleCountA', 'sampleCountB', 'pathwayHypothesisCount', 'testedSize']);
const prohibited = new Set(['__proto__', 'constructor', 'prototype']);

function object(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (prohibited.has(key) || (allowed && !allowed.includes(key))) throw new Error(`${label} contains an unsupported field ${key}.`);
  }
  return value;
}

function nonempty(value, label) {
  if (typeof value !== 'string' || !value.trim() || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${label} must be nonempty text without control characters.`);
  return value;
}

function relativePath(value, root) {
  nonempty(value, 'Delivery path');
  if (path.isAbsolute(value) || /^[a-z][a-z\d+.-]*:/i.test(value) || /[\\?#]/.test(value)) throw new Error('Delivery files require relative paths under the selected root.');
  resolveArtifactPath(value, { root });
  return value;
}

function scalar(field, value) {
  if (value === undefined || value === null) return null;
  if (countFields.has(field)) {
    const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    if (!Number.isSafeInteger(numeric) || numeric < 0) throw new Error(`${field} must be a nonnegative integer or null.`);
    return numeric;
  }
  return nonempty(value, field);
}

export function validateAnalysisRecord(value) {
  const input = object(value, 'Analysis record', DELIVERY_CLAIMS);
  return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, scalar(key, value)]));
}

export function validateDeliveryRequest(value, root) {
  const request = object(value, 'Delivery request', ['schemaVersion', 'claims', 'artifacts', 'additionalRecords', 'targetPathwayId']);
  if (request.schemaVersion !== undefined && request.schemaVersion !== 1) throw new Error('Unsupported delivery request schema version.');
  const claims = validateAnalysisRecord(object(request.claims, 'Delivery claims', DELIVERY_CLAIMS));
  if (!Array.isArray(request.artifacts)) throw new Error('Delivery artifacts must be an array.');
  const identities = new Set();
  const artifacts = request.artifacts.map(value => {
    const artifact = object(value, 'Delivery artifact', ['role', 'path', 'sha256', 'sizeBytes']);
    const role = nonempty(artifact.role, 'Artifact role');
    const file = relativePath(artifact.path, root);
    if (!/^[a-f0-9]{64}$/i.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) throw new Error('Artifact requires a SHA-256 digest and nonnegative byte size.');
    const identity = `${role}\0${file}`;
    if (identities.has(identity)) throw new Error('Duplicate delivery artifact role/path.');
    identities.add(identity);
    return { role, path: file, sha256: artifact.sha256.toLowerCase(), sizeBytes: artifact.sizeBytes };
  });
  const inputRecords = request.additionalRecords ?? [];
  if (!Array.isArray(inputRecords)) throw new Error('Additional records must be an array.');
  const documentNames = new Set();
  const additionalRecords = inputRecords.map(value => {
    const record = object(value, 'Additional record', ['name', 'path']);
    const name = nonempty(record.name, 'Record name');
    if (documentNames.has(name)) throw new Error('Duplicate additional record name.');
    documentNames.add(name);
    return { name, path: relativePath(record.path, root) };
  });
  return { schemaVersion: 1, claims, artifacts, additionalRecords,
    ...(request.targetPathwayId !== undefined ? { targetPathwayId: nonempty(request.targetPathwayId, 'Target pathway ID') } : {}) };
}

function measureFile(role, file, root) {
  const filename = resolveArtifactPath(file, { root });
  if (!fs.existsSync(filename) || !fs.statSync(filename).isFile()) return null;
  return describeArtifact(role, file, { root });
}

function diagnosis(integrityStatus, checks) {
  if (checks.some(check => check.status === 'fail')) return 'mismatch';
  if (integrityStatus !== 'verified_against_supplied_artifacts' || checks.some(check => check.status === 'unknown')) return 'unverifiable';
  return 'normal';
}

/** Read supplied artifacts and compare their recorded fields. The API accepts no case recipe or expert label. */
export function inspectDelivery(requestValue, observedValue, rootOrOptions) {
  const root = path.resolve(typeof rootOrOptions === 'string' ? rootOrOptions : rootOrOptions?.root || '.');
  const request = validateDeliveryRequest(requestValue, root);
  const observed = validateAnalysisRecord(observedValue);
  const integrity = verifyArtifacts(request.artifacts, { root, includeObservations: true });
  const files = request.artifacts.map((artifact, index) => {
    const measured = integrity.observations[index];
    return { role: artifact.role, path: artifact.path, recordedSha256: artifact.sha256,
      recordedSize: artifact.sizeBytes, suppliedSha256: measured?.sha256 ?? null, suppliedSize: measured?.sizeBytes ?? null };
  });
  const fieldChecks = Object.entries(request.claims).map(([key, requested]) => {
    const value = observed[key];
    return { id: `claim:${key}`, status: value == null || requested == null ? 'unknown' : value === requested ? 'pass' : 'fail',
      message: `${key}. Requested ${String(requested)}. Analysis record ${String(value ?? 'unavailable')}.` };
  });
  const documents = request.additionalRecords.map(record => {
    const measured = measureFile('document', record.path, root);
    return { ...record, available: Boolean(measured && measured.sizeBytes > 0), sha256: measured?.sha256 ?? null, sizeBytes: measured?.sizeBytes ?? null };
  });
  const documentChecks = documents.map(record => ({ id: `record:${record.name}`, status: record.available ? 'pass' : 'unknown',
    message: `${record.name} ${record.available ? 'was supplied' : 'was not supplied'}.` }));
  const checks = [...integrity.checks, ...fieldChecks, ...documentChecks];
  return { predicted: diagnosis(integrity.status, checks), checks, files, documents, integrityStatus: integrity.status };
}

export function createDeliveryInspection(requestValue, recordValue, options) {
  const root = path.resolve(options.root);
  const request = validateDeliveryRequest(requestValue, root);
  const analysisRecord = validateAnalysisRecord(recordValue);
  const checkedAt = options.checkedAt || new Date().toISOString();
  if (!Number.isFinite(Date.parse(checkedAt))) throw new Error('Inspection time must be an ISO date/time.');
  const sources = (options.sources || []).map(source => {
    object(source, 'Inspection source', ['role', 'path', 'sha256', 'sizeBytes']);
    if (!/^[a-f0-9]{64}$/i.test(source.sha256) || !Number.isSafeInteger(source.sizeBytes) || source.sizeBytes < 0) throw new Error('Invalid inspection source digest.');
    return { role: nonempty(source.role, 'Source role'), path: nonempty(source.path, 'Source path'), sha256: source.sha256.toLowerCase(), sizeBytes: source.sizeBytes };
  });
  return { schemaVersion: 1, checker: 'pnv-delivery-v1', checkedAt,
    scope: 'supplied-files-and-recorded-fields', verificationMode: 'supplied-files',
    request, analysisRecord, result: inspectDelivery(request, analysisRecord, root), sources };
}

export function analysisRecordFromViewer(viewer, request = {}) {
  const analysis = viewer.evidence?.analysis || {};
  const tables = viewer.evidence?.sourceTables || {};
  const table = [tables.metadata, tables.samples, tables.Samples].find(value => value?.columns?.includes('group') && (value.columns.includes('sample') || value.columns.includes('sample_id')));
  let samples;
  if (table) {
    const idColumn = table.columns.indexOf(table.columns.includes('sample') ? 'sample' : 'sample_id');
    const groupColumn = table.columns.indexOf('group');
    samples = table.rows.map(row => ({ id: row[idColumn], groupKey: row[groupColumn] }));
    if (new Set(samples.map(sample => sample.id)).size !== samples.length || samples.some(sample => typeof sample.id !== 'string' || !sample.id)) samples = [];
  } else {
    samples = Object.values(viewer.samplesById || {});
  }
  const groupsKnown = samples.length > 0 && samples.every(sample => ['A', 'B', 'U'].includes(sample.groupKey));
  const selected = request.targetPathwayId ? viewer.evidence?.pathways?.[request.targetPathwayId] : null;
  return validateAnalysisRecord({
    datasetIdentifier: viewer.provenance?.datasetIdentifier ?? null,
    conditionA: analysis.contrast?.conditionA ?? viewer.project?.conditionA ?? null,
    conditionB: analysis.contrast?.conditionB ?? viewer.project?.conditionB ?? null,
    designFormula: analysis.designFormula ?? null,
    sampleCountA: groupsKnown ? samples.filter(sample => sample.groupKey === 'A').length : null,
    sampleCountB: groupsKnown ? samples.filter(sample => sample.groupKey === 'B').length : null,
    rankMetric: analysis.rankMetric ?? null, lfcMethod: analysis.lfcMethod ?? null,
    adjustment: analysis.adjustment ?? null, pathwayHypothesisCount: analysis.pathwayHypothesisCount ?? null,
    testedSize: selected?.testedSize ?? null,
  });
}

function recordFromDocument(document, request) {
  if (document?.schemaVersion === 2 && document.project && Array.isArray(document.pathways)) return analysisRecordFromViewer(document, request);
  object(document, 'Analysis record document', ['schemaVersion', 'analysisRecord', 'runId', 'rows', 'sourceSha256']);
  if (document.schemaVersion !== 1) throw new Error('Analysis record requires schemaVersion 1 or a schema-v2 viewer.');
  return validateAnalysisRecord(document.analysisRecord);
}

function sourceFile(role, filename) {
  const actual = fs.realpathSync(path.resolve(filename));
  return describeArtifact(role, path.basename(actual), { root: path.dirname(actual) });
}

/** Normal CLI entry uses an actual report or a supplied record file, with explicit byte identity in the result. */
export function inspectDeliveryFiles({ handoffPath, analysisRecordPath, observed, viewer, root, sources = [] }) {
  const handoff = path.resolve(handoffPath);
  const handoffSource = sourceFile('handoff', handoff);
  const recordSource = analysisRecordPath ? sourceFile('analysis_record', analysisRecordPath) : null;
  const requestValue = JSON.parse(fs.readFileSync(handoff, 'utf8'));
  const deliveryRoot = path.resolve(root || path.dirname(handoff));
  const request = validateDeliveryRequest(requestValue, deliveryRoot);
  const supplied = analysisRecordPath ? recordFromDocument(JSON.parse(fs.readFileSync(analysisRecordPath, 'utf8')), request) : null;
  const actual = viewer ? analysisRecordFromViewer(viewer, request) : observed ? validateAnalysisRecord(observed) : supplied;
  if (!actual) throw new Error('Supply the report being inspected or an analysis-record file.');
  const files = [handoffSource, ...(recordSource ? [recordSource] : []), ...sources];
  const envelope = createDeliveryInspection(request, actual, { root: deliveryRoot, sources: files });
  if (supplied && (viewer || observed)) {
    const checks = Object.entries(supplied).filter(([, value]) => value !== null).map(([key, value]) => ({ id: `analysis-record:${key}`,
      status: value == null || actual[key] == null ? 'unknown' : value === actual[key] ? 'pass' : 'fail',
      message: `${key}. Supplied record ${String(value ?? 'unavailable')}. Rendered analysis ${String(actual[key] ?? 'unavailable')}.` }));
    envelope.submittedAnalysisRecord = supplied;
    envelope.result = { ...envelope.result, checks: [...envelope.result.checks, ...checks] };
    envelope.result.predicted = diagnosis(envelope.result.integrityStatus, envelope.result.checks);
  }
  for (const [role, filename] of [['handoff', handoff], ['analysis_record', analysisRecordPath]]) {
    if (!filename) continue;
    const original = files.find(file => file.role === role);
    if (sourceFile(role, filename).sha256 !== original.sha256) throw new Error('Inspection input changed while being read.');
  }
  return envelope;
}
