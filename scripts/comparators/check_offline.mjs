#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function sourceTable(file, key) {
  const [header, ...lines] = fs.readFileSync(file, 'utf8').trimEnd().split(/\r?\n/);
  const columns = header.split('\t');
  return new Map(lines.map(line => {
    const values = line.split('\t');
    const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
    return [row[key], row];
  }));
}

export function verifyComparatorArtifacts(metrics, directory) {
  assert.equal(metrics.schemaVersion, 2, 'Use the revised observed run schema');
  assert.equal(metrics.completed, true, 'Native execution must have completed');
  assert.ok(metrics.runnerSha256 && metrics.executedSources?.length === 2, 'Executed runner/helper hashes are required');
  for (const artifact of metrics.artifacts) {
    assert.equal(path.basename(artifact.path), artifact.path, 'Artifact paths must stay in the run directory');
    const file = path.join(directory, artifact.path);
    assert.equal(sha256(file), artifact.sha256, `Artifact digest differs: ${artifact.path}`);
    assert.equal(fs.statSync(file).size, artifact.bytes);
  }
  for (const item of metrics.executedSources) assert.equal(sha256(path.join(directory, item.path)), item.sha256);
  assert.equal(metrics.runnerSha256, metrics.executedSources[0].sha256);
}

function sameNumber(actual, expected) {
  if (expected === 'NA' || expected == null) assert.ok(actual === 'NA' || actual === '' || actual === 'null');
  else {
    const a = Number(actual), b = Number(expected);
    assert.ok(Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= 1e-10 + Math.abs(b) * 1e-10, `${actual} differs from ${expected}`);
  }
}

async function geneTonicRow(page, header, id) {
  const table = page.locator('.dataTables_wrapper').filter({ has: page.locator('th').filter({ hasText: new RegExp(`^${header}$`) }) });
  await table.locator('input[type=search]').fill(id);
  const row = table.locator('tbody tr').filter({ has: page.getByRole('cell', { name: id, exact: true }) }).first();
  await row.waitFor({ state: 'visible' });
  const columns = (await table.locator('thead th').allTextContents()).map(s => s.trim());
  return Object.fromEntries((await row.locator('td').allTextContents()).map((value, index) => [columns[index], value.trim()]));
}

export async function checkOffline(metricsFile) {
  const directory = path.dirname(path.resolve(metricsFile));
  const metrics = JSON.parse(fs.readFileSync(metricsFile, 'utf8'));
  verifyComparatorArtifacts(metrics, directory);
  const report = path.join(directory, path.basename(metrics.reportPath));
  const genes = sourceTable(path.join(directory, 'gene_statistics.tsv'), 'gene');
  const pathways = sourceTable(path.join(directory, 'pathway_statistics.tsv'), 'pathway');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage(), errors = [], remoteRequests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
    await page.goto(pathToFileURL(report).href, { waitUntil: 'load', timeout: 60000 });
    const body = await page.locator('body').innerText();
    assert.ok(body.includes(metrics.tool) && body.length > 100);
    const tasks = [{ task: 'open-native-report-offline', status: 'completed', evidence: { title: await page.title(), bodyCharacters: body.length } }];
    if (metrics.tool === 'GeneTonic') {
      for (const gene of metrics.selectedGenes) {
        const displayed = await geneTonicRow(page, 'gene_id', gene), source = genes.get(gene);
        assert.ok(source);
        for (const [shown, original] of [['apeglm_log2FC', 'log2FoldChange'], ['Wald_statistic', 'stat'], ['Wald_pvalue', 'pvalue'], ['BH_adjusted_Wald_pvalue', 'padj']]) sameNumber(displayed[shown], source[original]);
      }
      tasks.push({ task: 'inspect-selected-gene-effect-and-test', status: 'completed', evidence: { selectedGenes: metrics.selectedGenes, interface: 'native GeneTonic searchable table' } });
      for (const pathway of metrics.selectedPathways) {
        const displayed = await geneTonicRow(page, 'gs_id', pathway), source = pathways.get(pathway);
        assert.ok(source); sameNumber(displayed.gs_NES, source.NES); sameNumber(displayed.gs_adj_pvalue, source.padj);
      }
      tasks.push({ task: 'inspect-selected-pathway-NES-and-adjustment', status: 'completed', evidence: { selectedPathways: metrics.selectedPathways, interface: 'native GeneTonic searchable table' } });
    } else {
      const headings = await page.locator('h2').allTextContents();
      assert.ok(headings.includes('Overview') && headings.includes('Differential expression') && headings.includes('Reproducible R script'));
      assert.ok(await page.locator('img').count() > 0, 'The native volcano figure must render');
      assert.ok((await page.locator('pre').allTextContents()).some(text => text.includes('run_deseq2')));
      tasks.push({ task: 'inspect-saved-contrast-and-generated-code', status: 'completed', evidence: { headings, images: await page.locator('img').count() } });
      tasks.push({ task: 'inspect-selected-gene-effect-and-test', status: 'unavailable-in-native-report', evidence: { observedHeadings: headings, companionTable: 'gene_statistics.tsv' } });
      tasks.push({ task: 'inspect-selected-pathway-NES-and-adjustment', status: 'unavailable-in-native-report', evidence: { observedHeadings: headings, companionTable: 'pathway_statistics.tsv' } });
    }
    assert.equal(genes.size, metrics.genes); assert.equal(pathways.size, metrics.pathways);
    tasks.push({ task: 'trace-complete-output-tables-to-executed-input-and-code', status: 'completed', evidence: {
      genes: genes.size, pathways: pathways.size, fixtureSha256: metrics.fixtureSha256, runnerSha256: metrics.runnerSha256,
      artifacts: metrics.artifacts.map(({ path, sha256 }) => ({ path, sha256 })), interface: 'companion run directory and captured execution receipt' } });
    assert.deepEqual(errors, []); assert.deepEqual(remoteRequests, []);
    await page.screenshot({ path: path.join(directory, 'native-report.png'), fullPage: true });
    const audit = { schemaVersion: 2, browser: 'Chromium', browserVersion: browser.version(), platform: process.platform,
      tool: metrics.tool, mode: metrics.mode, reportSha256: sha256(report), runnerSha256: metrics.runnerSha256,
      auditScriptSha256: sha256(fileURLToPath(import.meta.url)), observedTasks: tasks,
      pageErrors: errors, remoteRequests, status: 'passed', participantObservations: 0,
      scope: 'Automated native report navigation and companion-file tracing for the specified tasks' };
    fs.writeFileSync(path.join(directory, 'offline-browser.json'), JSON.stringify(audit, null, 2) + '\n');
    const updated = { ...metrics, offlineBrowserVerified: true, offlineCheck: audit };
    fs.writeFileSync(metricsFile, JSON.stringify(updated, null, 2) + '\n');
    return audit;
  } finally { await browser.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  if (!file) throw new Error('Usage: check_offline.mjs comparator-metrics.json');
  checkOffline(file).then(audit => console.log(JSON.stringify({ tool: audit.tool, mode: audit.mode, status: audit.status, tasks: audit.observedTasks.map(({ task, status }) => ({ task, status })) })))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
