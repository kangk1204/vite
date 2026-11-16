#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL, URL as NodeURL } from 'node:url';
import { createHash } from 'node:crypto';

function safeLink(value) {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Task links must be local paths or file/http(s) URLs.');
  const trimmed = value.trim();
  if (!['http:', 'https:', 'file:'].includes(new URL(trimmed, 'http://127.0.0.1/').protocol)) throw new Error('Task links must be local paths or file/http(s) URLs.');
  return trimmed;
}

export function createSessionHtml(schedule, cases, participantId) {
  const participant = schedule.participants.find(p => p.id === participantId);
  if (!participant) throw new Error('Participant not in frozen assignment.');
  const tasks = schedule.assignments.filter(row => row.participantId === participantId).map(row => {
    const item = cases.find(c => c.id === row.caseId);
    if (!item || !item.prompt || !item.reportUrls?.[row.condition] || !item.rawEvidenceUrl) throw new Error(`Task packet incomplete: ${row.caseId}`);
    return { ...row, prompt: item.prompt, reportUrl: safeLink(item.reportUrls[row.condition]), rawEvidenceUrl: safeLink(item.rawEvidenceUrl) };
  });
  if (tasks.length !== 12) throw new Error('Session must contain twelve scheduled tasks.');
  const tutorials = {};
  for (const condition of participant.order ?? ['pnv_full', 'pnv_basic', 'genetonic']) {
    const tutorial = schedule.tutorials?.[condition];
    if (schedule.dataOrigin === 'human' && (!tutorial?.text || !tutorial.reportUrl || !tutorial.rawEvidenceUrl)) throw new Error('Human sessions require separate training packets for every condition.');
    tutorials[condition] = tutorial ? { text: tutorial.text, reportUrl: safeLink(tutorial.reportUrl), rawEvidenceUrl: safeLink(tutorial.rawEvidenceUrl) } : null;
    if (tutorial && tasks.some(task => [task.reportUrl, task.rawEvidenceUrl].includes(tutorial.reportUrl) || [task.reportUrl, task.rawEvidenceUrl].includes(tutorial.rawEvidenceUrl))) throw new Error('Training must not reuse held-out task artifacts.');
  }
  const runtime = fs.readFileSync(new NodeURL('./session_runtime.js', import.meta.url), 'utf8').replace(/<\/script/gi, '<\\/script');
  const data = JSON.stringify({ tasks, participantId, phase: schedule.phase, dataOrigin: schedule.dataOrigin,
    timeoutMs: schedule.timeoutMs, tutorials, trainingMs: schedule.dataOrigin === 'synthetic' ? 0 : 600000 }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>PNV evaluation session</title>
<style>body{font:17px system-ui;max-width:820px;margin:3rem auto;padding:1rem;line-height:1.6}button,a,input,textarea{font:inherit;margin:.4rem}textarea{width:95%;min-height:130px}.notice{background:#fff3cd;padding:1rem}#time{font-variant-numeric:tabular-nums}button{padding:.5rem 1rem}</style>
<h1>Interpretation evaluation</h1><p id="notice" class="notice"></p><p id="progress"></p><p id="prompt"></p>
<p><a id="report" target="_blank" rel="noopener">Open report</a> <a id="evidence" target="_blank" rel="noopener">Open complete source evidence</a></p>
<p id="time"></p><button id="start">Start training</button><section id="response" hidden><label>Answer, including uncertainty or insufficient evidence where appropriate<textarea id="answer"></textarea></label><br>
<label>Confidence that this answer is correct (0–100%)<input id="confidence" type="number" min="0" max="100" step="1"></label><br>
<label>Have you previously seen this specific case or its answer? <select id="prior-exposure"><option value="unsure">Unsure</option><option value="no">No</option><option value="yes">Yes</option></select></label><br><button id="submit">Submit answer</button><button id="abandon">Cannot complete</button><button id="failure">Report technical failure</button></section><button id="download">Download current records</button><button id="download-status">Download session status</button><p><button id="stop-retain">Stop and retain submitted answers</button><button id="withdraw-delete">Withdraw and clear browser answers</button></p>
<script type="application/json" id="study-data">${data}</script><script>${runtime}</script></html>`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [scheduleFile, casesFile, participantId, output] = process.argv.slice(2);
  if (!output) throw new Error('Usage: session_html.mjs assignment.json cases.json participant-id output.html');
  const schedule = JSON.parse(fs.readFileSync(scheduleFile, 'utf8'));
  if (schedule.phase === 'main' && schedule.casesSha256 !== createHash('sha256').update(fs.readFileSync(casesFile)).digest('hex')) throw new Error('Case packets changed after assignment freeze.');
  const html = createSessionHtml(schedule, JSON.parse(fs.readFileSync(casesFile, 'utf8')), participantId);
  fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true });
  fs.writeFileSync(output, html);
}
