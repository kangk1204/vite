#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteJson, describeArtifact, resolveArtifactPath, sha256 } from './provenance.mjs';
import { attachTestedMembership } from './provenance_membership.mjs';
import { analysisRecordFromViewer } from './delivery_inspection.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const defaultManifest = 'paper/manifests/publication_2026_11_16.json';
const defaultOutput = 'paper/outputs/publication_2026_11_16/delivery-validation';

function rows(table) {
  return table.rows.map(row => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])));
}

function run(command, args, logFile) {
  const fd = fs.openSync(logFile, 'w');
  try { execFileSync(command, args, { cwd: ROOT, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
}

function copyInputs(source, evidence, resources) {
  return evidence.artifacts.map(artifact => {
    const scope = { root: path.dirname(source), projectRoot: ROOT };
    const sourcePath = resolveArtifactPath(artifact.path, scope);
    const original = describeArtifact(artifact.role, artifact.path, scope);
    if (original.sha256 !== artifact.sha256) throw new Error(`Source changed: ${artifact.path}`);
    const filename = `${artifact.role}-${path.basename(sourcePath)}`;
    fs.copyFileSync(sourcePath, path.join(resources, filename));
    return { ...describeArtifact(artifact.role, filename, { root: resources }), path: `resources/${filename}` };
  });
}

function prepareSource(output, manifestPath) {
  const manifest = JSON.parse(fs.readFileSync(resolveArtifactPath(manifestPath, { root: ROOT }), 'utf8'));
  const cohort = manifest.cohorts.find(row => row.key === 'airway_paired_reference');
  if (!cohort) throw new Error('Delivery examples require the declared airway reference cohort.');
  const workbook = resolveArtifactPath(cohort.workbookPath, { root: ROOT });
  const sourceEvidence = resolveArtifactPath(cohort.evidencePath, { root: ROOT });
  const source = { cohort: cohort.key, datasetIdentifier: cohort.datasetIdentifier,
    workbookSha256: describeArtifact('workbook', cohort.workbookPath, { root: ROOT }).sha256,
    evidenceSha256: describeArtifact('evidence', cohort.evidencePath, { root: ROOT }).sha256 };
  const marker = path.join(output, '.pnv-delivery-examples.json');
  if (fs.existsSync(output) && fs.readdirSync(output).length) {
    if (!fs.existsSync(marker) || JSON.stringify(JSON.parse(fs.readFileSync(marker, 'utf8')).source) !== JSON.stringify(source)) throw new Error('Choose a new output directory for this source analysis. Existing materials were preserved.');
  }
  const resources = path.join(output, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  atomicWriteJson(marker, { kind: 'pnv-public-delivery-examples', source });
  const original = JSON.parse(fs.readFileSync(sourceEvidence, 'utf8')).evidence;
  const artifacts = copyInputs(sourceEvidence, original, resources);
  fs.copyFileSync(workbook, path.join(resources, 'input.xlsx'));
  const snapshot = resolveArtifactPath(cohort.referenceInputPath, { root: ROOT });
  let evidence = attachTestedMembership(original, snapshot, { root: path.dirname(sourceEvidence), projectRoot: ROOT });
  const snapshotArtifact = evidence.artifacts.find(artifact => artifact.role === 'reference_snapshot');
  fs.copyFileSync(snapshot, path.join(resources, path.basename(snapshotArtifact.path)));
  evidence = { ...evidence, artifacts: [...original.artifacts, snapshotArtifact,
    ...evidence.artifacts.filter(artifact => artifact.role === 'report_membership_helper'),
    describeArtifact('workbook', 'input.xlsx', { root: resources })] };
  atomicWriteJson(path.join(resources, 'evidence.json'), { schemaVersion: 2, evidence });
  const analysisRecord = analysisRecordFromViewer({
    project: original.analysis.contrast, provenance: { datasetIdentifier: cohort.datasetIdentifier }, evidence: original,
    samplesById: Object.fromEntries(rows(original.sourceTables.metadata).map(row => [row.sample, { groupKey: row.group }])) });
  const recordPath = path.join(resources, 'analysis-record.json');
  atomicWriteJson(recordPath, { schemaVersion: 1, analysisRecord, runId: original.runId, sourceSha256: source.evidenceSha256 });
  return { source, artifacts, analysisRecord, recordPath, resources };
}

function exampleDefinitions(prepared, output) {
  const { analysisRecord, artifacts } = prepared;
  const fields = ['datasetIdentifier', 'conditionA', 'conditionB', 'designFormula', 'sampleCountA', 'sampleCountB', 'rankMetric', 'lfcMethod', 'adjustment', 'pathwayHypothesisCount'];
  const claims = Object.fromEntries(fields.map(key => [key, analysisRecord[key]]));
  const request = { schemaVersion: 1, claims, artifacts, additionalRecords: [] };
  const code = artifacts.find(artifact => artifact.role === 'analysis_code');
  const changedPath = 'resources/changed-entrypoint.R';
  fs.writeFileSync(path.join(output, changedPath), `${fs.readFileSync(path.join(output, code.path), 'utf8')}\n# Delivery byte-identity example\n`);
  return [
    { id: 'normal', expected: 'normal', construction: 'Original supplied files and recorded analysis fields.', request },
    { id: 'contrast-conflict', expected: 'mismatch', construction: 'The requested test-group label differs from the actual fitted analysis.', request: { ...request, claims: { ...claims, conditionB: `${analysisRecord.conditionB} alternate declaration` } } },
    { id: 'changed-file', expected: 'mismatch', construction: 'An added comment changes the supplied analysis file bytes while its recorded digest is retained.', request: { ...request, artifacts: artifacts.map(artifact => artifact === code ? { ...artifact, path: changedPath } : artifact) } },
    { id: 'missing-file', expected: 'unverifiable', construction: 'The declared sample-metadata path has no supplied file.', request: { ...request, artifacts: artifacts.map(artifact => artifact.role === 'sample_metadata' ? { ...artifact, path: 'resources/unprovided-samples.tsv' } : artifact) } },
    { id: 'consistent-labels', expected: 'normal', construction: 'The supplied record and requested labels are changed coherently. Biological naming is outside the observable consistency checks.', recordOnly: true,
      request: { ...request, claims: { ...claims, conditionA: analysisRecord.conditionB, conditionB: analysisRecord.conditionA } } },
  ];
}

function executeExample(example, prepared, output) {
  const directory = path.join(output, example.id);
  fs.mkdirSync(directory, { recursive: true });
  const handoff = path.join(directory, 'handoff.json');
  atomicWriteJson(handoff, example.request);
  let suppliedRecord = prepared.recordPath;
  if (example.recordOnly) {
    suppliedRecord = path.join(directory, 'analysis-record.json');
    atomicWriteJson(suppliedRecord, { schemaVersion: 1, analysisRecord: { ...prepared.analysisRecord,
      conditionA: prepared.analysisRecord.conditionB, conditionB: prepared.analysisRecord.conditionA }, sourceSha256: prepared.source.evidenceSha256 });
  }
  const inspectionPath = path.join(directory, 'inspection.json');
  run('node', ['scripts/inspect_delivery.mjs', '--handoff', handoff, '--analysis-record', suppliedRecord, '--delivery-root', output, '--out', inspectionPath], path.join(directory, 'inspect.log'));
  const inspection = JSON.parse(fs.readFileSync(inspectionPath, 'utf8'));
  if (inspection.result.predicted !== example.expected) throw new Error(`Unexpected technical response for ${example.id}.`);
  const reports = [];
  if (!example.recordOnly) {
    for (const condition of ['full', 'basic']) {
      const html = path.join(directory, `${condition}.html`), json = path.join(directory, `${condition}.viewer.json`);
      run('node', ['scripts/build_report_from_workbook.mjs', path.join(prepared.resources, 'input.xlsx'), html, '--evidence', path.join(prepared.resources, 'evidence.json'), '--handoff', handoff, '--analysis-record', suppliedRecord, '--delivery-root', output, '--condition', condition, '--viewer-json', json], path.join(directory, `${condition}.log`));
      const delivered = JSON.parse(fs.readFileSync(json, 'utf8')).evidence.deliveryInspection;
      if (delivered.result.predicted !== example.expected) throw new Error(`Report delivery result differs for ${example.id}/${condition}.`);
      reports.push({ condition, path: path.relative(output, html), sha256: describeArtifact('report', path.basename(html), { root: directory }).sha256, inspection: delivered });
    }
  }
  const comparable = value => JSON.stringify({ request: value.request, analysisRecord: value.analysisRecord, submittedAnalysisRecord: value.submittedAnalysisRecord, result: value.result, sources: value.sources });
  const fullBasicRawEqual = reports.length ? comparable(reports[0].inspection) === comparable(reports[1].inspection) : null;
  if (fullBasicRawEqual === false) throw new Error('Full/basic raw delivery information differs.');
  return { id: example.id, construction: example.construction, expectedTechnicalOutcome: example.expected, observed: inspection.result.predicted,
    entryPoint: example.recordOnly ? 'inspect_delivery record-only' : 'inspect_delivery and build_report_from_workbook',
    fullBasicRawEqual, sourceClaims: inspection.request.claims, checks: inspection.result.checks,
    biologicalLabelAssessment: example.recordOnly ? 'unresolved' : 'outside these technical checks',
    inspectorCliExit: 0, reportCliExit: reports.length ? 0 : null,
    artifacts: [handoff, inspectionPath, suppliedRecord].map(file => ({ path: path.relative(output, file), sha256: sha256(fs.readFileSync(file)) })),
    reports: reports.map(({ inspection: ignored, ...report }) => report) };
}

export function buildDeliveryExamples(outputPath = defaultOutput, manifestPath = defaultManifest) {
  const output = path.resolve(outputPath);
  const prepared = prepareSource(output, manifestPath);
  const cases = exampleDefinitions(prepared, output).map(example => executeExample(example, prepared, output));
  const validation = { schemaVersion: 1, scope: 'developer-defined delivery contract checks', source: prepared.source, cases,
    limitations: ['Coherent supplied labels can pass file and field consistency while biological naming remains unresolved.', 'These constructed examples document software responses. Independent case adjudication and user-performance observations remain pending.'], humanRatings: 0 };
  atomicWriteJson(path.join(output, 'validation.json'), validation);
  fs.writeFileSync(path.join(output, 'README.md'), '# Public delivery checks\n\nThese developer-defined examples use the revised paired airway analysis. `validation.json` records the actual normal CLI outputs and file digests. Replace DELIVERY with this directory in the commands below.\n\n```sh\nnode scripts/inspect_delivery.mjs --handoff DELIVERY/normal/handoff.json --analysis-record DELIVERY/resources/analysis-record.json --delivery-root DELIVERY --out inspection.json\nnode scripts/build_report_from_workbook.mjs DELIVERY/resources/input.xlsx report.html --evidence DELIVERY/resources/evidence.json --handoff DELIVERY/normal/handoff.json --analysis-record DELIVERY/resources/analysis-record.json --delivery-root DELIVERY\n```\n\nThe coherent-label example exercises the record-only inspector. Its supplied labels agree with each other, and biological naming remains unresolved. The other four examples include freshly generated full/basic product reports with equal raw delivery information.\n');
  return validation;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const result = buildDeliveryExamples(process.argv[2] || defaultOutput, process.argv[3] || defaultManifest);
    console.log(JSON.stringify({ output: path.resolve(process.argv[2] || defaultOutput), cases: result.cases.length, humanRatings: 0 }));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
