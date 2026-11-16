import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {build, preview} from 'vite';
import {chromium} from 'playwright';

const inputs = process.argv.slice(2).map(file => path.resolve(file));
if (!inputs.length) throw new Error('Pass the real revised workbook paths to audit browser imports.');
const directory = path.resolve('.cache/revision-2026-11-16/ui/large-workbook');
const buildDirectory = path.join(directory, 'build');
await fs.mkdir(directory, {recursive:true});
let server, browser;
const checks = [], errors = [], remote = [];
try {
  await build({logLevel:'warn',build:{outDir:buildDirectory,emptyOutDir:true}});
  server = await preview({logLevel:'warn',build:{outDir:buildDirectory},preview:{host:'127.0.0.1',port:0}});
  browser = await chromium.launch({headless:true});
  for (const input of inputs) {
    const bytes = await fs.readFile(input), started = performance.now();
    assert.ok(bytes.length <= 64 * 1024 * 1024, 'Supported workbook must fit the shared 64 MiB budget');
    const context = await browser.newContext({viewport:{width:1280,height:1000}});
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {if (/^https?:/.test(request.url()) && !request.url().startsWith(server.resolvedUrls.local[0])) remote.push(request.url());});
    await page.goto(server.resolvedUrls.local[0] + 'builder.html');
    await page.getByLabel('Import analysis results').setInputFiles(input);
    await page.getByText('Imported results: ' + path.basename(input), {exact:true}).waitFor({timeout:180000});
    assert.equal(await page.getByText(/Failed to import results/).count(),0);
    assert.equal(await page.getByRole('button',{name:'Download report.html'}).isEnabled(),true);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({path:path.join(directory,path.basename(input)+'.png'),fullPage:true});
    checks.push({file:input,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),elapsedSeconds:(performance.now()-started)/1000});
    await context.close();
  }
  assert.deepEqual(errors,[]); assert.deepEqual(remote,[]);
  await fs.writeFile(path.join(directory,'verification.json'),JSON.stringify({passed:true,checks,errors,remote},null,2));
  console.log(JSON.stringify({passed:true,checks,errors,remote}));
} finally {
  if(browser)await browser.close();
  if(server)await new Promise(resolve=>server.httpServer.close(resolve));
}
