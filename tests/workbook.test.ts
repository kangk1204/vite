import { describe, expect, it } from 'vitest';
import * as XLSX from 'xlsx';
import { parseWorkbookBuffer } from '../src/lib/workbook';
import huriAdjacency from '../src/reference/generated/huri.json';

function pickAnyHuriGenePair(): [string, string] {
  const adjacency = huriAdjacency as unknown as Record<string, Array<[string, number | string]>>;
  for (const [source, neighbors] of Object.entries(adjacency)) {
    const neighbor = neighbors?.[0]?.[0];
    if (typeof neighbor === 'string' && neighbor) {
      return [source, neighbor];
    }
  }
  throw new Error('No HuRI gene pair available in generated reference.');
}

function buildWorkbookBuffer(): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        project_title: 'Example study',
        contrast_name: 'Drug_vs_Control',
        condition_a: 'Control',
        condition_b: 'Drug',
        species: 'human',
      },
    ]),
    'Project',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        gene_symbol: 'TP53',
        log2fc: -1.5,
        padj: 0.001,
        pvalue: 0.00001,
        rank_metric: -8.5,
        condition_a_mean: 10.1,
        condition_b_mean: 7.2,
      },
      {
        gene_symbol: 'CDKN1A',
        log2fc: 1.6,
        padj: 0.002,
        pvalue: 0.00002,
        rank_metric: 7.1,
        condition_a_mean: 5.1,
        condition_b_mean: 8.8,
      },
    ]),
    'Genes',
  );
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        pathway_name: 'HALLMARK_P53_PATHWAY',
        collection: 'Hallmark',
        nes: 2.0,
        padj: 0.01,
        leading_edge_genes: 'TP53;CDKN1A',
      },
    ]),
    'Pathways',
  );

  return XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
}

describe('parseWorkbookBuffer', () => {
  it('parses a valid workbook and falls back to leading-edge genes when needed', () => {
    const result = parseWorkbookBuffer(buildWorkbookBuffer());
    expect(result.viewerData).not.toBeNull();
    expect(result.summary.totalGenes).toBe(2);
    expect(result.summary.totalPathways).toBe(1);
    expect(result.viewerData?.pathways[0].leadingEdgeGenes).toEqual(['TP53', 'CDKN1A']);
  });

  it('reports a missing sheet as an error', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([{ project_title: 'Missing genes', contrast_name: 'A_vs_B', condition_a: 'A', condition_b: 'B' }]),
      'Project',
    );
    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).toBeNull();
    expect(result.issues.some((issue) => issue.level === 'error')).toBe(true);
    expect(result.issues.some((issue) => issue.message.includes('Project sheet is missing columns'))).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Genes sheet is missing columns'))).toBe(false);
    expect(result.issues.some((issue) => issue.message.includes('Pathways sheet is missing columns'))).toBe(false);
  });

  it('does not emit redundant project missing-columns errors when Project sheet is absent', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: -1.2,
          padj: 0.001,
          pvalue: 0.0001,
          rank_metric: -7.2,
          condition_a_mean: 4.5,
          condition_b_mean: 2.4,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.01,
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).toBeNull();
    expect(result.issues.some((issue) => issue.message.includes('Missing required sheet: Project'))).toBe(true);
    expect(result.issues.some((issue) => issue.message.includes('Project sheet is missing columns'))).toBe(false);
  });

  it('accepts workbook headers with mixed case and spaces', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          'Project Title': 'Flexible headers',
          'Contrast Name': 'B_vs_A',
          'Condition A': 'A',
          'Condition B': 'B',
          Species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          'Gene Symbol': 'TP53',
          Log2FC: -1.2,
          PADJ: 0.001,
          PValue: 0.0001,
          'Rank Metric': -7.2,
          'Condition A Mean': 4.5,
          'Condition B Mean': 2.4,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          'Pathway Name': 'HALLMARK_P53_PATHWAY',
          Collection: 'Hallmark',
          NES: 2.1,
          PADJ: 0.01,
          'Leading Edge Genes': 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(result.summary.totalGenes).toBe(1);
    expect(result.summary.totalPathways).toBe(1);
    expect(result.issues.some((issue) => issue.level === 'error')).toBe(false);
  });

  it('falls back to default project labels when project fields are blank strings', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: '   ',
          contrast_name: '',
          condition_a: ' ',
          condition_b: '  ',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: -1.2,
          padj: 0.001,
          pvalue: 0.0001,
          rank_metric: -7.2,
          condition_a_mean: 4.5,
          condition_b_mean: 2.4,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.01,
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(result.viewerData?.project.projectTitle).toBe('Pathway Network Viewer Study');
    expect(result.viewerData?.project.contrastName).toBe('Condition_B_vs_A');
    expect(result.viewerData?.project.conditionA).toBe('Condition A');
    expect(result.viewerData?.project.conditionB).toBe('Condition B');
  });

  it('keeps padj=0 as the highest significance when computing node size metric', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Zero padj',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: -1.2,
          padj: 0,
          pvalue: 0.1,
          rank_metric: -7.2,
          condition_a_mean: 4.5,
          condition_b_mean: 2.4,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.01,
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(result.viewerData?.pathways[0].nodes[0].sizeMetric).toBe(12);
  });

  it('parses common exported numeric text formats (detection-limit and locale thousands)', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Locale numeric parsing',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: '1,25',
          padj: '<1e-300',
          pvalue: '0,0002',
          rank_metric: '1,5',
          condition_a_mean: '1.234,5',
          condition_b_mean: "12'345,6",
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: '2,10',
          padj: '0,02',
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(result.viewerData?.pathways[0].nodes[0].sizeMetric).toBe(12);
    expect(result.viewerData?.pathways[0].nodes[0].conditionAMean).toBe(1234.5);
    expect(result.viewerData?.pathways[0].nodes[0].conditionBMean).toBe(12345.6);
    expect(
      result.issues.some((issue) => issue.message.includes('non-numeric statistics')),
    ).toBe(false);
  });

  it('parses accounting negatives and unicode minus signs in workbook numerics', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Accounting numeric parsing',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: '(1.25)',
          padj: '0.001',
          pvalue: '0.0002',
          rank_metric: '−2.5',
          condition_a_mean: '(1,234.5)',
          condition_b_mean: '(−987.6)',
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: '(2.10)',
          padj: '0.02',
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    const node = result.viewerData?.pathways[0].nodes[0];
    expect(node?.log2fc).toBe(-1.25);
    expect(node?.conditionAMean).toBe(-1234.5);
    expect(node?.conditionBMean).toBe(-987.6);
    expect(result.viewerData?.pathways[0].nes).toBe(-2.1);
    expect(
      result.issues.some((issue) => issue.message.includes('non-numeric statistics')),
    ).toBe(false);
  });

  it('keeps the most significant duplicate gene row when a later duplicate has missing significance', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Duplicate significance',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: -1.5,
          padj: 0.001,
          pvalue: 0.0001,
          rank_metric: -8.5,
          condition_a_mean: 10.1,
          condition_b_mean: 7.2,
        },
        {
          gene_symbol: 'TP53',
          log2fc: -1.2,
          padj: '',
          pvalue: '',
          rank_metric: -8.0,
          condition_a_mean: 10.0,
          condition_b_mean: 7.1,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: 2.0,
          padj: 0.01,
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    const node = result.viewerData?.pathways[0].nodes[0];
    expect(node?.padj).toBe(0.001);
    expect(node?.pvalue).toBe(0.0001);
    expect(node?.sizeMetric).toBeGreaterThan(2);
  });

  it('accepts leading-edge genes separated by new lines and pipes', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Flexible leading-edge delimiters',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: -1.2,
          padj: 0.001,
          pvalue: 0.0001,
          rank_metric: -7.2,
          condition_a_mean: 4.5,
          condition_b_mean: 2.4,
        },
        {
          gene_symbol: 'CDKN1A',
          log2fc: 1.1,
          padj: 0.002,
          pvalue: 0.0002,
          rank_metric: 6.3,
          condition_a_mean: 3.5,
          condition_b_mean: 5.4,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.01,
          leading_edge_genes: 'TP53\nCDKN1A|TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(result.viewerData?.pathways[0].leadingEdgeGenes).toEqual(['TP53', 'CDKN1A']);
  });

  it('keeps duplicate pathway rows by assigning unique keys instead of overwriting', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Duplicate pathways',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: -1.5,
          padj: 0.001,
          pvalue: 0.0001,
          rank_metric: -8.5,
          condition_a_mean: 10.1,
          condition_b_mean: 7.2,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          pathway_id: '',
          nes: 2.0,
          padj: 0.01,
          leading_edge_genes: 'TP53',
        },
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          pathway_id: '',
          nes: 1.8,
          padj: 0.02,
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(result.viewerData?.pathways).toHaveLength(2);
    const pathwayKeys = result.viewerData?.pathways.map((pathway) => pathway.key) ?? [];
    expect(new Set(pathwayKeys).size).toBe(2);
    expect(pathwayKeys.some((key) => key.includes('::dup2'))).toBe(true);
    expect(
      result.issues.some(
        (issue) =>
          issue.level === 'warning' &&
          issue.message.includes('Duplicate pathway identifier'),
      ),
    ).toBe(true);
  });

  it('warns and keeps ordering stable when pathway NES/FDR are non-numeric', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Non-numeric pathway stats',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: -1.2,
          padj: 0.001,
          pvalue: 0.0001,
          rank_metric: -7.2,
          condition_a_mean: 4.5,
          condition_b_mean: 2.4,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'A_PATHWAY',
          collection: 'Hallmark',
          nes: 'bad-value',
          padj: 'missing',
          leading_edge_genes: 'TP53',
        },
        {
          pathway_name: 'B_PATHWAY',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.02,
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(result.viewerData?.pathways[0].pathwayName).toBe('B_PATHWAY');
    expect(
      result.issues.some(
        (issue) =>
          issue.level === 'warning' &&
          issue.message.includes('non-numeric NES or FDR'),
      ),
    ).toBe(true);
  });

  it('caps per-gene sample values to keep memory usage bounded', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Sample cap',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );

    const geneRow: Record<string, string | number> = {
      gene_symbol: 'TP53',
      log2fc: -1.2,
      padj: 0.001,
      pvalue: 0.0001,
      rank_metric: -7.2,
      condition_a_mean: 4.5,
      condition_b_mean: 2.4,
    };
    for (let index = 1; index <= 210; index += 1) {
      geneRow[`sample_${index}`] = index;
    }
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([geneRow]), 'Genes');
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.02,
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    const node = result.viewerData?.pathways[0].nodes[0];
    expect(Object.keys(node?.sampleValues ?? {})).toHaveLength(160);
    expect(
      result.issues.some(
        (issue) =>
          issue.level === 'info' &&
          issue.message.includes('extra sample columns were omitted'),
      ),
    ).toBe(true);
  });

  it('marks built-in HuRI interactions on pathway network edges', () => {
    const [geneA, geneB] = pickAnyHuriGenePair();
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'HuRI edge source',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: geneA,
          log2fc: -1.2,
          padj: 0.001,
          pvalue: 0.0001,
          rank_metric: -7.2,
          condition_a_mean: 4.5,
          condition_b_mean: 2.4,
        },
        {
          gene_symbol: geneB,
          log2fc: 1.2,
          padj: 0.002,
          pvalue: 0.0002,
          rank_metric: 6.8,
          condition_a_mean: 3.8,
          condition_b_mean: 5.2,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HuRI interaction test',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.01,
          leading_edge_genes: `${geneA};${geneB}`,
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    const edges = result.viewerData?.pathways[0].edges ?? [];
    const pairEdge = edges.find(
      (edge) =>
        (edge.source === geneA && edge.target === geneB) ||
        (edge.source === geneB && edge.target === geneA),
    );
    expect(pairEdge).toBeDefined();
    expect(pairEdge?.isHuRI).toBe(true);
  });

  it('reports unknown non-empty gene symbols instead of silently accepting them', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Unknown genes',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          gene_symbol: 'TP53',
          log2fc: -1.2,
          padj: 0.001,
          pvalue: 0.0001,
          rank_metric: -7.2,
          condition_a_mean: 4.5,
          condition_b_mean: 2.4,
        },
        {
          gene_symbol: 'FAKEGENE123',
          log2fc: 1.1,
          padj: 0.02,
          pvalue: 0.001,
          rank_metric: 3.4,
          condition_a_mean: 3.5,
          condition_b_mean: 5.4,
        },
      ]),
      'Genes',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.02,
          leading_edge_genes: 'TP53;FAKEGENE123',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(result.summary.totalGenes).toBe(1);
    expect(result.summary.unknownGenes).toBe(1);
    expect(
      result.issues.some(
        (issue) =>
          issue.level === 'warning' &&
          issue.message.includes('Unrecognized gene symbol "FAKEGENE123" skipped.'),
      ),
    ).toBe(true);
  });

  it('keeps duplicate-gene sample merges capped at the per-gene sample limit', () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          project_title: 'Duplicate sample cap',
          contrast_name: 'B_vs_A',
          condition_a: 'A',
          condition_b: 'B',
          species: 'human',
        },
      ]),
      'Project',
    );

    const firstRow: Record<string, string | number> = {
      gene_symbol: 'TP53',
      log2fc: -1.2,
      padj: 0.001,
      pvalue: 0.0001,
      rank_metric: -7.2,
      condition_a_mean: 4.5,
      condition_b_mean: 2.4,
    };
    const secondRow: Record<string, string | number> = {
      gene_symbol: 'TP53',
      log2fc: -1.1,
      padj: 0.002,
      pvalue: 0.0002,
      rank_metric: -6.8,
      condition_a_mean: 4.7,
      condition_b_mean: 2.6,
    };
    for (let index = 1; index <= 100; index += 1) {
      firstRow[`sample_dup_a_${index}`] = index;
      secondRow[`sample_dup_b_${index}`] = index + 100;
    }
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([firstRow, secondRow]), 'Genes');
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet([
        {
          pathway_name: 'HALLMARK_P53_PATHWAY',
          collection: 'Hallmark',
          nes: 2.1,
          padj: 0.02,
          leading_edge_genes: 'TP53',
        },
      ]),
      'Pathways',
    );

    const buffer = XLSX.write(workbook, { bookType: 'xlsx', type: 'array' });
    const result = parseWorkbookBuffer(buffer);
    expect(result.viewerData).not.toBeNull();
    expect(Object.keys(result.viewerData?.pathways[0].nodes[0].sampleValues ?? {})).toHaveLength(160);
    expect(
      result.issues.some(
        (issue) =>
          issue.level === 'info' &&
          issue.message.includes('extra sample columns were omitted'),
      ),
    ).toBe(true);
  });

});
