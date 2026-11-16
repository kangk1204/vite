#!/usr/bin/env Rscript
file_arg <- commandArgs(FALSE)[grepl("^--file=", commandArgs(FALSE))]
runner_file <- normalizePath(sub("^--file=", "", file_arg[[1]]))
source(file.path(dirname(runner_file), "fixture_support.R"))
comparator_libraries()
args <- commandArgs(TRUE)
if (length(args) != 4L) stop("Usage: run_comparator.R GeneTonic|RNAmel fixture.rds output-directory matched|defaults")
tool <- args[[1]]; mode <- args[[4]]
if (!tool %in% c("GeneTonic", "RNAmel") || !mode %in% c("matched", "defaults")) stop("Unknown comparator or mode.")
if (!requireNamespace(tool, quietly = TRUE)) stop("Missing comparator package ", tool, ". Run scripts/comparators/install.R.")
fixture_file <- normalizePath(args[[2]])
output <- normalizePath(args[[3]], mustWork = FALSE)
if (dir.exists(output) && any(grepl("metrics\\.json$|\\.html$|\\.Rmd$", list.files(output)))) stop("Comparator output already exists. Choose a new output directory to retain earlier observations.")
dir.create(output, recursive = TRUE, showWarnings = FALSE)
fixture_hash <- comparator_hash(fixture_file)
fixture <- readRDS(fixture_file)
validate_comparator_fixture(fixture, require_matched = mode == "matched" || tool == "GeneTonic")
if (!file.exists(paste0(fixture_file, ".json"))) stop("The fixture preparation receipt is required.")
receipt <- jsonlite::read_json(paste0(fixture_file, ".json"))
if (!identical(receipt$fixtureSha256, fixture_hash)) stop("The fixture differs from its preparation receipt.")
metadata <- fixture$metadata
metadata$group <- factor(metadata$group, levels = c("A", "B"))
rownames(metadata) <- metadata$sample
counts <- fixture$counts[, metadata$sample, drop = FALSE]
report <- file.path(output, paste0(tolower(tool), ".", mode, ".html"))
set.seed(fixture$config$seed)
BiocParallel::register(BiocParallel::SerialParam(progressbar = FALSE), default = TRUE)
started <- proc.time()[[3]]
calls <- list(); captured_warnings <- character()
track <- function(name, arguments, operation) {
  began <- proc.time()[[3]]
  value <- operation()
  calls[[length(calls) + 1L]] <<- list(functionName = name, arguments = arguments,
    completed = TRUE, elapsedSeconds = proc.time()[[3]] - began)
  value
}
package_dir <- system.file(package = tool)
installed_files <- sort(list.files(package_dir, full.names = TRUE, recursive = TRUE, all.files = TRUE))
installed_files <- installed_files[!file.info(installed_files)$isdir]
installed_hashes <- as.list(setNames(vapply(installed_files, comparator_hash, character(1)), substring(installed_files, nchar(package_dir) + 2)))
package_identity <- digest::digest(installed_hashes, algo = "sha256")
notes <- character()
result <- withCallingHandlers({
  if (tool == "GeneTonic") {
    if (!rmarkdown::pandoc_available()) stop("Native GeneTonic rendering requires pandoc.")
    common <- fixture$matched
    annotation <- data.frame(gene_id = rownames(common$dds), gene_name = rownames(common$dds),
      apeglm_log2FC = common$geneResults$log2FoldChange, apeglm_posterior_SD = common$geneResults$lfcSE,
      Wald_statistic = common$geneResults$stat, Wald_pvalue = common$geneResults$pvalue,
      BH_adjusted_Wald_pvalue = common$geneResults$padj, check.names = FALSE)
    enrich <- track("GeneTonic::shake_fgseaResult", list(input = "fixture$matched$enrichment"),
      function() GeneTonic::shake_fgseaResult(common$enrichment))
    selected_sets <- head(enrich$gs_id, 5)
    selected_genes <- head(rownames(common$res)[order(common$res$padj, rownames(common$res), na.last = TRUE)], 5)
    track("GeneTonic::happy_hour", list(input = "fixture$matched", project_id = fixture$id,
      mygenesets = selected_sets, mygenes = selected_genes, mygroup = "group", output_file = basename(report),
      output_format = "html_document", self_contained = TRUE, template = "installed GeneTonic/extdata/cocktail_recipe.Rmd"),
      function() GeneTonic::happy_hour(dds = common$dds, res_de = common$res, res_enrich = enrich,
        annotation_obj = annotation, project_id = fixture$id, mygenesets = selected_sets, mygenes = selected_genes,
        mygroup = "group", output_file = basename(report), output_dir = output, open_after_creating = FALSE,
        output_options = list(self_contained = TRUE, mathjax = NULL),
        ignore_pandoc = rmarkdown::pandoc_version() >= "2.11" && !nzchar(Sys.which("pandoc-citeproc"))))
    document <- xml2::read_html(report)
    if (any(grepl("(^|\\n)## Error( in|:)", xml2::xml_text(xml2::xml_find_all(document, "//pre/code"))))) stop("GeneTonic embedded a failed R chunk.")
    notes <- c(notes, "GeneTonic is an analysis-result consumer. Both named modes use the same captured upstream inference and the native report template with the required bookmark arguments.",
      "The native GeneTonic template computes its aggregate visualization scores and expression transforms.")
    if (rmarkdown::pandoc_version() >= "2.11" && !nzchar(Sys.which("pandoc-citeproc"))) notes <- c(notes, "The supported ignore_pandoc flag permits modern Pandoc with built-in citeproc to pass GeneTonic's legacy executable preflight.")
    list(genes = common$geneResults, pathways = common$enrichment, selectedGenes = selected_genes, selectedPathways = selected_sets,
      settings = common$settings, upstreamMode = "frozen-matched-inference")
  } else {
    if (mode == "matched") {
      de <- fixture$matched$geneResults
      enrichment <- fixture$matched$enrichment
      settings <- fixture$matched$settings
      upstream_mode <- "frozen-matched-inference"
    } else {
      de <- track("RNAmel::run_deseq2", list(counts = "fixture$counts", metadata = "fixture$metadata",
        design = deparse(fixture$design), contrast = fixture$contrast, otherArguments = "installed API defaults"),
        function() RNAmel::run_deseq2(counts, metadata, design = fixture$design, contrast = fixture$contrast))
      set.seed(fixture$config$seed)
      enrichment <- track("RNAmel::run_gsea", list(results = "RNAmel::run_deseq2", gene_sets = "fixture$pathways", otherArguments = "installed API defaults"),
        function() RNAmel::run_gsea(de, fixture$pathways))
      settings <- list(de = lapply(formals(RNAmel::run_deseq2), deparse), gsea = lapply(formals(RNAmel::run_gsea), deparse),
        actualShrinkage = attr(de, "shrink"), design = deparse(fixture$design), contrast = fixture$contrast, seed = fixture$config$seed,
        parallelBackend = "BiocParallel::SerialParam")
      upstream_mode <- "native-RNAmel-default-analysis"
    }
    store <- track("RNAmel::contrast_store_upsert", list(contrast = "B_vs_A", designFormula = deparse(fixture$design)),
      function() RNAmel::contrast_store_upsert(list(), "B_vs_A", de,
        params = list(design_var = "group", design_formula = deparse(fixture$design), contrast = fixture$contrast)))
    project <- track("RNAmel::assemble_project", list(id = fixture$id, organism = "human", counts = "fixture$counts", metadata = "fixture$metadata", enrichment = "captured results"),
      function() RNAmel::assemble_project(fixture$id, organism = "human", counts = counts, metadata = metadata,
        contrasts = store, settings = list(enrichment = list(results = enrichment))))
    track("RNAmel::build_report_html", list(project = "assembled native project", title = paste("Comparator", fixture$id)),
      function() RNAmel::build_report_html(project, report, title = paste("Comparator", fixture$id)))
    saveRDS(project, file.path(output, "project.rds"))
    writeLines(RNAmel::generate_r_script(project), file.path(output, "native-generated-script.R"))
    selected_genes <- head(de$gene[order(de$padj, de$gene, na.last = TRUE)], 5)
    selected_sets <- head(enrichment$pathway[order(enrichment$padj, enrichment$pathway, na.last = TRUE)], 5)
    notes <- c(notes, "The installed RNAmel report renderer exposes its native overview, differential-expression plots and generated script. Companion result tables retain complete numerical output.")
    list(genes = de, pathways = enrichment, selectedGenes = selected_genes, selectedPathways = selected_sets,
      settings = settings, upstreamMode = upstream_mode)
  }
}, warning = function(warning) {
  captured_warnings <<- c(captured_warnings, conditionMessage(warning))
})
write_comparator_table(result$genes, file.path(output, "gene_statistics.tsv"))
write_comparator_table(result$pathways, file.path(output, "pathway_statistics.tsv"))
jsonlite::write_json(calls, file.path(output, "native-api-calls.json"), auto_unbox = TRUE, pretty = TRUE, digits = NA)
if (!identical(comparator_hash(fixture_file), fixture_hash)) stop("Input fixture changed during comparator execution.")
api_names <- unique(sub(".*::", "", vapply(calls, `[[`, character(1), "functionName")))
api_hashes <- as.list(setNames(vapply(api_names, function(name) digest::digest(getExportedValue(tool, name), algo = "sha256"), character(1)), api_names))
artifacts <- list.files(output, pattern = "\\.(html|tsv|R|rds|json)$", full.names = TRUE)
artifacts <- artifacts[basename(artifacts) != "metrics.json"]
metrics <- list(schemaVersion = 2L, tool = tool, version = as.character(utils::packageVersion(tool)),
  sourceCommit = utils::packageDescription(tool)$RemoteSha, installedPackageSha256 = package_identity,
  installedPackageFiles = installed_hashes, publicApiSha256 = api_hashes,
  mode = mode, upstreamMode = result$upstreamMode, fixture = fixture$id, dataOrigin = fixture$dataOrigin,
  identifierType = fixture$identifierType, fixtureSha256 = fixture_hash, fixtureReceiptSha256 = comparator_hash(paste0(fixture_file, ".json")),
  fixtureSources = fixture$sources, matchedSettings = fixture$matched$settings, actualSettings = result$settings,
  selectedGenes = result$selectedGenes, selectedPathways = result$selectedPathways,
  genes = nrow(result$genes), pathways = nrow(result$pathways), samples = ncol(counts),
  completed = file.exists(report), elapsedSeconds = proc.time()[[3]] - started,
  reportBytes = unname(file.info(report)$size), reportPath = report, peakMemoryBytes = NULL,
  manualSteps = list(scope = "Native API execution after fixture preparation and package installation", observedInterventions = 0L,
    interactivePrompts = 0L, deterministicApiCalls = length(calls), humanOperatorTimeSeconds = NULL),
  offlineBrowserVerified = FALSE, warnings = unique(captured_warnings),
  artifacts = lapply(artifacts, function(file) list(path = basename(file), sha256 = comparator_hash(file), bytes = unname(file.info(file)$size))),
  notes = c(notes, "Each cell is one observed execution; elapsed time and memory are descriptive workload measurements."),
  sessionInfo = capture.output(sessionInfo()))
jsonlite::write_json(metrics, file.path(output, "metrics.json"), pretty = TRUE, auto_unbox = TRUE, digits = NA, na = "null", null = "null")
cat("Comparator completed:", tool, mode, basename(report), "\n")
