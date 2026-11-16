// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function python(source) {
  const code = `import sys;sys.path.insert(0,'scripts')\nimport build_delivery_validation_figure as f\n${source}`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8' });
  expect(result.status, result.stderr).toBe(0);
}

describe('public delivery validation figure', () => {
  it('distinguishes missing artifacts and unrequested check categories', () => {
    python(`
row={'id':'missing-file','expectedTechnicalOutcome':'unverifiable','observed':'unverifiable','entryPoint':'inspect_delivery and build_report_from_workbook','fullBasicRawEqual':True,'checks':[{'id':'artifact:0','status':'pass'},{'id':'artifact:1','status':'unknown'}]}
summary=f.summarize_case(row)
assert summary['artifact_pass']==1 and summary['artifact_unknown']==1
assert summary['claim_total']==0 and summary['claim_state']=='unavailable'
`);
  });

  it('retains the record-only biological-label limit and refuses contradictory outcomes', () => {
    python(`
row={'id':'consistent-labels','expectedTechnicalOutcome':'normal','observed':'normal','entryPoint':'inspect_delivery record-only','biologicalLabelAssessment':'unresolved','fullBasicRawEqual':None,'checks':[]}
summary=f.summarize_case(row)
assert summary['biological_label_assessment']=='unresolved' and summary['scope']=='record-only'
assert summary['paired_raw_evidence_equal'] is None
row['observed']='mismatch'
try:f.summarize_case(row)
except ValueError:pass
else:raise AssertionError('contradictory technical observation was silently plotted')
`);
  });
});
