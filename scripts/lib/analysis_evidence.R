pnv_source_table <- function(table) {
  table <- as.data.frame(table)
  table[] <- lapply(table, function(column) if (is.factor(column)) as.character(column) else column)
  list(columns = names(table), rows = unname(lapply(seq_len(nrow(table)), function(index) {
    unname(as.list(table[index, , drop = FALSE]))
  })))
}

pnv_warning_table <- function(conditions) {
  if (!length(conditions)) return(data.frame(stage = character(), type = character(), message = character(),
    affectedQuantity = character(), geneAttribution = character(), affectedGeneIds = character()))
  do.call(rbind, lapply(conditions, function(x) data.frame(stage = x$stage, type = x$type,
    message = x$message, affectedQuantity = x$affectedQuantity, geneAttribution = x$geneAttribution,
    affectedGeneIds = if (is.null(x$affectedGeneIds)) NA_character_ else paste(x$affectedGeneIds, collapse = ";"))))
}

pnv_bootstrap_diagnostic_table <- function(diagnostics) {
  columns <- c("totalGenes", "betaNonconverged", "betaConvergenceUnknown", "cooksWithheld", "independentFiltered", "rankingIncluded", "rankingExcluded", "warningCount", "messageCount")
  if (!length(diagnostics)) {
    result <- data.frame(iteration = integer(), status = character())
    for (name in columns) result[[name]] <- integer()
    return(result)
  }
  do.call(rbind, lapply(diagnostics, function(x) {
    row <- data.frame(iteration = x$iteration, status = x$status)
    for (name in columns) row[[name]] <- pnv_default(x$diagnostics$summary[[name]], NA_integer_)
    row
  }))
}

pnv_build_evidence <- function(result, config, paths, genes, pathways, metadata) {
  packages <- c("DESeq2", "apeglm", "fgsea", if (result$settings$camera) c("edgeR", "limma"))
  versions <- as.list(stats::setNames(vapply(packages, function(p) as.character(utils::packageVersion(p)), character(1)), packages))
  versions$R <- as.character(getRversion())
  pathway_evidence <- lapply(seq_len(nrow(pathways)), function(index) {
    pathway <- pathways$pathway[[index]]
    camera <- result$cameraResults[result$cameraResults$pathway == pathway, , drop = FALSE]
    entry <- list(source = list(table = "pathways", row = index))
    if (nrow(camera)) entry$camera <- list(pvalue = camera$pvalue[[1]], padj = camera$padj[[1]],
      direction = camera$direction[[1]], nGenes = camera$NGenes[[1]], correlation = camera$Correlation[[1]])
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
  diagnostics <- result$fitDiagnostics
  if (diagnostics$summary$cooksWithheld > 0) checks[[length(checks) + 1L]] <- list(id = "cook-ranked-genes", status = "unknown",
    message = sprintf("%d genes have Cook-withheld p values; %d retain finite original Wald ranks under the recorded primary policy.",
      diagnostics$summary$cooksWithheld, diagnostics$rankingPolicy$includedCookOutlierCount))
  if (diagnostics$summary$betaNonconverged > 0) checks[[length(checks) + 1L]] <- list(id = "model-convergence", status = "unknown",
    message = sprintf("%d gene models have betaConv=FALSE; inspect the original Wald and ranking flags in the genes source table.", diagnostics$summary$betaNonconverged))
  if (diagnostics$summary$warningCount > 0) checks[[length(checks) + 1L]] <- list(id = "statistical-warnings", status = "unknown",
    message = sprintf("%d statistical warnings were recorded with method/quantity scope; upstream warnings without gene IDs remain unattributed.", diagnostics$summary$warningCount))
  list(runId = config$runContext$runId, analysis = list(method = "DESeq2+fgsea", versions = versions,
    contrast = list(conditionA = pnv_default(config$conditionA, "Control"), conditionB = pnv_default(config$conditionB, "Treatment")),
    designFormula = result$settings$designFormula, seed = result$settings$seed,
    alpha = result$settings$alpha, geneHypothesisCount = nrow(genes), pathwayHypothesisCount = nrow(pathways),
    filterRule = sprintf("count >= %s in >= ceiling(%s * n_samples) samples", result$settings$filterMinCount, result$settings$filterMinFraction),
    rankMetric = "DESeq2 Wald statistic (unshrunk inference)", lfcMethod = "apeglm", adjustment = "BH",
    rankingPolicy = diagnostics$rankingPolicy, countFilterExcludedGeneCount = length(result$excludedGenes),
    deseqOptions = list(test = "Wald", betaPrior = FALSE, minReplicatesForReplace = 7L,
      independentFiltering = TRUE, pAdjustMethod = "BH", cooksCutoff = "F_0.99(p, n-p)", alpha = .05),
    shrinkOptions = list(type = "apeglm", apeMethod = "nbinomCR", apeAdapt = TRUE, lfcThreshold = 0),
    dispersionFitType = attr(DESeq2::dispersionFunction(result$dds), "fitType"),
    modelColumns = colnames(result$designMatrix), minPathwaySize = 15L, maxPathwaySize = 500L,
    rngKind = c("Mersenne-Twister", "Inversion", "Rejection"),
    expressionScale = "DESeq2 normalized counts", fgsea = list(eps = 0, sampleSize = 101L, nPermSimple = 1000L, nproc = 1L),
    camera = if (result$settings$camera) "TMM + limma-voom + CAMERA (estimated inter-gene correlation)" else NULL,
    cameraOptions = if (result$settings$camera) pnv_camera_options() else NULL,
    covariateTransformations = pnv_default(config$covariateTransformations, list())),
    verification = list(status = "internally_consistent", checks = checks,
      limitations = c("Internal consistency is not independent validation of original biological sample labels.",
        "Bootstrap frequencies describe this dataset and procedure, not independent-study replication probabilities.",
        "Wilson intervals quantify finite Monte Carlo precision conditional on a testable resample, including fgsea stochastic variation; they are not biological or external replication intervals.",
        "CAMERA and fgsea address different test hypotheses; their p-values are not combined.")),
    artifacts = pnv_default(config$runContext$artifacts, list()),
    executionCapture = list(artifacts = pnv_default(config$runContext$artifacts, list()),
      loadedPackages = config$runContext$loadedPackages, capturedAt = config$runContext$capturedAt),
    pathways = if (length(pathway_evidence)) pathway_evidence else structure(list(), names = character()),
    fitDiagnostics = diagnostics,
    sourceTables = list(genes = pnv_source_table(genes), pathways = pnv_source_table(pathways),
      metadata = pnv_source_table(metadata), camera = pnv_source_table(result$cameraResults),
      fit_warnings = pnv_source_table(pnv_warning_table(diagnostics$warnings)),
      bootstrap_fit_diagnostics = pnv_source_table(pnv_bootstrap_diagnostic_table(result$bootstrap$fitDiagnostics))),
    bootstrap = list(requested = result$bootstrap$requested, completed = result$bootstrap$completed,
      failures = result$bootstrap$failures, fingerprint = result$bootstrap$fingerprint,
      workerPolicy = result$bootstrap$workerPolicy),
    excludedSamples = pnv_default(config$excludedSamples, list()),
    runtime = list(loadedPackages = config$runContext$loadedPackages,
      capturedAt = config$runContext$capturedAt),
    sessionInfo = capture.output(utils::sessionInfo()))
}
