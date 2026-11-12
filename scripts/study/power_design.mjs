#!/usr/bin/env node
import fs from 'node:fs';
import { buildAssignments } from './protocol.mjs';

const [count, seed, casesPath] = process.argv.slice(2);
const n = Number(count);
if (!Number.isInteger(n) || n < 6 || n % 6) throw new Error('Power design N must be a multiple of six.');
const cases = JSON.parse(fs.readFileSync(casesPath, 'utf8')).filter(row => row.split === 'held_out');
const participants = Array.from({ length: n }, (_, i) => ({ id: `SIM${i + 1}`, experience: i % 2 ? 'experienced' : 'novice' }));
const design = buildAssignments(participants, cases, { phase: 'dry_run', seed: Number(seed) });
const fields = ['participantId', 'caseId', 'condition', 'period', 'experience', 'taskType'];
console.log(fields.join('\t'));
for (const row of design.assignments) console.log(fields.map(field => row[field]).join('\t'));
