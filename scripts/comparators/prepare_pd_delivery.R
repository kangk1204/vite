#!/usr/bin/env Rscript
source('scripts/comparators/fixture_support.R')
pd_context_fields <- function(context,settings) {
  allowed<-c('protocolVersion','contractSha256','deliveryId','targetPathwayId','requestedContrast','actualContrast','actualDesign','declaredFiles','deliveredFiles')
  if(!setequal(names(context),allowed)||!context$deliveryId %in% c('D01','D02','D03'))stop('Native context must contain only the declared raw input fields and a neutral ID.')
  if(!identical(context$actualContrast$conditionA,settings$conditionA)||!identical(context$actualContrast$conditionB,settings$conditionB)||!identical(context$actualDesign,settings$designFormula))stop('Actual contrast/design differs from the retained analysis.')
  list(supplied_case_id=context$deliveryId,supplied_requested_group_A=context$requestedContrast$conditionA,
    supplied_requested_group_B=context$requestedContrast$conditionB,
    supplied_declared_files=as.character(jsonlite::toJSON(context$declaredFiles,auto_unbox=TRUE,null='null',digits=NA)),
    supplied_delivered_files=as.character(jsonlite::toJSON(context$deliveredFiles,auto_unbox=TRUE,null='null',digits=NA)))
}
prepare_pd_delivery <- function(base_file,context_file,output) {
  comparator_libraries()
  if(file.exists(output))stop('Derived fixture exists; choose a new path.')
  original<-readRDS(base_file);base_receipt<-jsonlite::read_json(paste0(base_file,'.json'))
  if(comparator_hash(base_file)!=base_receipt$fixtureSha256)stop('Base fixture digest differs.')
  context<-jsonlite::read_json(context_file)
  if(context$contractSha256!=comparator_hash('paper/evaluation/matched_tasks_2026_11_17.json'))stop('Task contract digest differs.')
  if(context$targetPathwayId!=original$target$pathwayId)stop('Context target differs.')
  fields<-pd_context_fields(context,original$matched$settings)
  fixture<-original
  if(any(names(fields)%in%names(fixture$nativeAnnotations)))stop('A contextualized fixture cannot be reused as the base.')
  for(name in names(fields))fixture$nativeAnnotations[[name]]<-fields[[name]]
  fixture$deliveryFields<-context
  fixture$sources[[context_file]]<-comparator_hash(context_file)
  fixture$sources[['scripts/comparators/prepare_pd_delivery.R']]<-comparator_hash('scripts/comparators/prepare_pd_delivery.R')
  stopifnot(identical(fixture$matched,original$matched),identical(fixture$counts,original$counts))
  dir.create(dirname(output),recursive=TRUE,showWarnings=FALSE);saveRDS(fixture,output,version=3)
  jsonlite::write_json(list(schemaVersion=2L,fixtureSha256=comparator_hash(output),
    baseFixtureSha256=base_receipt$fixtureSha256,contextSha256=comparator_hash(context_file),
    contractSha256=context$contractSha256,deliveryId=context$deliveryId,
    primaryFits=0L,bootstrapReruns=0L,originalArraysIdentical=TRUE,sourceHashes=fixture$sources,
    command=c('Rscript','scripts/comparators/prepare_pd_delivery.R',base_file,context_file,output),
    suppliedFieldNames=names(fields),target=fixture$target),paste0(output,'.json'),auto_unbox=TRUE,pretty=TRUE,digits=NA)
  cat('Derived raw-context fixture:',context$deliveryId,'without refitting\n')
}
if(sys.nframe()==0L){a<-commandArgs(TRUE);if(length(a)!=3L)stop('Usage: prepare_pd_delivery.R base.rds native-context.json output.rds');prepare_pd_delivery(a[[1]],a[[2]],a[[3]])}
