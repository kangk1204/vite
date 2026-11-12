import { describe, expect, it } from 'vitest';
import { buildAssignments, assertStudyGates, validateResponses, prepareAnalysisRows, blindResponses, createBlindedPacket, evaluateDetector } from '../scripts/study/protocol.mjs';

const participants = Array.from({ length: 6 }, (_, i) => ({ id: `P${i + 1}`, experience: i % 2 ? 'experienced' : 'novice', consent: true }));
const cases = Array.from({ length: 24 }, (_, i) => ({
  id: `C${i}`, familyId: `F${i}`, taskType: i % 2 ? 'audit' : 'ordinary',
  sourcePacketId: `S${i}`, adjudicationStatus: 'pending', evidenceReady: false,
}));

describe('publication study protocol', () => {
  it('balances six orders and gives each participant twelve unique cases and four tasks per condition', () => {
    const schedule = buildAssignments(participants, cases, { phase: 'dry_run', seed: 42 });
    expect(schedule.dataOrigin).toBe('synthetic');
    expect(new Set(schedule.participants.map(p => p.order.join(','))).size).toBe(6);
    for (const participant of participants) {
      const rows = schedule.assignments.filter(r => r.participantId === participant.id);
      expect(rows).toHaveLength(12);
      expect(new Set(rows.map(r => r.familyId)).size).toBe(12);
      for (const condition of ['pnv_full', 'pnv_basic', 'genetonic']) {
        const tasks = rows.filter(r => r.condition === condition);
        expect(tasks).toHaveLength(4);
        expect(tasks.filter(r => r.taskType === 'audit')).toHaveLength(2);
      }
    }
    expect(buildAssignments(participants, cases, { phase: 'dry_run', seed: 42 })).toEqual(schedule);
  });

  it('balances case difficulty across both conditions and periods for each six-person block', () => {
    for (const n of [6, 12, 24]) {
      const roster = Array.from({ length: n }, (_, i) => ({ id: `P${i}`, experience: i % 2 ? 'novice' : 'experienced' }));
      const schedule = buildAssignments(roster, cases, { phase: 'dry_run', seed: 728 });
      for (const id of new Set(schedule.assignments.map(row => row.caseId))) {
        const rows = schedule.assignments.filter(row => row.caseId === id);
        expect(new Set(['pnv_full', 'pnv_basic', 'genetonic'].map(condition => rows.filter(row => row.condition === condition).length)).size).toBe(1);
        expect(new Set([1, 2, 3].map(period => rows.filter(row => row.period === period).length)).size).toBe(1);
      }
    }
  });

  it('uses only held-out cases and the full frozen sample for main assignment', () => {
    const gates = { institutionalDetermination: 'approved', institutionalReference: 'IRB-TEST', consentMaterialsApproved: true, completedPilotParticipants: 6, preregistrationUrl: 'https://example.test/protocol', protocolSha256: 'a'.repeat(64), plannedSampleSize: 6, powerArtifactSha256: 'b'.repeat(64) };
    const reviewed = cases.map((item, index) => ({ ...item, split: index < 12 ? 'development' : 'held_out', adjudicationStatus: 'adjudicated', evidenceReady: true, reviewers: ['E1', 'E2'] }));
    const eligibleParticipants = participants.map(p => ({ ...p, wasPilot: false }));
    const schedule = buildAssignments(eligibleParticipants, reviewed, { phase: 'main', gates });
    expect(schedule.assignments.every(row => Number(row.caseId.slice(1)) >= 12)).toBe(true);
    expect(() => buildAssignments(participants, reviewed, { phase: 'main', gates })).toThrow(/wasPilot/);
    expect(() => buildAssignments(eligibleParticipants.slice(0, 1), reviewed, { phase: 'main', gates })).toThrow(/frozen planned/);
    expect(() => buildAssignments(eligibleParticipants, reviewed.map(item => ({ ...item, reviewers: [null, undefined] })), { phase: 'main', gates })).toThrow(/adjudicators/);
    expect(() => buildAssignments(eligibleParticipants, reviewed.map((item, index) => index === 12 ? { ...item, familyId: reviewed[0].familyId } : item), { phase: 'main', gates })).toThrow(/leaks/);
  });

  it('blocks real assignment until institutional, consent, independent adjudication and preregistration gates pass', () => {
    expect(() => buildAssignments(participants, cases, { phase: 'main', gates: {} })).toThrow(/institutional/);
    expect(() => assertStudyGates({ institutionalDetermination: 'approved', institutionalReference: 'TEST', consentMaterialsApproved: true }, 'main')).toThrow(/preregistration/);
    expect(() => buildAssignments([{ ...participants[0], consent: false }], cases, { phase: 'pilot', gates: { institutionalDetermination: 'exempt', institutionalReference: 'TEST', consentMaterialsApproved: true } })).toThrow(/consent/);
  });

  it('rejects too few families and duplicate participant identifiers', () => {
    expect(() => buildAssignments(participants, cases.slice(0, 4), { phase: 'dry_run' })).toThrow(/six/);
    expect(() => buildAssignments([participants[0], participants[0]], cases, { phase: 'dry_run' })).toThrow(/unique/);
  });

  it('validates assignments against responses and never admits synthetic logs to main analysis', () => {
    const schedule = buildAssignments([participants[0]], cases, { phase: 'dry_run' });
    const logs = schedule.assignments.map(row => ({ ...row, status: 'completed', elapsedMs: 1000, confidence: 0.8, answer: 'insufficient evidence', dataOrigin: 'synthetic', phase: 'dry_run' }));
    expect(validateResponses(schedule, logs)).toEqual([]);
    expect(validateResponses(schedule, [{ ...logs[0], confidence: 2 }])).toContain('confidence must be in [0,1] for P1:T01');
    expect(() => prepareAnalysisRows(schedule, logs, [], { phase: 'main' })).toThrow(/synthetic/);
    expect(blindResponses(logs)[0]).not.toHaveProperty('condition');
    expect(blindResponses(logs)[0]).not.toHaveProperty('period');
    const blinded = createBlindedPacket(logs);
    expect(blinded.rows[0]).not.toHaveProperty('participantId');
    expect(blinded.rows[0]).not.toHaveProperty('trialId');
    expect(blinded.key.find(k => k.ratingId === blinded.rows[0].ratingId)).toBeDefined();
    expect(validateResponses(schedule, [{ ...logs[0], elapsedMs: 240001 }, ...logs.slice(1)])).toContain('Completed trial exceeds frozen time limit for P1:T01');
  });

  it('requires two independent agreeing ratings and counts timed-out trials as failures', () => {
    const schedule = buildAssignments([participants[0]], cases, { phase: 'dry_run' });
    const logs = schedule.assignments.map((row, i) => ({ ...row, status: i ? 'completed' : 'timeout', elapsedMs: i ? 1000 : 240000, confidence: i ? 0.8 : null, answer: 'answer', dataOrigin: 'synthetic', phase: 'dry_run' }));
    expect(() => prepareAnalysisRows(schedule, logs, [], { phase: 'dry_run' })).toThrow(/two independent/);
    const ratings = logs.flatMap(row => ['R1', 'R2'].map(raterId => ({ participantId: row.participantId, trialId: row.trialId, raterId, correct: true })));
    const rows = prepareAnalysisRows(schedule, logs, ratings, { phase: 'dry_run' });
    expect(rows[0].error).toBe(1);
    expect(rows[0].penalizedTimeMs).toBe(240000);
    expect(rows[1].error).toBe(0);
    expect(rows[1].brier).toBeCloseTo(0.04);
    expect(() => prepareAnalysisRows(schedule, logs, ratings.map((r, i) => i === 3 ? { ...r, correct: false } : r), { phase: 'dry_run' })).toThrow(/disagreement/);
  });

  it('keeps unverifiable cases separate from detector specificity', () => {
    const result = evaluateDetector([
      { truth: 'mismatch', predicted: 'mismatch' }, { truth: 'normal', predicted: 'normal' },
      { truth: 'unverifiable', predicted: 'unverifiable' }, { truth: 'mismatch', predicted: 'normal' },
    ]);
    expect(result.sensitivity.estimate).toBe(0.5);
    expect(result.specificity.estimate).toBe(1);
    expect(result.unverifiable).toEqual({ total: 1, correctlyAbstained: 1 });
    expect(result.sensitivity.interval).toHaveLength(2);
  });
});
