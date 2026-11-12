import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
  if (!Array.isArray(artifacts) || artifacts.length === 0) {
    return { status: 'unverifiable', checks: [], limitations: ['No artifact digests were supplied.'] };
  }
  for (const [index, artifact] of artifacts.entries()) {
    const id = `artifact:${index}`;
    if (!artifact || typeof artifact.role !== 'string' || !/^[a-f0-9]{64}$/i.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 0) {
      checks.push({ id, status: 'fail', message: 'Malformed artifact digest.' });
      continue;
    }
    try {
      const actual = describeArtifact(artifact.role, artifact.path, options);
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

export function createRunCrate(evidence, { name = 'Pathway Network Viewer analysis', completed = false, datePublished = new Date().toISOString() } = {}) {
  const artifacts = Array.isArray(evidence.artifacts) ? evidence.artifacts : [];
  const profiles = [
    { '@id': 'https://w3id.org/ro/wfrun/process/0.5', '@type': 'CreativeWork', name: 'Process Run Crate', version: '0.5' },
    { '@id': 'https://w3id.org/ro/wfrun/workflow/0.5', '@type': 'CreativeWork', name: 'Workflow Run Crate', version: '0.5' },
    { '@id': 'https://w3id.org/workflowhub/workflow-ro-crate/1.0', '@type': 'CreativeWork', name: 'Workflow RO-Crate', version: '1.0' },
  ];
  const workflowIndex = artifacts.findIndex(artifact => artifact.role === 'analysis_code' && /(?:run_local_analysis|analyze_neural_bulk_cohort)\.R$/i.test(artifact.path));
  const workflowId = workflowIndex >= 0 ? `#artifact-${workflowIndex}` : '#workflow';
  const runId = `#run-${evidence.runId || 'unidentified'}`;
  const language = { '@id': 'https://www.r-project.org/', '@type': 'ComputerLanguage', name: 'R', url: 'https://www.r-project.org/' };
  const workflowProperties = { '@type': ['File', 'SoftwareSourceCode', 'ComputationalWorkflow'], programmingLanguage: { '@id': language['@id'] } };
  const fileNodes = artifacts.map((artifact, index) => ({
    '@id': `#artifact-${index}`, '@type': 'File', name: artifact.path,
    alternateName: artifact.path,
    contentSize: String(artifact.sizeBytes), sha256: artifact.sha256,
    description: artifact.role,
    license: 'Original artifact/source licensing applies; this metadata record grants no additional rights to referenced data or third-party software.',
    ...(index === workflowIndex ? workflowProperties : {}),
  }));
  const outputRoles = new Set(['workbook', 'gene_results', 'pathway_results', 'report', 'viewer_json', 'evidence']);
  const refs = predicate => artifacts.flatMap((artifact, index) => predicate(artifact) ? [{ '@id': `#artifact-${index}` }] : []);
  return {
    '@context': ['https://w3id.org/ro/crate/1.1/context', 'https://w3id.org/ro/terms/workflow-run/context'],
    '@graph': [
      { '@id': 'ro-crate-metadata.json', '@type': 'CreativeWork', conformsTo: { '@id': 'https://w3id.org/ro/crate/1.1' }, about: { '@id': './' } },
      { '@id': './', '@type': 'Dataset', name,
        description: 'Execution provenance metadata and digest inventory for PNV analysis and report delivery. Referenced source artifacts are not necessarily embedded in this metadata-only export.',
        datePublished, license: 'PNV-generated metadata follows the project MIT license. Referenced artifacts retain their original source-specific licenses.',
        conformsTo: profiles.map(profile => ({ '@id': profile['@id'] })),
        mainEntity: { '@id': workflowId }, mentions: { '@id': runId },
        hasPart: [...fileNodes.map(node => ({ '@id': node['@id'] })), ...(workflowIndex < 0 ? [{ '@id': workflowId }] : [])] },
      ...(workflowIndex < 0 ? [{ '@id': workflowId, ...workflowProperties, name: 'PNV local analysis', description: evidence.analysis?.method || 'External analysis; workflow source was not supplied.' }] : []),
      language,
      { '@id': runId, '@type': 'CreateAction', name: 'PNV analysis and report delivery',
        description: `Analysis method: ${evidence.analysis?.method || 'unknown'}. Stored digests describe supplied artifacts and do not establish biological correctness.`,
        instrument: { '@id': workflowId }, object: refs(artifact => !outputRoles.has(artifact.role)), result: refs(artifact => outputRoles.has(artifact.role)),
        ...(evidence.executionCapture?.capturedAt ? { startTime: evidence.executionCapture.capturedAt } : {}),
        ...(completed ? { endTime: datePublished, actionStatus: { '@id': 'http://schema.org/CompletedActionStatus' } } : { actionStatus: { '@id': 'http://schema.org/PotentialActionStatus' } }) },
      ...profiles,
      ...fileNodes,
    ],
  };
}
