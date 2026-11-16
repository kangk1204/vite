#!/usr/bin/env Rscript
source("scripts/lib/analysis_core.R")
source("scripts/lib/analysis_io.R")
source("scripts/validate_analysis_reference.R")
source("scripts/analyze_neural_bulk_cohort.R")
source("scripts/run_local_analysis.R")

set.seed(415)
counts <- matrix(rnbinom(600 * 8, mu = 70, size = 6), 600,
  dimnames = list(paste0("TESTGENE", seq_len(600)), paste0("S", 1:8)))
counts[1:25, 5:8] <- counts[1:25, 5:8] * 3
metadata <- data.frame(sample = colnames(counts), group = rep(c("A", "B"), each = 4))
pathways <- list("R-HSA-TEST1 :: Positive" = rownames(counts)[1:25],
  "R-HSA-TEST2 :: Background" = rownames(counts)[80:125])
directory <- tempfile("pnv-r-io-")
dir.create(directory)
config <- list(designFormula = "~ group", seed = 20261110L, camera = TRUE,
  bootstrapReplicates = 0L, resultPrefix = "test", outputDir = directory,
  conditionA = "Control", conditionB = "Treatment", projectTitle = "Reference IO", datasetIdentifier = "SYNTHETIC_TEST")
result <- pnv_analyze_counts(counts, metadata, pathways, config)
paths <- pnv_write_outputs(result, config)
stopifnot(all(file.exists(unlist(paths[names(paths) != "referenceInput"]))))
evidence <- jsonlite::fromJSON(paths$evidence, simplifyVector = FALSE)
stopifnot(evidence$schemaVersion == 2, evidence$evidence$verification$status == "internally_consistent",
  evidence$evidence$analysis$method == "DESeq2+fgsea", evidence$evidence$analysis$lfcMethod == "apeglm",
  length(evidence$evidence$sourceTables$genes$rows) == 600,
  length(evidence$evidence$pathways) == 2,
  evidence$evidence$analysis$pathwayHypothesisCount == 2)
stopifnot(length(utils::unzip(paths$workbook, list = TRUE)$Name) > 4)

bundle <- list(counts = counts, metadata = metadata, pathways = pathways, config = config,
  expected = list(genes = result$geneResults, pathways = as.data.frame(result$pathwayResults), camera = result$cameraResults))
comparison <- validate_reference_bundle(bundle)
stopifnot(comparison$status == "pass", all(vapply(comparison$checks, function(x) x$pass, logical(1))))
stopifnot(!reference_numeric_equal(c(NA_real_, 1), c(0, 1)),
  !reference_numeric_equal(c(1, 2), c(1, 2.01)))

# Empty references generate an empty pathway sheet/record, never synthetic significant signatures.
empty <- result
empty$pathwayResults <- pnv_empty_pathways()
empty$cameraResults <- result$cameraResults[0, ]
empty_paths <- pnv_write_outputs(empty, modifyList(config, list(resultPrefix = "empty")))
empty_json <- jsonlite::fromJSON(empty_paths$evidence, simplifyVector = FALSE)
stopifnot(length(empty_json$evidence$pathways) == 0,
  empty_json$evidence$analysis$pathwayHypothesisCount == 0)

# A non-estimable reference direction stays null in the evidence JSON.
missing <- result
missing$pathwayResults$NES[1] <- NA_real_
missing$bootstrap <- list(requested = 1L, completed = 1L, failures = list(),
  pathways = pnv_summarize_bootstrap(missing$pathwayResults$pathway, missing$pathwayResults$NES,
    list(as.data.frame(result$pathwayResults)), 1L, 0.05))
missing_paths <- pnv_write_outputs(missing, modifyList(config, list(resultPrefix = "missing")))
missing_json <- jsonlite::fromJSON(missing_paths$evidence, simplifyVector = FALSE)
stopifnot(is.null(missing_json$evidence$pathways[[1]]$bootstrap$directionMatches),
  is.null(missing_json$evidence$pathways[[1]]$bootstrap$directionConsistency))

# File boundary never truncates fractional or silently negative counts.
bad_counts <- file.path(directory, "fractional.tsv")
writeLines(c("gene\tS1\tS2", "TP53\t0.5\t10"), bad_counts)
error <- tryCatch(pnv_read_counts(bad_counts, "symbol"), error = identity)
stopifnot(inherits(error, "error"), grepl("integer", conditionMessage(error)))
alignment_error <- tryCatch(align_sample_metadata_to_counts(data.table::data.table(sample = c("S1", "MISSING")),
  counts, list()), error = identity)
stopifnot(inherits(alignment_error, "error"), grepl("align", conditionMessage(alignment_error)))

# Numeric-looking batch labels are categorical identities, not a linear trend.
batch_metadata_path <- file.path(directory, "numeric_batches.tsv")
data.table::fwrite(data.frame(sample = paste0("B", 1:6), group = rep(c("A", "B"), 3),
  batch = rep(1:3, each = 2)), batch_metadata_path, sep = "\t")
batch_metadata <- pnv_read_metadata(batch_metadata_path)
batch_counts <- counts[, 1:6]; colnames(batch_counts) <- batch_metadata$sample
batch_design <- pnv_validate_inputs(batch_counts, batch_metadata, list(designFormula = "~ batch + group"))
stopifnot(is.character(batch_metadata$batch), ncol(batch_design$designMatrix) == 4L,
  all(c("batch2", "batch3", "groupB") %in% colnames(batch_design$designMatrix)))
identifier_metadata_path <- file.path(directory, "identifier_types.tsv")
writeLines(c("sample\tgroup\tbatch\tdonor\tage", "001\tA\t01\t0007\t35",
  "002\tB\t02\t0008\t40"), identifier_metadata_path)
identifier_metadata <- pnv_read_metadata(identifier_metadata_path, numeric_covariates = "age")
stopifnot(identical(identifier_metadata$sample, c("001", "002")),
  identical(identifier_metadata$batch, c("01", "02")),
  identical(identifier_metadata$donor, c("0007", "0008")), is.numeric(identifier_metadata$age))
untyped_metadata <- pnv_read_metadata(identifier_metadata_path)
stopifnot(is.character(untyped_metadata$age))
identifier_counts_path <- file.path(directory, "identifier_counts.tsv")
writeLines(c("GeneID\t001\t002", "7157\t10\t12", "0007157\t8\t9"), identifier_counts_path)
identifier_counts <- pnv_read_counts(identifier_counts_path, "gene_id")
stopifnot(identical(identifier_counts$mapping$original_id, c("7157", "0007157")),
  identical(colnames(identifier_counts$counts), c("001", "002")))

captured_file <- file.path(directory, "captured.txt")
writeLines("original", captured_file)
capture_config <- file.path(directory, "config.json")
writeLines("{}", capture_config)
captured_context <- pnv_capture_run_context(list(rawCountsPath = captured_file,
  sampleMetadataPath = captured_file), capture_config, "scripts/run_local_analysis.R")
stopifnot(all(c("raw_counts", "sample_metadata", "reference", "analysis_code", "environment") %in%
  vapply(captured_context$artifacts, function(a) a$role, character(1))),
  any(startsWith(vapply(captured_context$artifacts, function(a) a$path, character(1)), "project:")))
pnv_assert_run_context(captured_context)
context <- list(artifacts = list(list(path = captured_file, sha256 = digest::digest(file = captured_file, algo = "sha256"))))
pnv_assert_run_context(context)
writeLines("modified", captured_file)
changed_error <- tryCatch(pnv_assert_run_context(context), error = identity)
stopifnot(inherits(changed_error, "error"), grepl("changed during", conditionMessage(changed_error)))

unlink(directory, recursive = TRUE)
cat("PASS: independent package parity, workbook/evidence IO, no-pathway and nullable-direction evidence, strict file/alignment guards\n")
