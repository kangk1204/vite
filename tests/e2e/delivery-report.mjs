import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { chromium } from 'playwright';
import { buildReport } from '../../scripts/build_report_from_workbook.mjs';
import { describeArtifact } from '../../scripts/lib/provenance.mjs';

const directory = path.resolve('.cache/revision-2026-11-16/ui/delivery');
await fs.mkdir(directory, { recursive: true });
const input = path.join(directory, 'input.xlsx');
const workbook = XLSX.utils.book_new();
for (const [name, rows] of [
  ['Project', [{ project_title: 'Synthetic delivery inspection', contrast_name: 'B_vs_A', condition_a: 'A', condition_b: 'B', species: 'human' }]],
  ['Genes', [{ gene_symbol: 'TP53', log2fc: 1, padj: 0.1, pvalue: 0.05, rank_metric: 2, condition_a_mean: 1, condition_b_mean: 2 }]],
  ['Pathways', [{ pathway_id: 'EXAMPLE', pathway_name: 'External example', collection: 'Custom', nes: 1.5, padj: 0.01, leading_edge_genes: 'TP53' }]],
]) XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
await fs.writeFile(input, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
const request = { schemaVersion: 1, claims: { conditionB: 'C' }, targetPathwayId: 'EXAMPLE',
  artifacts: [describeArtifact('workbook', 'input.xlsx', {root: directory})],
  additionalRecords: [{ name: 'Specimen map <img src=x onerror=alert(1)>', path: 'missing-map.tsv' }],
};
await fs.writeFile(path.join(directory, 'handoff.json'), JSON.stringify(request));
await fs.writeFile(path.join(directory, 'analysis-record.json'), JSON.stringify({ schemaVersion: 1, analysisRecord: { conditionB: 'D' } }));
const snapshots = {};
for (const condition of ['full', 'basic']) {
  const result = await buildReport(input, path.join(directory, `${condition}.html`), {
    condition, handoff: path.join(directory, 'handoff.json'), 'analysis-record': path.join(directory, 'analysis-record.json'), 'delivery-root': directory,
  });
  snapshots[condition] = result.viewerData.evidence.deliveryInspection;
  assert.equal(snapshots[condition]?.result.predicted, 'mismatch');
}
for (const field of ['request', 'analysisRecord', 'submittedAnalysisRecord', 'result', 'sources']) assert.deepEqual(snapshots.full[field], snapshots.basic[field]);

const browser = await chromium.launch({headless: true});
const checks = [];
try {
  for (const condition of ['full', 'basic']) {
    const context = await browser.newContext({offline: true, viewport: {width: 1440, height: 1000}});
    const page = await context.newPage(), errors = [], remote = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) remote.push(request.url()); });
    await page.goto(pathToFileURL(path.join(directory, `${condition}.html`)).href);
    assert.equal(await page.locator('#delivery-diagnostics').count(), condition === 'full' ? 1 : 0);
    assert.equal(await page.locator('.delivery-evidence img').count(), 0);
    await page.locator('#delivery-observations > summary').click();
    const raw = await page.locator('#delivery-observations').innerText();
    for (const label of ['Submitted analysis record', 'conditionB', 'No document supplied', 'C', 'D']) assert.ok(raw.includes(label));
    if (condition === 'full') {
      assert.ok(await page.locator('#delivery-diagnostics [data-check-status="fail"]').count() >= 2);
      await page.locator('#delivery-diagnostics [data-source-table]').first().click();
      assert.equal(await page.locator('#source-table-select').inputValue(), 'Pathways');
      assert.match(await page.locator('#source-table-content').innerText(), /EXAMPLE/);
    }
    await page.locator('.delivery-evidence').screenshot({path: path.join(directory, `${condition}.png`)});
    await page.setViewportSize({width: 390, height: 844});
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.deepEqual(errors, []); assert.deepEqual(remote, []);
    checks.push({condition, errors, remote, sourceNavigation: condition === 'full'});
    await context.close();
  }
} finally { await browser.close(); }
await fs.writeFile(path.join(directory, 'verification.json'), JSON.stringify({passed: true, checks}, null, 2));
console.log(JSON.stringify({passed: true, directory, checks}));
