#!/usr/bin/env node
// Finalize captured R outputs; this command never launches the cohort/bootstrap fits.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { atomicWriteJson, artifactManifestMatches, createRunCrate, describeArtifact, fingerprintFiles, sha256, sourceTableFromTsv, verifyArtifacts, resolveArtifactPath } from './lib/provenance.mjs';
import { captureRuntimeEnvironment, enrichEvidenceFile, promoteFiles } from './lib/provenance_run.mjs';
import { listFiles } from './lib/provenance_pipeline.mjs';
import { attachTestedMembership, assertReportEnrichment } from './lib/provenance_membership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const finite = value => value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);

function rows(table) {
  return table.rows.map(row => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])));
}

function sameCell(expected, actual) {
  const missing = value => value === null || value === undefined || (typeof value === 'string' && value.trim() === '');
  if (missing(expected)) return missing(actual);
  if (typeof expected === 'number') return !missing(actual) && Number.isFinite(Number(actual)) && Math.abs(expected - Number(actual)) <= 1e-8 + 1e-8 * Math.abs(expected);
  if (typeof expected === 'boolean') return actual === expected || actual === (expected ? 'TRUE' : 'FALSE');
  return String(actual) === expected;
}

export function assertRecordedTableMatches(recorded, actual, name) {
  if (!recorded || !Array.isArray(recorded.columns) || !Array.isArray(recorded.rows)) throw new Error(`Original R evidence lacks recorded ${name} source data.`);
  if (JSON.stringify(recorded.columns) !== JSON.stringify(actual.columns) || recorded.rows.length !== actual.rows.length) throw new Error(`${name} table structure differs from recorded R output.`);
  for (let row = 0; row < recorded.rows.length; row += 1) {
    for (let column = 0; column < recorded.columns.length; column += 1) {
      if (!sameCell(recorded.rows[row][column], actual.rows[row][column])) throw new Error(`${name} differs from recorded R output at data row ${row + 1}, column ${recorded.columns[column]}.`);
    }
  }
}

export function assertWorkbookStatistics(evidence, workbookTables) {
  const mappings = [
    ['genes', 'Genes', 'gene', 'gene_symbol', { log2FoldChange: 'log2fc', padj: 'padj', pvalue: 'pvalue', stat: 'rank_metric' }],
    ['pathways', 'Pathways', 'pathway_id', 'pathway_id', { NES: 'nes', padj: 'padj', leadingEdge: 'leading_edge_genes' }],
    ['metadata', 'Samples', 'sample', 'sample_id', { group: 'group' }],
  ];
  for (const [recordedName, workbookName, recordedKey, workbookKey, columns] of mappings) {
    const recorded = evidence.sourceTables?.[recordedName], actual = workbookTables?.[workbookName];
    if (!recorded || !actual) throw new Error(`Missing recorded/workbook table: ${workbookName}`);
    const expectedRows = rows(recorded), actualRows = rows(actual);
    const actualById = new Map(actualRows.map(row => [String(row[workbookKey]), row]));
    if (expectedRows.length !== actualRows.length || actualById.size !== actualRows.length) throw new Error(`${workbookName} identities differ from recorded R output.`);
    for (const expected of expectedRows) {
      const found = actualById.get(String(expected[recordedKey]));
      if (!found) throw new Error(`${workbookName} identifier ${expected[recordedKey]} differs from recorded R output.`);
      for (const [recordedColumn, workbookColumn] of Object.entries(columns)) {
        if (!sameCell(expected[recordedColumn], found[workbookColumn])) throw new Error(`${workbookName}.${workbookColumn} for ${expected[recordedKey]} differs from recorded R output.`);
      }
    }
  }
}

export function attachDesignSensitivity(evidence, table) {
  const index = new Map(rows(table).map((row, number) => [String(row.pathway_id || String(row.pathway).split(' :: ')[0]), { row, number: number + 1 }]));
  return {
    ...evidence,
    pathways: Object.fromEntries(Object.entries(evidence.pathways || {}).map(([id, value]) => {
      const found = index.get(id);
      const sensitivity = { designFormula: '~ group', nes: finite(found?.row.NES), padj: finite(found?.row.padj),
        ...(found ? { source: { table: 'group_only_pathways', row: found.number } } : {}) };
      return [id, { ...value, designSensitivity: [sensitivity] }];
    })),
    sourceTables: { ...evidence.sourceTables, group_only_pathways: table },
  };
}

export function verifyExecutionCapture(evidence, options) {
  const captured = evidence.executionCapture?.artifacts || evidence.executionArtifacts;
  if (!Array.isArray(captured) || !captured.length) {
    return { status: 'unverifiable', checks: [{ id: 'execution-capture', status: 'unknown', message: 'No execution-time input/code hashes were recorded; current hashes cannot establish historical execution binding.' }], limitations: ['Execution-time source integrity cannot be reconstructed retrospectively.'] };
  }
  const verified = verifyArtifacts(captured, options);
  if (verified.status === 'mismatch') throw new Error('Captured execution artifacts do not match current supplied files; original hashes have not been replaced.');
  return verified;
}

function sameSamples(primary, sensitivity) {
  if ([primary, sensitivity].some(table => !table.columns.includes('sample') || !table.columns.includes('group'))) return false;
  const signature = table => rows(table).map(row => `${row.sample}\0${row.group}`).sort();
  if ([primary, sensitivity].some(table => rows(table).some(row => !row.sample || !['A','B'].includes(row.group)) || new Set(rows(table).map(row => row.sample)).size !== table.rows.length)) return false;
  return JSON.stringify(signature(primary)) === JSON.stringify(signature(sensitivity));
}

function validateReference(cohort, root, execute, environmentNow) {
  const input = resolveArtifactPath(cohort.referenceInputPath, { root });
  const report = path.join(path.dirname(input), 'reference_validation.json');
  const bindingPath = `${report}.binding.json`;
  const descriptor = fingerprintFiles([cohort.referenceInputPath, 'scripts/validate_analysis_reference.R', 'renv.lock'], { root });
  const environment = environmentNow();
  const fingerprint = sha256(JSON.stringify({ inputs: descriptor.inputs, environment }));
  const old = fs.existsSync(bindingPath) ? JSON.parse(fs.readFileSync(bindingPath, 'utf8')) : null;
  if (!old || old.fingerprint !== fingerprint || !artifactManifestMatches(old.artifacts, { root })) {
    execute('Rscript', ['scripts/validate_analysis_reference.R', input, report], { cwd: root, stdio: 'inherit' });
    const result = JSON.parse(fs.readFileSync(report, 'utf8'));
    if (result.status !== 'pass' || !Array.isArray(result.checks) || !result.checks.length || result.checks.some(check => check.pass !== true)) throw new Error(`Independent package parity failed for ${cohort.key}.`);
    if (sha256(JSON.stringify({ inputs: fingerprintFiles([cohort.referenceInputPath, 'scripts/validate_analysis_reference.R', 'renv.lock'], { root }).inputs, environment: environmentNow() })) !== fingerprint) throw new Error('Reference validation inputs or environment changed during execution.');
    atomicWriteJson(bindingPath, { fingerprint, environment, artifacts: [describeArtifact('reference_validation', path.relative(root, report), { root })] });
  }
  return report;
}

function requiredCohortPaths(cohort) {
  return [cohort.evidencePath, cohort.workbookPath, cohort.referenceInputPath, cohort.degTablePath, cohort.pathwayTablePath, cohort.sampleMetadataPath, cohort.summaryTablePath].filter(Boolean);
}

function ready(cohort, root) {
  const absent = requiredCohortPaths(cohort).filter(filename => !fs.existsSync(resolveArtifactPath(filename, { root })));
  if (absent.length) throw new Error(`${cohort.key} analysis outputs are not ready; missing: ${absent.join(', ')}. No cohort fits were started.`);
}

function prepareEvidence(cohort, ablation, root, parityReport) {
  const originalPath = resolveArtifactPath(cohort.evidencePath, { root });
  const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
  if (original.schemaVersion !== 2 || !original.evidence) throw new Error(`Invalid R evidence for ${cohort.key}.`);
  const runRoot = path.dirname(originalPath);
  const captured = verifyExecutionCapture(original.evidence, { root: runRoot, projectRoot: root });
  const specs = [
    ['workbook', cohort.workbookPath], ['gene_results', cohort.degTablePath], ['pathway_results', cohort.pathwayTablePath],
    ['included_sample_metadata', cohort.sampleMetadataPath], ['reference_validation', path.relative(root, parityReport)],
    ['reference_snapshot', cohort.referenceInputPath],
  ].map(([role, filename]) => ({ role, path: `project:${filename}` }));
  let evidence = original.evidence;
  const diagnosticChecks = [];
  const tables = { genes: resolveArtifactPath(cohort.degTablePath, { root }), pathways: resolveArtifactPath(cohort.pathwayTablePath, { root }), samples: resolveArtifactPath(cohort.sampleMetadataPath, { root }) };
  for (const [name, filename] of Object.entries(tables)) assertRecordedTableMatches(original.evidence.sourceTables?.[name === 'samples' ? 'metadata' : name], sourceTableFromTsv(filename), name);
  if (ablation) {
    const output = ablation.patch.outputDir;
    const prefix = ablation.patch.resultPrefix;
    const pathwayPath = resolveArtifactPath(`${output}/${prefix}_fgsea_reactome.tsv`, { root });
    const metadataPath = resolveArtifactPath(`${output}/${prefix}_sample_metadata.tsv`, { root });
    const ablationEvidencePath = resolveArtifactPath(`${output}/${prefix}_evidence.json`, { root });
    const logPath = resolveArtifactPath(`${output}/${prefix}_run.log`, { root });
    if (!fs.existsSync(pathwayPath) || !fs.existsSync(metadataPath) || !fs.existsSync(ablationEvidencePath)) throw new Error(`Group-only sensitivity is not ready for ${cohort.key}; run the declared ablation with bootstrapReplicates=0.`);
    const ablationEvidence = JSON.parse(fs.readFileSync(ablationEvidencePath, 'utf8')).evidence;
    if (ablationEvidence.analysis?.designFormula !== '~ group' || ablationEvidence.bootstrap?.requested !== 0) throw new Error('Group-only sensitivity must use ~ group with zero bootstrap repetitions.');
    verifyExecutionCapture(ablationEvidence, { root: path.dirname(ablationEvidencePath), projectRoot: root });
    assertRecordedTableMatches(ablationEvidence.sourceTables?.pathways, sourceTableFromTsv(pathwayPath), 'group-only pathways');
    assertRecordedTableMatches(ablationEvidence.sourceTables?.metadata, sourceTableFromTsv(metadataPath), 'group-only samples');
    if (!sameSamples(sourceTableFromTsv(tables.samples), sourceTableFromTsv(metadataPath))) throw new Error(`Sensitivity sample identities/groups differ from the primary cohort: ${cohort.key}`);
    evidence = attachDesignSensitivity(evidence, sourceTableFromTsv(pathwayPath));
    if (fs.existsSync(logPath)) {
      const log = fs.readFileSync(logPath, 'utf8');
      evidence = { ...evidence, sourceTables: { ...evidence.sourceTables, group_only_execution_log: {
        columns: ['line', 'message'], rows: log.replace(/\r/g, '\n').split('\n').filter(Boolean).map((line, index) => [index + 1, line]),
      } } };
      specs.push({ role: 'design_sensitivity_log', path: `project:${path.relative(root, logPath)}` });
      if (/line search routine failed|unable to sufficiently decrease/i.test(log)) diagnosticChecks.push({
        id: 'design-sensitivity-shrinkage-warning', status: 'unknown',
        message: 'The group-only apeglm fit emitted optimizer warnings; inspect group_only_execution_log and review displayed shrunken effects. Original DESeq2 Wald statistics, p-values and adjusted p-values are retained separately and were not replaced by shrunken effects.',
      });
    }
    tables.group_only_samples = metadataPath;
    specs.push(...[pathwayPath, metadataPath, ablationEvidencePath].map(filename => ({ role: 'design_sensitivity', path: `project:${path.relative(root, filename)}` })));
  }
  if (diagnosticChecks.length) evidence = { ...evidence, verification: { ...evidence.verification, limitations: [...(evidence.verification?.limitations || []), ...diagnosticChecks.map(check => check.message)] } };
  const reportEvidencePath = originalPath.replace(/_evidence\.json$/, '_report_evidence.json');
  // Preserve the R-produced sidecar; derived report evidence has its own filename.
  atomicWriteJson(reportEvidencePath, { schemaVersion: 2, evidence });
  let enriched = enrichEvidenceFile(reportEvidencePath, {
    root: runRoot, projectRoot: root, runId: evidence.runId || sha256(JSON.stringify(evidence.executionCapture || {})), specs, tables,
    extraChecks: [{ id: 'independent-package-parity', status: 'pass', message: 'Independent direct-package reference calls passed the recorded numerical and identity checks.' },
      ...(ablation ? [{ id: 'design-sensitivity-samples', status: 'pass', message: 'Group-only sensitivity preserved the primary included sample identities and A/B assignments.' }] : []), ...diagnosticChecks, ...captured.checks],
  });
  if (original.evidence.analysis?.method === 'DESeq2+fgsea') {
    enriched = attachTestedMembership(enriched, resolveArtifactPath(cohort.referenceInputPath, { root }), { root: runRoot, projectRoot: root });
    atomicWriteJson(reportEvidencePath, { schemaVersion: 2, evidence: enriched });
  }
  if (captured.status === 'unverifiable') {
    enriched.verification = { ...enriched.verification, status: 'internally_consistent', limitations: [...enriched.verification.limitations, ...captured.limitations] };
    atomicWriteJson(reportEvidencePath, { schemaVersion: 2, evidence: enriched });
  }
  return { evidence: enriched, evidencePath: reportEvidencePath };
}

function cohortInputFingerprint(cohort, ablation, root) {
  const extras = ablation ? [`${ablation.patch.outputDir}/${ablation.patch.resultPrefix}_fgsea_reactome.tsv`, `${ablation.patch.outputDir}/${ablation.patch.resultPrefix}_sample_metadata.tsv`, `${ablation.patch.outputDir}/${ablation.patch.resultPrefix}_evidence.json`, `${ablation.patch.outputDir}/${ablation.patch.resultPrefix}_run.log`] : [];
  return fingerprintFiles([...requiredCohortPaths(cohort), ...extras, 'scripts/build_report_from_workbook.mjs', 'scripts/finalize_publication_v2.mjs', 'scripts/validate_analysis_reference.R', 'package-lock.json', ...listFiles(root, 'src'), ...listFiles(root, 'scripts/lib', filename => /provenance.*\.mjs$/.test(filename))], { root });
}

function finalizeCohort(cohort, ablation, root, execute, previous, environmentNow) {
  const originalPath = resolveArtifactPath(cohort.evidencePath, { root });
  const original = JSON.parse(fs.readFileSync(originalPath, 'utf8'));
  verifyExecutionCapture(original.evidence, { root: path.dirname(originalPath), projectRoot: root });
  const fingerprint = cohortInputFingerprint(cohort, ablation, root);
  if (fingerprint.complete && previous?.fingerprint === fingerprint.fingerprint && artifactManifestMatches(previous.artifacts, { root })) return { ...previous, reused: true };
  const parityReport = validateReference(cohort, root, execute, environmentNow);
  const reportDirectory = path.dirname(resolveArtifactPath(cohort.reportPath, { root }));
  fs.mkdirSync(reportDirectory, { recursive: true });
  const staging = fs.mkdtempSync(path.join(reportDirectory, '.pnv-finalize-'));
  const evidencePath = originalPath.replace(/_evidence\.json$/, '_report_evidence.json');
  const evidenceBackup = path.join(staging, 'previous-report-evidence.json');
  if (fs.existsSync(evidencePath)) fs.copyFileSync(evidencePath, evidenceBackup);
  let published = false;
  try {
    const prepared = prepareEvidence(cohort, ablation, root, parityReport);
    const outputs = [], mappings = [];
    for (const condition of ['full', 'basic']) {
      const report = condition === 'full' ? cohort.reportPath : cohort.reportPath.replace(/\.report\.html$/, '.basic.report.html');
      const viewer = report.replace(/\.html$/, '.viewer.json');
      const stagedReport = path.join(staging, path.basename(report));
      const stagedViewer = path.join(staging, path.basename(viewer));
      execute('node', ['scripts/build_report_from_workbook.mjs', resolveArtifactPath(cohort.workbookPath, { root }), stagedReport, '--evidence', prepared.evidencePath, '--viewer-json', stagedViewer, '--condition', condition], { cwd: root, stdio: 'inherit' });
      outputs.push(report, viewer);
      mappings.push({ source: stagedReport, target: resolveArtifactPath(report, { root }) }, { source: stagedViewer, target: resolveArtifactPath(viewer, { root }) });
    }
    const full = JSON.parse(fs.readFileSync(mappings[1].source, 'utf8'));
    const basic = JSON.parse(fs.readFileSync(mappings[3].source, 'utf8'));
    let enrichmentParity = null;
    if (original.evidence.analysis?.method === 'DESeq2+fgsea') {
      assertWorkbookStatistics(original.evidence, full.evidence.sourceTables);
      assertWorkbookStatistics(original.evidence, basic.evidence.sourceTables);
      enrichmentParity = assertReportEnrichment(full);
      assertReportEnrichment(basic);
    }
    if (JSON.stringify(full.evidence.sourceTables) !== JSON.stringify(basic.evidence.sourceTables)) throw new Error('Full/basic raw evidence differs; finalization refused.');
    if ([full, basic].some(viewer => viewer.evidence.verification.status === 'mismatch')) throw new Error(`Rendered artifact verification failed for ${cohort.key}.`);
    const reportArtifacts = mappings.map(entry => ({ ...describeArtifact(entry.source.endsWith('.html') ? 'report' : 'viewer_json', path.basename(entry.source), { root: staging }), path: `project:${path.relative(root, entry.target)}` }));
    const crate = cohort.reportPath.replace(/\.html$/, '.ro-crate.json');
    const stagedCrate = path.join(staging, 'ro-crate-metadata.json');
    atomicWriteJson(stagedCrate, createRunCrate({ ...prepared.evidence, artifacts: [...prepared.evidence.artifacts, ...reportArtifacts] }, { name: cohort.key, completed: true }));
    mappings.push({ source: stagedCrate, target: resolveArtifactPath(crate, { root }) });
    outputs.push(crate, path.relative(root, prepared.evidencePath), path.relative(root, parityReport), `${path.relative(root, parityReport)}.binding.json`);
    verifyExecutionCapture(original.evidence, { root: path.dirname(originalPath), projectRoot: root });
    if (!artifactManifestMatches(prepared.evidence.artifacts, { root: path.dirname(prepared.evidencePath), projectRoot: root })) throw new Error('Supplied artifacts changed during rendering; publication refused.');
    if (cohortInputFingerprint(cohort, ablation, root).fingerprint !== fingerprint.fingerprint) throw new Error('Source code or results changed during finalization; publication refused.');
    promoteFiles(staging, mappings);
    published = true;
    return { fingerprint: fingerprint.fingerprint, artifacts: outputs.map(filename => describeArtifact('publication_output', filename, { root })), verification: full.evidence.verification.status, referenceParity: 'pass', enrichmentParity, fullBasicEvidenceIdentical: true, reused: false };
  } finally {
    if (!published) {
      if (fs.existsSync(evidenceBackup)) fs.renameSync(evidenceBackup, evidencePath);
      else if (fs.existsSync(evidencePath)) fs.unlinkSync(evidencePath);
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export function finalizePublication(manifestPath = 'paper/manifests/publication_v2.json', options = {}) {
  const root = options.root || ROOT, execute = options.execute || execFileSync;
  const environmentNow = () => structuredClone(options.environment ?? captureRuntimeEnvironment(root));
  const manifest = JSON.parse(fs.readFileSync(resolveArtifactPath(manifestPath, { root }), 'utf8'));
  const all = (manifest.cohorts || []).filter(cohort => cohort.enabled !== false);
  const selected = options.cohort ? all.filter(cohort => cohort.key === options.cohort) : all;
  if (!selected.length) throw new Error('No matching publication cohorts.');
  selected.forEach(cohort => ready(cohort, root));
  const receiptPath = resolveArtifactPath(`${manifest.outputRoot}/benchmarks/finalization.json`, { root });
  const previous = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : { cohorts: {} };
  let receipt = { ...previous, manifestPath, externalUserStudy: 'pending_real_participants', independentExternalRerun: 'pending', cohorts: { ...previous.cohorts } };
  for (const cohort of selected) {
    const ablation = (manifest.ablations || []).find(item => item.cohortKey === cohort.key);
    const result = finalizeCohort(cohort, ablation, root, execute, previous.cohorts?.[cohort.key], environmentNow);
    receipt = { ...receipt, cohorts: { ...receipt.cohorts, [cohort.key]: result } };
    atomicWriteJson(receiptPath, receipt);
    console.log(`${result.reused ? 'Verified existing' : 'Finalized'} publication artifacts: ${cohort.key}`);
  }
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const cohortIndex = args.indexOf('--cohort');
    const cohort = cohortIndex >= 0 ? args[cohortIndex + 1] : undefined;
    if (cohortIndex >= 0 && !cohort) throw new Error('--cohort requires a key.');
    if (args.some(value => value.startsWith('--') && value !== '--cohort')) throw new Error('Unknown finalizer option. Use [manifest.json] [--cohort key].');
    const manifest = args.find((value, index) => !value.startsWith('--') && !(cohortIndex >= 0 && index === cohortIndex + 1)) || 'paper/manifests/publication_v2.json';
    finalizePublication(manifest, { cohort });
  } catch (error) { console.error(`Publication finalization failed: ${error.message}`); process.exitCode = 1; }
}
