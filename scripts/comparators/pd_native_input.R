# Join supplied common metadata without changing native statistical columns.
pd_with_annotations <- function(result,key,annotations) {
  if(!key %in% names(result)||!('pathway' %in% names(annotations))||anyDuplicated(annotations$pathway))stop('Native annotation keys are ambiguous.')
  columns<-setdiff(names(annotations),'pathway')
  if(any(columns %in% names(result)))stop('Supplied annotations must not overwrite native result columns.')
  index<-match(result[[key]],annotations$pathway)
  if(anyNA(index))stop('Native result lacks a supplied annotation source row.')
  out<-result;out[columns]<-annotations[index,columns,drop=FALSE]
  out
}
pd_native_selection <- function(enrich,target) {
  if(!target$pathway %in% enrich$gs_id)stop('Selected target is absent from the native enrichment input.')
  unique(c(target$pathway,head(enrich$gs_id,5)))
}
pd_contrast_params <- function(fixture) {
  list(design_var='group',design_formula=deparse(fixture$design),contrast=fixture$contrast,
    covariates=setdiff(all.vars(fixture$design),'group'),treated='B',reference='A',
    shrink=TRUE,shrink_used='apeglm',min_count=fixture$matched$settings$filterMinCount,
    alpha=fixture$matched$settings$alpha,
    ctrl='A',case='B',supplied_group_A=fixture$matched$settings$conditionA,
    supplied_group_B=fixture$matched$settings$conditionB,
    supplied_rank_method=fixture$matched$settings$ranking,
    supplied_effect_method=fixture$matched$settings$effect,
    supplied_covariate_transformations=fixture$matched$settings$covariateTransformations,
    supplied_delivery=fixture$deliveryFields)
}
pd_rnamel_enrichment <- function(fixture,enrichment) {
  ranks<-fixture$matched$rankedGenes;fields<-fixture$nativeAnnotations
  membership<-setNames(lapply(seq_len(nrow(fields)),function(i)list(
    testedGenes=strsplit(fields$supplied_tested_genes[[i]],';',fixed=TRUE)[[1]],
    testedSize=fields$supplied_tested_gene_count[[i]],originalEs=fields$supplied_original_ES[[i]],
    reconstructedEs=fields$supplied_reconstructed_ES[[i]],absoluteDifference=fields$supplied_ES_absolute_difference[[i]],
    tolerance=fields$supplied_ES_tolerance[[i]])),fields$supplied_pathway_identifier)
  list(results=enrichment,supplied_analysis=fixture$analysisRecord,
    supplied_ranked_genes=data.frame(rank=seq_along(ranks),gene=names(ranks),stat=unname(ranks),stringsAsFactors=FALSE),
    supplied_tested_membership=membership,supplied_case_context=fixture$deliveryFields,
    import_origin='Captured external fgsea results; no RNAmel enrichment run was executed',
    generator_scope='The native generator emits labeled example/default enrichment code for this imported result; use the supplied exact reconstruction recipe.')
}
