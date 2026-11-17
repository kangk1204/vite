// @vitest-environment node
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createHash}from'node:crypto';
import {afterEach,expect,it}from'vitest';
import {copyBoundArtifact,targetRow}from'../../scripts/comparators/build_pd_companion.mjs';
const dirs=[];afterEach(()=>dirs.splice(0).forEach(d=>fs.rmSync(d,{recursive:true,force:true})));
it('copies bound bytes and refuses changed artifacts or escaping output paths',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'pd-companion-'));dirs.push(root);fs.writeFileSync(path.join(root,'input'),'original');
 const output=path.join(root,'shared');fs.mkdirSync(output);const hash=createHash('sha256').update('original').digest('hex');
 const entry=copyBoundArtifact(root,output,{role:'genes',source:'input',path:'genes.tsv',sha256:hash});
 expect(entry).toMatchObject({role:'genes',path:'genes.tsv',sha256:hash,sizeBytes:8});
 fs.writeFileSync(path.join(root,'input'),'changed');expect(()=>copyBoundArtifact(root,output,{role:'genes',source:'input',path:'x',sha256:hash})).toThrow(/digest/);
 expect(()=>copyBoundArtifact(root,output,{role:'genes',source:'input',path:'../outside',sha256:hash})).toThrow(/path|escape/);
});
it('records one-based source rows and rejects missing or ambiguous target identifiers',()=>{
 const rows=[{pathway:'R-HSA-1 :: One'},{pathway_id:'R-HSA-449147'}];expect(targetRow(rows,'R-HSA-449147')).toBe(2);
 expect(()=>targetRow(rows,'missing')).toThrow(/target/);expect(()=>targetRow([...rows,rows[1]],'R-HSA-449147')).toThrow(/target/);
});
