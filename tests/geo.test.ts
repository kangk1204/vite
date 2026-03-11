import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyzeGeoDatasetFromText,
  parseGeoDownloadLinksFromHtml,
  previewGeoSeriesDesignFromText,
  searchGeoDatasets,
} from '../src/lib/geo';

const RAW_COUNTS_TEXT = [
  'GeneID\tGSM_A1\tGSM_A2\tGSM_B1\tGSM_B2',
  '7157\t120\t115\t420\t405',
  '1956\t90\t84\t260\t245',
  '7422\t65\t62\t18\t15',
  '5290\t150\t148\t235\t228',
  '4609\t45\t39\t210\t198',
  '673\t34\t31\t120\t114',
  '5979\t66\t64\t210\t205',
  '2064\t44\t41\t182\t170',
  '5594\t80\t76\t166\t160',
  '1958\t30\t28\t110\t102',
  '207\t22\t21\t74\t69',
].join('\n');

const SERIES_MATRIX_TEXT = [
  '!Sample_geo_accession\t"GSM_A1"\t"GSM_A2"\t"GSM_B1"\t"GSM_B2"',
  '!Sample_title\t"control rep1"\t"control rep2"\t"treated rep1"\t"treated rep2"',
  '!Sample_characteristics_ch1\t"group: control"\t"group: control"\t"group: treated"\t"group: treated"',
  '!Sample_characteristics_ch1\t"timepoint: baseline"\t"timepoint: baseline"\t"timepoint: baseline"\t"timepoint: baseline"',
  '!series_matrix_table_begin',
  '"ID_REF"\t"GSM_A1"\t"GSM_A2"\t"GSM_B1"\t"GSM_B2"',
  '!series_matrix_table_end',
].join('\n');

describe('analyzeGeoDatasetFromText', () => {
  it('builds a design preview with default grouping and factors', () => {
    const preview = previewGeoSeriesDesignFromText(SERIES_MATRIX_TEXT);
    expect(preview.sampleIds).toHaveLength(4);
    expect(preview.defaultConditionA).toBe('control');
    expect(preview.defaultConditionB).toBe('treated');
    expect(preview.defaultGroupBySample.GSM_A1).toBe('A');
    expect(preview.defaultGroupBySample.GSM_B2).toBe('B');
    expect(preview.factors.some((factor) => factor.id.includes('group'))).toBe(true);
  });

  it('builds viewer data from GEO-style raw counts and series metadata', () => {
    const result = analyzeGeoDatasetFromText({
      accession: 'GSE_TEST',
      title: 'Synthetic GEO Study',
      organism: 'Homo sapiens',
      rawCountsText: RAW_COUNTS_TEXT,
      seriesMatrixText: SERIES_MATRIX_TEXT,
    });

    expect(result.viewerData).not.toBeNull();
    expect(result.summary.totalGenes).toBeGreaterThan(0);
    expect(result.summary.totalPathways).toBeGreaterThan(0);
    expect(result.viewerData?.project.conditionA).toBe('control');
    expect(result.viewerData?.project.conditionB).toBe('treated');
    expect(
      result.issues.some((issue) =>
        issue.message.includes('GEO auto-analysis uses browser-side approximations'),
      ),
    ).toBe(true);
  });

  it('applies user-defined group labels and batch covariate in analysis', () => {
    const seriesWithBatch = [
      '!Sample_geo_accession\t"GSM_A1"\t"GSM_A2"\t"GSM_B1"\t"GSM_B2"',
      '!Sample_title\t"control rep1"\t"control rep2"\t"treated rep1"\t"treated rep2"',
      '!Sample_characteristics_ch1\t"group: control"\t"group: control"\t"group: treated"\t"group: treated"',
      '!Sample_characteristics_ch1\t"batch: run1"\t"batch: run2"\t"batch: run1"\t"batch: run2"',
      '!series_matrix_table_begin',
      '"ID_REF"\t"GSM_A1"\t"GSM_A2"\t"GSM_B1"\t"GSM_B2"',
      '!series_matrix_table_end',
    ].join('\n');

    const result = analyzeGeoDatasetFromText({
      accession: 'GSE_SETUP',
      rawCountsText: RAW_COUNTS_TEXT,
      seriesMatrixText: seriesWithBatch,
      design: {
        conditionA: 'Healthy',
        conditionB: 'Lesional',
        groupFactorName: 'Manual grouping',
        groupBySample: {
          GSM_A1: 'A',
          GSM_A2: 'A',
          GSM_B1: 'B',
          GSM_B2: 'B',
        },
        batchFactorName: 'Manual batch',
        batchBySample: {
          GSM_A1: 'Run_1',
          GSM_A2: 'Run_2',
          GSM_B1: 'Run_1',
          GSM_B2: 'Run_2',
        },
      },
    });

    expect(result.viewerData?.project.conditionA).toBe('Healthy');
    expect(result.viewerData?.project.conditionB).toBe('Lesional');
    expect(result.viewerData?.samplesById?.sample_GSM_A1?.groupKey).toBe('A');
    expect(result.viewerData?.samplesById?.sample_GSM_A1?.groupLabel).toBe('Healthy');
    expect(result.viewerData?.samplesById?.sample_GSM_B2?.batch).toBe('Run_2');
    expect(
      result.issues.some((issue) => issue.message.includes('Batch-aware linear model was applied')),
    ).toBe(true);
  });

  it('throws when series metadata cannot infer a binary comparison', () => {
    const noGroupsSeries = [
      '!Sample_geo_accession\t"GSM_A1"\t"GSM_A2"\t"GSM_B1"\t"GSM_B2"',
      '!Sample_title\t"sample1"\t"sample2"\t"sample3"\t"sample4"',
      '!series_matrix_table_begin',
      '"ID_REF"\t"GSM_A1"\t"GSM_A2"\t"GSM_B1"\t"GSM_B2"',
      '!series_matrix_table_end',
    ].join('\n');

    expect(() =>
      analyzeGeoDatasetFromText({
        accession: 'GSE_FAIL',
        rawCountsText: RAW_COUNTS_TEXT,
        seriesMatrixText: noGroupsSeries,
      }),
    ).toThrow(/Could not infer a binary comparison/);
  });

  it('stops analysis with a clear memory guidance for oversized sample counts', () => {
    const sampleIds = Array.from({ length: 1501 }, (_, index) => `GSM_${index + 1}`);
    const groups = sampleIds.map((_, index) => (index < 750 ? 'control' : 'treated'));
    const series = [
      `!Sample_geo_accession\t${sampleIds.map((id) => `"${id}"`).join('\t')}`,
      `!Sample_characteristics_ch1\t${groups.map((group) => `"group: ${group}"`).join('\t')}`,
      '!series_matrix_table_begin',
      `"ID_REF"\t${sampleIds.map((id) => `"${id}"`).join('\t')}`,
      '!series_matrix_table_end',
    ].join('\n');

    const counts = [
      `GeneID\t${sampleIds.join('\t')}`,
      `7157\t${sampleIds.map(() => '10').join('\t')}`,
    ].join('\n');

    expect(() =>
      analyzeGeoDatasetFromText({
        accession: 'GSE_BIG',
        rawCountsText: counts,
        seriesMatrixText: series,
      }),
    ).toThrow(/Analysis stopped due to browser memory limits/);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('searchGeoDatasets', () => {
  it('returns raw and excluded GEO hits instead of collapsing them into an empty result', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        return new Response(
          JSON.stringify({
            esearchresult: {
              idlist: ['1', '2'],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/esummary.fcgi')) {
        return new Response(
          JSON.stringify({
            result: {
              uids: ['1', '2'],
              '1': {
                uid: '1',
                accession: 'GSE100',
                title: 'Human study without counts',
                summary: 'human summary',
                taxon: 'Homo sapiens',
                n_samples: 12,
                ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE100nnn/GSE100',
              },
              '2': {
                uid: '2',
                accession: 'GSE200',
                title: 'Mouse study with counts',
                summary: 'mouse summary',
                taxon: 'Mus musculus',
                n_samples: 8,
                ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE200nnn/GSE200',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('acc=GSE100') && url.includes('format=text')) {
        return new Response('<a href="/geo/series/GSE100nnn/GSE100/matrix/GSE100_series_matrix.txt.gz">matrix</a>', {
          status: 200,
        });
      }
      if (url.includes('acc=GSE200') && url.includes('format=text')) {
        return new Response(
          [
            '<a href="/geo/download/?type=rnaseq_counts&acc=GSE200&format=file&file=GSE200_counts.tsv.gz">counts</a>',
            '<a href="/geo/series/GSE200nnn/GSE200/matrix/GSE200_series_matrix.txt.gz">matrix</a>',
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await searchGeoDatasets('cancer', 8);
    expect(result.rawHitCount).toBe(2);
    expect(result.eligibleCount).toBe(0);
    expect(result.excludedCount).toBe(2);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].eligibilityReason).toBeTruthy();
    expect(result.results.some((entry) => entry.eligibilityReason?.includes('non-human'))).toBe(true);
    expect(
      result.results.some((entry) => entry.eligibilityReason?.includes('raw counts unavailable')),
    ).toBe(true);
  });
});

describe('parseGeoDownloadLinksFromHtml', () => {
  it('uses ERAPID-style filename heuristics to classify rnaseq links', () => {
    const html = `
      <a href="/geo/download/?type=rnaseq_counts&amp;acc=GSE123456&amp;format=file&amp;file=GSE123456_counts_GRCh38.p13_NCBI.tsv.gz">counts</a>
      <a href="/geo/download/?type=rnaseq_counts&amp;acc=GSE123456&amp;format=file&amp;file=GSE123456_norm_counts_TPM_GRCh38.p13_NCBI.tsv.gz">tpm</a>
      <a href="/geo/download/?type=rnaseq_counts&amp;acc=GSE123456&amp;format=file&amp;file=GSE123456_norm_counts_FPKM_GRCh38.p13_NCBI.tsv.gz">fpkm</a>
      <a href="/geo/download/?type=rnaseq_counts&amp;format=file&amp;file=Human.GRCh38.p13.annot.tsv.gz">annot</a>
      <a href="ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE123nnn/GSE123456/matrix/GSE123456_series_matrix.txt.gz">matrix</a>
    `;

    const parsed = parseGeoDownloadLinksFromHtml(html);
    expect(parsed.hasNcbiGeneratedRawCounts).toBe(true);
    expect(parsed.rawCountsUrl).toContain('GSE123456_counts_GRCh38.p13_NCBI.tsv.gz');
    expect(parsed.tpmUrl).toContain('norm_counts_TPM');
    expect(parsed.fpkmUrl).toContain('norm_counts_FPKM');
    expect(parsed.annotationUrl).toContain('Human.GRCh38.p13.annot.tsv.gz');
    expect(parsed.seriesMatrixUrl).toContain('/geo/series/GSE123nnn/GSE123456/matrix/');
  });

  it('parses unquoted href attributes and survives malformed file encoding', () => {
    const html = `
      <a href=/geo/download/?type=rnaseq_counts&format=file&file=GSE777_counts.tsv.gz>counts</a>
      <a href="/geo/download/?type=rnaseq_counts&format=file&file=GSE777_counts_%E0%A4%A.tsv.gz">broken-encoding</a>
      <a href=/geo/series/GSE777nnn/GSE777/matrix/GSE777_series_matrix.txt.gz>matrix</a>
    `;

    const parsed = parseGeoDownloadLinksFromHtml(html);
    expect(parsed.hasNcbiGeneratedRawCounts).toBe(true);
    expect(parsed.rawCountsUrl).toContain('GSE777_counts.tsv.gz');
    expect(parsed.rawCountsFilename).toContain('GSE777_counts.tsv.gz');
    expect(parsed.seriesMatrixUrl).toContain('GSE777_series_matrix.txt.gz');
  });
});
