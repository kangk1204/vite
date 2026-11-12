import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const manifest = JSON.parse(await fs.readFile('paper/manifests/publication_v2.json', 'utf8'));
const receipt = JSON.parse(await fs.readFile(`${manifest.outputRoot}/benchmarks/finalization.json`, 'utf8'));
const output = path.resolve('.cache/verification/publication-browser');
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
  for (const cohort of manifest.cohorts.filter(row => row.enabled !== false)) {
    assert.equal(receipt.cohorts[cohort.key]?.enrichmentParity?.pathways > 0, true);
    for (const condition of ['full', 'basic']) {
      const file = condition === 'full' ? cohort.reportPath : cohort.reportPath.replace(/\.report\.html$/, '.basic.report.html');
      const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 } });
      const page = await context.newPage();
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => { if (/^https?:/.test(request.url())) requests.push(request.url()); });
      await page.goto(pathToFileURL(path.resolve(file)).href, { waitUntil: 'load', timeout: 60000 });
      await page.locator('#pathway-search').waitFor({ state: 'visible' });
      const data = await page.evaluate(() => {
        const value = window.__PNV_DATA__;
        const low = value.pathways.find(row => (value.evidence.pathways[row.pathwayId || row.key]?.bootstrap?.validFraction ?? 1) < 0.9);
        return { pathways: value.pathways.length, condition: value.reportCondition,
          status: value.evidence.verification.status, low: low ? { key: low.key, name: low.pathwayName } : null };
      });
      assert.equal(data.pathways, receipt.cohorts[cohort.key].enrichmentParity.pathways);
      assert.equal(data.condition, condition);
      assert.equal(data.status, 'verified_against_supplied_artifacts');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (cohort.key === manifest.primaryCohortKey && condition === 'full') {
        for (const format of ['svg', 'png', 'pdf']) {
          await page.locator('#export-format').selectOption(format);
          const [download] = await Promise.all([
            Promise.race([
              page.waitForEvent('download', { timeout: 90000 }),
              page.waitForEvent('dialog', { timeout: 90000 }).then(async dialog => {
                const message = dialog.message(); await dialog.dismiss(); throw new Error(message);
              }),
            ]),
            page.locator('#export-button').click(),
          ]);
          const destination = path.join(output, `${cohort.key}.${format}`);
          await download.saveAs(destination);
          assert.ok((await fs.stat(destination)).size > 100);
        }
      }
      if (condition === 'full' && data.low) {
        await page.locator('#pathway-search').fill(data.low.name);
        await page.locator(`[data-pathway-key=${JSON.stringify(data.low.key)}]`).click();
        assert.match(await page.locator('#pathway-evidence').innerText(), /90%/);
      }
      await page.screenshot({ path: path.join(output, `${cohort.key}.${condition}.png`), fullPage: false });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(100);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      assert.deepEqual(requests, []);
      checks.push({ cohort: cohort.key, condition, pathways: data.pathways, pageErrors: 0,
        remoteRequests: 0, layouts: ['desktop', 'mobile'], lowValidityWarningChecked: condition === 'full' && Boolean(data.low) });
      await context.close();
    }
  }
} finally { await browser.close(); }
await fs.writeFile(path.join(output, 'verification.json'), JSON.stringify({ passed: true, checks }, null, 2));
console.log(JSON.stringify({ passed: true, reports: checks.length, checks }, null, 2));
