#!/usr/bin/env Rscript
# Comparator packages live in an isolated library with recorded upstream revisions.
library <- normalizePath(".cache/comparators/R", mustWork = FALSE)
dir.create(library, recursive = TRUE, showWarnings = FALSE)
.libPaths(unique(c(library, .libPaths())))
if (!requireNamespace("BiocManager", quietly = TRUE) || !requireNamespace("jsonlite", quietly = TRUE)) {
  stop("Restore the primary analysis dependencies before installing comparators.")
}
options(repos = BiocManager::repositories(version = "3.22"))
if (!requireNamespace("remotes", quietly = TRUE)) install.packages("remotes", lib = library)
packages <- list(
  GeneTonic = list(version = "3.4.0", repository = "https://git.bioconductor.org/packages/GeneTonic",
    commit = "21785a12d4ffe30af533d0db15b270d80d42be29"),
  RNAmel = list(version = "0.18.1", repository = "https://github.com/KmBioChemo/RNAmel",
    commit = "efdd8e3849b2afbf24c933bd5049d55ee4896cbc"))
records <- lapply(names(packages), function(package) {
  pin <- packages[[package]]
  available <- find.package(package, lib.loc = library, quiet = TRUE)
  previous <- if (length(available)) utils::packageDescription(package, lib.loc = library) else NULL
  previous_commit <- if (package == "GeneTonic") previous$git_last_commit else previous$RemoteSha
  reusable <- !is.null(previous) && identical(previous$Version, pin$version) &&
    length(previous_commit) == 1L && startsWith(pin$commit, previous_commit)
  if (!reusable) {
    remotes::install_git(pin$repository, ref = pin$commit, lib = library,
      dependencies = NA, upgrade = "never", build_vignettes = FALSE)
  }
  installed <- utils::packageDescription(package, lib.loc = library)
  if (!identical(installed$Version, pin$version)) stop("Comparator version differs from its pin: ", package)
  list(package = package, version = installed$Version, repository = pin$repository, commit = pin$commit,
    action = if (reusable) "reused-recorded-installed-version" else "installed-pinned-source")
})
jsonlite::write_json(list(schemaVersion = 1L, packages = records, library = library,
  sessionInfo = capture.output(sessionInfo())), ".cache/comparators/install-receipt.json", auto_unbox = TRUE, pretty = TRUE)
writeLines(capture.output(sessionInfo()), ".cache/comparators/session-info.txt")
print(records)
