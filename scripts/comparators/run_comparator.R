#!/usr/bin/env Rscript
# Uses public APIs, with isolated library paths. Inputs are trusted local RDS fixtures.
args <- commandArgs(trailingOnly = TRUE)
if (length(args) < 4) stop("Usage: run_comparator.R GeneTonic|RNAmel fixture.rds output-dir matched|defaults")
tool <- args[1]; mode <- args[4]
if (!tool %in% c("GeneTonic", "RNAmel") || !mode %in% c("matched", "defaults")) stop("Unknown comparator or comparison mode.")
lib <- normalizePath(".cache/comparators/R", mustWork = FALSE)
.libPaths(unique(c(lib, .libPaths())))
if (!requireNamespace(tool, quietly = TRUE)) stop(sprintf("Comparator prerequisite missing: %s. Use scripts/comparators/install.R in the isolated library.", tool))
fixture <- readRDS(args[2])
required <- c("counts", "metadata", "pathways", "design", "contrast", "id")
if (!all(required %in% names(fixture))) stop("Fixture missing counts/metadata/pathways/design/contrast/id.")
if (!is.matrix(fixture$counts) || anyDuplicated(colnames(fixture$counts))) stop("Invalid count fixture.")
output <- normalizePath(args[3], mustWork = FALSE)
dir.create(output, recursive = TRUE, showWarnings = FALSE)
set.seed(20261110)
start <- proc.time()[[3]]
metadata <- fixture$metadata
rownames(metadata) <- metadata$sample
metadata$group <- factor(metadata$group, levels = c("A", "B"))
counts <- fixture$counts[, metadata$sample, drop = FALSE]
common <- function() {
  dds <- DESeq2::DESeqDataSetFromMatrix(countData = counts, colData = metadata, design = fixture$design)
  keep <- rowSums(DESeq2::counts(dds) >= 10) >= ceiling(0.15 * ncol(dds))
  dds <- DESeq2::DESeq(dds[keep, ], quiet = TRUE)
  res <- DESeq2::results(dds, contrast = fixture$contrast, alpha = 0.05)
  ranks <- res$stat; names(ranks) <- rownames(res)
  ranks <- sort(ranks[is.finite(ranks)], decreasing = TRUE)
  set.seed(20261110)
  enrichment <- fgsea::fgseaMultilevel(pathways = fixture$pathways, stats = ranks, minSize = 15, maxSize = 500, nproc = 1)
  list(dds = dds, res = res, enrichment = enrichment)
}
report <- file.path(output, sprintf("%s.%s.html", tolower(tool), mode))
notes <- character()
if (tool == "GeneTonic") {
  if (!rmarkdown::pandoc_available()) stop("GeneTonic requires pandoc for native HTML report generation.")
  modern_citeproc <- rmarkdown::pandoc_version() >= package_version("2.11") && !nzchar(Sys.which("pandoc-citeproc"))
  result <- if (mode == "matched" && !is.null(fixture$matched)) fixture$matched else common()
  annotation <- data.frame(gene_id = rownames(result$dds), gene_name = rownames(result$dds))
  enrich <- GeneTonic::shake_fgseaResult(as.data.frame(result$enrichment))
  enrich <- GeneTonic::get_aggrscores(enrich, result$res, annotation)
  GeneTonic::happy_hour(dds = result$dds, res_de = result$res, res_enrich = enrich,
    annotation_obj = annotation, project_id = fixture$id, mygenesets = head(enrich$gs_id, 5),
    mygenes = head(rownames(result$res)[order(result$res$padj)], 5), mygroup = "group",
    output_file = basename(report), output_dir = output, open_after_creating = FALSE, force_overwrite = TRUE,
    ignore_pandoc = modern_citeproc)
  if (modern_citeproc) notes <- c(notes, "GeneTonic legacy pandoc-citeproc preflight bypassed with its documented flag because installed pandoc >=2.11 has built-in citeproc; actual report rendering still required.")
  notes <- c(notes, "GeneTonic consumes externally supplied DE/enrichment objects; defaults mode uses its native report defaults, not a separate DE engine.")
  write.table(as.data.frame(result$res), file.path(output, "gene_statistics.tsv"), sep = "\t", quote = FALSE)
} else {
  if (mode == "matched") {
    result <- if (!is.null(fixture$matched)) fixture$matched else common()
    de <- as.data.frame(result$res); de$gene <- rownames(de)
    enrichment <- as.data.frame(result$enrichment)
    notes <- c(notes, "Matched mode injects common results through the public project API; it compares delivery, not RNAmel inference.")
  } else {
    de <- RNAmel::run_deseq2(counts, metadata, design = fixture$design, contrast = fixture$contrast)
    enrichment <- RNAmel::run_gsea(de, fixture$pathways, rank_by = "stat", min_size = 15, max_size = 500)
    notes <- c(notes, "Native defaults retain the comparator's filtering/shrinkage/GSEA behavior; numerical identity is not assumed.")
  }
  store <- RNAmel::contrast_store_upsert(list(), "B_vs_A", de,
    params = list(design_var = "group", design_formula = deparse(fixture$design), contrast = fixture$contrast))
  project <- RNAmel::assemble_project(fixture$id, organism = "human", counts = counts,
    metadata = metadata, contrasts = store, settings = list(enrichment = list(results = enrichment)))
  RNAmel::build_report_html(project, report, title = paste("Comparator", fixture$id))
  saveRDS(project, file.path(output, "project.rds"))
  write.table(de, file.path(output, "gene_statistics.tsv"), sep = "\t", quote = FALSE, row.names = FALSE)
  enrichment$leadingEdge <- NULL
  write.table(enrichment, file.path(output, "pathway_statistics.tsv"), sep = "\t", quote = FALSE, row.names = FALSE)
}
metrics <- list(schemaVersion = 1, tool = tool, version = as.character(utils::packageVersion(tool)),
  sourceCommit = utils::packageDescription(tool)$RemoteSha,
  mode = mode, fixture = fixture$id, dataOrigin = fixture$dataOrigin,
  completed = file.exists(report), elapsedSeconds = proc.time()[[3]] - start,
  reportBytes = if (file.exists(report)) file.info(report)$size else NA_real_,
  reportPath = report, peakMemoryBytes = NULL, manualSteps = NULL, offlineBrowserVerified = FALSE,
  notes = c(notes, "A single execution documents feasibility; its timing is not evidence of comparative speed superiority."), sessionInfo = capture.output(sessionInfo()))
jsonlite::write_json(metrics, file.path(output, "metrics.json"), pretty = TRUE, auto_unbox = TRUE, na = "null", null = "null", digits = NA)
cat("Comparator completed:", report, "\n")
