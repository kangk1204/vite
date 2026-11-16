import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import XLSX from 'xlsx';
import { chromium } from 'playwright';
import { buildReport } from '../../scripts/build_report_from_workbook.mjs';

const directory = path.resolve('.cache/revision-2026-11-16/ui');
await fs.mkdir(directory, { recursive: true });
const input = path.join(directory, 'membership.xlsx');
const workbook = XLSX.utils.book_new();
const append = (name, rows) => XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), name);
append('Project', [{ project_title: 'External membership audit', contrast_name: 'B_vs_A', condition_a: 'A', condition_b: 'B', species: 'human' }]);
append('Genes', ['TP53', 'CDKN1A', 'EGFR', 'BAX'].map((gene_symbol, index) => ({
  gene_symbol, log2fc: 1, padj: [0.2, null, null, 'NA'][index], pvalue: [0.1, 0.1, null, ''][index], rank_metric: [4, 3, 2, -1][index], condition_a_mean: 1, condition_b_mean: 2,
})));
const cases = [
  { pathway_id: 'CUSTOM', pathway_name: 'Unknown custom gene set', collection: 'Custom' },
  { pathway_id: 'HALLMARK_UNMATCHED', pathway_name: 'HALLMARK_UNMATCHED', collection: 'Hallmark' },
  { pathway_id: 'R-HSA-449147', pathway_name: 'Signaling by Interleukins', collection: 'Reactome' },
];
append('Pathways', [...cases, { pathway_id: 'EXACT', pathway_name: 'Exact supplied set', collection: 'Custom' }].map(item => ({ ...item, nes: 1.5, padj: 0.01, leading_edge_genes: 'TP53' })));
await fs.writeFile(input, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }));
const initial = await buildReport(input, path.join(directory, 'membership-initial.html'));
const evidence = {
  ...initial.viewerData.evidence,
  rankedGenes: initial.viewerData.rankedGenes,
  analysis: { ...initial.viewerData.evidence.analysis,
    geneHypothesisCount: 4,
    rankingPolicy: { id: 'finite_original_wald_v1', description: 'Finite original Wald statistics are retained; Cook and independent-filter flags remain attached.',
      includedGeneCount: 4, excludedNonFiniteCount: 0, includedCookOutlierCount: 1, includedIndependentFilterCount: 1, includedNonconvergedCount: 0 },
    cameraOptions: { interGeneCorrelation: 'estimated_per_set', allowNegativeCorrelation: false, useRanks: false, trendVar: false, directional: true, sort: false, adjustment: 'BH', normalization: 'TMM', transformation: 'voom' },
  },
  fitDiagnostics: { summary: { cooksWithheld: 1, independentFiltered: 1 }, warnings: [{ stage: 'dispersion', type: 'warning', message: 'Synthetic diagnostic warning', affectedQuantity: 'dispersion', geneAttribution: 'unavailable', affectedGeneIds: null }] },
  sourceTables: { ...initial.viewerData.evidence.sourceTables,
    pathways: { columns: ['pathway', 'pathway_id', 'leadingEdge'], rows: [['Exact supplied set [EXACT]', 'EXACT', 'TP53']] },
    camera: { columns: ['pathway', 'padj'], rows: [['Exact supplied set [EXACT]', 0.06]] },
  },
  pathways: { EXACT: { testedGenes: ['TP53', 'EGFR'], testedSize: 2, originalEs: 2 / 3, source: {table:'pathways',row:1},
    camera: { pvalue: 0.03, padj: 0.06, direction: 'Up', nGenes: 2, correlation: 0.04 },
    bootstrap: { requested: 500, valid: 400, selected: 200, directionMatches: 300, selectionFrequency: 0.5, directionConsistency: 0.75, validFraction: 0.8, warning: 'Incomplete fits',
      selectionInterval: { method: 'wilson', level: 0.95, lower: 0.451234504169709, upper: 0.548765495830291, denominator: 400 },
      directionInterval: { method: 'wilson', level: 0.95, lower: 0.7053228670693259, upper: 0.7899209857635259, denominator: 400 },
      denominatorReasons: { fitFailed: 80, notEligible: 15, nonFiniteStatistic: 5 }, interpretation: 'conditional_on_testable_resamples',
      uncertaintyScope: 'Monte Carlo precision of this joint sample-resampling and fgsea procedure; not biological/external-replication uncertainty',
    },
  } },
};
const sidecar = path.join(directory, 'membership.evidence.json');
await fs.writeFile(sidecar, JSON.stringify({ schemaVersion: 2, evidence }));
for (const condition of ['full', 'basic']) {
  await buildReport(input, path.join(directory, `membership-${condition}.html`), { condition, evidence: sidecar });
}

const browser = await chromium.launch({ headless: true });
const observations = [];
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
  const errors = [], requests = [];
  context.on('page', p => p.on('pageerror', error => errors.push(error.message)));
  context.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  for (const item of cases) {
    const page = await context.newPage();
    await page.goto(pathToFileURL(path.join(directory, 'membership-full.html')).href);
    await page.locator('#pathway-search').fill(item.pathway_name);
    await page.locator('[data-pathway-key]').filter({ hasText: item.pathway_name }).first().click();
    assert.match(await page.locator('#plot-container').innerText(), /Original tested membership was not supplied/);
    assert.equal(await page.locator('#plot-container path[stroke-linejoin]').count(), 0);
    const supplied = await page.evaluate(() => window.__PNV_DATA__.pathways.map(p => [p.nes, p.padj, p.enrichment.validation]));
    assert.ok(supplied.every(([nes, fdr]) => nes === 1.5 && fdr === 0.01));
    assert.equal(supplied.filter(([, , status]) => status === 'unavailable').length, 3);
    await page.screenshot({ path: path.join(directory, `${item.pathway_id}.html.png`), fullPage: true });
    const targets = item.pathway_id === 'CUSTOM' ? ['full', 'network', 'plot'] : ['full'];
    for (const target of targets) for (const format of target === 'plot' ? ['pdf'] : ['svg', 'png', 'jpg', 'pdf']) {
      await page.selectOption('#export-target', target);
      if (target !== 'plot') await page.selectOption('#export-format', format);
      const [download] = await Promise.all([page.waitForEvent('download'), page.locator('#export-button').click()]);
      const filename = path.join(directory, `${item.pathway_id}.${target}.${format}`);
      await download.saveAs(filename);
      const output = await fs.readFile(filename);
      if (format === 'svg' || format === 'pdf') {
        const text = format === 'svg'
          ? await page.evaluate(svg => [...new DOMParser().parseFromString(svg, 'image/svg+xml').querySelectorAll('text')].map(el => el.textContent).join(' '), output.toString())
          : execFileSync(process.env.PNV_PDFTOTEXT || 'pdftotext', ['-layout', filename, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
        assert.match(text, /Original tested membership was not supplied/);
        assert.match(text, /Original (?:enrichment|curve).*unavailable/i);
        if (target !== 'network') {
          assert.match(text, /NES \+1.50/); assert.match(text, /FDR 1.00e-2/);
          assert.match(text, /Peak ES NA/); assert.doesNotMatch(text, /Peak ES \+1.00/);
        }
        if (target === 'plot') {
          const bbox = execFileSync(process.env.PNV_PDFTOTEXT || 'pdftotext', ['-bbox', filename, '-'], {encoding:'utf8'});
          const height = await page.evaluate(xml => {
            const word = [...new DOMParser().parseFromString(xml, 'application/xml').querySelectorAll('word')].find(word => word.textContent === 'supplied.');
            return Number(word?.getAttribute('yMax')) - Number(word?.getAttribute('yMin'));
          }, bbox);
          assert.ok(height >= 7, 'The missing-membership reason must retain readable text size in plot-only PDF');
        }
      } else assert.ok(output.length > 1000);
      observations.push({ pathway: item.pathway_id, target, format, bytes: output.length });
    }
    await page.close();
  }
  const basic = await context.newPage();
  await basic.goto(pathToFileURL(path.join(directory, 'membership-basic.html')).href);
  await basic.locator('#pathway-search').fill('Unknown custom gene set');
  await basic.locator('[data-pathway-key]').filter({hasText: 'Unknown custom gene set'}).first().click();
  assert.match(await basic.locator('#plot-container').innerText(), /Original tested membership was not supplied/);
  const exact = await context.newPage();
  await exact.goto(pathToFileURL(path.join(directory, 'membership-full.html')).href);
  await exact.locator('#pathway-search').fill('Exact supplied set');
  await exact.locator('[data-pathway-key]').filter({hasText: 'Exact supplied set'}).first().click();
  assert.equal(await exact.locator('#plot-container path[stroke-linejoin]').count(), 1);
  assert.match(await exact.locator('#pathway-evidence').innerText(), /95% Wilson Monte Carlo interval/);
  assert.match(await exact.locator('#pathway-evidence').innerText(), /testable repetitions/);
  assert.match(await exact.locator('#pathway-evidence').innerText(), /correlation 0.04/);
  await exact.getByRole('button', {name:'CAMERA source row 1', exact:true}).click();
  assert.equal(await exact.locator('#source-table-select').inputValue(), 'camera');
  assert.match(await exact.locator('#source-table-content').innerText(), /Exact supplied set \[EXACT\]/);
  assert.match(await exact.locator('#fit-diagnostics').innerText(), /Synthetic diagnostic warning/);
  assert.match(await exact.locator('#fit-diagnostics').innerText(), /Recorded retained gene count 4/);
  assert.match(await exact.locator('#fit-diagnostics').innerText(), /Raw p-values available 2\/4/);
  assert.match(await exact.locator('#fit-diagnostics').innerText(), /Adjusted p-values available 1\/4/);
  assert.equal(await basic.locator('#fit-diagnostics').count(), 0);
  assert.deepEqual(await basic.evaluate(() => window.__PNV_DATA__.evidence), await exact.evaluate(() => window.__PNV_DATA__.evidence));
  await exact.screenshot({path: path.join(directory, 'statistical-diagnostics.html.png'), fullPage: true});
  await exact.locator('#pathway-evidence details > summary').click();
  await exact.setViewportSize({width:390,height:844});
  await exact.waitForFunction(() => document.documentElement.scrollWidth <= innerWidth, undefined, {timeout:5000});
  assert.ok(await exact.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'Expanded sample-resampling record must fit mobile');
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  await fs.writeFile(path.join(directory, 'membership-qa.json'), JSON.stringify({ passed: true, observations, errors, requests }, null, 2));
  console.log(JSON.stringify({ passed: true, exports: observations.length, directory }));
} finally { await browser.close(); }
