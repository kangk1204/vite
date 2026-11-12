import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { atomicWriteJson, describeArtifact, sourceTableFromTsv, verifyArtifacts } from './provenance.mjs';

export function captureRuntimeEnvironment(projectRoot) {
  const code = 'p <- c("DESeq2","fgsea","apeglm","limma","edgeR","jsonlite","writexl"); direct <- setNames(lapply(p,function(x) if(requireNamespace(x,quietly=TRUE)) as.character(packageVersion(x)) else NULL),p); n <- sort(loadedNamespaces()); cat(jsonlite::toJSON(list(R=R.version.string, packages=direct, loadedNamespaces=setNames(lapply(n,function(x)as.character(packageVersion(x))),n), externalSoftware=as.list(extSoftVersion()), libraryPaths=.libPaths()),auto_unbox=TRUE,null="null"))';
  const r = JSON.parse(execFileSync('Rscript', ['-e', code], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 1024 * 1024 }));
  return { node: process.versions.node, platform: process.platform, architecture: process.arch, ...r };
}

export function enrichEvidenceFile(evidencePath, { root, projectRoot, runId, specs, tables = {}, extraChecks = [] }) {
  const sidecar = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  if (sidecar.schemaVersion !== 2 || !sidecar.evidence || typeof sidecar.evidence !== 'object') {
    throw new Error('R engine did not emit schema v2 evidence.');
  }
  const captured = Array.isArray(sidecar.evidence.executionCapture?.artifacts) ? sidecar.evidence.executionCapture.artifacts
    : Array.isArray(sidecar.evidence.executionArtifacts) ? sidecar.evidence.executionArtifacts : [];
  if (captured.length && verifyArtifacts(captured, { root, projectRoot }).status === 'mismatch') {
    throw new Error('Previously captured execution artifacts no longer match; refusing to replace original hashes with current files.');
  }
  const current = specs.map(({ role, path: filename }) => describeArtifact(role, filename, { root, projectRoot }));
  const artifacts = [...new Map([...captured, ...current].map(artifact => [`${artifact.role}:${artifact.path}`, artifact])).values()];
  const verified = verifyArtifacts(artifacts, { root, projectRoot });
  const existingChecks = Array.isArray(sidecar.evidence.verification?.checks)
    ? sidecar.evidence.verification.checks.filter(check => !check.id?.startsWith('artifact:')) : [];
  const sourceTables = Object.fromEntries(Object.entries(tables).map(([name, filename]) => [name, sourceTableFromTsv(filename)]));
  const evidence = {
    ...sidecar.evidence,
    executionArtifacts: captured,
    runId,
    artifacts,
    sourceTables: { ...(sidecar.evidence.sourceTables || {}), ...sourceTables },
    verification: {
      ...verified,
      status: existingChecks.some(check => check.status === 'fail') || extraChecks.some(check => check.status === 'fail') ? 'mismatch' : verified.status,
      checks: [...existingChecks, ...extraChecks, ...verified.checks],
      limitations: [...new Set([...(sidecar.evidence.verification?.limitations || []), ...verified.limitations])],
    },
  };
  atomicWriteJson(evidencePath, { schemaVersion: 2, evidence });
  return evidence;
}

export function stageDirectory(outputPath, produce) {
  const output = path.resolve(outputPath);
  const parent = path.dirname(output);
  fs.mkdirSync(parent, { recursive: true });
  if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('Output directory must not be a symlink.');
  if (fs.existsSync(output) && !fs.statSync(output).isDirectory()) throw new Error('Output path must be a directory.');
  const stage = fs.mkdtempSync(path.join(parent, '.pnv-stage-'));
  let backup;
  try {
    const result = produce(stage);
    if (fs.existsSync(output)) {
      backup = `${stage}.previous`;
      fs.renameSync(output, backup);
    }
    try {
      fs.renameSync(stage, output);
    } catch (error) {
      if (backup) fs.renameSync(backup, output);
      throw error;
    }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    return result;
  } finally {
    if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true });
  }
}

export function promoteFiles(stagingDirectory, mappings) {
  if (new Set(mappings.map(entry => path.resolve(entry.target))).size !== mappings.length) throw new Error('Publication targets must be distinct.');
  for (const entry of mappings) {
    if (!fs.existsSync(entry.source) || !fs.lstatSync(entry.source).isFile()) throw new Error(`Staged publication source must be a regular file: ${entry.source}`);
    if (fs.existsSync(entry.target) && !fs.lstatSync(entry.target).isFile()) throw new Error(`Publication target must be a regular file, not a directory or symlink: ${entry.target}`);
  }
  const backups = [];
  const published = [];
  try {
    for (const [index, entry] of mappings.entries()) {
      fs.mkdirSync(path.dirname(entry.target), { recursive: true });
      if (fs.existsSync(entry.target)) {
        const backup = path.join(stagingDirectory, `previous-${index}`);
        fs.renameSync(entry.target, backup);
        backups.push({ source: backup, target: entry.target });
      }
    }
    for (const entry of mappings) {
      fs.renameSync(entry.source, entry.target);
      published.push(entry.target);
    }
  } catch (error) {
    for (const filename of published) if (fs.existsSync(filename)) fs.unlinkSync(filename);
    for (const entry of backups) if (fs.existsSync(entry.source)) fs.renameSync(entry.source, entry.target);
    throw error;
  }
}
