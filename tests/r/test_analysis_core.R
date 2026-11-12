#!/usr/bin/env Rscript
# Base-R regression suite: no optional testing framework is required.
source("scripts/lib/analysis_core.R")

assert_error <- function(expression, pattern) {
  error <- tryCatch({ force(expression); NULL }, error = identity)
  if (is.null(error) || !grepl(pattern, conditionMessage(error), ignore.case = TRUE)) {
    stop(sprintf("Expected error matching '%s'; got %s", pattern,
      if (is.null(error)) "success" else conditionMessage(error)))
  }
}

set.seed(410)
counts <- matrix(rnbinom(800 * 12, mu = 80, size = 5), nrow = 800,
  dimnames = list(paste0("GENE", seq_len(800)), paste0("S", seq_len(12))))
counts[1:35, 7:12] <- counts[1:35, 7:12] * 4L
metadata <- data.frame(sample = colnames(counts), group = rep(c("A", "B"), each = 6),
  donor = rep(paste0("D", seq_len(6)), 2), stringsAsFactors = FALSE)
pathways <- list("R-HSA-TEST1 :: Signal" = rownames(counts)[1:35],
  "R-HSA-TEST2 :: Background" = rownames(counts)[100:160],
  "R-HSA-SMALL :: Excluded" = rownames(counts)[1:5])
config <- list(designFormula = "~ group", seed = 20261110L, camera = TRUE,
  bootstrapReplicates = 0L, filterMinCount = 10, filterMinFraction = 0.15)

bad <- counts; colnames(bad)[2] <- colnames(bad)[1]
assert_error(pnv_validate_inputs(bad, metadata, config), "duplicate.*sample")
bad <- counts; bad[1, 1] <- -1
assert_error(pnv_validate_inputs(bad, metadata, config), "non-negative")
bad <- counts; bad[1, 1] <- 0.5
assert_error(pnv_validate_inputs(bad, metadata, config), "integer")
assert_error(pnv_validate_inputs(counts * 0, metadata, config), "zero")
assert_error(pnv_validate_inputs(counts[, rep(1, 12)], metadata, config), "duplicate.*sample")
identical_counts <- counts; identical_counts[,] <- counts[, 1]
assert_error(pnv_validate_inputs(identical_counts, metadata, config), "identical")
bad_metadata <- metadata; bad_metadata$batch <- bad_metadata$group
assert_error(pnv_validate_inputs(counts, bad_metadata,
  modifyList(config, list(designFormula = "~ batch + group"))), "rank|confound")
bad_metadata <- metadata; bad_metadata$age <- seq_len(12); bad_metadata$age[1] <- NA
assert_error(pnv_validate_inputs(counts, bad_metadata,
  modifyList(config, list(designFormula = "~ age + group"))), "missing")
assert_error(pnv_validate_inputs(counts[, 1:7], metadata[1:7, ], config), "replicate")
assert_error(pnv_validate_inputs(counts, metadata,
  modifyList(config, list(designFormula = "~ system('echo unsafe') + group"))), "additive")

result <- pnv_analyze_counts(counts, metadata, pathways, config)
stopifnot(nrow(result$geneResults) == 800, nrow(result$pathwayResults) == 2,
  identical(result$settings$lfcMethod, "apeglm"),
  all(c("log2FoldChangeUnshrunk", "log2FoldChange", "stat") %in% names(result$geneResults)),
  all(result$pathwayResults$size >= 15 & result$pathwayResults$size <= 500))

direct_wald <- as.data.frame(DESeq2::results(result$dds,
  contrast = c("group", "B", "A"), alpha = 0.05))
direct_wald <- direct_wald[result$geneResults$gene, ]
stopifnot(isTRUE(all.equal(result$geneResults$stat, direct_wald$stat, tolerance = 1e-8)),
  isTRUE(all.equal(result$geneResults$pvalue, direct_wald$pvalue, tolerance = 1e-8)),
  isTRUE(all.equal(result$geneResults$padj, direct_wald$padj, tolerance = 1e-8)))
stopifnot(all(c("pvalue", "padj", "direction") %in% names(result$cameraResults)))

empty <- pnv_score_pathways(setNames(result$geneResults$stat, result$geneResults$gene),
  list("no-overlap" = paste0("MISSING", 1:20)), config)
stopifnot(nrow(empty) == 0)
constant <- pnv_score_pathways(setNames(rep(0, 800), rownames(counts)), pathways, config)
stopifnot(nrow(constant) == 2, all(is.na(constant$NES)), all(is.na(constant$padj)),
  all(constant$missingReason == "constant_rank"))

paired <- pnv_validate_inputs(counts, metadata,
  modifyList(config, list(designFormula = "~ donor + group")))
stopifnot(ncol(paired$designMatrix) == 7)

# Summaries must use per-pathway valid fits, never silently count failures as negatives.
summary <- pnv_summarize_bootstrap(
  c("P1", "P2"), c(1, -1),
  list(data.frame(pathway = "P1", NES = 2, padj = 0.01),
       data.frame(pathway = c("P1", "P2"), NES = c(-2, -1), padj = c(0.2, 0.01)),
       NULL), 3, 0.05)
stopifnot(summary$P1$valid == 2, summary$P1$selected == 1,
  summary$P1$selectionFrequency == 0.5, summary$P1$directionConsistency == 0.5,
  summary$P2$valid == 1, summary$P2$validFraction == 1/3,
  nzchar(summary$P1$warning))

checkpoint_dir <- tempfile("pnv-bootstrap-checkpoint-")
bootstrap_config <- modifyList(config, list(bootstrapReplicates = 2L, bootstrapCheckpointDir = checkpoint_dir))
bootstrap <- pnv_bootstrap_pathways(counts, metadata, pathways,
  bootstrap_config, result$pathwayResults)
stopifnot(bootstrap$requested == 2, length(bootstrap$failures) <= 2,
  all(vapply(bootstrap$pathways, function(x) x$requested == 2, logical(1))))
checkpoint_files <- list.files(checkpoint_dir, recursive = TRUE, full.names = TRUE)
checkpoint_times <- file.info(checkpoint_files)$mtime
reused <- pnv_bootstrap_pathways(counts, metadata, pathways, bootstrap_config, result$pathwayResults)
stopifnot(identical(reused, bootstrap), identical(file.info(checkpoint_files)$mtime, checkpoint_times))
parallel_bootstrap <- pnv_bootstrap_pathways(counts, metadata, pathways,
  modifyList(bootstrap_config, list(bootstrapWorkers = 2L, bootstrapCheckpointDir = tempfile("pnv-parallel-"))),
  result$pathwayResults)
stopifnot(identical(parallel_bootstrap$pathways, bootstrap$pathways),
  identical(parallel_bootstrap$fingerprint, bootstrap$fingerprint),
  identical(parallel_bootstrap$workerPolicy$requested, 2L))
changed_counts <- counts; changed_counts[1, 1] <- counts[1, 1] + 1
changed <- pnv_bootstrap_pathways(changed_counts, metadata, pathways,
  modifyList(bootstrap_config, list(bootstrapReplicates = 1L)), result$pathwayResults)
stopifnot(changed$fingerprint != bootstrap$fingerprint,
  length(list.files(checkpoint_dir, recursive = TRUE)) == 3)
unlink(checkpoint_dir, recursive = TRUE)

cat("PASS: R analysis core guards, Wald preservation, pathway nulls, CAMERA, paired design and bootstrap denominators\n")
