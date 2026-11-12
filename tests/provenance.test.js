import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { atomicWriteJson, describeArtifact, fingerprintFiles, verifyArtifacts, createRunCrate, artifactManifestMatches, sourceTableFromTsv } from '../scripts/lib/provenance.mjs';
import { promoteFiles } from '../scripts/lib/provenance_run.mjs';

const roots = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-provenance-'));
  roots.push(root);
  return root;
}
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('content provenance', () => {
  it('never replaces a directory at a report output path',()=>{
    const root=fixture();const stage=path.join(root,'stage');fs.mkdirSync(stage);
    fs.writeFileSync(path.join(stage,'report.html'),'new report');
    const target=path.join(root,'report.html');fs.mkdirSync(target);fs.writeFileSync(path.join(target,'notes.txt'),'preserve');
    expect(()=>promoteFiles(stage,[{source:path.join(stage,'report.html'),target}])).toThrow(/regular file|directory/);
    expect(fs.readFileSync(path.join(target,'notes.txt'),'utf8')).toBe('preserve');
  });
  it('preserves trailing missing statistics and quoted TSV source fields', () => {
    const root = fixture();
    const filename = path.join(root, 'table.tsv');
    fs.writeFileSync(filename, 'gene\tvalue\treason\nTP53\t1\t\n"A\tB"\t\t"line one\nline two"\n');
    expect(sourceTableFromTsv(filename)).toEqual({ columns: ['gene', 'value', 'reason'], rows: [['TP53', '1', null], ['A\tB', null, 'line one\nline two']] });
  });
  it('changes a fingerprint when bytes change without changing the file name', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'counts.tsv'), 'before');
    const first = fingerprintFiles(['counts.tsv'], { root });
    fs.writeFileSync(path.join(root, 'counts.tsv'), 'after');
    expect(fingerprintFiles(['counts.tsv'], { root }).fingerprint).not.toBe(first.fingerprint);
    expect(first.complete).toBe(true);
  });

  it('marks missing inputs incomplete instead of allowing cached reuse', () => {
    expect(fingerprintFiles(['missing.tsv'], { root: fixture() }).complete).toBe(false);
  });

  it('verifies all supplied roles and detects output tampering', () => {
    const root = fixture();
    const roles = ['raw_counts', 'sample_metadata', 'analysis_code', 'reference', 'environment'];
    const artifacts = roles.map(role => {
      fs.writeFileSync(path.join(root, role), role);
      return describeArtifact(role, role, { root });
    });
    expect(verifyArtifacts(artifacts, { root }).status).toBe('verified_against_supplied_artifacts');
    expect(verifyArtifacts(artifacts.map(artifact=>({...artifact,sha256:artifact.sha256.toUpperCase()})),{root}).status).toBe('verified_against_supplied_artifacts');
    fs.writeFileSync(path.join(root, 'raw_counts'), 'tampered');
    expect(verifyArtifacts(artifacts, { root }).status).toBe('mismatch');
    expect(artifactManifestMatches(artifacts, { root })).toBe(false);
  });

  it('does not equate a workbook hash with raw-data verification', () => {
    const root = fixture();
    fs.writeFileSync(path.join(root, 'result.xlsx'), 'workbook');
    const artifacts = [describeArtifact('workbook', 'result.xlsx', { root })];
    expect(verifyArtifacts(artifacts, { root }).status).toBe('internally_consistent');
    expect(verifyArtifacts([], { root }).status).toBe('unverifiable');
  });

  it('rejects traversal and symlink escapes without reading them', () => {
    const root = fixture();
    const outside = fixture();
    fs.writeFileSync(path.join(outside, 'secret'), 'private');
    fs.symlinkSync(path.join(outside, 'secret'), path.join(root, 'link'));
    expect(() => describeArtifact('input', '../secret', { root })).toThrow(/outside|escape/i);
    expect(() => describeArtifact('input', 'link', { root })).toThrow(/outside|escape/i);
  });

  it('writes JSON atomically and exports a linked Workflow Run RO-Crate', () => {
    const root = fixture();
    const destination = path.join(root, 'meta.json');
    atomicWriteJson(destination, { valid: true });
    expect(JSON.parse(fs.readFileSync(destination))).toEqual({ valid: true });
    expect(fs.readdirSync(root)).toEqual(['meta.json']);
    const crate = createRunCrate({ runId: 'abc', artifacts: [], analysis: { method: 'DESeq2+fgsea' } });
    expect(crate['@context']).toContain('https://w3id.org/ro/crate/1.1/context');
    expect(crate['@context']).toContain('https://w3id.org/ro/terms/workflow-run/context');
    expect(crate['@graph'].find(node => node['@id'] === 'ro-crate-metadata.json').about).toEqual({ '@id': './' });
    expect(crate['@graph'].find(node => node['@type'] === 'CreateAction').result).toBeDefined();
    const dataset=crate['@graph'].find(node=>node['@id']==='./');
    expect(Number.isFinite(Date.parse(dataset.datePublished))).toBe(true);
    expect(dataset.description).toBeTruthy();expect(dataset.license).toBeTruthy();
    for(const profile of dataset.conformsTo)expect(crate['@graph'].find(node=>node['@id']===profile['@id'])?.['@type']).toBe('CreativeWork');
    const workflow=crate['@graph'].find(node=>node['@id']===dataset.mainEntity['@id']);
    expect(workflow['@type']).toContain('ComputationalWorkflow');
    expect(crate['@graph'].find(node=>node['@id']===workflow.programmingLanguage['@id'])?.['@type']).toBe('ComputerLanguage');
  });
});
