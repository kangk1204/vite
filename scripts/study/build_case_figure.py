#!/usr/bin/env python3
"""Main Figure 1 from frozen pathway tables, valid bootstrap fits and a real report."""
import argparse
import csv
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import json
import math
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET

from build_implementation_figures import (SUPPLEMENTARY_STEMS, canonical_zip, collect_sources, sha256,
    verify_artifact, write_legend_docx, write_source_xlsx, write_tsv)

ROOT = Path(__file__).resolve().parents[2]
KEYS = {'gse68719_pd_primary': 'PD', 'gse102556_mdd_extension': 'MDD'}
CASE_ID = 'R-HSA-449147'
STEM = 'figure1_pathway_selection'
PANEL_A = 'figure1a_bootstrap_distribution'
PANEL_B = 'figure1b_interleukin_report'
DARK = '#19313f'
ORDINARY = '#37788c'
FOCUS = '#ab4d20'
LIMITED = '#762c69'


def descriptor(root, file):
    return {'path': os.path.relpath(file, root), 'sha256': sha256(file), 'sizeBytes': file.stat().st_size}


def decimal_fdr(raw):
    if raw is None or str(raw).strip().lower() in {'', 'na', 'nan', 'null'}:
        return None
    try:
        value = Decimal(str(raw).strip())
    except InvalidOperation as error:
        raise ValueError(f'Invalid pathway FDR {raw!r}') from error
    if not value.is_finite() or not 0 <= value <= 1:
        raise ValueError(f'Pathway FDR outside [0,1]: {raw!r}')
    return value


def make_point(cohort, pathway_id, name, source_row, raw_fdr, bootstrap, source_path):
    fdr = decimal_fdr(raw_fdr)
    requested, selected, valid, matches = [bootstrap[k] for k in ('requested','selected','valid','directionMatches')]
    if any(type(n) is not int for n in (requested,selected,valid,matches)) or not (0 <= selected <= valid <= requested and 0 <= matches <= valid and requested > 0):
        raise ValueError(f'Invalid bootstrap numerator/denominator for {pathway_id}')
    frequency = selected / valid if valid else None
    for key, expected in [('selectionFrequency',frequency),('directionConsistency', matches / valid if valid else None),('validFraction', valid/requested)]:
        if key in bootstrap:
            actual = bootstrap[key]
            if (actual is None) != (expected is None) or (expected is not None and not math.isclose(float(actual),expected,abs_tol=1e-12)):
                raise ValueError(f'{pathway_id} {key} is inconsistent with source counts')
    reasons = []
    if fdr is None:
        reasons.append('missing original FDR')
    if not valid:
        reasons.append('no testable repetitions')
    return {'cohort':cohort,'pathway_id':pathway_id,'pathway_name':name,'original_fdr':None if fdr is None else str(fdr),
        'selected':selected,'valid':valid,'requested':requested,'direction_matches':matches,'selection_frequency':frequency,
        'valid_fraction':valid/requested,'original_significant':fdr is not None and fdr < Decimal('0.05'),
        'below_half':None if valid==0 else 2*selected<valid,'limited_testability':10*valid<9*requested,
        'zero_fdr':fdr==0 if fdr is not None else False,'plotted':not reasons,'exclusion_reason':', '.join(reasons) or None,
        'fdr_source_file':source_path,'fdr_source_table':'pathways','fdr_source_row':source_row,
        'bootstrap_source_key':f'evidence.pathways[{pathway_id}].bootstrap'}


def table_rows(table):
    return [dict(zip(table['columns'],row,strict=True)) for row in table['rows']]


def summarize(points):
    significant = [p for p in points if p['original_significant']]
    return {'all_pathways':len(points),'plotted_pathways':sum(p['plotted'] for p in points),
        'original_significant':len(significant),'significant_with_defined_frequency':sum(p['plotted'] for p in significant),
        'below_half_significant':sum(p['below_half'] is True for p in significant),
        'limited_testability':sum(p['limited_testability'] for p in points),'missing_fdr':sum(p['original_fdr'] is None for p in points),
        'zero_valid':sum(p['valid']==0 for p in points),'zero_fdr':sum(p['zero_fdr'] for p in points)}


def select_example(dataset, evidence):
    complete = [p for p in dataset['rows'] if p['original_fdr'] is not None]
    chosen = min(complete, key=lambda p:(Decimal(p['original_fdr']),p['pathway_id']))
    if chosen['pathway_id'] != CASE_ID:
        raise ValueError('The frozen lowest-FDR example changed. Review the selection rule and report capture.')
    detail = evidence['pathways'][CASE_ID]
    tables = evidence['sourceTables']
    primary = table_rows(tables['pathways'])[chosen['fdr_source_row']-1]
    model = next(item for item in detail['designSensitivity'] if item['designFormula']=='~ group')
    simple = table_rows(tables[model['source']['table']])[model['source']['row']-1]
    cameras=[(i,row) for i,row in enumerate(table_rows(tables['camera']),1) if row['pathway'].split(' :: ')[0] == CASE_ID]
    if len(cameras)!=1 or simple['pathway_id']!=CASE_ID or primary['pathway_id']!=CASE_ID:
        raise ValueError('Example source row identities disagree')
    camera_row,camera=cameras[0]
    for actual, expected in [(camera['padj'],detail['camera']['padj']),(simple['NES'],model['nes']),(simple['padj'],model['padj'])]:
        if not math.isclose(float(actual),float(expected),rel_tol=1e-12):
            raise ValueError('Linked sensitivity numbers disagree with the raw rows')
    return {**chosen,'source_row':chosen['fdr_source_row'],'primary_nes':float(primary['NES']),'primary_es':float(primary['ES']),
        'tested_size':int(primary['size']),'group_only_row':model['source']['row'],'group_only_nes':float(simple['NES']),
        'group_only_fdr':float(simple['padj']),'camera_row':camera_row,'camera_direction':camera['direction'],'camera_fdr':float(camera['padj']),
        'model':evidence['analysis']['designFormula'],'rank_metric':evidence['analysis']['rankMetric'],
        'effect_size_method':evidence['analysis']['lfcMethod'],'adjustment':evidence['analysis']['adjustment'],
        'camera_method':evidence['analysis']['camera'],'alpha':evidence['analysis']['alpha'],
        'reference_tokens':detail['referenceCoverage']['referenceTokenCount'],'selection_rule':'Minimum numeric original PD fgsea FDR; stable pathway ID breaks a tie.',
        'full_report':'../reports/gse68719_pd_primary.report.html','matched_raw_table':'../gse68719_pd_primary/gse68719_pd_vs_control_fgsea_reactome.tsv'}


def load_cases(root):
    manifest_file=root/'paper/manifests/publication_v2.json'
    manifest=json.loads(manifest_file.read_text()); release=root/manifest['outputRoot']
    receipt_file=release/'benchmarks/finalization.json'; receipt=json.loads(receipt_file.read_text())
    inputs=[descriptor(root, manifest_file),descriptor(root, receipt_file)];datasets=[];case=None
    for key,label in KEYS.items():
        cohort=next(c for c in manifest['cohorts'] if c['key']==key)
        finalized=receipt['cohorts'][key]
        derived=cohort['evidencePath'].removesuffix('_evidence.json')+'_report_evidence.json'
        artifact=next(a for a in finalized['artifacts'] if a['path']==derived)
        path=verify_artifact(artifact,root);inputs.append(descriptor(root,path))
        evidence=json.loads(path.read_text())['evidence'];primary=table_rows(evidence['sourceTables']['pathways']);points=[]
        if evidence['analysis']['alpha'] != 0.05:
            raise ValueError('The release selection threshold differs from the figure legend')
        for row_number,row in enumerate(primary,1):
            pid=row['pathway_id'];detail=evidence['pathways'][pid]
            if detail['source']!={'table':'pathways','row':row_number}:
                raise ValueError(f'Primary source link mismatch at {pid}')
            point=make_point(label,pid,row['pathway_name'],row_number,row['padj'],detail['bootstrap'],derived)
            if point['requested']!=500:
                raise ValueError('Case figure requires the frozen 500-repetition data')
            points.append(point)
        if len({p['pathway_id'] for p in points})!=len(points) or len(points)!=evidence['analysis']['pathwayHypothesisCount']:
            raise ValueError('Primary pathway family is incomplete or duplicated')
        dataset={'label':label,'key':key,'accession':cohort['datasetIdentifier'],'rows':points,'summary':summarize(points)};datasets.append(dataset)
        if label=='PD':
            case=select_example(dataset,evidence)
            report_descriptor=next(a for a in finalized['artifacts'] if a['path']==cohort['reportPath'])
            inputs.append(descriptor(root,verify_artifact(report_descriptor,root)))
            viewer_file=cohort['reportPath'].replace('.html','.viewer.json')
            viewer_descriptor=next(a for a in finalized['artifacts'] if a['path']==viewer_file)
            inputs.append(descriptor(root,verify_artifact(viewer_descriptor,root)))
            case['full_viewer_json']=viewer_file
    return datasets,case,inputs


def fdr_coordinate(fdr):
    return math.log1p(-float(Decimal(fdr).log10()))


def draw_distribution(fig, datasets, case, region):
    from matplotlib.lines import Line2D
    from matplotlib.ticker import PercentFormatter
    left,bottom,width,height=region
    points=[p for ds in datasets for p in ds['rows'] if p['plotted']]
    positive_x=[fdr_coordinate(p['original_fdr']) for p in points if not p['zero_fdr']]
    xmax=max(positive_x,default=1);zero_x=xmax+.32;has_zero=any(p['zero_fdr'] for p in points)
    max_axis=zero_x if has_zero else xmax
    ticks=[(fdr_coordinate(q),t) for q,t in [('1','1'),('.05','0.05'),('1e-4',r'$10^{-4}$'),('1e-12',r'$10^{-12}$'),('1e-32',r'$10^{-32}$')] if fdr_coordinate(q)<=xmax+.02]
    if has_zero:ticks.append((zero_x,'0'))
    for i,ds in enumerate(datasets):
        w=(width-.095)/2;ax=fig.add_axes([left+i*(w+.095),bottom,w,height]);s=ds['summary']
        threshold=fdr_coordinate('.05');ax.fill_between([threshold,max_axis+.05],0,.5,color='#fcf1ea',zorder=0)
        for focus in [False,True]:
            selected=[p for p in ds['rows'] if p['plotted'] and (p['original_significant'] and p['below_half'])==focus]
            ax.scatter([zero_x if p['zero_fdr'] else fdr_coordinate(p['original_fdr']) for p in selected], [p['selection_frequency'] for p in selected],
                s=9 if focus else 7,alpha=.73 if focus else .32,c=FOCUS if focus else ORDINARY,linewidths=0,zorder=2 if focus else 1)
        flagged=[p for p in ds['rows'] if p['plotted'] and p['limited_testability']]
        ax.scatter([zero_x if p['zero_fdr'] else fdr_coordinate(p['original_fdr']) for p in flagged], [p['selection_frequency'] for p in flagged],
            marker='^',facecolors='none',edgecolors=LIMITED,s=30,linewidths=.85,zorder=3)
        ax.axvline(threshold,color='#635d58',ls='--',lw=.7,zorder=0);ax.axhline(.5,color='#635d58',ls='--',lw=.7,zorder=0)
        if ds['label']=='PD' and case['plotted']:
            x=zero_x if case['zero_fdr'] else fdr_coordinate(case['original_fdr']);y=case['selection_frequency'];ax.scatter([x],[y],s=51,facecolors='none',edgecolors=DARK,lw=1.15,zorder=4)
            ax.annotate('B',(x,y),xytext=(5,-8),textcoords='offset points',weight='bold',fontsize=8,color=DARK)
        ax.set(xlim=(-.07,max_axis+.06),ylim=(-.035,1.035),yticks=[0,.25,.5,.75,1]);ax.yaxis.set_major_formatter(PercentFormatter(1,decimals=0))
        ax.set_xticks([t[0] for t in ticks], [t[1] for t in ticks]);ax.tick_params(axis='both',labelsize=8,length=3,color='#71828a');ax.spines[['top','right']].set_visible(False)
        ax.spines[['bottom','left']].set_color('#71828a');ax.set_xlabel('Original fgsea FDR',fontsize=9)
        if i==0:ax.set_ylabel('Selected / testable bootstrap fits',fontsize=9)
        ax.text(0,1.18,f"{ds['label']}  ·  {ds['accession']}  ·  {s['all_pathways']:,} pathways", transform=ax.transAxes,fontsize=10,weight='bold',color=DARK)
        ax.text(0,1.065,f"{s['below_half_significant']}/{s['original_significant']} below 50% selection at FDR < 0.05",transform=ax.transAxes,fontsize=8,color=FOCUS)
    handles=[Line2D([],[],marker='o',ls='',ms=4,color=ORDINARY,label='Pathway'),Line2D([],[],marker='o',ls='',ms=4,color=FOCUS,label='FDR < 0.05 and selection < 50%'),
        Line2D([],[],marker='^',ls='',ms=5,markerfacecolor='none',color=LIMITED,label='Testable in < 90% ('+', '.join(f"{d['summary']['limited_testability']} {d['label']}" for d in datasets)+')' )]
    fig.legend(handles=handles,loc='upper center',bbox_to_anchor=(.52,bottom-.49/fig.get_figheight()),frameon=False,ncol=3,fontsize=7.5,handletextpad=.35,columnspacing=1.3)


def draw_report(fig, capture_dir, region):
    from PIL import Image, ImageChops
    left,bottom,width,height=region
    for subregion,file in [((left,bottom,width*.56,height),'figure1b_capture_evidence.png'),((left+width*.585,bottom,width*.415,height),'figure1b_capture_network.png')]:
        snapshot=Image.open(capture_dir/file).convert('RGB')
        if file.endswith('network.png'):
            bounds=ImageChops.difference(snapshot,Image.new('RGB',snapshot.size,'white')).getbbox()
            if bounds:
                snapshot=snapshot.crop(bounds)
        ax=fig.add_axes(subregion);ax.imshow(snapshot);ax.axis('off');ax.set_anchor('N')


def save_formats(fig, stem):
    import matplotlib.pyplot as plt
    for ext,metadata in [('png',{'Software':'Pathway Network Viewer'}),('pdf',{'CreationDate':None,'ModDate':None,'Creator':'Pathway Network Viewer'}),('svg',{'Date':None})]:
        fig.savefig(stem.with_suffix('.'+ext),dpi=350,metadata=metadata,facecolor='white')
    plt.close(fig)


def write_package(stage, name, rows, legend, inputs, extras, metadata):
    prefix=stage/name
    tabular=[{key:'' if value is None else value for key,value in row.items()} for row in rows]
    write_tsv(Path(str(prefix)+'.source.tsv'),tabular);write_source_xlsx(Path(str(prefix)+'.source.xlsx'),tabular)
    Path(str(prefix)+'.legend.txt').write_text(legend+'\n')
    docx=Path(str(prefix)+'.legend.docx');write_legend_docx(docx,name.replace('_',' '),legend);canonical_zip(docx)
    outputs=[stage/f'{name}.{ext}' for ext in ['png','pdf','svg','legend.txt','legend.docx']]+extras
    describe=lambda f:{'path':f.name,'sha256':sha256(f),'sizeBytes':f.stat().st_size}
    manifest={'figure_id':name,'generated_at':datetime.now(timezone.utc).isoformat(),'script':'scripts/study/build_case_figure.py','inputs':inputs,
        'outputs':[describe(f) for f in outputs],'source_data':[describe(stage/f'{name}.source.tsv'),describe(stage/f'{name}.source.xlsx')],
        'path_bases':{'inputs':'repository root','outputs':'manifest directory','source_data':'manifest directory'},
        'panel_claims':metadata,'validation':{'sourceRows':len(rows),'receiptVerified':True},
        'known_limitations':['Within-cohort frequencies depend on the testable resamples. CAMERA and fgsea have different test hypotheses.']}
    Path(str(prefix)+'.manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')


def verify_rendered_numbers(case,capture):
    patterns=[(capture['summary'],r'NES ([\d.eE+\-]+)',case['primary_nes']),
              (capture['summary'],r'FDR ([\d.eE+\-]+)',case['original_fdr']),
              (capture['evidenceText'],r'Design sensitivity: ~ group · NES ([\d.eE+\-]+)',case['group_only_nes']),
              (capture['evidenceText'],r'Design sensitivity: [^\n]+?FDR ([\d.eE+\-]+)',case['group_only_fdr']),
              (capture['evidenceText'],r'CAMERA sensitivity: direction \w+ · FDR ([\d.eE+\-]+)',case['camera_fdr'])]
    for text,pattern,value in patterns:
        match=re.search(pattern,text)
        if match is None:
            raise ValueError(f'Missing report statistic for {pattern}')
        rounded=Decimal(match.group(1).rstrip('.'));precision=Decimal(10)**rounded.as_tuple().exponent
        if abs(rounded-Decimal(str(value)))>precision/2:
            raise ValueError(f'Rendered statistic {rounded} differs from its source value {value}')


def network_tables(root,stage,case,capture):
    viewer=json.loads((root/case['full_viewer_json']).read_text())
    pathway=next(p for p in viewer['pathways'] if p['pathwayId']==case['pathway_id'])
    svg=ET.parse(stage/capture['screenshots']['network']['vectorFile'])
    labels={''.join(el.itertext()).strip() for el in svg.iter() if el.tag.endswith('text') and el.get('fill')!='none'}
    nodes=[n for n in pathway['nodes'] if n['label'] in labels];ids={n['id'] for n in nodes}
    edges=[(i,viewer['sharedEdges'][i]) for i in pathway['edgeIndices'] if viewer['sharedEdges'][i]['source'] in ids and viewer['sharedEdges'][i]['target'] in ids and viewer['sharedEdges'][i]['score']>=700]
    if len(nodes)!=len(labels) or f'{len(nodes)}/{case["tested_size"]} genes · {len(edges)} edges' not in capture['summary']:
        raise ValueError('Captured network differs from the visible nodes/edges in the frozen viewer')
    rows=[{k:n[k] for k in ('id','label','log2fc','padj','isLeadingEdge','sizeMetric')} for n in nodes]
    write_tsv(stage/'figure1b_network_nodes.tsv',rows)
    write_tsv(stage/'figure1b_network_edges.tsv',[{'shared_edge_index':i,**edge} for i,edge in edges])
    return [stage/'figure1b_network_nodes.tsv',stage/'figure1b_network_edges.tsv']


def promote(stage,out):
    files=sorted(stage.iterdir(),key=lambda file:file.name.endswith('.manifest.json'))
    backups=[];installed=[];out.mkdir(parents=True,exist_ok=True)
    try:
        for i,file in enumerate(files):
            target=out/file.name
            if target.exists():
                backup=stage/f'previous-{i}';os.replace(target,backup);backups.append((backup,target))
            os.replace(file,target);installed.append(target)
    except Exception:
        for target in installed:target.unlink(missing_ok=True)
        for backup,target in backups:os.replace(backup,target)
        raise


def update_inventory(root,out):
    stems=[STEM,PANEL_A,PANEL_B,*SUPPLEMENTARY_STEMS]
    inventory=[]
    for stem in stems:
        file=out/(stem+'.manifest.json')
        if not file.exists():
            if stem in SUPPLEMENTARY_STEMS:
                continue
            raise ValueError(f'Missing case figure manifest {file}')
        manifest=json.loads(file.read_text())
        if manifest['figure_id']!=stem:raise ValueError('Figure manifest identifier mismatch')
        for artifact in manifest['outputs']+manifest['source_data']:
            target=out/Path(artifact['path']).name
            if sha256(target)!=artifact['sha256']:raise ValueError(f'Stale figure output {target.name}')
        inventory.append({'figure':stem,'manifest':file.name,'manifestSha256':sha256(file),
            'role':'main' if stem==STEM else 'supplementary' if stem in SUPPLEMENTARY_STEMS else 'panel',
            'sourceRows':manifest['validation'].get('sourceRows',manifest['validation'].get('plotted_rows')),
            'png':stem+'.png','pdf':stem+'.pdf','svg':stem+'.svg'})
    if len(inventory)==len(stems):
        archive=root/'.cache/superseded-figure-identifiers'/datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
        for old in ['figure1_evidence_workflow','figure2_integration_checks']:
            for suffix in ['png','pdf','svg','source.tsv','source.xlsx','legend.txt','legend.docx','manifest.json','validation.txt']:
                file=out/(old+'.'+suffix)
                if file.exists():
                    archive.mkdir(parents=True,exist_ok=True);os.replace(file,archive/file.name)
    index={'status':'pass','scope':'Canonical publication figures with checked output hashes','figures':inventory}
    temp=out/'.figure-package-verification.tmp';temp.write_text(json.dumps(index,indent=2)+'\n');os.replace(temp,out/'figure_package_verification.json')


def scientific(value):
    mantissa,exponent=f'{float(value):.2e}'.split('e')
    return mantissa+' × 10'+str(int(exponent)).translate(str.maketrans('-0123456789','⁻⁰¹²³⁴⁵⁶⁷⁸⁹'))


def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--output',type=Path,default=ROOT/'paper/outputs/publication_v2/figures');args=parser.parse_args()
    root=ROOT;out=args.output.resolve();manifest=root/'paper/manifests/publication_v2.json'
    collect_sources(root,manifest,False)
    datasets,case,inputs=load_cases(root);out.parent.mkdir(parents=True,exist_ok=True)
    inputs += [descriptor(root,Path(__file__).resolve()),descriptor(root,root/'scripts/study/capture_case_figure.mjs'),descriptor(root,root/'scripts/study/build_implementation_figures.py')]
    import matplotlib
    matplotlib.use('Agg');matplotlib.rcParams.update({'font.family':'DejaVu Sans','svg.fonttype':'none','svg.hashsalt':'pnv-case-figure-v1','pdf.fonttype':42,'text.color':DARK,'axes.labelcolor':DARK})
    import matplotlib.pyplot as plt
    with tempfile.TemporaryDirectory(dir=out.parent,prefix='.case-figure-') as temp:
        stage=Path(temp);subprocess.run(['node','scripts/study/capture_case_figure.mjs',str(stage)],cwd=root,check=True)
        capture=json.loads((stage/'figure1b_capture.json').read_text());expected=[('group_only_pathways',case['group_only_row']),('pathways',case['source_row'])]
        if capture['pathwayId']!=case['pathway_id'] or [(r['table'],r['row']) for r in capture['navigation']]!=expected:
            raise ValueError('Captured report and evidence selection differ')
        if not all(s in capture['evidenceText'] for s in [f"{100*case['selection_frequency']:.1f}%",f"{100*case['direction_matches']/case['valid']:.1f}%",f"{case['valid']}/{case['requested']}",'CAMERA sensitivity: direction '+case['camera_direction']]):
            raise ValueError('Report screenshot fields differ from bootstrap/CAMERA source rows')
        verify_rendered_numbers(case,capture)
        graph_tables=network_tables(root,stage,case,capture)
        all_rows=[p for ds in datasets for p in ds['rows']]
        legend_a=('A. Original Reactome fgsea FDR and bootstrap selection frequency in Parkinson disease (PD, GSE68719, n=73) and major depressive disorder (MDD, GSE102556, n=48). Each point represents one pathway. The horizontal axis uses log(1 − log10 FDR) spacing with original FDR labels. Selection frequency is the proportion of testable group-stratified resamples with FDR <0.05. Dashed guides at original FDR 0.05 and frequency 50% define the descriptive comparison. Open triangles identify pathways testable in fewer than 450 of 500 fits. The circled point identifies the example in B.')
        legend_b=(f"B. Chromium capture from the offline PD report, paired with its native network export. {case['pathway_name']} ({case['pathway_id']}) had the lowest original PD fgsea FDR. The adjusted primary model gave NES {case['primary_nes']:.2f} and FDR {scientific(case['original_fdr'])}. The group-only analysis gave NES {case['group_only_nes']:.2f} and FDR {scientific(case['group_only_fdr'])}. The pathway passed the fgsea threshold in {case['selected']} of {case['valid']} testable resamples and retained its original direction in {case['direction_matches']}. CAMERA reported direction {case['camera_direction']} with FDR {case['camera_fdr']:.3f} under its competitive test. The network shows the top 15 displayed genes and nine reference edges in ELK stress layout, with white margins trimmed. In the live report, the source buttons open the primary and group-only data rows.")
        summaries={ds['label']:ds['summary'] for ds in datasets}
        counts=', '.join(f"{v['below_half_significant']}/{v['original_significant']} in {k}" for k,v in summaries.items())
        legend_a+=f' Among pathways with original FDR <0.05, the counts below 50% selection were {counts}.'
        legend='Figure 1. Pathway selection across resampled bulk RNA-seq cohorts and inspection of a PD pathway. '+legend_a+' '+legend_b
        provenance={'thresholds':{'primaryFdrStrict':0.05,'selectionStrict':0.5,'testabilityStrict':0.9},'cohorts':summaries,
            'joinedSources':'Numeric original FDR from the indexed source-table row and integer selection/valid counts from the same pathway ID in evidence.pathways.',
            'zeroPolicy':'True zero FDR is displayed at a separate labeled zero coordinate, if present. A missing FDR or zero valid denominator stays in the source table and has no plotted coordinate.',
            'xScale':'log(1 − log10(original FDR)) for positive FDR; ticks label original FDR.','case':case,'capture':'figure1b_capture.json',
            'fullRows':['figure1a_bootstrap_distribution.source.tsv','figure1b_interleukin_report.source.tsv'],'fullReport':case['full_report']}
        fig=plt.figure(figsize=(7.4,7.1));fig.text(.012,.961,'A',weight='bold',fontsize=14);draw_distribution(fig,datasets,case,(.105,.614,.862,.26));fig.text(.012,.461,'B',weight='bold',fontsize=14);draw_report(fig,stage,(.065,.02,.91,.447));save_formats(fig,stage/STEM)
        fig=plt.figure(figsize=(7.4,3.8));fig.text(.012,.951,'A',weight='bold',fontsize=14);draw_distribution(fig,datasets,case,(.105,.24,.862,.57));save_formats(fig,stage/PANEL_A)
        fig=plt.figure(figsize=(7.4,3.85));fig.text(.012,.92,'B',weight='bold',fontsize=14);draw_report(fig,stage,(.065,.025,.91,.90));save_formats(fig,stage/PANEL_B)
        extras=[stage/'figure1b_capture.json', stage/'figure1b_capture_evidence.png',stage/'figure1b_capture_network.png',stage/'figure1b_network_export.svg',*graph_tables]
        write_package(stage,PANEL_A,all_rows,legend_a,inputs,[],provenance)
        write_package(stage,PANEL_B,[case],legend_b,inputs,extras,{'selection':case,'report':capture['report'],'capture':'figure1b_capture.json'})
        case_fields={key:value for key,value in case.items() if key not in all_rows[0]}
        combined_rows=[{**row,**{f'case_{field}':value if row['cohort']=='PD' and row['pathway_id']==CASE_ID else None for field,value in case_fields.items()}} for row in all_rows]
        write_package(stage,STEM,combined_rows,legend,inputs,extras,provenance)
        for item in inputs:
            verify_artifact(item,root)
        collect_sources(root,manifest,False)
        promote(stage,out)
    update_inventory(root,out)
    print(json.dumps({'output':str(out),'figure':STEM,'distribution':summaries,'example':case['pathway_id']}))


if __name__=='__main__':
    main()
