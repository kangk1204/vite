#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteJson } from './lib/provenance.mjs';
import { inspectDeliveryFiles } from './lib/delivery_inspection.mjs';

export function parseDeliveryArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    if (!['--handoff', '--analysis-record', '--delivery-root', '--out'].includes(flag) || !argv[index + 1]) throw new Error('Usage: inspect_delivery.mjs --handoff request.json --analysis-record result.json [--delivery-root directory] [--out inspection.json]');
    options[flag.slice(2)] = argv[index + 1];
  }
  if (!options.handoff || !options['analysis-record']) throw new Error('--handoff and --analysis-record are required.');
  if (options.out && [options.handoff, options['analysis-record']].map(file => path.resolve(file)).includes(path.resolve(options.out))) throw new Error('Inspection output must not overwrite an input.');
  return options;
}

export function main(argv) {
  const options = parseDeliveryArgs(argv);
  const result = inspectDeliveryFiles({ handoffPath: options.handoff, analysisRecordPath: options['analysis-record'], root: options['delivery-root'] });
  if (options.out) atomicWriteJson(path.resolve(options.out), result);
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
