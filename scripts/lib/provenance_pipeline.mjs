import fs from 'node:fs';
import path from 'node:path';
import { fingerprintFiles, sha256, resolveArtifactPath } from './provenance.mjs';

export function listFiles(root, directory, accept = () => true) {
  const absolute = resolveArtifactPath(directory, { root });
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinked source input is not supported: ${relative}`);
    return entry.isDirectory() ? listFiles(root, relative, accept) : accept(relative) ? [relative] : [];
  }).sort();
}

export const REFERENCE_INPUTS = [
  'data/reference/ReactomePathways.gmt.zip',
  'data/reference/manifest.json',
  'src/reference/generated/ncbi_gene_map.json',
  'src/reference/generated/pathways.json',
  'src/reference/generated/aliases.json',
  'src/reference/generated/metadata.json',
  'src/reference/generated/ppi.json',
  'src/reference/generated/huri.json',
];

export const ENVIRONMENT_INPUTS = [
  'renv.lock', 'package-lock.json',
  { path: 'Dockerfile', required: false },
  { path: 'requirements.txt', required: false },
  { path: 'requirements.lock.txt', required: false },
  { path: '.Rprofile', required: false },
  { path: '.Renviron', required: false },
];

const INPUT_KEYS = new Set(['rawCountsPath', 'seriesMatrixPath', 'sampleMetadataPath', 'referencePath', 'geneMapPath']);

function nestedInputs(value) {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, item]) => {
    if (INPUT_KEYS.has(key) && typeof item === 'string') return [item];
    if (key === 'inputPaths' && Array.isArray(item)) return item.filter(entry => typeof entry === 'string');
    return typeof item === 'object' ? nestedInputs(item) : [];
  });
}

export function jobInputFiles(commands, manifestPath, root) {
  const direct = commands.flatMap(command => command.slice(1).filter(argument =>
    typeof argument === 'string' && !argument.startsWith('-') && /\.(json|mjs|js|ts|r|py|sh)$/i.test(argument),
  ));
  const referenced = direct.filter(filename => filename.endsWith('.json')).flatMap(filename => {
    const absolute = resolveArtifactPath(filename, { root });
    return fs.existsSync(absolute) ? nestedInputs(JSON.parse(fs.readFileSync(absolute, 'utf8'))) : [];
  });
  const legacyInputs = direct.includes('scripts/analyze_gse121212_psoriasis.R')
    ? ['data/raw/GSE121212_readcount.txt.gz', 'data/raw/GSE121212_series_matrix.txt.gz', '.cache/reference/ReactomePathways.gmt.zip'] : [];
  return [path.relative(root, manifestPath), ...direct, ...referenced, ...legacyInputs,
    'scripts/run_paper_benchmark.mjs', 'scripts/lib/provenance_pipeline.mjs', 'scripts/lib/provenance_run.mjs', 'scripts/lib/provenance.mjs',
    ...listFiles(root, 'scripts/lib', filename => /\.R$/i.test(filename)),
    ...REFERENCE_INPUTS, ...ENVIRONMENT_INPUTS];
}

export function reportFingerprint(cohort, root) {
  const evidencePath = evidencePathForCohort(cohort);
  const paths = [cohort.workbookPath,
    { path: evidencePath, required: false },
    'scripts/build_report_from_workbook.mjs', 'package-lock.json',
    ...listFiles(root, 'src'),
    ...listFiles(root, 'scripts/lib', filename => /provenance.*\.mjs$/.test(filename)),
  ].filter(Boolean);
  return fingerprintFiles(paths, { root }).fingerprint;
}

export function evidencePathForCohort(cohort) {
  return cohort.evidencePath || cohort.workbookPath.replace(/_pathway_viewer_input\.xlsx$/i, '_evidence.json').replace(/\.xlsx$/i, '_evidence.json');
}

export function fingerprintDescriptor(commands, cohorts, manifestPath, gitCommit, referenceVersion, { root, environment = {} }) {
  const descriptor = fingerprintFiles(jobInputFiles(commands, manifestPath, root), { root });
  return { ...descriptor, fingerprint: sha256(JSON.stringify({ commands, cohorts, gitCommit, referenceVersion, environment, inputs: descriptor.inputs })) };
}
