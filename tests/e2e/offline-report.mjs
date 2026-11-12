import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { chromium } from 'playwright';

const directory = path.resolve('.cache/verification/offline-report');
await fs.mkdir(directory, { recursive: true });
const genes = ['TP53', 'CDKN1A', 'MDM2', 'BAX', 'BBC3', 'GADD45A'];
const rows = genes.map((gene, index) => ({
  gene_symbol: gene, log2fc: index === 5 ? null : 1.2, padj: index === 5 ? null : 0.01,
  pvalue: index === 5 ? null : 0.001, rank_metric: index === 5 ? null : 5 - index / 3,
  condition_a_mean: 2, condition_b_mean: 4, sample_A1: 1.8, sample_A2: 2.2,
  sample_B1: 3.8, sample_B2: 4.2,
}));
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
  project_title: 'Audit <script>window.__pnvInjected=true</script>', contrast_name: 'B_vs_A',
  condition_a: 'A', condition_b: 'B', species: 'human',
}]), 'Project');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Genes');
XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
  pathway_name: 'HALLMARK_P53_PATHWAY', collection: 'Hallmark', nes: 1.5, padj: 0.02,
  leading_edge_genes: genes.join(';'),
}]), 'Pathways');
const input = path.join(directory, 'fixture.xlsx');
await fs.writeFile(input, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
const evidence = {
  runId: null,
  analysis: {
    method: 'external', versions: {}, contrast: { conditionA: 'A', conditionB: 'B' },
    designFormula: null, seed: null, alpha: 0.05, geneHypothesisCount: 6,
    pathwayHypothesisCount: 1, filterRule: null, rankMetric: null, lfcMethod: null,
    adjustment: 'BH',
  },
  verification: { status: 'unverifiable', checks: [], limitations: ['Synthetic software test only.'] },
  artifacts: [], pathways: {},
  sourceTables: { fixture: { columns: ['gene', 'padj'], rows: [['TP53', 0.01], ['GADD45A', null]] } },
};
const sidecar = path.join(directory, 'evidence.json');
await fs.writeFile(sidecar, JSON.stringify({ schemaVersion: 2, evidence }));

for (const condition of ['full', 'basic']) {
  execFileSync(process.execPath, [
    'scripts/build_report_from_workbook.mjs', input, path.join(directory, `${condition}.html`),
    '--evidence', sidecar, '--viewer-json', path.join(directory, `${condition}.viewer.json`),
    '--condition', condition,
  ], { stdio: 'pipe', maxBuffer: 8 * 1024 * 1024 });
}

const full = JSON.parse(await fs.readFile(path.join(directory, 'full.viewer.json'), 'utf8'));
const basic = JSON.parse(await fs.readFile(path.join(directory, 'basic.viewer.json'), 'utf8'));
assert.equal(full.schemaVersion, 2);
assert.deepEqual(full.evidence.sourceTables, basic.evidence.sourceTables, 'Both conditions must expose identical source evidence');
assert.equal(full.pathways[0].nodes.find(node => node.id === 'GADD45A').padj, null);

const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const condition of ['full', 'basic']) {
    const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    const errors = [];
    const network = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.on('request', request => { if (/^https?:/.test(request.url())) network.push(request.url()); });
    await page.goto(pathToFileURL(path.join(directory, `${condition}.html`)).href, { waitUntil: 'load' });
    await page.locator('#export-button').waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.querySelectorAll('canvas').length > 0);
    assert.equal(await page.evaluate(() => Boolean(window.__pnvInjected)), false, 'HTML input must not execute');
    const body = await page.locator('body').innerText();
    assert.match(body, /P53/i);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Desktop report must not overflow horizontally');
    for (const format of ['svg', 'png', 'pdf']) {
      await page.locator('#export-format').selectOption(format);
      const [download] = await Promise.all([
        Promise.race([
          page.waitForEvent('download', { timeout: 60000 }),
          page.waitForEvent('dialog', { timeout: 60000 }).then(async dialog => {
            const message = dialog.message();
            await dialog.dismiss();
            throw new Error(`${condition} ${format} export failed: ${message}`);
          }),
        ]),
        page.locator('#export-button').click(),
      ]);
      const exported = path.join(directory, `${condition}.${format}`);
      await download.saveAs(exported);
      const contents = await fs.readFile(exported);
      assert.ok(contents.length > 100, `${format} export must contain an artifact`);
      if (format === 'pdf') assert.equal(contents.subarray(0, 5).toString(), '%PDF-');
      if (format === 'png') assert.equal(contents.subarray(1, 4).toString(), 'PNG');
      if (format === 'svg') assert.match(contents.toString(), /<svg/);
    }
    await page.screenshot({ path: path.join(directory, `${condition}.screenshot.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(150);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'Mobile report must not overflow horizontally');
    await page.screenshot({ path: path.join(directory, `${condition}.mobile.png`), fullPage: true });
    assert.deepEqual(errors, [], 'Offline report must not throw');
    assert.deepEqual(network, [], 'Offline report must not request remote assets');
    checks.push({ condition, pageErrors: errors.length, remoteRequests: network.length, exports: ['svg', 'png', 'pdf'] });
    await context.close();
  }
} finally {
  await browser.close();
}
await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({ checks }, null, 2));
console.log(JSON.stringify({ passed: true, checks, artifacts: directory }, null, 2));
