import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const suites = fs.readdirSync(path.join(root, 'tests/r')).filter(name => /^test_.*\.R$/.test(name)).sort();
for (const suite of suites) {
  execFileSync('Rscript', [path.join('tests/r', suite)], { cwd: root, stdio: 'inherit' });
}
console.log(`Passed ${suites.length} R regression suites.`);
