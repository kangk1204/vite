// @vitest-environment node
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { runBenchmark } from '../../scripts/comparators/benchmark.mjs';

const temporary = [];
afterEach(() => temporary.splice(0).forEach(dir => fs.rmSync(dir, { recursive: true, force: true })));
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pnv-comparison-')); temporary.push(root);
  const input = path.join(root, 'fixture.rds'); fs.writeFileSync(input, 'software fixture');
  fs.writeFileSync(input + '.json', JSON.stringify({ fixtureSha256: createHash('sha256').update('software fixture').digest('hex') }));
  return { input, output: path.join(root, 'runs') };
}

describe('observed comparator execution receipts', () => {
  it('captures both executed source files, native outputs and the actual command', () => {
    const { input, output } = fixture();
    const summary = runBenchmark(input, output, 'RNAmel', 'matched', { execute(command, args) {
      const at = args.indexOf('RNAmel'); const directory = args[at + 2];
      fs.writeFileSync(path.join(directory, 'native.html'), '<html>native test</html>');
      fs.writeFileSync(path.join(directory, 'metrics.json'), JSON.stringify({ completed: true, reportPath:path.join(directory, 'native.html'), artifacts:[] }));
      return { status:0, stdout:'complete', stderr:'12345 maximum resident set size' };
    }});
    const run = summary.results[0];
    expect(run.completed).toBe(true);
    expect(run.runnerSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(run.executedSources).toHaveLength(2);
    expect(run.executedSources.every(item => fs.existsSync(path.join(output, 'rnamel-matched', item.path)))).toBe(true);
    expect(run.fixtureSha256).toBe(JSON.parse(fs.readFileSync(input + '.json')).fixtureSha256);
    expect(run.command).toContain('RNAmel');
    expect(() => runBenchmark(input, output, 'RNAmel', 'matched')).toThrow(/exists/);
  });

  it('retains failed execution as failed even if an HTML file was left behind', () => {
    const { input, output } = fixture();
    const summary = runBenchmark(input, output, 'RNAmel', 'defaults', { execute() { return { status:1, stdout:'partial', stderr:'failed' }; } });
    expect(summary.results[0].completed).toBe(false);
    expect(summary.results[0].exitCode).toBe(1);
    expect(summary.results[0].manualSteps.humanOperatorTimeSeconds).toBeNull();
  });
});
