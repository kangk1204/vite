#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(data.table)
  library(DESeq2)
  library(fgsea)
  library(ggplot2)
  library(ggrepel)
  library(jsonlite)
  library(writexl)
})

`%||%` <- function(value, fallback) {
  if (is.null(value) || length(value) == 0) {
    return(fallback)
  }
  if (length(value) == 1 && is.na(value)) {
    return(fallback)
  }
  value
}

source("scripts/lib/analysis_core.R")
source("scripts/lib/analysis_io.R")

download_if_missing <- function(url, path) {
  if (!file.exists(path)) {
    dir.create(dirname(path), recursive = TRUE, showWarnings = FALSE)
    if (is.null(url) || !nzchar(url)) stop(sprintf("Required input is missing: %s", path))
    download.file(url, path, mode = "wb", quiet = FALSE)
  }
}

strip_quotes <- function(value) {
  cleaned <- trimws(as.character(value %||% ""))
  if (grepl('^".*"$', cleaned)) {
    cleaned <- substring(cleaned, 2, nchar(cleaned) - 1)
  }
  gsub('""', '"', cleaned, fixed = TRUE)
}

sanitize_name <- function(value) {
  cleaned <- tolower(gsub("[^A-Za-z0-9]+", "_", value))
  cleaned <- gsub("_+", "_", cleaned)
  cleaned <- gsub("^_|_$", "", cleaned)
  if (!nzchar(cleaned)) {
    return("value")
  }
  cleaned
}

normalize_sample_key <- function(value) {
  cleaned <- tolower(gsub("[^A-Za-z0-9]+", "", strip_quotes(value)))
  cleaned
}

read_lines_maybe_gzip <- function(path) {
  connection <- if (grepl("\\.gz$", path, ignore.case = TRUE)) gzfile(path, "rt") else file(path, "rt")
  on.exit(close(connection), add = TRUE)
  readLines(connection, warn = FALSE)
}

parse_characteristic_entry <- function(value) {
  cleaned <- strip_quotes(value)
  if (!nzchar(cleaned)) {
    return(list(key = "", value = NA_character_))
  }
  if (!grepl(":", cleaned, fixed = TRUE)) {
    return(list(key = "", value = cleaned))
  }
  key <- trimws(sub(":.*$", "", cleaned))
  parsed_value <- trimws(sub("^[^:]+:", "", cleaned))
  list(key = key, value = parsed_value)
}

parse_series_matrix <- function(path) {
  lines <- read_lines_maybe_gzip(path)
  sample_ids <- NULL
  sample_titles <- NULL
  sample_columns <- list()
  characteristic_rows <- list()

  for (line in lines) {
    if (!startsWith(line, "!Sample_")) {
      next
    }
    fields <- strsplit(line, "\t", fixed = TRUE)[[1]]
    if (length(fields) < 2) {
      next
    }
    key <- sub("^!Sample_", "", fields[[1]])
    values <- vapply(fields[-1], strip_quotes, character(1))

    if (key == "geo_accession") {
      sample_ids <- values
      next
    }
    if (key == "title") {
      sample_titles <- values
      next
    }
    if (key == "characteristics_ch1") {
      characteristic_rows[[length(characteristic_rows) + 1]] <- values
      next
    }
    sample_columns[[key]] <- values
  }

  if (is.null(sample_ids) || !length(sample_ids)) {
    stop("Series matrix is missing !Sample_geo_accession entries.")
  }
  if (anyDuplicated(sample_ids)) stop("Duplicate GEO sample identifiers in series metadata.")

  if (is.null(sample_titles) || length(sample_titles) != length(sample_ids)) {
    sample_titles <- sample_ids
  }

  sample_md <- data.table(
    sample = sample_ids,
    title = sample_titles,
    title_clean = gsub("\\s*\\[[^]]+\\]$", "", sample_titles),
    title_compact = gsub("\\s+", " ", gsub("\\s*\\[[^]]+\\]$", "", sample_titles))
  )

  for (column_name in names(sample_columns)) {
    values <- sample_columns[[column_name]]
    if (length(values) != nrow(sample_md)) {
      next
    }
    safe_name <- sanitize_name(column_name)
    if (safe_name == "source_name_ch1") {
      safe_name <- "source_name"
    }
    sample_md[[safe_name]] <- values
  }

  used_names <- names(sample_md)
  for (index in seq_along(characteristic_rows)) {
    values <- characteristic_rows[[index]]
    if (length(values) != nrow(sample_md)) {
      next
    }
    parsed <- lapply(values, parse_characteristic_entry)
    inferred_keys <- vapply(parsed, function(entry) entry$key, character(1))
    inferred_key <- inferred_keys[inferred_keys != ""][1] %||% paste0("characteristic_", index)
    safe_name <- sanitize_name(inferred_key)
    if (safe_name %in% used_names) {
      safe_name <- paste0(safe_name, "_", index)
    }
    used_names <- c(used_names, safe_name)
    sample_md[[safe_name]] <- vapply(parsed, function(entry) entry$value %||% NA_character_, character(1))
  }

  sample_md
}

prepare_grouped_metadata <- function(sample_md, cfg) {
  grouped <- copy(sample_md)
  filters <- cfg$includeFilters %||% list()
  if (length(filters)) {
    filters_dt <- as.data.table(filters)
    for (filter_index in seq_len(nrow(filters_dt))) {
      filter <- filters_dt[filter_index]
      source_name <- as.character(filter$source[[1]] %||% "")
      pattern <- as.character(filter$pattern[[1]] %||% "")
      if (!nzchar(source_name) || !nzchar(pattern)) {
        next
      }
      if (!source_name %in% names(grouped)) {
        stop(sprintf("Include filter source column not found: %s", source_name))
      }
      values <- as.character(grouped[[source_name]] %||% "")
      grouped <- grouped[grepl(pattern, values, perl = TRUE)]
    }
  }

  grouped[, contrast_group := NA_character_]

  rules <- as.data.table(cfg$groupRules)
  for (rule_index in seq_len(nrow(rules))) {
    rule <- rules[rule_index]
    source_name <- as.character(rule$source[[1]])
    if (!source_name %in% names(grouped)) {
      stop(sprintf("Grouping source column not found: %s", source_name))
    }
    values <- as.character(grouped[[source_name]] %||% "")
    matches <- grepl(as.character(rule$pattern[[1]]), values, perl = TRUE)
    grouped[is.na(contrast_group) & matches, contrast_group := as.character(rule$group[[1]])]
  }

  grouped <- grouped[!is.na(contrast_group)]
  if (!nrow(grouped)) {
    stop("No samples matched the configured contrast rules.")
  }

  grouped[, group := factor(contrast_group, levels = c("A", "B"))]
  grouped
}

assert_group_balance <- function(sample_md, stage, cfg) {
  min_replicates <- as.integer(cfg$minReplicatesPerGroup %||% 2)
  counts <- table(factor(sample_md$contrast_group, levels = c("A", "B")))
  if (any(counts < min_replicates)) {
    stop(
      sprintf(
        "Configured contrast has too few samples after %s (A=%s, B=%s, required >=%s per group).",
        stage,
        counts[["A"]],
        counts[["B"]],
        min_replicates
      ),
      call. = FALSE
    )
  }
}

coerce_covariates <- function(sample_md, cfg) {
  sample_md <- copy(sample_md)
  covariates <- cfg$numericCovariates %||% character(0)
  if (!length(covariates)) {
    return(sample_md)
  }

  for (field in covariates) {
    if (!field %in% names(sample_md)) {
      stop(sprintf("Configured numeric covariate is missing from metadata: %s", field))
    }
    numeric_values <- suppressWarnings(as.numeric(sample_md[[field]]))
    if (any(!is.finite(numeric_values))) stop(sprintf("Missing/non-finite values in covariate %s; curate exclusions explicitly.", field))
    if (sd(numeric_values, na.rm = TRUE) > 0) {
      numeric_values <- as.numeric(scale(numeric_values))
    } else {
      numeric_values <- numeric_values * 0
    }
    sample_md[[field]] <- numeric_values
  }

  sample_md
}

align_sample_metadata_to_counts <- function(sample_md, count_matrix, cfg) {
  alignment_fields <- cfg$sampleAlignmentFields %||% c("sample", "title_clean", "title_compact", "title")
  raw_sample_ids <- colnames(count_matrix)
  if (anyDuplicated(raw_sample_ids) || anyDuplicated(sample_md$sample)) stop("Duplicate sample identifiers prevent one-to-one alignment.")
  raw_by_exact <- split(raw_sample_ids, raw_sample_ids)
  raw_by_normalized <- split(raw_sample_ids, vapply(raw_sample_ids, normalize_sample_key, character(1)))
  # Four global passes: exact IDs, normalized IDs, exact titles, normalized titles.
  # Resolve a whole tier before the next, so metadata order cannot steal identity.
  ordered_raw_ids <- rep(NA_character_, nrow(sample_md))
  assign_pass <- function(fields, normalized = FALSE) {
    proposed <- ordered_raw_ids
    reserved <- ordered_raw_ids[!is.na(ordered_raw_ids)]
    for (row_index in which(is.na(ordered_raw_ids))) {
      for (field in fields) {
        if (!field %in% names(sample_md)) next
        value <- as.character(sample_md[[field]][row_index] %||% "")
        if (is.na(value) || !nzchar(value)) next
        candidates <- if (normalized) raw_by_normalized[[normalize_sample_key(value)]] else raw_by_exact[[value]]
        if (!length(candidates)) next
        if (any(candidates %in% reserved)) {
          stop(sprintf("Sample %s fallback collides with a reserved sample identifier; curate the mapping explicitly.", sample_md$sample[row_index]))
        }
        if (length(candidates) != 1L) stop(sprintf("Ambiguous count-column match for sample %s.", sample_md$sample[row_index]))
        proposed[row_index] <- candidates[[1]]
        break
      }
    }
    if (anyDuplicated(proposed[!is.na(proposed)])) stop("Multiple samples claim the same count column; curate the mapping explicitly.")
    proposed
  }
  ordered_raw_ids <- assign_pass("sample", FALSE)
  ordered_raw_ids <- assign_pass("sample", TRUE)
  title_fields <- setdiff(alignment_fields, "sample")
  ordered_raw_ids <- assign_pass(title_fields, FALSE)
  ordered_raw_ids <- assign_pass(title_fields, TRUE)
  if (anyNA(ordered_raw_ids)) {
    stop(sprintf("Could not uniquely align included sample(s): %s", paste(sample_md$sample[is.na(ordered_raw_ids)], collapse = ", ")))
  }
  if (anyDuplicated(ordered_raw_ids)) stop("Multiple samples claim the same fallback count column; curate the mapping explicitly.")
  matched_rows <- seq_len(nrow(sample_md))

  aligned_md <- copy(sample_md[matched_rows])
  aligned_md[, count_sample_id := ordered_raw_ids]
  setcolorder(aligned_md, c("count_sample_id", setdiff(names(aligned_md), "count_sample_id")))
  list(sample_md = aligned_md, count_ids = ordered_raw_ids)
}

make_pca_plot <- function(vsd, sample_md, output_stub, title_text, config) {
  pca_df <- plotPCA(vsd, intgroup = "group", returnData = TRUE)
  pca_df$sample <- rownames(pca_df)
  group_counts <- table(pca_df$group)
  plot <- ggplot(pca_df, aes(PC1, PC2, color = group)) +
    geom_point(size = 3.1, alpha = 0.9)
  if (length(group_counts) > 0 && all(group_counts >= 4)) {
    plot <- plot +
      stat_ellipse(type = "norm", linewidth = 0.5, alpha = 0.15)
  }
  plot <- plot +
    scale_color_manual(
      values = c("A" = "#0ea5e9", "B" = "#d946ef"),
      labels = setNames(c(config$conditionA, config$conditionB), c("A", "B"))
    ) +
    labs(
      title = title_text,
      x = sprintf("PC1 (%.1f%%)", attr(pca_df, "percentVar")[1] * 100),
      y = sprintf("PC2 (%.1f%%)", attr(pca_df, "percentVar")[2] * 100),
      color = NULL
    ) +
    theme_minimal(base_size = 12) +
    theme(panel.grid.minor = element_blank(), legend.position = "top", plot.title = element_text(face = "bold"))
  ggsave(sprintf("figures/%s.pdf", output_stub), plot, width = 6.8, height = 5.2)
  ggsave(sprintf("figures/%s.png", output_stub), plot, width = 6.8, height = 5.2, dpi = 320)
}

write_empty_analysis_figure <- function(output_stub, title_text, reason) {
  plot <- ggplot() +
    annotate("text", x = 0.5, y = 0.5, label = reason, size = 4.5, color = "#334155") +
    xlim(0, 1) + ylim(0, 1) + labs(title = title_text) +
    theme_void(base_size = 12) + theme(plot.title = element_text(face = "bold", hjust = 0.5),
      plot.background = element_rect(fill = "white", color = NA))
  ggsave(sprintf("figures/%s.pdf", output_stub), plot, width = 7.2, height = 5.2)
  ggsave(sprintf("figures/%s.png", output_stub), plot, width = 7.2, height = 5.2, dpi = 320)
  invisible(NULL)
}

make_volcano_plot <- function(res_df, output_stub, title_text, config) {
  plot_df <- copy(res_df)
  plot_df[, neglog10_padj := -log10(pmax(padj, 1e-300))]
  plot_df <- plot_df[
    is.finite(log2FoldChange) &
      !is.na(neglog10_padj) &
      is.finite(neglog10_padj)
  ]
  if (!nrow(plot_df)) {
    return(write_empty_analysis_figure(output_stub, title_text,
      "No finite differential-expression statistics are available.\nNo significant result is implied."))
  }
  plot_df[, direction := fifelse(
    padj < 0.05 & log2FoldChange > 1,
    sprintf("Higher in %s", config$conditionB),
    fifelse(
      padj < 0.05 & log2FoldChange < -1,
      sprintf("Higher in %s", config$conditionA),
      "NS"
    )
  )]
  label_df <- plot_df[!is.na(padj)][order(padj, -abs(log2FoldChange))][1:min(15, .N)]

  plot <- ggplot(plot_df, aes(log2FoldChange, neglog10_padj, color = direction)) +
    geom_point(alpha = 0.68, size = 1.6) +
    geom_vline(xintercept = c(-1, 1), linetype = "dashed", color = "#6b7a90", linewidth = 0.4) +
    geom_hline(yintercept = -log10(0.05), linetype = "dashed", color = "#6b7a90", linewidth = 0.4) +
    geom_text_repel(
      data = label_df,
      aes(label = gene),
      size = 3.1,
      max.overlaps = 30,
      box.padding = 0.35,
      point.padding = 0.15,
      segment.color = "#94a3b8"
    ) +
    scale_color_manual(values = setNames(
      c("#c7ced8", "#0284c7", "#c026d3"),
      c("NS", sprintf("Higher in %s", config$conditionA), sprintf("Higher in %s", config$conditionB))
    )) +
    labs(title = title_text, x = "log2 fold-change", y = expression(-log[10]("FDR")), color = NULL) +
    theme_minimal(base_size = 12) +
    theme(panel.grid.minor = element_blank(), legend.position = "top", plot.title = element_text(face = "bold"))

  ggsave(sprintf("figures/%s.pdf", output_stub), plot, width = 7.2, height = 5.2)
  ggsave(sprintf("figures/%s.png", output_stub), plot, width = 7.2, height = 5.2, dpi = 320)
}

make_pathway_dotplot <- function(gsea_df, output_stub, title_text, config) {
  plot_df <- copy(gsea_df[!is.na(padj)])
  plot_df[, size_metric := pmin(-log10(pmax(padj, 1e-300)), 12)]
  plot_df[, direction := ifelse(
    NES >= 0,
    sprintf("Enriched in %s", config$conditionB),
    sprintf("Enriched in %s", config$conditionA)
  )]
  top_up <- head(plot_df[NES > 0][order(padj, -NES)], 10)
  top_down <- head(plot_df[NES < 0][order(padj, NES)], 10)
  plot_df <- rbind(top_up, top_down, fill = TRUE)
  if (!nrow(plot_df)) {
    return(write_empty_analysis_figure(output_stub, title_text,
      "No eligible pathway has a finite directional enrichment result.\nNo significant result is implied."))
  }
  plot_df[, pathway_name := factor(pathway_name, levels = rev(pathway_name))]
  plot_height <- max(6.4, 0.34 * nrow(plot_df) + 0.8)

  plot <- ggplot(plot_df, aes(NES, pathway_name, size = size_metric, color = direction)) +
    geom_point(alpha = 0.88, stroke = 0.35) +
    scale_color_manual(values = setNames(
      c("#0284c7", "#c026d3"),
      c(sprintf("Enriched in %s", config$conditionA), sprintf("Enriched in %s", config$conditionB))
    )) +
    scale_size_continuous(
      range = c(2.6, 7.8),
      breaks = c(2, 4, 6, 8, 10, 12),
      limits = c(0, 12),
      name = expression(-log[10]("FDR"))
    ) +
    labs(title = title_text, x = "Normalized enrichment score", y = NULL, color = NULL) +
    theme_minimal(base_size = 12) +
    theme(panel.grid.minor = element_blank(), legend.position = "top", plot.title = element_text(face = "bold"))

  ggsave(sprintf("figures/%s.pdf", output_stub), plot, width = 8.2, height = plot_height)
  ggsave(sprintf("figures/%s.png", output_stub), plot, width = 8.2, height = plot_height, dpi = 320)
}

run_neural_cohort <- function(config_path) {
  config <- jsonlite::fromJSON(config_path)
  for (directory in c("data/raw", "results", "figures")) dir.create(directory, recursive = TRUE, showWarnings = FALSE)
  download_if_missing(config$rawCountsUrl, config$rawCountsPath)
  download_if_missing(config$seriesMatrixUrl, config$seriesMatrixPath)
  config$runContext <- pnv_capture_run_context(config, config_path, "scripts/analyze_neural_bulk_cohort.R")
  reference_path <- pnv_default(config$referencePath, "data/reference/ReactomePathways.gmt.zip")
  reactome <- pnv_read_pathways(reference_path)
  all_metadata <- parse_series_matrix(config$seriesMatrixPath)
  sample_md <- prepare_grouped_metadata(all_metadata, config)
  assert_group_balance(sample_md, "group assignment", config)
  sample_md <- coerce_covariates(sample_md, config)
  mapped <- pnv_read_counts(config$rawCountsPath, pnv_default(config$geneIdentifierType, "gene_id"),
    pnv_default(config$geneMapPath, "src/reference/generated/ncbi_gene_map.json"),
    pnv_default(config$aliasesPath, "src/reference/generated/aliases.json"))
  alignment <- align_sample_metadata_to_counts(sample_md, mapped$counts, config)
  sample_md <- alignment$sample_md
  assert_group_balance(sample_md, "raw-count alignment", config)
  selected_counts <- mapped$counts[, alignment$count_ids, drop = FALSE]
  model_metadata <- as.data.frame(sample_md)
  model_metadata$geo_sample <- model_metadata$sample
  model_metadata$sample <- model_metadata$count_sample_id
  model_metadata$group <- as.character(model_metadata$contrast_group)
  excluded <- setdiff(all_metadata$sample, sample_md$sample)
  config$excludedSamples <- lapply(excluded, function(id) list(sample = id, reason = "prespecified_cohort_filter_or_group_rules"))
  config$outputDir <- pnv_default(config$outputDir, "results")
  config$bootstrapCheckpointDir <- pnv_default(config$bootstrapCheckpointDir,
    file.path(".cache", "bootstrap", config$resultPrefix))
  result <- pnv_analyze_counts(selected_counts, model_metadata, reactome, config)
  paths <- pnv_write_outputs(result, config, mapped$mapping)
  saveRDS(list(counts = selected_counts, metadata = model_metadata, pathways = reactome,
    config = modifyList(config, list(bootstrapReplicates = 0L)), expected = list(
      genes = result$geneResults, pathways = as.data.frame(result$pathwayResults), camera = result$cameraResults)),
    paths$referenceInput)
  figure_prefix <- config$figurePrefix
  if (!is.null(figure_prefix) && !isFALSE(config$writeFigures)) {
    vsd <- DESeq2::varianceStabilizingTransformation(result$dds, blind = FALSE)
    figure_md <- data.table::as.data.table(result$metadata)
    make_pca_plot(vsd, figure_md, paste0(figure_prefix, "_pca"),
      config$figureTitles$pca %||% paste(config$projectTitle, "PCA"), config)
    make_volcano_plot(data.table::as.data.table(result$geneResults), paste0(figure_prefix, "_volcano"),
      config$figureTitles$volcano %||% paste(config$projectTitle, "differential expression"), config)
    make_pathway_dotplot(data.table::as.data.table(pnv_pathway_table(result)), paste0(figure_prefix, "_pathway_dotplot"),
      config$figureTitles$pathway %||% paste(config$projectTitle, "Reactome pathways"), config)
  }
  message(sprintf("Completed cohort analysis: %s (%d genes, %d eligible pathways)",
    config$cohortKey, nrow(result$geneResults), nrow(result$pathwayResults)))
  invisible(paths)
}

if (sys.nframe() == 0L) {
  args <- commandArgs(trailingOnly = TRUE)
  if (length(args) != 1L) stop("Usage: Rscript scripts/analyze_neural_bulk_cohort.R <config.json>", call. = FALSE)
  run_neural_cohort(args[[1]])
}
