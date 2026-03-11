#!/usr/bin/env Rscript

cran_packages <- c(
  "data.table",
  "ggplot2",
  "ggrepel",
  "jsonlite",
  "patchwork",
  "pheatmap",
  "writexl"
)
bioc_packages <- c("DESeq2", "fgsea")

install_if_missing <- function(packages, installer) {
  missing <- packages[!vapply(packages, requireNamespace, quietly = TRUE, FUN.VALUE = logical(1))]
  if (length(missing)) {
    installer(missing)
  }
}

install_if_missing(cran_packages, function(packages) {
  install.packages(packages, repos = "https://cloud.r-project.org")
})

if (!requireNamespace("BiocManager", quietly = TRUE)) {
  install.packages("BiocManager", repos = "https://cloud.r-project.org")
}

install_if_missing(bioc_packages, function(packages) {
  BiocManager::install(packages, ask = FALSE, update = FALSE)
})

cat("R dependencies are installed.\n")
