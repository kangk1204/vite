#!/usr/bin/env Rscript
source("scripts/comparators/fixture_support.R")

prepare_comparator_fixture <- function(output, kind, reference = "data/reference/ReactomePathways.gmt.zip") {
  comparator_libraries()
  if (!kind %in% c("airway", "smoke")) stop("Unknown fixture kind.")
  if (file.exists(output)) stop("Fixture path already exists. Choose a new path to preserve the earlier fixture.")
  captured <- c("scripts/comparators/prepare_fixture.R", "scripts/comparators/fixture_support.R", "renv.lock")
  if (kind == "airway") captured <- c(captured, reference, "scripts/prepare_airway_case.R",
    "scripts/lib/analysis_core.R", "scripts/lib/analysis_diagnostics.R", "scripts/lib/analysis_bootstrap.R",
    "scripts/lib/analysis_io.R", "scripts/lib/analysis_evidence.R", "src/reference/generated/aliases.json", "src/reference/generated/ncbi_gene_map.json")
  hashes <- as.list(setNames(vapply(captured, comparator_hash, character(1)), captured))
  set.seed(20261110)
  if (kind == "airway") {
    source("scripts/prepare_airway_case.R")
    source("scripts/lib/analysis_core.R")
    source("scripts/lib/analysis_io.R")
    input_directory <- tempfile("pnv-comparator-airway-")
    dir.create(input_directory)
    on.exit(unlink(input_directory, recursive = TRUE), add = TRUE)
    config_path <- prepare_airway_case(input_directory)
    input_config <- jsonlite::fromJSON(config_path, simplifyVector = TRUE)
    mapped <- pnv_read_counts(input_config$rawCountsPath, identifier_type = "symbol")
    counts <- mapped$counts
    metadata <- pnv_read_metadata(input_config$sampleMetadataPath)
    pathways <- read_symbol_pathways(reference)
    design <- ~ donor + group
    origin <- "public-airway-GSE52778"
    mapping <- mapped$mapping
    annotation <- data.table::fread(file.path(input_directory, "airway_annotation.tsv"), data.table = FALSE)
    stopifnot(ncol(counts) == 8L, length(unique(metadata$donor)) == 4L, all(table(metadata$donor, metadata$group) == 1L))
  } else {
    counts <- matrix(rnbinom(2000 * 12, mu = 100, size = 5), nrow = 2000)
    rownames(counts) <- paste0("GENE", seq_len(nrow(counts))); colnames(counts) <- paste0("S", seq_len(ncol(counts)))
    counts[1:100, 7:12] <- counts[1:100, 7:12] * 4L
    metadata <- data.frame(sample = colnames(counts), group = rep(c("A", "B"), each = 6))
    pathways <- list(SYNTHETIC_UP = rownames(counts)[1:100], SYNTHETIC_BACKGROUND = rownames(counts)[101:200], SYNTHETIC_MIXED = rownames(counts)[seq(1, 1000, by = 5)])
    design <- ~ group; origin <- "synthetic-software-smoke"
    mapping <- data.frame(original_id = rownames(counts), gene_symbol = rownames(counts), included = TRUE, rule = "synthetic identifier")
  }
  fixture <- list(schemaVersion = 2L, id = paste0("pnv-", kind, "-symbols-v2"), dataOrigin = origin,
    identifierType = "symbol", identifierRule = if (kind == "airway") "PNV airway annotation symbols followed by pnv_read_counts frozen HGNC/NCBI mapping; duplicate mapped symbols summed; exact reference GMT token matching" else "Synthetic gene identifiers",
    counts = counts, metadata = metadata, pathways = pathways, design = design, contrast = c("group", "B", "A"),
    config = list(seed = 20261110L, alpha = 0.05, filterMinCount = 10, filterMinFraction = 0.15),
    sources = hashes, packageVersions = comparator_versions(c(if (kind == "airway") "airway", "DESeq2", "apeglm", "fgsea", "BiocParallel", "jsonlite")))
  direct <- fit_matched_fixture(fixture)
  if (kind == "airway") {
    config <- c(fixture$config, list(designFormula = deparse(design), camera = FALSE, bootstrapReplicates = 0L))
    primary <- pnv_fit_primary(counts, metadata, config)
    genes <- primary$geneResults
    enrichment <- as.data.frame(pnv_score_pathways(setNames(genes$stat, genes$gene), pathways, config))
    stopifnot(identical(genes$gene, direct$geneResults$gene), identical(enrichment$pathway, direct$enrichment$pathway),
      identical(enrichment$leadingEdge, direct$enrichment$leadingEdge))
    gene_fields <- c("baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj", "log2FoldChangeUnshrunk", "lfcSEUnshrunk")
    for (field in gene_fields) stopifnot(isTRUE(all.equal(genes[[field]], direct$geneResults[[field]], tolerance = 1e-8)))
    for (field in c("ES", "NES", "pval", "padj", "size")) stopifnot(isTRUE(all.equal(enrichment[[field]], direct$enrichment[[field]], tolerance = 1e-8)))
    result <- DESeq2::DESeqResults(S4Vectors::DataFrame(genes[, c("baseMean", "log2FoldChange", "lfcSE", "stat", "pvalue", "padj")], row.names = genes$gene), priorInfo = list(type = "apeglm"))
    fixture$matched <- list(dds = primary$dds, res = result, enrichment = enrichment, geneResults = genes,
      rankedGenes = direct$rankedGenes, settings = direct$settings,
      pnvIntegration = list(entrypoints = c("pnv_read_counts", "pnv_read_metadata", "pnv_fit_primary", "pnv_score_pathways"),
        independentDirectPackageParity = TRUE, tolerance = 1e-8, geneFields = gene_fields, testedGenes = nrow(genes), testedPathways = nrow(enrichment)))
  } else fixture$matched <- direct
  validate_comparator_fixture(fixture)
  for (name in names(hashes)) if (!identical(comparator_hash(name), hashes[[name]])) stop("A source changed while preparing the fixture: ", name)
  dir.create(dirname(output), recursive = TRUE, showWarnings = FALSE)
  staging <- tempfile("fixture-", tmpdir = dirname(output))
  on.exit(unlink(staging), add = TRUE)
  saveRDS(fixture, staging, version = 3)
  if (!file.rename(staging, output)) stop("Could not promote prepared fixture.")
  write_comparator_table(mapping, paste0(output, ".mapping.tsv"))
  if (kind == "airway") write_comparator_table(annotation, paste0(output, ".airway-annotation.tsv"))
  write_comparator_table(fixture$matched$geneResults, paste0(output, ".genes.tsv"))
  write_comparator_table(fixture$matched$enrichment, paste0(output, ".pathways.tsv"))
  receipt <- list(schemaVersion = 2L, id = fixture$id, dataOrigin = origin,
    identifierType = fixture$identifierType, identifierRule = fixture$identifierRule,
    fixtureSha256 = comparator_hash(output), fixtureBytes = unname(file.info(output)$size),
    preparationCommand = c("Rscript", "scripts/comparators/prepare_fixture.R", output, kind, if (kind == "airway") reference),
    sourceHashes = hashes, packages = fixture$packageVersions, settings = fixture$matched$settings, pnvIntegration = fixture$matched$pnvIntegration,
    totalInputGenes = nrow(counts), testedGenes = nrow(fixture$matched$res), samples = ncol(counts), testedPathways = nrow(fixture$matched$enrichment),
    artifacts = lapply(c(output, paste0(output, c(".mapping.tsv", ".genes.tsv", ".pathways.tsv"))), function(file) list(path = basename(file), sha256 = comparator_hash(file), bytes = unname(file.info(file)$size))),
    sessionInfo = capture.output(sessionInfo()))
  jsonlite::write_json(receipt, paste0(output, ".json"), auto_unbox = TRUE, pretty = TRUE, digits = NA, na = "null", null = "null")
  cat(jsonlite::toJSON(receipt[c("id", "fixtureSha256", "testedGenes", "samples", "testedPathways")], auto_unbox = TRUE), "\n")
  invisible(fixture)
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) < 2L || length(args) > 3L) stop("Usage: Rscript scripts/comparators/prepare_fixture.R output.rds smoke|airway [frozen-symbol-pathways.gmt.zip]")
  prepare_comparator_fixture(args[[1]], args[[2]], if (length(args) == 3L) args[[3]] else "data/reference/ReactomePathways.gmt.zip")
}
