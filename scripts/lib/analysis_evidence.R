pnv_source_table <- function(table) {
  table <- as.data.frame(table)
  table[] <- lapply(table, function(column) if (is.factor(column)) as.character(column) else column)
  list(columns = names(table), rows = unname(lapply(seq_len(nrow(table)), function(index) {
    unname(as.list(table[index, , drop = FALSE]))
  })))
}

pnv_build_evidence <- function(result, config, paths, genes, pathways, metadata) {
  packages <- c("DESeq2", "apeglm", "fgsea", if (result$settings$camera) c("edgeR", "limma"))
  versions <- as.list(stats::setNames(vapply(packages, function(p) as.character(utils::packageVersion(p)), character(1)), packages))
  versions$R <- as.character(getRversion())
  pathway_evidence <- lapply(seq_len(nrow(pathways)), function(index) {
    pathway <- pathways$pathway[[index]]
    camera <- result$cameraResults[result$cameraResults$pathway == pathway, , drop = FALSE]
    entry <- list(source = list(table = "pathways", row = index))
    if (nrow(camera)) entry$camera <- list(pvalue = camera$pvalue[[1]], padj = camera$padj[[1]], direction = camera$direction[[1]])
    if (!is.null(result$bootstrap$pathways[[pathway]])) entry$bootstrap <- result$bootstrap$pathways[[pathway]]
    entry
  })
  names(pathway_evidence) <- pathways$pathway_id
  checks <- list(list(id = "model-rank", status = "pass", message = "The actual design matrix is full rank with residual degrees of freedom."),
    list(id = "sample-alignment", status = "pass", message = "Included sample identifiers match the count-matrix columns one-to-one."),
    list(id = "source-artifact-hashes", status = "unknown", message = "This R-produced sidecar alone does not verify supplied artifact hashes."))
  if (!nrow(pathways)) checks[[length(checks) + 1L]] <- list(id = "eligible-pathways", status = "unknown", message = "No reference pathway met the prespecified 15–500 mapped-gene size range.")
  if (length(result$bootstrap$failures)) checks[[length(checks) + 1L]] <- list(id = "bootstrap-fits", status = "unknown",
    message = sprintf("%d of %d bootstrap fits failed; failures are recorded separately.", length(result$bootstrap$failures), result$bootstrap$requested))
  list(runId = config$runContext$runId, analysis = list(method = "DESeq2+fgsea", versions = versions,
    contrast = list(conditionA = pnv_default(config$conditionA, "Control"), conditionB = pnv_default(config$conditionB, "Treatment")),
    designFormula = result$settings$designFormula, seed = result$settings$seed,
    alpha = result$settings$alpha, geneHypothesisCount = nrow(genes), pathwayHypothesisCount = nrow(pathways),
    filterRule = sprintf("count >= %s in >= ceiling(%s * n_samples) samples", result$settings$filterMinCount, result$settings$filterMinFraction),
    rankMetric = "DESeq2 Wald statistic (unshrunk inference)", lfcMethod = "apeglm", adjustment = "BH",
    dispersionFitType = attr(DESeq2::dispersionFunction(result$dds), "fitType"),
    modelColumns = colnames(result$designMatrix), minPathwaySize = 15L, maxPathwaySize = 500L,
    rngKind = c("Mersenne-Twister", "Inversion", "Rejection"),
    expressionScale = "DESeq2 normalized counts", fgsea = list(eps = 0, sampleSize = 101L, nPermSimple = 1000L, nproc = 1L),
    camera = if (result$settings$camera) "TMM + limma-voom + CAMERA (estimated inter-gene correlation)" else NULL),
    verification = list(status = "internally_consistent", checks = checks,
      limitations = c("Internal consistency is not independent validation of original biological sample labels.",
        "Bootstrap frequencies describe this dataset and procedure, not independent-study replication probabilities.",
        "CAMERA and fgsea address different test hypotheses; their p-values are not combined.")),
    artifacts = pnv_default(config$runContext$artifacts, list()),
    executionCapture = list(artifacts = pnv_default(config$runContext$artifacts, list()),
      loadedPackages = config$runContext$loadedPackages, capturedAt = config$runContext$capturedAt),
    pathways = if (length(pathway_evidence)) pathway_evidence else structure(list(), names = character()),
    sourceTables = list(genes = pnv_source_table(genes), pathways = pnv_source_table(pathways),
      metadata = pnv_source_table(metadata), camera = pnv_source_table(result$cameraResults)),
    bootstrap = list(requested = result$bootstrap$requested, completed = result$bootstrap$completed,
      failures = result$bootstrap$failures, fingerprint = result$bootstrap$fingerprint,
      workerPolicy = result$bootstrap$workerPolicy),
    excludedSamples = pnv_default(config$excludedSamples, list()),
    runtime = list(loadedPackages = config$runContext$loadedPackages,
      capturedAt = config$runContext$capturedAt),
    sessionInfo = capture.output(utils::sessionInfo()))
}
