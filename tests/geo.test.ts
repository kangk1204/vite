import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __getGeoSearchCacheSizesForTests,
  __resetGeoSearchCachesForTests,
  analyzeGeoDatasetFromText,
  loadGeoInputFromFiles,
  parseGeoDownloadLinksFromHtml,
  previewGeoSeriesDesignFromText,
  searchGeoDatasets,
  startGeoDatasetSearch,
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

  it('refuses browser inference for identical counts instead of fabricating significant pathways', async () => {
    const rawCountsText = ['gene_symbol\tGSM_A1\tGSM_A2\tGSM_B1\tGSM_B2',
      ...['A1BG-AS1', 'A2M-AS1', 'A2ML1', 'A2ML1-AS1', 'A2ML1-AS2', 'A3GALT2'].map((symbol) => `${symbol}\t100\t100\t100\t100`),
    ].join('\n');
    await expect(analyzeGeoDatasetFromText({ rawCountsText, seriesMatrixText: SERIES_MATRIX_TEXT }))
      .rejects.toThrow(/local R analysis/i);
  });

  it('does not create browser statistics for arbitrary inputs', async () => {
    await expect(analyzeGeoDatasetFromText({ rawCountsText: RAW_COUNTS_TEXT, seriesMatrixText: SERIES_MATRIX_TEXT }))
      .rejects.toThrow(/local R analysis/i);
  });

  it('allows explicit manual grouping when no binary metadata factor is available', () => {
    const preview = previewGeoSeriesDesignFromText('!Sample_geo_accession\t"S1"\t"S2"\t"S3"\t"S4"');
    expect(preview.defaultGroupFactorId).toBe('manual');
    expect(Object.values(preview.defaultGroupBySample)).toEqual(['', '', '', '']);
  });

  it('does not use an incidental binary assay flag or sex as the default biological contrast', () => {
    const series = [
      '!Sample_geo_accession\t"S1"\t"S2"\t"S3"\t"S4"',
      '!Sample_title\t"C_0002"\t"C_0003"\t"P_0004"\t"P_0005"',
      '!Sample_characteristics_ch1\t"proteomics study: yes"\t"proteomics study: no"\t"proteomics study: yes"\t"proteomics study: no"',
      '!Sample_characteristics_ch1\t"gender: male"\t"gender: female"\t"gender: male"\t"gender: female"',
    ].join('\n');
    const preview = previewGeoSeriesDesignFromText(series);
    expect(preview.defaultGroupFactorId).toBe('manual');
    expect(Object.values(preview.defaultGroupBySample)).toEqual(['', '', '', '']);
    expect(preview.factors.some((factor) => factor.id.includes('gender'))).toBe(true);
  });

  it('rejects oversized local input before reading it', async () => {
    const large = new File([], 'large.tsv');
    Object.defineProperty(large, 'size', { value: 129 * 1024 * 1024 });
    const matrix = new File([], 'matrix.txt');
    Object.defineProperty(matrix, 'arrayBuffer', { value: async () => new ArrayBuffer(0) });
    await expect(loadGeoInputFromFiles({ rawCountsFile: large, seriesMatrixFile: matrix })).rejects.toThrow(/memory limit/i);
  });

});

afterEach(() => {
  vi.restoreAllMocks();
  __resetGeoSearchCachesForTests();
});

describe('searchGeoDatasets', () => {
  it('returns raw and excluded GEO hits instead of collapsing them into an empty result', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        return new Response(
          JSON.stringify({
            esearchresult: {
              count: '2',
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
    expect(result.inspectedCount).toBe(2);
    expect(result.checkingCount).toBe(0);
    expect(result.eligibleCount).toBe(0);
    expect(result.excludedCount).toBe(2);
    expect(result.complete).toBe(true);
    expect(result.results).toHaveLength(2);
    expect(result.results[0].eligibilityReason).toBeTruthy();
    expect(result.results.some((entry) => entry.eligibilityReason?.includes('non-human'))).toBe(true);
    expect(
      result.results.some((entry) => entry.eligibilityReason?.includes('raw counts unavailable')),
    ).toBe(true);
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain('"Homo sapiens"[Organism]');
    expect(decodeURIComponent(String(fetchMock.mock.calls[0]?.[0]))).toContain(
      '"expression profiling by high throughput sequencing"[DataSet Type]',
    );
  });

  it('continues fetching additional GEO pages until eligible datasets are found', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        const retstart = Number(new URL(url).searchParams.get('retstart') ?? '0');
        if (retstart === 0) {
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '3',
                idlist: ['1', '2'],
              },
            }),
            { status: 200 },
          );
        }
        if (retstart === 2) {
          return new Response(
            JSON.stringify({
              esearchresult: {
                count: '3',
                idlist: ['3'],
              },
            }),
            { status: 200 },
          );
        }
      }
      if (url.includes('/esummary.fcgi')) {
        if (url.includes('id=1%2C2')) {
          return new Response(
            JSON.stringify({
              result: {
                uids: ['1', '2'],
                '1': {
                  uid: '1',
                  accession: 'GSE100',
                  title: 'Mouse study',
                  summary: 'mouse summary',
                  taxon: 'Mus musculus',
                  n_samples: 12,
                  ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE100nnn/GSE100',
                },
                '2': {
                  uid: '2',
                  accession: 'GSE200',
                  title: 'Human study without counts',
                  summary: 'human summary',
                  taxon: 'Homo sapiens',
                  n_samples: 8,
                  ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE200nnn/GSE200',
                },
              },
            }),
            { status: 200 },
          );
        }
        if (url.includes('id=3')) {
          return new Response(
            JSON.stringify({
              result: {
                uids: ['3'],
                '3': {
                  uid: '3',
                  accession: 'GSE300',
                  title: 'Human study with counts',
                  summary: 'human summary',
                  taxon: 'Homo sapiens',
                  n_samples: 16,
                  ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE300nnn/GSE300',
                },
              },
            }),
            { status: 200 },
          );
        }
      }
      if (url.includes('acc=GSE200') && url.includes('format=text')) {
        return new Response('<a href="/geo/series/GSE200nnn/GSE200/matrix/GSE200_series_matrix.txt.gz">matrix</a>', {
          status: 200,
        });
      }
      if (url.includes('acc=GSE300') && url.includes('format=text')) {
        return new Response(
          [
            '<a href="/geo/download/?type=rnaseq_counts&acc=GSE300&format=file&file=GSE300_counts.tsv.gz">counts</a>',
            '<a href="/geo/series/GSE300nnn/GSE300/matrix/GSE300_series_matrix.txt.gz">matrix</a>',
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await searchGeoDatasets('cancer', 1);
    expect(result.rawHitCount).toBe(3);
    expect(result.inspectedCount).toBe(3);
    expect(result.checkingCount).toBe(0);
    expect(result.eligibleCount).toBe(1);
    expect(result.excludedCount).toBe(2);
    expect(result.complete).toBe(true);
    expect(result.results[0]?.accession).toBe('GSE300');
    expect(fetchMock.mock.calls.filter(([url]) => String(url).includes('/esearch.fcgi')).length).toBe(2);
  });

  it('returns initial candidate cards immediately and hydrates eligibility in the background', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        return new Response(
          JSON.stringify({
            esearchresult: {
              count: '1',
              idlist: ['1'],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/esummary.fcgi')) {
        return new Response(
          JSON.stringify({
            result: {
              uids: ['1'],
              '1': {
                uid: '1',
                accession: 'GSE500',
                title: 'Human study with pending counts check',
                summary: 'human summary',
                taxon: 'Homo sapiens',
                n_samples: 14,
                ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE500nnn/GSE500',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('acc=GSE500') && url.includes('format=text')) {
        return new Response(
          [
            '<a href="/geo/download/?type=rnaseq_counts&acc=GSE500&format=file&file=GSE500_counts.tsv.gz">counts</a>',
            '<a href="/geo/series/GSE500nnn/GSE500/matrix/GSE500_series_matrix.txt.gz">matrix</a>',
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const session = await startGeoDatasetSearch('cancer', 1, { initialPageSize: 1 });
    expect(session.initialResponse.rawHitCount).toBe(1);
    expect(session.initialResponse.inspectedCount).toBe(0);
    expect(session.initialResponse.checkingCount).toBe(1);
    expect(session.initialResponse.complete).toBe(false);
    expect(session.initialResponse.results[0]?.eligibilityStatus).toBe('checking');

    const final = await session.completion;
    expect(final.complete).toBe(true);
    expect(final.eligibleCount).toBe(1);
    expect(final.results[0]?.eligibilityStatus).toBe('eligible');
  });

  it('excludes datasets that have raw counts but no downloadable series matrix metadata', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        return new Response(
          JSON.stringify({
            esearchresult: {
              count: '1',
              idlist: ['1'],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/esummary.fcgi')) {
        return new Response(
          JSON.stringify({
            result: {
              uids: ['1'],
              '1': {
                uid: '1',
                accession: 'GSE291830',
                title: 'Supplement-only cohort without matrix',
                summary: 'human cancer study',
                taxon: 'Homo sapiens',
                n_samples: 9,
                ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE291nnn/GSE291830/',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('acc=GSE291830') && url.includes('format=text')) {
        return new Response(
          '<a href="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE291nnn/GSE291830/suppl/GSE291830_CTCsmartseq3.UMIcounts.txt.gz">suppl counts</a>',
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const session = await startGeoDatasetSearch('cancer', 1, { initialPageSize: 1 });
    const final = await session.completion;

    expect(final.results).toHaveLength(1);
    expect(final.results[0]?.eligibilityStatus).toBe('excluded');
    expect(final.results[0]?.eligibilityReason).toContain('series matrix metadata unavailable');
    expect(final.eligibleCount).toBe(0);
    expect(final.excludedCount).toBe(1);
  });

  it('aborts stale background eligibility checks when the caller cancels the search', async () => {
    const controller = new AbortController();
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              esearchresult: {
                count: '1',
                idlist: ['1'],
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes('/esummary.fcgi')) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              result: {
                uids: ['1'],
                '1': {
                  uid: '1',
                  accession: 'GSE777',
                  title: 'Cancelable human study',
                  summary: 'human summary',
                  taxon: 'Homo sapiens',
                  n_samples: 12,
                  ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE777nnn/GSE777',
                },
              },
            }),
            { status: 200 },
          ),
        );
      }
      if (url.includes('acc=GSE777') && url.includes('format=text')) {
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal;
          const abort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
          if (signal?.aborted) {
            abort();
            return;
          }
          signal?.addEventListener('abort', abort, { once: true });
        });
      }
      return Promise.reject(new Error(`Unexpected fetch: ${url}`));
    });

    vi.stubGlobal('fetch', fetchMock);

    const session = await startGeoDatasetSearch('abort me', 1, {
      initialPageSize: 1,
      signal: controller.signal,
    });
    expect(session.initialResponse.results[0]?.eligibilityStatus).toBe('checking');

    controller.abort();

    await expect(session.completion).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('reuses cached query results on repeated searches', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        return new Response(
          JSON.stringify({
            esearchresult: {
              count: '1',
              idlist: ['1'],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/esummary.fcgi')) {
        return new Response(
          JSON.stringify({
            result: {
              uids: ['1'],
              '1': {
                uid: '1',
                accession: 'GSE900',
                title: 'Cached human study',
                summary: 'human summary',
                taxon: 'Homo sapiens',
                n_samples: 10,
                ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE900nnn/GSE900',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('acc=GSE900') && url.includes('format=text')) {
        return new Response(
          [
            '<a href="/geo/download/?type=rnaseq_counts&acc=GSE900&format=file&file=GSE900_counts.tsv.gz">counts</a>',
            '<a href="/geo/series/GSE900nnn/GSE900/matrix/GSE900_series_matrix.txt.gz">matrix</a>',
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const first = await searchGeoDatasets('cache me', 1);
    const callsAfterFirstSearch = fetchMock.mock.calls.length;
    const second = await searchGeoDatasets('cache me', 1);

    expect(first.eligibleCount).toBe(1);
    expect(second.eligibleCount).toBe(1);
    expect(fetchMock.mock.calls).toHaveLength(callsAfterFirstSearch);
  });

  it('caps query cache size to prevent unbounded browser-memory growth', async () => {
    let queryCounter = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        queryCounter += 1;
        return new Response(
          JSON.stringify({
            esearchresult: {
              count: '1',
              idlist: [String(queryCounter)],
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/esummary.fcgi')) {
        const idParam = new URL(url).searchParams.get('id') ?? '1';
        const accession = `GSE${idParam.padStart(4, '0')}`;
        return new Response(
          JSON.stringify({
            result: {
              uids: [idParam],
              [idParam]: {
                uid: idParam,
                accession,
                title: `Cache pressure study ${idParam}`,
                summary: 'human summary',
                taxon: 'Homo sapiens',
                n_samples: 10,
                ftplink: `https://ftp.ncbi.nlm.nih.gov/geo/series/${accession}nnn/${accession}`,
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('format=text')) {
        const accession = /acc=(GSE\d+)/.exec(url)?.[1] ?? 'GSE0001';
        return new Response(
          [
            `<a href="/geo/download/?type=rnaseq_counts&acc=${accession}&format=file&file=${accession}_counts.tsv.gz">counts</a>`,
            `<a href="/geo/series/${accession}nnn/${accession}/matrix/${accession}_series_matrix.txt.gz">matrix</a>`,
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    for (let index = 0; index < 48; index += 1) {
      await searchGeoDatasets(`cache pressure ${index}`, 1);
    }

    const cacheSizes = __getGeoSearchCacheSizesForTests();
    expect(cacheSizes.queryEntries).toBeLessThanOrEqual(32);
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

  it('detects supplemental raw counts FTP links without rnaseq_counts parameters', () => {
    const html = `
      <a href="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE324nnn/GSE324662/suppl/GSE324662_raw_counts_All_Samples.txt.gz">supplementary counts</a>
      <a href="/geo/series/GSE324nnn/GSE324662/matrix/GSE324662_series_matrix.txt.gz">matrix</a>
    `;

    const parsed = parseGeoDownloadLinksFromHtml(html);
    expect(parsed.hasNcbiGeneratedRawCounts).toBe(true);
    expect(parsed.rawCountsUrl).toContain('GSE324662_raw_counts_All_Samples.txt.gz');
    expect(parsed.rawCountsFilename).toBe('GSE324662_raw_counts_All_Samples.txt.gz');
    expect(parsed.seriesMatrixUrl).toContain('/geo/series/GSE324nnn/GSE324662/matrix/');
  });
});
