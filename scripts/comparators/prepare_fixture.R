#!/usr/bin/env Rscript
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 2) stop("Usage: prepare_fixture.R output.rds smoke|airway")
kind <- args[2]
set.seed(20261110)
if (kind == "smoke") {
  counts <- matrix(rnbinom(2000 * 12, mu = 100, size = 5), nrow = 2000)
  rownames(counts) <- paste0("GENE", seq_len(nrow(counts))); colnames(counts) <- paste0("S", 1:12)
  counts[1:100, 7:12] <- counts[1:100, 7:12] * 4L
  metadata <- data.frame(sample = colnames(counts), group = rep(c("A", "B"), each = 6))
  pathways <- list(SYNTHETIC_UP = rownames(counts)[1:100], SYNTHETIC_BACKGROUND = rownames(counts)[101:200], SYNTHETIC_MIXED = rownames(counts)[seq(1, 1000, by = 5)])
  design <- ~ group; data_origin <- "synthetic-software-smoke"
} else if (kind == "airway") {
  if (!requireNamespace("airway", quietly = TRUE)) stop("Install the locked airway package.")
  env <- new.env(); data("airway", package = "airway", envir = env)
  counts <- SummarizedExperiment::assay(env$airway)
  meta <- as.data.frame(SummarizedExperiment::colData(env$airway))
  metadata <- data.frame(sample = colnames(counts), donor = meta$cell, group = ifelse(meta$dex == "untrt", "A", "B"))
  # Ensembl-keyed curated sets must be supplied; invented sets are not biological validation.
  if (length(args) < 3) stop("airway mode requires a frozen Ensembl-keyed pathway RDS as argument 3.")
  pathways <- readRDS(args[3]); design <- ~ donor + group; data_origin <- "public-airway-GSE52778"
} else stop("Unknown fixture kind.")
fixture <- list(id = paste0("pnv-", kind), dataOrigin = data_origin, counts = counts, metadata = metadata,
  pathways = pathways, design = design, contrast = c("group", "B", "A"))
dir.create(dirname(args[1]), recursive = TRUE, showWarnings = FALSE)
saveRDS(fixture, args[1]); cat("Wrote", args[1], "origin", data_origin, "\n")
