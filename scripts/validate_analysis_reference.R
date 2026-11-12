#!/usr/bin/env Rscript
# Independent package calls: deliberately does not source any PNV analysis module.
reference_analysis <- function(bundle) {
  counts <- bundle$counts
  metadata <- as.data.frame(bundle$metadata)
  cfg <- bundle$config
  metadata <- metadata[match(colnames(counts), metadata$sample), , drop = FALSE]
  rownames(metadata) <- metadata$sample
  metadata$group <- factor(metadata$group, levels = c("A", "B"))
  formula <- as.formula(cfg$designFormula)
  for (variable in all.vars(formula)) if (is.character(metadata[[variable]])) metadata[[variable]] <- factor(metadata[[variable]])
  minimum <- if (is.null(cfg$filterMinCount)) 10 else cfg$filterMinCount
  fraction <- if (is.null(cfg$filterMinFraction)) 0.15 else cfg$filterMinFraction
  seed <- if (is.null(cfg$seed)) 20261110L else as.integer(cfg$seed)
  keep <- rowSums(counts >= minimum) >= ceiling(fraction * ncol(counts))
  RNGkind("Mersenne-Twister", "Inversion", "Rejection")
  set.seed(seed)
  dds <- DESeq2::DESeqDataSetFromMatrix(round(counts[keep, , drop = FALSE]), metadata, formula)
  dds <- DESeq2::DESeq(dds, quiet = TRUE, parallel = FALSE)
  wald <- DESeq2::results(dds, contrast = c("group", "B", "A"), alpha = 0.05)
  effect <- DESeq2::lfcShrink(dds, coef = which(DESeq2::resultsNames(dds) == "group_B_vs_A"),
    res = wald, type = "apeglm", quiet = TRUE)
  genes <- data.frame(gene = rownames(wald), stat = wald$stat, pvalue = wald$pvalue,
    padj = wald$padj, log2FoldChangeUnshrunk = wald$log2FoldChange,
    log2FoldChange = effect$log2FoldChange, lfcSE = effect$lfcSE)
  ranks <- setNames(genes$stat, genes$gene)
  ranks <- ranks[is.finite(ranks)]
  ranks <- ranks[order(-ranks, names(ranks))]
  pathways <- lapply(bundle$pathways, function(set) intersect(unique(set), names(ranks)))
  pathways <- pathways[lengths(pathways) >= 15 & lengths(pathways) <= 500]
  set.seed(seed)
  if (length(pathways) && length(unique(ranks)) >= 2) {
    enrichment <- as.data.frame(fgsea::fgseaMultilevel(pathways, ranks,
      minSize = 15, maxSize = 500, eps = 0, nPermSimple = 1000, sampleSize = 101, nproc = 1,
      BPPARAM = BiocParallel::SerialParam(progressbar = FALSE)))
    enrichment$padj <- p.adjust(enrichment$pval, "BH")
  } else if (length(pathways)) {
    enrichment <- data.frame(pathway = names(pathways), pval = NA_real_, padj = NA_real_,
      ES = NA_real_, NES = NA_real_, size = lengths(pathways))
    enrichment$leadingEdge <- lapply(pathways, function(x) character())
  } else {
    enrichment <- data.frame(pathway = character(), pval = numeric(), padj = numeric(), ES = numeric(), NES = numeric(), size = integer())
    enrichment$leadingEdge <- list()
  }
  camera <- data.frame(pathway = character(), pvalue = numeric(), padj = numeric(), direction = character())
  if (is.null(cfg$camera) || isTRUE(cfg$camera)) {
    filtered_counts <- counts[keep, , drop = FALSE]
    sets <- lapply(bundle$pathways, function(set) match(intersect(unique(set), rownames(filtered_counts)), rownames(filtered_counts)))
    sets <- sets[lengths(sets) >= 15 & lengths(sets) <= 500]
    if (length(sets)) {
      design <- model.matrix(formula, metadata)
      dge <- edgeR::calcNormFactors(edgeR::DGEList(filtered_counts), method = "TMM")
      voom <- limma::voom(dge, design, plot = FALSE)
      tested <- limma::camera(voom, sets, design, contrast = which(colnames(design) == "groupB"),
        inter.gene.cor = NA, sort = FALSE)
      camera <- data.frame(pathway = rownames(tested), pvalue = tested$PValue,
        padj = p.adjust(tested$PValue, "BH"), direction = tested$Direction)
    }
  }
  list(genes = genes, pathways = enrichment, camera = camera)
}

reference_numeric_equal <- function(actual, expected, tolerance = 1e-8) {
  if (length(actual) != length(expected) || !identical(is.na(actual), is.na(expected))) return(FALSE)
  keep <- !is.na(expected)
  if (!identical(is.finite(actual[keep]), is.finite(expected[keep]))) return(FALSE)
  all(abs(actual[keep] - expected[keep]) <= tolerance + tolerance * abs(expected[keep]))
}

validate_reference_bundle <- function(bundle, tolerance = 1e-8) {
  direct <- reference_analysis(bundle)
  expected <- bundle$expected
  checks <- list()
  add <- function(id, pass) checks[[length(checks) + 1L]] <<- list(id = id, pass = isTRUE(pass))
  add("gene-identifiers", identical(direct$genes$gene, expected$genes$gene))
  for (column in c("stat", "pvalue", "padj", "log2FoldChangeUnshrunk", "log2FoldChange", "lfcSE")) {
    add(paste0("genes-", column), reference_numeric_equal(direct$genes[[column]], expected$genes[[column]], tolerance))
  }
  add("pathway-identifiers", setequal(direct$pathways$pathway, expected$pathways$pathway))
  expected_pathways <- expected$pathways[match(direct$pathways$pathway, expected$pathways$pathway), , drop = FALSE]
  for (column in c("ES", "NES", "pval", "padj", "size")) {
    add(paste0("pathways-", column), reference_numeric_equal(direct$pathways[[column]], expected_pathways[[column]], tolerance))
  }
  add("leading-edge-sets", length(direct$pathways$leadingEdge) == length(expected_pathways$leadingEdge) &&
    all(vapply(seq_along(direct$pathways$leadingEdge), function(i) {
      setequal(direct$pathways$leadingEdge[[i]], expected_pathways$leadingEdge[[i]])
    }, logical(1))))
  add("camera-identifiers", setequal(direct$camera$pathway, expected$camera$pathway))
  expected_camera <- expected$camera[match(direct$camera$pathway, expected$camera$pathway), , drop = FALSE]
  add("camera-pvalue", reference_numeric_equal(direct$camera$pvalue, expected_camera$pvalue, tolerance))
  add("camera-padj", reference_numeric_equal(direct$camera$padj, expected_camera$padj, tolerance))
  add("camera-direction", identical(direct$camera$direction, expected_camera$direction))
  list(status = if (all(vapply(checks, function(x) x$pass, logical(1)))) "pass" else "fail",
    purpose = "Same-environment standard-package integration parity; not independent validation of the statistical methods.",
    absoluteTolerance = tolerance, relativeTolerance = tolerance, checks = checks,
    sessionInfo = capture.output(sessionInfo()))
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  if (!length(args) || length(args) > 2L) stop("Usage: Rscript scripts/validate_analysis_reference.R <reference_input.rds> [report.json]")
  report <- validate_reference_bundle(readRDS(args[[1]]))
  if (length(args) == 2L) jsonlite::write_json(report, args[[2]], auto_unbox = TRUE, pretty = TRUE)
  cat(jsonlite::toJSON(report, auto_unbox = TRUE, pretty = TRUE), "\n")
  if (report$status != "pass") quit(status = 1L)
}
