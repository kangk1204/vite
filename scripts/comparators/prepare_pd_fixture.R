#!/usr/bin/env Rscript
# Reconstruct one DDS while supplying the retained PD inference arrays unchanged.
source('scripts/comparators/fixture_support.R')
source('scripts/validate_analysis_reference.R')

pd_validate_snapshot <- function(capture, target_id='R-HSA-449147') {
  required <- c('counts','metadata','config','pathways','expected')
  if (!all(required %in% names(capture))) stop('Incomplete PD reference snapshot.')
  counts <- capture$counts; metadata <- capture$metadata; cfg <- capture$config
  if (!identical(cfg$datasetIdentifier,'GSE68719') || ncol(counts)!=73L || nrow(metadata)!=73L ||
      anyDuplicated(metadata$sample) || anyDuplicated(colnames(counts)) ||
      !setequal(metadata$sample,colnames(counts))) stop('PD snapshot must retain all 73 unique samples.')
  if (!identical(as.integer(table(factor(metadata$group,levels=c('A','B')))),c(44L,29L))) stop('PD group mapping differs.')
  for (variable in cfg$numericCovariates) {
    values <- metadata[[variable]]; rule <- cfg$covariateTransformations[[variable]]
    if (!is.numeric(values) || any(!is.finite(values)) || abs(mean(values))>1e-8 || abs(sd(values)-1)>1e-8 ||
        !identical(rule$method,'z_standardization')) stop('Recorded standardized covariate differs: ',variable)
  }
  design <- model.matrix(as.formula(cfg$designFormula),transform(metadata,group=factor(group,levels=c('A','B'))))
  if (qr(design)$rank!=ncol(design) || nrow(design)<=ncol(design)) stop('PD design is not estimable.')
  genes <- capture$expected$genes; pathways <- capture$expected$pathways
  if (anyDuplicated(genes$gene) || any(!genes$gene %in% rownames(counts)) || anyDuplicated(pathways$pathway)) stop('Captured result identifiers differ.')
  target <- pathways$pathway[sub(' :: .*','',pathways$pathway)==target_id]
  if (length(target)!=1L || !target %in% names(capture$pathways)) stop('Target pathway is absent or ambiguous.')
  target
}

pd_compare_primary <- function(genes,pathways,expected,tolerance=1e-8) {
  checks <- list()
  add <- function(id,pass,a=NULL,b=NULL) {
    finite <- if (is.null(a)) logical() else is.finite(a)&is.finite(b)
    checks[[length(checks)+1L]] <<- list(id=id,pass=isTRUE(pass),
      maximumAbsoluteDifference=if(any(finite))max(abs(a[finite]-b[finite]))else NULL)
  }
  add('gene-identifiers',identical(genes$gene,expected$genes$gene))
  if (!identical(genes$gene,expected$genes$gene)) stop('Frozen PD parity failed: gene identifiers')
  fields <- c('baseMean','log2FoldChange','lfcSE','stat','pvalue','padj','log2FoldChangeUnshrunk','lfcSEUnshrunk')
  for (field in fields) add(paste0('genes-',field),reference_numeric_equal(genes[[field]],expected$genes[[field]],tolerance),genes[[field]],expected$genes[[field]])
  add('pathway-identifiers',setequal(pathways$pathway,expected$pathways$pathway))
  original <- expected$pathways[match(pathways$pathway,expected$pathways$pathway),,drop=FALSE]
  for (field in c('ES','NES','pval','padj','size')) add(paste0('pathways-',field),reference_numeric_equal(pathways[[field]],original[[field]],tolerance),pathways[[field]],original[[field]])
  add('leading-edge-sets',length(pathways$leadingEdge)==length(original$leadingEdge)&&all(vapply(seq_along(pathways$leadingEdge),function(i)setequal(pathways$leadingEdge[[i]],original$leadingEdge[[i]]),logical(1))))
  failed <- vapply(Filter(function(x)!x$pass,checks),`[[`,character(1),'id')
  if (length(failed)) stop('Frozen PD parity failed: ',paste(failed,collapse=', '))
  list(status='pass',absoluteTolerance=tolerance,relativeTolerance=tolerance,checks=checks,
    scope='Same-environment reconstruction of retained primary arrays; no bootstrap or alternative-method rerun.')
}

pd_native_annotations <- function(capture,evidence) {
  p<-capture$expected$pathways;ids<-sub(' :: .*','',p$pathway)
  ranks<-setNames(capture$expected$genes$stat,capture$expected$genes$gene)
  ranks<-ranks[is.finite(ranks)];ranks<-ranks[order(-ranks,names(ranks))]
  members<-lapply(p$pathway,function(name)intersect(unique(capture$pathways[[name]]),names(ranks)))
  stopifnot(identical(as.integer(lengths(members)),as.integer(p$size)))
  details<-lapply(ids,function(id)evidence$pathways[[id]])
  num<-function(part,key)vapply(details,function(x)if(is.null(x[[part]][[key]]))NA_real_ else as.numeric(x[[part]][[key]]),numeric(1))
  txt<-function(part,key)vapply(details,function(x)if(is.null(x[[part]][[key]]))NA_character_ else as.character(x[[part]][[key]]),character(1))
  group<-lapply(details,function(x)if(length(x$designSensitivity))x$designSensitivity[[1]]else NULL)
  gv<-function(key,as_numeric=FALSE)vapply(group,function(x) {
    v<-x[[key]];if(is.null(v))if(as_numeric)NA_real_ else NA_character_ else if(as_numeric)as.numeric(v)else as.character(v)
  },if(as_numeric)numeric(1)else character(1))
  camera<-evidence$sourceTables$camera;column<-match('pathway',unlist(camera$columns))
  camera_ids<-sub(' :: .*','',vapply(camera$rows,function(row)as.character(row[[column]]),character(1)))
  data.frame(pathway=p$pathway,supplied_pathway_identifier=ids,
    supplied_original_ES=p$ES,supplied_tested_gene_count=p$size,
    supplied_tested_genes=vapply(members,paste,collapse=';',character(1)),
    supplied_rank_universe_size=length(ranks),supplied_rank_universe_file='shared-evidence/ranked-genes.tsv',
    supplied_design=capture$config$designFormula,supplied_positive_contrast='B versus A',
    supplied_group_A=capture$config$conditionA,supplied_group_B=capture$config$conditionB,
    supplied_group_only_design=gv('designFormula'),supplied_group_only_NES=gv('nes',TRUE),supplied_group_only_FDR=gv('padj',TRUE),
    supplied_group_only_source_row=vapply(group,function(x)if(is.null(x$source$row))NA_integer_ else as.integer(x$source$row),integer(1)),
    supplied_CAMERA_direction=txt('camera','direction'),supplied_CAMERA_FDR=num('camera','padj'),
    supplied_CAMERA_test='TMM/limma-voom CAMERA competitive test; separate from fgsea',supplied_CAMERA_source_row=match(ids,camera_ids),
    supplied_bootstrap_selected=num('bootstrap','selected'),supplied_bootstrap_testable=num('bootstrap','valid'),
    supplied_bootstrap_requested=num('bootstrap','requested'),supplied_bootstrap_direction_agreement=num('bootstrap','directionMatches'),
    supplied_bootstrap_meaning='Conditional frequency among testable resamples; not independent-study replication probability',
    check.names=FALSE,stringsAsFactors=FALSE)
}

prepare_pd_fixture <- function(output, snapshot, evidence_file) {
  comparator_libraries()
  if(file.exists(output))stop('Fixture already exists; choose a new output path.')
  source('scripts/lib/analysis_diagnostics.R');source('scripts/lib/analysis_core.R')
  files<-c('scripts/comparators/prepare_pd_fixture.R','scripts/comparators/fixture_support.R',
    'scripts/validate_analysis_reference.R','scripts/lib/analysis_core.R','scripts/lib/analysis_diagnostics.R',
    'renv.lock',snapshot,evidence_file,'paper/evaluation/matched_tasks_2026_11_17.json')
  hashes<-as.list(setNames(vapply(files,comparator_hash,character(1)),files))
  capture<-readRDS(snapshot);target<-pd_validate_snapshot(capture)
  evidence<-jsonlite::read_json(evidence_file)$evidence
  recorded<-vapply(Filter(function(a)identical(a$role,'reference_snapshot'),evidence$artifacts),`[[`,character(1),'sha256')
  if(!length(recorded)||any(recorded!=comparator_hash(snapshot)))stop('Reference RDS does not match recorded artifact digests.')
  warnings<-character();start<-proc.time()[[3]]
  dir.create(dirname(output),recursive=TRUE,showWarnings=FALSE)
  cache_path<-paste0(output,'.primary-cache.rds');reused_primary<-file.exists(cache_path)
  if(reused_primary) {
    cache<-readRDS(cache_path)
    for(name in setdiff(names(hashes),'scripts/comparators/prepare_pd_fixture.R'))
      if(!identical(cache$sourceHashes[[name]],hashes[[name]]))stop('Cached primary input/engine binding differs: ',name)
    primary<-cache$primary
  } else {
    primary<-withCallingHandlers(pnv_fit_primary(capture$counts,capture$metadata,capture$config),warning=function(w){warnings<<-c(warnings,conditionMessage(w))})
    saveRDS(list(primary=primary,sourceHashes=hashes),cache_path)
  }
  recomputed<-pnv_score_pathways(setNames(primary$geneResults$stat,primary$geneResults$gene),capture$pathways,capture$config)
  proof<-pd_compare_primary(primary$geneResults,as.data.frame(recomputed),capture$expected)
  jsonlite::write_json(proof,paste0(output,'.parity.json'),auto_unbox=TRUE,pretty=TRUE,digits=NA)
  for(variable in capture$config$numericCovariates)stopifnot(identical(primary$metadata[[variable]],capture$metadata[[variable]]))
  genes<-capture$expected$genes;pathways<-as.data.frame(capture$expected$pathways)
  ranks<-setNames(genes$stat,genes$gene);ranks<-ranks[is.finite(ranks)];ranks<-ranks[order(-ranks,names(ranks))]
  annotations<-pd_native_annotations(capture,evidence)
  reconstructed<-vapply(pathways$pathway,function(name) {
    members<-intersect(unique(capture$pathways[[name]]),names(ranks))
    fgsea::calcGseaStat(ranks,sort(match(members,names(ranks))),gseaParam=1,scoreType='std')
  },numeric(1))
  stopifnot(reference_numeric_equal(unname(reconstructed),pathways$ES,1e-8))
  annotations$supplied_reconstructed_ES<-unname(reconstructed)
  annotations$supplied_ES_absolute_difference<-abs(reconstructed-pathways$ES)
  annotations$supplied_ES_tolerance<-1e-8
  annotations$supplied_ES_reconstruction_method<-'fgsea::calcGseaStat on retained ordered Wald ranks and exact tested membership'
  metadata<-capture$metadata
  metadata$condition<-factor(metadata$group,levels=c('A','B'),labels=c(capture$config$conditionA,capture$config$conditionB))
  SummarizedExperiment::colData(primary$dds)$condition<-metadata$condition
  res<-DESeq2::DESeqResults(S4Vectors::DataFrame(genes[,c('baseMean','log2FoldChange','lfcSE','stat','pvalue','padj')],row.names=genes$gene),priorInfo=list(type='apeglm'))
  settings<-list(designFormula=capture$config$designFormula,contrast=c('group','B','A'),
    conditionA=capture$config$conditionA,conditionB=capture$config$conditionB,seed=capture$config$seed,alpha=.05,
    filterMinCount=capture$config$filterMinCount,filterMinFraction=capture$config$filterMinFraction,
    inference='Captured original DESeq2 Wald test',effect='Captured apeglm posterior mode and SD',
    ranking='Finite original Wald statistics',minSize=15L,maxSize=500L,covariateTransformations=capture$config$covariateTransformations)
  fixture<-list(schemaVersion=2L,id='GSE68719-PD-matched',dataOrigin='public-GSE68719-PD',
    identifierType='symbol',identifierRule='Exact captured PNV gene identifiers; no remapping',
    counts=capture$counts,metadata=metadata,pathways=capture$pathways,design=as.formula(capture$config$designFormula),
    contrast=c('group','B','A'),config=capture$config,sources=hashes,target=list(pathwayId='R-HSA-449147',pathway=target),
    nativeAnnotations=annotations,analysisRecord=evidence$analysis,
    matched=list(dds=primary$dds,res=res,enrichment=pathways,geneResults=genes,rankedGenes=ranks,settings=settings))
  validate_comparator_fixture(fixture)
  for(name in names(hashes))if(comparator_hash(name)!=hashes[[name]])stop('Source changed during reconstruction: ',name)
  dir.create(dirname(output),recursive=TRUE,showWarnings=FALSE);saveRDS(fixture,output,version=3)
  write_comparator_table(genes,paste0(output,'.genes.tsv'));write_comparator_table(pathways,paste0(output,'.pathways.tsv'))
  write_comparator_table(annotations,paste0(output,'.native-annotations.tsv'))
  receipt<-list(schemaVersion=2L,fixtureSha256=comparator_hash(output),sourceHashes=hashes,target=fixture$target,
    samples=73L,groups=list(A=44L,B=29L),testedGenes=nrow(genes),testedPathways=nrow(pathways),
    reconstruction=proof,primaryFits=if(reused_primary)0L else 1L,primaryCacheReused=reused_primary,
    primaryCacheSha256=comparator_hash(cache_path),pathwayScorings=1L,bootstrapReruns=0L,covariatesRescaled=FALSE,
    suppliedArrays='Original retained arrays after reconstruction parity, not refitted replacements',
    ESReconstructionMaximumAbsoluteDifference=max(abs(reconstructed-pathways$ES)),
    command=c('Rscript','scripts/comparators/prepare_pd_fixture.R',output,snapshot,evidence_file),
    warnings=unique(warnings),elapsedSeconds=proc.time()[[3]]-start,
    packageVersions=comparator_versions(c('DESeq2','apeglm','fgsea','GeneTonic','RNAmel')),sessionInfo=capture.output(sessionInfo()))
  jsonlite::write_json(receipt,paste0(output,'.json'),auto_unbox=TRUE,pretty=TRUE,digits=NA,na='null',null='null')
  cat(jsonlite::toJSON(receipt[c('fixtureSha256','testedGenes','testedPathways','samples','ESReconstructionMaximumAbsoluteDifference')],auto_unbox=TRUE),'\n')
}
if(sys.nframe()==0L) {
  args<-commandArgs(TRUE)
  if(length(args)!=3L)stop('Usage: prepare_pd_fixture.R output.rds original-reference.rds original-report-evidence.json')
  prepare_pd_fixture(args[[1]],args[[2]],args[[3]])
}
