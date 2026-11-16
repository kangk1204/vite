import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import * as geoModule from '../src/lib/geo';
import * as geoSearchModule from '../src/lib/geoSearch';

vi.mock('../src/lib/geoSearch', () => {
  const emptyResponse = {
    results: [],
    rawHitCount: 0,
    inspectedCount: 0,
    checkingCount: 0,
    eligibleCount: 0,
    excludedCount: 0,
    complete: true,
  };
  return {
    startGeoDatasetSearch: vi.fn(async () => ({
      initialResponse: emptyResponse,
      completion: Promise.resolve(emptyResponse),
    })),
    getGeoSearchCacheStats: vi.fn(() => ({
      queryCacheHits: 0,
      queryCacheMisses: 0,
      accessionCacheHits: 0,
      accessionCacheMisses: 0,
      queryEntries: 0,
      accessionEntries: 0,
    })),
  };
});

vi.mock('../src/lib/geo', () => ({
  previewGeoSeriesDesignFromNcbi: vi.fn(async () => ({
    sampleIds: ['GSM_A1', 'GSM_A2', 'GSM_B1', 'GSM_B2'],
    sampleTitles: {
      GSM_A1: 'control rep1',
      GSM_A2: 'control rep2',
      GSM_B1: 'treated rep1',
      GSM_B2: 'treated rep2',
    },
    factors: [
      {
        id: 'group',
        label: 'group',
        uniqueValues: ['control', 'treated'],
        valuesBySample: {
          GSM_A1: 'control',
          GSM_A2: 'control',
          GSM_B1: 'treated',
          GSM_B2: 'treated',
        },
        orderedBinaryValues: ['control', 'treated'],
      },
    ],
    defaultGroupFactorId: 'group',
    defaultConditionA: 'control',
    defaultConditionB: 'treated',
    defaultGroupBySample: {
      GSM_A1: 'A',
      GSM_A2: 'A',
      GSM_B1: 'B',
      GSM_B2: 'B',
    },
  })),
  previewGeoSeriesDesignFromFile: vi.fn(async () => ({
    sampleIds: ['GSM_A1', 'GSM_A2'],
    sampleTitles: {
      GSM_A1: 'sample 1',
      GSM_A2: 'sample 2',
    },
    factors: [],
    defaultGroupFactorId: '',
    defaultConditionA: 'A',
    defaultConditionB: 'B',
    defaultGroupBySample: {
      GSM_A1: 'A',
      GSM_A2: 'B',
    },
  })),
}));

describe('App GEO search interactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('uses the latest search input when triggering GEO search', async () => {
    render(<App />);
    const searchInput = screen.getByPlaceholderText(/search human geo studies/i);
    const searchButton = screen.getByRole('button', { name: /search geo/i });

    fireEvent.change(searchInput, { target: { value: 'psoriasis skin' } });
    fireEvent.click(searchButton);

    await waitFor(() => {
      expect(geoSearchModule.startGeoDatasetSearch).toHaveBeenCalledWith(
        'psoriasis skin',
        12,
        expect.any(Object),
      );
    });
  });

  it('shows validation error for empty GEO search input', async () => {
    render(<App />);
    const searchButton = screen.getByRole('button', { name: /search geo/i });
    fireEvent.click(searchButton);

    expect(
      await screen.findByText(/enter a keyword or gse accession first/i),
    ).toBeInTheDocument();
  });

  it('shows accession, title and retryable failure instead of claiming missing files', async () => {
    const response = {
      results: [{ accession: 'GSE68719', title: 'Human post-mortem BA9 Parkinson disease cohort',
        summary: 'Parkinson disease and neurologically normal individuals.', organism: 'Homo sapiens', sampleCount: 73,
        geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE68719', downloadUrl: 'https://www.ncbi.nlm.nih.gov/geo/download/?acc=GSE68719',
        hasNcbiGeneratedRawCounts: false, eligibilityStatus: 'excluded' as const, isEligible: false, availabilityCheckFailed: true,
        eligibilityReason: 'Availability check failed: browser/network access could not verify raw-count files. Retry the search, or open GEO and upload downloaded files with Private analysis.',
      }], rawHitCount: 1, inspectedCount: 1, checkingCount: 0, eligibleCount: 0, excludedCount: 1, complete: true,
    };
    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({ initialResponse: response, completion: Promise.resolve(response) });
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), { target: { value: 'GSE68719' } });
    fireEvent.click(screen.getByRole('button', { name: /search geo/i }));
    expect(await screen.findByText('GSE68719')).toBeInTheDocument();
    expect(screen.getByText('Human post-mortem BA9 Parkinson disease cohort')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Check unavailable' })).toBeDisabled();
    expect(screen.getByText(/does not establish that raw counts or metadata are absent/i)).toBeInTheDocument();
    expect(screen.queryByText(/series matrix metadata unavailable/i)).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open GEO' })).toHaveAttribute('href', response.results[0].geoUrl);
  });

  it('shows filter match hints and highlights in GEO cards', async () => {
    const seededResponse = {
      results: [
        {
          accession: 'GSE157951',
          title: 'Psoriasis lesional skin bulk RNA-seq',
          summary: 'Transcriptome profiling of psoriasis lesions and controls.',
          organism: 'Homo sapiens',
          sampleCount: 52,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
          hasNcbiGeneratedRawCounts: true,
          eligibilityStatus: 'eligible' as const,
          isEligible: true,
          eligibilityReason: undefined,
          seriesMatrixUrl: undefined,
          rawCountsUrl: undefined,
          pubmedId: '12345678',
        },
      ],
      rawHitCount: 1,
      inspectedCount: 1,
      checkingCount: 0,
      eligibleCount: 1,
      excludedCount: 0,
      complete: true,
    };
    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
      initialResponse: seededResponse,
      completion: Promise.resolve(seededResponse),
    });

    const { container } = render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
      target: { value: 'psoriasis' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search geo/i }));

    expect(await screen.findByText(/psoriasis lesional skin bulk rna-seq/i)).toBeInTheDocument();

    const filterInput = screen.getByPlaceholderText(/filter current geo results/i);
    fireEvent.change(filterInput, { target: { value: 'psoriasis lesion' } });

    expect(await screen.findByText(/matched in:/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(container.querySelectorAll('mark.geo-highlight').length).toBeGreaterThan(0);
    });
  });

  it('toggles GEO card density mode', async () => {
    const seededResponse = {
      results: [
        {
          accession: 'GSE157951',
          title: 'Psoriasis lesional skin bulk RNA-seq',
          summary: 'Transcriptome profiling of psoriasis lesions and controls.',
          organism: 'Homo sapiens',
          sampleCount: 52,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
          hasNcbiGeneratedRawCounts: true,
          eligibilityStatus: 'eligible' as const,
          isEligible: true,
          eligibilityReason: undefined,
          seriesMatrixUrl: undefined,
          rawCountsUrl: undefined,
          pubmedId: '12345678',
        },
      ],
      rawHitCount: 1,
      inspectedCount: 1,
      checkingCount: 0,
      eligibleCount: 1,
      excludedCount: 0,
      complete: true,
    };
    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
      initialResponse: seededResponse,
      completion: Promise.resolve(seededResponse),
    });

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
      target: { value: 'psoriasis' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search geo/i }));

    expect(await screen.findByText(/card density:/i)).toHaveTextContent(/comfortable/i);

    fireEvent.click(screen.getByRole('button', { name: /compact/i }));

    expect(screen.getByText(/card density:/i)).toHaveTextContent(/compact/i);
  });

  it('runs GEO setup from an eligible card click', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });
    try {
      const seededResponse = {
        results: [
          {
            accession: 'GSE157951',
            title: 'Psoriasis lesional skin bulk RNA-seq',
            summary: 'Transcriptome profiling of psoriasis lesions and controls.',
            organism: 'Homo sapiens',
            sampleCount: 52,
            geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
            downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
            hasNcbiGeneratedRawCounts: true,
            eligibilityStatus: 'eligible' as const,
            isEligible: true,
            eligibilityReason: undefined,
            seriesMatrixUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/matrix/GSE157951_series_matrix.txt.gz',
            rawCountsUrl: undefined,
            pubmedId: '12345678',
          },
        ],
        rawHitCount: 1,
        inspectedCount: 1,
        checkingCount: 0,
        eligibleCount: 1,
        excludedCount: 0,
        complete: true,
      };
      vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
        initialResponse: seededResponse,
        completion: Promise.resolve(seededResponse),
      });

      render(<App />);
      fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
        target: { value: 'psoriasis' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search geo/i }));

      expect(await screen.findByText(/psoriasis lesional skin bulk rna-seq/i)).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: /^select and setup$/i }));

      await waitFor(() => {
        expect(vi.mocked(geoModule.previewGeoSeriesDesignFromNcbi)).toHaveBeenCalledWith(
          expect.objectContaining({ accession: 'GSE157951' }),
        );
      });
      expect(await screen.findByText(/sample group and batch setup/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalled();
      });
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it('starts GEO setup while search is still hydrating', async () => {
    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    });

    const seededResponse = {
      results: [
        {
          accession: 'GSE157951',
          title: 'Psoriasis lesional skin bulk RNA-seq',
          summary: 'Transcriptome profiling of psoriasis lesions and controls.',
          organism: 'Homo sapiens',
          sampleCount: 52,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
          hasNcbiGeneratedRawCounts: true,
          eligibilityStatus: 'eligible' as const,
          isEligible: true,
          eligibilityReason: undefined,
          seriesMatrixUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/matrix/GSE157951_series_matrix.txt.gz',
          rawCountsUrl: undefined,
          pubmedId: '12345678',
        },
      ],
      rawHitCount: 1,
      inspectedCount: 1,
      checkingCount: 0,
      eligibleCount: 1,
      excludedCount: 0,
      complete: false,
    };

    let resolveCompletion: (response: typeof seededResponse) => void = () => {};
    const completion = new Promise<typeof seededResponse>((resolve) => {
      resolveCompletion = resolve;
    });

    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
      initialResponse: seededResponse,
      completion,
    });

    try {
      render(<App />);
      fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
        target: { value: 'psoriasis' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search geo/i }));

      expect(await screen.findByText(/psoriasis lesional skin bulk rna-seq/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /^select and setup$/i }));

      expect(await screen.findByText(/sample group and batch setup/i)).toBeInTheDocument();
      await waitFor(() => {
        expect(vi.mocked(geoModule.previewGeoSeriesDesignFromNcbi)).toHaveBeenCalledWith(
          expect.objectContaining({ accession: 'GSE157951' }),
        );
      });
      await waitFor(() => {
        expect(scrollIntoView).toHaveBeenCalled();
      });
      resolveCompletion(seededResponse);
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
        configurable: true,
        value: originalScrollIntoView,
      });
    }
  });

  it('expands GEO card height enough to keep action buttons visible', async () => {
    const seededResponse = {
      results: [
        {
          accession: 'GSE157951',
          title: 'Psoriasis lesional skin bulk RNA-seq with a long title for card layout regression coverage',
          summary:
            'Transcriptome profiling of psoriasis lesions and controls with enough descriptive text to exercise the GEO card action row layout.',
          organism: 'Homo sapiens',
          sampleCount: 52,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
          hasNcbiGeneratedRawCounts: true,
          eligibilityStatus: 'eligible' as const,
          isEligible: true,
          eligibilityReason: undefined,
          seriesMatrixUrl: undefined,
          rawCountsUrl: undefined,
          pubmedId: '12345678',
        },
      ],
      rawHitCount: 1,
      inspectedCount: 1,
      checkingCount: 0,
      eligibleCount: 1,
      excludedCount: 0,
      complete: true,
    };
    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
      initialResponse: seededResponse,
      completion: Promise.resolve(seededResponse),
    });

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
      target: { value: 'psoriasis' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search geo/i }));

    const title = await screen.findByText(/psoriasis lesional skin bulk rna-seq with a long title/i);
    const card = title.closest('article');
    expect(card).not.toBeNull();
    expect(card).toHaveStyle({ height: '224px' });

    fireEvent.change(screen.getByPlaceholderText(/filter current geo results/i), {
      target: { value: 'psoriasis' },
    });

    await waitFor(() => {
      expect(card).toHaveStyle({ height: '256px' });
    });

    fireEvent.click(screen.getByRole('button', { name: /^compact$/i }));

    await waitFor(() => {
      expect(card).toHaveStyle({ height: '216px' });
    });
  });

  it('supports keyboard selection in GEO result filter and opens selected card on Enter', async () => {
    const seededResponse = {
      results: [
        {
          accession: 'GSE157951',
          title: 'Psoriasis lesional skin bulk RNA-seq',
          summary: 'Transcriptome profiling of psoriasis lesions and controls.',
          organism: 'Homo sapiens',
          sampleCount: 52,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
          hasNcbiGeneratedRawCounts: true,
          eligibilityStatus: 'eligible' as const,
          isEligible: true,
        },
        {
          accession: 'GSE909090',
          title: 'Mouse liver RNA-seq',
          summary: 'Non-human dataset with sequencing replicates',
          organism: 'Mus musculus',
          sampleCount: 24,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE909090',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE909nnn/GSE909090/suppl/',
          hasNcbiGeneratedRawCounts: false,
          eligibilityStatus: 'excluded' as const,
          isEligible: false,
          eligibilityReason: 'Excluded by constraints',
        },
      ],
      rawHitCount: 2,
      inspectedCount: 2,
      checkingCount: 0,
      eligibleCount: 1,
      excludedCount: 1,
      complete: true,
    };
    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
      initialResponse: seededResponse,
      completion: Promise.resolve(seededResponse),
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
      target: { value: 'psoriasis' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search geo/i }));
    expect(await screen.findByText(/mouse liver rna-seq/i)).toBeInTheDocument();

    const filterInput = screen.getByPlaceholderText(/filter current geo results/i);
    filterInput.focus();
    fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
    fireEvent.keyDown(filterInput, { key: 'ArrowDown' });
    fireEvent.keyDown(filterInput, { key: 'Enter' });

    expect(openSpy).toHaveBeenCalledWith(
      'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE909090',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('supports End key to jump to the last GEO result before running Enter action', async () => {
    const seededResponse = {
      results: [
        {
          accession: 'GSE157951',
          title: 'Psoriasis lesional skin bulk RNA-seq',
          summary: 'Transcriptome profiling of psoriasis lesions and controls.',
          organism: 'Homo sapiens',
          sampleCount: 52,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
          hasNcbiGeneratedRawCounts: true,
          eligibilityStatus: 'eligible' as const,
          isEligible: true,
        },
        {
          accession: 'GSE909090',
          title: 'Mouse liver RNA-seq',
          summary: 'Non-human dataset with sequencing replicates',
          organism: 'Mus musculus',
          sampleCount: 24,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE909090',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE909nnn/GSE909090/suppl/',
          hasNcbiGeneratedRawCounts: false,
          eligibilityStatus: 'excluded' as const,
          isEligible: false,
          eligibilityReason: 'Excluded by constraints',
        },
      ],
      rawHitCount: 2,
      inspectedCount: 2,
      checkingCount: 0,
      eligibleCount: 1,
      excludedCount: 1,
      complete: true,
    };
    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
      initialResponse: seededResponse,
      completion: Promise.resolve(seededResponse),
    });
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
      target: { value: 'psoriasis' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search geo/i }));
    expect(await screen.findByText(/mouse liver rna-seq/i)).toBeInTheDocument();

    const filterInput = screen.getByPlaceholderText(/filter current geo results/i);
    filterInput.focus();
    fireEvent.keyDown(filterInput, { key: 'End' });
    fireEvent.keyDown(filterInput, { key: 'Enter' });

    expect(openSpy).toHaveBeenCalledWith(
      'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE909090',
      '_blank',
      'noopener,noreferrer',
    );
    openSpy.mockRestore();
  });

  it('focuses the GEO result filter input on slash shortcut', async () => {
    const seededResponse = {
      results: [
        {
          accession: 'GSE157951',
          title: 'Psoriasis lesional skin bulk RNA-seq',
          summary: 'Transcriptome profiling of psoriasis lesions and controls.',
          organism: 'Homo sapiens',
          sampleCount: 52,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
          hasNcbiGeneratedRawCounts: true,
          eligibilityStatus: 'eligible' as const,
          isEligible: true,
        },
      ],
      rawHitCount: 1,
      inspectedCount: 1,
      checkingCount: 0,
      eligibleCount: 1,
      excludedCount: 0,
      complete: true,
    };
    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
      initialResponse: seededResponse,
      completion: Promise.resolve(seededResponse),
    });

    render(<App />);
    fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
      target: { value: 'psoriasis' },
    });
    fireEvent.click(screen.getByRole('button', { name: /search geo/i }));
    expect(await screen.findByText(/psoriasis lesional skin bulk rna-seq/i)).toBeInTheDocument();

    const filterInput = screen.getByPlaceholderText(/filter current geo results/i);
    expect(document.activeElement).not.toBe(filterInput);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(document.activeElement).toBe(filterInput);
  });

  it('downloads filtered GEO rows as TSV for manuscript workflows', async () => {
    const seededResponse = {
      results: [
        {
          accession: 'GSE157951',
          title: 'Psoriasis lesional skin bulk RNA-seq',
          summary: 'Transcriptome profiling of psoriasis lesions and controls.',
          organism: 'Homo sapiens',
          sampleCount: 52,
          geoUrl: 'https://www.ncbi.nlm.nih.gov/geo/query/acc.cgi?acc=GSE157951',
          downloadUrl: 'https://ftp.ncbi.nlm.nih.gov/geo/series/GSE157nnn/GSE157951/suppl/',
          hasNcbiGeneratedRawCounts: true,
          eligibilityStatus: 'eligible' as const,
          isEligible: true,
          pubmedId: '12345678',
        },
      ],
      rawHitCount: 1,
      inspectedCount: 1,
      checkingCount: 0,
      eligibleCount: 1,
      excludedCount: 0,
      complete: true,
    };
    vi.mocked(geoSearchModule.startGeoDatasetSearch).mockResolvedValueOnce({
      initialResponse: seededResponse,
      completion: Promise.resolve(seededResponse),
    });

    const originalCreateObjectUrl = URL.createObjectURL;
    let capturedBlob: Blob | null = null;
    const createObjectUrlSpy = vi.fn((blob: Blob) => {
      capturedBlob = blob;
      return 'blob:test-export';
    });
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: createObjectUrlSpy,
    });
    try {
      render(<App />);
      fireEvent.change(screen.getByPlaceholderText(/search human geo studies/i), {
        target: { value: 'psoriasis' },
      });
      fireEvent.click(screen.getByRole('button', { name: /search geo/i }));
      expect(await screen.findByText(/psoriasis lesional skin bulk rna-seq/i)).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: /download filtered tsv/i }));
      expect(createObjectUrlSpy).toHaveBeenCalledTimes(1);
      expect(capturedBlob).toBeInstanceOf(Blob);
      if (!capturedBlob) {
        throw new Error('Expected Blob payload from createObjectURL');
      }
      const tsvContent = await (capturedBlob as unknown as { text: () => Promise<string> }).text();
      expect(tsvContent).toContain('accession\ttitle\torganism\tsample_count');
      expect(tsvContent).toContain('GSE157951\tPsoriasis lesional skin bulk RNA-seq\tHomo sapiens\t52');
    } finally {
      Object.defineProperty(URL, 'createObjectURL', {
        configurable: true,
        value: originalCreateObjectUrl,
      });
    }
  });
});
