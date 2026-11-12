import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const moduleLoader = "import importlib.util; spec=importlib.util.spec_from_file_location('figures','scripts/study/build_implementation_figures.py'); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m); ";

describe('supplementary implementation figures', () => {
  it('publishes the architecture and parity matrix under the supplementary inventory', () => {
    const run = spawnSync('python3', ['-c', moduleLoader + 'print(*m.SUPPLEMENTARY_STEMS, sep="\\n")'], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout.trim().split('\n')).toEqual(['supplementary_figure_s1_evidence_workflow', 'supplementary_figure_s2_integration_checks']);
  });
  it('rejects stale artifact bytes instead of presenting a pass matrix', () => {
    const code = moduleLoader + "import tempfile,pathlib,hashlib; root=pathlib.Path(tempfile.mkdtemp()); f=root/'a.json';f.write_text('old');a={'path':'a.json','sha256':hashlib.sha256(b'old').hexdigest(),'sizeBytes':3};m.verify_artifact(a,root);f.write_text('new');\ntry:m.verify_artifact(a,root)\nexcept ValueError:print('stale rejected')\n";
    const run = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('stale rejected');
  });
  it('requires exactly the declared eighteen passing checks and keeps pass flags separate from error magnitudes', () => {
    const code = moduleLoader + "import tempfile,pathlib,json; p=pathlib.Path(tempfile.mktemp());d={'status':'pass','absoluteTolerance':1e-8,'relativeTolerance':1e-8,'checks':[{'id':key,'pass':True} for key in m.CHECK_IDS]};p.write_text(json.dumps(d));r=m.read_parity(p);assert len(r['checks'])==18;assert 'maxDifference' not in r;d['checks'][0]['pass']=False;p.write_text(json.dumps(d));\ntry:m.read_parity(p)\nexcept ValueError:print('failed check rejected')\n";
    const run = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(run.stdout).toContain('failed check rejected');
  });
  it('refuses final rendering without a complete release receipt and writes no figure', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-figures-gate-'));
    try {
      const manifest = path.join(root, 'manifest.json');
      fs.writeFileSync(manifest, JSON.stringify({ manifestVersion: 2, outputRoot: 'paper/outputs/publication_v2', cohorts: Array.from({ length: 5 }, (_, i) => ({ key: `C${i}` })) }));
      const out = path.join(root, 'figures');
      const run = spawnSync('python3', ['scripts/study/build_implementation_figures.py', '--project-root', root, '--manifest', manifest, '--output', out], { encoding: 'utf8' });
      expect(run.status).not.toBe(0);
      expect(run.stderr).toContain('finalization receipt');
      expect(fs.existsSync(out)).toBe(false);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
