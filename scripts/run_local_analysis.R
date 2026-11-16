#!/usr/bin/env Rscript
source("scripts/lib/analysis_core.R")
source("scripts/lib/analysis_io.R")

run_local_analysis <- function(config_path) {
  pnv_require("jsonlite")
  config <- jsonlite::fromJSON(config_path)
  if (is.null(config$rawCountsPath) || is.null(config$sampleMetadataPath)) {
    stop("Configuration requires rawCountsPath and sampleMetadataPath.", call. = FALSE)
  }
  config$runContext <- pnv_capture_run_context(config, config_path, "scripts/run_local_analysis.R")
  mapped <- pnv_read_counts(config$rawCountsPath, pnv_default(config$geneIdentifierType, "auto"),
    pnv_default(config$geneMapPath, "src/reference/generated/ncbi_gene_map.json"),
    pnv_default(config$aliasesPath, "src/reference/generated/aliases.json"))
  metadata <- pnv_read_metadata(config$sampleMetadataPath, pnv_default(config$numericCovariates, character()))
  if (any(!metadata$sample %in% colnames(mapped$counts))) {
    stop("Included sample metadata does not match count column names.", call. = FALSE)
  }
  excluded <- setdiff(colnames(mapped$counts), metadata$sample)
  config$excludedSamples <- lapply(excluded, function(id) list(sample = id, reason = "not_in_explicit_included_sample_metadata"))
  counts <- mapped$counts[, metadata$sample, drop = FALSE]
  pathways <- pnv_read_pathways(pnv_default(config$referencePath, "data/reference/ReactomePathways.gmt.zip"))
  result <- pnv_analyze_counts(counts, metadata, pathways, config)
  paths <- pnv_write_outputs(result, config, mapped$mapping)
  saveRDS(list(counts = counts, metadata = metadata, pathways = pathways,
    config = modifyList(config, list(bootstrapReplicates = 0L)), expected = list(
      genes = result$geneResults, pathways = as.data.frame(result$pathwayResults), camera = result$cameraResults)),
    paths$referenceInput)
  cat(jsonlite::toJSON(list(status = "complete", outputs = paths), auto_unbox = TRUE), "\n")
  invisible(paths)
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) != 1) stop("Usage: Rscript scripts/run_local_analysis.R <config.json>", call. = FALSE)
  run_local_analysis(args[[1]])
}
