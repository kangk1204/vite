#!/usr/bin/env Rscript
# Separate comparator library: never update the primary analysis environment.
lib <- normalizePath(".cache/comparators/R", mustWork = FALSE)
dir.create(lib, recursive = TRUE, showWarnings = FALSE)
.libPaths(unique(c(lib, .libPaths())))
options(repos = c(CRAN = "https://cloud.r-project.org"))
if (!requireNamespace("BiocManager", quietly = TRUE)) stop("Install BiocManager in the analysis environment first.")
BiocManager::install("GeneTonic", lib = lib, ask = FALSE, update = FALSE)
if (!requireNamespace("remotes", quietly = TRUE)) install.packages("remotes", lib = lib)
remotes::install_github("KmBioChemo/RNAmel@efdd8e3849b2afbf24c933bd5049d55ee4896cbc", lib = lib,
  dependencies = NA, upgrade = "never", build_vignettes = FALSE)
writeLines(capture.output(sessionInfo()), ".cache/comparators/session-info.txt")
