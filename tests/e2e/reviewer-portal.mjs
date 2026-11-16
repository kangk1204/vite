import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('../../', import.meta.url));
const portal = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'paper/outputs/publication_v2/reviewer');
const artifacts = path.join(root, '.cache/verification/reviewer-portal');
const receipt = JSON.parse(await fs.readFile(path.join(portal, 'reviewer-package.json'), 'utf8'));
const archive = path.join(portal, receipt.archive);
const extracted = await fs.mkdtemp(path.join(os.tmpdir(), 'pnv-review-'));
const checks = [];
let browser;

try {
  await fs.mkdir(artifacts, { recursive: true });
  assert.equal(crypto.createHash('sha256').update(await fs.readFile(archive)).digest('hex'), receipt.sha256);
  const extract = `
import json, pathlib, sys, zipfile, shutil
archive, dest = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
def unpack(file, root):
    with zipfile.ZipFile(file) as z:
        assert z.testzip() is None
        for item in z.infolist():
            assert (root / item.filename).resolve().is_relative_to(root.resolve()) and not pathlib.PurePosixPath(item.filename).is_absolute()
        z.extractall(root)
unpack(archive, dest)
source = json.loads((dest / 'source/source-snapshot.json').read_text())
analysis = dest / 'analysis'
unpack(dest / 'source' / source['archive'], analysis)
cfg = json.loads((analysis / 'paper/configs/publication_v2/gse68719_pd_primary.json').read_text())
for key in ['rawCountsPath', 'seriesMatrixPath']:
    output = analysis / cfg[key]
    output.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(dest / 'inputs' / output.name, output)
assert (analysis / cfg['referencePath']).is_file()
assert (analysis / 'scripts/analyze_neural_bulk_cohort.R').is_file()
assert (analysis / 'scripts/validate_analysis_reference.R').is_file()
assert (analysis / 'renv.lock').is_file()
`;
  execFileSync('python3', ['-c', extract, archive, extracted]);
  const verified = execFileSync('python3', [path.join(extracted, 'verify_bundle.py')], { encoding: 'utf8' }).trim();
  checks.push({ check: 'fresh ZIP extraction, source archive, canonical PD inputs and SHA-256 inventory', result: verified });

  const example = JSON.parse(await fs.readFile(path.join(extracted, 'evidence/pathway-record.json'), 'utf8'));
  const open = file => pathToFileURL(path.join(extracted, file)).href;
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [], requests = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (/^https?:/i.test(request.url())) requests.push(request.url()); });
  let links = 0;
  for (const name of ['index.html', 'evidence.html', 'files.html', 'reproduce.html']) {
    await page.goto(open(name));
    const hrefs = await page.locator('a[href],link[href]').evaluateAll(nodes => nodes.map(node => node.getAttribute('href')));
    for (const href of hrefs) {
      const url = new URL(href, open(name));
      assert.equal(url.protocol, 'file:');
      const filename = fileURLToPath(url);
      assert.ok(filename.startsWith(`${extracted}${path.sep}`));
      assert.ok((await fs.stat(filename)).isFile(), `Missing linked file ${href}`);
      if (url.hash) assert.ok((await fs.readFile(filename, 'utf8')).includes(`id="${url.hash.slice(1)}"`), `Missing anchor ${href}`);
      links += 1;
    }
  }
  checks.push({ check: 'portable page links and source anchors', links });
  await page.goto(open('index.html'));
  await page.screenshot({ path: path.join(artifacts, 'home-desktop.png'), fullPage: true });
  for (const [linkName, id] of [[`Inspect fgsea row ${example.primary.row}`, 'fgsea'], ['Inspect the resampling record', 'bootstrap'], [`Inspect CAMERA row ${example.camera.row}`, 'camera']]) {
    await page.getByRole('link', { name: linkName, exact: true }).click();
    assert.equal(new URL(page.url()).hash, `#${id}`);
    const sourceText = await page.locator(`#${id}`).innerText();
    assert.ok(sourceText.includes(id === 'bootstrap' ? String(example.bootstrap.selected) : id === 'fgsea' ? example.primary.values.padj : example.camera.values.padj));
    await page.getByRole('navigation').getByRole('link', { name: 'Example', exact: true }).click();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  for (const name of ['index.html', 'evidence.html', 'files.html', 'reproduce.html']) {
    await page.goto(open(name));
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `Mobile overflow on ${name}`);
  }
  await page.goto(open('index.html'));
  await page.screenshot({ path: path.join(artifacts, 'home-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.getByRole('link', { name: /Open one-pathway report/ }).click();
  const sourceRow = page.locator('#pathway-evidence [data-source-table="pathways"]').first();
  await sourceRow.waitFor(); await sourceRow.click();
  assert.ok(await page.locator('#raw-evidence').evaluate(el => el.open));
  assert.equal(await page.locator('#source-table-select').inputValue(), 'pathways');
  for (const [file, count, verification] of [['interleukins.report.html', 1, 'internally_consistent'], ['gse68719_pd_primary.report.html', example.analysis.pathwayHypothesisCount, 'verified_against_supplied_artifacts']]) {
    await page.goto(open(`reports/${file}`), { waitUntil: 'load', timeout: 90000 });
    await page.waitForFunction(() => document.querySelectorAll('canvas').length > 0);
    const observed = await page.evaluate(id => {
      const data = window.__PNV_DATA__, pathway = data.pathways.find(p => p.pathwayId === id);
      return { count: data.pathways.length, fdr: pathway.padj, status: data.evidence.verification.status,
        pathwayId: pathway.pathwayId, selected: data.evidence.pathways[id].bootstrap.selected,
        denominator: data.evidence.pathways[id].bootstrap.valid, camera: data.evidence.pathways[id].camera.padj, ranks: data.rankedGenes.length };
    }, example.pathwayId);
    assert.equal(observed.count, count); assert.equal(observed.status, verification);
    assert.equal(observed.selected, example.bootstrap.selected); assert.equal(observed.denominator, example.bootstrap.valid);
    assert.equal(observed.camera, Number(example.camera.values.padj)); assert.equal(observed.ranks, example.analysis.geneHypothesisCount);
    assert.ok(Math.abs(observed.fdr / Number(example.primary.values.padj) - 1) < 1e-5, 'Report display rounding exceeds five significant digits');
    checks.push({ check: file, ...observed });
  }
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  const result = { passed: true, archive: receipt.archive, archiveSha256: receipt.sha256, sourceSnapshot: receipt.sourceSnapshot,
    offline: true, remoteRequests: requests.length, pageErrors: errors.length, checks };
  await fs.writeFile(path.join(artifacts, 'verification.json'), JSON.stringify(result, null, 2) + '\n');
  await fs.writeFile(path.join(portal, 'browser-verification.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  await fs.rm(extracted, { recursive: true, force: true });
}
