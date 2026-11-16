import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  artifactManifestMatches, atomicWriteJson, crateLocator, createRunCrate,
  describeArtifact, fingerprintFiles, promoteRunCrate, resolveArtifactPath,
  sourceTableFromTsv, verifyArtifacts, writeRunCrate,
} from '../scripts/lib/provenance.mjs';

const roots = [];
function fixture() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-crate-boundary-')));
  roots.push(root);
  return root;
}
function source(root, name = 'counts.tsv', content = 'gene\tS1\nTP53\t10\n') {
  fs.writeFileSync(path.join(root, name), content);
  return describeArtifact('raw_counts', name, { root });
}
function crate(root, name, content = 'original') {
  const artifact = source(root, `${name}.tsv`, content);
  const result = writeRunCrate({ artifacts: [artifact] }, { directory: path.join(root, name), artifactRoot: root });
  return { ...result, artifact };
}
afterEach(() => {
  vi.restoreAllMocks();
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

describe('provenance input and metadata boundaries', () => {
  it('rejects invalid, absolute and absent-child symlink paths before accessing artifacts', () => {
    const root = fixture(), outside = fixture();
    for (const input of [null, '', '  ', 'a\0b', path.join(outside, 'input.tsv')]) {
      expect(() => resolveArtifactPath(input, { root })).toThrow(/path|root/);
    }
    fs.symlinkSync(outside, path.join(root, 'external'));
    expect(() => resolveArtifactPath('external/not-created.tsv', { root })).toThrow(/symlink escapes/);
    fs.mkdirSync(path.join(root, 'directory'));
    expect(() => describeArtifact('input', 'directory', { root })).toThrow(/artifact file/);
  });

  it('does not convert missing or malformed digests into successful verification', () => {
    const root = fixture();
    const artifact = source(root);
    const absent = { ...artifact, path: 'absent.tsv' };
    expect(verifyArtifacts(null, { root }).status).toBe('unverifiable');
    expect(artifactManifestMatches(null, { root })).toBe(false);
    expect(artifactManifestMatches([], { root })).toBe(false);
    const unavailable = verifyArtifacts([absent], { root, includeObservations: true });
    expect(unavailable.status).toBe('unverifiable');
    expect(unavailable.checks[0].status).toBe('unknown');
    expect(unavailable.observations).toEqual([null]);
    expect(unavailable.limitations.join(' ')).toContain('unavailable');
    const partial = verifyArtifacts([artifact, absent], { root });
    expect(partial.status).toBe('internally_consistent');
    for (const malformed of [null, { ...artifact, role: null }, { ...artifact, sha256: 'x' }, { ...artifact, sizeBytes: -1 }, { ...artifact, sizeBytes: 1.5 }]) {
      expect(verifyArtifacts([malformed], { root }).checks[0]).toMatchObject({ status: 'fail', message: 'Malformed artifact digest.' });
    }
    const badPath = verifyArtifacts([{ ...artifact, path: '../outside.tsv' }], { root });
    expect(badPath.status).toBe('mismatch');
    expect(badPath.checks[0].message).toContain('escapes');
    expect(artifactManifestMatches([artifact], { root })).toBe(true);
  });

  it('fingerprints optional absent inputs and rejects directory inputs instead of hiding them as missing', () => {
    const root = fixture();
    source(root);
    const paths = ['counts.tsv', { path: 'optional.tsv', required: false }, 'counts.tsv'];
    const fingerprint = fingerprintFiles(paths, { root });
    expect(fingerprint.complete).toBe(true);
    expect(fingerprint.inputs).toHaveLength(2);
    expect(fingerprint.inputs[1]).toMatchObject({ path: 'optional.tsv', sha256: null, required: false });
    source(root, 'optional.tsv', 'now supplied');
    expect(fingerprintFiles(paths, { root }).fingerprint).not.toBe(fingerprint.fingerprint);
    fs.mkdirSync(path.join(root, 'directory'));
    expect(() => fingerprintFiles(['directory'], { root })).toThrow(/artifact file/);
  });

  it('uses resolvable absolute file URIs when files lie outside the metadata directory', () => {
    const root = fixture(), metadataRoot = fixture();
    const artifact = source(root, 'counts #1%.tsv');
    const result = createRunCrate({ artifacts: [artifact], executionCapture: { capturedAt: '2026-11-16T00:00:00Z' } }, {
      artifactRoot: root, crateRoot: metadataRoot, completed: true, datePublished: '2026-11-16T01:00:00Z',
    });
    const file = result['@graph'].find(node => node['@type'] === 'File');
    expect(fileURLToPath(file['@id'])).toBe(path.join(root, artifact.path));
    expect(fs.readFileSync(fileURLToPath(file['@id']), 'utf8')).toContain('TP53');
    const action = result['@graph'].find(node => node['@type'] === 'CreateAction');
    expect(action).toMatchObject({ '@id': '#run-unidentified', startTime: '2026-11-16T00:00:00Z', endTime: '2026-11-16T01:00:00Z' });
    expect(action.description).toContain('method unknown');
  });

  it('preserves unknown workflow provenance and rejects conflicting descriptions of the same file', () => {
    const empty = createRunCrate({});
    const dataset = empty['@graph'].find(node => node['@id'] === './');
    expect(dataset.mainEntity).toBeUndefined();
    expect(dataset.hasPart).toEqual([]);
    expect(dataset.conformsTo).toEqual([{ '@id': 'https://w3id.org/ro/wfrun/process/0.5' }]);
    expect(empty['@graph'].some(node => node['@type'] === 'ComputerLanguage')).toBe(false);
    expect(empty['@graph'].find(node => node['@id'] === '#analysis-tool').description).toBe('Method unavailable');
    const root = fixture();
    const artifact = source(root);
    expect(() => createRunCrate({ artifacts: [artifact, { ...artifact, role: 'analysis_input', sizeBytes: artifact.sizeBytes + 1 }] }, { artifactRoot: root })).toThrow(/Conflicting artifact digests/);
  });

  it('retains escaped quotes, CRLF, empty tables and explicit malformed-table failures', () => {
    const root = fixture(), filename = path.join(root, 'table.tsv');
    fs.writeFileSync(filename, '\uFEFFgene\treason\r\nTP53\t"a ""quote"""');
    expect(sourceTableFromTsv(filename)).toEqual({ columns: ['gene', 'reason'], rows: [['TP53', 'a "quote"']] });
    fs.writeFileSync(filename, '');
    expect(sourceTableFromTsv(filename)).toEqual({ columns: [], rows: [] });
    fs.writeFileSync(filename, 'gene\treason\nTP53');
    expect(() => sourceTableFromTsv(filename)).toThrow(/Non-rectangular/);
    fs.writeFileSync(filename, 'gene\treason\nTP53\t"unclosed');
    expect(() => sourceTableFromTsv(filename)).toThrow(/Unclosed/);
  });
});

describe('portable crate transactions', () => {
  it('refuses unmanaged directories, files, added user files and symlinks without deleting them', () => {
    const root = fixture(), directory = path.join(root, 'result');
    const options = { directory, artifactRoot: root };
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'notes'), 'keep');
    expect(() => writeRunCrate({}, options)).toThrow(/unmanaged/);
    expect(fs.readFileSync(path.join(directory, 'notes'), 'utf8')).toBe('keep');
    const managed = crate(root, 'managed');
    fs.writeFileSync(path.join(managed.directory, 'notes'), 'keep');
    expect(() => writeRunCrate({}, { ...options, directory: managed.directory })).toThrow(/unmanaged files/);
    fs.unlinkSync(path.join(managed.directory, 'notes'));
    fs.symlinkSync(path.join(root, 'managed.tsv'), path.join(managed.directory, 'unexpected-link'));
    expect(() => writeRunCrate({}, { ...options, directory: managed.directory })).toThrow(/unexpected symlink/);
    const fileTarget = path.join(root, 'file-target');
    fs.writeFileSync(fileTarget, 'keep-file');
    expect(() => writeRunCrate({}, { ...options, directory: fileTarget })).toThrow(/unmanaged/);
    expect(fs.readFileSync(fileTarget, 'utf8')).toBe('keep-file');
  });

  it('replaces a managed crate successfully with a staged report and real workflow source', () => {
    const root = fixture(), stagingRoot = fixture();
    const previous = crate(root, 'managed');
    source(root, 'workflow.mjs', '// actual delivery workflow');
    const report = source(stagingRoot, 'report.html', '<html>new report</html>');
    const artifact = { ...report, role: 'report' };
    const result = writeRunCrate({ artifacts: [artifact] }, {
      directory: previous.directory, artifactRoot: root, stagingRoot,
      artifactSources: new Map([['report.html', path.join(stagingRoot, 'report.html')]]),
      workflowSource: 'workflow.mjs', completed: true,
    });
    expect(fs.readFileSync(path.join(result.directory, 'run/report.html'), 'utf8')).toContain('new report');
    expect(fs.existsSync(path.join(result.directory, 'run/managed.tsv'))).toBe(false);
    const dataset = result.metadata['@graph'].find(node => node['@id'] === './');
    const workflow = result.metadata['@graph'].find(node => node['@id'] === dataset.mainEntity['@id']);
    expect(workflow['@type']).toContain('ComputationalWorkflow');
    expect(workflow.programmingLanguage['@id']).toContain('ecma-262');
    const locator = crateLocator(result, 'managed');
    expect(locator.metadataPath).toBe('managed/ro-crate-metadata.json');
    expect(locator.metadataSha256).toBe(result.metadataSha256);
    expect(locator.profiles).toContain('https://w3id.org/ro/wfrun/workflow/0.5');
    expect(fs.readdirSync(root).filter(name => name.startsWith('.pnv-crate-'))).toEqual([]);
  });

  it('rejects malformed descriptors, source overrides outside allowed roots and output nesting over an input', () => {
    const root = fixture(), outside = fixture();
    const artifact = source(root);
    const options = { directory: path.join(root, 'managed'), artifactRoot: root };
    for (const invalid of [null, { ...artifact, role: '' }, { ...artifact, sha256: null }, { ...artifact, sizeBytes: -1 }]) {
      expect(() => writeRunCrate({ artifacts: [invalid] }, options)).toThrow(/requires a role/);
    }
    const external = source(outside);
    expect(() => writeRunCrate({ artifacts: [external] }, { ...options, artifactSources: new Map([['counts.tsv', path.join(outside, 'counts.tsv')]]) })).toThrow(/outside the allowed roots/);
    const managed = crate(root, 'nested');
    const inside = describeArtifact('raw_counts', 'nested/run/nested.tsv', { root });
    expect(() => writeRunCrate({ artifacts: [inside] }, { ...options, directory: managed.directory })).toThrow(/contains one of its source/);
    expect(fs.readFileSync(path.join(managed.directory, 'run/nested.tsv'), 'utf8')).toBe('original');
  });

  it('restores the previous crate if installing the verified replacement fails', () => {
    const root = fixture(), prior = crate(root, 'managed');
    const before = fs.readFileSync(path.join(prior.directory, 'ro-crate-metadata.json'));
    const replacement = source(root, 'replacement.tsv', 'replacement');
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === prior.directory && path.basename(from).startsWith('.pnv-crate-') && !from.endsWith('.previous')) throw new Error('simulated installation failure');
      return rename(from, to);
    });
    expect(() => writeRunCrate({ artifacts: [replacement] }, { directory: prior.directory, artifactRoot: root })).toThrow(/installation failure/);
    expect(fs.readFileSync(path.join(prior.directory, 'ro-crate-metadata.json'))).toEqual(before);
    expect(fs.readdirSync(root).filter(name => name.startsWith('.pnv-crate-'))).toEqual([]);
  });

  it('cleans temporary JSON when serialization or replacement fails', () => {
    const root = fixture(), target = path.join(root, 'record.json');
    atomicWriteJson(target, { previous: true });
    expect(() => atomicWriteJson(target, { invalid: 1n })).toThrow();
    const rename = fs.renameSync;
    vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === target) throw new Error('simulated replacement failure');
      return rename(from, to);
    });
    expect(() => atomicWriteJson(target, { previous: false })).toThrow(/replacement failure/);
    expect(JSON.parse(fs.readFileSync(target, 'utf8'))).toEqual({ previous: true });
    expect(fs.readdirSync(root)).toEqual(['record.json']);
  });

  it('rolls back crate publication when the related report transaction fails', () => {
    const root = fixture(), prior = crate(root, 'published'), staged = crate(root, 'staged', 'new');
    const before = fs.readFileSync(path.join(prior.directory, 'ro-crate-metadata.json'));
    expect(() => promoteRunCrate(staged.directory, prior.directory, () => { throw new Error('report publication failed'); })).toThrow(/report publication failed/);
    expect(fs.readFileSync(path.join(prior.directory, 'ro-crate-metadata.json'))).toEqual(before);
    expect(fs.readdirSync(root).some(name => name.includes('.previous-'))).toBe(false);
    const fresh = crate(root, 'fresh'), target = path.join(root, 'new-target');
    expect(() => promoteRunCrate(fresh.directory, target, () => { throw new Error('report publication failed'); })).toThrow();
    expect(fs.existsSync(target)).toBe(false);
  });

  it('promotes staged crates only into managed destinations and preserves extra user files', () => {
    const root = fixture(), staged = crate(root, 'staged'), prior = crate(root, 'prior');
    expect(() => promoteRunCrate(path.join(root, 'absent'), prior.directory, () => {})).toThrow(/Missing staged/);
    const unmanaged = path.join(root, 'unmanaged');
    fs.mkdirSync(unmanaged);
    expect(() => promoteRunCrate(staged.directory, unmanaged, () => {})).toThrow(/unmanaged/);
    fs.writeFileSync(path.join(prior.directory, 'notes'), 'retain');
    expect(() => promoteRunCrate(staged.directory, prior.directory, () => {})).toThrow(/unmanaged files/);
    expect(fs.readFileSync(path.join(prior.directory, 'notes'), 'utf8')).toBe('retain');
    fs.unlinkSync(path.join(prior.directory, 'notes'));
    const publish = vi.fn();
    promoteRunCrate(staged.directory, prior.directory, publish);
    expect(publish).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(prior.directory, 'run/staged.tsv'), 'utf8')).toBe('original');
    expect(fs.existsSync(staged.directory)).toBe(false);
    expect(fs.readdirSync(root).some(name => name.includes('.previous-'))).toBe(false);
  });
});
