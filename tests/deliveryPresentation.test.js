import { describe, expect, it } from 'vitest';
import { renderDeliveryPresentation } from '../scripts/lib/delivery_presentation.mjs';

const envelope = () => ({
  schemaVersion: 1, checker: 'pnv-delivery-v1', checkedAt: '2026-11-16T00:00:00Z',
  scope: 'supplied-files-and-recorded-fields', verificationMode: 'supplied-files',
  request: { claims: { conditionA: 'A', conditionB: 'B' }, artifacts: [], additionalRecords: [] },
  analysisRecord: { conditionA: 'A', conditionB: 'C' },
  result: { predicted: 'mismatch', integrityStatus: 'internally_consistent',
    checks: [{ id: 'claim:conditionB', status: 'fail', message: 'Requested B; recorded C.' }],
    files: [{ role: 'counts', path: 'counts.tsv', recordedSha256: 'abc', recordedSize: 10, suppliedSha256: 'def', suppliedSize: 11 }],
    documents: [],
  }, sources: [],
});

describe('shared public delivery presentation', () => {
  it('exposes identical raw observations with a full-only diagnostic and linking panel', () => {
    const full = renderDeliveryPresentation(envelope(), { condition: 'full', links: [{ label: 'Pathway source', source: { table: 'Pathways', row: 2 } }] });
    const basic = renderDeliveryPresentation(envelope(), { condition: 'basic' });
    expect(full).toContain('id="delivery-diagnostics"');
    expect(full).toContain('Requested B; recorded C.');
    expect(full).toContain('data-source-table="Pathways" data-source-row="2"');
    expect(basic).not.toContain('id="delivery-diagnostics"');
    const raw = html => html.slice(html.indexOf('<details id="delivery-observations"'));
    expect(raw(full)).toEqual(raw(basic));
    expect(basic).toContain('abc'); expect(basic).toContain('def');
  });

  it('uses the same renderer with relative source links in an external task wrapper', () => {
    const html = renderDeliveryPresentation(envelope(), { links: [{ label: 'Supporting rows', href: '../evidence.html#pathways' }] });
    expect(html).toContain('href="../evidence.html#pathways"');
  });

  it('escapes incoming labels and rejects script or protocol-relative links', () => {
    const value = envelope(); value.result.checks[0].message = '<img src=x onerror=alert(1)>';
    const html = renderDeliveryPresentation(value, { links: [{ label: '<script>x</script>', href: 'javascript:alert(1)' }, { label: 'remote', href: '//example.org' }] });
    expect(html).not.toContain('<img'); expect(html).toContain('&lt;img');
    expect(html).not.toContain('href="javascript'); expect(html).not.toContain('href="//');
  });

  it('labels previously recorded checks after import without claiming a new file check', () => {
    const value = { ...envelope(), verificationMode: 'recorded-only' };
    expect(renderDeliveryPresentation(value)).toContain('Files were not rechecked during this import');
  });

  it('shows the conflicting submitted record and supplied document bytes in both conditions', () => {
    const value = envelope();
    value.submittedAnalysisRecord = { conditionB: 'D' };
    value.result.documents = [{ name: 'Specimen map', path: 'map.tsv', available: true, sha256: 'e'.repeat(64), sizeBytes: 12 },
      { name: 'Batch map', path: 'batch.tsv', available: false, sha256: null, sizeBytes: null }];
    for (const condition of ['full', 'basic']) {
      const html = renderDeliveryPresentation(value, {condition});
      expect(html).toContain('Submitted analysis record');
      expect(html).toContain('<td>D</td>');
      expect(html).toContain('e'.repeat(64));
      expect(html).toContain('No document supplied');
    }
    expect(renderDeliveryPresentation(undefined)).toBe('');
  });
});
