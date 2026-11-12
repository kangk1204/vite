#!/usr/bin/env Rscript
source("scripts/analyze_neural_bulk_cohort.R")
samples <- data.table::data.table(sample = c("GSM1", "GSM2", "GSM3", "GSM4"),
  title_clean = c("GSM2", "A", "T3", "T4"), group = c("A", "B", "A", "B"))
counts <- matrix(10, nrow = 2, ncol = 4,
  dimnames = list(c("TP53", "MYC"), c("GSM2", "A", "GSM3", "GSM4")))
for (order in list(1:4, c(2, 1, 4, 3))) {
  observed <- tryCatch(align_sample_metadata_to_counts(samples[order], counts, list()), error = identity)
  stopifnot(inherits(observed, "error"))
}
normalized_counts <- counts
colnames(normalized_counts)[1] <- "gsm2"
for (order in list(1:4, c(2, 1, 4, 3))) {
  observed <- tryCatch(align_sample_metadata_to_counts(samples[order], normalized_counts,
    list(sampleAlignmentFields = c("title_clean", "sample"))), error = identity)
  stopifnot(inherits(observed, "error"))
}
safe <- data.table::copy(samples)
safe$title_clean[1] <- "A"
matched <- align_sample_metadata_to_counts(safe, counts, list())
stopifnot(identical(matched$count_ids, c("A", "GSM2", "GSM3", "GSM4")))
permuted <- align_sample_metadata_to_counts(safe[c(2, 1, 4, 3)], counts, list())
stopifnot(identical(permuted$count_ids, c("GSM2", "A", "GSM4", "GSM3")))
cat("PASS: global exact-ID reservation prevents cross-group title collisions independently of metadata order\n")
