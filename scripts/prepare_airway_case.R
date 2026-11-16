#!/usr/bin/env Rscript
# Materialize a documented, paired human reference example without a GEO network request.
prepare_airway_case <- function(output_dir) {
  if (!requireNamespace("airway", quietly = TRUE)) stop("Install the Bioconductor airway data package first.")
  environment <- new.env(parent = emptyenv())
  utils::data("airway", package = "airway", envir = environment)
  experiment <- environment$airway
  annotation <- as.data.frame(SummarizedExperiment::rowData(experiment))
  symbols <- as.character(annotation$symbol)
  keep <- !is.na(symbols) & nzchar(symbols)
  counts <- rowsum(SummarizedExperiment::assay(experiment)[keep, , drop = FALSE], symbols[keep], reorder = FALSE)
  metadata <- as.data.frame(SummarizedExperiment::colData(experiment))
  samples <- data.frame(sample = rownames(metadata), group = ifelse(metadata$dex == "untrt", "A", "B"),
    donor = as.character(metadata$cell), stringsAsFactors = FALSE)
  stopifnot(ncol(counts) == 8, length(unique(samples$donor)) == 4,
    all(table(samples$donor, samples$group) == 1))
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
  raw_path <- file.path(output_dir, "airway_counts.tsv")
  metadata_path <- file.path(output_dir, "airway_samples.tsv")
  data.table::fwrite(data.frame(gene_symbol = rownames(counts), counts, check.names = FALSE), raw_path, sep = "\t")
  data.table::fwrite(samples, metadata_path, sep = "\t")
  data.table::fwrite(data.frame(original_id = rownames(experiment), gene_symbol = symbols,
    status = ifelse(keep, "symbol_from_airway_annotation", "unmapped_excluded")),
    file.path(output_dir, "airway_annotation.tsv"), sep = "\t", na = "")
  config <- list(cohortKey = "airway_paired_reference", datasetIdentifier = "GSE52778 (airway subset)",
    projectTitle = "Paired airway smooth muscle dexamethasone reference", contrastName = "dexamethasone_vs_untreated",
    conditionA = "Untreated", conditionB = "Dexamethasone", rawCountsPath = raw_path,
    sampleMetadataPath = metadata_path, geneIdentifierType = "symbol", designFormula = "~ donor + group",
    resultPrefix = "airway_paired", outputDir = file.path(output_dir, "results"),
    referencePath = "data/reference/ReactomePathways.gmt.zip", seed = 20261110L, camera = TRUE,
    bootstrapReplicates = 0L, filterMinCount = 10, filterMinFraction = 0.15,
    sampleGroupSource = "airway package colData; each of four donors contributes one untreated and one treated sample.",
    notes = paste("Paired implementation reference, not a new biological finding. airway package version", as.character(utils::packageVersion("airway"))))
  config_path <- file.path(output_dir, "airway_config.json")
  jsonlite::write_json(config, config_path, auto_unbox = TRUE, pretty = TRUE)
  cat(config_path, "\n")
  invisible(config_path)
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) != 1L) stop("Usage: Rscript scripts/prepare_airway_case.R <output-directory>")
  prepare_airway_case(args[[1]])
}
