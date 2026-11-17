"""Verify original PD values and raw context in the final native executions."""
import csv,hashlib,json
from pathlib import Path
BASE=Path(__file__).resolve().parents[2]/'paper/outputs/publication_2026_11_17/comparators'
def rows(file,key):
    data=list(csv.DictReader(file.open(),delimiter='\t'))
    if len({r[key]for r in data})!=len(data):raise ValueError('Duplicate result identifier')
    return {r[key]:r for r in data}
def number(x):return None if x in ('','NA','NaN')else float(x)
def compare(a,b,columns):
    if set(a)!=set(b):raise ValueError('Identifier mismatch')
    result={}
    for column in columns:
        delta=[]
        for key in a:
            x,y=number(a[key][column]),number(b[key][column])
            if(x is None)!=(y is None):raise ValueError('Missingness differs')
            if x is not None:
                d=abs(x-y)
                if d>1e-8+1e-8*abs(x):raise ValueError('Statistical value differs')
                delta.append(d)
        result[column]=max(delta,default=0)
    return result
def verify(base=BASE):
    genes=rows(base/'shared-evidence/genes.tsv','gene');paths=rows(base/'shared-evidence/pathways.tsv','pathway');out=[]
    for case in ['D01','D02','D03']:
        context=json.loads((base/f'matched_tasks/deliveries/{case}/native-context.json').read_text())
        for tool,folder in [('genetonic','native-deliveries'),('rnamel','native-rnamel-final')]:
            directory=base/f'{folder}/{case}/{tool}-matched';m=json.loads((directory/'metrics.json').read_text())
            if not m['completed']:raise ValueError('Incomplete native run')
            g=compare(genes,rows(directory/'gene_statistics.tsv','gene'),['baseMean','log2FoldChange','lfcSE','stat','pvalue','padj','log2FoldChangeUnshrunk'])
            observed=rows(directory/'pathway_statistics.tsv','pathway');p=compare(paths,observed,['ES','NES','pval','padj','size'])
            if any(set(paths[k]['leadingEdge'].split(';'))!=set(observed[k]['leadingEdge'].split(';'))for k in paths):raise ValueError('Leading edge mismatch')
            fields=rows(directory/'native-supplied-pathway-fields.tsv','pathway')['R-HSA-449147 :: Signaling by Interleukins']
            for group in ['A','B']:
                if fields['supplied_requested_group_'+group]!=context['requestedContrast']['condition'+group]:raise ValueError('Requested label mismatch')
            for label,key in [('declared','declaredFiles'),('delivered','deliveredFiles')]:
                if json.loads(fields['supplied_'+label+'_files'])!=context[key]:raise ValueError('File-record mismatch')
            out.append({'delivery':case,'tool':m['tool'],'version':m['version'],'genes':len(genes),'pathways':len(paths),
                'geneMaximumDifferences':g,'pathwayMaximumDifferences':p,'leadingEdgesIdentical':True,'rawContextIdentical':True,
                'reportSha256':hashlib.sha256((directory/Path(m['reportPath']).name).read_bytes()).hexdigest()})
    result={'schemaVersion':1,'scope':'Original values and raw input-field preservation; no task or user-performance score',
        'scriptSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'absoluteTolerance':1e-8,'relativeTolerance':1e-8,'results':out}
    (base/'native-data-preservation.json').write_text(json.dumps(result,indent=2)+'\n');return result
if __name__=='__main__':print(json.dumps({'runsVerified':len(verify()['results'])}))
