// @vitest-environment node
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

describe('prospective power configuration boundaries',()=>{
  it('rejects empty nuisance grids instead of treating zero scenarios as successful planning',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-power-grid-'));
    try {
      const config=JSON.parse(fs.readFileSync('paper/evaluation/power-config.json'));
      const input=path.join(root,'config.json'),out=path.join(root,'result.json');
      fs.writeFileSync(input,JSON.stringify({...config,taskConditionSD:[]}));
      const run=spawnSync('Rscript',['scripts/study/power_study.R',input,out,'--smoke'],{encoding:'utf8',timeout:30000});
      expect(run.status).not.toBe(0);expect(run.stderr).toContain('nonempty finite numeric');
      expect(fs.existsSync(out)).toBe(false);
    }finally{fs.rmSync(root,{recursive:true,force:true});}
  });
});
