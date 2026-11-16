#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildReport } from './build_report_from_workbook.mjs';
import { readTsvFile, toTsv } from './lib/paper_pipeline.mjs';
import { resolveArtifactPath } from './lib/provenance.mjs';
import { checkFigureExample, compactViewer, EXAMPLE_ID, extractExample } from './lib/reviewer_example.mjs';
import { renderPages } from './lib/reviewer_pages.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_MANIFEST = 'paper/manifests/publication_2026_11_16.json';
const PD = 'gse68719_pd_primary';
const FIGURES = [
  ['figure1_pathway_selection', 'Figure 1. Pathway selection under sample resampling'],
  ['figure2_evidence_inspection', 'Figure 2. Evidence inspection and reference network'],
  ['figure3_delivery_validation', 'Figure 3. Observable delivery checks'],
  ['supplementary_figure_s1_evidence_workflow', 'Supplementary Figure S1. Evidence workflow'],
  ['supplementary_figure_s2_integration_checks', 'Supplementary Figure S2. Integration checks'],
];
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const projectFile = name => resolveArtifactPath(name, { root: ROOT });
const mkdir = dir => fs.mkdirSync(dir, { recursive: true });

async function hashFile(filename) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) digest.update(chunk);
  return digest.digest('hex');
}

function writeJson(filename, data) {
  mkdir(path.dirname(filename)); fs.writeFileSync(filename, JSON.stringify(data, null, 2) + '\n');
}

async function copyFile(source, destination, expectedDigest) {
  if (fs.lstatSync(source).isSymbolicLink()) throw new Error(`Refusing symlink input ${source}`);
  mkdir(path.dirname(destination)); fs.copyFileSync(source, destination);
  const digest = await hashFile(destination);
  if (expectedDigest && digest !== expectedDigest) throw new Error(`File differs from its recorded digest: ${source}`);
  return digest;
}

async function verifyInputRecords(records) {
  for (const item of records) {
    const file = projectFile(path.relative(ROOT, path.resolve(ROOT, item.path)));
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || await hashFile(file) !== item.sha256) throw new Error(`Figure or supplement input digest differs: ${item.path}`);
  }
}

export async function collectFigure(stage, publication, base) {
  if (!/^[a-zA-Z0-9_-]+$/.test(base)) throw new Error('Invalid figure identifier');
  const manifestName = `${base}.manifest.json`;
  const manifest = readJson(path.join(publication, 'figures', manifestName));
  const recorded = [...(manifest.outputs || []), ...(manifest.source_data || [])];
  if (manifest.validation?.preview === true) throw new Error(`Figure is marked as a preview: ${base}`);
  await verifyInputRecords([...(manifest.inputs || []), ...(manifest.script_sha256 ? [{ path: manifest.script, sha256: manifest.script_sha256 }] : [])]);
  for (const ext of ['pdf', 'png', 'svg', 'source.tsv', 'source.xlsx', 'legend.txt', 'legend.docx']) {
    const file = `${base}.${ext}`;
    const digest = recorded.find(item => path.basename(item.path) === file)?.sha256;
    if (!digest) throw new Error(`No figure manifest digest for ${file}`);
    await copyFile(path.join(publication, 'figures', file), path.join(stage, 'figures', file), digest);
  }
  writeJson(path.join(stage, 'figures', manifestName), manifest);
  for (const item of manifest.outputs || []) {
    const file = path.basename(item.path);
    if (/^figure1b_(?:capture(?:_evidence|_network)?\.(?:json|png)|network_export\.svg)$/.test(file)) {
      await copyFile(path.join(publication, 'figures', file), path.join(stage, 'figures', file), item.sha256);
    }
  }
}

export async function collectStatistics(stage, indexPath) {
  if (!indexPath) return null;
  const filename = projectFile(indexPath), directory = path.dirname(filename), index = readJson(filename);
  if (!Array.isArray(index.files) || !index.files.length || new Set(index.files.map(item => item.path)).size !== index.files.length) throw new Error('Statistical artifact index is empty or contains duplicates.');
  const collected = [];
  for (const item of index.files) {
    const original = projectFile(item.path), relative = path.relative(directory, original);
    if (/checkpoint|replicate/i.test(relative) || !/\.(?:tsv|json|md|png|pdf|svg|xlsx|txt|docx)$/.test(relative)) throw new Error(`Raw checkpoint payload is excluded from the reviewer package: ${relative}`);
    resolveArtifactPath(relative, { root: directory });
    if (!/^[a-f0-9]{64}$/.test(item.sha256) || fs.statSync(original).size !== item.bytes) throw new Error(`Statistical artifact digest or size differs: ${relative}`);
    await copyFile(original, path.join(stage, 'statistics', relative), item.sha256);
    if (relative.endsWith('.manifest.json')) {
      const figure = readJson(original);
      await verifyInputRecords([...(figure.sourceData || []), ...(figure.renderer ? [figure.renderer] : [])]);
    }
    collected.push(`statistics/${relative}`);
  }
  await copyFile(filename, path.join(stage, 'statistics/artifact-index.json'));
  return { index: 'statistics/artifact-index.json', files: collected };
}

function artifactDigest(records, relativePath) {
  const record = records.find(item => item.path === relativePath || item.path === `project:${relativePath}`);
  if (!record || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`Missing recorded digest for ${relativePath}`);
  return record.sha256;
}

export function assertCameraTable(rows, source) {
  if (!source || rows.length !== source.rows.length) throw new Error('CAMERA table length differs from report evidence');
  rows.forEach((row, index) => source.columns.forEach((column, cell) => {
    const actual = row[column];
    const expected = source.rows[index][cell];
    if (expected == null && (actual === '' || actual === 'NA')) return;
    if (['pvalue', 'padj', 'Correlation'].includes(column) && actual !== '' && expected !== null && Number.isFinite(Number(actual)) && Number.isFinite(Number(expected))) {
      // fwrite and jsonlite serialize the same R double with slightly different final digits.
      const scale = Math.max(Math.abs(Number(actual)), Math.abs(Number(expected)));
      if (Math.abs(Number(actual) - Number(expected)) <= scale * 1e-12) return;
    }
    if (String(actual) !== String(expected)) throw new Error(`CAMERA ${column} differs at data row ${index + 1}`);
  }));
}

async function collectCohort(stage, cohort, finalization) {
  if (!/^[a-zA-Z0-9_-]+$/.test(cohort.key)) throw new Error('Invalid cohort identifier');
  if (finalization.verification !== 'verified_against_supplied_artifacts' || finalization.referenceParity !== 'pass') throw new Error(`Cohort verification incomplete: ${cohort.key}`);
  const evidencePath = cohort.evidencePath.replace(/_evidence\.json$/, '_report_evidence.json');
  const evidenceBytes = fs.readFileSync(projectFile(evidencePath));
  const evidenceHash = crypto.createHash('sha256').update(evidenceBytes).digest('hex');
  if (evidenceHash !== artifactDigest(finalization.artifacts, evidencePath)) throw new Error(`Cohort evidence digest differs: ${cohort.key}`);
  const { evidence } = JSON.parse(evidenceBytes);
  const folder = path.join(stage, 'tables', cohort.key);
  const files = [['fgsea.tsv', 'fgsea'], ['camera.tsv', 'CAMERA'], ['genes.tsv', 'DESeq2']];
  const primaryPath = projectFile(cohort.pathwayTablePath), cameraPath = projectFile(cohort.evidencePath.replace(/_evidence\.json$/, '_camera.tsv'));
  const primaryRows = readTsvFile(primaryPath), cameraRows = readTsvFile(cameraPath);
  assertCameraTable(cameraRows, evidence.sourceTables.camera);
  const primaryHash = await copyFile(primaryPath, path.join(folder, 'fgsea.tsv'), artifactDigest(evidence.artifacts, cohort.pathwayTablePath));
  const cameraHash = await copyFile(cameraPath, path.join(folder, 'camera.tsv'));
  await copyFile(projectFile(cohort.degTablePath), path.join(folder, 'genes.tsv'), artifactDigest(evidence.artifacts, cohort.degTablePath));
  for (const [suffix, target, label] of [
    ['/reference_validation.json', 'independent-reference.json', 'Independent R comparisons'],
    ['/reference_validation.json.binding.json', 'independent-reference-binding.json', 'Comparison binding'],
  ]) {
    const artifact = finalization.artifacts.find(item => item.path.endsWith(suffix) && !item.path.includes('.crate/'));
    if (!artifact) throw new Error(`Missing independent reference artifact for ${cohort.key}`);
    await copyFile(projectFile(artifact.path), path.join(folder, target), artifact.sha256);
    files.push([target, label]);
  }
  const groupOnly = evidence.artifacts.find(item => item.role === 'design_sensitivity' && item.path.endsWith('_fgsea_reactome.tsv'));
  if (groupOnly) {
    const original = resolveArtifactPath(groupOnly.path, { root: path.dirname(projectFile(evidencePath)), projectRoot: ROOT });
    await copyFile(original, path.join(folder, 'group-only-fgsea.tsv'), groupOnly.sha256);
    files.push(['group-only-fgsea.tsv', 'Group-only fgsea']);
  }
  if (evidence.bootstrap?.requested > 0) {
    const rows = primaryRows.map((row, index) => {
      const values = evidence.pathways[row.pathway_id]?.bootstrap;
      if (!values) throw new Error(`Missing resampling record for ${row.pathway_id}`);
      return { pathway_id: row.pathway_id, pathway_name: row.pathway_name, fgsea_data_row: index + 1, ...values };
    });
    fs.writeFileSync(path.join(folder, 'bootstrap.tsv'), toTsv(rows));
    files.push(['bootstrap.tsv', 'Bootstrap']);
  }
  const record = { key: cohort.key, datasetIdentifier: cohort.datasetIdentifier, contrastName: cohort.contrastName, files };
  if (cohort.key !== PD) return { record };
  const example = extractExample({ primaryRows, cameraRows, evidence });
  // Figure 2's legacy-named case source records this path alongside the full report.
  await copyFile(primaryPath, path.join(stage, PD, path.basename(primaryPath)), primaryHash);
  const hashes = { fgseaTsvSha256: primaryHash, cameraTsvSha256: cameraHash, finalizedEvidenceSha256: evidenceHash,
    bootstrapTsvSha256: await hashFile(path.join(folder, 'bootstrap.tsv')) };
  const samples = evidence.sourceTables.metadata;
  const column = samples.columns.indexOf('contrast_group');
  const pdCount = samples.rows.filter(row => row[column] === 'B').length;
  const controlCount = samples.rows.filter(row => row[column] === 'A').length;
  if (!pdCount || !controlCount || pdCount + controlCount !== samples.rows.length) throw new Error('Invalid PD group assignments');
  writeJson(path.join(stage, 'evidence/pathway-record.json'), {
    pathwayId: EXAMPLE_ID, runId: evidence.runId, analysis: evidence.analysis, sourceDigests: hashes,
    primary: example.primary, camera: example.camera, bootstrap: example.bootstrap,
    bootstrapSource: { canonicalJsonPath: `evidence.pathways["${EXAMPLE_ID}"].bootstrap`, table: `tables/${PD}/bootstrap.tsv`, dataRow: example.primary.row },
  });
  const config = readJson(projectFile(cohort.configPath));
  for (const file of [config.rawCountsPath, config.seriesMatrixPath]) await copyFile(projectFile(file), path.join(stage, 'inputs', path.basename(file)), artifactDigest(evidence.artifacts, file));
  await copyFile(projectFile(cohort.reportPath), path.join(stage, 'reports/gse68719_pd_primary.report.html'), artifactDigest(finalization.artifacts, cohort.reportPath));
  const viewerPath = cohort.reportPath.replace(/\.html$/, '.viewer.json');
  if (await hashFile(projectFile(viewerPath)) !== artifactDigest(finalization.artifacts, viewerPath)) throw new Error('PD viewer digest mismatch');
  const compact = compactViewer(readJson(projectFile(viewerPath)));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-reviewer-example-'));
  try {
    const input = path.join(temp, 'example.viewer.json'); writeJson(input, compact);
    await buildReport(input, path.join(stage, 'reports/interleukins.report.html'));
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
  return { record, example, pdCount, controlCount };
}

export async function collectComparators(stage, benchmarkPath) {
  if (!benchmarkPath) return null;
  const filename = projectFile(benchmarkPath);
  const benchmark = readJson(filename);
  const directory = path.dirname(filename);
  const results = benchmark.results;
  const expected = new Set(['GeneTonic:matched', 'GeneTonic:defaults', 'RNAmel:matched', 'RNAmel:defaults']);
  if (!Array.isArray(results) || results.length !== 4 || new Set(results.map(row => `${row.tool}:${row.mode}`)).size !== 4) throw new Error('Four distinct observed comparator runs are required.');
  const records = [];
  const copied = new Set();
  for (const result of results) {
    if (!expected.has(`${result.tool}:${result.mode}`) || !result.completed || !result.offlineBrowserVerified || !result.runnerSha256 || result.executedSources?.length !== 2) throw new Error('Comparator execution or source receipt is incomplete.');
    const folder = `${result.tool.toLowerCase()}-${result.mode}`;
    const runDirectory = path.join(directory, folder);
    const observed = readJson(path.join(runDirectory, 'metrics.json'));
    if (JSON.stringify(observed) !== JSON.stringify(result)) throw new Error(`Comparator summary differs from the finalized run receipt: ${folder}`);
    for (const source of result.executedSources) {
      if (path.basename(source.path) !== source.path || !result.artifacts.some(artifact => artifact.path === source.path && artifact.sha256 === source.sha256)) throw new Error('Comparator executed source is not bound to its artifact inventory.');
    }
    if (result.runnerSha256 !== result.executedSources[0].sha256) throw new Error('Comparator runner digest differs from its executed source.');
    for (const source of result.executedSources) {
      if (await hashFile(projectFile(source.original)) !== source.sha256) throw new Error(`Public comparator source differs from the executed source: ${source.original}`);
    }
    for (const [source, digest] of Object.entries(result.fixtureSources ?? {})) {
      if (await hashFile(projectFile(source)) !== digest) throw new Error(`Public fixture preparation source differs from its captured input: ${source}`);
    }
    for (const artifact of result.artifacts) {
      if (path.basename(artifact.path) !== artifact.path) throw new Error('Unexpected comparator artifact path.');
      await copyFile(path.join(runDirectory, artifact.path), path.join(stage, 'comparators', folder, artifact.path), artifact.sha256);
    }
    for (const extra of ['metrics.json', 'offline-browser.json', 'native-report.png']) {
      await copyFile(path.join(runDirectory, extra), path.join(stage, 'comparators', folder, extra));
    }
    const originalFixture = projectFile(path.relative(ROOT, result.command[3]));
    if (await hashFile(originalFixture) !== result.fixtureSha256 || await hashFile(originalFixture + '.json') !== result.fixtureReceiptSha256) throw new Error('Comparator fixture differs from its execution receipt.');
    const prepared = readJson(originalFixture + '.json');
    if (!prepared.pnvIntegration?.independentDirectPackageParity) throw new Error('Comparator input is not bound to the main PNV inference arrays.');
    const validation = readJson(originalFixture + '.replay-validation.json');
    if (validation.status !== 'pass' || validation.fixtureSha256 !== result.fixtureSha256 || validation.ordinaryPnvReference?.status !== 'pass') throw new Error('Comparator fixture replay or ordinary PNV parity is incomplete.');
    for (const suffix of ['', '.json', '.mapping.tsv', '.airway-annotation.tsv', '.genes.tsv', '.pathways.tsv', '.replay-validation.json']) {
      const file = originalFixture + suffix;
      if (!copied.has(file)) {
        await copyFile(file, path.join(stage, 'comparators/fixture', path.basename(file)));
        copied.add(file);
      }
    }
    records.push({ tool: result.tool, version: result.version, mode: result.mode,
      report: `comparators/${folder}/${path.basename(result.reportPath)}`, receipt: `comparators/${folder}/metrics.json`,
      taskAudit: `comparators/${folder}/offline-browser.json`, fixtureSha256: result.fixtureSha256 });
  }
  if (new Set(records.map(row => row.fixtureSha256)).size !== 1) throw new Error('Comparator cells did not use the same input fixture.');
  await copyFile(filename, path.join(stage, 'comparators/benchmark.json'));
  for (const file of ['benchmark.tsv', 'task-completion.tsv']) await copyFile(path.join(directory, file), path.join(stage, 'comparators', file));
  writeJson(path.join(stage, 'comparators/index.json'), { scope: 'Single automated native executions with matched PNV input and task-specific browser observations', participantObservations: 0, records });
  return records;
}

export async function collectLinuxProbe(stage, probePath, source) {
  if (!probePath) return null;
  const filename = projectFile(probePath), proof = readJson(filename);
  if (proof.status !== 'completed' || proof.sourceSnapshot !== source.sourceSnapshot || proof.sourceArchiveSha256 !== source.sha256) throw new Error('Linux probe has not been bound to the selected public source archive.');
  if (!proof.evidenceFiles || !Object.keys(proof.evidenceFiles).length) throw new Error('Linux probe supporting evidence is missing.');
  const folder = path.join(stage, 'linux-replay');
  mkdir(folder);
  for (const [name, record] of Object.entries(proof.evidenceFiles)) {
    const original = resolveArtifactPath(name, { root: path.dirname(filename) });
    const destination = resolveArtifactPath(name, { root: folder });
    if (!/^[a-f0-9]{64}$/.test(record.sha256) || fs.statSync(original).size !== record.bytes) throw new Error(`Linux evidence digest or size is invalid: ${name}`);
    await copyFile(original, destination, record.sha256);
  }
  await copyFile(filename, path.join(folder, 'ordinary-airway-results.json'));
  return { receipt: 'linux-replay/ordinary-airway-results.json',
    files: Object.keys(proof.evidenceFiles).map(name => `linux-replay/${name}`) };
}

export async function collectProvenanceValidation(stage, publication) {
  const directory = path.join(publication, 'provenance-validation'), filename = path.join(directory, 'validation.json');
  if (!fs.existsSync(filename)) return null;
  const validation = readJson(filename);
  const records = [...validation.cases.flatMap(item => item.receipts), ...(validation.replayInput ? [validation.replayInput] : [])];
  if (!records.length || new Set(records.map(item => item.path)).size !== records.length) throw new Error('External provenance receipt inventory is empty or duplicated.');
  const destination = path.join(stage, 'provenance-validation'); mkdir(destination);
  for (const record of records) {
    if (!/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error('External provenance receipt has an invalid digest.');
    await copyFile(resolveArtifactPath(record.path, { root: directory }), resolveArtifactPath(record.path, { root: destination }), record.sha256);
  }
  await copyFile(filename, path.join(destination, 'validation.json'));
  return { index: 'provenance-validation/validation.json', files: records.map(item => `provenance-validation/${item.path}`) };
}

export function resolveReviewerPaths(options = {}, root = ROOT) {
  const locate = value => resolveArtifactPath(path.relative(root, path.resolve(root, value)), { root });
  const manifestPath = locate(options.manifestPath || DEFAULT_MANIFEST);
  const manifest = readJson(manifestPath);
  if (typeof manifest.outputRoot !== 'string' || !manifest.outputRoot.trim()) throw new Error('Publication manifest requires outputRoot.');
  const publication = locate(manifest.outputRoot);
  return { manifestPath, manifest, publication,
    releaseReceipt: locate(options.releaseReceipt || path.join(publication, 'release/source-snapshot.json')),
    destination: locate(options.destination || path.join(publication, 'reviewer')) };
}

export async function buildReviewerPortal(options = {}) {
  const { manifestPath, manifest, publication, releaseReceipt, destination } = resolveReviewerPaths(options);
  const release = readJson(releaseReceipt);
  const name = path.basename(release.archive);
  if (!/^[a-f0-9]{64}$/.test(release.sourceSnapshot) || name !== `pnv-source-${release.sourceSnapshot.slice(0, 12)}.zip`) throw new Error('Unexpected content-addressed source archive name');
  const finalization = readJson(path.join(publication, 'benchmarks/finalization.json'));
  mkdir(path.dirname(destination));
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.reviewer-stage-'));
  try {
    const source = { ...release, archive: name, name };
    await copyFile(projectFile(release.archive), path.join(stage, 'source', name), source.sha256);
    writeJson(path.join(stage, 'source/source-snapshot.json'), { sourceSnapshot: source.sourceSnapshot, archive: name,
      sha256: source.sha256, files: source.files, workingTreeDirty: source.workingTreeDirty });
    for (const file of ['reviewer.css', 'verify_bundle.py']) await copyFile(path.join(ROOT, 'paper/reviewer', file), path.join(stage, file.endsWith('.css') ? `assets/${file}` : file));
    for (const [base] of FIGURES) await collectFigure(stage, publication, base);
    const panelFile = 'figure1b_interleukin_report.source.tsv';
    await copyFile(path.join(publication, 'figures', panelFile), path.join(stage, 'figures', panelFile));
    const cohorts = []; let primary;
    for (const cohort of manifest.cohorts.filter(item => item.enabled !== false)) {
      const collected = await collectCohort(stage, cohort, finalization.cohorts[cohort.key]);
      cohorts.push(collected.record);
      if (cohort.key === PD) primary = collected;
    }
    if (!primary) throw new Error('Missing PD cohort');
    checkFigureExample(readTsvFile(path.join(stage, 'figures', panelFile)), primary.example);
    const comparators = await collectComparators(stage, manifest.comparatorBenchmarkPath);
    const linuxProbe = await collectLinuxProbe(stage, manifest.linuxProbePath, source);
    const defaultStatisticsIndex = path.join(publication, 'statistics/artifact-index.json');
    const statistics = await collectStatistics(stage, manifest.statisticsArtifactIndexPath || (fs.existsSync(defaultStatisticsIndex) ? path.relative(ROOT, defaultStatisticsIndex) : null));
    const provenanceValidation = await collectProvenanceValidation(stage, publication);
    const selectedPrimary = manifest.cohorts.find(cohort => cohort.key === PD);
    const pages = renderPages({ ...primary, cohorts, source, figureBases: FIGURES, comparators, linuxProbe, statistics, provenanceValidation,
      publication: { manifestPath: path.relative(ROOT, manifestPath), outputRoot: manifest.outputRoot,
        primaryConfigPath: selectedPrimary.configPath,
        primarySnapshotPath: selectedPrimary.evidencePath.replace(/_evidence\.json$/, '_reference_input.rds') },
      exampleBytes: fs.statSync(path.join(stage, 'reports/interleukins.report.html')).size,
      fullBytes: fs.statSync(path.join(stage, 'reports/gse68719_pd_primary.report.html')).size });
    for (const [file, html] of Object.entries(pages)) fs.writeFileSync(path.join(stage, file), html);
    writeJson(path.join(stage, 'publication-version.json'), {
      manifest: path.relative(ROOT, manifestPath), sourceSnapshot: source.sourceSnapshot,
      sourceArchiveSha256: source.sha256, outputRoot: manifest.outputRoot,
      comparatorIndex: comparators ? 'comparators/index.json' : null,
      linuxProbe: linuxProbe?.receipt ?? null,
      statisticsIndex: statistics?.index ?? null,
      provenanceValidation: provenanceValidation?.index ?? null,
    });
    execFileSync('python3', [path.join(ROOT, 'scripts/lib/reviewer_archive.py'), stage], { stdio: 'inherit' });
    const backup = `${destination}.previous-${process.pid}`;
    if (fs.existsSync(destination)) {
      if (readJson(path.join(destination, 'reviewer-package.json')).builder !== 'scripts/build_reviewer_portal.mjs') throw new Error('Existing reviewer directory is not a generated package');
      fs.renameSync(destination, backup);
    }
    try { fs.renameSync(stage, destination); }
    catch (error) { if (fs.existsSync(backup)) fs.renameSync(backup, destination); throw error; }
    if (fs.existsSync(backup)) fs.rmSync(backup, { recursive: true, force: true });
    console.log(JSON.stringify(readJson(path.join(destination, 'reviewer-package.json')), null, 2));
  } finally { fs.rmSync(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = { '--manifest': 'manifestPath', '--release-receipt': 'releaseReceipt', '--destination': 'destination' };
  const options = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    if (!names[args[index]] || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Use --manifest, --release-receipt and --destination with paths.');
    options[names[args[index]]] = args[index + 1];
  }
  buildReviewerPortal(options).catch(error => { console.error(error.message); process.exitCode = 1; });
}
