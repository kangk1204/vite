#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  computeReplicationMetrics,
  readTsvFile,
  toNumber,
  toTsv,
} from './lib/paper_pipeline.mjs';
import { atomicWriteJson, artifactManifestMatches, describeArtifact, fingerprintFiles, sha256 } from './lib/provenance.mjs';
import { listFiles, REFERENCE_INPUTS, ENVIRONMENT_INPUTS } from './lib/provenance_pipeline.mjs';
import { captureRuntimeEnvironment } from './lib/provenance_run.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function isPathInsideRoot(targetPath, root = ROOT) {
  const relative = path.relative(root, targetPath);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveRootPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Expected a non-empty repository-relative path.');
  }
  const resolved = path.resolve(ROOT, relativePath);
  if (!isPathInsideRoot(resolved)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return resolved;
}

function loadManifest(manifestArg) {
  const manifestPath = resolveRootPath(manifestArg || 'paper/cohort_manifest.json');
  return {
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
}

function findCohortConfigPath(datasetIdentifier) {
  const configDir = resolveRootPath('paper/configs');
  const candidates = fs.readdirSync(configDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(configDir, name));
  for (const candidate of candidates) {
    const parsed = JSON.parse(fs.readFileSync(candidate, 'utf8'));
    if (parsed.datasetIdentifier === datasetIdentifier) {
      return candidate;
    }
  }
  throw new Error(`No cohort config found for dataset ${datasetIdentifier}`);
}

export function significantGeneSet(rows, padjThreshold = 0.05, absLfcThreshold = 1) {
  return new Set(
    rows
      .filter((row) => {
        const padj = toNumber(row.padj);
        const lfc = toNumber(row.log2FoldChange ?? row.log2fc);
        return Number.isFinite(padj) && padj >= 0 && padj <= 1 && Number.isFinite(lfc) && padj < padjThreshold && Math.abs(lfc) > absLfcThreshold;
      })
      .map((row) => String(row.gene || row.gene_symbol || '').trim())
      .filter(Boolean),
  );
}

export function jaccard(leftSet, rightSet) {
  const intersection = [...leftSet].filter((item) => rightSet.has(item)).length;
  const union = new Set([...leftSet, ...rightSet]).size;
  return union ? intersection / union : null;
}

export function formatOptionalMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(4)) : '';
}

export function buildAblationConfigPath(resultPrefix) {
  const fileStem = String(resultPrefix || '');
  if (
    !fileStem ||
    fileStem.includes('..') ||
    /[/\\]/.test(fileStem) ||
    !/^[A-Za-z0-9_.-]+$/.test(fileStem)
  ) {
    throw new Error(`Unsafe ablation resultPrefix: ${fileStem}`);
  }
  const runtimeDir = resolveRootPath('.cache/runtime/ablation-configs');
  fs.mkdirSync(runtimeDir, { recursive: true });
  return path.join(runtimeDir, `${fileStem}.json`);
}

export function makeAblationConfig(original, patch = {}, cohort = {}) {
  return {
    ...original, ...patch,
    ...(cohort.sampleMetadataPath ? { sampleMetadataPath: cohort.sampleMetadataPath } : {}),
    bootstrapReplicates: 0,
    writeFigures: false,
  };
}

function ablationTablePath(config, suffix) {
  return resolveRootPath(path.join(config.outputDir || 'results', `${config.resultPrefix}${suffix}`));
}

function runAblation(configPath, patch, env, previousRuntimeSeconds = null, cohort = {}) {
  const original = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const ablationConfig = makeAblationConfig(original, patch, cohort);
  const ablationPath = buildAblationConfigPath(ablationConfig.resultPrefix);
  atomicWriteJson(ablationPath, ablationConfig);
  const runtimeEnvironment = captureRuntimeEnvironment(ROOT);
  const inputFiles = [path.relative(ROOT, ablationPath), ablationConfig.rawCountsPath,
    ablationConfig.sampleMetadataPath || ablationConfig.seriesMatrixPath,
    'scripts/run_local_analysis.R', 'scripts/analyze_neural_bulk_cohort.R',
    ...listFiles(ROOT, 'scripts/lib', filename => /\.R$/i.test(filename)), ...REFERENCE_INPUTS, ...ENVIRONMENT_INPUTS].filter(Boolean);
  const inputs = fingerprintFiles(inputFiles, { root: ROOT });
  const fingerprint = sha256(JSON.stringify({ inputs: inputs.inputs, runtimeEnvironment }));
  const receiptPath = `${ablationPath}.receipt.json`;
  const receipt = fs.existsSync(receiptPath) ? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) : null;

  if (process.env.PNV_FORCE_RERUN !== '1' && inputs.complete && receipt?.fingerprint === fingerprint && artifactManifestMatches(receipt.artifacts, { root: ROOT })) {
    return {
      config: ablationConfig,
      runtimeSeconds: Number.isFinite(receipt.runtimeSeconds) ? receipt.runtimeSeconds : previousRuntimeSeconds,
    };
  }

  const startedAt = Date.now();
  const entrypoint = ablationConfig.sampleMetadataPath ? 'scripts/run_local_analysis.R' : 'scripts/analyze_neural_bulk_cohort.R';
  const logPath = ablationTablePath(ablationConfig, '_run.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'w');
  console.log(`Running same-sample sensitivity with zero bootstraps: ${ablationConfig.resultPrefix}`);
  try {
    execFileSync('Rscript', [entrypoint, ablationPath], { cwd: ROOT, stdio: ['ignore', logFd, logFd], env });
  } catch (error) {
    throw new Error(`Ablation failed; inspect ${path.relative(ROOT, logPath)}`, { cause: error });
  } finally { fs.closeSync(logFd); }
  const runtimeSeconds = Number(((Date.now() - startedAt) / 1000).toFixed(2));
  const completedInputs = fingerprintFiles(inputFiles, { root: ROOT });
  const completedFingerprint = sha256(JSON.stringify({ inputs: completedInputs.inputs, runtimeEnvironment: captureRuntimeEnvironment(ROOT) }));
  if (completedFingerprint !== fingerprint) throw new Error('Ablation inputs, code or environment changed during execution; receipt publication refused.');
  const artifacts = ['_fgsea_reactome.tsv', '_deseq2.tsv', '_sample_metadata.tsv', '_evidence.json', '_camera.tsv', '_run.log']
    .map(suffix => describeArtifact('output', path.relative(ROOT, ablationTablePath(ablationConfig, suffix)), { root: ROOT }));
  atomicWriteJson(receiptPath, { fingerprint, artifacts, inputs: inputs.inputs, runtimeEnvironment, runtimeSeconds });
  return {
    config: ablationConfig,
    runtimeSeconds,
  };
}

function main() {
  const manifestArg = process.argv[2];
  const { manifest } = loadManifest(manifestArg);
  const outputRoot = resolveRootPath(manifest.outputRoot || 'paper/outputs');
  const benchmarkDir = path.join(outputRoot, 'benchmarks');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  const outputPath = path.join(benchmarkDir, 'ablation_summary.tsv');
  const previousRows = fs.existsSync(outputPath) ? readTsvFile(outputPath) : [];
  const previousRuntimeByPrefix = new Map(
    previousRows.map((row) => [row.ablation_result_prefix, Number.isFinite(toNumber(row.runtime_seconds)) ? toNumber(row.runtime_seconds) : null]),
  );

  const env = { ...process.env };
  const ablations = Array.isArray(manifest.ablations) ? manifest.ablations : [];
  if (!ablations.length) {
    fs.writeFileSync(outputPath, '', 'utf8');
    console.log(`No ablations declared; wrote empty ablation summary: ${path.relative(ROOT, outputPath)}`);
    return;
  }

  const rows = [];
  for (const ablation of ablations) {
    const cohort = (manifest.cohorts || []).find((entry) => entry.key === ablation.cohortKey);
    if (!cohort) {
      throw new Error(`Cohort not found in manifest: ${ablation.cohortKey}`);
    }
    const configPath = cohort.configPath ? resolveRootPath(cohort.configPath) : findCohortConfigPath(cohort.datasetIdentifier);
    const previousRuntimeSeconds = previousRuntimeByPrefix.get(ablation.patch?.resultPrefix) ?? null;
    const { config, runtimeSeconds } = runAblation(configPath, ablation.patch, env, previousRuntimeSeconds, cohort);

    const referencePathways = readTsvFile(resolveRootPath(cohort.pathwayTablePath));
    const ablationPathways = readTsvFile(ablationTablePath(config, '_fgsea_reactome.tsv'));
    const metrics = computeReplicationMetrics(referencePathways, ablationPathways);

    const referenceDeg = readTsvFile(resolveRootPath(cohort.degTablePath));
    const ablationDeg = readTsvFile(ablationTablePath(config, '_deseq2.tsv'));
    const referenceGenes = significantGeneSet(referenceDeg);
    const ablationGenes = significantGeneSet(ablationDeg);

    rows.push({
      cohort: cohort.key,
      dataset_identifier: cohort.datasetIdentifier,
      ablation_name: ablation.ablationName || ablation.name || 'ablation',
      reference_design: cohort.batchHandlingRule,
      ablation_design: config.designFormula,
      reference_significant_pathways: metrics.significantPathwaysPrimary,
      ablation_significant_pathways: metrics.significantPathwaysCohort,
      shared_significant_pathways: metrics.sharedSignificantPathways,
      direction_consistency: formatOptionalMetric(metrics.directionConsistency),
      leading_edge_overlap_score: formatOptionalMetric(metrics.leadingEdgeOverlapScore),
      direction_comparable_pathways: metrics.directionComparablePathways,
      leading_edge_comparable_pathways: metrics.leadingEdgeComparablePathways,
      comparison_scope: 'conditional_same_sample_design_sensitivity',
      reference_significant_genes: referenceGenes.size,
      ablation_significant_genes: ablationGenes.size,
      significant_gene_jaccard: formatOptionalMetric(jaccard(referenceGenes, ablationGenes)),
      runtime_seconds: runtimeSeconds,
      ablation_result_prefix: config.resultPrefix,
      run_log_path: path.relative(ROOT, ablationTablePath(config, '_run.log')),
    });
  }

  fs.writeFileSync(outputPath, toTsv(rows), 'utf8');
  console.log(`Wrote ablation summary: ${path.relative(ROOT, outputPath)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
