import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {parseTsv,findSourceRow,numericValue,compareNumeric,reconstructEs,sha256} from './matched_task_contract.mjs';

export function readSource(file, outputRoot) {
  const bytes=fs.readFileSync(file);
  return {file:path.relative(outputRoot,path.resolve(file)).split(path.sep).join('/'),sha256:sha256(bytes),sizeBytes:bytes.length,bytes};
}

export function arrayIdentity(values, ordered = true) {
  const comparable=ordered ? values : [...values].sort((a,b)=>String(a).localeCompare(String(b)));
  return {count:values.length,sha256:sha256(JSON.stringify(comparable)),ordered};
}

export function readOriginalPrecision(fixture,target,outputFile) {
  if (fs.existsSync(outputFile)) return JSON.parse(fs.readFileSync(outputFile,'utf8'));
  const script='args<-commandArgs(TRUE);x<-readRDS(args[[1]]);d<-if(!is.null(x$matched))x$matched$enrichment else x$expected$pathways;d<-d[grepl(args[[2]],d$pathway,fixed=TRUE),c("pathway","NES","padj","ES","size"),drop=FALSE];stopifnot(nrow(d)==1L);d[]<-lapply(d,function(v)if(is.numeric(v))format(v,digits=17,scientific=TRUE,trim=TRUE)else v);cat(jsonlite::toJSON(d,auto_unbox=TRUE,na="null"))';
  const args=['-e',script,path.resolve(fixture),target],run=spawnSync('Rscript',args,{encoding:'utf8',maxBuffer:1024*1024});
  if(run.status!==0)throw new Error('Original numeric extraction failed: '+run.stderr);
  const record={source:{file:path.resolve(fixture),sha256:sha256(fs.readFileSync(fixture)),key:'original pathway results at target pathway'},
    command:['Rscript',...args],values:JSON.parse(run.stdout)[0],scope:'Read-only full-precision extraction from frozen original arrays; no model fit or pathway test.'};
  fs.writeFileSync(outputFile,JSON.stringify(record,null,2)+'\n');
  return record;
}

/** Expected facts come from the frozen original sources, independently of the inspected reports. */
export function loadSourceFacts(files, target, outputRoot, originalPrecision) {
  const sources=Object.fromEntries(Object.entries(files).map(([role,file])=>[role,readSource(file,outputRoot)]));
  const evidence=JSON.parse(sources.report_evidence.bytes).evidence;
  const detail=evidence.pathways[target];
  if (!detail) throw new Error('Target pathway is absent from original evidence.');
  const tables=Object.fromEntries(['primary_pathways','camera','group_only_pathways','metadata'].map(role=>[role,parseTsv(sources[role].bytes.toString())]));
  const primary=findSourceRow(tables.primary_pathways,'pathway_id',target);
  const camera=findSourceRow(tables.camera,'pathway',primary.values.pathway);
  const groupOnly=findSourceRow(tables.group_only_pathways,'pathway_id',target);
  const binding=(role,extra={})=>{const {bytes,...source}=sources[role];return{...source,...extra};};
  const evidenceKey=key=>binding('report_evidence',{key:'/evidence/'+key});
  const rowBinding=(role,row,column)=>binding(role,{row:row.row,column});
  const fact=(kind,value,...sourceBindings)=>({kind,expected:value,sources:sourceBindings});
  const number=(row,column)=>numericValue(row.values[column]);
  const members=detail.testedGenes,ranks=evidence.rankedGenes;
  if (!Array.isArray(members)||!Array.isArray(ranks)) throw new Error('Exact original membership and rank universe are required.');
  const originalNumber=column=>originalPrecision?numericValue(originalPrecision.values[column]):number(primary,column);
  for (const column of ['NES','padj','ES','size']) if(!compareNumeric(originalNumber(column),number(primary,column)))throw new Error('Frozen array and primary source table disagree.');
  const originalEs=originalNumber('ES'),reconstructedEs=reconstructEs(ranks,members);
  if (!compareNumeric(originalEs,detail.originalEs)||!compareNumeric(originalEs,reconstructedEs)) throw new Error('Original source ES does not agree with exact-membership reconstruction.');
  if (number(primary,'size')!==members.length||detail.testedSize!==members.length) throw new Error('Original source tested-size fields differ.');
  for (const [column,field] of [['padj','padj'],['NGenes','nGenes'],['Correlation','correlation']]) {
    if (!compareNumeric(camera.values[column],detail.camera[field])) throw new Error('CAMERA source and recorded evidence disagree.');
  }
  const design=detail.designSensitivity.find(row=>row.designFormula.replace(/\s/g,'')==='~group');
  if (!design||!compareNumeric(groupOnly.values.NES,design.nes)||!compareNumeric(groupOnly.values.padj,design.padj)) throw new Error('Group-only source and evidence disagree.');
  const contrast=evidence.analysis.contrast,boot=detail.bootstrap;
  if (boot.valid<0||boot.valid>boot.requested||!compareNumeric(boot.selectionFrequency,boot.valid?boot.selected/boot.valid:null)) throw new Error('Original bootstrap denominator is inconsistent.');
  const fields={
    pathway_identifier:fact('text',target,rowBinding('primary_pathways',primary,'pathway_id')),
    original_NES:fact('number',originalNumber('NES'),rowBinding('primary_pathways',primary,'NES')),
    original_adjusted_pvalue:fact('number',originalNumber('padj'),rowBinding('primary_pathways',primary,'padj')),
    actual_design:fact('formula',evidence.analysis.designFormula,evidenceKey('analysis/designFormula')),
    contrast_direction:fact('record',{numerator:'B',denominator:'A'},evidenceKey('analysis/contrast')),
    group_label_mapping:fact('record',{A:contrast.conditionA,B:contrast.conditionB},binding('metadata',{columns:['group','condition_label']}),evidenceKey('analysis/contrast')),
    tested_gene_count:fact('number',members.length,rowBinding('primary_pathways',primary,'size'),evidenceKey('pathways/'+target+'/testedGenes')),
    exact_tested_gene_identifiers:fact('identifier_set',arrayIdentity(members,false),evidenceKey('pathways/'+target+'/testedGenes')),
    original_rank_universe:fact('ordered_ranks',arrayIdentity(ranks),evidenceKey('rankedGenes')),
    original_ES:fact('number',originalEs,rowBinding('primary_pathways',primary,'ES')),
    reconstruction_agreement:fact('agreement',{agrees:true,originalEs,reconstructedEs,absoluteDifference:Math.abs(originalEs-reconstructedEs),tolerance:1e-8},
      evidenceKey('rankedGenes'),evidenceKey('pathways/'+target+'/testedGenes'),rowBinding('primary_pathways',primary,'ES')),
    group_only_design:fact('formula',design.designFormula,evidenceKey('pathways/'+target+'/designSensitivity/0/designFormula')),
    group_only_NES:fact('number',number(groupOnly,'NES'),rowBinding('group_only_pathways',groupOnly,'NES')),
    group_only_adjusted_pvalue:fact('number',number(groupOnly,'padj'),rowBinding('group_only_pathways',groupOnly,'padj')),
    group_only_source_row:fact('number',groupOnly.row,rowBinding('group_only_pathways',groupOnly,'pathway_id')),
    CAMERA_direction:fact('text',camera.values.direction,rowBinding('camera',camera,'direction')),
    CAMERA_adjusted_pvalue:fact('number',number(camera,'padj'),rowBinding('camera',camera,'padj')),
    CAMERA_test_identity:fact('text',evidence.analysis.camera,evidenceKey('analysis/camera')),
    CAMERA_source_row:fact('number',camera.row,rowBinding('camera',camera,'pathway')),
    selected_count:fact('number',boot.selected,evidenceKey('pathways/'+target+'/bootstrap/selected')),
    testable_count:fact('number',boot.valid,evidenceKey('pathways/'+target+'/bootstrap/valid')),
    requested_repetitions:fact('number',boot.requested,evidenceKey('pathways/'+target+'/bootstrap/requested')),
    direction_agreement_count:fact('number',boot.directionMatches,evidenceKey('pathways/'+target+'/bootstrap/directionMatches')),
    conditional_frequency_meaning:fact('text','conditional_on_testable_resamples',evidenceKey('pathways/'+target+'/bootstrap/interpretation')),
  };
  if(originalPrecision)for(const component of ['original_NES','original_adjusted_pvalue','original_ES','reconstruction_agreement']){
    fields[component].sources.push({...originalPrecision.source,file:path.relative(outputRoot,originalPrecision.source.file)});
  }
  return {fields,evidence,detail,primary,camera,groupOnly,sources:Object.fromEntries(Object.entries(sources).map(([role,{bytes,...record}])=>[role,record]))};
}
