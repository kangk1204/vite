// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  parseTsv, numericValue, findSourceRow, compareNumeric,
  assertFairEvidence, validateAccessObservation, freezeContract, reconstructEs, compareDisplay,compareRanks,sameFormula,
} from '../../scripts/comparators/matched_task_contract.mjs';
import {prepareDeliveryFiles,prepareCoherentRecords,inspectPreparedDelivery,writeCompanionPage} from '../../scripts/comparators/matched_task_deliveries.mjs';
import {completeDeliveryManifest,verifyManifest} from '../../scripts/comparators/matched_task_companion.mjs';
import {pnvComputedValues} from '../../scripts/comparators/matched_task_native.mjs';

const roots=[];
afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
const artifact=(role='pathways',sha='a'.repeat(64))=>({role,path:'pathways.tsv',sha256:sha,sizeBytes:12});

describe('matched-task evidence contract',()=>{
  it('preserves empty terminal cells, CRLF, original tokens and data-row numbering',()=>{
    const table=parseTsv('\uFEFFpathway\tNES\tpadj\r\nR1\t1.5\t0.01\r\nR2\t-2\t\r\n');
    expect(table.columns).toEqual(['pathway','NES','padj']);
    expect(findSourceRow(table,'pathway','R2')).toEqual({row:2,values:{pathway:'R2',NES:'-2',padj:''}});
    expect(numericValue(findSourceRow(table,'pathway','R2').values.padj)).toBeNull();
  });
  it.each([null,undefined,'','  ','NA','N/A','NaN','Inf','-Inf'])('keeps unavailable statistic %s missing',value=>{
    expect(numericValue(value)).toBeNull();
    expect(compareNumeric(value,0)).toBe(false);
  });
  it('accepts finite scientific values and rejects malformed or nonnumeric primitives',()=>{
    expect(numericValue('0')).toBe(0);expect(numericValue('-1.2e-4')).toBe(-0.00012);
    expect(compareNumeric('0.0602980518925924',0.0602980518925923)).toBe(true);
    expect(()=>numericValue(false)).toThrow();expect(()=>numericValue('less than0.01')).toThrow();
    expect(compareNumeric(null,null)).toBe(true);expect(compareNumeric(0.01,0.02)).toBe(false);
  });
  it('checks actual rendered precision separately from raw-source parity',()=>{
    expect(compareDisplay('2.31',2.314).matches).toBe(true);
    expect(compareDisplay('2.31',2.316).matches).toBe(false);
    expect(compareDisplay('2.65e-16',2.654e-16)).toMatchObject({matches:true,displayed:2.65e-16,unit:1e-18});
    expect(compareDisplay('2.65e-16',3e-16).matches).toBe(false);
    expect(compareDisplay('NA',null).matches).toBe(true);
    expect(compareDisplay('NA',0).matches).toBe(false);
  });
  it('checks exact rank order while permitting the prespecified numeric serialization tolerance',()=>{
    const ranks=[{gene:'A',metric:2.123456789},{gene:'a',metric:-1}];
    expect(compareRanks([{gene:'A',metric:2.1234567890001},{gene:'a',metric:-1}],ranks).matches).toBe(true);
    expect(compareRanks([...ranks].reverse(),ranks).matches).toBe(false);
    expect(compareRanks([{gene:'A',metric:null},ranks[1]],ranks).matches).toBe(false);
    expect(sameFormula('~ group + age','~age+\x60group\x60')).toBe(true);
    expect(sameFormula('~group','~age+group')).toBe(false);
  });
  it('reconstructs deterministic ES from exact case-sensitive membership and ordered ranks',()=>{
    const ranks=[{gene:'A',metric:4},{gene:'B',metric:3},{gene:'C',metric:2},{gene:'a',metric:-1}];
    expect(reconstructEs(ranks,['A','C'])).toBeCloseTo(2/3,12);
    expect(reconstructEs(ranks,['a'])).toBe(-1);
    expect(reconstructEs(ranks,[])).toBeNull();
    expect(reconstructEs(ranks,ranks.map(r=>r.gene))).toBeNull();
    expect(()=>reconstructEs(ranks,['A','A'])).toThrow(/duplicate/i);
    expect(()=>reconstructEs(ranks,['missing'])).toThrow(/absent/i);
  });
  it('rejects malformed rows, duplicate headers and ambiguous source rows',()=>{
    expect(()=>parseTsv('id\tid\nA\tB')).toThrow(/header/);
    expect(()=>parseTsv('id\tvalue\nA')).toThrow(/width/);
    const table=parseTsv('id\tvalue\nA\t1\nA\t2');
    expect(()=>findSourceRow(table,'id','A')).toThrow(/unique/);
    expect(()=>findSourceRow(table,'unknown','A')).toThrow(/column/);
  });
  it('requires the same byte identities and availability for all three tools',()=>{
    const allocations={PNV:[artifact()],GeneTonic:[artifact()],RNAmel:[artifact()]};
    expect(()=>assertFairEvidence(allocations)).not.toThrow();
    expect(()=>assertFairEvidence({...allocations,RNAmel:[]})).toThrow(/same/);
    expect(()=>assertFairEvidence({...allocations,GeneTonic:[artifact('pathways','b'.repeat(64))]})).toThrow(/same/);
    expect(()=>assertFairEvidence({...allocations,GeneTonic:[{...artifact(),present:false}]})).toThrow(/same/);
  });
  it('keeps hidden extraction and companion access distinct from visible native support',()=>{
    const visible={route:'visible_native_report',mechanism:'dom_text',visible:true,control:'Source row button',screenshot:'T01.png'};
    expect(()=>validateAccessObservation(visible)).not.toThrow();
    expect(()=>validateAccessObservation({...visible,mechanism:'embedded_json'})).toThrow(/native/);
    expect(()=>validateAccessObservation({...visible,visible:false})).toThrow(/visible/);
    expect(()=>validateAccessObservation({route:'shared_companion',mechanism:'source_file',file:'source.tsv',key:'row1'})).not.toThrow();
    expect(()=>validateAccessObservation({route:'not_exposed_in_tested_report',mechanism:'dom_inspection',reason:'No enrichment table in this generated report.'})).not.toThrow();
    expect(()=>validateAccessObservation({...visible,screenshot:''})).toThrow();
    expect(()=>validateAccessObservation({...visible,control:''})).toThrow();
    expect(()=>validateAccessObservation({route:'documented_native_export',mechanism:'user_export',control:'Public save API',file:'project.rds'})).not.toThrow();
    expect(()=>validateAccessObservation({route:'documented_native_export',mechanism:'embedded_json',control:'Object',file:'project.rds'})).toThrow();
    expect(()=>validateAccessObservation({route:'shared_companion',mechanism:'source_file'})).toThrow();
    expect(()=>validateAccessObservation({route:'embedded_machine_record',mechanism:'embedded_json',key:'project.results'})).not.toThrow();
    expect(()=>validateAccessObservation({route:'embedded_machine_record',mechanism:'dom_text',key:'project.results'})).toThrow();
    expect(()=>validateAccessObservation({route:'not_assessed',mechanism:'none'})).toThrow();
    expect(()=>validateAccessObservation({route:'unknown',mechanism:'none',reason:'test'})).toThrow();
  });
  it('freezes the task bytes before observation and rejects later contract edits',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-tasks-'));roots.push(root);
    const input=path.join(root,'tasks.json'),output=path.join(root,'audit');
    fs.writeFileSync(input,JSON.stringify({tasks:['T01','T02']}));
    const frozen=freezeContract(input,output);
    expect(fs.readFileSync(path.join(output,'task-contract.json'),'utf8')).toBe(fs.readFileSync(input,'utf8'));
    expect(frozen.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(freezeContract(input,output).sha256).toBe(frozen.sha256);
    fs.writeFileSync(input,JSON.stringify({tasks:['T01']}));
    expect(()=>freezeContract(input,output)).toThrow(/changed/);
  });
});

describe('isolated matched delivery material',()=>{
  function setup() {
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-delivery-audit-'));roots.push(root);
    const source=path.join(root,'original-counts.tsv');fs.writeFileSync(source,'gene\tA\tB\nTP53\t1\t2\n');
    return {root,source,analysisRecord:{conditionA:'A',conditionB:'B'},target:'R-HSA-449147',contractSha256:'a'.repeat(64)};
  }
  it('keeps the required file physically absent and does not recover it from a workspace copy',()=>{
    const input=setup(),directory=path.join(input.root,'missing');
    const delivery=prepareDeliveryFiles({...input,directory,files:{raw_counts:input.source},kind:'missing_required_file'});
    expect(fs.existsSync(input.source)).toBe(true);
    expect(fs.existsSync(path.join(directory,'files/raw_counts.tsv'))).toBe(false);
    expect(delivery.manifest.deliveredFiles).toEqual([]);
    expect(inspectPreparedDelivery(delivery).result.predicted).toBe('unverifiable');
  });
  it('reverses only requested contrast while preserving the original input and analysis record',()=>{
    const input=setup(),directory=path.join(input.root,'conflict');
    const delivery=prepareDeliveryFiles({...input,directory,files:{raw_counts:input.source},kind:'contrast_conflict'});
    expect(delivery.request.claims).toEqual({conditionA:'B',conditionB:'A'});
    expect(delivery.analysisRecord).toEqual({conditionA:'A',conditionB:'B'});
    expect(fs.readFileSync(path.join(directory,'files/raw_counts.tsv'),'utf8')).toBe(fs.readFileSync(input.source,'utf8'));
    expect(inspectPreparedDelivery(delivery).result.predicted).toBe('mismatch');
  });
  it('keeps the coherent control record-only without independently authenticated labels',()=>{
    const input=setup(),delivery=prepareCoherentRecords(path.join(input.root,'coherent'),input.contractSha256);
    expect(delivery.manifest.independentSpecimenLabelRecords).toEqual([]);
    const inspection=inspectPreparedDelivery(delivery);
    expect(inspection.result.integrityStatus).toBe('internally_consistent');
    expect(inspection.result.checks.every(check=>check.status==='pass')).toBe(true);
    expect(delivery.analysisRecord).toEqual({conditionA:'Symbolic group A',conditionB:'Symbolic group B',sampleCountA:2,sampleCountB:2});
    expect(delivery.manifest).not.toHaveProperty('biologicalTruth');
  });
  it('binds supplied declarations as well as source artifacts in the actual delivery manifest',()=>{
    const input=setup(),delivery=prepareCoherentRecords(path.join(input.root,'coherent'),input.contractSha256);
    const manifest=completeDeliveryManifest(delivery.directory,delivery.manifest);
    expect(manifest.files.some(file=>file.path==='handoff.json')).toBe(true);
    expect(manifest.files.some(file=>file.path==='analysis-record.json')).toBe(true);
    expect(()=>verifyManifest(delivery.directory,manifest)).not.toThrow();
    fs.appendFileSync(path.join(delivery.directory,'handoff.json'),' ');
    expect(()=>verifyManifest(delivery.directory,manifest)).toThrow(/changed/);
  });
  it('rejects path-like source roles and unsafe companion links',()=>{
    const input=setup(),directory=path.join(input.root,'unsafe');
    expect(()=>prepareDeliveryFiles({...input,directory,files:{'../escape':input.source},kind:'consistent'})).toThrow(/role/i);
    expect(()=>writeCompanionPage(directory,{title:'Input',manifest:{files:[{role:'x',path:'javascript:alert(1)',sha256:'a'.repeat(64),sizeBytes:1}]}})).toThrow(/path/i);
    expect(()=>prepareDeliveryFiles({...input,directory,files:{raw_counts:input.source},kind:'invented'})).toThrow(/kind/i);
    expect(()=>prepareDeliveryFiles({...input,directory,files:{raw_counts:{path:input.source,role:'../outside'}},kind:'consistent'})).toThrow(/role/i);
  });
  it('renders neutral delivered records with escaped source text and object values',()=>{
    const input=setup(),delivery=prepareCoherentRecords(path.join(input.root,'coherent'),input.contractSha256);
    const page=writeCompanionPage(delivery.directory,{title:'Records <img>',manifest:delivery.manifest,sections:[
      {id:'labels',title:'Original labels',source:'symbolic-labels.tsv',value:'<script>unsafe</script>'},
      {id:'record',title:'Captured record',value:{conditionA:'A',missing:null}},
    ]});
    const html=fs.readFileSync(page.path,'utf8');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('symbolic-labels.tsv');
    expect(html).toContain('&quot;missing&quot;: null');
    expect(html).not.toContain('predicted');
    const other=writeCompanionPage(delivery.directory,{title:'Files',manifest:{files:delivery.manifest.deliveredFiles}});
    expect(fs.readFileSync(other.path,'utf8')).toContain('Delivery manifest');
  });
  it('records an actual tool check instead of recomputing a pass from supplied inventory',()=>{
    const record={result:{predicted:'mismatch',files:[{role:'counts',path:'counts.tsv',suppliedSha256:'a'}],
      checks:[{id:'artifact:0',status:'fail'},{id:'claim:conditionA',status:'pass'},{id:'claim:conditionB',status:'pass'}]}};
    const values=pnvComputedValues(record,{file_agreement:{allDeclaredFilesPresent:true,allHashesAgree:true},contrast_agreement:{agrees:true},conflict_state:{conflict:false},unverifiable_state:{unverifiable:false}});
    expect(values.file_agreement.allHashesAgree).toBe(false);
    expect(values.contrast_agreement.agrees).toBe(true);
  });
});
