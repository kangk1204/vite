#!/usr/bin/env Rscript
# Restore the measured package lock without silently updating a release.
options(repos = c(CRAN = "https://cloud.r-project.org"))
args <- commandArgs(trailingOnly = TRUE)
lockfile <- if (length(args)) args[[1]] else "renv.lock"
if (!file.exists(lockfile)) stop("Missing environment lock: ", lockfile)
dir.create(".cache/R/library", recursive = TRUE, showWarnings = FALSE)
.libPaths(c(normalizePath(".cache/R/library"), .libPaths()))
if (!requireNamespace("renv", quietly = TRUE)) {
  install.packages("renv", lib = .libPaths()[[1]])
}
renv::restore(lockfile = lockfile, library = .libPaths()[[1]], prompt = FALSE)

# data.table uses these optional packages to read the archived GEO gzip inputs.
# Preserve the original statistical lock and install the observed I/O versions.
readers <- list(
  c("R.methodsS3", "1.8.2", "822d5e61dad4c91e8883be2b38d7b89f87492046d0fe345704eb5d2658927c2e"),
  c("R.oo", "1.27.1", "5faf599cc1f027d8b80e1270aa6a43e29dccd6fee8287953f13e7ab3d94270f5"),
  c("R.utils", "2.13.0", "ab2043c34e129928ff85a037ce7a3f7791f245f49a55ee9a95bd7df0813bcf25")
)
restore_reader <- function(spec) {
  pkg <- spec[[1]]
  version <- spec[[2]]
  current <- tryCatch(as.character(utils::packageVersion(pkg)), error = function(e) "")
  if (identical(current, version)) return(invisible(NULL))
  filename <- paste0(pkg, "_", version, ".tar.gz")
  archive <- tempfile(fileext = ".tar.gz")
  on.exit(unlink(archive), add = TRUE)
  roots <- c("https://cloud.r-project.org/src/contrib/", paste0("https://cloud.r-project.org/src/contrib/Archive/", pkg, "/"))
  for (root in roots) {
    status <- tryCatch(utils::download.file(paste0(root, filename), archive, mode = "wb", quiet = TRUE), error = function(e) 1L)
    if (identical(status, 0L)) break
  }
  if (!identical(status, 0L) || !identical(digest::digest(file = archive, algo = "sha256"), spec[[3]])) {
    stop("Unable to verify the pinned source archive for ", pkg, " ", version)
  }
  utils::install.packages(archive, repos = NULL, type = "source", lib = .libPaths()[[1]])
  stopifnot(identical(as.character(utils::packageVersion(pkg, lib.loc = .libPaths()[[1]])), version))
}
invisible(lapply(readers, restore_reader))
verify_compressed_input <- function() {
  probe <- tempfile(fileext = ".tsv.gz")
  on.exit(unlink(probe), add = TRUE)
  connection <- gzfile(probe, "wt")
  tryCatch(writeLines(c("gene\tcount", "TP53\t73"), connection), finally = close(connection))
  result <- data.table::fread(probe)
  stopifnot(identical(result$gene, "TP53"), identical(result$count, 73L))
}
verify_compressed_input()
message("Restored the analysis environment and verified compressed GEO input reading.")
