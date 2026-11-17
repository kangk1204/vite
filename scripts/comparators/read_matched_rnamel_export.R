args <- commandArgs(TRUE)
if (length(args) != 3L) stop("Usage: read_matched_rnamel_export.R project.rnaflow.rds pathway-id output.json")
.libPaths(c(".cache/comparators/R", .libPaths()))
project <- RNAmel::load_project(args[[1]])
enrichment <- project$enrichment
rows <- enrichment$results
selected <- rows[grepl(args[[2]], rows$pathway, fixed = TRUE), , drop = FALSE]
stopifnot(nrow(selected) == 1L)
result <- list(
  packageVersion = as.character(utils::packageVersion("RNAmel")),
  analysis = enrichment$supplied_analysis,
  rankedGenes = enrichment$supplied_ranked_genes,
  membership = enrichment$supplied_tested_membership[[args[[2]]]],
  pathway = as.list(selected[1, , drop = FALSE]),
  caseContext = enrichment$supplied_case_context,
  contrastParams = project$contrasts[["B_vs_A"]]$params,
  metadata = project$metadata[, intersect(c("sample", "group", "condition"), names(project$metadata)), drop = FALSE]
)
jsonlite::write_json(result, args[[3]], auto_unbox = TRUE, pretty = TRUE, digits = 16, na = "null", null = "null")
