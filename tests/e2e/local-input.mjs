import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build, preview } from 'vite';
import { chromium } from 'playwright';
import XLSX from 'xlsx';

const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, '.cache/verification/local-ui');
const buildDirectory = path.join(directory, 'build');
const hostileText = '</script><script>window.__pnvInjected=true</script><img src=x onerror="window.__pnvInjected=true">';
const sampleIds = ['A1', 'A2', 'A3', 'B1', 'B2', 'B3'];
const batchLabels = ['one', 'two', 'three', 'one', 'two', 'three'];
const counts = `gene_symbol\t${sampleIds.join('\t')}\nTP53\t100\t100\t100\t100\t100\t100`;
const metadata = [
  `!Sample_geo_accession\t${sampleIds.map(id => `"${id}"`).join('\t')}`,
  `!Sample_title\t${sampleIds.map(id => `"sample ${id}"`).join('\t')}`,
  `!Sample_characteristics_ch1\t${batchLabels.map(batch => `"batch: ${batch}"`).join('\t')}`,
].join('\n');

function makeWorkbook() {
  const workbook = XLSX.utils.book_new();
  const sheets = {
    Project: [{ project_title: `Imported workbook ${hostileText}`, contrast_name: 'Treatment_vs_Reference', condition_a: 'Reference', condition_b: 'Treatment', species: 'human' }],
    Genes: ['TP53', 'MDM2', 'CDKN1A'].map((symbol, index) => ({
      gene_symbol: symbol, log2fc: index + 0.5, padj: index === 2 ? null : 0.01,
      pvalue: index === 2 ? null : 0.001, rank_metric: 3 - index,
      condition_a_mean: 4, condition_b_mean: 8,
      sample_A1: 3, sample_A2: 4, sample_A3: 5, sample_B1: 7, sample_B2: 8, sample_B3: 9,
    })),
    Pathways: [{ pathway_name: 'HALLMARK_P53_PATHWAY', collection: 'Hallmark', nes: 1.5, padj: 0.02, leading_edge_genes: 'TP53;MDM2;CDKN1A' }],
    GeneLabels: [{ gene_symbol: 'TP53', label: `TP53 ${hostileText}`, priority: 1 }],
  };
  for (const [name, rows] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
  return XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
}

function makeViewerJson() {
  const referenceSummary = { reactomePathways: 0, hallmarkPathways: 0, ppiGenes: 0, ppiEdges: 0, hallmarkMode: 'leading-edge-only', stringScoreCutoff: 700 };
  return {
    schemaVersion: 2, reportCondition: 'full',
    project: { projectTitle: `Imported JSON ${hostileText}`, contrastName: 'Treatment_vs_Reference', conditionA: 'Reference', conditionB: 'Treatment', species: 'human' },
    builtAt: '2026-11-10T00:00:00Z', significantPadjThreshold: 0.05, referenceSummary, issues: [],
    pathways: [{
      key: 'External::test', pathwayId: 'test', pathwayName: `Pathway ${hostileText}`, collection: 'External',
      nes: 1.5, padj: 0.02, leadingEdgeGenes: ['TP53'], allGenes: ['TP53'], missingGenes: [],
      hasReferenceMembership: false, fallbackToLeadingEdge: true,
      nodes: [{ id: 'TP53', label: `TP53 ${hostileText}`, labelPriority: 0, log2fc: 1, padj: null, pvalue: null, sizeMetric: 0,
        conditionAMean: 3, conditionBMean: 6, statisticsReason: 'p-value not supplied', sampleValues: {}, isLeadingEdge: true }],
      edges: [], enrichment: { points: [{ index: 0, value: 1, gene: 'TP53', isHit: true }], hitIndices: [0], maxAbsValue: 1 },
    }],
    evidence: {
      runId: 'synthetic-software-fixture',
      analysis: { method: 'external', versions: {}, contrast: { conditionA: 'Reference', conditionB: 'Treatment' }, designFormula: null,
        seed: null, alpha: 0.05, geneHypothesisCount: 1, pathwayHypothesisCount: 1, filterRule: null, rankMetric: null, lfcMethod: null, adjustment: 'BH' },
      verification: { status: 'verified_against_supplied_artifacts', checks: [], limitations: ['Synthetic fixture; no original source files supplied.'] },
      artifacts: [], pathways: {}, sourceTables: { fixture: { columns: ['gene', 'note'], rows: [['TP53', hostileText]] } },
    },
  };
}

async function verifyLayout(page, label) {
  const dimensions = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert.ok(dimensions.document <= dimensions.viewport, `${label}: page must not overflow horizontally`);
  await page.screenshot({ path: path.join(directory, `${label}.png`), fullPage: true });
}

async function downloadReport(page, name) {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 60000 }),
    page.getByRole('button', { name: 'Download report.html', exact: true }).click(),
  ]);
  const output = path.join(directory, name);
  await download.saveAs(output);
  assert.ok((await fs.stat(output)).size > 1000, 'Generated report must contain embedded assets');
  return output;
}

async function verifyReport(browser, output, expected) {
  const context = await browser.newContext({ offline: true });
  try {
    const page = await context.newPage();
    const pageErrors = [], network = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await page.goto(pathToFileURL(output).href, { waitUntil: 'load', timeout: 60000 });
    await page.locator('#export-button').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('canvas').length > 0);
    assert.equal(await page.evaluate(() => Boolean(window.__pnvInjected)), false, 'Imported markup must not execute in a report');
    const data = await page.evaluate(() => window.__PNV_DATA__);
    assert.equal(data.schemaVersion, 2);
    assert.equal(data.evidence.verification.status, 'unverifiable', 'Import must not trust a claimed artifact verification');
    assert.ok(data.project.projectTitle.includes(expected));
    assert.equal(data.pathways[0].nes, 1.5);
    assert.equal(data.pathways[0].padj, 0.02);
    assert.ok(data.pathways[0].nodes.some(node => node.padj === null), 'Missing inference must remain null');
    assert.deepEqual(pageErrors, [], 'Generated report must not throw');
    assert.deepEqual(network, [], 'Standalone report must not load remote assets or injected images');
    return { file: path.basename(output), schemaVersion: data.schemaVersion, verification: data.evidence.verification.status, pageErrors: 0, remoteRequests: 0 };
  } finally { await context.close(); }
}

await fs.mkdir(directory, { recursive: true });
let server, browser;
const checks = [];
try {
  await build({ root, logLevel: 'warn', build: { outDir: buildDirectory, emptyOutDir: true } });
  server = await preview({ root, logLevel: 'warn', build: { outDir: buildDirectory }, preview: { host: '127.0.0.1', port: 0 } });
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(`${server.resolvedUrls.local[0]}builder.html`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Private analysis', exact: true }).click();
  await page.getByLabel('Raw counts file').setInputFiles({ name: 'counts.tsv', mimeType: 'text/plain', buffer: Buffer.from(counts) });
  await page.getByLabel('Series matrix file').setInputFiles({ name: 'series.txt', mimeType: 'text/plain', buffer: Buffer.from(metadata) });
  await page.getByLabel('Project title (optional)').fill(`Prepared input ${hostileText}`);
  await page.getByRole('button', { name: 'Prepare sample setup', exact: true }).click();
  assert.equal(await page.getByLabel('Group factor (binary)').inputValue(), 'manual', 'Nonbinary metadata must permit explicit manual assignment');
  await page.getByLabel('Condition A label').fill('Reference');
  await page.getByLabel('Condition B label').fill('Treatment');
  for (const sample of sampleIds) {
    const row = page.locator('.design-row').filter({ has: page.locator('.design-cell-id', { hasText: new RegExp(`^${sample}$`) }) });
    await row.locator('select').selectOption(sample.startsWith('A') ? 'A' : 'B');
  }
  await page.getByLabel('Batch factor (optional)').selectOption('characteristic:batch');
  const [download] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('button', { name: 'Prepare local analysis', exact: true }).click(),
  ]);
  const bundlePath = path.join(directory, 'prepared.local-analysis.json');
  await download.saveAs(bundlePath);
  const bundle = JSON.parse(await fs.readFile(bundlePath, 'utf8'));
  assert.equal(bundle.kind, 'pnv-local-analysis-input'); assert.equal(bundle.schemaVersion, 1);
  assert.deepEqual(bundle.design.groupBySample, Object.fromEntries(sampleIds.map(id => [id, id.startsWith('A') ? 'A' : 'B'])));
  assert.deepEqual(bundle.design.batchBySample, Object.fromEntries(sampleIds.map((id, index) => [id, batchLabels[index]])));
  assert.equal(bundle.rawCountsText, counts); assert.equal(bundle.seriesMatrixText, metadata);
  assert.ok(!('pathways' in bundle) && !('viewerData' in bundle), 'Preparation must not invent statistical results');
  assert.equal(await page.locator('.pathway-preview').count(), 0);
  assert.equal(await page.evaluate(() => Boolean(window.__pnvInjected)), false);
  await verifyLayout(page, 'prepared-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.local-run-instructions').scrollIntoViewIfNeeded();
  await verifyLayout(page, 'prepared-mobile');
  checks.push({ step: 'private-input-and-manual-design', inputBundle: true, inferenceInBrowser: false, layouts: ['desktop', 'mobile'] });

  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.getByLabel('Import analysis results').setInputFiles({ name: 'external.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: makeWorkbook() });
  await page.getByText('Imported results: external.xlsx', { exact: true }).waitFor();
  assert.equal(await page.locator('.design-panel').count(), 0, 'Imported results must not be attached to the earlier design draft');
  await page.getByText(/Source verification: Not verified/).waitFor();
  const workbookReport = await downloadReport(page, 'workbook.report.html');
  checks.push(await verifyReport(browser, workbookReport, 'Imported workbook'));

  await page.getByLabel('Import analysis results').setInputFiles({ name: 'external.viewer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(makeViewerJson())) });
  await page.getByText('Imported results: external.viewer.json', { exact: true }).waitFor();
  await page.getByText(/Source verification: Not verified/).waitFor();
  assert.equal(await page.evaluate(() => Boolean(window.__pnvInjected)), false);
  const jsonReport = await downloadReport(page, 'json.report.html');
  checks.push(await verifyReport(browser, jsonReport, 'Imported JSON'));
  await verifyLayout(page, 'imported-desktop');
  await page.setViewportSize({ width: 390, height: 844 });
  await verifyLayout(page, 'imported-mobile');
  assert.deepEqual(pageErrors, [], 'Builder must not throw');
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ passed: true, checks, pageErrors }, null, 2));
  console.log(JSON.stringify({ passed: true, checks, artifacts: directory }, null, 2));
} catch (error) {
  await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ passed: false, checks, error: error.stack ?? String(error) }, null, 2));
  throw error;
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.httpServer.close(resolve));
}
