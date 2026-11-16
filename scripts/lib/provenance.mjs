import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

export function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

export function resolveArtifactPath(artifactPath, { root, projectRoot = root }) {
  if (typeof artifactPath !== 'string' || !artifactPath.trim() || artifactPath.includes('\0')) {
    throw new Error('Artifact path must be a non-empty string.');
  }
  const projectScoped = artifactPath.startsWith('project:');
  const base = path.resolve(projectScoped ? projectRoot : root);
  const relative = projectScoped ? artifactPath.slice('project:'.length) : artifactPath;
  if (path.isAbsolute(relative)) throw new Error(`Artifact path is outside its allowed root: ${artifactPath}`);
  const resolved = path.resolve(base, relative);
  if (!isWithin(base, resolved)) throw new Error(`Artifact path escapes its allowed root: ${artifactPath}`);
  // Check the nearest existing ancestor too: an absent child beneath an escaping
  // symlink is not a safe destination simply because the child does not exist yet.
  let ancestor = resolved;
  while (!fs.existsSync(ancestor) && ancestor !== path.dirname(ancestor)) ancestor = path.dirname(ancestor);
  const realBase = fs.existsSync(base) ? fs.realpathSync(base) : base;
  if (!isWithin(realBase, fs.realpathSync(ancestor))) {
    throw new Error(`Artifact symlink escapes its allowed root: ${artifactPath}`);
  }
  return resolved;
}

function hashFile(filename) {
  const hash = crypto.createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(filename, 'r');
  try {
    let bytes;
    while ((bytes = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, bytes));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function describeArtifact(role, artifactPath, options) {
  const filename = resolveArtifactPath(artifactPath, options);
  const stat = fs.statSync(filename);
  if (!stat.isFile()) throw new Error(`Expected an artifact file: ${artifactPath}`);
  return { role, path: artifactPath, sha256: hashFile(filename), sizeBytes: stat.size };
}

export function fingerprintFiles(paths, options) {
  const descriptors = paths.map(entry => typeof entry === 'string' ? { path: entry, required: true } : entry);
  const unique = [...new Map(descriptors.map(entry => [entry.path, entry])).values()].sort((a, b) => a.path.localeCompare(b.path));
  const inputs = unique.map(entry => {
    try {
      return { ...describeArtifact('input', entry.path, options), required: entry.required !== false };
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error;
      return { path: entry.path, sha256: null, sizeBytes: null, required: entry.required !== false };
    }
  });
  return { fingerprint: sha256(JSON.stringify(inputs)), inputs, complete: inputs.every(entry => entry.sha256 || !entry.required) };
}

export function verifyArtifacts(artifacts, options) {
  const checks = [];
  const observations = [];
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return { status: 'unverifiable', checks: [], limitations: ['No artifact digests were supplied.'] };
  }
  for (const [index, artifact] of artifacts.entries()) {
    const id = `artifact:${index}`;
    observations.push(null);
    if (!artifact || typeof artifact.role !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      checks.push({ id, status: 'fail', message: 'Malformed artifact digest.' });
      continue;
    }
    try {
      const actual = describeArtifact(artifact.role, artifact.path, options);
      observations[index] = actual;
      const matches = actual.sha256 === artifact.sha256.toLowerCase() && actual.sizeBytes === artifact.sizeBytes;
      checks.push({ id, status: matches ? 'pass' : 'fail', message: `${artifact.path}: ${matches ? 'supplied file matches recorded bytes' : 'file digest or size does not match'}.` });
    } catch (error) {
      const absent = ['ENOENT', 'ENOTDIR'].includes(error.code);
      checks.push({ id, status: absent ? 'unknown' : 'fail', message: `${artifact.path}: ${absent ? 'file not supplied at verification' : error.message}.` });
    }
  }
  const roles = new Set(artifacts.map(artifact => artifact?.role));
  const required = ['raw_counts', 'sample_metadata', 'analysis_code', 'reference', 'environment'];
  const allPresent = required.every(role => roles.has(role));
  const failed = checks.some(check => check.status === 'fail');
  const allMatched = checks.every(check => check.status === 'pass');
  const status = failed ? 'mismatch' : allMatched && allPresent ? 'verified_against_supplied_artifacts' : checks.some(check => check.status === 'pass') ? 'internally_consistent' : 'unverifiable';
  return {
    status,
    checks,
    ...(options?.includeObservations ? { observations } : {}),
    limitations: [
      'Digest verification establishes supplied byte identity, not biological label correctness or independent reproducibility.',
      ...(!allPresent ? ['Raw counts, sample metadata, analysis code, references and environment were not all supplied.'] : []),
      ...(!allMatched && !failed ? ['Some recorded artifacts are unavailable; their current contents were not verified.'] : []),
    ],
  };
}

export function artifactManifestMatches(artifacts, options) {
  if (!Array.isArray(artifacts) || !artifacts.length) return false;
  return verifyArtifacts(artifacts, options).checks.every(check => check.status === 'pass');
}

export function atomicWriteJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
    fs.renameSync(temporary, filename);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export function sourceTableFromTsv(filename) {
  const input = fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '');
  const records = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (char === '"' && (quoted || field === '')) {
      if (quoted && input[index + 1] === '"') { field += '"'; index += 1; }
      else quoted = !quoted;
    } else if (!quoted && (char === '\t' || char === '\n' || char === '\r')) {
      row.push(field); field = '';
      if (char !== '\t') {
        records.push(row); row = [];
        if (char === '\r' && input[index + 1] === '\n') index += 1;
      }
    } else field += char;
  }
  if (quoted) throw new Error(`Unclosed quoted field in source table: ${filename}`);
  if (field !== '' || row.length) records.push([...row, field]);
  const columns = records.shift() || [];
  const rows = records.map(values => {
    if (values.length !== columns.length) throw new Error(`Non-rectangular source table: ${filename}`);
    return values.map(value => value === '' ? null : value);
  });
  return { columns, rows };
}

const CRATE_OUTPUT_ROLES = new Set([
  'workbook', 'gene_results', 'pathway_results', 'camera', 'camera_results', 'gene_mapping',
  'included_sample_metadata', 'filtered_genes', 'excluded_genes', 'normalized_counts',
  'bootstrap_results', 'bootstrap_failures', 'analysis_summary', 'reference_snapshot',
  'reference_validation', 'design_sensitivity', 'design_sensitivity_log', 'report',
  'viewer_json', 'evidence', 'report_evidence', 'fit_diagnostics',
]);

function encodedPath(relative) {
  return relative.split(path.sep).map(encodeURIComponent).join('/');
}

function crateGroups(artifacts, options) {
  const groups = new Map();
  for (const artifact of artifacts) {
    const digest = artifact.sha256.toLowerCase();
    const source = resolveArtifactPath(artifact.path, { root: options.artifactRoot, projectRoot: options.projectRoot });
    const uri = options.fileLocations?.get(artifact.path) || (isWithin(options.crateRoot, source)
      ? encodedPath(path.relative(options.crateRoot, source)) : pathToFileURL(source).href);
    const previous = groups.get(uri);
    if (previous && (previous.sha256 !== digest || previous.sizeBytes !== artifact.sizeBytes)) throw new Error(`Conflicting artifact digests for ${artifact.path}`);
    groups.set(uri, { uri, sha256: digest, sizeBytes: artifact.sizeBytes,
      paths: [...new Set([...(previous?.paths || []), artifact.path])],
      roles: [...new Set([...(previous?.roles || []), artifact.role])] });
  }
  return [...groups.values()];
}

function workflowSource(files) {
  return files.find(file => file.roles.includes('workflow_source'))
    || files.find(file => file.roles.includes('analysis_code') && file.paths.some(name => /(?:run_local_analysis|run_paper_benchmark|finalize_publication_v2)\.mjs$/i.test(name)))
    || files.find(file => file.roles.includes('analysis_code') && file.paths.some(name => /(?:run_local_analysis|analyze_neural_bulk_cohort)\.R$/i.test(name)));
}

/** Construct metadata using URI paths that resolve to files or actual absolute file URIs. */
export function createRunCrate(evidence, options = {}) {
  const { name = 'Pathway Network Viewer analysis', completed = false, datePublished = new Date().toISOString() } = options;
  const artifactRoot = path.resolve(options.artifactRoot || process.cwd());
  const projectRoot = path.resolve(options.projectRoot || artifactRoot);
  const crateRoot = path.resolve(options.crateRoot || artifactRoot);
  const files = crateGroups(evidence.artifacts || [], { ...options, artifactRoot, projectRoot, crateRoot });
  const workflow = workflowSource(files);
  const profiles = [{ '@id': 'https://w3id.org/ro/wfrun/process/0.5', '@type': 'CreativeWork', name: 'Process Run Crate', version: '0.5' }];
  if (workflow) profiles.push(
    { '@id': 'https://w3id.org/ro/wfrun/workflow/0.5', '@type': 'CreativeWork', name: 'Workflow Run Crate', version: '0.5' },
    { '@id': 'https://w3id.org/workflowhub/workflow-ro-crate/1.0', '@type': 'CreativeWork', name: 'Workflow RO-Crate', version: '1.0' },
  );
  const javascript = workflow?.paths.some(filename => /\.m?js$/i.test(filename));
  const language = javascript
    ? { '@id': 'https://www.ecma-international.org/publications-and-standards/standards/ecma-262/', '@type': 'ComputerLanguage', name: 'JavaScript' }
    : { '@id': 'https://www.r-project.org/', '@type': 'ComputerLanguage', name: 'R' };
  const toolId = workflow?.uri || '#analysis-tool';
  const runId = `#run-${encodeURIComponent(evidence.runId || 'unidentified')}`;
  const reference = file => ({ '@id': file.uri });
  const isOutput = file => file.roles.some(role => CRATE_OUTPUT_ROLES.has(role));
  const fileNodes = files.map(file => ({
    '@id': file.uri, '@type': file === workflow ? ['File', 'SoftwareSourceCode', 'ComputationalWorkflow'] : 'File',
    name: path.posix.basename(file.paths[0]), alternateName: file.paths,
    contentSize: String(file.sizeBytes), sha256: file.sha256, description: file.roles.join(', '),
    license: 'Original source-specific artifact licenses apply.',
    ...(file === workflow ? { programmingLanguage: { '@id': language['@id'] }, version: file.sha256 } : {}),
  }));
  return {
    '@context': ['https://w3id.org/ro/crate/1.1/context', 'https://w3id.org/ro/terms/workflow-run/context'],
    '@graph': [
      { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', about: { '@id': './' },
        conformsTo: [{ '@id': 'https://w3id.org/ro/crate/1.1' }, ...(workflow ? [{ '@id': 'https://w3id.org/workflowhub/workflow-ro-crate/1.0' }] : [])] },
      { '@id': './', '@type': 'Dataset', name, description: 'Inputs, software, generated results and digest records for a PNV analysis and report delivery.',
        datePublished, license: 'PNV metadata follows the project MIT license. Referenced data retain their original licenses.',
        conformsTo: profiles.map(profile => ({ '@id': profile['@id'] })),
        ...(workflow ? { mainEntity: { '@id': workflow.uri } } : {}), mentions: { '@id': runId }, hasPart: files.map(reference) },
      ...(workflow ? [language] : [{ '@id': toolId, '@type': 'SoftwareApplication', name: 'Analysis recorded by Pathway Network Viewer', description: evidence.analysis?.method || 'Method unavailable' }]),
      { '@id': runId, '@type': 'CreateAction', name: 'PNV analysis and report delivery',
        instrument: { '@id': toolId }, object: files.filter(file => !isOutput(file)).map(reference), result: files.filter(isOutput).map(reference),
        description: `Recorded analysis method ${evidence.analysis?.method || 'unknown'}. Digests identify the supplied file bytes.`,
        ...(evidence.executionCapture?.capturedAt ? { startTime: evidence.executionCapture.capturedAt } : {}),
        ...(completed ? { endTime: datePublished, actionStatus: { '@id': 'http://schema.org/CompletedActionStatus' } } : { actionStatus: { '@id': 'http://schema.org/PotentialActionStatus' } }) },
      ...profiles, ...fileNodes,
    ],
  };
}

function crateFiles(directory, prefix = '') {
  return fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = path.join(prefix, entry.name);
    if (entry.isSymbolicLink()) throw new Error('A crate contains an unexpected symlink.');
    return entry.isDirectory() ? crateFiles(directory, relative) : [relative];
  });
}

/** Materialize verified bytes so every relative File identifier remains retrievable after transfer. */
export function writeRunCrate(evidence, options) {
  const directory = path.resolve(options.directory);
  const artifactRoot = path.resolve(options.artifactRoot);
  const projectRoot = path.resolve(options.projectRoot || artifactRoot);
  const artifacts = [...(evidence.artifacts || [])];
  if (options.workflowSource) artifacts.push(describeArtifact('workflow_source', options.workflowSource, { root: artifactRoot, projectRoot }));
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.role !== 'string' || !artifact.role.trim() || typeof artifact.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) throw new Error('A crate artifact requires a role, SHA-256 digest and nonnegative byte size.');
  }
  fs.mkdirSync(path.dirname(directory), { recursive: true });
  if (fs.existsSync(directory)) {
    if (!fs.lstatSync(directory).isDirectory() || !fs.existsSync(path.join(directory, '.pnv-crate.json'))) throw new Error('Existing unmanaged crate directory is preserved.');
    const previous = JSON.parse(fs.readFileSync(path.join(directory, '.pnv-crate.json'), 'utf8'));
    const owned = new Set([...previous.files.map(file => file.path), '.pnv-crate.json']);
    if (crateFiles(directory).some(file => !owned.has(file))) throw new Error('The existing crate contains unmanaged files.');
  }
  const stage = fs.mkdtempSync(path.join(path.dirname(directory), '.pnv-crate-'));
  const destinationBoundary = path.join(fs.realpathSync(path.dirname(directory)), path.basename(directory));
  const allowedRoots = [artifactRoot, projectRoot, options.stagingRoot].filter(Boolean).map(root => fs.realpathSync(path.resolve(root)));
  const locations = new Map(), copied = new Map();
  let backup;
  try {
    for (const artifact of artifacts) {
      const declaredSource = resolveArtifactPath(artifact.path, { root: artifactRoot, projectRoot });
      const override = options.artifactSources?.get(artifact.path);
      const source = override ? path.resolve(override) : declaredSource;
      if (!allowedRoots.some(root => isWithin(root, fs.realpathSync(source)))) throw new Error('Crate source is outside the allowed roots.');
      if (isWithin(destinationBoundary, fs.realpathSync(source))) throw new Error('Crate output contains one of its source artifacts.');
      const measured = describeArtifact(artifact.role, path.basename(source), { root: path.dirname(source) });
      if (measured.sha256 !== artifact.sha256.toLowerCase() || measured.sizeBytes !== artifact.sizeBytes) throw new Error(`Artifact digest does not match: ${artifact.path}`);
      const realSource = fs.realpathSync(source);
      let relative = copied.get(realSource);
      if (!relative) {
        relative = artifact.path.startsWith('project:') ? path.join('project', artifact.path.slice('project:'.length)) : path.join('run', artifact.path);
        const destination = resolveArtifactPath(relative, { root: stage });
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.copyFileSync(source, destination, fs.constants.COPYFILE_FICLONE);
        const copiedArtifact = describeArtifact(artifact.role, relative, { root: stage });
        if (copiedArtifact.sha256 !== artifact.sha256.toLowerCase()) throw new Error('An artifact changed while the crate was being copied.');
        copied.set(realSource, relative);
      }
      locations.set(artifact.path, encodedPath(relative));
    }
    const metadata = createRunCrate({ ...evidence, artifacts }, { ...options, artifactRoot, projectRoot, crateRoot: stage, fileLocations: locations });
    atomicWriteJson(path.join(stage, 'ro-crate-metadata.json'), metadata);
    const files = crateFiles(stage).map(file => describeArtifact('crate_file', file, { root: stage }));
    atomicWriteJson(path.join(stage, '.pnv-crate.json'), { schemaVersion: 1, files });
    if (fs.existsSync(directory)) { backup = `${stage}.previous`; fs.renameSync(directory, backup); }
    try { fs.renameSync(stage, directory); }
    catch (error) { if (backup) fs.renameSync(backup, directory); throw error; }
    if (backup) fs.rmSync(backup, { recursive: true, force: true });
    return { directory, metadata, files, metadataSha256: files.find(file => file.path === 'ro-crate-metadata.json').sha256 };
  } finally { if (fs.existsSync(stage)) fs.rmSync(stage, { recursive: true, force: true }); }
}

/** Install a staged managed crate and related report files with rollback on publication failure. */
export function promoteRunCrate(sourceDirectory, targetDirectory, publishRelatedFiles) {
  if (!fs.existsSync(path.join(sourceDirectory, '.pnv-crate.json'))) throw new Error('Missing staged crate receipt.');
  if (fs.existsSync(targetDirectory)) {
    if (!fs.lstatSync(targetDirectory).isDirectory() || !fs.existsSync(path.join(targetDirectory, '.pnv-crate.json'))) throw new Error('Existing unmanaged crate directory is preserved.');
    const previous = JSON.parse(fs.readFileSync(path.join(targetDirectory, '.pnv-crate.json'), 'utf8'));
    const owned = new Set([...previous.files.map(file => file.path), '.pnv-crate.json']);
    if (crateFiles(targetDirectory).some(file => !owned.has(file))) throw new Error('The existing crate contains unmanaged files.');
  }
  const backup = `${targetDirectory}.previous-${crypto.randomUUID()}`;
  const hadPrevious = fs.existsSync(targetDirectory);
  if (hadPrevious) fs.renameSync(targetDirectory, backup);
  let installed = false;
  try {
    fs.renameSync(sourceDirectory, targetDirectory);
    installed = true;
    publishRelatedFiles();
  } catch (error) {
    if (installed) fs.rmSync(targetDirectory, { recursive: true, force: true });
    if (hadPrevious) fs.renameSync(backup, targetDirectory);
    throw error;
  }
  if (hadPrevious) fs.rmSync(backup, { recursive: true, force: true });
}

export function crateLocator(result, relativeDirectory) {
  return { schemaVersion: 1, kind: 'pnv-ro-crate-location',
    metadataPath: `${relativeDirectory.replaceAll(path.sep, '/')}/ro-crate-metadata.json`,
    metadataSha256: result.metadataSha256,
    profiles: result.metadata['@graph'].find(entity => entity['@id'] === './').conformsTo.map(profile => profile['@id']) };
}
