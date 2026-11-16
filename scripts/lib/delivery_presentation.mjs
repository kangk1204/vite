const escape = value => String(value ?? 'Not supplied').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

function sourceLink(link) {
  const label = escape(link.label);
  if (link.source && typeof link.source.table === 'string' && Number.isInteger(link.source.row) && link.source.row > 0) {
    return `<button type="button" class="tool-button" data-source-table="${escape(link.source.table)}" data-source-row="${link.source.row}">${label}</button>`;
  }
  const href = String(link.href || '');
  // The portable report and task wrapper link to local evidence, with no script URLs.
  if (!href || /[\u0000-\u0020\\]/u.test(href) || href.startsWith('//') || /^[a-z][a-z0-9+.-]*:/i.test(href)) return `<span>${label}</span>`;
  return `<a href="${escape(href)}">${label}</a>`;
}

const table = (columns, rows) => `<div class="delivery-table"><table><thead><tr>${columns.map(column => `<th>${escape(column)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${escape(cell)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;

/** Product and study share this presentation of the public checker's recorded output. */
export function renderDeliveryPresentation(envelope, { condition = 'full', links = [] } = {}) {
  if (!envelope) return '';
  const { request, analysisRecord, result } = envelope;
  const mode = envelope.verificationMode === 'supplied-files'
    ? 'Checks were run against supplied files and recorded fields.'
    : 'Files were not rechecked during this import. The checks below were recorded earlier.';
  const fields = [...new Set([...Object.keys(request.claims), ...Object.keys(analysisRecord), ...Object.keys(envelope.submittedAnalysisRecord || {})])];
  const claims = table(['Field', 'Handoff request', 'Analysis record', ...(envelope.submittedAnalysisRecord ? ['Submitted analysis record'] : [])],
    fields.map(field => [field, request.claims[field], analysisRecord[field], ...(envelope.submittedAnalysisRecord ? [envelope.submittedAnalysisRecord[field]] : [])]));
  const files = table(['File role', 'Path', 'Recorded bytes', 'Recorded SHA-256', 'Supplied bytes', 'Supplied SHA-256'],
    result.files.map(file => [file.role, file.path, file.recordedSize, file.recordedSha256, file.suppliedSize, file.suppliedSha256]));
  const documents = table(['Additional record', 'Path', 'Observation', 'Bytes', 'SHA-256'],
    (result.documents || []).map(item => [item.name, item.path, item.available ? 'Document supplied' : 'No document supplied', item.sizeBytes, item.sha256]));
  const diagnoses = condition === 'full' ? `<div id="delivery-diagnostics">
    <h2>Delivery diagnostics and linked evidence</h2><p>${escape(mode)}</p>
    <p>Recorded outcome ${escape(result.predicted)}. File checks establish byte identity within the supplied materials.</p>
    <ul>${result.checks.map(check => `<li data-check-status="${escape(check.status)}"><strong>${escape(check.status)}</strong> ${escape(check.message)}</li>`).join('')}</ul>
    ${links.length ? `<p class="delivery-links">${links.map(sourceLink).join(' ')}</p>` : ''}
  </div>` : '';
  return `<section class="delivery-evidence" aria-label="Delivery evidence">${diagnoses}
    <details id="delivery-observations"><summary>Raw delivery observations</summary>
      <p>${escape(mode)} Checker ${escape(envelope.checker)}. Recorded ${escape(envelope.checkedAt)}.</p>
      ${claims}${files}${documents}
      <details><summary>Complete delivery record</summary><pre>${escape(JSON.stringify(envelope, null, 2))}</pre></details>
    </details></section>`;
}
