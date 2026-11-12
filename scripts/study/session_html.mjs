#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
  const data = JSON.stringify({ tasks, participantId, phase: schedule.phase, dataOrigin: schedule.dataOrigin,
    timeoutMs: schedule.timeoutMs, tutorials, trainingMs: schedule.dataOrigin === 'synthetic' ? 0 : 600000 }).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `<!doctype html><html lang="en"><meta charset="utf-8"><title>PNV evaluation session</title>
<style>body{font:17px system-ui;max-width:820px;margin:3rem auto;padding:1rem;line-height:1.6}button,a,input,textarea{font:inherit;margin:.4rem}textarea{width:95%;min-height:130px}.notice{background:#fff3cd;padding:1rem}#time{font-variant-numeric:tabular-nums}button{padding:.5rem 1rem}</style>
<h1>Interpretation evaluation</h1><p id="notice" class="notice"></p><p id="progress"></p><p id="prompt"></p>
<p><a id="report" target="_blank" rel="noopener">Open report</a> <a id="evidence" target="_blank" rel="noopener">Open complete source evidence</a></p>
<p id="time"></p><button id="start">Start training</button><section id="response" hidden><label>Answer, including uncertainty or insufficient evidence where appropriate<textarea id="answer"></textarea></label><br>
<label>Confidence that this answer is correct (0–100%)<input id="confidence" type="number" min="0" max="100" step="1"></label><br>
<button id="submit">Submit answer</button><button id="abandon">Cannot complete</button><button id="failure">Report technical failure</button></section><button id="download">Download current records</button>
<script type="application/json" id="study-data">${data}</script><script>
const DATA=JSON.parse(document.getElementById('study-data').textContent); const records=[]; let index=0,started=null,trainingEnd=null,trainedPeriod=0;
const el=id=>document.getElementById(id); const current=()=>DATA.tasks[index];
el('notice').textContent=DATA.dataOrigin==='synthetic'?'SYNTHETIC SOFTWARE CHECK — not participant evidence':'Records stay in this browser until you download them. Do not enter names or other personal identifiers.';
function reveal(text,report,evidence){el('prompt').textContent=text;el('report').hidden=!report;el('evidence').hidden=!evidence;if(report)el('report').href=report;else el('report').removeAttribute('href');if(evidence)el('evidence').href=evidence;else el('evidence').removeAttribute('href');}
function show(){const task=current();el('response').hidden=true;started=null;reveal('Evaluation material is shown when the task timer starts.',null,null);if(!task){el('progress').textContent='Session complete. Download the records and provide them through the approved study process.';el('start').hidden=true;return;}el('progress').textContent='Task '+(index+1)+' / 12 · period '+task.period;el('answer').value='';el('confidence').value='';el('start').disabled=false;el('start').textContent=trainedPeriod===task.period?'Start task':'Start ten-minute training';el('time').textContent='';}
el('start').onclick=()=>{const task=current();if(!task)return;if(trainedPeriod!==task.period){trainingEnd=performance.now()+DATA.trainingMs;el('start').disabled=true;const tutorial=DATA.tutorials[task.condition];reveal(tutorial?.text||'Synthetic training check.',tutorial?.reportUrl,tutorial?.rawEvidenceUrl);if(DATA.trainingMs===0){trainedPeriod=task.period;trainingEnd=null;show();}return;}started=performance.now();reveal(task.prompt,task.reportUrl,task.rawEvidenceUrl);el('response').hidden=false;el('start').disabled=true;};
function finish(status){if(started===null)return;const elapsedMs=Math.round(performance.now()-started);if(elapsedMs>DATA.timeoutMs)status='timeout';let confidence=el('confidence').value===''?null:Number(el('confidence').value)/100;if(status!=='completed'&&(confidence!==null&&(!Number.isFinite(confidence)||confidence<0||confidence>1)))confidence=null;const answer=el('answer').value.trim();if(status==='completed'&&(!answer||confidence===null||!Number.isFinite(confidence)||confidence<0||confidence>1)){alert('Provide an answer and confidence from 0 to 100.');return;}records.push({...current(),prompt:undefined,reportUrl:undefined,rawEvidenceUrl:undefined,phase:DATA.phase,dataOrigin:DATA.dataOrigin,status,elapsedMs,answer,confidence});index+=1;show();}
el('submit').onclick=()=>finish('completed');el('abandon').onclick=()=>finish('abandoned');el('failure').onclick=()=>finish('system_error');
setInterval(()=>{if(trainingEnd!==null){const left=Math.max(0,trainingEnd-performance.now());el('time').textContent='Training remaining: '+Math.ceil(left/1000)+' seconds';if(left===0){trainedPeriod=current().period;trainingEnd=null;show();}}else if(started!==null){const left=Math.max(0,DATA.timeoutMs-(performance.now()-started));el('time').textContent='Task remaining: '+Math.ceil(left/1000)+' seconds';if(left===0)finish('timeout');}},250);
el('download').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(records,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=DATA.participantId+'.'+DATA.phase+'.responses.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
window.onbeforeunload=()=>records.length?'Download records before closing.':null;show();
</script></html>`;
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
