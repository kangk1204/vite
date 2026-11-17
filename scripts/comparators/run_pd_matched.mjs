#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import os from 'node:os';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const tools = ['GeneTonic', 'RNAmel'], modes = ['matched'];

export function runBenchmark(fixtureArg, outputArg, selectedTool, selectedMode, { execute = spawnSync } = {}) {
  if (!fixtureArg || !outputArg) throw new Error('Usage: run_pd_matched.mjs fixture.rds output-directory [GeneTonic|RNAmel] [matched|defaults]');
  if ((selectedTool && !tools.includes(selectedTool)) || (selectedMode && !modes.includes(selectedMode))) throw new Error('Unknown tool or mode.');
  const fixture = path.resolve(fixtureArg), output = path.resolve(outputArg);
  if (!fs.statSync(fixture).isFile()) throw new Error('Fixture must be a file.');
  const prepared = JSON.parse(fs.readFileSync(fixture + '.json', 'utf8'));
  if (prepared.fixtureSha256 !== sha256(fixture)) throw new Error('Fixture differs from its preparation receipt.');
  fs.mkdirSync(output, { recursive: true });
  const context = {
    platform: process.platform, architecture: process.arch, cpuModel: os.cpus()[0]?.model,
    logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem(), initialLoadAverage: os.loadavg(),
    design: 'One observed execution per tool/mode in fixed order. Timings describe this workload.',
  };
  const results = [];
  for (const tool of selectedTool ? [selectedTool] : tools) for (const mode of selectedMode ? [selectedMode] : modes) {
    const directory = path.join(output, `${tool.toLowerCase()}-${mode}`);
    if (fs.existsSync(directory)) throw new Error(`Run directory already exists: ${directory}. Choose a new output directory.`);
    fs.mkdirSync(directory);
    const executedSources = [['run_pd_comparator.R', 'runner.snapshot.R'], ['fixture_support.R', 'fixture_support.R'], ['pd_native_input.R', 'pd_native_input.R']].map(([original, destination]) => {
      const source = path.join(root, 'scripts/comparators', original), target = path.join(directory, destination);
      fs.copyFileSync(source, target, fs.constants.COPYFILE_EXCL);
      return { original: `scripts/comparators/${original}`, path: destination, sha256: sha256(target), bytes: fs.statSync(target).size };
    });
    const args = [path.join(directory, 'runner.snapshot.R'), tool, fixture, directory, mode];
    const nativeCommand = ['Rscript', ...args];
    const timeArgs = process.platform === 'darwin' ? ['-l'] : ['-v'];
    const timed = fs.existsSync('/usr/bin/time');
    const executable = timed ? '/usr/bin/time' : 'Rscript';
    const executedArgs = timed ? [...timeArgs, ...nativeCommand] : args;
    const began = new Date().toISOString();
    const run = execute(executable, executedArgs, { cwd: root, encoding: 'utf8', timeout: 1200000, maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, OMP_NUM_THREADS: '1', OPENBLAS_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1' } });
    fs.writeFileSync(path.join(directory, 'execution.log'), `${run.stdout ?? ''}\n${run.stderr ?? ''}`);
    const metricsPath = path.join(directory, 'metrics.json');
    const observed = run.status === 0 && fs.existsSync(metricsPath) ? JSON.parse(fs.readFileSync(metricsPath, 'utf8')) : {};
    const memory = process.platform === 'darwin' ? run.stderr?.match(/(\d+)\s+maximum resident set size/) : run.stderr?.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
    const sourcesIntact = executedSources.every(source => sha256(path.join(directory, source.path)) === source.sha256);
    const fixtureIntact = sha256(fixture) === prepared.fixtureSha256;
    const actualArtifacts = [...new Set([...(observed.artifacts ?? []).map(a => a.path), ...executedSources.map(a => a.path), 'execution.log'])].map(name => {
      if (path.basename(name) !== name) throw new Error('Comparator output artifact must be run-directory-relative.');
      const file = path.join(directory, name);
      return { path: name, sha256: sha256(file), bytes: fs.statSync(file).size };
    });
    const result = {
      ...observed, schemaVersion: 2, tool, mode, completed: run.status === 0 && observed.completed === true && sourcesIntact && fixtureIntact,
      exitCode: run.status, failure: run.error?.message ?? (run.status === 0 && sourcesIntact && fixtureIntact ? null : 'See execution.log and integrity checks.'),
      startedAt: began, finishedAt: new Date().toISOString(),
      peakMemoryBytes: memory ? Number(memory[1]) * (process.platform === 'darwin' ? 1 : 1024) : null,
      command: nativeCommand, measuredCommand: [executable, ...executedArgs],
      replayCommand: ['node', 'scripts/comparators/run_pd_matched.mjs', fixtureArg, '<new-output-directory>', tool, mode],
      runnerSha256: executedSources[0].sha256, executedSources,
      fixtureSha256: prepared.fixtureSha256, fixtureReceiptSha256: sha256(fixture + '.json'),
      fixtureIntegrityAfterRun: fixtureIntact, executedSourceIntegrityAfterRun: sourcesIntact,
      artifacts: actualArtifacts, executionContext: context,
      manualSteps: observed.manualSteps ?? { scope: 'Automated invocation', observedInterventions: 0, interactivePrompts: 0, humanOperatorTimeSeconds: null },
    };
    write(metricsPath, result); results.push(result);
    console.log(`${tool} ${mode}: ${result.completed ? 'completed' : 'failed'}`);
  }
  const summary = { schemaVersion: 2, status: 'observed-descriptive-execution', executionContext: context, results };
  write(path.join(output, 'benchmark.json'), summary);
  const fields = ['tool', 'version', 'mode', 'completed', 'dataOrigin', 'elapsedSeconds', 'reportBytes', 'peakMemoryBytes', 'offlineBrowserVerified'];
  fs.writeFileSync(path.join(output, 'benchmark.tsv'), `${fields.join('\t')}\n${results.map(row => fields.map(field => row[field] ?? '').join('\t')).join('\n')}\n`);
  return summary;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = runBenchmark(...process.argv.slice(2));
    if (result.results.some(row => !row.completed)) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
