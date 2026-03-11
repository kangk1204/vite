#!/usr/bin/env Rscript

suppressPackageStartupMessages({
  library(data.table)
  library(DESeq2)
  library(fgsea)
  library(ggplot2)
  library(ggrepel)
  library(jsonlite)
  library(patchwork)
  library(pheatmap)
  library(writexl)
})

dir.create("data/raw", recursive = TRUE, showWarnings = FALSE)
dir.create("data/processed", recursive = TRUE, showWarnings = FALSE)
dir.create("results", recursive = TRUE, showWarnings = FALSE)
dir.create("figures", recursive = TRUE, showWarnings = FALSE)

counts_path <- "data/raw/GSE121212_readcount.txt.gz"
series_path <- "data/raw/GSE121212_series_matrix.txt.gz"
reactome_zip <- ".cache/reference/ReactomePathways.gmt.zip"

download_if_missing <- function(url, path) {
  if (!file.exists(path)) {
    download.file(url, path, mode = "wb", quiet = FALSE)
  }
}

download_if_missing(
  "https://www.ncbi.nlm.nih.gov/geo/download/?acc=GSE121212&file=GSE121212_readcount.txt.gz&format=file",
  counts_path
)
download_if_missing(
  "https://ftp.ncbi.nlm.nih.gov/geo/series/GSE121nnn/GSE121212/matrix/GSE121212_series_matrix.txt.gz",
  series_path
)

parse_sample_metadata <- function(sample_names) {
  parts <- tstrsplit(sample_names, "_", fixed = TRUE)
  disease <- parts[[1]]
  patient_id <- ifelse(disease == "CTRL", sample_names, paste(parts[[1]], parts[[2]], sep = "_"))
  tissue <- vapply(sample_names, function(x) {
    pieces <- strsplit(x, "_", fixed = TRUE)[[1]]
    if (pieces[1] == "CTRL") {
      return("healthy")
    }
    paste(pieces[-c(1, 2)], collapse = "_")
  }, character(1))
  state <- ifelse(
    tissue %in% c("lesional", "chronic_lesion"),
    "lesional",
    ifelse(tissue == "non-lesional", "nonlesional", ifelse(tissue == "healthy", "healthy", tissue))
  )
  data.frame(
    sample = sample_names,
    disease = disease,
    patient_id = patient_id,
    tissue = tissue,
    state = state,
    group = paste(disease, state, sep = "_"),
    stringsAsFactors = FALSE
  )
}

read_reactome_pathways <- function(zip_path) {
  lines <- readLines(unz(zip_path, "ReactomePathways.gmt"))
  pathways <- lapply(lines, function(line) {
    fields <- strsplit(line, "\t", fixed = TRUE)[[1]]
    genes <- unique(fields[-c(1, 2)])
    genes[genes != ""]
  })
  names(pathways) <- vapply(lines, function(line) {
    fields <- strsplit(line, "\t", fixed = TRUE)[[1]]
    paste(fields[2], fields[1], sep = " :: ")
  }, character(1))
  pathways
}

make_volcano <- function(res_df, output_stub, title_text, label_candidates) {
  plot_df <- copy(res_df)
  plot_df[, neglog10_padj := -log10(pmax(padj, 1e-300))]
  plot_df[, direction := fifelse(padj < 0.05 & log2FoldChange > 1, "Up", fifelse(padj < 0.05 & log2FoldChange < -1, "Down", "NS"))]
  label_df <- plot_df[gene %in% label_candidates | rank(-neglog10_padj * abs(log2FoldChange), ties.method = "first") <= 15]

  p <- ggplot(plot_df, aes(log2FoldChange, neglog10_padj, color = direction)) +
    geom_point(alpha = 0.65, size = 1.6) +
    scale_color_manual(values = c(Down = "#1f77b4", NS = "#c7ced8", Up = "#d62728")) +
    geom_vline(xintercept = c(-1, 1), linetype = "dashed", color = "#6b7a90", linewidth = 0.4) +
    geom_hline(yintercept = -log10(0.05), linetype = "dashed", color = "#6b7a90", linewidth = 0.4) +
    geom_text_repel(
      data = label_df,
      aes(label = gene),
      size = 3.2,
      max.overlaps = 30,
      box.padding = 0.35,
      point.padding = 0.15,
      segment.color = "#94a3b8"
    ) +
    labs(
      title = title_text,
      x = "log2 fold-change",
      y = expression(-log[10]("FDR")),
      color = NULL
    ) +
    theme_minimal(base_size = 12) +
    theme(
      panel.grid.minor = element_blank(),
      legend.position = "top",
      plot.title = element_text(face = "bold")
    )

  ggsave(sprintf("figures/%s.pdf", output_stub), p, width = 7.2, height = 5.2)
  ggsave(sprintf("figures/%s.png", output_stub), p, width = 7.2, height = 5.2, dpi = 320)
}

make_pathway_dotplot <- function(gsea_df, output_stub, title_text) {
  plot_df <- copy(gsea_df[!is.na(padj)])
  plot_df[, size_metric := pmin(-log10(pmax(padj, 1e-300)), 12)]
  plot_df[, direction := ifelse(NES >= 0, "Enriched in psoriasis lesion", "Depleted in psoriasis lesion")]
  plot_df <- rbind(
    plot_df[NES > 0][order(padj, -NES)][1:10],
    plot_df[NES < 0][order(padj, NES)][1:10]
  )
  plot_df[, pathway := factor(pathway, levels = rev(pathway))]
  plot_height <- max(6.4, 0.34 * nrow(plot_df) + 0.8)

  p <- ggplot(plot_df, aes(NES, pathway, size = size_metric, color = direction)) +
    geom_point(alpha = 0.88, stroke = 0.35) +
    scale_color_manual(values = c("Enriched in psoriasis lesion" = "#c026d3", "Depleted in psoriasis lesion" = "#0284c7")) +
    scale_size_continuous(
      range = c(2.6, 7.8),
      breaks = c(2, 4, 6, 8, 10, 12),
      limits = c(0, 12),
      name = expression(-log[10]("FDR"))
    ) +
    labs(title = title_text, x = "Normalized enrichment score", y = NULL, size = expression(-log[10]("FDR")), color = NULL) +
    theme_minimal(base_size = 12) +
    theme(
      panel.grid.minor = element_blank(),
      legend.position = "top",
      plot.title = element_text(face = "bold")
    )

  ggsave(sprintf("figures/%s.pdf", output_stub), p, width = 8.2, height = plot_height)
  ggsave(sprintf("figures/%s.png", output_stub), p, width = 8.2, height = plot_height, dpi = 320)
}

counts <- fread(counts_path)
gene_col <- names(counts)[1]
setnames(counts, gene_col, "gene")
counts <- counts[gene != ""]
counts <- counts[!duplicated(gene)]
count_matrix <- as.matrix(counts[, -"gene"])
rownames(count_matrix) <- counts$gene
storage.mode(count_matrix) <- "integer"

sample_md <- parse_sample_metadata(colnames(count_matrix))
fwrite(sample_md, "results/gse121212_sample_metadata.tsv", sep = "\t")

psoriasis_vs_ctrl_md <- sample_md[sample_md$group %in% c("PSO_lesional", "CTRL_healthy"), ]
psoriasis_vs_ctrl_counts <- count_matrix[, psoriasis_vs_ctrl_md$sample]
psoriasis_vs_ctrl_md$group <- factor(psoriasis_vs_ctrl_md$group, levels = c("CTRL_healthy", "PSO_lesional"))
rownames(psoriasis_vs_ctrl_md) <- psoriasis_vs_ctrl_md$sample

dds <- DESeqDataSetFromMatrix(
  countData = psoriasis_vs_ctrl_counts,
  colData = psoriasis_vs_ctrl_md,
  design = ~ group
)
keep <- rowSums(counts(dds) >= 10) >= ceiling(0.15 * ncol(dds))
dds <- dds[keep, ]
dds <- DESeq(dds, quiet = TRUE)
res <- results(dds, contrast = c("group", "PSO_lesional", "CTRL_healthy"))
res <- lfcShrink(dds, coef = "group_PSO_lesional_vs_CTRL_healthy", res = res, type = "normal")
res_df <- as.data.table(as.data.frame(res), keep.rownames = "gene")
res_df <- res_df[order(padj, -abs(log2FoldChange))]
fwrite(res_df, "results/psoriasis_lesional_vs_healthy_deseq2.tsv", sep = "\t")

vsd <- vst(dds, blind = FALSE)
pca_df <- plotPCA(vsd, intgroup = "group", returnData = TRUE)
pca_df$sample <- rownames(pca_df)
pca_plot <- ggplot(pca_df, aes(PC1, PC2, color = group)) +
  geom_point(size = 3.2, alpha = 0.9) +
  stat_ellipse(type = "norm", linewidth = 0.5, alpha = 0.15) +
  scale_color_manual(values = c("CTRL_healthy" = "#0ea5e9", "PSO_lesional" = "#d946ef")) +
  labs(
    title = "Psoriasis lesional skin separates from healthy control skin",
    x = sprintf("PC1 (%.1f%%)", attr(pca_df, "percentVar")[1] * 100),
    y = sprintf("PC2 (%.1f%%)", attr(pca_df, "percentVar")[2] * 100),
    color = NULL
  ) +
  theme_minimal(base_size = 12) +
  theme(panel.grid.minor = element_blank(), legend.position = "top", plot.title = element_text(face = "bold"))
ggsave("figures/figure1_pca_psoriasis_vs_healthy.pdf", pca_plot, width = 6.8, height = 5.2)
ggsave("figures/figure1_pca_psoriasis_vs_healthy.png", pca_plot, width = 6.8, height = 5.2, dpi = 320)

reactome <- read_reactome_pathways(reactome_zip)
ranked_stats <- res_df[!is.na(stat)][order(-stat)]$stat
names(ranked_stats) <- res_df[!is.na(stat)][order(-stat)]$gene
gsea_res <- as.data.table(fgseaMultilevel(pathways = reactome, stats = ranked_stats, minSize = 15, maxSize = 500))
gsea_res[, leadingEdge := vapply(leadingEdge, function(x) paste(x, collapse = ";"), character(1))]
gsea_res[, pathway_id := sub(" :: .*", "", pathway)]
gsea_res[, pathway_name := sub("^.* :: ", "", pathway)]
gsea_res <- gsea_res[order(padj, -NES)]
fwrite(gsea_res, "results/psoriasis_lesional_vs_healthy_fgsea_reactome.tsv", sep = "\t")

paired_md <- sample_md[sample_md$disease == "PSO" & sample_md$state %in% c("lesional", "nonlesional"), ]
paired_counts <- count_matrix[, paired_md$sample]
patient_counts <- table(paired_md$patient_id)
paired_md <- paired_md[paired_md$patient_id %in% names(patient_counts[patient_counts == 2]), ]
paired_counts <- paired_counts[, paired_md$sample]
paired_md$patient_id <- factor(paired_md$patient_id)
paired_md$state <- factor(paired_md$state, levels = c("nonlesional", "lesional"))
rownames(paired_md) <- paired_md$sample

dds_paired <- DESeqDataSetFromMatrix(
  countData = paired_counts,
  colData = paired_md,
  design = ~ patient_id + state
)
keep_paired <- rowSums(counts(dds_paired) >= 10) >= ceiling(0.15 * ncol(dds_paired))
dds_paired <- dds_paired[keep_paired, ]
dds_paired <- DESeq(dds_paired, quiet = TRUE)
res_paired <- results(dds_paired, contrast = c("state", "lesional", "nonlesional"))
res_paired <- lfcShrink(dds_paired, coef = "state_lesional_vs_nonlesional", res = res_paired, type = "normal")
res_paired_df <- as.data.table(as.data.frame(res_paired), keep.rownames = "gene")
res_paired_df <- res_paired_df[order(padj, -abs(log2FoldChange))]
fwrite(res_paired_df, "results/psoriasis_lesional_vs_nonlesional_paired_deseq2.tsv", sep = "\t")

ranked_paired <- res_paired_df[!is.na(stat)][order(-stat)]$stat
names(ranked_paired) <- res_paired_df[!is.na(stat)][order(-stat)]$gene
gsea_paired <- as.data.table(fgseaMultilevel(pathways = reactome, stats = ranked_paired, minSize = 15, maxSize = 500))
gsea_paired[, leadingEdge := vapply(leadingEdge, function(x) paste(x, collapse = ";"), character(1))]
gsea_paired[, pathway_id := sub(" :: .*", "", pathway)]
gsea_paired[, pathway_name := sub("^.* :: ", "", pathway)]
gsea_paired <- gsea_paired[order(padj, -NES)]
fwrite(gsea_paired, "results/psoriasis_lesional_vs_nonlesional_fgsea_reactome.tsv", sep = "\t")

top_labels <- c("IL17A", "IL36G", "CXCL8", "CXCL1", "S100A7", "DEFB4A", "KRT16", "SERPINB4", "IFI27")
make_volcano(
  res_df,
  "figure2_volcano_psoriasis_vs_healthy",
  "Differential expression in psoriasis lesions versus healthy skin",
  top_labels
)

make_pathway_dotplot(
  gsea_res[, .(pathway = pathway_name, NES, padj)],
  "figure3_reactome_fgsea_psoriasis_vs_healthy",
  "Reactome pathways altered in psoriasis lesions"
)

shared_pathways <- merge(
  gsea_res[, .(pathway_name, NES_healthy = NES, padj_healthy = padj)],
  gsea_paired[, .(pathway_name, NES_paired = NES, padj_paired = padj)],
  by = "pathway_name"
)
shared_pathways[, category := ifelse(padj_healthy < 0.05 & padj_paired < 0.05, "significant in both", "other")]
concordance_plot <- ggplot(shared_pathways, aes(NES_healthy, NES_paired, color = category)) +
  geom_point(alpha = 0.75, size = 1.8) +
  geom_vline(xintercept = 0, linetype = "dashed", color = "#94a3b8", linewidth = 0.4) +
  geom_hline(yintercept = 0, linetype = "dashed", color = "#94a3b8", linewidth = 0.4) +
  scale_color_manual(values = c("other" = "#cbd5e1", "significant in both" = "#7c3aed")) +
  labs(
    title = "Pathway shifts are concordant in lesion-vs-healthy and lesion-vs-uninvolved contrasts",
    x = "NES (lesion vs healthy)",
    y = "NES (lesion vs non-lesional)",
    color = NULL
  ) +
  theme_minimal(base_size = 12) +
  theme(panel.grid.minor = element_blank(), legend.position = "top", plot.title = element_text(face = "bold"))
ggsave("figures/figure4_pathway_concordance.pdf", concordance_plot, width = 6.5, height = 5.4)
ggsave("figures/figure4_pathway_concordance.png", concordance_plot, width = 6.5, height = 5.4, dpi = 320)

top_pathways <- gsea_res[padj < 0.05][order(padj, -NES)][1:40]
gene_table <- res_df[, .(
  gene_symbol = gene,
  log2fc = log2FoldChange,
  padj = padj,
  pvalue = pvalue,
  rank_metric = stat,
  condition_a_mean = rowMeans(counts(dds, normalized = TRUE)[gene, psoriasis_vs_ctrl_md$group == "CTRL_healthy", drop = FALSE]),
  condition_b_mean = rowMeans(counts(dds, normalized = TRUE)[gene, psoriasis_vs_ctrl_md$group == "PSO_lesional", drop = FALSE])
)]

pathway_table <- top_pathways[, .(
  pathway_id = pathway_id,
  pathway_name = pathway_name,
  collection = "Reactome",
  nes = NES,
  padj = padj,
  leading_edge_genes = leadingEdge
)]

project_table <- data.frame(
  project_title = "Psoriasis lesional versus healthy skin",
  contrast_name = "PSO_lesional_vs_CTRL_healthy",
  condition_a = "Healthy skin",
  condition_b = "Psoriasis lesion",
  species = "human",
  stringsAsFactors = FALSE
)

write_xlsx(
  list(
    Project = project_table,
    Genes = gene_table,
    Pathways = pathway_table
  ),
  "results/psoriasis_pathway_viewer_input.xlsx"
)

summary_table <- data.table(
  metric = c(
    "total_samples",
    "psoriasis_lesional_samples",
    "healthy_control_samples",
    "paired_psoriasis_samples",
    "tested_genes_primary",
    "DEGs_FDR_lt_0.05_absLFC_gt_1",
    "Reactome_pathways_FDR_lt_0.05",
    "Top_up_pathway",
    "Top_down_pathway"
  ),
  value = c(
    nrow(sample_md),
    sum(psoriasis_vs_ctrl_md$group == "PSO_lesional"),
    sum(psoriasis_vs_ctrl_md$group == "CTRL_healthy"),
    nrow(paired_md),
    nrow(res_df),
    sum(res_df$padj < 0.05 & abs(res_df$log2FoldChange) > 1, na.rm = TRUE),
    sum(gsea_res$padj < 0.05, na.rm = TRUE),
    gsea_res[order(padj, -NES)][NES > 0][1]$pathway_name,
    gsea_res[order(padj, NES)][NES < 0][1]$pathway_name
  )
)
fwrite(summary_table, "results/analysis_summary.tsv", sep = "\t")
