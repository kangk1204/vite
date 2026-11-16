// Usage: node tests/e2e/combined-export-layout.mjs [path/to/published/full-PD.report.html]
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const started = performance.now();
const root = fileURLToPath(new URL('../../', import.meta.url));
const directory = path.join(root, '.cache/verification/combined-export-layout');
const original = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'paper/outputs/publication_v2/reports/gse68719_pd_primary.report.html');
const report = path.join(directory, 'gse68719_pd_primary.maintenance.report.html');
const presets = { '2-column': [7.2, 4.8], '1-column': [3.54, 2.7], slide: [13.33, 7.5] };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const pdfTextTool = process.env.PNV_PDFTOTEXT || 'pdftotext';
const pdfRasterTool = process.env.PNV_PDFTOPPM || 'pdftoppm';

async function refreshRuntimeOnly() {
  const html = await fs.readFile(original, 'utf8');
  const marker = '\n      window.__PNV_DATA__ = ';
  const start = html.indexOf(marker), end = html.indexOf(';\n    </script>', start);
  assert.ok(start > 0 && end > start && html.indexOf(marker, start + marker.length) === -1, 'Expected one frozen viewer assignment');
  const open = html.indexOf('<script>', end) + '<script>'.length;
  const close = html.lastIndexOf('</script>');
  assert.ok(open > end && close > open && html.slice(open).trimStart().startsWith('(function'), 'Expected final embedded report runtime');
  const runtimeSource = await fs.readFile(path.join(root, 'src/report/runtime.js'), 'utf8');
  const runtime = runtimeSource.replace(/<\/script/gi, '<\\/script');
  const fresh = html.slice(0, open) + runtime + html.slice(close);
  const assignmentStart = start + marker.indexOf('window.');
  const frozenAssignment = html.slice(assignmentStart, end + 1);
  assert.equal(fresh.slice(assignmentStart, end + 1), frozenAssignment);
  await fs.writeFile(report, fresh);
  return { originalFile: path.basename(original), originalSha256: hash(html), maintenanceSha256: hash(fresh),
    viewerAssignmentSha256: hash(frozenAssignment), viewerJsonSha256: hash(html.slice(start + marker.length, end)),
    runtimeSourceSha256: hash(runtimeSource), embeddedRuntimeSha256: hash(runtime) };
}

async function download(page, preset, format, prefix) {
  await page.selectOption('#export-preset', preset);
  await page.selectOption('#export-format', format);
  const [result] = await Promise.all([page.waitForEvent('download', { timeout: 60000 }), page.locator('#export-button').click()]);
  const filename = path.join(directory, `${prefix}.${format}`);
  await result.saveAs(filename);
  return filename;
}

function inspectGeometry() {
  const rootSvg = document.documentElement;
  const { width, height } = rootSvg.viewBox.baseVal;
  const topLevel = selector => [...rootSvg.querySelectorAll(selector)].filter(el => el.ownerSVGElement === rootSvg);
  const cards = topLevel('rect').filter(el => el.getAttribute('fill') === '#f8fbff');
  const texts = topLevel('text');
  const panels = topLevel('svg');
  const box = el => {
    const { x, y, width, height } = el.getBBox();
    return { x, y, right: x + width, bottom: y + height };
  };
  const issues = [];
  const follows = (a, b) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (cards.length !== 2 || panels.length !== 2) throw new Error('Expected two visible cards and their nested artwork.');
  const firstTop = Math.min(...cards.map(card => box(card).y));
  for (const el of texts) {
    const b = box(el), caption = el.textContent.trim();
    if (b.x < -0.1 || b.right > width + 0.1 || b.y < -0.1 || b.bottom > height + 0.1) issues.push(`Canvas overflow: ${caption}`);
    if (follows(el, cards[0]) && b.bottom > firstTop - 1) issues.push(`Header crosses card top: ${caption}`);
  }
  for (let index = 0; index < cards.length; index++) {
    const card = cards[index], bounds = box(card), panel = panels[index];
    const x = panel.x.baseVal.value, y = panel.y.baseVal.value;
    const bodyRight = x + panel.width.baseVal.value, bodyBottom = y + panel.height.baseVal.value;
    if (x < bounds.x || y < bounds.y || bodyRight > bounds.right + 0.1 || bodyBottom > bounds.bottom + 0.1 || panel.height.baseVal.value < 20) issues.push(`Invalid artwork bounds in panel ${index + 1}`);
    for (const el of texts.filter(t => follows(card, t) && follows(t, panel))) {
      const b = box(el);
      if (b.x < bounds.x + 1 || b.right > bounds.right - 1 || b.y < bounds.y + 1 || b.bottom > y - 1) issues.push(`Panel label outside its area: ${el.textContent.trim()}`);
    }
  }
  const extents = texts.map(el => ({ text: el.textContent.trim(), ...box(el) }));
  for (let i = 0; i < extents.length; i++) for (const b of extents.slice(i + 1)) {
    const a = extents[i];
    if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 0.5 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 0.5) issues.push(`Overlapping labels: ${a.text} / ${b.text}`);
  }
  const curve = panels[1].querySelector('path[stroke-linejoin="round"]');
  const matrix = rootSvg.getScreenCTM().inverse().multiply(curve.getScreenCTM());
  const mapped = (x,y) => new DOMPoint(x,y).matrixTransform(matrix);
  const curveBox = curve.getBBox(), upper = mapped(curveBox.x, curveBox.y), lower = mapped(curveBox.x+curveBox.width, curveBox.y+curveBox.height);
  const peak = panels[1].querySelector('circle'), peakPoint = mapped(peak.cx.baseVal.value, peak.cy.baseVal.value);
  return { width, height, physicalWidth: rootSvg.getAttribute('width'), physicalHeight: rootSvg.getAttribute('height'), textExtents: extents,
    curve: { left: upper.x/width, right: lower.x/width, top: upper.y/height, bottom: lower.y/height, peakX: peakPoint.x/width, peakY: peakPoint.y/height }, issues };
}

async function inspectPdfRaster(page, file, bounds) {
  const out = file.replace(/\.pdf$/, '.pdf-preview');
  execFileSync(pdfRasterTool, ['-r','150','-png','-singlefile',file,out], { stdio:'pipe' });
  const png = await fs.readFile(out + '.png');
  return page.evaluate(async ({data, bounds}) => {
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const {width:w,height:h} = bitmap, ctx = new OffscreenCanvas(w,h).getContext('2d'); ctx.drawImage(bitmap,0,0);
    const pixels = ctx.getImageData(0,0,w,h).data;
    const box = bounds || {left:0,right:1,top:0,bottom:1};
    const columns = new Set(), rows = new Set(); let peak = false;
    for (let y=Math.max(0,Math.floor(box.top*h)-2); y<Math.min(h,Math.ceil(box.bottom*h)+3); y++) {
      for (let x=Math.max(0,Math.floor(box.left*w)-2); x<Math.min(w,Math.ceil(box.right*w)+3); x++) {
        const i=(y*w+x)*4, r=pixels[i], g=pixels[i+1], b=pixels[i+2];
        if(r<90 && b>170 && b-r>100 && b-g>60){columns.add(x);rows.add(y);}
        if(bounds && Math.abs(x-bounds.peakX*w)<3 && Math.abs(y-bounds.peakY*h)<3 && r<55 && g<70 && b<100) peak=true;
      }
    }
    return {blueColumnCoverage:columns.size/(w*(box.right-box.left)),blueRowCoverage:rows.size/(h*(box.bottom-box.top)),peakMarkerDetected:peak};
  }, {data:png.toString('base64'),bounds});
}

async function inspectStandaloneHeader(page, file) {
  const bbox = execFileSync(pdfTextTool, ['-bbox', file, '-'], {encoding: 'utf8'});
  const image = await fs.readFile(file.replace(/\.pdf$/, '.pdf-preview.png'));
  return page.evaluate(async ({bbox, data}) => {
    const doc = new DOMParser().parseFromString(bbox, 'application/xml');
    const source = doc.querySelector('page'), words = [...source.querySelectorAll('word')];
    const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const context = new OffscreenCanvas(bitmap.width, bitmap.height).getContext('2d');
    context.drawImage(bitmap, 0, 0);
    const scaleX = bitmap.width / Number(source.getAttribute('width'));
    const scaleY = bitmap.height / Number(source.getAttribute('height'));
    return ['Reactome', 'NES', 'Hits'].map(label => {
      const first = words.find(word => word.textContent === label);
      if (!first) throw new Error(`Standalone PDF lacks ${label}`);
      const row = words.filter(word => word.getAttribute('yMin') === first.getAttribute('yMin') && word.textContent !== '·');
      const obscured = row.filter(word => {
        const coord = key => Number(word.getAttribute(key));
        const x = Math.floor(coord('xMin') * scaleX), y = Math.floor(coord('yMin') * scaleY);
        const w = Math.ceil(coord('xMax') * scaleX) - x, h = Math.ceil(coord('yMax') * scaleY) - y;
        const pixels = context.getImageData(x, y, w, h).data;
        let ink = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          if (pixels[i] < 145 && pixels[i + 1] < 155 && pixels[i + 2] < 175) ink++;
        }
        return ink < w * h * 0.04;
      });
      return {text: row.map(word => word.textContent).join(' '), obscured: obscured.map(word => word.textContent)};
    });
  }, {bbox, data: image.toString('base64')});
}

await fs.mkdir(directory, { recursive: true });
const binding = await refreshRuntimeOnly();
const browser = await chromium.launch({ headless: true });
const records = [];
try {
  const context = await browser.newContext({ offline: true, viewport: { width: 1440, height: 960 } });
  let page = await context.newPage();
  const checkPage = await context.newPage();
  const errors = [], requests = [];
  context.on('page', p => p.on('pageerror', error => errors.push(error.message)));
  for (const p of [page, checkPage]) p.on('pageerror', error => errors.push(error.message));
  context.on('request', r => { if (/^https?:/.test(r.url())) requests.push(r.url()); });
  await page.goto(pathToFileURL(report).href, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => document.querySelectorAll('canvas').length > 0);
  const defaultName = await page.locator('#current-pathway-name').innerText();
  const longest = await page.evaluate(() => window.__PNV_DATA__.pathways.reduce((a, b) => a.pathwayName.length > b.pathwayName.length ? a : b).pathwayName);
  const unicodeName = 'Activation of IRF3, IRF7 mediated by TBK1, IKKε (IKBKE)';
  for (const [kind, name] of [['default', defaultName], ['long-title', longest], ['unicode', unicodeName]]) {
    if (kind !== 'default') {
      // Chromium rate-limits repeated downloads per page after ten files.
      await page.close();
      page = await context.newPage();
      await page.goto(pathToFileURL(report).href, { waitUntil: 'load', timeout: 90000 });
      await page.locator('#pathway-search').fill(name);
      const button = page.locator('[data-pathway-key]').filter({ hasText: name }).first();
      await button.click();
      assert.equal(await page.locator('#current-pathway-name').innerText(), name);
    }
    const expected = await page.evaluate(name => {
      const p = window.__PNV_DATA__.pathways.find(item => item.pathwayName === name);
      const project = window.__PNV_DATA__.project;
      return { nes: p.nes, fdr: p.padj, hits: p.enrichment.hitIndices.length, contrast: `${project.conditionA} to ${project.conditionB}` };
    }, name);
    for (const [preset, inches] of Object.entries(presets)) {
      if (kind === 'unicode' && preset !== '2-column') continue;
      const prefix = `${kind}.${preset}`;
      const svg = await download(page, preset, 'svg', prefix);
      await checkPage.goto(pathToFileURL(svg).href);
      const geometry = await checkPage.evaluate(inspectGeometry);
      const record = { pathway: name, preset, expected, geometry }; records.push(record);
      assert.ok(Math.abs(geometry.width - inches[0] * 72) < 0.001 && Math.abs(geometry.height - inches[1] * 72) < 0.001);
      assert.equal(geometry.physicalWidth, `${inches[0] * 72}pt`); assert.equal(geometry.physicalHeight, `${inches[1] * 72}pt`);
      const caption = geometry.textExtents.map(e => e.text).join(' ');
      assert.ok(caption.includes(name) && caption.includes(expected.contrast), 'Complete pathway and contrast must remain visible');
      const stats = /NES\s+([\d.eE+-]+)\s+·\s+FDR\s+([\d.eE+-]+)/.exec(caption);
      assert.ok(stats, 'NES and FDR must appear in the drawn header');
      assert.equal(Number(stats[1]), Number(expected.nes.toFixed(2)));
      assert.equal(Number(stats[2]), Number(expected.fdr.toExponential(2)));
      assert.equal(Number(/\bHits\s+(\d+)/.exec(caption)?.[1]), expected.hits);
      if (kind !== 'long-title') {
        const file = await download(page, preset, 'png', prefix), pixels = await fs.readFile(file);
        record.png = { width: pixels.readUInt32BE(16), height: pixels.readUInt32BE(20) };
        assert.deepEqual([record.png.width, record.png.height], inches.map(value => Math.round(value * 300)));
        const pdfFile = await download(page, preset, 'pdf', prefix);
        const pdf = await fs.readFile(pdfFile);
        const content = pdf.toString('latin1'), dimensions = /\/MediaBox\s*\[0\s+0\s+([\d.]+)\s+([\d.]+)\]/.exec(content);
        assert.ok(dimensions, 'Expected PDF page dimensions');
        record.pdf = { width: Number(dimensions[1]), height: Number(dimensions[2]) };
        if (Math.abs(record.pdf.width - inches[0] * 72) > 0.1 || Math.abs(record.pdf.height - inches[1] * 72) > 0.1) geometry.issues.push('PDF MediaBox differs from the figure preset');
        if (kind === 'unicode') {
          assert.ok(content.includes('/Subtype /Image') && content.includes('Rasterized at 300 dpi to preserve Unicode labels'));
          record.pdf.rendering = 'Unicode raster at 300 dpi';
        } else {
          const text = execFileSync(pdfTextTool, ['-layout', pdfFile, '-'], { encoding: 'utf8' }).replace(/\s+/g, ' ');
          for (const phrase of [expected.contrast, name, 'NETWORK VIEW', 'GSEA ENRICHMENT', 'Node size -log10(FDR)']) assert.ok(text.includes(phrase), `PDF lacks expected text: ${phrase}`);
          record.pdf.rendering = 'vector with extractable text';
        }
        record.pdf.curvePixels = await inspectPdfRaster(checkPage, pdfFile, geometry.curve);
        if (record.pdf.curvePixels.blueColumnCoverage < 0.9 || record.pdf.curvePixels.blueRowCoverage < 0.9 || !record.pdf.curvePixels.peakMarkerDetected) geometry.issues.push('Rendered PDF is missing the recorded enrichment curve or peak marker');
      }
    }
  }
  // Plot-only PDF uses the same enrichment SVG generator. Check the actual rendered ink.
  await page.locator('#pathway-search').fill(defaultName);
  await page.locator('[data-pathway-key]').filter({hasText:defaultName}).first().click();
  await page.selectOption('#export-target','plot');
  const [plotDownload] = await Promise.all([page.waitForEvent('download'),page.locator('#export-button').click()]);
  const plotFile = path.join(directory,'standalone-plot.pdf'); await plotDownload.saveAs(plotFile);
  const standalonePlot = await inspectPdfRaster(checkPage,plotFile,null);
  standalonePlot.headerRows = await inspectStandaloneHeader(checkPage, plotFile);
  assert.deepEqual(standalonePlot.headerRows.flatMap(row => row.obscured), [], 'Standalone plot must visibly draw every source statistic above its card');
  assert.ok(standalonePlot.blueColumnCoverage > 0.60 && standalonePlot.blueRowCoverage > 0.10,'Standalone PDF must display the enrichment curve');
  assert.deepEqual(errors, []); assert.deepEqual(requests, []);
  const issues = records.flatMap(record => record.geometry.issues.map(issue => `${record.preset}: ${issue}`));
  await fs.writeFile(path.join(directory, 'geometry.json'), JSON.stringify({ passed: !issues.length, binding, elapsedSeconds: (performance.now()-started)/1000, records, standalonePlot, pageErrors: errors, remoteRequests: requests }, null, 2));
  assert.deepEqual(issues, [], 'Export labels, cards, artwork and PDF pages must fit at every preset');
  console.log(JSON.stringify({ passed: true, directory, ...binding, elapsedSeconds: (performance.now()-started)/1000, cases: records.length }));
} finally { await browser.close(); }
