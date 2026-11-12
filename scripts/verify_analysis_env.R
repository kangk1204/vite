#!/usr/bin/env Rscript
# Check the environment actually loaded, rather than trusting a lockfile alone.
if (!requireNamespace("jsonlite", quietly = TRUE)) stop("Restore the R environment before verification.")
args <- commandArgs(trailingOnly = TRUE)
lock <- jsonlite::fromJSON("renv.lock", simplifyVector = FALSE)
target_library <- if (length(args)) normalizePath(args[[1]], mustWork = TRUE) else NULL
packages <- lock$Packages
versions <- lapply(names(packages), function(name) {
  actual <- tryCatch(as.character(utils::packageVersion(name, lib.loc = target_library)),
    error = function(e) NA_character_)
  list(package = name, expected = packages[[name]]$Version, actual = actual,
    matches = !is.na(actual) && utils::compareVersion(actual, packages[[name]]$Version) == 0L)
})
result <- list(R = list(expected = lock$R$Version, actual = as.character(getRversion())),
  packages = versions, allPackagesMatch = all(vapply(versions, `[[`, logical(1), "matches")))
cat(jsonlite::toJSON(result, auto_unbox = TRUE, pretty = TRUE, na = "null"), "\n")
if (!result$allPackagesMatch) stop("Installed package versions differ from renv.lock; restore before producing release evidence.")
if (!identical(result$R$expected, result$R$actual)) stop("R interpreter version differs from the measured lock.")
