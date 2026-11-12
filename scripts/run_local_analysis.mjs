#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { prepareLocalInput } from './lib/local_input.mjs';
import { sha256, fingerprintFiles, describeArtifact, artifactManifestMatches, atomicWriteJson, createRunCrate, isWithin } from './lib/provenance.mjs';
import { listFiles, REFERENCE_INPUTS, ENVIRONMENT_INPUTS } from './lib/provenance_pipeline.mjs';
import { captureRuntimeEnvironment, enrichEvidenceFile, stageDirectory } from './lib/provenance_run.mjs';
import { attachTestedMembership, assertReportEnrichment } from './lib/provenance_membership.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'pnv-run.json';

export function parseLocalArgs(argv) {
  const args = { condition: 'full' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (['--output', '--condition'].includes(token)) {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${token}`);
      args[token === '--output' ? 'outputPath' : 'condition'] = value;
    } else if (token.startsWith('-')) throw new Error(`Unknown argument: ${token}`);
    else if (!args.inputPath) args.inputPath = token;
    else throw new Error('Only one input bundle is accepted.');
  }
  if (!args.inputPath || !args.outputPath) throw new Error('Usage: npm run analyze:local -- input.json --output directory [--condition full|basic]');
  if (!['full', 'basic'].includes(args.condition)) throw new Error('Condition must be full or basic.');
  return args;
}

function existingRun(output) {
  if (!fs.existsSync(output)) return null;
  if (!fs.lstatSync(output).isDirectory() || fs.lstatSync(output).isSymbolicLink()) throw new Error('Output must be a real directory.');
  const entries = fs.readdirSync(output);
  if (!entries.length) return null;
  const marker = path.join(output, MARKER);
  if (!fs.existsSync(marker)) throw new Error('Refusing to replace an unmanaged output directory. Choose a new directory.');
  const previous = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (previous.kind !== 'pnv-local-analysis-run' || previous.schemaVersion !== 1 || !Array.isArray(previous.artifacts)) throw new Error('Output has an invalid managed-run manifest.');
  const recorded = new Set(previous.artifacts.map(artifact => artifact.path));
  const unknown = listFiles(output, '.').filter(filename => filename !== MARKER && !recorded.has(filename));
  if (unknown.length) throw new Error(`Refusing to replace unmanaged files in output: ${unknown.join(', ')}`);
  return previous;
}

function canonicalOutputPath(outputPath) {
  const absolute = path.resolve(outputPath);
  if (fs.existsSync(absolute) && fs.lstatSync(absolute).isSymbolicLink()) throw new Error('Output directory must not be a symlink.');
  let ancestor = absolute;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  return path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, absolute));
}

function sourceFingerprint(root, input, condition, environment) {
  const files = fingerprintFiles([
    'scripts/run_local_analysis.R', 'scripts/run_local_analysis.mjs',
    'scripts/build_report_from_workbook.mjs',
    ...listFiles(root, 'scripts/lib'), ...listFiles(root, 'src'),
    ...REFERENCE_INPUTS, ...ENVIRONMENT_INPUTS,
  ], { root });
  return { ...files, fingerprint: sha256(JSON.stringify({ input, condition, environment, files: files.inputs })) };
}

function inputSpecs(descriptor) {
  return descriptor.inputs.filter(input => input.sha256).map(input => ({
    path: `project:${input.path}`,
    role: /reference\//.test(input.path) ? 'reference' : /\.(R|mjs)$/i.test(input.path) ? 'analysis_code' : 'software',
  }));
}

function produceRun(stage, prepared, input, descriptor, environment, condition, root, execute, environmentNow) {
  fs.writeFileSync(path.join(stage, 'raw_counts.tsv'), prepared.rawCountsText);
  fs.writeFileSync(path.join(stage, 'series_matrix.txt'), prepared.seriesMatrixText);
  fs.writeFileSync(path.join(stage, 'samples.tsv'), prepared.metadataTsv);
  atomicWriteJson(path.join(stage, 'input.json'), input);
  atomicWriteJson(path.join(stage, 'environment.json'), environment);
  atomicWriteJson(path.join(stage, 'sample_alignment.json'), { alignment: prepared.sampleAlignment, excluded: prepared.excludedSamples });
  const config = {
    ...prepared.config, resultPrefix: 'analysis', outputDir: stage,
    rawCountsPath: path.join(stage, 'raw_counts.tsv'),
    sampleMetadataPath: path.join(stage, 'samples.tsv'),
    referencePath: path.join(root, 'data/reference/ReactomePathways.gmt.zip'),
    geneMapPath: path.join(root, 'src/reference/generated/ncbi_gene_map.json'),
  };
  const configPath = path.join(stage, 'analysis_config.json');
  atomicWriteJson(configPath, config);
  execute('Rscript', ['scripts/run_local_analysis.R', configPath], { cwd: root, stdio: 'inherit' });
  if (sourceFingerprint(root, input, condition, environmentNow()).fingerprint !== descriptor.fingerprint) {
    throw new Error('Source code, references, or runtime environment changed during R analysis; no result package was published.');
  }

  const evidencePath = path.join(stage, 'analysis_evidence.json');
  const workbook = 'analysis_pathway_viewer_input.xlsx';
  const specs = [
    ...inputSpecs(descriptor),
    { role: 'raw_counts', path: 'raw_counts.tsv' },
    { role: 'sample_metadata', path: 'samples.tsv' },
    { role: 'environment', path: 'environment.json' },
    { role: 'workbook', path: workbook },
    { role: 'gene_results', path: 'analysis_deseq2.tsv' },
    { role: 'pathway_results', path: 'analysis_fgsea_reactome.tsv' },
    { role: 'analysis_input', path: 'input.json' },
  ];
  const tables = {
    genes: path.join(stage, 'analysis_deseq2.tsv'), pathways: path.join(stage, 'analysis_fgsea_reactome.tsv'),
    samples: path.join(stage, 'samples.tsv'),
  };
  for (const [name, suffix] of [['camera', '_camera.tsv'], ['gene_mapping', '_gene_mapping.tsv']]) {
    const filename = `analysis${suffix}`;
    if (fs.existsSync(path.join(stage, filename))) {
      tables[name] = path.join(stage, filename);
      specs.push({ role: name, path: filename });
    }
  }
  let evidence = enrichEvidenceFile(evidencePath, {
    root: stage, projectRoot: root, runId: descriptor.fingerprint, specs, tables,
    extraChecks: [{ id: 'sample-alignment', status: 'pass', message: 'Included sample identities were uniquely aligned to explicit A/B assignments; excluded samples are recorded.' }],
  });
  if (evidence.analysis?.method === 'DESeq2+fgsea') {
    evidence = attachTestedMembership(evidence, path.join(stage, 'analysis_reference_input.rds'), { root: stage, projectRoot: root });
    atomicWriteJson(evidencePath, { schemaVersion: 2, evidence });
  }
  if (evidence.verification.status === 'mismatch') throw new Error('Artifact content changed during analysis; no result package was published. Rerun after inputs and code are stable.');
  const report = 'analysis.report.html';
  const viewer = 'analysis.viewer.json';
  execute('node', ['scripts/build_report_from_workbook.mjs', path.join(stage, workbook), path.join(stage, report),
    '--evidence', evidencePath, '--viewer-json', path.join(stage, viewer), '--condition', condition,
  ], { cwd: root, stdio: 'inherit' });
  const viewerData = JSON.parse(fs.readFileSync(path.join(stage, viewer), 'utf8'));
  const enrichmentParity = evidence.analysis?.method === 'DESeq2+fgsea' ? assertReportEnrichment(viewerData) : null;
  if (viewerData.evidence?.verification?.status === 'mismatch' || !artifactManifestMatches(evidence.artifacts, { root: stage, projectRoot: root })) {
    throw new Error('Report/input artifacts changed during report generation; no result package was published.');
  }
  if (sourceFingerprint(root, input, condition, environmentNow()).fingerprint !== descriptor.fingerprint) {
    throw new Error('Source code, references, or runtime environment changed during report generation; no result package was published.');
  }
  const reportArtifacts = [report, viewer].map(filename => describeArtifact(filename === report ? 'report' : 'viewer_json', filename, { root: stage }));
  atomicWriteJson(path.join(stage, 'ro-crate-metadata.json'), createRunCrate({ ...evidence, artifacts: [...evidence.artifacts, ...reportArtifacts] }, { name: prepared.config.projectTitle, completed: true }));
  // analysis_config.json records the actual executed staging paths. The portable
  // replay input is input.json, accepted by this same CLI with a new output path.
  const artifacts = listFiles(stage, '.').map(filename => describeArtifact('output', filename, { root: stage }));
  atomicWriteJson(path.join(stage, MARKER), {
    schemaVersion: 1, kind: 'pnv-local-analysis-run', runId: descriptor.fingerprint,
    sourceInputsComplete: descriptor.complete, condition,
    enrichmentParity,
    artifacts, sourceInputs: descriptor.inputs,
  });
}

export function runLocalAnalysis(inputPath, outputPath, options = {}) {
  const root = options.root ?? ROOT;
  const condition = options.condition ?? 'full';
  if (!['full', 'basic'].includes(condition)) throw new Error('Unknown report condition.');
  const inputFile = fs.realpathSync(path.resolve(inputPath));
  const output = canonicalOutputPath(outputPath);
  if (isWithin(output, fs.realpathSync(root))) throw new Error('Output must not replace the project root or its ancestors.');
  if (isWithin(output, inputFile)) throw new Error('Input bundle must be outside the output directory.');
  if (fs.statSync(inputFile).size > 1024 * 1024 * 1024) throw new Error('Input bundle exceeds the 1 GiB limit.');
  const input = JSON.parse(fs.readFileSync(inputFile, 'utf8'));
  const prepared = prepareLocalInput(input);
  const previous = existingRun(output);
  const environmentNow = () => structuredClone(options.environment ?? captureRuntimeEnvironment(root));
  const environment = environmentNow();
  const originalInput = describeArtifact('original_input', path.basename(inputFile), { root: path.dirname(inputFile) });
  const descriptor = sourceFingerprint(root, input, condition, environment);
  if (previous?.runId === descriptor.fingerprint && descriptor.complete && artifactManifestMatches(previous.artifacts, { root: output })) {
    return { output, reportPath: path.join(output, 'analysis.report.html'), viewerPath: path.join(output, 'analysis.viewer.json'), reused: true };
  }
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const lock = path.join(path.dirname(output), `.${path.basename(output)}.pnv.lock`);
  let lockFd;
  try {
    lockFd = fs.openSync(lock, 'wx');
    fs.writeFileSync(lockFd, String(process.pid));
    stageDirectory(output, stage => {
      produceRun(stage, prepared, input, descriptor, environment, condition, root, options.execute ?? execFileSync, environmentNow);
      if (!artifactManifestMatches([originalInput], { root: path.dirname(inputFile) })) throw new Error('Original input bundle changed during execution; no result package was published.');
    });
  } finally {
    if (lockFd !== undefined) {
      fs.closeSync(lockFd);
      fs.unlinkSync(lock);
    }
  }
  return { output, reportPath: path.join(output, 'analysis.report.html'), viewerPath: path.join(output, 'analysis.viewer.json'), reused: false };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseLocalArgs(process.argv.slice(2));
    const result = runLocalAnalysis(args.inputPath, args.outputPath, args);
    console.log(`${result.reused ? 'Reused verified' : 'Created'} local analysis: ${result.reportPath}`);
  } catch (error) {
    console.error(`Local analysis failed: ${error.message}`);
    process.exitCode = 1;
  }
}
