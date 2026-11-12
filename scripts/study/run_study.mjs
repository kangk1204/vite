#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { assertStudyGates, buildAssignments, validateResponses, createBlindedPacket, prepareAnalysisRows, evaluateDetector } from './protocol.mjs';

function read(file) {
  if (!file) throw new Error('A required JSON input path is missing.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const hashFile = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;

export function protocolDigest(protocol) {
  return createHash('sha256').update(JSON.stringify(canonical({ ...protocol, gates: { ...protocol.gates, protocolSha256: null } }))).digest('hex');
}

export function studyCodeDigest() {
  const files = ['protocol.mjs', 'power_design.mjs', 'model.R', 'power_study.R', 'analyze_study.R', 'run_study.mjs', 'session_html.mjs'];
  return createHash('sha256').update(files.map(file => `${file}:${hashFile(new URL(file, import.meta.url))}`).join('\n')).digest('hex');
}

function verifyMainArtifacts(options, protocol, casesPath) {
  if (protocolDigest(protocol) !== protocol.gates.protocolSha256) throw new Error('Protocol contents differ from the frozen protocol hash.');
  const power = read(options.power);
  if (hashFile(options.power) !== protocol.gates.powerArtifactSha256 || power.status !== 'power-selected' || power.selectedN !== protocol.gates.plannedSampleSize) throw new Error('Power artifact is not the frozen final sample-size decision.');
  if (casesPath && power.casesSha256 !== hashFile(casesPath)) throw new Error('Case pool differs from the one used in final power simulation.');
  if (power.studyCodeSha256 !== studyCodeDigest()) throw new Error('Study assignment or analysis code changed after power selection.');
  if (power.config.seed !== protocol.seed || power.config.alpha !== 0.05 || power.config.targetPower !== 0.8 || power.config.errorReduction !== 0.1) throw new Error('Power settings differ from the registered seed/alpha/power/effect target.');
  return power;
}

function write(file, data) {
  if (!file) throw new Error('--out is required.');
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(data, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temp, file);
}

export function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'code-hash') return { studyCodeSha256: studyCodeDigest() };
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i].startsWith('--') || rest[i + 1] === undefined) throw new Error('Options require --name value pairs.');
    options[rest[i].slice(2)] = rest[i + 1];
  }
  if (command === 'status') {
    const protocol = read(options.protocol);
    try {
      assertStudyGates(protocol.gates, 'main');
      if (!options.power || !options.cases) return { ready: false, gatesComplete: true, artifactVerification: 'not_checked', reason: 'Supply --power and --cases to verify frozen artifacts.' };
      verifyMainArtifacts(options, protocol, options.cases);
      return { ready: true, gatesComplete: true, artifactVerification: 'verified' };
    }
    catch (error) { return { ready: false, reason: error.message, participantResults: 'not collected' }; }
  }
  if (command === 'assign') {
    const protocol = read(options.protocol);
    const power = (options.phase || 'main') === 'main' ? verifyMainArtifacts(options, protocol, options.cases) : null;
    const schedule = buildAssignments(read(options.participants), read(options.cases), {
      phase: options.phase || 'main', seed: protocol.seed, gates: protocol.gates, timeoutMs: protocol.timeoutMs,
    });
    write(options.out, { ...schedule, tutorials: protocol.tutorials ?? null, casesSha256: hashFile(options.cases), studyCodeSha256: power?.studyCodeSha256 ?? null, analysisEnvironment: power?.analysisEnvironment ?? null });
    return { assignments: schedule.assignments.length, phase: schedule.phase, dataOrigin: schedule.dataOrigin };
  }
  if (command === 'blind') {
    const responses = read(options.responses);
    const errors = validateResponses(read(options.assignments), responses);
    if (errors.length) throw new Error(errors.join('\n'));
    if (!options.key || path.resolve(options.key) === path.resolve(options.out)) throw new Error('--key must identify a separate private mapping file.');
    const packet = createBlindedPacket(responses);
    write(options.key, packet.key);
    write(options.out, packet.rows);
    return { blindedResponses: responses.length };
  }
  if (command === 'prepare') {
    const phase = options.phase || 'main';
    const protocol = read(options.protocol);
    assertStudyGates(protocol.gates, phase);
    const power = phase === 'main' ? verifyMainArtifacts(options, protocol) : null;
    const schedule = read(options.assignments);
    if (phase === 'main' && (schedule.protocolSha256 !== protocol.gates.protocolSha256 || schedule.powerArtifactSha256 !== protocol.gates.powerArtifactSha256 || schedule.studyCodeSha256 !== power.studyCodeSha256)) throw new Error('Frozen schedule and protocol identities differ.');
    const rows = prepareAnalysisRows(schedule, read(options.responses), read(options.ratings), { phase, timeoutMs: protocol.timeoutMs, ratingKey: options.key ? read(options.key) : undefined });
    write(options.out, { schemaVersion: 1, phase, dataOrigin: phase === 'dry_run' ? 'synthetic' : 'human',
      plannedSampleSize: schedule.plannedSampleSize, timeoutMs: schedule.timeoutMs, protocolSha256: schedule.protocolSha256, powerArtifactSha256: schedule.powerArtifactSha256,
      studyCodeSha256: schedule.studyCodeSha256, analysisEnvironment: schedule.analysisEnvironment, rows });
    return { rows: rows.length, phase };
  }
  if (command === 'detector') {
    const cases = read(options.cases);
    if (!Array.isArray(cases) || !cases.length || cases.some(row => typeof row.id !== 'string' || !row.id.trim() || row.split !== 'held_out') || new Set(cases.map(row => row.id)).size !== cases.length) throw new Error('Final detector metrics require unique held_out case IDs.');
    if (cases.some(row => row.adjudicationStatus !== 'adjudicated' || !Array.isArray(row.reviewers) || row.reviewers.length !== 2 || row.reviewers.some(r => typeof r !== 'string' || !r.trim()) || new Set(row.reviewers).size !== 2)) throw new Error('Detector evaluation requires independent case adjudication.');
    const result = { ...evaluateDetector(cases), status: 'independently-adjudicated', dataOrigin: 'expert-adjudicated-cases', cases: cases.length };
    write(options.out, result);
    return result;
  }
  throw new Error('Usage: run_study.mjs status|assign|blind|prepare|detector --name value ...');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
