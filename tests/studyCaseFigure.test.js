// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';

function python(code) {
  const result = spawnSync('python3', ['-c', `import sys;sys.path.insert(0,'scripts/study')\nimport build_case_figure as f\n${code}`], {encoding:'utf8'});
  expect(result.status, result.stderr).toBe(0);
}

describe('Figure 1 source recomputation', () => {
  it('applies strict thresholds, retains missing rows and distinguishes zero FDR from missing FDR', () => {
    python(`
def row(q, n, v, requested=500):
 return f.make_point('PD','R-HSA-test','test',1,q,{'requested':requested,'selected':n,'valid':v,'directionMatches':0},'x.json')
a=row('0.05',249,500);assert not a['original_significant'] and a['plotted']
b=row('0.049',250,500);assert b['original_significant'] and not b['below_half']
c=row('0',0,500);assert c['zero_fdr'] and c['plotted'] and c['below_half']
d=row(None,0,500);assert not d['plotted'] and d['original_fdr'] is None
e=row('0.01',0,0);assert not e['plotted'] and e['selection_frequency'] is None
assert not row('.1',50,450)['limited_testability'];assert row('.1',50,449)['limited_testability']
try: row('0.1',501,500)
except ValueError: pass
else: raise AssertionError('invalid denominator accepted')`);
  });
  it('selects by numeric FDR and recomputes the full release when the analysis artifacts are present', () => {
    python(`
import json
from pathlib import Path
pid=f.CASE_ID;b={'requested':500,'selected':200,'valid':500,'directionMatches':400}
points=[f.make_point('PD',name,name,i,q,b,'test-fixture.json') for i,(name,q) in enumerate([('other','0.09'),(pid,'9e-10')],1)]
cols=['pathway_id','NES','ES','size','padj'];entry=[pid,2.0,0.5,20,'9e-10']
tables={'pathways':{'columns':cols,'rows':[['other',1,0.1,15,'0.09'],entry]},'group_only_pathways':{'columns':cols,'rows':[entry]},'camera':{'columns':['pathway','padj','direction'],'rows':[[pid,0.8,'Up']]}}
e={'sourceTables':tables,'analysis':{'designFormula':'~ group','rankMetric':'Wald','lfcMethod':'apeglm','adjustment':'BH','camera':'CAMERA','alpha':0.05},'pathways':{pid:{'designSensitivity':[{'designFormula':'~ group','nes':2,'padj':9e-10,'source':{'table':'group_only_pathways','row':1}}],'camera':{'padj':0.8},'referenceCoverage':{'referenceTokenCount':30}}}}
case=f.select_example({'rows':points},e);assert case['source_row']==2 and case['group_only_row']==1 and case['camera_row']==1
assert f.summarize(points)['below_half_significant']==1
receipt=Path('paper/outputs/publication_v2/benchmarks/finalization.json')
if receipt.is_file() and set(f.KEYS)<=set(json.loads(receipt.read_text())['cohorts']):
 datasets,case,inputs=f.load_cases(Path.cwd());p,m=datasets
 assert (len(p['rows']),len(m['rows']))==(1342,1326)
 assert [(x['summary']['below_half_significant'],x['summary']['original_significant']) for x in datasets]==[(83,221),(289,757)]
 assert [x['summary']['limited_testability'] for x in datasets]==[5,5]
 assert case['pathway_id']=='R-HSA-449147' and case['source_row']==1 and case['group_only_row']==25 and case['camera_row']==1114
 assert case['selected']==473 and case['direction_matches']==498 and case['valid']==500
 assert abs(case['camera_fdr']-0.83327907261093)<1e-14`);
  }, 60000);
  it('rejects a captured CAMERA value that disagrees with the separate CAMERA source row', () => {
    python(`
c={'primary_nes':2.312,'original_fdr':'2.6475e-16','group_only_nes':2.179,'group_only_fdr':8.046e-13,'camera_fdr':0.8333}
view={'summary':'NES 2.31 · FDR 2.65e-16','evidenceText':'Design sensitivity: ~ group · NES 2.18 · FDR 8.05e-13.\\nCAMERA sensitivity: direction Up · FDR 8.33e-1.'}
f.verify_rendered_numbers(c,view)
view['evidenceText']=view['evidenceText'].replace('8.33e-1','2.65e-16')
try:f.verify_rendered_numbers(c,view)
except ValueError:pass
else:raise AssertionError('CAMERA and fgsea swapped')`);
  });
});
