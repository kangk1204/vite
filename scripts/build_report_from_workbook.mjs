#!/usr/bin/env node
// The CLI and browser intentionally use the same workbook parser and report renderer.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { verifyArtifacts } from './lib/provenance.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROVENANCE_OPTIONS = {
  'dataset-id': 'datasetIdentifier', 'contrast-definition': 'contrastDefinition',
  'sample-group-source': 'sampleGroupSource', 'batch-handling-rule': 'batchHandlingRule',
  'analysis-timestamp': 'analysisTimestamp', 'git-commit': 'gitCommit',
  'reference-asset-version': 'referenceAssetVersion', notes: 'notes',
};

export function parseCliArgs(argv) {
  const positional = [], options = {};
  const allowed = new Set(['evidence', 'viewer-json', 'condition', ...Object.keys(PROVENANCE_OPTIONS)]);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) { positional.push(token); continue; }
    const key = token.slice(2), value = argv[++index];
    if (!allowed.has(key)) throw new Error(`Unknown option --${key}`);
    if (!value || value.startsWith('--')) throw new Error(`Missing value for --${key}`);
    options[key] = value;
  }
  if (positional.length > 2) throw new Error('Expected input workbook and optional output HTML path.');
  if (options.condition && !['full', 'basic'].includes(options.condition)) throw new Error('--condition must be full or basic.');
  return { positional, options };
}

export async function buildReport(inputPath, outputPath, options = {}) {
  const input = path.resolve(inputPath), output = path.resolve(outputPath);
  if (input === output || (options['viewer-json'] && path.resolve(options['viewer-json']) === input)) throw new Error('Output paths must not overwrite the input workbook.');
  if (options['viewer-json'] && path.resolve(options['viewer-json']) === output) throw new Error('HTML and viewer JSON outputs must be different files.');
  if (options.evidence && [output, options['viewer-json'] && path.resolve(options['viewer-json'])].includes(path.resolve(options.evidence))) throw new Error('Output paths must not overwrite the evidence sidecar.');
  const server = await createServer({
    root: ROOT, configFile: false, mode: 'test', appType: 'custom', logLevel: 'error',
    // hmr:false alone still creates Vite's WebSocket transport in middleware mode.
    // This one-shot SSR loader must open neither network listeners nor file watchers.
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    const [workbooks, reports, contract] = await Promise.all([
      server.ssrLoadModule('/src/lib/workbook.ts'), server.ssrLoadModule('/src/lib/reportHtml.ts'), server.ssrLoadModule('/src/lib/evidence.ts'),
    ]);
    let parsed;
    if (path.extname(input).toLowerCase() === '.json') {
      const viewerData = contract.parseViewerDataJson(JSON.parse(fs.readFileSync(input, 'utf8')));
      parsed = { viewerData, issues: viewerData.issues, summary: { totalPathways: viewerData.pathways.length } };
    } else {
      await workbooks.ensureWorkbookRuntimeReady();
      const bytes = fs.readFileSync(input);
      parsed = workbooks.parseWorkbookBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    }
    if (!parsed.viewerData || parsed.issues.some(issue => issue.level === 'error')) {
      throw new Error(`Invalid input: ${parsed.issues.map(issue => issue.message).join('; ')}`);
    }
    let viewer = parsed.viewerData;
    const overrides = Object.fromEntries(Object.entries(PROVENANCE_OPTIONS).filter(([key]) => options[key] !== undefined).map(([key, field]) => [field, options[key]]));
    if (Object.keys(overrides).length) viewer = { ...viewer, provenance: { ...viewer.provenance, ...overrides } };
    if (options.evidence) {
      const evidencePath = path.resolve(options.evidence);
      const imported = contract.parseEvidenceSidecar(JSON.parse(fs.readFileSync(evidencePath, 'utf8')));
      const verified = verifyArtifacts(imported.artifacts, { root: path.dirname(evidencePath), projectRoot: ROOT });
      const actualHash = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
      const workbookArtifact = imported.artifacts.find(artifact => artifact.role === 'workbook');
      const matchesWorkbook = workbookArtifact?.sha256 === actualHash;
      const contrastMatches = imported.analysis.contrast.conditionA === viewer.project.conditionA && imported.analysis.contrast.conditionB === viewer.project.conditionB;
      const checks = [...imported.verification.checks, ...verified.checks,
        { id: 'rendered_input', status: !workbookArtifact ? 'unknown' : matchesWorkbook ? 'pass' : 'fail', message: !workbookArtifact ? 'The supplied evidence does not identify this report input.' : matchesWorkbook ? 'Report input matches the recorded workbook digest.' : 'Report input differs from the recorded workbook digest.' },
        { id: 'report_contrast', status: contrastMatches ? 'pass' : 'fail', message: contrastMatches ? 'Evidence and displayed contrast agree.' : 'Evidence and displayed contrast differ.' },
      ];
      const status = checks.some(check => check.status === 'fail') ? 'mismatch' : matchesWorkbook ? verified.status : 'unverifiable';
      const limitations = [...new Set([...imported.verification.limitations.filter(message => !message.includes('not been rechecked during this import')), ...verified.limitations])];
      const evidence = {
        ...imported,
        sourceTables: { ...viewer.evidence?.sourceTables, ...imported.sourceTables },
        pathways: Object.fromEntries(viewer.pathways.map(p => {
          const key = p.pathwayId || p.key;
          return [key, { source: p.source, ...(imported.pathways[key] || imported.pathways[p.key] || {}) }];
        })),
        verification: { status, checks, limitations },
      };
      viewer = { ...viewer, schemaVersion: 2, evidence };
    }
    viewer = reports.prepareViewerDataForReport({ ...viewer, reportCondition: options.condition || viewer.reportCondition || 'full' });
    const html = await reports.createReportHtml(viewer);
    fs.mkdirSync(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    try { fs.writeFileSync(temporary, html, 'utf8'); fs.renameSync(temporary, output); }
    finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    if (options['viewer-json']) {
      const filename = path.resolve(options['viewer-json']);
      fs.mkdirSync(path.dirname(filename), { recursive: true });
      const temporaryJson = `${filename}.${process.pid}.tmp`;
      try { fs.writeFileSync(temporaryJson, JSON.stringify(viewer), 'utf8'); fs.renameSync(temporaryJson, filename); }
      finally { if (fs.existsSync(temporaryJson)) fs.unlinkSync(temporaryJson); }
    }
    return { ...parsed, viewerData: viewer, outputPath: output };
  } finally { await server.close(); }
}

async function main() {
  const cli = parseCliArgs(process.argv.slice(2));
  const inputPath = cli.positional[0];
  if (!inputPath) throw new Error('Usage: node scripts/build_report_from_workbook.mjs input.xlsx [output.report.html] [--evidence evidence.json] [--viewer-json viewer.json] [--condition full|basic]');
  const outputPath = cli.positional[1] || path.join(path.dirname(inputPath), `${path.basename(inputPath, path.extname(inputPath))}.report.html`);
  const result = await buildReport(inputPath, outputPath, cli.options);
  console.log(`Wrote report: ${result.outputPath}`);
  console.log(`Pathways: ${result.viewerData.pathways.length}; verification: ${result.viewerData.evidence.verification.status}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
