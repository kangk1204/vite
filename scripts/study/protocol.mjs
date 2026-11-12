/** Study administration helpers. These validate records; they do not supply human evidence. */
import { randomUUID } from 'node:crypto';
export const CONDITIONS = ['pnv_full', 'pnv_basic', 'genetonic'];
export const ORDERS = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
const STATUSES = ['completed', 'timeout', 'abandoned', 'system_error'];

function requireUnique(values, label) {
  if (values.some(value => typeof value !== 'string' || !value.trim()) || new Set(values).size !== values.length) {
    throw new Error(`${label} must be non-empty and unique.`);
  }
}

function twoIdentities(values) {
  return Array.isArray(values) && values.length === 2 && values.every(value => typeof value === 'string' && value.trim()) && new Set(values).size === 2;
}

function permutation(length, seed) {
  let state = Number(seed) >>> 0;
  const ranked = Array.from({ length }, (_, index) => {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return { index, rank: state };
  });
  return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map(entry => entry.index);
}

export function assertStudyGates(gates = {}, phase) {
  if (phase === 'dry_run') return;
  if (!['pilot', 'main'].includes(phase)) throw new Error('phase must be pilot, main, or dry_run.');
  if (!['approved', 'exempt'].includes(gates.institutionalDetermination)) throw new Error('An institutional determination is required.');
  if (!gates.institutionalReference) throw new Error('An institutional reference is required.');
  if (gates.consentMaterialsApproved !== true) throw new Error('Approved consent materials are required.');
  if (phase === 'main') {
    if (!/^https:\/\//.test(gates.preregistrationUrl ?? '') || !/^[a-f0-9]{64}$/.test(gates.protocolSha256 ?? '')) throw new Error('A frozen preregistration and protocol hash are required.');
    if (gates.completedPilotParticipants !== 6) throw new Error('Six completed pilot participants, excluded from the main study, are required.');
    if (!Number.isInteger(gates.plannedSampleSize) || gates.plannedSampleSize < 6 || gates.plannedSampleSize % 6) throw new Error('A power-selected sample size in multiples of six is required.');
    if (!/^[a-f0-9]{64}$/.test(gates.powerArtifactSha256 ?? '')) throw new Error('A frozen power artifact is required.');
  }
}

export function buildAssignments(participants, cases, options = {}) {
  const { phase = 'main', gates = {}, seed = 20261110, timeoutMs = 240000 } = options;
  assertStudyGates(gates, phase);
  if (!Number.isInteger(seed) || !Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid seed or timeout.');
  if (!Array.isArray(participants) || !participants.length || !Array.isArray(cases)) throw new Error('Participant and case arrays are required.');
  requireUnique(participants.map(p => p.id), 'Participant identifiers');
  requireUnique(cases.map(c => c.id), 'Case identifiers');
  if (phase !== 'dry_run' && participants.some(p => p.consent !== true)) throw new Error('Every participant requires recorded consent.');
  if (participants.some(p => !['novice', 'experienced'].includes(p.experience))) throw new Error('Experience must be novice or experienced.');
  if (phase === 'main' && participants.some(p => p.wasPilot !== false)) throw new Error('Main participants require explicit wasPilot:false eligibility.');
  if (phase === 'main' && participants.length !== gates.plannedSampleSize) throw new Error('Main roster must equal the frozen planned sample size.');
  if (phase === 'pilot' && participants.length !== 6) throw new Error('Pilot roster must contain exactly six participants.');
  const splitByFamily = new Map();
  for (const item of cases) {
    if (splitByFamily.has(item.familyId) && splitByFamily.get(item.familyId) !== item.split) throw new Error('Case family leaks across development and held-out splits.');
    splitByFamily.set(item.familyId, item.split);
  }
  const eligible = phase === 'dry_run' ? cases : cases.filter(c => c.split === (phase === 'main' ? 'held_out' : 'development'));
  requireUnique(eligible.map(c => c.familyId), 'Eligible case families');
  if (phase !== 'dry_run' && eligible.some(c => c.adjudicationStatus !== 'adjudicated' || c.evidenceReady !== true || !twoIdentities(c.reviewers))) {
    throw new Error('Cases require evidence packets and two independent expert adjudicators.');
  }
  const pools = Object.fromEntries(['ordinary', 'audit'].map(type => {
    const pool = eligible.filter(c => c.taskType === type);
    requireUnique(pool.map(c => c.familyId), `${type} case families`);
    if (pool.length < 6) throw new Error(`At least six distinct ${type} case families are required.`);
    return [type, permutation(pool.length, seed + (type === 'audit' ? 1 : 0)).map(i => pool[i])];
  }));
  const orderPermutation = permutation(6, seed);
  const rosterOrder = permutation(participants.length, seed + 7).map(i => participants[i]);
  const ordered = rosterOrder.map((participant, i) => ({
    ...participant, order: ORDERS[orderPermutation[i % 6]].map(index => CONDITIONS[index]),
  }));
  const assignments = ordered.flatMap((participant, participantIndex) => {
    const used = new Set();
    return participant.order.flatMap((condition, periodIndex) => ['ordinary', 'ordinary', 'audit', 'audit'].map((taskType, taskIndex) => {
      const pool = pools[taskType];
      const first = CONDITIONS.indexOf(participant.order[0]);
      const orientation = (CONDITIONS.indexOf(participant.order[1]) - first + 3) % 3;
      const block = (first - orientation * periodIndex + 6) % 3;
      const offset = Math.floor(participantIndex / 6) * 6 + block * 2 + taskIndex % 2;
      const selected = pool[offset % pool.length];
      if (used.has(selected.familyId)) throw new Error('A case family would repeat within a participant.');
      used.add(selected.familyId);
      return {
        participantId: participant.id, experience: participant.experience,
        trialId: `T${String(periodIndex * 4 + taskIndex + 1).padStart(2, '0')}`,
        condition, period: periodIndex + 1, taskType, caseId: selected.id,
        familyId: selected.familyId, sourcePacketId: selected.sourcePacketId,
      };
    }));
  });
  return { schemaVersion: 1, phase, dataOrigin: phase === 'dry_run' ? 'synthetic' : 'human', seed, timeoutMs,
    plannedSampleSize: phase === 'main' ? gates.plannedSampleSize : null,
    protocolSha256: phase === 'main' ? gates.protocolSha256 : null,
    powerArtifactSha256: phase === 'main' ? gates.powerArtifactSha256 : null,
    participants: ordered, assignments };
}

export function validateResponses(schedule, responses) {
  if (!Array.isArray(responses) || !Array.isArray(schedule?.assignments)) return ['Invalid schedule or response array.'];
  const expected = new Map(schedule.assignments.map(row => [`${row.participantId}:${row.trialId}`, row]));
  const seen = new Set();
  const errors = [];
  for (const response of responses) {
    const key = `${response.participantId}:${response.trialId}`;
    const assignment = expected.get(key);
    if (!assignment) { errors.push(`Unscheduled response: ${key}`); continue; }
    if (seen.has(key)) errors.push(`Duplicate response: ${key}`);
    seen.add(key);
    for (const field of ['condition', 'period', 'caseId']) if (response[field] !== assignment[field]) errors.push(`${field} differs from assignment for ${key}`);
    if (response.dataOrigin !== schedule.dataOrigin || response.phase !== schedule.phase) errors.push(`Origin or phase mismatch for ${key}`);
    if (!STATUSES.includes(response.status)) errors.push(`Invalid status for ${key}`);
    if (!Number.isFinite(response.elapsedMs) || response.elapsedMs < 0) errors.push(`Invalid elapsedMs for ${key}`);
    if (response.status === 'completed' && response.elapsedMs > schedule.timeoutMs) errors.push(`Completed trial exceeds frozen time limit for ${key}`);
    if (response.confidence !== null && (!Number.isFinite(response.confidence) || response.confidence < 0 || response.confidence > 1)) errors.push(`confidence must be in [0,1] for ${key}`);
    if (response.status === 'completed' && (typeof response.answer !== 'string' || !response.answer.trim() || response.confidence === null)) errors.push(`Completed trial lacks answer/confidence for ${key}`);
  }
  for (const key of expected.keys()) if (!seen.has(key)) errors.push(`Missing scheduled trial: ${key}`);
  return errors;
}

export function blindResponses(responses) {
  return createBlindedPacket(responses).rows;
}

export function createBlindedPacket(responses) {
  const key = responses.map(({ participantId, trialId }) => ({ ratingId: randomUUID(), participantId, trialId }));
  const rows = responses.map(({ caseId, answer }, index) => ({ ratingId: key[index].ratingId, caseId, answer })).sort((a, b) => a.ratingId.localeCompare(b.ratingId));
  return { rows, key };
}

export function prepareAnalysisRows(schedule, responses, ratings, options = {}) {
  const { phase = 'main', timeoutMs = schedule.timeoutMs } = options;
  if (timeoutMs !== schedule.timeoutMs) throw new Error('Analysis time limit differs from the frozen assignment.');
  if (phase !== 'dry_run' && (schedule.dataOrigin !== 'human' || responses.some(r => r.dataOrigin !== 'human'))) throw new Error('Cannot analyze synthetic responses as human data.');
  if (schedule.phase !== phase || (phase === 'main' && schedule.participants.some(p => p.wasPilot))) throw new Error('Main and pilot records must remain separate.');
  if (phase === 'main' && (!options.ratingKey || schedule.participants.length !== schedule.plannedSampleSize || !/^[a-f0-9]{64}$/.test(schedule.protocolSha256 ?? ''))) throw new Error('Main analysis requires opaque rating keys and frozen sample/protocol metadata.');
  const keyedRatings = options.ratingKey ? ratings.map(rating => {
    const match = options.ratingKey.filter(item => item.ratingId === rating.ratingId);
    if (match.length !== 1) throw new Error('Missing or duplicate opaque rating key.');
    return { ...rating, participantId: match[0].participantId, trialId: match[0].trialId };
  }) : ratings;
  const errors = validateResponses(schedule, responses);
  if (errors.length) throw new Error(errors.join('\n'));
  return responses.map(response => {
    const assignment = schedule.assignments.find(a => a.participantId === response.participantId && a.trialId === response.trialId);
    const judgments = keyedRatings.filter(r => r.participantId === response.participantId && r.trialId === response.trialId);
    if (!twoIdentities(judgments.map(r => r.raterId)) || judgments.some(r => typeof r.correct !== 'boolean')) throw new Error(`Exactly two independent ratings required for ${response.participantId}:${response.trialId}`);
    if (judgments[0].correct !== judgments[1].correct) throw new Error(`Unresolved rating disagreement for ${response.participantId}:${response.trialId}`);
    const correct = response.status === 'completed' && judgments[0].correct;
    return {
      ...assignment, phase, dataOrigin: schedule.dataOrigin, status: response.status,
      error: correct ? 0 : 1, elapsedMs: response.elapsedMs,
      penalizedTimeMs: correct ? Math.min(response.elapsedMs, timeoutMs) : timeoutMs,
      confidence: response.confidence, brier: response.confidence === null ? null : (response.confidence - Number(correct)) ** 2,
    };
  });
}

function proportion(successes, total) {
  if (!total) return { successes, total, estimate: null, interval: [null, null] };
  const z = 1.959963984540054;
  const p = successes / total;
  const scale = 1 + z * z / total;
  const center = (p + z * z / (2 * total)) / scale;
  const half = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / scale;
  return { successes, total, estimate: p, interval: [Math.max(0, center - half), Math.min(1, center + half)] };
}

export function evaluateDetector(rows) {
  if (rows.some(r => !['normal', 'mismatch', 'unverifiable'].includes(r.truth) || !['normal', 'mismatch', 'unverifiable'].includes(r.predicted))) throw new Error('Unknown detector label.');
  const positives = rows.filter(r => r.truth === 'mismatch');
  const negatives = rows.filter(r => r.truth === 'normal');
  const unknown = rows.filter(r => r.truth === 'unverifiable');
  return {
    sensitivity: proportion(positives.filter(r => r.predicted === 'mismatch').length, positives.length),
    specificity: proportion(negatives.filter(r => r.predicted === 'normal').length, negatives.length),
    unverifiable: { total: unknown.length, correctlyAbstained: unknown.filter(r => r.predicted === 'unverifiable').length },
    intervalMethod: 'Wilson 95%; case is the observational unit',
  };
}
