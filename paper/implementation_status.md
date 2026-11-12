# Publication implementation status

The five-cohort implementation and report verification were completed on 10 November 2026. The November 12 publication materials add a data-backed case figure, blinded evaluation packets, native comparator reports and an offline reviewer tutorial. External adjudication and participant observations are pending.

## Implemented behavior

- GEO discovery and explicit sample design produce local R input bundles; browser inference and fabricated-significance fallbacks are removed.
- One DESeq2/Wald + apeglm + fgsea engine, separate CAMERA and sample/design sensitivity, with no automatic removal of unidentifiable model terms.
- Versioned nullable evidence, exact upstream ranking/membership, source-row links, full/basic reports with identical raw information, content hashes and staged publication/rollback.
- Typed sample/batch/donor identifiers, safe workbook/JSON boundaries, no silent case/alias merges, and no missing-p-value-to-zero conversions.
- Executable study assignment/logger/blinded ratings/power/analysis/figure tools and real comparator adapters. No synthetic participant observations are presented as human results.

## Recorded verification

| Check | Result |
|---|---|
| November 10 engine verification suite | 345/345 passed |
| R regression suites | 4 passed |
| TypeScript / production build | passed |
| Critical JS/TS coverage | 96.48% lines; 84.36% branches; scoped modules, not whole repository |
| Independent direct-package checks | 18 per dataset, 90/90 passed; same-environment integration verification |
| Rendered tested membership / ES | 6,565 pathways passed; maximum absolute ES difference 1.055e-15 |
| PD / MDD sample bootstrap | 500 fits each; zero failed fits |
| Pathway testable repetitions | PD 385–500; MDD 286–500; five pathways per cohort below 90% |
| Same-sample group-only sensitivity | two actual runs, zero bootstrap repetitions; missing overlap metrics remain missing |
| Full/basic source information | identical in all five datasets |
| Publication report browser checks | 10 reports, offline desktop/mobile, zero page errors and remote requests |
| Figure exports | SVG/PNG/PDF checked on synthetic fixtures and real PD report |
| Live GEO route | GSE68719 FTP discovery, explicit 44-control/29-PD assignment, input download, actual local CLI analysis/report generation passed |
| Full pipeline command | `npm run paper:benchmark` passed; unchanged second run reused all five analysis jobs and reports |
| Frozen R packages | 128 declared package versions matched in a separate verification library; two fresh-process airway reference checks passed |
| Node dependency audit | zero reported advisories at verification |
| Comparator execution | GeneTonic 3.4.0 / RNAmel 0.18.1, matched/default modes on real paired airway: four completed runs |

These checks do not establish universal FDR control, disease mechanisms, independent external reproducibility or user-performance improvement. Pipeline replay timings include checkpoint reuse and are not cold-run speed benchmarks. Comparator timings are descriptive single executions under concurrent workload.

Evidence files include `.cache/verification/vitest-final.json`, `.cache/verification/coverage-critical/coverage-summary.json`, `.cache/verification/publication-browser/verification.json`, `.cache/verification/publication-full-pipeline.log`, `.cache/verification/publication-cache-reuse.log`, and `paper/outputs/publication_v2/benchmarks/finalization.json`. Figure inputs/outputs and legends are hashed in the figure manifests. The local source archive receipt is `paper/outputs/publication_v2/release/source-snapshot.json`; it records the actual dirty working source separately from the base Git commit.

## Known limitations and external gates

- Institutional determination/consent, independent expert case adjudication, six-person pilot, final power assumptions/preregistration, recruitment and the main user study remain pending. Participant templates are empty.
- A clean Linux arm64 VM built the pinned R 4.5.1/Bioconductor 3.22 image and restored all 128 statistical lock entries. Processing compressed GEO files additionally required R.methodsS3 1.8.2, R.oo 1.27.1 and R.utils 2.13.0. The ordinary restore now installs verified source archives for these versions and checks a compressed input. The Linux replay and independent-operator directions are in `paper/evaluation/linux-replay/RUNBOOK.md`. A same-host virtual machine is a technical replication. An external analyst’s run remains pending.
- MDD group-only apeglm optimization warnings are retained in the report checks, limitations and raw execution log. Shrunk effects and original Wald inference remain separate.
- The frozen macOS R 4.5.1 environment emits a native protection-stack warning during nested initial loading of SparseArray 1.10.10. It reproduces without PNV code or data. A 600-gene/8-sample comparison with explicit namespace preloading produced identical gene, fgsea and CAMERA results after ten GC cycles (Wald/NES difference zero); all five real reference checks passed. No PNV numerical corruption was demonstrated, but independent environment follow-up remains required. The binary build/runtime version difference is context, not a proven cause. Warnings are preserved in validation logs.
- Exact upstream identifier matching is retained. Unmatched reference identifiers are exposed; viral names are not reassigned to human genes by case folding. This reports the tested universe, not a claim of exhaustive biological annotation.
- GeneTonic's optional MathJax request was observed in an offline initial-render check. That check does not certify every comparator widget/export.

No claim that PNV reduces interpretation errors or outperforms comparator tools is supported until external evaluation is completed.

## November 12 publication materials

Figure 1 gives the complete PD and MDD reselection distributions and the minimum-FDR PD example. It includes 83/221 and 289/757 original selections below 50% reselection. The architecture and integration check figures are Supplementary Figures S1 and S2. Data and figure manifests accompany the original vector exports.

The coordinator package has 12 development cases and 12 held-out cases, each split balanced across six ordinary and six audit tasks. Three report conditions use shared evidence. The 72 scored routes and three practice routes passed offline browser checks. Predictions were frozen before external truth became available. The private review kits preserve the two initial ratings, differences and adjudication history. Public release materials omit live case definitions, assignments and answer keys.

The separate Linux restore test began with R.utils unavailable and passed a 600-gene, eight-sample gzip-input analysis after installing the source-verified reader packages. Recruitment materials use the confirmed correspondence details. No external expert has supplied a judgment and no participant response is included.

On 12 November 2026, 378 workspace tests, type checking and the production build passed. The public source is a separately audited distribution with a reduced test set. The reviewer ZIP supports a one-pathway tutorial, the complete PD report, source rows and a portable software archive. A clean Linux arm64 replay uses the pinned base image, the frozen statistical packages and the three gzip-reader dependencies. Read the replay receipt for measured environment differences and the separate independent-operator record for human replication status.
