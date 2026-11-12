#!/usr/bin/env bash
# Run inside the archived R-only image with a candidate restore script mounted at /update.
set -euo pipefail
cd /opt/pnv
case "${1:-ordinary-restore}" in
  ordinary-restore)
    export PNV_REPLAY_SMOKE_MODE=ordinary-restore PNV_REPLAY_RESTORE_SCRIPT=/update/restore_analysis_env.R
    Rscript -e 'stopifnot(as.character(getRversion())=="4.5.1", !requireNamespace("R.utils",quietly=TRUE));cat("Confirmed clean R image lacked R.utils before restore.\n")'
    Rscript "$PNV_REPLAY_RESTORE_SCRIPT" ;;
  built-image)
    export PNV_REPLAY_SMOKE_MODE=built-image PNV_REPLAY_RESTORE_SCRIPT=/opt/pnv/scripts/restore_analysis_env.R
    Rscript -e 'stopifnot(as.character(getRversion())=="4.5.1", requireNamespace("R.utils",quietly=TRUE))' ;;
  *) echo 'Expected ordinary-restore or built-image' >&2; exit 2 ;;
esac
Rscript scripts/verify_analysis_env.R > /proof/after-environment.json
Rscript - <<'RS'
source('scripts/lib/analysis_core.R'); source('scripts/lib/analysis_io.R')
pathways <- pnv_read_pathways()
eligible <- pathways[lengths(pathways) >= 20 & lengths(pathways) <= 100]
genes <- head(unique(c(eligible[[1]], unlist(eligible, use.names=FALSE))), 600)
set.seed(20261112)
samples <- paste0('S', seq_len(8)); counts <- matrix(rnbinom(length(genes)*8,mu=80,size=5),nrow=length(genes),dimnames=list(genes,samples))
counts[seq_len(20),5:8] <- counts[seq_len(20),5:8]*3L
dir <- '.cache/ordinary-gzip-smoke'; dir.create(dir,recursive=TRUE,showWarnings=FALSE)
file <- file.path(dir,'counts.tsv.gz'); con <- gzfile(file,'wt'); write.table(data.frame(gene=genes,counts,check.names=FALSE),con,sep='\t',quote=FALSE,row.names=FALSE);close(con)
md <- file.path(dir,'samples.tsv');write.table(data.frame(sample=samples,group=rep(c('A','B'),each=4)),md,sep='\t',quote=FALSE,row.names=FALSE)
cfg <- list(rawCountsPath=file,sampleMetadataPath=md,outputDir=file.path(dir,'output'),resultPrefix='smoke',conditionA='Control',conditionB='Treatment',projectTitle='Synthetic gzip reader smoke',geneIdentifierType='symbol',designFormula='~ group',bootstrapReplicates=0L,camera=TRUE)
jsonlite::write_json(cfg,file.path(dir,'config.json'),auto_unbox=TRUE)
RS
Rscript scripts/run_local_analysis.R .cache/ordinary-gzip-smoke/config.json
Rscript - <<'RS'
ev<-jsonlite::fromJSON('.cache/ordinary-gzip-smoke/output/smoke_evidence.json',simplifyVector=FALSE)
stopifnot(ev$schemaVersion==2,ev$evidence$analysis$geneHypothesisCount>0,ev$evidence$analysis$pathwayHypothesisCount>0)
pkgs<-c('R.utils','R.oo','R.methodsS3')
jsonlite::write_json(list(status='pass',mode=Sys.getenv('PNV_REPLAY_SMOKE_MODE'),input='synthetic 600-gene/8-sample gzipped count matrix',entrypoint='Rscript scripts/run_local_analysis.R',genes=ev$evidence$analysis$geneHypothesisCount,pathways=ev$evidence$analysis$pathwayHypothesisCount,readers=setNames(lapply(pkgs,function(p)as.character(packageVersion(p))),pkgs),restoreScriptSha256=digest::digest(file=Sys.getenv('PNV_REPLAY_RESTORE_SCRIPT'),algo='sha256')), '/proof/ordinary-restore.json',auto_unbox=TRUE,pretty=TRUE)
RS
