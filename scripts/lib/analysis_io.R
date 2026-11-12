# Validated file adapters shared by local and cohort analysis entrypoints.
pnv_capture_run_context <- function(config, config_path, entrypoint) {
  pnv_require(c("digest", "DESeq2", "apeglm", "fgsea", "edgeR", "limma", "jsonlite", "writexl", "data.table"))
  inputs <- list(config = config_path, counts = config$rawCountsPath,
    metadata = pnv_default(config$sampleMetadataPath, config$seriesMatrixPath),
    pathways = pnv_default(config$referencePath, "data/reference/ReactomePathways.gmt.zip"),
    gene_map = pnv_default(config$geneMapPath, "src/reference/generated/ncbi_gene_map.json"),
    aliases = pnv_default(config$aliasesPath, "src/reference/generated/aliases.json"),
    entrypoint = entrypoint)
  code <- c("scripts/lib/analysis_core.R", "scripts/lib/analysis_bootstrap.R",
    "scripts/lib/analysis_io.R", "scripts/lib/analysis_evidence.R")
  for (path in code) inputs[[paste0("code:", basename(path))]] <- path
  if (file.exists("renv.lock")) inputs$environment_lock <- "renv.lock"
  project_root <- normalizePath(getwd(), winslash = "/", mustWork = TRUE)
  output_dir <- pnv_default(config$outputDir, "results")
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
  run_root <- normalizePath(output_dir, winslash = "/", mustWork = TRUE)
  captured_paths <- vapply(inputs, normalizePath, character(1), winslash = "/", mustWork = TRUE)
  artifacts <- lapply(names(inputs), function(role) {
    path <- captured_paths[[role]]
    if (is.null(path) || !file.exists(path) || isTRUE(file.info(path)$isdir)) stop(sprintf("Required analysis artifact is missing: %s", role))
    artifact_path <- if (startsWith(path, paste0(run_root, "/"))) {
      substring(path, nchar(run_root) + 2L)
    } else if (startsWith(path, paste0(project_root, "/"))) {
      paste0("project:", substring(path, nchar(project_root) + 2L))
    } else paste0("external:", basename(path))
    artifact_role <- if (role == "counts") "raw_counts" else if (role == "metadata") "sample_metadata" else
      if (role %in% c("pathways", "gene_map", "aliases")) "reference" else
      if (role == "entrypoint" || startsWith(role, "code:")) "analysis_code" else
      if (role == "environment_lock") "environment" else "analysis_config"
    list(role = artifact_role, path = artifact_path, sha256 = digest::digest(file = path, algo = "sha256"),
      sizeBytes = unname(file.info(path)$size))
  })
  versions <- as.list(vapply(sort(loadedNamespaces()), function(p) as.character(getNamespaceVersion(p)), character(1)))
  list(runId = digest::digest(list(artifacts = artifacts, loadedPackages = versions, R = R.version.string), algo = "sha256"),
    artifacts = artifacts, capturedPaths = unname(captured_paths), loadedPackages = versions,
    capturedAt = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"))
}

pnv_assert_run_context <- function(context) {
  if (is.null(context)) return(invisible(NULL))
  for (index in seq_along(context$artifacts)) {
    artifact <- context$artifacts[[index]]
    path <- if (!is.null(context$capturedPaths)) context$capturedPaths[[index]] else sub("^project:", "", artifact$path)
    if (!file.exists(path) || !identical(digest::digest(file = path, algo = "sha256"), artifact$sha256)) {
      stop(sprintf("Analysis artifact changed during the run: %s. Outputs were not finalized.", artifact$path), call. = FALSE)
    }
  }
  invisible(NULL)
}

pnv_read_pathways <- function(path = "data/reference/ReactomePathways.gmt.zip") {
  if (!file.exists(path)) stop(sprintf("Frozen pathway reference not found: %s", path), call. = FALSE)
  if (grepl("\\.zip$", path, ignore.case = TRUE)) {
    entries <- utils::unzip(path, list = TRUE)$Name
    entries <- entries[grepl("\\.gmt$", entries)]
    if (length(entries) != 1) stop("Pathway ZIP must contain exactly one GMT file.", call. = FALSE)
    connection <- unz(path, entries[[1]])
  } else connection <- file(path, "rt")
  on.exit(close(connection))
  lines <- readLines(connection, warn = FALSE)
  fields <- strsplit(lines, "\t", fixed = TRUE)
  fields <- fields[lengths(fields) >= 3]
  pathways <- lapply(fields, function(row) unique(row[-c(1, 2)][nzchar(row[-c(1, 2)])]))
  names(pathways) <- vapply(fields, function(row) paste(row[[2]], row[[1]], sep = " :: "), character(1))
  if (anyDuplicated(names(pathways))) stop("Duplicate pathway identities in the reference.", call. = FALSE)
  pathways
}

pnv_read_counts <- function(path, identifier_type = "auto", gene_map_path = "src/reference/generated/ncbi_gene_map.json",
                            aliases_path = "src/reference/generated/aliases.json") {
  pnv_require(c("data.table", "jsonlite"))
  input <- data.table::fread(path, check.names = FALSE, data.table = FALSE,
    colClasses = list(character = 1L))
  if (ncol(input) < 3 || !nrow(input)) stop("Counts require a gene identifier column and sample columns.", call. = FALSE)
  sample_ids <- names(input)[-1]
  if (anyDuplicated(sample_ids)) stop("Duplicate count sample identifiers.", call. = FALSE)
  raw_ids <- trimws(as.character(input[[1]]))
  numeric_columns <- lapply(input[-1], function(column) suppressWarnings(as.numeric(column)))
  matrix_input <- do.call(cbind, numeric_columns)
  if (any(!is.finite(matrix_input)) || any(matrix_input < 0)) stop("Counts must be finite and non-negative.", call. = FALSE)
  if (any(matrix_input != floor(matrix_input))) stop("Counts must be integer-valued.", call. = FALSE)
  if (any(!nzchar(raw_ids))) stop("Empty gene identifiers are not allowed.", call. = FALSE)
  if (!identifier_type %in% c("auto", "symbol", "gene_id")) stop("Unsupported geneIdentifierType.", call. = FALSE)
  gene_map <- jsonlite::fromJSON(gene_map_path, simplifyVector = TRUE)
  aliases <- jsonlite::fromJSON(aliases_path, simplifyVector = TRUE)
  map_one <- function(id) {
    normalized <- toupper(sub("\\.[0-9]+$", "", id))
    if (identifier_type != "symbol" && !is.null(gene_map[[id]])) return(as.character(gene_map[[id]]))
    if (identifier_type == "gene_id") return(NA_character_)
    canonical <- aliases[[normalized]]
    if (!is.null(canonical)) return(as.character(canonical))
    # Explicit symbol inputs retain unmapped identifiers in statistics; reference overlap may be empty.
    if (!grepl("^[0-9]+$", normalized) && !grepl("^ENSG[0-9]+$", normalized)) return(normalized)
    NA_character_
  }
  symbols <- vapply(raw_ids, map_one, character(1))
  mapping <- data.frame(original_id = raw_ids, gene_symbol = symbols,
    status = ifelse(is.na(symbols), "unmapped_excluded", ifelse(raw_ids == symbols, "unchanged", "mapped")),
    stringsAsFactors = FALSE)
  keep <- !is.na(symbols)
  if (!any(keep)) stop("No gene identifiers could be mapped; provide symbols or supported NCBI GeneIDs.", call. = FALSE)
  grouped <- rowsum(matrix_input[keep, , drop = FALSE], group = symbols[keep], reorder = FALSE)
  colnames(grouped) <- sample_ids
  if (any(grouped > .Machine$integer.max)) stop("Aggregated counts exceed the supported integer range.", call. = FALSE)
  list(counts = grouped, mapping = mapping,
    mappingRule = "NCBI GeneID/HGNC alias to symbol; rows mapping to the same symbol are summed; unmapped numeric IDs are excluded and recorded.")
}

pnv_read_metadata <- function(path, numeric_covariates = character()) {
  pnv_require("data.table")
  # Identifiers and factor labels must retain their exact spelling (including leading zeros).
  metadata <- data.table::fread(path, data.table = FALSE, check.names = FALSE, colClasses = "character")
  if (!all(c("sample", "group") %in% names(metadata))) stop("Metadata TSV must contain sample and group columns.", call. = FALSE)
  if (!is.character(numeric_covariates) || anyNA(numeric_covariates) || anyDuplicated(numeric_covariates) ||
      any(!numeric_covariates %in% names(metadata)) || any(numeric_covariates %in% c("sample", "group", "batch", "donor"))) {
    stop("numericCovariates must name distinct non-identifier metadata columns; sample/group/batch/donor are categorical.", call. = FALSE)
  }
  for (column in numeric_covariates) {
    values <- suppressWarnings(as.numeric(metadata[[column]]))
    if (any(!is.finite(values))) stop(sprintf("Explicit numeric covariate %s contains missing or invalid values.", column), call. = FALSE)
    metadata[[column]] <- values
  }
  if (anyDuplicated(metadata$sample)) stop("Duplicate metadata sample identifiers.", call. = FALSE)
  metadata
}

pnv_pathway_table <- function(result) {
  table <- as.data.frame(result$pathwayResults)
  table$pathway_id <- sub(" :: .*", "", table$pathway)
  table$pathway_name <- ifelse(grepl(" :: ", table$pathway, fixed = TRUE), sub("^.*? :: ", "", table$pathway), table$pathway)
  table$leadingEdge <- vapply(table$leadingEdge, paste, collapse = ";", character(1))
  table
}

pnv_write_tsv <- function(table, path) {
  data.table::fwrite(table, path, sep = "\t", na = "", quote = "auto")
}

pnv_write_outputs <- function(result, config, mapping = NULL) {
  pnv_require(c("data.table", "jsonlite", "writexl"))
  pnv_assert_run_context(config$runContext)
  prefix <- pnv_default(config$resultPrefix, "analysis")
  if (length(prefix) != 1 || !grepl("^[A-Za-z0-9_-]+$", prefix)) stop("resultPrefix must be a safe filename stem.", call. = FALSE)
  output_dir <- pnv_default(config$outputDir, "results")
  dir.create(output_dir, recursive = TRUE, showWarnings = FALSE)
  path_for <- function(suffix) file.path(output_dir, paste0(prefix, suffix))
  paths <- list(deg = path_for("_deseq2.tsv"), pathways = path_for("_fgsea_reactome.tsv"),
    metadata = path_for("_sample_metadata.tsv"), summary = path_for("_analysis_summary.tsv"),
    workbook = path_for("_pathway_viewer_input.xlsx"), evidence = path_for("_evidence.json"),
    camera = path_for("_camera.tsv"), bootstrapFailures = path_for("_bootstrap_failures.json"),
    mapping = path_for("_gene_mapping.tsv"), excludedGenes = path_for("_filtered_genes.tsv"),
    referenceInput = path_for("_reference_input.rds"))
  genes <- result$geneResults
  pathways <- pnv_pathway_table(result)
  metadata <- result$metadata
  condition_a <- pnv_default(config$conditionA, "Control")
  condition_b <- pnv_default(config$conditionB, "Treatment")
  metadata$condition_label <- ifelse(metadata$group == "A", condition_a, condition_b)
  pnv_write_tsv(genes, paths$deg)
  pnv_write_tsv(pathways, paths$pathways)
  pnv_write_tsv(metadata, paths$metadata)
  pnv_write_tsv(result$cameraResults, paths$camera)
  if (is.null(mapping)) mapping <- data.frame(original_id = genes$gene, gene_symbol = genes$gene, status = "supplied_symbol")
  pnv_write_tsv(mapping, paths$mapping)
  pnv_write_tsv(data.frame(gene = result$excludedGenes,
    reason = rep("prespecified_low_count_filter", length(result$excludedGenes))), paths$excludedGenes)
  jsonlite::write_json(result$bootstrap$failures, paths$bootstrapFailures, auto_unbox = TRUE, pretty = TRUE, na = "null")
  summary <- c(cohort_id = pnv_default(config$cohortKey, prefix),
    dataset_identifier = pnv_default(config$datasetIdentifier, "User-supplied"),
    contrast_name = pnv_default(config$contrastName, paste0(condition_b, "_vs_", condition_a)),
    condition_a = condition_a, condition_b = condition_b, contrast_samples_total = nrow(metadata),
    condition_a_samples = sum(metadata$group == "A"), condition_b_samples = sum(metadata$group == "B"),
    tested_genes = nrow(genes), DEGs_FDR_lt_0.05_absLFC_gt_1 = sum(genes$padj < 0.05 & abs(genes$log2FoldChange) > 1, na.rm = TRUE),
    Reactome_pathways_FDR_lt_0.05 = sum(pathways$padj < 0.05, na.rm = TRUE),
    tested_pathways = nrow(pathways), bootstrap_requested = result$bootstrap$requested,
    bootstrap_completed = result$bootstrap$completed)
  pnv_write_tsv(data.frame(metric = names(summary), value = unname(summary)), paths$summary)
  gene_sheet <- data.frame(gene_symbol = genes$gene, log2fc = genes$log2FoldChange,
    padj = genes$padj, pvalue = genes$pvalue, rank_metric = genes$stat,
    condition_a_mean = rowMeans(result$normalizedCounts[, metadata$group == "A", drop = FALSE]),
    condition_b_mean = rowMeans(result$normalizedCounts[, metadata$group == "B", drop = FALSE]),
    missing_reason = genes$missingReason, check.names = FALSE)
  for (sample_id in colnames(result$normalizedCounts)) gene_sheet[[paste0("sample_", sample_id)]] <- result$normalizedCounts[, sample_id]
  pathway_sheet <- data.frame(pathway_id = pathways$pathway_id, pathway_name = pathways$pathway_name,
    collection = rep("Reactome", nrow(pathways)), nes = pathways$NES, padj = pathways$padj,
    leading_edge_genes = pathways$leadingEdge, missing_reason = pathways$missingReason)
  project_sheet <- data.frame(project_title = pnv_default(config$projectTitle, "Local RNA-seq analysis"),
    contrast_name = unname(summary[["contrast_name"]]), condition_a = condition_a, condition_b = condition_b,
    species = "human", dataset_identifier = unname(summary[["dataset_identifier"]]),
    contrast_definition = pnv_default(config$contrastDefinition, paste(condition_b, "versus", condition_a)),
    sample_group_source = pnv_default(config$sampleGroupSource, "Explicit sample metadata"),
    batch_handling_rule = paste("DESeq2 design =", result$settings$designFormula),
    analysis_timestamp = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
    git_commit = Sys.getenv("PNV_GIT_COMMIT", "local-r-run"),
    reference_asset_version = Sys.getenv("PNV_REFERENCE_ASSET_VERSION", "frozen-reference-hash-in-evidence"),
    analysis_method = "DESeq2+fgsea", schema_version = 2,
    notes = pnv_default(config$notes, "Normalized expression values are DESeq2 normalized counts; PPI edges are reference interactions."))
  sample_sheet <- data.frame(sample_id = metadata$sample, label = metadata$sample,
    group = as.character(metadata$group), group_label = metadata$condition_label,
    batch = if ("batch" %in% names(metadata)) as.character(metadata$batch) else rep("", nrow(metadata)))
  writexl::write_xlsx(list(Project = project_sheet, Genes = gene_sheet,
    Pathways = pathway_sheet, Samples = sample_sheet), paths$workbook)
  evidence <- pnv_build_evidence(result, config, paths, genes, pathways, metadata)
  jsonlite::write_json(list(schemaVersion = 2L, evidence = evidence), paths$evidence,
    auto_unbox = TRUE, pretty = TRUE, digits = NA, na = "null", null = "null")
  paths
}

source("scripts/lib/analysis_evidence.R")
