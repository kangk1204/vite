#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const output = path.resolve(process.argv[2] || 'paper/outputs/publication_v2/comparators');
const results = [];
for (const tool of ['GeneTonic', 'RNAmel']) for (const mode of ['matched', 'defaults']) {
  const file = path.join(output, `${tool.toLowerCase()}-${mode}`, 'metrics.json');
  if (fs.existsSync(file)) results.push(JSON.parse(fs.readFileSync(file, 'utf8')));
}
if (!results.length) throw new Error('No observed comparator metrics exist.');
const fields = ['tool', 'version', 'mode', 'completed', 'dataOrigin', 'elapsedSeconds', 'reportBytes', 'peakMemoryBytes', 'offlineBrowserVerified'];
const summary = { schemaVersion: 1, status: 'descriptive-execution-evidence',
  limitation: 'Single executions under the recorded environment/workload; no controlled speed or user-performance superiority claim.', results };
fs.writeFileSync(path.join(output, 'benchmark.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(output, 'benchmark.tsv'), `${fields.join('\t')}\n${results.map(row => fields.map(field => row[field] ?? '').join('\t')).join('\n')}\n`);
console.log(JSON.stringify({ executions: results.length, completed: results.filter(row => row.completed).length }));
