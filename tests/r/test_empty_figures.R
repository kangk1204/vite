#!/usr/bin/env Rscript
source("scripts/analyze_neural_bulk_cohort.R")

test_empty_figures <- function() {
  original <- getwd()
  directory <- tempfile("pnv-empty-figures-")
  dir.create(file.path(directory, "figures"), recursive = TRUE)
  on.exit({ setwd(original); unlink(directory, recursive = TRUE) }, add = TRUE)
  setwd(directory)
  config <- list(conditionA = "Control", conditionB = "Treatment")
  for (stem in c("empty_volcano", "empty_pathway")) {
    for (extension in c("pdf", "png")) writeLines("stale previous result", paste0("figures/", stem, ".", extension))
  }
  make_volcano_plot(data.table::data.table(gene = character(), log2FoldChange = numeric(), padj = numeric()),
    "empty_volcano", "No testable differential expression", config)
  make_pathway_dotplot(data.table::data.table(pathway_name = character(), NES = numeric(), padj = numeric()),
    "empty_pathway", "No eligible pathways", config)
  for (stem in c("empty_volcano", "empty_pathway")) {
    pdf <- paste0("figures/", stem, ".pdf")
    png <- paste0("figures/", stem, ".png")
    stopifnot(file.info(pdf)$size > 100, file.info(png)$size > 100,
      identical(rawToChar(readBin(pdf, "raw", n = 4)), "%PDF"),
      identical(readBin(png, "raw", n = 8), as.raw(c(137, 80, 78, 71, 13, 10, 26, 10))))
  }
}

test_empty_figures()
cat("PASS: empty analysis figures replace stale PDFs/PNGs with explicit empty-state artifacts\n")
