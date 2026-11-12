#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const out = path.resolve(process.argv[2] ?? path.join(root, '.cache/case-figure-capture'));
const release = path.join(root, 'paper/outputs/publication_v2');
const key = 'gse68719_pd_primary';
const id = 'R-HSA-449147';
const name = 'Signaling by Interleukins';
const report = path.join(release, 'reports', `${key}.report.html`);
const receipt = JSON.parse(await fs.readFile(path.join(release, 'benchmarks/finalization.json'), 'utf8'));
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const reportHash = sha256(await fs.readFile(report));
const descriptor = receipt.cohorts[key].artifacts.find(a => a.path === path.relative(root, report));
if (descriptor?.sha256 !== reportHash) throw new Error('PD report differs from finalization receipt');
await fs.mkdir(out, {recursive: true});
const browser = await chromium.launch({headless:true});
try {
  const context = await browser.newContext({offline:true, viewport:{width:490,height:1060},deviceScaleFactor:3, reducedMotion:'reduce',locale:'en-US'});
  const page = await context.newPage();
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  await page.goto(pathToFileURL(report).href,{waitUntil:'load',timeout:90000});
  await page.locator('#pathway-search').fill(name);
  await page.getByRole('option').filter({has:page.getByText(name,{exact:true})}).first().click();
  await page.locator('#top-genes').selectOption('15');
  await page.locator('#layout-mode').selectOption('elk-stress');
  await page.locator('#network-container canvas').first().waitFor();
  await page.waitForFunction(name => document.querySelector('#current-pathway-name')?.textContent.trim() === name, name);
  await page.waitForTimeout(800);
  const evidence = page.locator('#pathway-evidence');
  const text = await evidence.innerText();
  const summary = await page.locator('#current-pathway-summary').innerText();
  const screenshots = {};
  async function capture(label, selector) {
    const element = page.locator(selector);
    await element.scrollIntoViewIfNeeded();
    const file = `figure1b_capture_${label}.png`;
    await element.screenshot({path:path.join(out,file),animations:'disabled'});
    screenshots[label] = {file,selector,sha256:sha256(await fs.readFile(path.join(out,file)))};
  }
  await capture('evidence','.pathway-meta');
  await page.locator('#export-target').selectOption('network');
  await page.locator('#export-format').selectOption('svg');
  const pendingDownload = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await pendingDownload;
  const vectorFile = 'figure1b_network_export.svg';
  await download.saveAs(path.join(out, vectorFile));
  const vectorPage = await context.newPage();
  await vectorPage.goto(pathToFileURL(path.join(out, vectorFile)).href);
  const networkFile = 'figure1b_capture_network.png';
  await vectorPage.locator('svg').first().screenshot({path:path.join(out,networkFile)});
  screenshots.network = {file:networkFile, source:'Unmodified network SVG downloaded with report Save Figure', vectorFile,
    sha256:sha256(await fs.readFile(path.join(out,networkFile))), vectorSha256:sha256(await fs.readFile(path.join(out,vectorFile)))};
  await vectorPage.close();
  const navigation=[];
  for (const table of ['group_only_pathways','pathways']) {
    const button = evidence.locator(`[data-source-table="${table}"]`);
    const row = Number(await button.getAttribute('data-source-row'));
    await button.click();
    const selected = await page.locator('#source-table-select').inputValue();
    const cells = await page.locator('#source-table-content tbody tr').first().locator('td').allTextContents();
    if (selected !== table || Number(cells[0]) !== row || !cells.includes(id)) throw new Error(`Source link did not open the requested ${table} row ${row}`);
    navigation.push({table,row,selectedPathwayId:id,columns:await page.locator('#source-table-content thead th').allTextContents(),values:cells});
  }
  if (pageErrors.length) throw new Error(pageErrors.join('\n'));
  const metadata={report:path.relative(root,report),reportSha256:reportHash,browser:browser.version(),offline:true,viewport:{width:490,height:1060},deviceScaleFactor:3,
    pathwayId:id,pathwayName:name,selection:'Minimum numeric original PD fgsea-adjusted p-value; resolve ties by pathway ID.',layout:'elk-stress',geneFilter:'top 15',ppiSource:await page.locator('#ppi-mode').inputValue(),
    shownPathway:await page.locator('#current-pathway-name').innerText(),summary,evidenceText:text,screenshots,navigation};
  await fs.writeFile(path.join(out,'figure1b_capture.json'),JSON.stringify(metadata,null,2)+'\n');
  console.log(JSON.stringify({selected:id,reportHash,sourceRows:navigation.map(n=>[n.table,n.row]),summary,text}));
} finally { await browser.close(); }
