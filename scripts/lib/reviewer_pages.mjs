import { escapeText as esc, renderSourceRows } from './reviewer_example.mjs';

const link = (href, label, cls = '') => `<a class="${cls}" href="${esc(href)}">${esc(label)}</a>`;
const fmt = (value, digits = 3) => Number(value).toLocaleString('en-US', { maximumFractionDigits: digits });
const nav = [['index.html', 'Example'], ['evidence.html', 'Evidence'], ['files.html', 'Files'], ['reproduce.html', 'Reproduce']];

function layout(title, page, body, sourceVersion) {
  const links = nav.map(([href, label]) => `<a href="${href}"${href === page ? ' aria-current="page"' : ''}>${label}</a>`).join('');
  return `<!doctype html>
    <html lang="en">
    <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <meta name="color-scheme" content="light">
    <title>${esc(title)} | Pathway Network Viewer</title>
    <link rel="stylesheet" href="assets/reviewer.css">
    </head>
    <body>
    <a class="skip" href="#main">Skip to content</a>
    <header>
    <div class="mast">
    <a class="brand" href="index.html">Pathway Network Viewer</a>
    <nav aria-label="Package navigation">${links}</nav>
    </div>
    </header>
    <main id="main">${body}</main>
    <footer>
    <span>Pathway Network Viewer · Public review package</span>
    <a href="source/source-snapshot.json">Source ${esc(sourceVersion.slice(0, 12))}</a>
    </footer>
    </body>
    </html>`;
}

export function renderPages({ example: e, cohorts, source, figureBases, pdCount, controlCount, exampleBytes, fullBytes, comparators = null, linuxProbe = null, statistics = null, provenanceValidation = null, publication = {
  manifestPath: 'paper/manifests/publication_v2.json', outputRoot: 'paper/outputs/publication_v2',
  primaryConfigPath: 'paper/configs/publication_v2/gse68719_pd_primary.json',
  primarySnapshotPath: 'paper/outputs/publication_v2/gse68719_pd_primary/gse68719_pd_vs_control_reference_input.rds',
} }) {
  const p = e.primary.values, c = e.camera.values, b = e.bootstrap;
  const pdDir = 'tables/gse68719_pd_primary';
  const size = n => `${fmt(n / 1024 / 1024, 1)} MiB`;
  const hero = `<p class="context">GSE68719 · Human prefrontal cortex (BA9)</p>
    <h1>Signaling by Interleukins in Parkinson disease</h1>
    <p class="lead">Does this pathway meet the 0.05 adjusted P-value threshold in both the primary fgsea test and the CAMERA sensitivity analysis?</p>`;
  const metrics = `<div class="metrics" aria-label="Observed pathway results">
    <section>
    <h2>fgsea FDR</h2>
    <strong>${Number(p.padj).toExponential(2)}</strong>
    <p>NES ${fmt(p.NES)} in Parkinson disease relative to controls.</p>${link('evidence.html#fgsea', `Inspect fgsea row ${e.primary.row}`)}</section>
    <section>
    <h2>Bootstrap selection</h2>
    <strong>${b.selected} <small>/ ${b.valid}</small>
    </strong>
    <p>Selected at FDR &lt; ${e.analysis.alpha} across testable sample resamples.</p>${link('evidence.html#bootstrap', 'Inspect the resampling record')}</section>
    <section>
    <h2>CAMERA FDR</h2>
    <strong>${fmt(c.padj)}</strong>
    <p>Estimated direction ${esc(c.direction.toLowerCase())} with inter-gene correlation adjustment.</p>${link('evidence.html#camera', `Inspect CAMERA row ${e.camera.row}`)}</section>
    </div>`;
  const home = `${hero}${metrics}<section class="callout">
    <h2>Explore the pathway</h2>
    <p>Open the selected pathway to trace its genes, interactions and enrichment curve. The example retains the original ranks and adjustment across ${fmt(e.analysis.pathwayHypothesisCount)} tested pathways.</p>
    <div class="actions">${link('reports/interleukins.report.html', `Open one-pathway report (${size(exampleBytes)})`, 'button')}${link('reports/gse68719_pd_primary.report.html', `Open complete PD report (${size(fullBytes)})`, 'secondary')}</div>
    </section>
    <section class="study">
    <h2>Study design</h2>
    <dl class="facts">
    <div>
    <dt>Comparison</dt>
    <dd>${pdCount} Parkinson disease and ${controlCount} neurologically normal control samples</dd>
    </div>
    <div>
    <dt>Adjustment</dt>
    <dd>Post-mortem interval, age at death and RNA integrity number</dd>
    </div>
    <div>
    <dt>Gene set</dt>
    <dd>Reactome ${esc(e.id)} · ${fmt(p.size)} genes in the tested universe</dd>
    </div>
    </dl>
    </section>`;

  const evidence = `<p class="context">${esc(e.id)} · GSE68719</p>
    <h1>Trace the evidence</h1>
    <p class="lead">Each source row belongs to the frozen analysis. Data row numbers start at 1 and exclude the header.</p>
    <section id="fgsea">
    <h2>Primary enrichment</h2>
    <p>The DESeq2 Wald ranking yielded a positive NES and an FDR below ${e.analysis.alpha}. The adjusted value covers all ${fmt(e.analysis.pathwayHypothesisCount)} tested Reactome pathways.</p>
    <p>${link(`${pdDir}/fgsea.tsv`, `Complete fgsea TSV · data row ${e.primary.row}`)}</p>${renderSourceRows(Object.fromEntries(['pathway_id', 'pathway_name', 'size', 'ES', 'NES', 'pval', 'padj'].map(key => [key, p[key]])))}</section>
    <section id="bootstrap">
    <h2>Sample resampling</h2>
    <p>The pathway met the selection threshold in ${b.selected} of ${b.valid} testable resamples (${fmt(100 * b.selectionFrequency, 1)}%). ${b.valid} of ${b.requested} requested fits were testable. This frequency describes sensitivity to resampling within this cohort.</p>
    <p>${link(`${pdDir}/bootstrap.tsv`, `Complete bootstrap TSV · data row ${e.primary.row}`)} · ${link('evidence/pathway-record.json', 'Extracted evidence record')}</p>${renderSourceRows({ pathway_id: e.id, requested: b.requested, valid: b.valid, selected: b.selected, selectionFrequency: b.selectionFrequency, directionMatches: b.directionMatches, directionConsistency: b.directionConsistency })}</section>
    <section id="camera">
    <h2>Method sensitivity</h2>
    <p>CAMERA also estimated an upward direction. Its FDR of ${fmt(c.padj)} exceeds the ${e.analysis.alpha} threshold. The two tests therefore give different significance decisions for this pathway.</p>
    <p>${link(`${pdDir}/camera.tsv`, `Complete CAMERA TSV · data row ${e.camera.row}`)}</p>${renderSourceRows(c)}</section>
    <section>
    <h2>Recorded analysis</h2>${renderSourceRows({ runId: e.runId, method: e.analysis.method, design: e.analysis.designFormula, rank: e.analysis.rankMetric, seed: e.analysis.seed, genesTested: e.analysis.geneHypothesisCount, pathwaysTested: e.analysis.pathwayHypothesisCount })}<p>${link('reports/gse68719_pd_primary.report.html', 'Open complete supplied-artifact verification in the PD report')}</p>
    </section>`;

  const tableRows = cohorts.map(cohort => `<tr>
    <th scope="row">${esc(cohort.datasetIdentifier)}</th>
    <td>${esc(cohort.contrastName)}</td>
    <td>${cohort.files.map(([name, label]) => link(`tables/${cohort.key}/${name}`, label)).join(' · ')}</td>
    </tr>`).join('');
  const figures = figureBases.map(([name, title]) => `<li>
    <strong>${esc(title)}</strong>
    <span>${['pdf', 'png', 'svg', 'source.tsv', 'source.xlsx', 'legend.txt', 'legend.docx', 'manifest.json'].map(suffix => link(`figures/${name}.${suffix}`, suffix)).join(' · ')}</span>
    </li>`).join('');
  const comparatorSection = comparators ? `<section><h2>Observed native report comparison</h2>
    <p>The four cells use the same public airway input fixture. Matched report inputs contain the captured PNV arrays. The accompanying audits record completion and numerical access for specific native-report tasks.</p>
    <ul>${comparators.map(item => `<li>${link(item.report, `${item.tool} ${item.version} · ${item.mode}`)} · ${link(item.receipt, 'Execution and source receipt')} · ${link(item.taskAudit, 'Automated task observations')}</li>`).join('')}</ul>
    <p>${link('comparators/benchmark.tsv', 'Observed resource measurements')} · ${link('comparators/task-completion.tsv', 'Task completion table')} · ${link('comparators/index.json', 'Artifact index')}</p>
    </section>` : '';
  const linuxSection = linuxProbe ? `<section><h2>Revised ordinary Linux airway probe</h2>
    <p>This implementing-team Linux VM run used the same paired airway input values in a gzip file. The records retain numerical macOS/Linux differences, independent package comparisons within Linux, public delivery checks and a relocated RO-Crate. It is a same-host technical check, with no independent operator or participant observations.</p>
    <p>${link(linuxProbe.receipt, 'Actual execution receipt')} · ${link('linux-replay/airway-cross-platform.json', 'Measured cross-platform differences')} · ${link('linux-replay/methods/commands.json', 'Executed methods')} · ${link('linux-replay/image-build-context.json', 'Actual source-file hashes')} · ${link('linux-replay/airway-analysis.crate.zip', 'Portable analysis RO-Crate')}</p>
    <p>${link('linux-replay/airway-independent-reference.json', 'Independent package checks')} · ${link('linux-replay/delivery-validation.json', 'Public delivery checks')} · ${link('linux-replay/delivery-browser.json', 'Offline HTML consumers')} · ${link('linux-replay/official-crate-validation.json', 'Official crate validation')}</p>
    </section>` : '';
  const statisticsSection = statistics ? `<section><h2>Statistical sensitivity and validation</h2>
    <p>These derived artifacts retain Cook-withheld-gene sensitivity, CAMERA correlation and fit diagnostics, and the conditional Monte Carlo precision of sample resampling. Historical and revised derivations remain separately labeled. Raw resampling checkpoints are excluded from this review package.</p>
    <p>${link(statistics.index, 'Artifact index with source digests')}</p>
    <details><summary>Browse ${statistics.files.length} derived artifacts</summary>
    <ul>${statistics.files.map(file => `<li>${link(file, file.replace(/^statistics\//, '').replaceAll('_', ' '))}</li>`).join('')}</ul></details>
    </section>` : '';
  const provenanceSection = provenanceValidation ? `<section><h2>Independent provenance consumers</h2>
    <p>These records describe mandatory external profile checks and independent retrieval of supplied files. They do not assess biological correctness or human interpretation.</p>
    <p>${link(provenanceValidation.index, 'Validation settings, scope and exact receipt hashes')}</p>
    <ul>${provenanceValidation.files.map(file => `<li>${link(file, file.replace(/^provenance-validation\//, ''))}</li>`).join('')}</ul>
    </section>` : '';
  const files = `<h1>Reports, tables and figures</h1>${comparatorSection}${linuxSection}${statisticsSection}${provenanceSection}
    <p class="lead">The two offline reports cover the selected PD example. The tables retain the complete test families for all five analysis contexts.</p>
    <section>
    <h2>Interactive reports</h2>
    <ul class="file-list">
    <li>${link('reports/interleukins.report.html', 'One-pathway PD example')}<span>${size(exampleBytes)} · One pathway displayed using the full Wald ranking</span>
    </li>
    <li>${link('reports/gse68719_pd_primary.report.html', 'Complete PD cohort report')}<span>${size(fullBytes)} · ${fmt(e.analysis.pathwayHypothesisCount)} pathways with the original artifact checks</span>
    </li>
    </ul>
    </section>
    <section>
    <h2>Quantitative source tables</h2>
    <div class="scroll">
    <table>
    <thead>
    <tr>
    <th>Dataset</th>
    <th>Contrast</th>
    <th>Complete tables</th>
    </tr>
    </thead>
    <tbody>${tableRows}</tbody>
    </table>
    </div>
    <p>Bootstrap rows follow the order of the corresponding fgsea table. Bootstrap tables are available for the two cohorts with prespecified sample resampling.</p>
    </section>
    <section>
    <h2>Manuscript figures</h2>
    <ul class="file-list">${figures}</ul>
    <p>${link('figures/figure1b_interleukin_report.source.tsv', 'Interleukin example source data (Figure 2)')}</p>
    </section>
    <section>
    <h2>Release files</h2>
    <ul>
    <li>${link(`source/${source.name}`, `Versioned source archive (${source.sourceSnapshot.slice(0, 12)})`)}</li>
    <li>${link('source/source-snapshot.json', 'Source archive receipt')}</li>
    <li>${link('evidence/pathway-record.json', 'Pathway records and source-file hashes')}</li>
    <li>${link('files.sha256', 'SHA-256 inventory of review files')}</li>
    </ul>
    </section>`;
  const reproduce = `<h1>Reproduce the PD analysis</h1>
    <p class="lead">Read the reports offline. The recorded analysis used R ${esc(e.analysis.versions?.R || "4.5.1")} and Bioconductor 3.22. Install Node.js and restore the dependencies pinned in the source archive. The initial dependency installation requires network access.</p>
    <section>
    <h2>Verify the extracted package</h2>
    <p>From the folder containing this page, verify the file inventory.</p>
    <pre>
    <code>python3 verify_bundle.py</code>
    </pre>
    </section>
    <section>
    <h2>Restore the versioned source</h2>
    <p>${link(`source/${source.name}`, 'Source archive')} · ${link('source/source-snapshot.json', 'Archive SHA-256 and source identity')}</p>
    <pre>
    <code>unzip source/${esc(source.name)} -d analysis\nmkdir -p analysis/data/raw\ncp inputs/GSE68719*.gz analysis/data/raw/\ncd analysis\nnpm ci\nbash scripts/setup_case_study_env.sh\nnpm run environment:verify</code>
    </pre>
    <p>The package includes the canonical ${link('inputs/GSE68719_raw_counts_GRCh38.p13_NCBI.tsv.gz', 'GEO raw counts')} and ${link('inputs/GSE68719_series_matrix.txt.gz', 'series matrix')}. Their bytes were checked against the frozen analysis records.</p>
    </section>
    <section>
    <h2>Run the cohort and integration checks</h2>
    <p>The first command executes the prespecified primary model and 500 sample resamples. The second compares the statistical outputs with direct package calls in the restored environment.</p>
    <pre>
    <code>Rscript scripts/analyze_neural_bulk_cohort.R ${esc(publication.primaryConfigPath)}\nRscript scripts/validate_analysis_reference.R \\\n  ${esc(publication.primarySnapshotPath)} \\\n  pd-reference-validation.json</code>
    </pre>
    <p>For all five contexts and the corresponding reports, run <code>node scripts/run_paper_benchmark.mjs ${esc(publication.manifestPath)}</code>. The workflow retrieves additional public cohort inputs. The full local index is generated under <code>${esc(publication.outputRoot)}/</code>.</p>
    </section>`;
  return { 'index.html': layout('Review example', 'index.html', home, source.sourceSnapshot), 'evidence.html': layout('Trace the evidence', 'evidence.html', evidence, source.sourceSnapshot), 'files.html': layout('Review files', 'files.html', files, source.sourceSnapshot), 'reproduce.html': layout('Reproduce', 'reproduce.html', reproduce, source.sourceSnapshot) };
}
