#!/usr/bin/env node
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const file = process.argv[2];
if (!file) throw new Error('Usage: check_offline.mjs comparator-metrics.json');
const metrics = JSON.parse(fs.readFileSync(file, 'utf8'));
if (!metrics.completed || !metrics.reportPath) throw new Error('A completed report is required.');
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({ offline: true });
  const page = await context.newPage();
  const errors = [];
  const remoteRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/.test(request.url())) remoteRequests.push(request.url()); });
  await page.goto(pathToFileURL(metrics.reportPath).href, { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(1000);
  const bodyLength = (await page.locator('body').innerText()).length;
  const result = { ...metrics, offlineBrowserVerified: bodyLength > 100 && errors.length === 0,
    offlineCheck: { browser: 'Chromium', bodyLength, pageErrors: errors, remoteRequests,
      scope: 'Initial report rendering only; exports and every widget are not certified by this check.' } };
  fs.writeFileSync(file, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.offlineCheck));
  if (!result.offlineBrowserVerified) process.exitCode = 1;
} finally { await browser.close(); }
