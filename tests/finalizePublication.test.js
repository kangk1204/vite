import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachDesignSensitivity, verifyExecutionCapture, finalizePublication, assertRecordedTableMatches, assertWorkbookStatistics } from '../scripts/finalize_publication_v2.mjs';
import { describeArtifact } from '../scripts/lib/provenance.mjs';

const roots=[];
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-finalize-'));roots.push(root);return root;}
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));

describe('publication finalization',()=>{
  it('rejects changed source statistics before taking new output hashes',()=>{
    const recorded={columns:['gene','padj'],rows:[['TP53',0.05],['EGFR',null]]};
    expect(()=>assertRecordedTableMatches(recorded,{columns:['gene','padj'],rows:[['TP53','0.05'],['EGFR',null]]},'genes')).not.toThrow();
    expect(()=>assertRecordedTableMatches(recorded,{columns:['gene','padj'],rows:[['TP53','0.0001'],['EGFR',null]]},'genes')).toThrow(/differs/);
    expect(()=>assertRecordedTableMatches(recorded,{columns:['gene','padj'],rows:[['TP53','0.05'],['EGFR','0']]},'genes')).toThrow(/differs/);
  });
  it('rejects workbook statistics that differ from the original R evidence',()=>{
    const original={sourceTables:{genes:{columns:['gene','log2FoldChange','padj','pvalue','stat'],rows:[['TP53',1,0.05,0.01,2]]},pathways:{columns:['pathway_id','NES','padj','leadingEdge'],rows:[['R-1',1.5,0.03,'TP53']]},metadata:{columns:['sample','group'],rows:[['S1','A']]}}};
    const workbook={Genes:{columns:['gene_symbol','log2fc','padj','pvalue','rank_metric'],rows:[['TP53',1,0.05,0.01,2]]},Pathways:{columns:['pathway_id','nes','padj','leading_edge_genes'],rows:[['R-1',1.5,0.03,'TP53']]},Samples:{columns:['sample_id','group'],rows:[['S1','A']]}};
    expect(()=>assertWorkbookStatistics(original,workbook)).not.toThrow();
    workbook.Genes.rows[0][2]=0.00001;
    expect(()=>assertWorkbookStatistics(original,workbook)).toThrow(/differs/);
  });
  it('preserves missing sensitivity values and original inference without replacing it',()=>{
    const original={analysis:{designFormula:'~ age + group'},pathways:{'R-1':{camera:{padj:0.03}},'R-2':{}},sourceTables:{}};
    const table={columns:['pathway_id','NES','padj'],rows:[['R-1','2.1','0.04']]};
    const result=attachDesignSensitivity(original,table);
    expect(result.analysis.designFormula).toBe('~ age + group');
    expect(result.pathways['R-1'].designSensitivity[0]).toEqual({designFormula:'~ group',nes:2.1,padj:0.04,source:{table:'group_only_pathways',row:1}});
    expect(result.pathways['R-2'].designSensitivity[0]).toMatchObject({nes:null,padj:null});
    expect(original.pathways['R-1'].designSensitivity).toBeUndefined();
    expect(result.sourceTables.group_only_pathways).toEqual(table);
  });
  it('does not replace captured run hashes with current bytes',()=>{
    const root=fixture();fs.writeFileSync(path.join(root,'counts.tsv'),'original');
    const artifact=describeArtifact('raw_counts','counts.tsv',{root});
    const evidence={executionCapture:{artifacts:[artifact]}};
    fs.writeFileSync(path.join(root,'counts.tsv'),'changed');
    expect(()=>verifyExecutionCapture(evidence,{root,projectRoot:root})).toThrow(/captured|match/i);
    expect(verifyExecutionCapture({}, {root,projectRoot:root}).status).toBe('unverifiable');
  });
  it('refuses to finalize missing analysis outputs without starting R fits',()=>{
    const root=fixture();fs.mkdirSync(path.join(root,'paper'),{recursive:true});
    const manifest={outputRoot:'out',cohorts:[{key:'pending',enabled:true,evidencePath:'missing_evidence.json',workbookPath:'missing.xlsx',referenceInputPath:'missing.rds'}]};
    fs.writeFileSync(path.join(root,'paper/manifest.json'),JSON.stringify(manifest));
    let executed=false;
    expect(()=>finalizePublication('paper/manifest.json',{root,execute:()=>{executed=true;}})).toThrow(/not ready|missing/i);
    expect(executed).toBe(false);
  });
  it('preserves prior full/basic reports and derived evidence when source changes mid-render',()=>{
    const root=fixture();
    for(const dir of ['paper','scripts','src','out/reports','out/case'])fs.mkdirSync(path.join(root,dir),{recursive:true});
    for(const file of ['scripts/build_report_from_workbook.mjs','scripts/finalize_publication_v2.mjs','scripts/validate_analysis_reference.R','renv.lock','package-lock.json'])fs.writeFileSync(path.join(root,file),'fixture');
    const cohort={key:'case',enabled:true,evidencePath:'out/case/case_evidence.json',workbookPath:'out/case/case.xlsx',referenceInputPath:'out/case/case.rds',degTablePath:'out/case/genes.tsv',pathwayTablePath:'out/case/pathways.tsv',sampleMetadataPath:'out/case/samples.tsv',summaryTablePath:'out/case/summary.tsv',reportPath:'out/reports/case.report.html'};
    fs.writeFileSync(path.join(root,cohort.workbookPath),'workbook');fs.writeFileSync(path.join(root,cohort.referenceInputPath),'snapshot');
    for(const file of ['genes.tsv','pathways.tsv','samples.tsv','summary.tsv'])fs.writeFileSync(path.join(root,'out/case',file),'id\tvalue\nx\t1\n');
    const original={schemaVersion:2,evidence:{runId:'run',analysis:{method:'fixture'},verification:{checks:[],limitations:[]},artifacts:[],pathways:{},sourceTables:{genes:{columns:['id','value'],rows:[['x',1]]},pathways:{columns:['id','value'],rows:[['x',1]]},metadata:{columns:['id','value'],rows:[['x',1]]}}}};
    fs.writeFileSync(path.join(root,cohort.evidencePath),JSON.stringify(original));
    const oldFiles=['case.report.html','case.report.viewer.json','case.basic.report.html','case.basic.report.viewer.json'];
    oldFiles.forEach(file=>fs.writeFileSync(path.join(root,'out/reports',file),`old:${file}`));
    const derived=path.join(root,'out/case/case_report_evidence.json');fs.writeFileSync(derived,'old-derived');
    fs.writeFileSync(path.join(root,'paper/manifest.json'),JSON.stringify({outputRoot:'out',cohorts:[cohort]}));
    let renders=0;
    const execute=(command,args)=>{
      if(command==='Rscript')fs.writeFileSync(args[2],JSON.stringify({status:'pass',checks:[{pass:true}]}));
      else{
        renders+=1;fs.writeFileSync(args[2],'new report');
        fs.writeFileSync(args[args.indexOf('--viewer-json')+1],JSON.stringify({evidence:{sourceTables:{same:true},verification:{status:'internally_consistent'}}}));
        if(renders===2)fs.writeFileSync(path.join(root,'scripts/build_report_from_workbook.mjs'),'changed during rendering');
      }
    };
    expect(()=>finalizePublication('paper/manifest.json',{root,execute,environment:{R:'fixture'}})).toThrow(/changed during finalization/);
    oldFiles.forEach(file=>expect(fs.readFileSync(path.join(root,'out/reports',file),'utf8')).toBe(`old:${file}`));
    expect(fs.readFileSync(derived,'utf8')).toBe('old-derived');
    expect(fs.existsSync(path.join(root,'out/benchmarks/finalization.json'))).toBe(false);
  });
});
