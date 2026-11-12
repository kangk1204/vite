#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeReplicationMetrics,
  countTableRows,
  metricTableToObject,
  readTsvFile,
  toTsv,
} from './lib/paper_pipeline.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

function resolveRootPath(relativePath) {
  if (typeof relativePath !== 'string' || !relativePath.trim()) {
    throw new Error('Expected a non-empty repository-relative path.');
  }
  const resolved = path.resolve(ROOT, relativePath);
  const boundary = path.relative(ROOT, resolved);
  if (boundary.startsWith('..') || path.isAbsolute(boundary)) {
    throw new Error(`Path escapes repository root: ${relativePath}`);
  }
  return resolved;
}

function loadManifest(manifestPathArg) {
  const manifestPath = resolveRootPath(manifestPathArg || 'paper/cohort_manifest.json');
  return {
    manifestPath,
    manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
  };
}

function loadRunMetadata(outputRoot) {
  const runMetadataPath = path.join(outputRoot, 'benchmarks', 'run_metadata.json');
  if (!fs.existsSync(runMetadataPath)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(runMetadataPath, 'utf8'));
}

function cohortRuntimeSeconds(runMetadata, cohort) {
  return runMetadata.jobs?.[cohort.jobKey]?.durationSeconds ?? '';
}

function comparisonFields(metrics) {
  const rounded = (value) => Number.isFinite(value) ? Number(value.toFixed(4)) : null;
  return {
    significant_pathways: metrics.significantPathwaysCohort,
    // Legacy column name retained for existing consumers; scope is explicit below.
    replicated_pathways: metrics.sharedSignificantPathways,
    direction_consistency: rounded(metrics.directionConsistency),
    leading_edge_overlap_score: rounded(metrics.leadingEdgeOverlapScore),
    direction_comparable_pathways: metrics.directionComparablePathways,
    leading_edge_comparable_pathways: metrics.leadingEdgeComparablePathways,
    comparison_scope: metrics.comparisonScope,
  };
}

function main() {
  const manifestArg = process.argv[2];
  const { manifestPath, manifest } = loadManifest(manifestArg);
  const outputRoot = resolveRootPath(manifest.outputRoot || 'paper/outputs');
  const benchmarkDir = path.join(outputRoot, 'benchmarks');
  fs.mkdirSync(benchmarkDir, { recursive: true });
  fs.mkdirSync(path.join(outputRoot, 'tables'), { recursive: true });

  const cohorts = (manifest.cohorts || []).filter((cohort) => cohort.enabled !== false);
  if (!cohorts.length) {
    throw new Error('No enabled cohorts found in manifest.');
  }

  const primaryKey = manifest.primaryCohortKey || cohorts.find((cohort) => cohort.role === 'primary')?.key;
  const primary = cohorts.find((cohort) => cohort.key === primaryKey) || cohorts[0];
  const primaryPathwayRows = readTsvFile(resolveRootPath(primary.pathwayTablePath));
  const runMetadata = loadRunMetadata(outputRoot);

  const cohortSummaryRows = [];
  const overlapRows = [];

  const primarySampleCount = countTableRows(resolveRootPath(primary.sampleMetadataPath || '')) || primary.sampleCount || '';
  const primaryMetrics = computeReplicationMetrics(primaryPathwayRows, primaryPathwayRows);
  cohortSummaryRows.push({
    cohort: primary.key,
    role: primary.role || 'primary',
    dataset_identifier: primary.datasetIdentifier || '',
    contrast: primary.contrastName || '',
    n_samples: primarySampleCount,
    ...comparisonFields(primaryMetrics),
    runtime_seconds: cohortRuntimeSeconds(runMetadata, primary),
    report_path: primary.reportPath || '',
  });

  for (const cohort of cohorts) {
    if (cohort.key === primary.key) {
      continue;
    }

    const cohortPathwayRows = readTsvFile(resolveRootPath(cohort.pathwayTablePath));
    const metrics = computeReplicationMetrics(primaryPathwayRows, cohortPathwayRows);
    const sampleCount = countTableRows(resolveRootPath(cohort.sampleMetadataPath || '')) || cohort.sampleCount || '';
    const summaryMetricMap = cohort.summaryTablePath
      ? metricTableToObject(readTsvFile(resolveRootPath(cohort.summaryTablePath)))
      : {};

    cohortSummaryRows.push({
      cohort: cohort.key,
      role: cohort.role || 'replication',
      dataset_identifier: cohort.datasetIdentifier || '',
      contrast: cohort.contrastName || '',
      n_samples: sampleCount,
      ...comparisonFields(metrics),
      runtime_seconds: cohortRuntimeSeconds(runMetadata, cohort),
      report_path: cohort.reportPath || '',
      top_up_pathway: summaryMetricMap.Top_up_pathway || '',
      top_down_pathway: summaryMetricMap.Top_down_pathway || '',
    });

    metrics.overlapRows.forEach((row) => {
      overlapRows.push({
        cohort: cohort.key,
        ...row,
      });
    });
  }

  const cohortSummaryPath = path.join(benchmarkDir, 'cohort_summary.tsv');
  const replicationSummaryPath = path.join(benchmarkDir, 'pathway_replication_summary.tsv');
  const overlapPath = path.join(outputRoot, 'tables', 'replicated_pathways.tsv');
  const leadingEdgePath = path.join(outputRoot, 'tables', 'leading_edge_overlap.tsv');
  fs.writeFileSync(cohortSummaryPath, toTsv(cohortSummaryRows), 'utf8');
  fs.writeFileSync(
    replicationSummaryPath,
    toTsv(
      cohortSummaryRows.map((row) => ({
        cohort: row.cohort,
        dataset_identifier: row.dataset_identifier,
        contrast: row.contrast,
        significant_pathways: row.significant_pathways,
        replicated_pathways: row.replicated_pathways,
        direction_consistency: row.direction_consistency,
        leading_edge_overlap_score: row.leading_edge_overlap_score,
        direction_comparable_pathways: row.direction_comparable_pathways,
        leading_edge_comparable_pathways: row.leading_edge_comparable_pathways,
        comparison_scope: row.comparison_scope,
      })),
    ),
    'utf8',
  );
  fs.writeFileSync(overlapPath, toTsv(overlapRows), 'utf8');
  fs.writeFileSync(
    leadingEdgePath,
    toTsv(
      overlapRows.map((row) => ({
        cohort: row.cohort,
        comparison_scope: row.comparison_scope,
        pathway_key: row.pathway_key,
        pathway_name: row.pathway_name,
        leading_edge_jaccard: row.leading_edge_jaccard,
        shared_leading_edge_genes: row.shared_leading_edge_genes,
      })),
    ),
    'utf8',
  );

  console.log(`Wrote cohort summary: ${path.relative(ROOT, cohortSummaryPath)}`);
  console.log(`Wrote conditional cross-context summary (legacy filename): ${path.relative(ROOT, replicationSummaryPath)}`);
  console.log(`Wrote shared-significant pathway table (legacy filename): ${path.relative(ROOT, overlapPath)}`);
  console.log(`Wrote leading-edge overlap table: ${path.relative(ROOT, leadingEdgePath)}`);
  console.log(`Manifest: ${path.relative(ROOT, manifestPath)}`);
}

main();
