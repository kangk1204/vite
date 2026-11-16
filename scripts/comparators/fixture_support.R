# Public comparator fixture and serialization helpers.
comparator_libraries <- function() {
  library <- normalizePath(".cache/comparators/R", mustWork = FALSE)
  .libPaths(unique(c(library, .libPaths())))
}

comparator_hash <- function(file) digest::digest(file = file, algo = "sha256")
comparator_versions <- function(packages) {
  as.list(stats::setNames(vapply(packages, function(package) as.character(utils::packageVersion(package)), character(1)), packages))
}

validate_comparator_fixture <- function(fixture, require_matched = TRUE) {
  required <- c("schemaVersion", "id", "dataOrigin", "counts", "metadata", "pathways", "design", "contrast", "identifierType", "config")
  if (!all(required %in% names(fixture)) || fixture$schemaVersion != 2L) stop("A version-2 comparator fixture is required.")
  counts <- fixture$counts
  if (!is.matrix(counts) || any(!is.finite(counts)) || any(counts < 0) || any(counts != round(counts)) ||
      is.null(rownames(counts)) || anyDuplicated(rownames(counts)) || anyDuplicated(colnames(counts))) stop("Invalid count matrix or duplicate identifiers.")
  metadata <- fixture$metadata
  if (!all(c("sample", "group") %in% names(metadata)) || anyDuplicated(metadata$sample) ||
      !setequal(metadata$sample, colnames(counts)) || any(!metadata$group %in% c("A", "B")) ||
      any(table(factor(metadata$group, levels = c("A", "B"))) < 2)) stop("Metadata must identify every biological sample and both groups.")
  pathways <- fixture$pathways
  if (!is.list(pathways) || !length(pathways) || is.null(names(pathways)) || anyDuplicated(names(pathways))) stop("Pathways require unique identifiers.")
  overlap <- lengths(lapply(pathways, intersect, rownames(counts)))
  if (!any(overlap >= 15 & overlap <= 500)) stop("No eligible pathway overlaps the declared count identifier convention.")
  if (require_matched) {
    matched <- fixture$matched
    if (is.null(matched) || !all(c("dds", "res", "enrichment", "geneResults", "settings") %in% names(matched))) stop("Matched results are required. Regenerate the fixture with prepare_fixture.R.")
    if (!methods::is(matched$dds, "DESeqDataSet") || !methods::is(matched$res, "DESeqResults") ||
        !identical(rownames(matched$res), rownames(matched$dds))) stop("Matched DESeq2 object identities differ.")
    if (!all(c("pathway", "NES", "padj", "leadingEdge") %in% names(matched$enrichment))) stop("Matched fgsea results are incomplete.")
  }
  invisible(TRUE)
}

read_symbol_pathways <- function(file) {
  if (!file.exists(file)) stop("Frozen Reactome GMT is missing: ", file)
  if (grepl("\\.zip$", file)) {
    names <- utils::unzip(file, list = TRUE)$Name
    selected <- names[grepl("\\.gmt$", names)]
    if (length(selected) != 1L) stop("The reference archive must contain one GMT.")
    connection <- unz(file, selected)
  } else connection <- file(file, "r")
  on.exit(close(connection))
  records <- strsplit(readLines(connection, warn = FALSE), "\t", fixed = TRUE)
  records <- records[lengths(records) >= 3]
  pathways <- lapply(records, function(row) unique(row[-c(1, 2)][nzchar(row[-c(1, 2)])]))
  names(pathways) <- vapply(records, function(row) paste(row[[2]], row[[1]], sep = " :: "), character(1))
  if (anyDuplicated(names(pathways))) stop("Reference pathway identifiers are not unique.")
  pathways
}

fit_matched_fixture <- function(fixture) {
  validate_comparator_fixture(fixture, require_matched = FALSE)
  config <- fixture$config
  metadata <- as.data.frame(fixture$metadata, row.names = fixture$metadata$sample)
  for (name in all.vars(fixture$design)) if (is.character(metadata[[name]])) metadata[[name]] <- factor(metadata[[name]])
  metadata$group <- factor(metadata$group, levels = c("A", "B"))
  counts <- fixture$counts[, rownames(metadata), drop = FALSE]
  keep <- rowSums(counts >= config$filterMinCount) >= ceiling(config$filterMinFraction * ncol(counts))
  if (!any(keep)) stop("The matched expression filter retained no genes.")
  design <- model.matrix(fixture$design, metadata)
  if (qr(design)$rank != ncol(design) || nrow(design) <= ncol(design)) stop("The matched model is not estimable.")
  set.seed(config$seed)
  dds <- DESeq2::DESeqDataSetFromMatrix(countData = counts[keep, , drop = FALSE], colData = metadata, design = fixture$design)
  dds <- DESeq2::DESeq(dds, quiet = TRUE, parallel = FALSE)
  original <- DESeq2::results(dds, contrast = fixture$contrast, alpha = config$alpha)
  coefficient <- which(DESeq2::resultsNames(dds) == "group_B_vs_A")
  if (length(coefficient) != 1L) stop("Missing B versus A coefficient.")
  shrunk <- DESeq2::lfcShrink(dds, coef = coefficient, res = original, type = "apeglm", quiet = TRUE)
  display <- original
  display$log2FoldChange <- shrunk$log2FoldChange
  display$lfcSE <- shrunk$lfcSE
  genes <- data.frame(gene = rownames(original), as.data.frame(display), row.names = NULL)
  genes$log2FoldChangeUnshrunk <- original$log2FoldChange
  genes$lfcSEUnshrunk <- original$lfcSE
  ranks <- setNames(original$stat, rownames(original))
  ranks <- ranks[is.finite(ranks)]
  ranks <- ranks[order(-ranks, names(ranks))]
  overlap <- lapply(fixture$pathways, function(members) intersect(unique(members), names(ranks)))
  overlap <- overlap[lengths(overlap) >= 15 & lengths(overlap) <= 500]
  set.seed(config$seed)
  enrichment <- as.data.frame(fgsea::fgseaMultilevel(pathways = overlap, stats = ranks,
    minSize = 15, maxSize = 500, eps = 0, sampleSize = 101, nPermSimple = 1000, nproc = 1,
    BPPARAM = BiocParallel::SerialParam(progressbar = FALSE)))
  enrichment$padj <- stats::p.adjust(enrichment$pval, method = "BH")
  enrichment <- enrichment[order(enrichment$padj, enrichment$pathway, na.last = TRUE), , drop = FALSE]
  settings <- list(filterMinCount = config$filterMinCount, filterMinFraction = config$filterMinFraction,
    alpha = config$alpha, contrast = fixture$contrast, designFormula = deparse(fixture$design),
    effect = "apeglm", inference = "original unshrunk DESeq2 Wald test", ranking = "all finite original Wald statistics including finite rows whose p-values are unavailable",
    rankingMissingPvalueGenes = genes$gene[is.finite(genes$stat) & is.na(genes$pvalue)],
    minSize = 15L, maxSize = 500L, eps = 0, sampleSize = 101L, nPermSimple = 1000L, nproc = 1L, seed = config$seed)
  list(dds = dds, res = display, enrichment = enrichment, geneResults = genes, rankedGenes = ranks, settings = settings)
}

write_comparator_table <- function(value, file) {
  table <- as.data.frame(value)
  for (name in names(table)) if (is.list(table[[name]])) table[[name]] <- vapply(table[[name]], paste, collapse = ";", character(1))
  data.table::fwrite(table, file, sep = "\t", na = "NA", quote = FALSE)
}
