#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

const [fixtureArg, outputArg, selectedTool, selectedMode] = process.argv.slice(2);
if (!fixtureArg || !outputArg) throw new Error('Usage: benchmark.mjs fixture.rds output-directory [GeneTonic|RNAmel] [matched|defaults]');
if (selectedTool && !['GeneTonic', 'RNAmel'].includes(selectedTool) || selectedMode && !['matched', 'defaults'].includes(selectedMode)) throw new Error('Unknown selected tool or mode.');
const fixture = path.resolve(fixtureArg);
const output = path.resolve(outputArg);
if (!fs.statSync(fixture).isFile()) throw new Error('Fixture must be a file.');
fs.mkdirSync(output, { recursive: true });
let results = [];
for (const tool of ['GeneTonic', 'RNAmel']) for (const mode of ['matched', 'defaults']) {
  const existing = path.join(output, `${tool.toLowerCase()}-${mode}`, 'metrics.json');
  if (fs.existsSync(existing)) results.push(JSON.parse(fs.readFileSync(existing, 'utf8')));
}
const executionContext = { platform: process.platform, architecture: process.arch, cpuModel: os.cpus()[0]?.model,
  logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), initialLoadAverage: os.loadavg(),
  design: 'One execution per tool/mode, fixed order; descriptive execution evidence, not a controlled speed comparison.' };
for (const tool of selectedTool ? [selectedTool] : ['GeneTonic', 'RNAmel']) {
  for (const mode of selectedMode ? [selectedMode] : ['matched', 'defaults']) {
    const directory = path.join(output, `${tool.toLowerCase()}-${mode}`);
    fs.mkdirSync(directory, { recursive: true });
    const runnerSnapshot = path.join(directory, 'runner.snapshot.R');
    const runnerBytes = fs.readFileSync('scripts/comparators/run_comparator.R');
    fs.writeFileSync(runnerSnapshot, runnerBytes);
    const args = [runnerSnapshot, tool, fixture, directory, mode];
    const timed = fs.existsSync('/usr/bin/time');
    const timeArgs = process.platform === 'darwin' ? ['-l'] : ['-v'];
    const run = spawnSync(timed ? '/usr/bin/time' : 'Rscript', timed ? [...timeArgs, 'Rscript', ...args] : args,
      { encoding: 'utf8', timeout: 900000, maxBuffer: 32 * 1024 * 1024 });
    fs.writeFileSync(path.join(directory, 'execution.log'), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    const metricsPath = path.join(directory, 'metrics.json');
    const observed = run.status === 0 && fs.existsSync(metricsPath) ? JSON.parse(fs.readFileSync(metricsPath, 'utf8')) : {};
    const memory = process.platform === 'darwin'
      ? run.stderr?.match(/(\d+)\s+maximum resident set size/)
      : run.stderr?.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
    const result = { ...observed, tool, mode, completed: run.status === 0 && observed.completed === true,
      exitCode: run.status, failure: run.error?.message ?? (run.status === 0 ? null : 'See execution.log'),
      peakMemoryBytes: memory ? Number(memory[1]) * (process.platform === 'darwin' ? 1 : 1024) : null,
      command: ['Rscript', ...args], runnerSha256: createHash('sha256').update(runnerBytes).digest('hex'), executionContext, fixtureSha256: createHash('sha256').update(fs.readFileSync(fixture)).digest('hex') };
    results = [...results.filter(item => item.tool !== tool || item.mode !== mode), result];
    fs.writeFileSync(path.join(directory, 'metrics.json'), JSON.stringify(result, null, 2));
    console.log(`${tool} ${mode}: ${result.completed ? 'completed' : 'failed'}`);
  }
}
fs.writeFileSync(path.join(output, 'benchmark.json'), JSON.stringify({ schemaVersion: 1, executionContext, results }, null, 2));
const fields = ['tool', 'mode', 'completed', 'dataOrigin', 'elapsedSeconds', 'reportBytes', 'peakMemoryBytes', 'offlineBrowserVerified'];
fs.writeFileSync(path.join(output, 'benchmark.tsv'), `${fields.join('\t')}\n${results.map(r => fields.map(f => r[f] ?? '').join('\t')).join('\n')}\n`);
if (results.some(r => !r.completed)) process.exitCode = 1;
