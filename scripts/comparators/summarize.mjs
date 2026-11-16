#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const output = path.resolve(process.argv[2] || 'paper/outputs/publication_2026_11_16/comparators/execution-2');
const results = [];
for (const tool of ['GeneTonic', 'RNAmel']) for (const mode of ['matched', 'defaults']) {
  const file = path.join(output, `${tool.toLowerCase()}-${mode}`, 'metrics.json');
  if (fs.existsSync(file)) results.push(JSON.parse(fs.readFileSync(file, 'utf8')));
}
if (!results.length) throw new Error('No observed comparator metrics exist.');
const fields = ['tool', 'version', 'mode', 'upstreamMode', 'completed', 'dataOrigin', 'elapsedSeconds', 'reportBytes', 'peakMemoryBytes', 'offlineBrowserVerified', 'runnerSha256'];
const summary = { schemaVersion: 2, status: 'descriptive-execution-evidence',
  limitation: 'Single executions under the recorded environment/workload; no controlled speed or user-performance superiority claim.', results };
fs.writeFileSync(path.join(output, 'benchmark.json'), JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(output, 'benchmark.tsv'), `${fields.join('\t')}\n${results.map(row => fields.map(field => row[field] ?? '').join('\t')).join('\n')}\n`);
const taskRows = results.flatMap(result => (result.offlineCheck?.observedTasks ?? []).map(task => ({ tool: result.tool, mode: result.mode, task: task.task, status: task.status })));
fs.writeFileSync(path.join(output, 'task-completion.tsv'), 'tool\tmode\ttask\tstatus\n' + taskRows.map(row => [row.tool,row.mode,row.task,row.status].join('\t')).join('\n') + '\n');
console.log(JSON.stringify({ executions: results.length, completed: results.filter(row => row.completed).length, observedTasks: taskRows.length }));
