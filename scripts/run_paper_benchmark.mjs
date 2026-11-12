#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import metadata from '../src/reference/generated/metadata.json' with { type: 'json' };
import { atomicWriteJson, artifactManifestMatches, describeArtifact, createRunCrate, resolveArtifactPath } from './lib/provenance.mjs';
import { fingerprintDescriptor, reportFingerprint, evidencePathForCohort } from './lib/provenance_pipeline.mjs';
import { captureRuntimeEnvironment, enrichEvidenceFile, promoteFiles } from './lib/provenance_run.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const ALLOWED_JOB_EXECUTABLES = new Set(['Rscript', 'node', 'python3', '.venv/bin/python']);

function getGitCommit() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: ROOT,
      encoding: 'utf8',
    }).trim() || 'unknown';
  } catch {
    return 'unknown';
  }
}

function getReferenceAssetVersion() {
  return [
    `reactome-${metadata.reactomePathways}`,
    `hallmark-${metadata.hallmarkPathways}`,
    `string-${metadata.stringScoreCutoff}`,
    `huri-${metadata.huriPpiEdges ?? 0}`,
    `mode-${metadata.hallmarkMode}`,
  ].join('.');
}

export function isPathInsideRoot(targetPath, root = ROOT) {
  const relative = path.relative(root, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

export function resolveRootPath(relativePath, root = ROOT) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Expected a non-empty repository-relative path.');
  }
  const resolved = path.resolve(root, relativePath);
  if (!isPathInsideRoot(resolved, root)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return resolveArtifactPath(path.relative(root, resolved) || '.', { root });
}

export function loadManifest(manifestArg, root = ROOT) {
  const manifestPath = resolveRootPath(manifestArg || 'paper/cohort_manifest.json', root);
  return {
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
}

function ensureOutputDirs(outputRoot) {
  for (const directory of ['figures', 'tables', 'reports', 'benchmarks']) {
    fs.mkdirSync(path.join(outputRoot, directory), { recursive: true });
  }
}

function loadExistingRunMetadata(outputRoot) {
  const runMetadataPath = path.join(outputRoot, 'benchmarks', 'run_metadata.json');
  if (!fs.existsSync(runMetadataPath)) {
    return {};
  }
  try {
    return JSON.parse(fs.readFileSync(runMetadataPath, 'utf8'));
  } catch {
    return {};
  }
}

function ensureRuntimeCacheDirs() {
  const cacheRoot = path.join(ROOT, '.cache', 'runtime');
  const mplConfigDir = path.join(cacheRoot, 'matplotlib');
  const xdgCacheHome = path.join(cacheRoot, 'xdg');
  for (const directory of [cacheRoot, mplConfigDir, xdgCacheHome]) {
    fs.mkdirSync(directory, { recursive: true });
  }
  return { cacheRoot, mplConfigDir, xdgCacheHome };
}

export function normalizeJobCommands(job) {
  const commandGroups = job.commands ?? (job.command ? [job.command] : []);
  if (!Array.isArray(commandGroups) || !commandGroups.length) {
    throw new Error(`Job ${job.key || '<unknown>'} must define command as argv array or commands as argv arrays.`);
  }
  return commandGroups.map((command, index) => {
    if (!Array.isArray(command)) {
      throw new Error(`Job ${job.key || '<unknown>'} command ${index + 1} must be an argv array; shell strings are not allowed.`);
    }
    if (!command.length || command.some((entry) => typeof entry !== 'string' || !entry.length)) {
      throw new Error(`Job ${job.key || '<unknown>'} command ${index + 1} contains an empty or non-string argv entry.`);
    }
    const executable = command[0];
    if (!ALLOWED_JOB_EXECUTABLES.has(executable)) {
      throw new Error(`Job ${job.key || '<unknown>'} executable is not allowed: ${executable}`);
    }
    if (executable.includes('/') || executable.includes('\\')) {
      // The sole allowlisted repository executable is a virtualenv interpreter,
      // which legitimately symlinks to the installed Python outside the repo.
      if (!isPathInsideRoot(path.resolve(ROOT, executable))) throw new Error('Interpreter path escapes the repository.');
    }
    if (!command[1] || command[1].startsWith('-')) throw new Error(`Job ${job.key || '<unknown>'} must name a repository script; inline executable code is not accepted.`);
    resolveRootPath(command[1]);
    return command;
  });
}

export function describeJobFingerprint(job, cohortsForJob, manifestPath, gitCommit, referenceAssetVersion, options = {}) {
  const commands = [...(job.prepareCommands?.length ? normalizeJobCommands({ key: `${job.key}:prepare`, commands: job.prepareCommands }) : []), ...normalizeJobCommands(job)];
  return fingerprintDescriptor(commands, cohortsForJob, manifestPath, gitCommit, referenceAssetVersion, { root: ROOT, ...options });
}

export function computeJobFingerprint(job, cohortsForJob, manifestPath, gitCommit, referenceAssetVersion, options = {}) {
  return describeJobFingerprint(job, cohortsForJob, manifestPath, gitCommit, referenceAssetVersion, options).fingerprint;
}

function runJob(job, env) {
  const startedAt = Date.now();
  for (const command of normalizeJobCommands(job)) {
    const [file, ...args] = command;
    execFileSync(file, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env,
    });
  }
  return Number(((Date.now() - startedAt) / 1000).toFixed(2));
}

export function prepareJobInputs(job, { root = ROOT, execute = execFileSync } = {}) {
  if (job.prepareCommands?.length) {
    for (const command of normalizeJobCommands({ key: `${job.key}:prepare`, commands: job.prepareCommands })) {
      execute(command[0], command.slice(1), { cwd: root, stdio: 'inherit' });
    }
  }
  for (const command of normalizeJobCommands(job)) {
    if (command[0] === 'Rscript' && command[1] === 'scripts/prepare_airway_case.R' && command[2]) {
      const output = resolveRootPath(command[2], root);
      if (!fs.existsSync(path.join(output, 'airway_counts.tsv')) || !fs.existsSync(path.join(output, 'airway_samples.tsv'))) {
        execute(command[0], command.slice(1), { cwd: root, stdio: 'inherit' });
      }
    }
  }
  for (const command of normalizeJobCommands(job)) {
    for (const argument of command.slice(1).filter(value => value.endsWith('.json'))) {
      const configFile = resolveRootPath(argument, root);
      if (!fs.existsSync(configFile)) continue;
      const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      for (const prefix of ['rawCounts', 'seriesMatrix']) {
        if (!config[`${prefix}Path`]) continue;
        const destination = resolveRootPath(config[`${prefix}Path`], root);
        if (fs.existsSync(destination)) continue;
        const url = config[`${prefix}Url`];
        if (!url || new URL(url).protocol !== 'https:') throw new Error(`Missing ${prefix} input; supply it before running the benchmark.`);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const temporary = `${destination}.${process.pid}.download`;
        try {
          execute('Rscript', ['-e', 'a <- commandArgs(TRUE); download.file(a[1], a[2], mode="wb", quiet=TRUE)', url, temporary], { cwd: root, stdio: 'inherit' });
          fs.renameSync(temporary, destination);
        } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
      }
    }
  }
}

export function canReuseCohortOutputs(cohort, root = ROOT) {
  const required = cohortOutputPaths(cohort);
  if (!required.length) return false;
  return required.every(relativePath => {
    const absolutePath = resolveRootPath(relativePath, root);
    return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile() && fs.statSync(absolutePath).size > 0;
  });
}

function cohortOutputPaths(cohort, { analysisOnly = false } = {}) {
  return [
    cohort.workbookPath,
    ...(!analysisOnly ? [cohort.reportPath] : []),
    cohort.degTablePath,
    cohort.pathwayTablePath,
    cohort.summaryTablePath,
    cohort.sampleMetadataPath,
    ...(cohort.figurePaths || []),
  ].filter(Boolean);
}

export function collectCohortArtifacts(cohort, root = ROOT, options = {}) {
  const required = cohortOutputPaths(cohort, options);
  const evidence = evidencePathForCohort(cohort);
  if (fs.existsSync(resolveRootPath(evidence, root))) {
    required.push(evidence);
    const prefix = evidence.replace(/_evidence\.json$/i, '');
    for (const suffix of ['_camera.tsv', '_bootstrap_failures.json', '_gene_mapping.tsv', '_filtered_genes.tsv', '_reference_input.rds']) {
      if (fs.existsSync(resolveRootPath(`${prefix}${suffix}`, root))) required.push(`${prefix}${suffix}`);
    }
    if (!options.analysisOnly && cohort.reportPath) required.push(
      cohort.reportPath.replace(/\.html$/i, '.viewer.json'),
      cohort.reportPath.replace(/\.html$/i, '.ro-crate.json'),
    );
  }
  if (!options.analysisOnly && cohort.reportPath) {
    for (const suffix of ['.viewer.json', '.ro-crate.json']) {
      const filename = cohort.reportPath.replace(/\.html$/i, suffix);
      if (fs.existsSync(resolveRootPath(filename, root))) required.push(filename);
    }
  }
  return [...new Set(required)].map(filename => describeArtifact('output', filename, { root }));
}

export function canReuseRecordedOutputs(cohort, recorded, root = ROOT, options = {}) {
  if (!Array.isArray(recorded) || !recorded.length) return false;
  const required = cohortOutputPaths(cohort, options);
  const byPath = new Map(recorded.map(artifact => [artifact.path, artifact]));
  return required.length > 0 && required.every(filename => byPath.has(filename)) && artifactManifestMatches(recorded, { root });
}

export function shouldRebuildReport({ forceRerun, jobReran, outputsMatch, fingerprint, previousFingerprint }) {
  return Boolean(forceRerun || jobReran || !outputsMatch || !fingerprint || fingerprint !== previousFingerprint);
}

function copyIfPresent(sourcePath, destinationPath) {
  if (!sourcePath) {
    return;
  }
  const absoluteSource = resolveRootPath(sourcePath);
  const absoluteDestination = path.resolve(destinationPath);
  if (!isPathInsideRoot(absoluteDestination)) {
    throw new Error(`Destination path escapes repository root: ${destinationPath}`);
  }
  if (!fs.existsSync(absoluteSource)) {
    throw new Error(`Expected output not found: ${sourcePath}`);
  }
  fs.mkdirSync(path.dirname(absoluteDestination), { recursive: true });
  if (absoluteSource === absoluteDestination) {
    return;
  }
  fs.copyFileSync(absoluteSource, absoluteDestination);
}

function buildReportForCohort(cohort, gitCommit, referenceAssetVersion, analysisTimestamp, stagingDirectory) {
  const workbookPath = resolveRootPath(cohort.workbookPath);
  const reportPath = path.join(stagingDirectory, path.basename(cohort.reportPath));
  const args = [
    'scripts/build_report_from_workbook.mjs',
    workbookPath,
    reportPath,
    '--dataset-id', cohort.datasetIdentifier,
    '--contrast-definition', cohort.contrastDefinition,
    '--sample-group-source', cohort.sampleGroupSource,
    '--batch-handling-rule', cohort.batchHandlingRule,
    '--analysis-timestamp', analysisTimestamp,
    '--git-commit', gitCommit,
    '--reference-asset-version', referenceAssetVersion,
  ];
  if (cohort.notes) {
    args.push('--notes', cohort.notes);
  }
  const evidencePath = resolveRootPath(evidencePathForCohort(cohort));
  if (fs.existsSync(evidencePath)) args.push('--evidence', evidencePath);
  args.push('--viewer-json', reportPath.replace(/\.html$/i, '.viewer.json'), '--condition', 'full');
  execFileSync('node', args, {
    cwd: ROOT,
    stdio: 'inherit',
  });
  return { reportPath, viewerPath: reportPath.replace(/\.html$/i, '.viewer.json') };
}

function updateCohortEvidence(cohort, jobDescriptor, environmentPath) {
  const evidencePath = resolveRootPath(evidencePathForCohort(cohort));
  if (!fs.existsSync(evidencePath)) return null; // Legacy studies remain explicitly unverified.
  const specs = jobDescriptor.inputs.filter(input => input.sha256).map(input => ({
    role: /raw_counts|counts\.(tsv|txt)/i.test(input.path) ? 'raw_counts'
      : /reference\/|reference\/generated/.test(input.path) ? 'reference'
        : /\.R$/i.test(input.path) ? 'analysis_code' : 'analysis_input',
    path: `project:${input.path}`,
  }));
  const outputRoles = [
    ['workbook', cohort.workbookPath], ['gene_results', cohort.degTablePath],
    ['pathway_results', cohort.pathwayTablePath], ['sample_metadata', cohort.sampleMetadataPath],
    ['environment', path.relative(ROOT, environmentPath)],
  ];
  specs.push(...outputRoles.filter(([, filename]) => filename).map(([role, filename]) => ({ role, path: `project:${filename}` })));
  const evidence = enrichEvidenceFile(evidencePath, {
    root: path.dirname(evidencePath), projectRoot: ROOT,
    runId: jobDescriptor.fingerprint, specs,
    tables: Object.fromEntries([
      ['genes', cohort.degTablePath], ['pathways', cohort.pathwayTablePath], ['samples', cohort.sampleMetadataPath],
    ].filter(([, filename]) => filename).map(([name, filename]) => [name, resolveRootPath(filename)])),
  });
  return evidence;
}

function resolvePythonForPaperFigures() {
  const venvPython = path.join(ROOT, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
}

function main() {
  const manifestArg = process.argv[2];
  const { manifestPath, manifest } = loadManifest(manifestArg);
  const outputRoot = resolveRootPath(manifest.outputRoot || 'paper/outputs');
  const cohorts = (manifest.cohorts || []).filter((cohort) => cohort.enabled !== false);
  const jobs = manifest.jobs || [];
  const gitCommit = getGitCommit();
  const referenceAssetVersion = getReferenceAssetVersion();
  const analysisTimestamp = new Date().toISOString();
  const runtimeCacheDirs = ensureRuntimeCacheDirs();
  const env = {
    ...process.env,
    PNV_GIT_COMMIT: gitCommit,
    PNV_REFERENCE_ASSET_VERSION: referenceAssetVersion,
    MPLCONFIGDIR: runtimeCacheDirs.mplConfigDir,
    XDG_CACHE_HOME: runtimeCacheDirs.xdgCacheHome,
    MPLBACKEND: 'Agg',
  };

  ensureOutputDirs(outputRoot);
  const previousRunMetadata = loadExistingRunMetadata(outputRoot);
  const runtimeEnvironment = captureRuntimeEnvironment(ROOT);
  const environmentPath = path.join(outputRoot, 'benchmarks', 'environment.json');
  atomicWriteJson(environmentPath, runtimeEnvironment);

  const requiredJobs = new Set(cohorts.map((cohort) => cohort.jobKey));
  const cohortsByJobKey = new Map();
  for (const cohort of cohorts) {
    const list = cohortsByJobKey.get(cohort.jobKey) ?? [];
    list.push(cohort);
    cohortsByJobKey.set(cohort.jobKey, list);
  }
  const forceRerun = process.env.PNV_FORCE_RERUN === '1';
  const runMetadata = {
    manifestPath: path.relative(ROOT, manifestPath),
    gitCommit,
    referenceAssetVersion,
    analysisTimestamp,
    runtimeEnvironment,
    jobs: {},
    cohorts: {},
  };
  const jobDescriptors = new Map();

  for (const job of jobs) {
    if (!requiredJobs.has(job.key)) {
      continue;
    }
    const cohortsForJob = cohortsByJobKey.get(job.key) ?? [];
    prepareJobInputs(job);
    const descriptor = describeJobFingerprint(job, cohortsForJob, manifestPath, gitCommit, referenceAssetVersion, { environment: runtimeEnvironment });
    const { fingerprint } = descriptor;
    const previousFingerprint = previousRunMetadata.jobs?.[job.key]?.fingerprint;
    const canReuse =
      !forceRerun &&
      descriptor.complete &&
      cohortsForJob.length > 0 &&
      cohortsForJob.every((cohort) => canReuseRecordedOutputs(cohort, previousRunMetadata.cohorts?.[cohort.key]?.analysisArtifacts, ROOT, { analysisOnly: true })) &&
      previousFingerprint === fingerprint;
    if (canReuse) {
      const previousDurationSeconds = previousRunMetadata.jobs?.[job.key]?.durationSeconds ?? 0;
      runMetadata.jobs[job.key] = {
        description: job.description || '',
        durationSeconds: previousDurationSeconds,
        fingerprint,
        skipped: true,
        reason: 'Reused existing cohort outputs (set PNV_FORCE_RERUN=1 to rebuild).',
      };
      console.log(`Skipping job ${job.key}: all cohort outputs already exist.`);
      jobDescriptors.set(job.key, descriptor);
      continue;
    }
    const durationSeconds = runJob(job, env);
    const completedDescriptor = describeJobFingerprint(job, cohortsForJob, manifestPath, gitCommit, referenceAssetVersion, { environment: captureRuntimeEnvironment(ROOT) });
    if (completedDescriptor.fingerprint !== descriptor.fingerprint) throw new Error(`Inputs, code or environment changed during ${job.key}; report/cache publication refused.`);
    jobDescriptors.set(job.key, completedDescriptor);
    runMetadata.jobs[job.key] = {
      description: job.description || '',
      durationSeconds,
      fingerprint: completedDescriptor.fingerprint,
      inputsComplete: completedDescriptor.complete,
      skipped: false,
    };
  }

  if (manifest.reportSchemaVersion === 2) {
    const relativeManifest = path.relative(ROOT, manifestPath);
    if (Array.isArray(manifest.ablations) && manifest.ablations.length) {
      execFileSync('node', ['scripts/run_cohort_ablation.mjs', relativeManifest], { cwd: ROOT, stdio: 'inherit', env });
    }
    execFileSync('node', ['scripts/finalize_publication_v2.mjs', relativeManifest], { cwd: ROOT, stdio: 'inherit', env });
    const finalization = JSON.parse(fs.readFileSync(path.join(outputRoot, 'benchmarks/finalization.json'), 'utf8'));
    for (const cohort of cohorts) {
      runMetadata.cohorts[cohort.key] = {
        analysisArtifacts: collectCohortArtifacts(cohort, ROOT, { analysisOnly: true }),
        artifacts: [...collectCohortArtifacts(cohort), ...finalization.cohorts[cohort.key].artifacts],
        finalization: finalization.cohorts[cohort.key],
      };
    }
    atomicWriteJson(path.join(outputRoot, 'benchmarks/manifest.snapshot.json'), { manifest, runMetadata });
    atomicWriteJson(path.join(outputRoot, 'benchmarks/run_metadata.json'), runMetadata);
    execFileSync('node', ['scripts/build_replication_summary.mjs', relativeManifest], { cwd: ROOT, stdio: 'inherit' });
    console.log(`Publication v2 analysis, sensitivity, full/basic reports and cross-context summaries complete: ${manifest.outputRoot}`);
    return;
  }

  for (const cohort of cohorts) {
    const jobReran = runMetadata.jobs[cohort.jobKey]?.skipped !== true;
    const previous = previousRunMetadata.cohorts?.[cohort.key];
    const fingerprint = reportFingerprint(cohort, ROOT);
    const rebuild = shouldRebuildReport({
      forceRerun, jobReran, fingerprint, previousFingerprint: previous?.reportFingerprint,
      outputsMatch: canReuseRecordedOutputs(cohort, previous?.artifacts),
    });
    if (rebuild) {
      const evidence = updateCohortEvidence(cohort, jobDescriptors.get(cohort.jobKey), environmentPath);
      if (evidence?.verification.status === 'mismatch') throw new Error(`Artifact mismatch while preparing ${cohort.key}; refusing to publish a new report.`);
      const beforeRender = reportFingerprint(cohort, ROOT);
      fs.mkdirSync(path.dirname(resolveRootPath(cohort.reportPath)), { recursive: true });
      const staging = fs.mkdtempSync(path.join(path.dirname(resolveRootPath(cohort.reportPath)), '.pnv-report-'));
      try {
        const staged = buildReportForCohort(cohort, gitCommit, referenceAssetVersion, analysisTimestamp, staging);
        if (reportFingerprint(cohort, ROOT) !== beforeRender) throw new Error(`Report inputs/code changed while rendering ${cohort.key}; publication refused.`);
        if (evidence && !artifactManifestMatches(evidence.artifacts, { root: path.dirname(resolveRootPath(evidencePathForCohort(cohort))), projectRoot: ROOT })) throw new Error(`Artifact content changed while rendering ${cohort.key}; publication refused.`);
        const viewer = JSON.parse(fs.readFileSync(staged.viewerPath, 'utf8'));
        if (viewer.evidence?.verification.status === 'mismatch') throw new Error(`Report evidence mismatch for ${cohort.key}; publication refused.`);
        const mappings = [{ source: staged.reportPath, target: resolveRootPath(cohort.reportPath) }, { source: staged.viewerPath, target: resolveRootPath(cohort.reportPath.replace(/\.html$/i, '.viewer.json')) }];
        if (evidence) {
          const reportArtifact = { ...describeArtifact('report', path.basename(staged.reportPath), { root: staging }), path: `project:${cohort.reportPath}` };
          const crate = path.join(staging, 'ro-crate-metadata.json');
          atomicWriteJson(crate, createRunCrate({ ...evidence, artifacts: [...evidence.artifacts, reportArtifact] }, { completed: true }));
          mappings.push({ source: crate, target: resolveRootPath(cohort.reportPath.replace(/\.html$/i, '.ro-crate.json')) });
        }
        promoteFiles(staging, mappings);
      } finally { fs.rmSync(staging, { recursive: true, force: true }); }
    } else {
      console.log(`Reusing report/workbook outputs for cohort ${cohort.key}.`);
    }
    runMetadata.cohorts[cohort.key] = {
      reportFingerprint: reportFingerprint(cohort, ROOT),
      analysisArtifacts: collectCohortArtifacts(cohort, ROOT, { analysisOnly: true }),
      artifacts: collectCohortArtifacts(cohort),
      reportRebuilt: rebuild,
    };

    copyIfPresent(cohort.reportPath, path.join(outputRoot, 'reports', path.basename(cohort.reportPath)));
    if (cohort.workbookPath) {
      copyIfPresent(cohort.workbookPath, path.join(outputRoot, 'tables', `${cohort.key}.viewer_input.xlsx`));
    }
    for (const tablePath of [cohort.degTablePath, cohort.pathwayTablePath, cohort.summaryTablePath, cohort.sampleMetadataPath]) {
      if (!tablePath) {
        continue;
      }
      copyIfPresent(tablePath, path.join(outputRoot, 'tables', `${cohort.key}.${path.basename(tablePath)}`));
    }
    for (const figurePath of cohort.figurePaths || []) {
      copyIfPresent(figurePath, path.join(outputRoot, 'figures', path.basename(figurePath)));
    }
  }

  const snapshotPath = path.join(outputRoot, 'benchmarks', 'manifest.snapshot.json');
  atomicWriteJson(snapshotPath, { manifest, runMetadata });
  atomicWriteJson(path.join(outputRoot, 'benchmarks', 'run_metadata.json'), runMetadata);

  execFileSync('node', ['scripts/build_replication_summary.mjs', manifestPath], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  const hasAblations = Array.isArray(manifest.ablations) && manifest.ablations.length > 0;
  if (hasAblations) {
    execFileSync('node', ['scripts/run_cohort_ablation.mjs', manifestPath], {
      cwd: ROOT,
      stdio: 'inherit',
      env,
    });
  } else {
    console.log('Skipping ablation stage: manifest has no ablations.');
  }

  execFileSync(resolvePythonForPaperFigures(), ['scripts/build_paper_summary_figures.py', manifestPath], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  execFileSync(resolvePythonForPaperFigures(), ['scripts/build_tool_comparison_benchmark.py', manifestPath], {
    cwd: ROOT,
    stdio: 'inherit',
  });

  if (hasAblations) {
    execFileSync(resolvePythonForPaperFigures(), ['scripts/build_ablation_figure.py', manifestPath], {
      cwd: ROOT,
      stdio: 'inherit',
    });
  }

  console.log(`Paper benchmark complete: ${path.relative(ROOT, outputRoot)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
