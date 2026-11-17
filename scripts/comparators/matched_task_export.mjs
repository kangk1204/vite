import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {sha256,compareRanks} from './matched_task_contract.mjs';
import {arrayIdentity} from './matched_task_sources.mjs';
import {writeJson} from './matched_task_deliveries.mjs';

export function readRnamelExport(reportDirectory,target,output,prefix,facts) {
  const input=path.join(reportDirectory,'project.rnaflow.rds'),file=path.join(output,prefix+'-loaded-project.json');
  const script='scripts/comparators/read_matched_rnamel_export.R',args=[script,input,target,file];
  const result=spawnSync('Rscript',args,{encoding:'utf8',maxBuffer:1024*1024});
  fs.writeFileSync(path.join(output,prefix+'-load-project.log'),String(result.stdout||'')+String(result.stderr||''));
  if(result.status!==0)throw new Error('Documented RNAmel project loading failed: '+result.stderr);
  const data=JSON.parse(fs.readFileSync(file));
  const receipt={command:['Rscript',...args],publicApi:'RNAmel::load_project',exportApi:'RNAmel::save_project',
    packageVersion:data.packageVersion,sourceSha256:sha256(fs.readFileSync(script)),file:input,sha256:sha256(fs.readFileSync(input)),
    extractionFile:path.basename(file),extractionSha256:sha256(fs.readFileSync(file)),requires_R:true,
    scope:'Documented native R API export and retrieval. These values are not claimed to be visible in the native HTML.'};
  const receiptPath=path.join(output,prefix+'-export-receipt.json');writeJson(receiptPath,receipt);
  const base={route:'documented_native_export',mechanism:'user_export',control:'RNAmel::save_project / RNAmel::load_project',
    file:input,sha256:receipt.sha256,export_receipt:path.basename(receiptPath),requires_R:true,value_origin:'Frozen original inputs retained in documented RNAmel project fields',native_computation:false};
  const field=(observed,key)=>({...base,observed,key});
  const p=data.pathway,a=data.analysis,m=data.membership;
  const positive=/([AB])\s+versus\s+([AB])/i.exec(p.supplied_positive_contrast||'');
  const ranked=data.rankedGenes.map(row=>({gene:row.gene,metric:row.stat??row.metric}));
  const observed={
    pathway_identifier:field(p.supplied_pathway_identifier,'enrichment.results[target].supplied_pathway_identifier'),
    original_NES:field(p.NES,'enrichment.results[target].NES'),original_adjusted_pvalue:field(p.padj,'enrichment.results[target].padj'),
    actual_design:field(a.designFormula,'enrichment.supplied_analysis.designFormula'),
    contrast_direction:field({numerator:positive?.[1],denominator:positive?.[2],declared:p.supplied_positive_contrast},'enrichment.results[target].supplied_positive_contrast'),
    group_label_mapping:field({A:a.contrast.conditionA,B:a.contrast.conditionB},'enrichment.supplied_analysis.contrast'),
    tested_gene_count:field(m.testedSize,'enrichment.supplied_tested_membership[target].testedSize'),
    exact_tested_gene_identifiers:field(arrayIdentity(m.testedGenes,false),'enrichment.supplied_tested_membership[target].testedGenes'),
    original_rank_universe:{...field(arrayIdentity(ranked),'enrichment.supplied_ranked_genes'),rank_comparison:compareRanks(ranked,facts.evidence.rankedGenes)},
    original_ES:field(p.ES,'enrichment.results[target].ES'),
    reconstruction_agreement:field({agrees:m.absoluteDifference<=m.tolerance,absoluteDifference:m.absoluteDifference,tolerance:m.tolerance},'enrichment.supplied_tested_membership[target]'),
    group_only_design:field(p.supplied_group_only_design,'enrichment.results[target].supplied_group_only_design'),
    group_only_NES:field(p.supplied_group_only_NES,'enrichment.results[target].supplied_group_only_NES'),
    group_only_adjusted_pvalue:field(p.supplied_group_only_FDR,'enrichment.results[target].supplied_group_only_FDR'),
    group_only_source_row:field(p.supplied_group_only_source_row,'enrichment.results[target].supplied_group_only_source_row'),
    CAMERA_direction:field(p.supplied_CAMERA_direction,'enrichment.results[target].supplied_CAMERA_direction'),
    CAMERA_adjusted_pvalue:field(p.supplied_CAMERA_FDR,'enrichment.results[target].supplied_CAMERA_FDR'),
    CAMERA_test_identity:field(p.supplied_CAMERA_test,'enrichment.results[target].supplied_CAMERA_test'),
    CAMERA_source_row:field(p.supplied_CAMERA_source_row,'enrichment.results[target].supplied_CAMERA_source_row'),
    selected_count:field(p.supplied_bootstrap_selected,'enrichment.results[target].supplied_bootstrap_selected'),
    testable_count:field(p.supplied_bootstrap_testable,'enrichment.results[target].supplied_bootstrap_testable'),
    requested_repetitions:field(p.supplied_bootstrap_requested,'enrichment.results[target].supplied_bootstrap_requested'),
    direction_agreement_count:field(p.supplied_bootstrap_direction_agreement,'enrichment.results[target].supplied_bootstrap_direction_agreement'),
    conditional_frequency_meaning:field(p.supplied_bootstrap_meaning,'enrichment.results[target].supplied_bootstrap_meaning'),
  };
  observed.reconstruction_agreement.derivation='auditor_comparison_of_exported_inputs';
  return{observed,data,receipt,base};
}
