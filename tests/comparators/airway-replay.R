#!/usr/bin/env Rscript
source("scripts/comparators/prepare_fixture.R")
comparator_libraries()
args <- commandArgs(TRUE)
if (length(args) < 1L || length(args) > 2L) stop("Usage: Rscript tests/comparators/airway-replay.R prepared-airway-fixture.rds [ordinary-PNV-reference_input.rds]")
fixture <- readRDS(args[[1]])
validate_comparator_fixture(fixture)
stopifnot(identical(fixture$dataOrigin, "public-airway-GSE52778"))
environment <- new.env(parent = emptyenv())
data("airway", package = "airway", envir = environment)
symbols <- as.character(SummarizedExperiment::rowData(environment$airway)$symbol)
keep <- !is.na(symbols) & nzchar(symbols)
counts <- rowsum(SummarizedExperiment::assay(environment$airway)[keep, , drop = FALSE], symbols[keep], reorder = FALSE)
source("scripts/lib/analysis_core.R")
source("scripts/lib/analysis_io.R")
intermediate <- tempfile(fileext = ".tsv")
data.table::fwrite(data.frame(gene_symbol = rownames(counts), counts, check.names = FALSE), intermediate, sep = "\t")
tryCatch({ mapped <- pnv_read_counts(intermediate, identifier_type = "symbol") }, finally = unlink(intermediate))
stopifnot(identical(mapped$counts, fixture$counts), identical(fixture$identifierType, "symbol"),
  isTRUE(fixture$matched$pnvIntegration$independentDirectPackageParity))
repeated <- fit_matched_fixture(fixture)
stopifnot(identical(rownames(repeated$res), rownames(fixture$matched$res)))
fields <- c("log2FoldChange", "lfcSE", "stat", "pvalue", "padj")
gene_checks <- lapply(fields, function(field) {
  a <- as.numeric(repeated$res[[field]]); b <- as.numeric(fixture$matched$res[[field]])
  stopifnot(identical(is.na(a), is.na(b)), isTRUE(all.equal(a, b, tolerance = 1e-8)))
  list(field = field, maximumAbsoluteDifference = max(abs(a - b), na.rm = TRUE))
})
stopifnot(identical(repeated$enrichment$pathway, fixture$matched$enrichment$pathway),
  identical(repeated$enrichment$leadingEdge, fixture$matched$enrichment$leadingEdge))
pathway_checks <- lapply(c("ES", "NES", "pval", "padj", "size"), function(field) {
  a <- repeated$enrichment[[field]]; b <- fixture$matched$enrichment[[field]]
  stopifnot(identical(is.na(a), is.na(b)), isTRUE(all.equal(a, b, tolerance = 1e-8)))
  list(field = field, maximumAbsoluteDifference = max(abs(a - b), na.rm = TRUE))
})
result <- list(status = "pass", scope = "Public fixture preparation repeated in the same recorded R environment",
  fixtureSha256 = comparator_hash(args[[1]]), inputCountsIdentical = TRUE, leadingEdgeIdentical = TRUE,
  geneChecks = gene_checks, pathwayChecks = pathway_checks, testSourceSha256 = comparator_hash("tests/comparators/airway-replay.R"))
if (length(args) == 2L) {
  primary <- readRDS(args[[2]])
  stopifnot(identical(primary$counts, fixture$counts), identical(primary$expected$genes$gene, fixture$matched$geneResults$gene),
    identical(primary$expected$pathways$pathway, fixture$matched$enrichment$pathway),
    identical(primary$expected$pathways$leadingEdge, fixture$matched$enrichment$leadingEdge))
  for (field in c("log2FoldChange", "lfcSE", "stat", "pvalue", "padj")) stopifnot(isTRUE(all.equal(primary$expected$genes[[field]], fixture$matched$geneResults[[field]], tolerance = 1e-8)))
  for (field in c("ES", "NES", "pval", "padj", "size")) stopifnot(isTRUE(all.equal(primary$expected$pathways[[field]], fixture$matched$enrichment[[field]], tolerance = 1e-8)))
  result$ordinaryPnvReference <- list(status = "pass", snapshotSha256 = comparator_hash(args[[2]]),
    mappedCountsIdentical = TRUE, primaryInferenceAndLeadingEdgeMatch = TRUE)
}
jsonlite::write_json(result, paste0(args[[1]], ".replay-validation.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
cat(jsonlite::toJSON(result, auto_unbox = TRUE), "\n")
