# Prior art and direct comparison

Search date: 2026-11-10. Targeted prior-art review, not a systematic review or proof of priority. PubMed/PMC, publisher originals, official documentation and preprints were searched; some Scholar/Europe PMC/bioRxiv access was unavailable.

| Tool / method | Existing capability relevant to PNV | Source |
| --- | --- | --- |
| GeneTonic (2021) | Linked gene/expression/gene-set exploration; interactive offline HTML and reproducible R code. The earlier table understated offline capability. | [Article](https://doi.org/10.1186/s12859-021-04461-5) |
| RNAmel (2026-10-14 accepted early article) | Tested common R API, scripts, self-contained HTML, portable sessions, Docker/renv and independent implementation comparisons. | [Article](https://doi.org/10.1186/s12859-026-06710-x) |
| pathlinkR (2024) | Enrichment, pathway networks, PPI and publication figures. | [Article](https://doi.org/10.1371/journal.pcbi.1012422) |
| EnrichmentMap:RNASeq (2025) | Accessible web enrichment and network visualization. | [Article](https://doi.org/10.1093/bioadv/vbaf178) |
| ReactomeGSA public-data update (2024) | Public-data retrieval and comparative pathway analysis. | [Article](https://doi.org/10.1093/bioinformatics/btae338) |
| Gene set bagging (2013) | Sample resampling and repeated gene-set analyses. | [Article](https://doi.org/10.1186/1471-2105-14-360) |
| bootGSEA (2024) | Gene/protein composition subsampling and robust rank aggregation; a different resampling unit from sample bootstrap. | [Article](https://doi.org/10.3389/fbinf.2024.1380928) |
| Workflow Run RO-Crate (2024) | Standardized execution provenance and artifact packaging. | [Article](https://doi.org/10.1371/journal.pone.0309210) |

Offline delivery, PPI visualization, bagging and provenance hashing are not new. The hypothesis is that linking statistical meaning, artifact agreement and sensitivity improves interpretation decisions. This remains untested in external participants.

## Executable comparisons

`scripts/comparators/run_comparator.R` invokes GeneTonic's public `happy_hour()` and RNAmel's public analysis/project/report APIs. See `evaluation/README.md` for commands.

- Matched mode supplies common DE/enrichment objects to delivery interfaces. It isolates delivery, not independent inference.
- Defaults mode preserves each tool's native workflow behavior. GeneTonic consumes upstream results rather than providing a distinct DE engine.
- Record success, elapsed time, report size, memory where measured, and offline checks. Unmeasured fields remain null.
- Historical feature-score totals are archival documentation-based comparisons, not current performance evidence.
- Synthetic fixtures establish adapter execution only; public-data benchmarks and external user performance are separate.

RNAmel installation is pinned to commit `efdd8e3849b2afbf24c933bd5049d55ee4896cbc` (0.18.1 at inspection). Every run records actual versions and session information. GeneTonic's installed version is recorded rather than assumed.
