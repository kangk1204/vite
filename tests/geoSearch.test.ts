import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __resetGeoSearchCachesForTests,
  parseGeoDownloadLinksFromHtml,
  getGeoSearchCacheStats,
  searchGeoDatasets,
  startGeoDatasetSearch,
} from '../src/lib/geoSearch';
import type { GeoSearchResponse } from '../src/lib/geoSearch';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  __resetGeoSearchCachesForTests();
});

describe('geoSearch direct accession fast path', () => {
  it('serves direct GSE queries from accession cache without new network calls', async () => {
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
                title: 'Cached human cohort',
                summary: 'human summary',
                taxon: 'Homo sapiens',
                n_samples: 12,
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

    const warmup = await searchGeoDatasets('cache warmup', 1);
    expect(warmup.eligibleCount).toBe(1);
    const callsBeforeDirectLookup = fetchMock.mock.calls.length;

    const directLookup = await startGeoDatasetSearch('GSE900', 1);
    const directResult = await directLookup.completion;

    expect(directResult.results).toHaveLength(1);
    expect(directResult.results[0]?.accession).toBe('GSE900');
    expect(directResult.complete).toBe(true);
    expect(fetchMock.mock.calls).toHaveLength(callsBeforeDirectLookup);
  });
});

describe('parseGeoDownloadLinksFromHtml', () => {
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

describe('startGeoDatasetSearch', () => {
  it('releases a throttled request slot when a queued search is cancelled', async () => {
    vi.stubEnv('MODE', 'production');
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const url = String(input);
      if (url.includes('/esearch.fcgi')) return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['1'] } }));
      return new Response(JSON.stringify({ result: { uids: ['1'], '1': { accession: 'GSE1', title: 'Mouse cohort', taxon: 'Mus musculus', n_samples: 4 } } }));
    }));
    const first = searchGeoDatasets('first query', 1);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const controller = new AbortController();
    const cancelled = searchGeoDatasets('cancelled query', 1, { signal: controller.signal }).catch((error: unknown) => error);
    controller.abort();
    await first;
    expect(await cancelled).toMatchObject({ name: 'AbortError' });
    const third = await searchGeoDatasets('third query', 1);
    expect(third.results[0].accession).toBe('GSE1');
  }, 5000);

  it('keeps a real-shaped GEO hit visible when link checks fail and retries without negative caching', async () => {
    let failAvailability = true;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['200068719'] } }));
      if (url.includes('/esummary.fcgi')) return new Response(JSON.stringify({ result: { uids: ['200068719'], '200068719': {
        accession: 'GSE68719', title: 'mRNA-Seq expression and MS3 proteomics profiling of human post-mortem BA9 brain tissue',
        summary: 'Parkinson disease and neurologically normal individuals.', taxon: 'Homo sapiens', n_samples: 73,
        ftplink: 'ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE68nnn/GSE68719', pubmedids: ['26793951'],
      } } }));
      if (failAvailability) throw new TypeError('Failed to fetch');
      return new Response('<a href="https://www.ncbi.nlm.nih.gov/geo/download/?type=rnaseq_counts&acc=GSE68719&format=file&file=GSE68719_counts.tsv.gz">counts</a><a href="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE68nnn/GSE68719/matrix/GSE68719_series_matrix.txt.gz">matrix</a>');
    });
    vi.stubGlobal('fetch', fetchMock);
    const failed = await searchGeoDatasets('GSE68719', 1);
    expect(failed.results).toHaveLength(1);
    expect(failed.results[0].accession).toBe('GSE68719');
    expect(failed.results[0].sampleCount).toBe(73);
    expect(failed.results[0].isEligible).toBe(false);
    expect(failed.results[0].availabilityCheckFailed).toBe(true);
    expect(failed.results[0].eligibilityReason).toMatch(/check failed/i);
    expect(failed.results[0].eligibilityReason).not.toMatch(/metadata unavailable/);
    expect(getGeoSearchCacheStats().queryEntries).toBe(0);
    expect(getGeoSearchCacheStats().accessionEntries).toBe(0);
    const callsBeforeRetry = fetchMock.mock.calls.length;
    failAvailability = false;
    const retried = await searchGeoDatasets('GSE68719', 1);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBeforeRetry);
    expect(retried.eligibleCount).toBe(1);
    expect(retried.results[0].availabilityCheckFailed).not.toBe(true);
  }, 15000);

  it('uses actual SOFT-listed raw counts and an accessible matrix when the download page is blocked', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['123'] } }));
      if (url.includes('/esummary.fcgi')) return new Response(JSON.stringify({ result: { uids: ['123'], '123': {
        accession: 'GSE12345', title: 'Public human cohort', taxon: 'Homo sapiens', n_samples: 12,
      } } }));
      if (url.includes('/geo/download/')) throw new TypeError('Failed to fetch');
      if (url.includes('form=text')) return new Response('^SERIES = GSE12345\n!Series_supplementary_file = ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/suppl/GSE12345_raw_counts.tsv.gz');
      if (init?.method === 'HEAD' && url.includes('ftp.ncbi.nlm.nih.gov')) return new Response(null, { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchGeoDatasets('GSE12345', 1);
    expect(result.eligibleCount).toBe(1);
    expect(result.results[0].rawCountsUrl).toBe('https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/suppl/GSE12345_raw_counts.tsv.gz');
    expect(result.results[0].seriesMatrixUrl).toBe('https://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/matrix/GSE12345_series_matrix.txt.gz');
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'HEAD')).toHaveLength(2);
  }, 15000);

  it('does not promote normalized count files from a SOFT fallback to raw counts', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['123'] } }));
      if (url.includes('/esummary.fcgi')) return new Response(JSON.stringify({ result: { uids: ['123'], '123': {
        accession: 'GSE12345', title: 'Public human cohort', taxon: 'Homo sapiens', n_samples: 12,
      } } }));
      if (url.includes('form=text')) return new Response('^SERIES = GSE12345\n!Series_supplementary_file = ftp://ftp.ncbi.nlm.nih.gov/geo/series/GSE12nnn/GSE12345/suppl/GSE12345_DESeq2_norm_counts.txt.gz');
      throw new TypeError('Failed to fetch');
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchGeoDatasets('GSE12345', 1);
    expect(result.eligibleCount).toBe(0);
    expect(result.results[0].availabilityCheckFailed).toBe(true);
    expect(result.results[0].rawCountsUrl).toBeUndefined();
  }, 15000);

  it('discovers the actual NCBI FTP raw-count filename instead of guessing a reference build', async () => {
    const rawUrl = 'https://ftp.ncbi.nlm.nih.gov/geo/rnaseq_counts/GSE68nnn/GSE68719_raw_counts_GRCh38.p13_NCBI.tsv.gz';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) return new Response(JSON.stringify({ esearchresult: { count: '1', idlist: ['200068719'] } }));
      if (url.includes('/esummary.fcgi')) return new Response(JSON.stringify({ result: { uids: ['200068719'], '200068719': {
        accession: 'GSE68719', title: 'Human BA9 RNA-seq', taxon: 'Homo sapiens', n_samples: 73,
      } } }));
      if (url.includes('/geo/download/')) throw new TypeError('Failed to fetch');
      if (url.endsWith('/rnaseq_counts/GSE68nnn/')) return new Response([
        '<a href="GSE68718_raw_counts_GRCh38.p14_NCBI.tsv.gz">different study</a>',
        '<a href="GSE68719_norm_counts_TPM_GRCh38.p13_NCBI.tsv.gz">normalized counts</a>',
        '<a href="GSE68719_raw_counts_GRCh38.p13_NCBI.tsv.gz">raw counts</a>',
      ].join('\n'));
      if (init?.method === 'HEAD' && (url === rawUrl || url.endsWith('/GSE68719_series_matrix.txt.gz'))) return new Response(null, { status: 200 });
      throw new Error(`Unexpected request ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const result = await searchGeoDatasets('GSE68719', 1);
    expect(result.eligibleCount).toBe(1);
    expect(result.results[0].rawCountsUrl).toBe(rawUrl);
    expect(result.results[0].rawCountsFilename).toBe('GSE68719_raw_counts_GRCh38.p13_NCBI.tsv.gz');
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('GSE68718_raw_counts'))).toBe(false);
  }, 15000);

  it('hydrates supplement-only raw counts links to eligible', async () => {
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
                accession: 'GSE324662',
                title: 'RNA-seq cancer cohort',
                summary: 'human cancer study',
                taxon: 'Homo sapiens',
                n_samples: 9,
                ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE324nnn/GSE324662/',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('acc=GSE324662') && url.includes('format=text')) {
        return new Response(
          [
            '<a href="https://ftp.ncbi.nlm.nih.gov/geo/series/GSE324nnn/GSE324662/suppl/GSE324662_raw_counts_All_Samples.txt.gz">suppl counts</a>',
            '<a href="/geo/series/GSE324nnn/GSE324662/matrix/GSE324662_series_matrix.txt.gz">matrix</a>',
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    vi.stubGlobal('fetch', fetchMock);

    const result = await startGeoDatasetSearch('cancer', 1, { initialPageSize: 1 });
    const final = await result.completion;
    expect(final.results).toHaveLength(1);
    expect(final.results[0]?.eligibilityStatus).toBe('eligible');
    expect(final.eligibleCount).toBe(1);
    expect(final.excludedCount).toBe(0);
    expect(final.results[0]?.rawCountsFilename).toBe('GSE324662_raw_counts_All_Samples.txt.gz');
  });

  it('excludes datasets that expose raw counts but no series matrix metadata', async () => {
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
});

describe('geoSearch cache stats', () => {
  it('tracks query and accession cache hits/misses for debugging and tuning', async () => {
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
                accession: 'GSE777',
                title: 'Cached cohort',
                summary: 'human summary',
                taxon: 'Homo sapiens',
                n_samples: 12,
                ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE777nnn/GSE777',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('acc=GSE777') && url.includes('format=text')) {
        return new Response(
          [
            '<a href="/geo/download/?type=rnaseq_counts&acc=GSE777&format=file&file=GSE777_counts.tsv.gz">counts</a>',
            '<a href="/geo/series/GSE777nnn/GSE777/matrix/GSE777_series_matrix.txt.gz">matrix</a>',
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const initial = getGeoSearchCacheStats();
    expect(initial.queryCacheHits + initial.queryCacheMisses).toBe(0);

    await searchGeoDatasets('cache stats', 1);
    const afterFirst = getGeoSearchCacheStats();
    expect(afterFirst.queryCacheMisses).toBeGreaterThan(0);

    await searchGeoDatasets('cache stats', 1);
    const afterSecond = getGeoSearchCacheStats();
    expect(afterSecond.queryCacheHits).toBeGreaterThan(afterFirst.queryCacheHits);
    expect(afterSecond.queryCacheMisses).toBe(afterFirst.queryCacheMisses);
  });
});

describe('geoSearch in-flight hydration dedupe', () => {
  it('hydrates duplicated accession only once across concurrent searches', async () => {
    let downloadFetchCount = 0;
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
                accession: 'GSE777',
                title: 'Shared cohort',
                summary: 'human summary',
                taxon: 'Homo sapiens',
                n_samples: 14,
                ftplink: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE777nnn/GSE777',
              },
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('acc=GSE777') && url.includes('format=text')) {
        downloadFetchCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return new Response(
          [
            '<a href="/geo/download/?type=rnaseq_counts&acc=GSE777&format=file&file=GSE777_counts.tsv.gz">counts</a>',
            '<a href="/geo/series/GSE777nnn/GSE777/matrix/GSE777_series_matrix.txt.gz">matrix</a>',
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const [left, right] = await Promise.all([
      searchGeoDatasets('alpha', 1),
      searchGeoDatasets('beta', 1),
    ]);

    expect(left.eligibleCount).toBe(1);
    expect(right.eligibleCount).toBe(1);
    expect(downloadFetchCount).toBe(1);
  });
});

describe('geoSearch progress snapshot isolation', () => {
  it('emits independent result array snapshots during hydration progress', async () => {
    const ids = Array.from({ length: 7 }, (_value, index) => String(index + 1));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        return new Response(
          JSON.stringify({
            esearchresult: {
              count: String(ids.length),
              idlist: ids,
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/esummary.fcgi')) {
        const resultEntries: Record<string, unknown> = { uids: ids };
        ids.forEach((id) => {
          resultEntries[id] = {
            uid: id,
            accession: `GSE90${id}`,
            title: `Hydration cohort ${id}`,
            summary: 'human summary',
            taxon: 'Homo sapiens',
            n_samples: 12 + Number(id),
            ftplink: `https://ftp.ncbi.nlm.nih.gov/geo/series/GSE90nnn/GSE90${id}`,
          };
        });
        return new Response(JSON.stringify({ result: resultEntries }), { status: 200 });
      }
      if (url.includes('format=text') && url.includes('acc=GSE90')) {
        const accessionMatch = url.match(/acc=(GSE90\d)/i);
        const accession = accessionMatch?.[1] ?? 'GSE900';
        return new Response(
          [
            `<a href="/geo/download/?type=rnaseq_counts&acc=${accession}&format=file&file=${accession}_counts.tsv.gz">counts</a>`,
            `<a href="/geo/series/GSE90nnn/${accession}/matrix/${accession}_series_matrix.txt.gz">matrix</a>`,
          ].join('\n'),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const progressSnapshots: GeoSearchResponse[] = [];
    const session = await startGeoDatasetSearch('psoriasis', 7, {
      onProgress: (response) => {
        progressSnapshots.push(response);
      },
    });
    await session.completion;

    expect(progressSnapshots.length).toBeGreaterThanOrEqual(2);
    for (let index = 1; index < progressSnapshots.length; index += 1) {
      expect(progressSnapshots[index - 1]?.results).not.toBe(progressSnapshots[index]?.results);
    }
    for (const snapshot of progressSnapshots) {
      const uniqueAccessions = new Set(snapshot.results.map((item) => item.accession));
      expect(uniqueAccessions.size).toBe(snapshot.results.length);
    }
  });
});

describe('geoSearch query cache memory guard', () => {
  it('skips query-response caching for very large result sets to protect browser memory', async () => {
    const ids = Array.from({ length: 360 }, (_value, index) => String(index + 1));
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/esearch.fcgi')) {
        return new Response(
          JSON.stringify({
            esearchresult: {
              count: String(ids.length),
              idlist: ids,
            },
          }),
          { status: 200 },
        );
      }
      if (url.includes('/esummary.fcgi')) {
        const resultEntries: Record<string, unknown> = { uids: ids };
        ids.forEach((id) => {
          resultEntries[id] = {
            uid: id,
            accession: `GSE8${id.padStart(5, '0')}`,
            title: `Large cached cohort ${id}`,
            summary: 'non-human cohort to skip hydration',
            taxon: 'Mus musculus',
            n_samples: 8,
            ftplink: `https://ftp.ncbi.nlm.nih.gov/geo/series/GSE8nnn/GSE8${id.padStart(5, '0')}`,
          };
        });
        return new Response(JSON.stringify({ result: resultEntries }), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await startGeoDatasetSearch('cache-guard-query', 0, { initialPageSize: ids.length });
    const firstResult = await first.completion;
    expect(firstResult.results.length).toBe(ids.length);
    const callsAfterFirst = fetchMock.mock.calls.length;

    const second = await startGeoDatasetSearch('cache-guard-query', 0, { initialPageSize: ids.length });
    const secondResult = await second.completion;
    expect(secondResult.results.length).toBe(ids.length);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});
