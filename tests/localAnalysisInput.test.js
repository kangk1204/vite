import { describe, expect, it } from 'vitest';
import { prepareLocalInput } from '../scripts/lib/local_input.mjs';

function bundle() {
  return {
    schemaVersion: 1, kind: 'pnv-local-analysis-input',
    project: { title: 'Study', accession: 'GSE_TEST', organism: 'Homo sapiens', conditionA: 'Control', conditionB: 'Treatment' },
    rawCountsText: 'GeneID\tctrl_1\tctrl_2\ttreat_1\ttreat_2\n7157\t10\t11\t12\t13\n',
    seriesMatrixText: '!Sample_geo_accession\t"GSM1"\t"GSM2"\t"GSM3"\t"GSM4"\n!Sample_title\t"ctrl_1"\t"ctrl_2"\t"treat_1"\t"treat_2"',
    design: { groupBySample: { GSM1: 'A', GSM2: 'A', GSM3: 'B', GSM4: 'B' } },
  };
}

describe('local R input preparation', () => {
  it('aligns explicit metadata IDs to raw count titles and preserves count bytes', () => {
    const input = bundle();
    const prepared = prepareLocalInput(input);
    expect(prepared.metadataTsv).toBe('sample\tgroup\nctrl_1\tA\nctrl_2\tA\ntreat_1\tB\ntreat_2\tB\n');
    expect(prepared.rawCountsText).toBe(input.rawCountsText);
    expect(prepared.config.designFormula).toBe('~ group');
    expect(prepared.config.geneIdentifierType).toBe('auto');
    expect(input.design.groupBySample.GSM1).toBe('A');
  });

  it('leaves Ensembl and numeric identifiers to the R mapping adapter regardless of header', () => {
    const input = bundle();
    input.rawCountsText = input.rawCountsText.replace('GeneID', 'Gene').replace('7157', 'ENSG00000141510');
    expect(prepareLocalInput(input).config.geneIdentifierType).toBe('auto');
    input.rawCountsText = input.rawCountsText.replace('ENSG00000141510', '7157');
    expect(prepareLocalInput(input).config.geneIdentifierType).toBe('auto');
  });

  it('constructs a trusted batch formula and never executes user strings', () => {
    const input = bundle();
    input.design.batchBySample = { GSM1: 'x', GSM2: 'y', GSM3: 'x', GSM4: 'y' };
    input.design.batchFactorName = 'run';
    expect(prepareLocalInput(input).config.designFormula).toBe('~ batch + group');
    input.design.designFormula = '~ system("bad")';
    expect(() => prepareLocalInput(input)).toThrow(/unsupported|unexpected/i);
  });

  it('rejects unknown assignments, missing labels, and too few biological replicates', () => {
    const input = bundle();
    input.design.groupBySample.GSM5 = 'A';
    expect(() => prepareLocalInput(input)).toThrow(/unknown sample/i);
    delete input.design.groupBySample.GSM5;
    delete input.design.groupBySample.GSM4;
    expect(() => prepareLocalInput(input)).toThrow(/assignment/i);
    input.design.groupBySample.GSM4 = 'U';
    expect(() => prepareLocalInput(input)).toThrow(/two|2/);
  });

  it('rejects duplicate headers, ambiguous alignment, and invalid raw counts', () => {
    const input = bundle();
    input.rawCountsText = input.rawCountsText.replace('ctrl_2', 'ctrl_1');
    expect(() => prepareLocalInput(input)).toThrow(/duplicate/i);
    input.rawCountsText = bundle().rawCountsText.replace('\t10\t', '\t-1\t');
    expect(() => prepareLocalInput(input)).toThrow(/non-negative integer/i);
    input.rawCountsText = bundle().rawCountsText.replace('ctrl_1', 'unmatched');
    expect(() => prepareLocalInput(input)).toThrow(/align/i);
  });

  it('accepts integer-valued scientific notation without altering input bytes',()=>{
    const input=bundle(); input.rawCountsText=input.rawCountsText.replace('\t10\t','\t1e1\t');
    expect(prepareLocalInput(input).rawCountsText).toBe(input.rawCountsText);
  });

  it('never lets a title steal another sample accession column', () => {
    const input = bundle();
    input.rawCountsText = 'GeneID\tGSM2\tA\tGSM3\tGSM4\n7157\t10\t11\t12\t13\n';
    input.seriesMatrixText = '!Sample_geo_accession\tGSM1\tGSM2\tGSM3\tGSM4\n!Sample_title\tGSM2\tA\tT3\tT4';
    expect(() => prepareLocalInput(input)).toThrow(/align/i);
    input.seriesMatrixText = '!Sample_geo_accession\tGSM2\tGSM1\tGSM3\tGSM4\n!Sample_title\tA\tGSM2\tT3\tT4';
    expect(() => prepareLocalInput(input)).toThrow(/align/i);
    input.rawCountsText = input.rawCountsText.replace('GSM2', 'gsm-2');
    input.seriesMatrixText = '!Sample_geo_accession\tGSM1\tGSM2\tGSM3\tGSM4\n!Sample_title\tgsm-2\tA\tT3\tT4';
    expect(() => prepareLocalInput(input)).toThrow(/align/i);
  });

  it('rejects shared-title proposals without depending on metadata row order', () => {
    const input = bundle();
    input.rawCountsText = 'GeneID\tshared\tother\tGSM3\tGSM4\n7157\t10\t11\t12\t13\n';
    input.seriesMatrixText = '!Sample_geo_accession\tGSM1\tGSM2\tGSM3\tGSM4\n!Sample_title\tshared\tshared\tT3\tT4';
    expect(() => prepareLocalInput(input)).toThrow(/align/i);
  });

  it('rejects non-human studies, malformed records and unsupported schema versions', () => {
    expect(() => prepareLocalInput([])).toThrow();
    expect(() => prepareLocalInput({ ...bundle(), schemaVersion: 5 })).toThrow(/version/i);
    const input = bundle();
    input.project.organism = 'Mus musculus';
    expect(() => prepareLocalInput(input)).toThrow(/human/i);
  });
});
