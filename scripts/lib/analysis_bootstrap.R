# Resampling describes this dataset and procedure, never external replication probability.
pnv_summarize_bootstrap <- function(pathway_ids, reference_nes, repetitions, requested, alpha) {
  summaries <- lapply(seq_along(pathway_ids), function(index) {
    id <- pathway_ids[[index]]
    rows <- lapply(repetitions, function(result) {
      if (is.null(result)) return(NULL)
      row <- result[result$pathway == id, , drop = FALSE]
      if (nrow(row) != 1 || !is.finite(row$NES) || !is.finite(row$padj)) return(NULL)
      row
    })
    valid <- Filter(Negate(is.null), rows)
    n <- length(valid)
    selected <- sum(vapply(valid, function(row) row$padj < alpha, logical(1)))
    direction_matches <- if (is.finite(reference_nes[[index]])) {
      sum(vapply(valid, function(row) sign(row$NES) == sign(reference_nes[[index]]), logical(1)))
    } else NA_integer_
    fraction <- if (requested > 0) n / requested else NA_real_
    list(requested = requested, valid = n, selected = selected, directionMatches = direction_matches,
      selectionFrequency = if (n) selected / n else NA_real_,
      directionConsistency = if (n && !is.na(direction_matches)) direction_matches / n else NA_real_,
      validFraction = fraction,
      warning = if (is.na(fraction) || fraction < 0.9) "Fewer than 90% of requested replicates were testable for this pathway." else NULL)
  })
  stats::setNames(summaries, pathway_ids)
}

pnv_resample_indices <- function(metadata, unit_column = NULL) {
  if (!is.null(unit_column)) {
    if (!unit_column %in% names(metadata) || anyNA(metadata[[unit_column]])) {
      stop("Bootstrap unit column is missing or incomplete.", call. = FALSE)
    }
    units <- split(seq_len(nrow(metadata)), metadata[[unit_column]])
    paired <- vapply(units, function(rows) all(c("A", "B") %in% metadata$group[rows]), logical(1))
    if (!all(paired)) stop("Cluster bootstrap requires every declared paired unit to contain both groups.", call. = FALSE)
    picked <- sample(seq_along(units), length(units), replace = TRUE)
    return(unlist(units[picked], use.names = FALSE))
  }
  unlist(lapply(c("A", "B"), function(group) {
    rows <- which(metadata$group == group)
    sample(rows, length(rows), replace = TRUE)
  }), use.names = FALSE)
}

pnv_bootstrap_pathways <- function(counts, metadata, pathways, config, reference) {
  settings <- pnv_settings(config)
  requested <- as.integer(settings$bootstrapReplicates)
  if (!requested) return(list(requested = 0L, completed = 0L, failures = list(), pathways = list()))
  validated <- pnv_validate_inputs(counts, metadata, config)
  metadata <- validated$metadata
  restore_rng <- pnv_seed_scope(settings$seed)
  on.exit(restore_rng(), add = TRUE)
  pnv_require(c("digest", "DESeq2", "fgsea"))
  fingerprint_settings <- settings
  fingerprint_settings$bootstrapReplicates <- NULL
  fingerprint_settings$bootstrapCheckpointDir <- NULL
  fingerprint_settings$bootstrapWorkers <- NULL
  fingerprint <- digest::digest(list(counts = counts, metadata = metadata, pathways = pathways,
    settings = fingerprint_settings, R = R.version.string,
    packages = vapply(sort(loadedNamespaces()), function(p) as.character(getNamespaceVersion(p)), character(1)),
    lockfile = if (file.exists("renv.lock")) digest::digest(file = "renv.lock", algo = "sha256") else NULL,
    code = vapply(c("scripts/lib/analysis_core.R", "scripts/lib/analysis_bootstrap.R"),
      function(p) digest::digest(file = p, algo = "sha256"), character(1))), algo = "sha256")
  checkpoint_dir <- settings$bootstrapCheckpointDir
  if (!is.null(checkpoint_dir)) dir.create(file.path(checkpoint_dir, fingerprint), recursive = TRUE, showWarnings = FALSE)
  run_replicate <- function(iteration) {
    checkpoint <- if (is.null(checkpoint_dir)) NULL else file.path(checkpoint_dir, fingerprint, sprintf("rep-%05d.rds", iteration))
    saved <- if (!is.null(checkpoint) && file.exists(checkpoint)) {
      tryCatch(readRDS(checkpoint), error = function(e) NULL)
    } else NULL
    if (is.null(saved) || !identical(saved$fingerprint, fingerprint) || !identical(saved$iteration, iteration)) {
      seed <- as.integer((as.double(settings$seed) + 104729 * iteration) %% (.Machine$integer.max - 1) + 1)
      set.seed(seed)
      outcome <- tryCatch({
        indices <- pnv_resample_indices(metadata, settings$bootstrapUnitColumn)
        boot_metadata <- metadata[indices, , drop = FALSE]
        boot_metadata$source_sample <- boot_metadata$sample
        boot_metadata$sample <- paste0(boot_metadata$sample, "__resample_", seq_along(indices))
        # Distinguish repeated sampled pairs so donor fixed effects preserve the pairing.
        if (!is.null(settings$bootstrapUnitColumn)) {
          units <- metadata[[settings$bootstrapUnitColumn]][indices]
          lengths_by_unit <- table(metadata[[settings$bootstrapUnitColumn]])
          block <- integer(length(indices)); cursor <- 1L; block_number <- 0L
          while (cursor <= length(indices)) {
            block_number <- block_number + 1L
            width <- as.integer(lengths_by_unit[[as.character(units[[cursor]])]])
            block[cursor:(cursor + width - 1L)] <- block_number
            cursor <- cursor + width
          }
          boot_metadata[[settings$bootstrapUnitColumn]] <- factor(paste0("pair_", block))
        }
        boot_counts <- counts[, indices, drop = FALSE]
        colnames(boot_counts) <- boot_metadata$sample
        rownames(boot_metadata) <- boot_metadata$sample
        boot_config <- modifyList(config, list(seed = seed, bootstrapReplicates = 0L, camera = FALSE))
        fitted <- pnv_fit_primary(boot_counts, boot_metadata, boot_config, shrink = FALSE)
        ranked <- setNames(fitted$geneResults$stat, fitted$geneResults$gene)
        list(result = as.data.frame(pnv_score_pathways(ranked, pathways, boot_config)), error = NULL)
      }, error = function(e) list(result = NULL, error = conditionMessage(e)))
      saved <- c(list(fingerprint = fingerprint, iteration = iteration, seed = seed), outcome)
      if (!is.null(checkpoint)) {
        temporary <- paste0(checkpoint, ".", Sys.getpid(), ".tmp")
        saveRDS(saved, temporary)
        if (!file.rename(temporary, checkpoint)) stop("Could not atomically save bootstrap checkpoint.")
      }
    }
    saved
  }
  workers <- if (.Platform$OS.type == "unix") min(settings$bootstrapWorkers, requested) else 1L
  completed <- if (workers > 1L) {
    parallel::mclapply(seq_len(requested), run_replicate, mc.cores = workers,
      mc.preschedule = FALSE, mc.set.seed = FALSE)
  } else lapply(seq_len(requested), run_replicate)
  # Unexpected process failures must not be mistaken for successful null pathways.
  if (any(vapply(completed, function(x) inherits(x, "try-error") || !is.list(x) || is.null(x$iteration), logical(1)))) {
    stop("A bootstrap worker terminated unexpectedly; rerun to resume completed checkpoints.", call. = FALSE)
  }
  repetitions <- lapply(completed, function(x) x$result)
  failures <- lapply(Filter(function(x) !is.null(x$error), completed),
    function(x) list(iteration = x$iteration, seed = x$seed, reason = x$error))
  list(requested = requested, completed = requested - length(failures), failures = failures,
    fingerprint = fingerprint,
    workerPolicy = list(requested = settings$bootstrapWorkers, actual = workers,
      strategy = if (workers > 1L) "fork-per-replicate" else "sequential", perReplicateFgseaWorkers = 1L,
      seedPolicy = "fixed seed derived from base seed and replicate index; scheduling does not alter results"),
    pathways = pnv_summarize_bootstrap(reference$pathway, reference$NES, repetitions, requested, settings$alpha))
}
