import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { attachTestedMembership, assertReportEnrichment } from '../scripts/lib/provenance_membership.mjs';

const roots=[];afterEach(()=>roots.splice(0).forEach(root=>fs.rmSync(root,{recursive:true,force:true})));
const ranking=[{gene:'TP53',metric:3},{gene:'TAT',metric:2},{gene:'ACTB',metric:1}];
const membership={testedGenes:['TP53','ACTB'],originalEs:0.75,testedSize:2,referenceCoverage:{referenceTokenCount:3,exactTestedCount:2,unmatchedTokens:['tat'],reason:'absent_from_ranked_universe'}};

describe('captured exact tested membership',()=>{
  it('preserves exact-case upstream IDs and exposes unmatched reference tokens without alias guessing',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'pnv-membership-'));roots.push(root);
    fs.mkdirSync(path.join(root,'scripts/lib'),{recursive:true});fs.writeFileSync(path.join(root,'scripts/lib/provenance_membership.mjs'),'helper');
    const snapshot=path.join(root,'reference.rds');fs.writeFileSync(snapshot,'trusted snapshot fixture');
    const evidence={pathways:{'R-1':{camera:{padj:0.2}}},artifacts:[]};
    const result=attachTestedMembership(evidence,snapshot,{root,projectRoot:root,execute:()=>JSON.stringify({rankedGenes:ranking,pathways:{'R-1':membership}})});
    expect(result.pathways['R-1'].testedGenes).toEqual(['TP53','ACTB']);
    expect(result.pathways['R-1'].referenceCoverage.unmatchedTokens).toEqual(['tat']);
    expect(result.referenceMatching).toBe('exact case-sensitive upstream identifiers');
    expect(result.rankedGenesSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.pathways['R-1'].testedMembershipSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.sourceTables.tested_membership_coverage.rows[0][3]).toBe('tat');
    expect(result.artifacts.map(a=>a.role)).toEqual(expect.arrayContaining(['reference_snapshot','report_membership_helper']));
    expect(evidence.pathways['R-1'].testedGenes).toBeUndefined();
  });
  it('checks actual report hit indices and running-sum ES against captured inference',()=>{
    const viewer={rankedGenes:ranking,evidence:{rankedGenes:ranking,pathways:{'R-1':membership}},pathways:[{pathwayId:'R-1',enrichment:{hitIndices:[1,3],es:0.75}}]};
    expect(assertReportEnrichment(viewer)).toEqual({pathways:1,finiteEs:1,tolerance:1e-8,maxAbsEsDifference:0});
    expect(()=>assertReportEnrichment({...viewer,pathways:[{pathwayId:'R-1',enrichment:{hitIndices:[1,2,3],es:0.75}}]})).toThrow(/membership|hit/);
    expect(()=>assertReportEnrichment({...viewer,pathways:[{pathwayId:'R-1',enrichment:{hitIndices:[1,3],es:0.5}}]})).toThrow(/ES/);
    expect(()=>assertReportEnrichment({...viewer,rankedGenes:[...ranking].reverse()})).toThrow(/rank/);
  });
  it('uses the upstream uniform-hit convention when hit weights are all zero',()=>{
    const rankedGenes=[{gene:'A',metric:2},{gene:'B',metric:1},{gene:'C',metric:0}];
    const viewer={rankedGenes,evidence:{rankedGenes,pathways:{'R-1':{testedGenes:['C'],originalEs:-1,testedSize:1}}},pathways:[{pathwayId:'R-1',enrichment:{hitIndices:[3],es:-1}}]};
    expect(assertReportEnrichment(viewer).finiteEs).toBe(1);
    expect(()=>assertReportEnrichment({...viewer,evidence:{...viewer.evidence,pathways:{'R-1':{testedGenes:['C'],originalEs:0,testedSize:1}}},pathways:[{pathwayId:'R-1',enrichment:{hitIndices:[3],es:0}}]})).toThrow(/zero ES/);
  });
});
