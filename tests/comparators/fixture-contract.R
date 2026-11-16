#!/usr/bin/env Rscript
source("scripts/comparators/prepare_fixture.R")
metadata <- data.frame(sample = c("A1", "A2", "B1", "B2"), group = c("A", "A", "B", "B"))
counts <- matrix(seq_len(80), nrow = 20, dimnames = list(paste0("G", 1:20), metadata$sample))
fixture <- list(schemaVersion = 2L, id = "test", dataOrigin = "synthetic-test",
  counts = counts, metadata = metadata, pathways = list(test = rownames(counts)),
  design = ~ group, contrast = c("group", "B", "A"), identifierType = "symbol",
  config = list(seed = 20261110L, designFormula = "~ group", camera = FALSE, bootstrapReplicates = 0L),
  matched = NULL)
stopifnot(inherits(try(validate_comparator_fixture(fixture, require_matched = TRUE), silent = TRUE), "try-error"))
stopifnot(isTRUE(validate_comparator_fixture(fixture, require_matched = FALSE)))
fixture$pathways <- list(test = paste0("ENSG", 1:20))
stopifnot(inherits(try(validate_comparator_fixture(fixture, require_matched = FALSE), silent = TRUE), "try-error"))
fixture$pathways <- list(test = rownames(counts)); fixture$metadata$sample[2] <- "A1"
stopifnot(inherits(try(validate_comparator_fixture(fixture, require_matched = FALSE), silent = TRUE), "try-error"))
cat("Comparator fixture validation passed\n")
