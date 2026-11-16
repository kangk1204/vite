(() => {
  const data = JSON.parse(document.getElementById('study-data').textContent);
  const element = id => document.getElementById(id);
  let records = [];
  let index = 0;
  let started = null;
  let trainingEnd = null;
  let trainedPeriod = 0;
  let closed = false;
  let disposition = {participantId:data.participantId,status:'active',allowUse:true};
  const visits = new Map();
  let priorTargetVisits = 0;
  const current = () => data.tasks[index];
  element('notice').textContent = data.dataOrigin === 'synthetic'
    ? 'SYNTHETIC SOFTWARE CHECK — no participant observations'
    : 'Download your records through the study procedure. Use your participant code for contact.';
  function reveal(text, report, evidence) {
    element('prompt').textContent = text;
    for (const [id, href] of [['report',report],['evidence',evidence]]) {
      element(id).hidden = !href;
      if (href) element(id).href = href;
      else element(id).removeAttribute('href');
    }
  }
  function show() {
    started = null;
    element('response').hidden = true;
    reveal('Evaluation material appears when the task timer starts.',null,null);
    const task = current();
    if (!task) {
      closed = true;
      disposition = {participantId:data.participantId,status:'completed',allowUse:true};
      element('progress').textContent = 'Session complete. Download your responses and session status.';
      element('start').hidden = true;
      return;
    }
    element('progress').textContent = `Task ${index+1} / 12 · period ${task.period}`;
    element('answer').value = '';
    element('confidence').value = '';
    element('prior-exposure').value = 'unsure';
    element('start').disabled = false;
    element('start').textContent = trainedPeriod === task.period ? 'Start task' : 'Start ten-minute training';
    element('time').textContent = '';
  }
  element('start').onclick = () => {
    if (closed || started !== null) return;
    const task = current();
    if (trainedPeriod !== task.period) {
      trainingEnd = performance.now()+data.trainingMs;
      element('start').disabled = true;
      const tutorial = data.tutorials[task.condition];
      reveal(tutorial?.text || 'Synthetic training check.',tutorial?.reportUrl,tutorial?.rawEvidenceUrl);
      if (data.trainingMs === 0) { trainedPeriod=task.period; trainingEnd=null; show(); }
      return;
    }
    const context = task.contextId || task.familyId;
    priorTargetVisits = visits.get(context) || 0;
    visits.set(context,priorTargetVisits+1);
    started = performance.now();
    reveal(task.prompt,task.reportUrl,task.rawEvidenceUrl);
    element('response').hidden = false;
    element('start').disabled = true;
  };
  function finish(status) {
    if (closed || started === null) return;
    const elapsedMs = Math.round(performance.now()-started);
    if (elapsedMs > data.timeoutMs) status = 'timeout';
    let confidence = element('confidence').value === '' ? null : Number(element('confidence').value)/100;
    const validConfidence = confidence !== null && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1;
    if (status !== 'completed' && !validConfidence) confidence = null;
    const answer = element('answer').value.trim();
    if (status === 'completed' && (!answer || !validConfidence)) { alert('Provide an answer and confidence from 0 to 100.'); return; }
    const {prompt,reportUrl,rawEvidenceUrl,exposureKeys,...assignment} = current();
    records = [...records,{...assignment,phase:data.phase,dataOrigin:data.dataOrigin,status,elapsedMs,answer,confidence,
      priorTargetVisits,selfReportedPriorExposure:element('prior-exposure').value}];
    index += 1;
    show();
  }
  function stopSession(deleteData) {
    if (closed && disposition.status === 'withdrawn_delete') return;
    closed = true;
    started = trainingEnd = null;
    if (deleteData) records = [];
    disposition = {participantId:data.participantId,status:deleteData?'withdrawn_delete':'stopped_retain',allowUse:!deleteData};
    element('answer').value = '';
    element('confidence').value = '';
    element('response').hidden = true;
    element('start').hidden = true;
    reveal(deleteData ? 'This browser record has been cleared. Send the session status through your approved contact channel to request removal of previously submitted copies.'
      : 'The session has stopped. Your submitted answers remain available for download. Unfinished tasks have no response record.',null,null);
    element('progress').textContent = `Participant ${data.participantId} · ${disposition.status}`;
  }
  function download(value, suffix) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value,null,2)],{type:'application/json'}));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${data.participantId}.${data.phase}.${suffix}.json`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  element('submit').onclick = () => finish('completed');
  element('abandon').onclick = () => finish('abandoned');
  element('failure').onclick = () => finish('system_error');
  element('stop-retain').onclick = () => stopSession(false);
  element('withdraw-delete').onclick = () => stopSession(true);
  element('download').onclick = () => download(records,'responses');
  element('download-status').onclick = () => download({...disposition,phase:data.phase,dataOrigin:data.dataOrigin,observedTrials:records.length},'session-status');
  setInterval(() => {
    if (closed) return;
    if (trainingEnd !== null) {
      const left = Math.max(0,trainingEnd-performance.now());
      element('time').textContent = `Training remaining ${Math.ceil(left/1000)} seconds`;
      if (left === 0) { trainedPeriod=current().period; trainingEnd=null; show(); }
    } else if (started !== null) {
      const left = Math.max(0,data.timeoutMs-(performance.now()-started));
      element('time').textContent = `Task remaining ${Math.ceil(left/1000)} seconds`;
      if (left === 0) finish('timeout');
    }
  },250);
  window.onbeforeunload = () => records.length ? 'Download records before closing.' : null;
  show();
})();
