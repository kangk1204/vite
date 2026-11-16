#!/usr/bin/env Rscript
# Prespecified sensitivity of pathway ranks to genes with Cook-withheld p values.
source("scripts/lib/analysis_core.R")
source("scripts/lib/analysis_io.R")

run_cook_sensitivity <- function(analysis_root, output) {
  prefix <- "gse290452_akap11_hetko_vs_wt_unt"
  directory <- file.path(analysis_root, "gse290452_akap11_model_extension")
  input <- file.path(directory, paste0(prefix, "_reference_input.rds"))
  sidecar <- file.path(directory, paste0(prefix, "_evidence.json"))
  bundle <- readRDS(input)
  genes <- bundle$expected$genes
  if (!all(c("cooksOutlier", "rankingIncluded", "missingReason") %in% names(genes))) {
    stop("This sensitivity requires the revised gene diagnostic contract.")
  }
  primary_ranks <- pnv_ranked_genes(genes)
  excluded <- genes$gene[genes$cooksOutlier & genes$rankingIncluded]
  replay <- pnv_score_pathways(primary_ranks, bundle$pathways, bundle$config)
  expected <- bundle$expected$pathways
  alignment <- match(expected$pathway, replay$pathway)
  stopifnot(!anyNA(alignment), nrow(expected) == nrow(replay),
    isTRUE(all.equal(expected$NES, replay$NES[alignment], tolerance = 1e-8)),
    isTRUE(all.equal(expected$padj, replay$padj[alignment], tolerance = 1e-8)))
  alternative <- pnv_score_pathways(primary_ranks[!names(primary_ranks) %in% excluded], bundle$pathways, bundle$config)
  table_for <- function(table, label) {
    result <- data.frame(pathway = table$pathway, NES = table$NES, padj = table$padj,
      leadingEdge = vapply(table$leadingEdge, paste, collapse = ";", character(1)), size = table$size)
    names(result)[-1] <- paste0(names(result)[-1], "_", label)
    result
  }
  comparison <- merge(table_for(replay, "primary"), table_for(alternative, "exclude_cook"), by = "pathway", all = TRUE)
  comparison$pathway_id <- sub(" :: .*", "", comparison$pathway)
  comparison$pathway_name <- sub("^.*? :: ", "", comparison$pathway)
  comparison$eligible_primary <- !is.na(comparison$size_primary)
  comparison$eligible_exclude_cook <- !is.na(comparison$size_exclude_cook)
  comparison$decision_changed <- ifelse(is.finite(comparison$padj_primary) & is.finite(comparison$padj_exclude_cook),
    (comparison$padj_primary < .05) != (comparison$padj_exclude_cook < .05), NA)
  genes_of <- function(value) if (is.na(value) || !nzchar(value)) character() else strsplit(value, ";", fixed = TRUE)[[1]]
  comparison$cook_genes_in_primary_leading_edge <- vapply(comparison$leadingEdge_primary,
    function(x) paste(intersect(genes_of(x), excluded), collapse = ";"), character(1))
  comparison$leading_edge_jaccard <- mapply(function(a, b) {
    if (is.na(a) || is.na(b)) return(NA_real_)
    x <- genes_of(a); y <- genes_of(b); union_size <- length(union(x, y))
    if (!union_size) return(NA_real_)
    length(intersect(x, y)) / union_size
  }, comparison$leadingEdge_primary, comparison$leadingEdge_exclude_cook)
  dir.create(output, recursive = TRUE, showWarnings = FALSE)
  data.table::fwrite(comparison, file.path(output, "pathway_comparison.tsv"), sep = "\t", na = "")
  data.table::fwrite(genes[genes$cooksOutlier, ], file.path(output, "cook_withheld_genes.tsv"), sep = "\t", na = "")
  tables <- list(primary_replay = replay, exclude_cook = alternative)
  for (name in names(tables)) {
    table <- as.data.frame(tables[[name]])
    table$leadingEdge <- vapply(table$leadingEdge, paste, collapse = ";", character(1))
    data.table::fwrite(table, file.path(output, paste0(name, "_fgsea.tsv")), sep = "\t", na = "")
  }
  summary <- list(rankingPolicy = "finite_original_wald_v1", sensitivity = "Exclude Cook-withheld finite-Wald genes from the preranked list only",
    additionalDESeqFits = 0L, originalRankReplayMatched = TRUE,
    retainedPrimaryGenes = length(primary_ranks), excludedCookGenes = length(excluded),
    primaryEligiblePathways = nrow(replay), sensitivityEligiblePathways = nrow(alternative),
    primarySignificant = sum(replay$padj < .05, na.rm = TRUE), sensitivitySignificant = sum(alternative$padj < .05, na.rm = TRUE),
    commonDecisionChanges = sum(comparison$decision_changed, na.rm = TRUE),
    primaryLeadingEdgesContainingCookGenes = sum(nzchar(comparison$cook_genes_in_primary_leading_edge)),
    sourceRunId = jsonlite::fromJSON(sidecar, simplifyVector = FALSE)$evidence$runId,
    files = lapply(c(input, sidecar, "scripts/statistics/akap11_cook_sensitivity.R",
      "scripts/lib/analysis_core.R", "scripts/lib/analysis_diagnostics.R", "renv.lock"),
      function(p) list(path = p, sha256 = digest::digest(file = p, algo = "sha256"))),
    settings = list(alpha = .05, minSize = 15L, maxSize = 500L, seed = bundle$config$seed,
      rankStatistic = "original Wald", eps = 0, sampleSize = 101L, nPermSimple = 1000L, fgseaWorkers = 1L))
  jsonlite::write_json(summary, file.path(output, "sensitivity_provenance.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
  print(summary[1:12])
  invisible(summary)
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  root <- if (length(args)) args[[1]] else "paper/outputs/publication_2026_11_16"
  destination <- if (length(args) >= 2) args[[2]] else file.path(root, "statistics/akap11-cook-sensitivity")
  run_cook_sensitivity(root, destination)
}
