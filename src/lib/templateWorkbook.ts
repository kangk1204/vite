import * as XLSX from 'xlsx';
import { downloadBlob } from './utils';

export function downloadTemplateWorkbook(): void {
  const workbook = XLSX.utils.book_new();

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ['Sheet', 'Purpose', 'Required', 'Notes'],
      ['Project', 'Study metadata', 'Yes', 'Fill exactly one row.'],
      ['Genes', 'DEG statistics and mean expression', 'Yes', 'One row per gene.'],
      ['Pathways', 'GSEA pathway results', 'Yes', 'One row per enriched pathway.'],
      ['GeneLabels', 'Optional label override', 'No', 'Only for publication labels.'],
      ['Samples', 'Optional sample-level expression', 'No', 'Wide format; one row per gene.'],
      ['CustomPPI', 'Optional edge override', 'No', 'Merged into built-in STRING edges.'],
      [],
      ['Leading edge format', 'Use ; , | or new lines between genes (e.g., TP53;CDKN1A;MDM2)', '', ''],
    ]),
    'Instructions',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        project_title: 'KRAS inhibitor response',
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
        log2fc: -1.52,
        padj: 0.0008,
        pvalue: 0.00001,
        rank_metric: -7.8,
        condition_a_mean: 11.2,
        condition_b_mean: 7.4,
        Sample_01: 10.8,
        Sample_02: 11.6,
        Sample_03: 7.1,
        Sample_04: 7.7,
      },
      {
        gene_symbol: 'CDKN1A',
        log2fc: 1.84,
        padj: 0.0002,
        pvalue: 0.000002,
        rank_metric: 8.2,
        condition_a_mean: 6.1,
        condition_b_mean: 10.5,
        Sample_01: 5.9,
        Sample_02: 6.3,
        Sample_03: 10.2,
        Sample_04: 10.8,
      },
      {
        gene_symbol: 'MDM2',
        log2fc: -0.92,
        padj: 0.014,
        pvalue: 0.0011,
        rank_metric: -4.3,
        condition_a_mean: 9.1,
        condition_b_mean: 7.5,
        Sample_01: 8.9,
        Sample_02: 9.3,
        Sample_03: 7.2,
        Sample_04: 7.8,
      },
      {
        gene_symbol: 'BAX',
        log2fc: 1.16,
        padj: 0.008,
        pvalue: 0.0009,
        rank_metric: 5.1,
        condition_a_mean: 4.8,
        condition_b_mean: 6.9,
        Sample_01: 4.6,
        Sample_02: 5.0,
        Sample_03: 6.7,
        Sample_04: 7.1,
      },
    ]),
    'Genes',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        pathway_id: '',
        pathway_name: 'HALLMARK_P53_PATHWAY',
        collection: 'Hallmark',
        nes: 2.14,
        padj: 0.004,
        leading_edge_genes: 'TP53;CDKN1A;MDM2;BAX',
      },
      {
        pathway_id: 'R-HSA-69580',
        pathway_name: 'p53-Dependent G1 DNA Damage Response',
        collection: 'Reactome',
        nes: 1.92,
        padj: 0.013,
        leading_edge_genes: 'TP53;CDKN1A;BAX',
      },
    ]),
    'Pathways',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      { gene_symbol: 'TP53', label: 'TP53', priority: 10 },
      { gene_symbol: 'CDKN1A', label: 'p21', priority: 9 },
    ]),
    'GeneLabels',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      {
        gene_symbol: 'TP53',
        Sample_01: 10.8,
        Sample_02: 11.6,
        Sample_03: 7.1,
        Sample_04: 7.7,
      },
      {
        gene_symbol: 'CDKN1A',
        Sample_01: 5.9,
        Sample_02: 6.3,
        Sample_03: 10.2,
        Sample_04: 10.8,
      },
    ]),
    'Samples',
  );

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet([
      { gene_a: 'TP53', gene_b: 'CDKN1A', score: 990 },
      { gene_a: 'TP53', gene_b: 'MDM2', score: 980 },
    ]),
    'CustomPPI',
  );

  const arrayBuffer = XLSX.write(workbook, {
    bookType: 'xlsx',
    type: 'array',
  });

  downloadBlob(
    'PathwayViewer_Template.xlsx',
    new Blob([arrayBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    }),
  );
}
