# Shared, package-backed inference. Sourcing this file never runs an analysis.
pnv_default <- function(value, fallback) if (is.null(value) || !length(value)) fallback else value

pnv_require <- function(packages) {
  missing <- packages[!vapply(packages, requireNamespace, logical(1), quietly = TRUE)]
  if (length(missing)) stop(sprintf("Missing R packages: %s. Run scripts/install_case_study_r_packages.R.",
    paste(missing, collapse = ", ")), call. = FALSE)
}

pnv_seed_scope <- function(seed) {
  previous_kind <- RNGkind()
  previous_seed <- if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) get(".Random.seed", envir = .GlobalEnv) else NULL
  RNGkind("Mersenne-Twister", "Inversion", "Rejection")
  set.seed(as.integer(seed))
  function() {
    do.call(RNGkind, as.list(previous_kind))
    if (is.null(previous_seed)) {
      if (exists(".Random.seed", envir = .GlobalEnv, inherits = FALSE)) rm(".Random.seed", envir = .GlobalEnv)
    } else assign(".Random.seed", previous_seed, envir = .GlobalEnv)
  }
}

pnv_settings <- function(config = list()) {
  settings <- list(
    designFormula = pnv_default(config$designFormula, "~ group"),
    seed = pnv_default(config$seed, 20261110L), alpha = 0.05,
    filterMinCount = pnv_default(config$filterMinCount, 10),
    filterMinFraction = pnv_default(config$filterMinFraction, 0.15),
    minSize = 15L, maxSize = 500L, lfcMethod = "apeglm",
    camera = pnv_default(config$camera, TRUE),
    bootstrapReplicates = pnv_default(config$bootstrapReplicates, 0L),
    bootstrapWorkers = pnv_default(config$bootstrapWorkers, 1L),
    bootstrapUnitColumn = config$bootstrapUnitColumn,
    bootstrapCheckpointDir = config$bootstrapCheckpointDir)
  if (length(settings$seed) != 1 || !is.finite(settings$seed) || settings$seed < 0 ||
      settings$seed > .Machine$integer.max || settings$seed != floor(settings$seed)) {
    stop("seed must be a single non-negative R integer.", call. = FALSE)
  }
  if (!is.numeric(settings$filterMinCount) || length(settings$filterMinCount) != 1 ||
      !is.finite(settings$filterMinCount) || settings$filterMinCount < 1 ||
      !is.numeric(settings$filterMinFraction) || length(settings$filterMinFraction) != 1 ||
      !is.finite(settings$filterMinFraction) || settings$filterMinFraction <= 0 || settings$filterMinFraction > 1) {
    stop("Invalid expression filter thresholds.", call. = FALSE)
  }
  repetitions <- settings$bootstrapReplicates
  if (length(repetitions) != 1 || !is.numeric(repetitions) || !is.finite(repetitions) ||
      repetitions < 0 || repetitions != floor(repetitions) || repetitions > 10000) {
    stop("bootstrapReplicates must be an integer from 0 to 10000.", call. = FALSE)
  }
  if (!is.logical(settings$camera) || length(settings$camera) != 1 || is.na(settings$camera)) {
    stop("camera must be true or false.", call. = FALSE)
  }
  workers <- settings$bootstrapWorkers
  if (length(workers) != 1 || !is.numeric(workers) || !is.finite(workers) ||
      workers != floor(workers) || workers < 1 || workers > 8) {
    stop("bootstrapWorkers must be an integer from 1 to 8.", call. = FALSE)
  }
  settings$bootstrapWorkers <- as.integer(workers)
  settings
}

pnv_validate_inputs <- function(counts, metadata, config = list()) {
  settings <- pnv_settings(config)
  if (!is.matrix(counts) || !is.numeric(counts) || !nrow(counts) || !ncol(counts)) {
    stop("Counts must be a non-empty numeric gene-by-sample matrix.", call. = FALSE)
  }
  if (any(!is.finite(counts)) || any(counts < 0)) stop("Counts must be finite and non-negative.", call. = FALSE)
  if (any(counts != floor(counts)) || any(counts > .Machine$integer.max)) {
    stop("Counts must be integer values within the R integer range.", call. = FALSE)
  }
  sample_ids <- colnames(counts)
  if (is.null(sample_ids) || any(!nzchar(sample_ids)) || anyDuplicated(sample_ids)) {
    stop("Missing or duplicate count sample identifiers.", call. = FALSE)
  }
  if (is.null(rownames(counts)) || any(!nzchar(rownames(counts))) || anyDuplicated(rownames(counts))) {
    stop("Missing or duplicate gene identifiers; resolve mappings before analysis.", call. = FALSE)
  }
  metadata <- as.data.frame(metadata, stringsAsFactors = FALSE)
  if (!all(c("sample", "group") %in% names(metadata)) || anyNA(metadata$sample) ||
      anyDuplicated(metadata$sample) || !setequal(metadata$sample, sample_ids)) {
    stop("Metadata must contain unique sample IDs matching every count column and an explicit group.", call. = FALSE)
  }
  metadata <- metadata[match(sample_ids, metadata$sample), , drop = FALSE]
  rownames(metadata) <- metadata$sample
  if (anyNA(metadata$group) || any(!as.character(metadata$group) %in% c("A", "B"))) {
    stop("Every included sample must have group A or B.", call. = FALSE)
  }
  metadata$group <- factor(metadata$group, levels = c("A", "B"))
  if (any(table(metadata$group) < 2)) stop("At least two biological replicates per group are required.", call. = FALSE)
  if (any(colSums(counts) == 0)) stop("Zero-library samples cannot be analyzed.", call. = FALSE)
  if (all(vapply(seq_len(ncol(counts)), function(i) identical(counts[, i], counts[, 1]), logical(1)))) {
    stop("All count columns are identical; no between-sample variation is testable.", call. = FALSE)
  }
  formula_text <- settings$designFormula
  if (!is.character(formula_text) || length(formula_text) != 1 ||
      !grepl("^~[[:space:]]*[A-Za-z][A-Za-z0-9_]*([[:space:]]*\\+[[:space:]]*[A-Za-z][A-Za-z0-9_]*)*[[:space:]]*$", formula_text)) {
    stop("Use an additive design of metadata columns, e.g. ~ donor + group.", call. = FALSE)
  }
  formula <- stats::as.formula(formula_text)
  variables <- all.vars(formula)
  if (!"group" %in% variables || any(!variables %in% names(metadata))) {
    stop("Design must include group and only available metadata columns.", call. = FALSE)
  }
  for (variable in variables) {
    values <- metadata[[variable]]
    if (anyNA(values) || any(as.character(values) == "") || (is.numeric(values) && any(!is.finite(values)))) {
      stop(sprintf("Missing/non-finite values in model covariate %s; curate samples explicitly.", variable), call. = FALSE)
    }
    if (is.character(values)) metadata[[variable]] <- factor(values)
  }
  design <- tryCatch(stats::model.matrix(formula, data = metadata), error = function(e) {
    stop(sprintf("Design is not estimable: %s", conditionMessage(e)), call. = FALSE)
  })
  if (qr(design)$rank != ncol(design)) {
    stop("Design matrix is rank deficient (possibly condition/batch confounding); no covariate was dropped.", call. = FALSE)
  }
  if (nrow(design) <= ncol(design)) stop("Design has no residual degrees of freedom.", call. = FALSE)
  if (!"groupB" %in% colnames(design)) stop("Design must estimate the B versus A group coefficient.", call. = FALSE)
  list(metadata = metadata, designMatrix = design, formula = formula, settings = settings)
}

pnv_fit_primary <- function(counts, metadata, config = list(), shrink = TRUE) {
  pnv_require(c("DESeq2", if (shrink) "apeglm"))
  validated <- pnv_validate_inputs(counts, metadata, config)
  settings <- validated$settings
  restore_rng <- pnv_seed_scope(settings$seed)
  on.exit(restore_rng(), add = TRUE)
  keep <- rowSums(counts >= settings$filterMinCount) >= ceiling(settings$filterMinFraction * ncol(counts))
  if (!any(keep)) stop("No genes passed the prespecified expression filter.", call. = FALSE)
  dds <- DESeq2::DESeqDataSetFromMatrix(round(counts[keep, , drop = FALSE]),
    validated$metadata, validated$formula)
  dds <- DESeq2::DESeq(dds, quiet = TRUE, parallel = FALSE)
  wald <- DESeq2::results(dds, contrast = c("group", "B", "A"), alpha = settings$alpha)
  genes <- data.frame(gene = rownames(wald), as.data.frame(wald), row.names = NULL, check.names = FALSE)
  genes$log2FoldChangeUnshrunk <- genes$log2FoldChange
  genes$lfcSEUnshrunk <- genes$lfcSE
  if (shrink) {
    coefficient <- which(DESeq2::resultsNames(dds) == "group_B_vs_A")
    if (length(coefficient) != 1) stop("Cannot identify the prespecified B versus A coefficient.", call. = FALSE)
    shrunk <- DESeq2::lfcShrink(dds, coef = coefficient, res = wald, type = "apeglm", quiet = TRUE)
    genes$log2FoldChange <- shrunk$log2FoldChange
    genes$lfcSE <- shrunk$lfcSE
  }
  genes$missingReason <- ifelse(is.na(genes$pvalue), "DESeq2_not_testable",
    ifelse(is.na(genes$padj), "DESeq2_independent_filter", NA_character_))
  list(dds = dds, geneResults = genes, normalizedCounts = DESeq2::counts(dds, normalized = TRUE),
    metadata = validated$metadata, designMatrix = validated$designMatrix, settings = settings,
    excludedGenes = rownames(counts)[!keep])
}

pnv_empty_pathways <- function() {
  data.table::data.table(pathway = character(), pval = numeric(), padj = numeric(),
    log2err = numeric(), ES = numeric(), NES = numeric(), size = integer(),
    leadingEdge = list(), missingReason = character())
}

pnv_score_pathways <- function(ranks, pathways, config = list()) {
  pnv_require(c("fgsea", "data.table"))
  settings <- pnv_settings(config)
  if (is.null(names(ranks)) || anyDuplicated(names(ranks))) stop("Ranking genes must have unique IDs.", call. = FALSE)
  ranks <- ranks[is.finite(ranks)]
  ranks <- ranks[order(-ranks, names(ranks))]
  if (!is.list(pathways) || (length(pathways) && (is.null(names(pathways)) || anyDuplicated(names(pathways))))) {
    stop("Pathways must be a uniquely named list.", call. = FALSE)
  }
  overlap <- lapply(pathways, function(genes) intersect(unique(genes), names(ranks)))
  eligible <- lengths(overlap) >= settings$minSize & lengths(overlap) <= settings$maxSize
  overlap <- overlap[eligible]
  if (!length(overlap)) return(pnv_empty_pathways())
  if (length(unique(ranks)) < 2L) {
    result <- data.table::data.table(pathway = names(overlap), pval = NA_real_, padj = NA_real_,
      log2err = NA_real_, ES = NA_real_, NES = NA_real_, size = lengths(overlap),
      leadingEdge = lapply(overlap, function(x) character()), missingReason = "constant_rank")
    return(result)
  }
  restore_rng <- pnv_seed_scope(settings$seed)
  on.exit(restore_rng(), add = TRUE)
  result <- fgsea::fgseaMultilevel(pathways = overlap, stats = ranks,
    minSize = settings$minSize, maxSize = settings$maxSize, eps = 0,
    nPermSimple = 1000, sampleSize = 101, nproc = 1,
    BPPARAM = BiocParallel::SerialParam(progressbar = FALSE))
  result$padj <- stats::p.adjust(result$pval, method = "BH")
  result$missingReason <- ifelse(is.na(result$pval) | is.na(result$NES), "fgsea_not_estimable", NA_character_)
  result[order(result$padj, result$pathway, na.last = TRUE), ]
}

pnv_camera <- function(counts, metadata, design, pathways) {
  pnv_require(c("edgeR", "limma"))
  ids <- rownames(counts)
  overlap <- lapply(pathways, function(genes) match(intersect(unique(genes), ids), ids))
  overlap <- overlap[lengths(overlap) >= 15 & lengths(overlap) <= 500]
  if (!length(overlap)) return(data.frame(pathway = character(), pvalue = numeric(),
    padj = numeric(), direction = character()))
  y <- edgeR::calcNormFactors(edgeR::DGEList(counts = counts), method = "TMM")
  v <- limma::voom(y, design = design, plot = FALSE)
  tested <- limma::camera(v, index = overlap, design = design,
    contrast = which(colnames(design) == "groupB"), inter.gene.cor = NA, sort = FALSE)
  data.frame(pathway = rownames(tested), pvalue = tested$PValue,
    padj = stats::p.adjust(tested$PValue, "BH"), direction = tested$Direction, row.names = NULL)
}

pnv_analyze_counts <- function(counts, metadata, pathways, config = list()) {
  primary <- pnv_fit_primary(counts, metadata, config)
  ranks <- setNames(primary$geneResults$stat, primary$geneResults$gene)
  primary$pathwayResults <- pnv_score_pathways(ranks, pathways, config)
  primary$cameraResults <- if (primary$settings$camera) {
    pnv_camera(counts[primary$geneResults$gene, , drop = FALSE], primary$metadata,
      primary$designMatrix, pathways)
  } else data.frame(pathway = character(), pvalue = numeric(), padj = numeric(), direction = character())
  primary$bootstrap <- pnv_bootstrap_pathways(counts, metadata, pathways, config, primary$pathwayResults)
  primary
}

source("scripts/lib/analysis_bootstrap.R")
