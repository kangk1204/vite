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
const PUBLICATION = path.join(ROOT, 'paper/outputs/publication_v2');
const PD = 'gse68719_pd_primary';
const FIGURES = [
  ['figure1_pathway_selection', 'Figure 1. Pathway selection under sample resampling'],
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

function artifactDigest(records, relativePath) {
  const record = records.find(item => item.path === relativePath || item.path === `project:${relativePath}`);
  if (!record || !/^[a-f0-9]{64}$/.test(record.sha256)) throw new Error(`Missing recorded digest for ${relativePath}`);
  return record.sha256;
}

function assertCameraTable(rows, source) {
  if (!source || rows.length !== source.rows.length) throw new Error('CAMERA table length differs from report evidence');
  rows.forEach((row, index) => source.columns.forEach((column, cell) => {
    const actual = row[column];
    const expected = source.rows[index][cell];
    if (expected == null && (actual === '' || actual === 'NA')) return;
    if (['pvalue', 'padj'].includes(column) && actual !== '' && expected !== null && Number.isFinite(Number(actual)) && Number.isFinite(Number(expected))) {
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
  // Figure 1B's canonical source file records this relative path alongside the full report.
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

export async function buildReviewerPortal({ releaseReceipt = path.join(PUBLICATION, 'release/source-snapshot.json'), destination = path.join(PUBLICATION, 'reviewer') } = {}) {
  const release = readJson(releaseReceipt);
  const name = path.basename(release.archive);
  if (!/^[a-f0-9]{64}$/.test(release.sourceSnapshot) || name !== `pnv-source-${release.sourceSnapshot.slice(0, 12)}.zip`) throw new Error('Unexpected content-addressed source archive name');
  const manifest = readJson(path.join(ROOT, 'paper/manifests/publication_v2.json'));
  const finalization = readJson(path.join(PUBLICATION, 'benchmarks/finalization.json'));
  mkdir(path.dirname(destination));
  const stage = fs.mkdtempSync(path.join(path.dirname(destination), '.reviewer-stage-'));
  try {
    const source = { ...release, archive: name, name };
    await copyFile(projectFile(release.archive), path.join(stage, 'source', name), source.sha256);
    writeJson(path.join(stage, 'source/source-snapshot.json'), { sourceSnapshot: source.sourceSnapshot, archive: name,
      sha256: source.sha256, files: source.files, workingTreeDirty: source.workingTreeDirty });
    for (const file of ['reviewer.css', 'verify_bundle.py']) await copyFile(path.join(ROOT, 'paper/reviewer', file), path.join(stage, file.endsWith('.css') ? `assets/${file}` : file));
    for (const [base] of FIGURES) {
      const manifestName = `${base}.manifest.json`;
      const figureManifest = readJson(path.join(PUBLICATION, 'figures', manifestName));
      const recorded = [...figureManifest.outputs, ...figureManifest.source_data];
      if (figureManifest.validation?.preview === true) throw new Error(`Figure is marked as a preview: ${base}`);
      for (const ext of ['pdf', 'png', 'svg', 'source.tsv', 'source.xlsx', 'legend.txt', 'legend.docx']) {
        const file = `${base}.${ext}`;
        const digest = recorded.find(item => path.basename(item.path) === file)?.sha256;
        if (!digest) throw new Error(`No figure manifest digest for ${file}`);
        await copyFile(path.join(PUBLICATION, 'figures', file), path.join(stage, 'figures', file), digest);
      }
      writeJson(path.join(stage, 'figures', manifestName), figureManifest);
      for (const item of figureManifest.outputs) {
        const file = path.basename(item.path);
        if (/^figure1b_(?:capture(?:_evidence|_network)?\.(?:json|png)|network_export\.svg)$/.test(file)) {
          await copyFile(path.join(PUBLICATION, 'figures', file), path.join(stage, 'figures', file), item.sha256);
        }
      }
    }
    const panelFile = 'figure1b_interleukin_report.source.tsv';
    await copyFile(path.join(PUBLICATION, 'figures', panelFile), path.join(stage, 'figures', panelFile));
    const cohorts = []; let primary;
    for (const cohort of manifest.cohorts.filter(item => item.enabled !== false)) {
      const collected = await collectCohort(stage, cohort, finalization.cohorts[cohort.key]);
      cohorts.push(collected.record);
      if (cohort.key === PD) primary = collected;
    }
    if (!primary) throw new Error('Missing PD cohort');
    checkFigureExample(readTsvFile(path.join(stage, 'figures', panelFile)), primary.example);
    const pages = renderPages({ ...primary, cohorts, source, figureBases: FIGURES,
      exampleBytes: fs.statSync(path.join(stage, 'reports/interleukins.report.html')).size,
      fullBytes: fs.statSync(path.join(stage, 'reports/gse68719_pd_primary.report.html')).size });
    for (const [file, html] of Object.entries(pages)) fs.writeFileSync(path.join(stage, file), html);
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
  buildReviewerPortal().catch(error => { console.error(error.message); process.exitCode = 1; });
}
