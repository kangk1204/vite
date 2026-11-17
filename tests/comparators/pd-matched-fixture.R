source('scripts/comparators/prepare_pd_fixture.R')
expect_error <- function(f, pattern) {
  x <- tryCatch({ f(); NA_character_ }, error=function(e) conditionMessage(e))
  stopifnot(!is.na(x), grepl(pattern, x, ignore.case=TRUE))
}
genes <- paste0('G', 1:30)
target <- 'R-HSA-449147 :: Signaling by Interleukins'
md <- data.frame(sample=paste0('S',1:73),group=rep(c('A','B'),c(44,29)),
 age=as.numeric(scale(1:73)),pmi=as.numeric(scale((1:73)%%7)),rin=as.numeric(scale((1:73)%%11)))
cfg <- list(datasetIdentifier='GSE68719',designFormula='~ pmi + age + rin + group',numericCovariates=c('pmi','age','rin'),
 covariateTransformations=setNames(lapply(1:3,function(i)list(method='z_standardization',sampleCount=73L)),c('pmi','age','rin')))
g <- data.frame(gene=genes,baseMean=1:30,log2FoldChange=(1:30)/10,lfcSE=.1,stat=1:30,pvalue=.01,padj=.02,
 log2FoldChangeUnshrunk=(1:30)/9,lfcSEUnshrunk=.2)
g$pvalue[1] <- g$padj[1] <- NA_real_
p <- data.frame(pathway=target,pval=.01,padj=.01,ES=.5,NES=2,size=20L)
p$leadingEdge <- list(genes[1:4])
x <- list(counts=matrix(1:(30*73),30,dimnames=list(genes,md$sample)),metadata=md,config=cfg,
 pathways=setNames(list(genes[1:20]),target),expected=list(genes=g,pathways=p,camera=data.frame()))
stopifnot(identical(pd_validate_snapshot(x),target),identical(x$metadata,md),pd_compare_primary(g,p,x$expected)$status=='pass')
a<-g;a$stat[2]<-a$stat[2]+1e-10;stopifnot(pd_compare_primary(a,p,x$expected)$status=='pass')
a$pvalue[1]<-0;expect_error(function()pd_compare_primary(a,p,x$expected),'pvalue')
a<-p;a$leadingEdge[[1]]<-genes[2:5];expect_error(function()pd_compare_primary(g,a,x$expected),'leading')
a<-p;a$NES[1]<-3;expect_error(function()pd_compare_primary(g,a,x$expected),'NES')
a<-x;a$metadata$sample[2]<-a$metadata$sample[1];expect_error(function()pd_validate_snapshot(a),'sample')
a<-x;a$metadata$age<-a$metadata$age+2;expect_error(function()pd_validate_snapshot(a),'standard')
a<-x;a$expected$pathways$pathway<-'R-HSA-other';expect_error(function()pd_validate_snapshot(a),'target')
a<-x;a$counts<-a$counts[,-1,drop=FALSE];expect_error(function()pd_validate_snapshot(a),'73|sample')
cat('PD fixture validation/parity failure tests passed\n')
