import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../src/App';
import * as utils from '../src/lib/utils';

const fixture = vi.hoisted(() => ({
  rawCountsText: 'gene_symbol\tA1\tA2\tB1\tB2\nTP53\t100\t100\t100\t100',
  seriesMatrixText: '!Sample_geo_accession\t"A1"\t"A2"\t"B1"\t"B2"\n!Sample_characteristics_ch1\t"group: control"\t"group: control"\t"group: treated"\t"group: treated"',
}));
vi.mock('../src/lib/geo', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/lib/geo')>();
  return { ...original,
    previewGeoSeriesDesignFromFile: vi.fn(async () => original.previewGeoSeriesDesignFromText(fixture.seriesMatrixText)),
    loadGeoInputFromFiles: vi.fn(async (options) => ({ ...fixture, design: options.design })),
  };
});
vi.mock('../src/lib/utils', async (importOriginal) => ({ ...await importOriginal<typeof import('../src/lib/utils')>(), downloadBlob: vi.fn() }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('local analysis workflow', () => {
  it('prepares a local R input bundle without showing invented analysis results', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Private analysis' }));
    fireEvent.change(screen.getByLabelText('Raw counts file'), { target: { files: [new File(['counts'], 'counts.tsv')] } });
    fireEvent.change(screen.getByLabelText('Series matrix file'), { target: { files: [new File(['metadata'], 'matrix.txt')] } });
    fireEvent.click(screen.getByRole('button', { name: 'Prepare sample setup' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Prepare local analysis' }));
    await waitFor(() => expect(utils.downloadBlob).toHaveBeenCalledWith('user-data.local-analysis.json', expect.any(Blob)));
    expect(screen.getByText(/npm run analyze:local --/)).toBeInTheDocument();
    expect(screen.queryByText('Top pathways')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run pathway analysis' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Condition B label'), { target: { value: 'Updated treatment' } });
    expect(screen.getByText(/Sample setup changed after the download/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Raw counts file'), { target: { files: [new File(['other'], 'other.tsv')] } });
    expect(screen.queryByRole('button', { name: 'Prepare local analysis' })).not.toBeInTheDocument();
  });

  it('offers workbook and JSON result import with clear local execution instructions', () => {
    render(<App />);
    const input = screen.getByLabelText('Import analysis results');
    expect(input).toHaveAttribute('accept', '.xlsx,.xls,.json');
    expect(screen.getByText(/Statistical analysis runs locally in R/)).toBeInTheDocument();
  });

  it('reports invalid JSON without creating a result', async () => {
    render(<App />);
    const file = new File(['not JSON'], 'invalid.json');
    Object.defineProperty(file, 'text', { value: async () => 'not JSON' });
    fireEvent.change(screen.getByLabelText('Import analysis results'), { target: { files: [file] } });
    expect(await screen.findByText(/Failed to import results/)).toBeInTheDocument();
    expect(screen.queryByText('Top pathways')).not.toBeInTheDocument();
  });

  it('imports legacy JSON as an independent unverified result and offers report export', async () => {
    render(<App />);
    const content = JSON.stringify({
      project: { projectTitle: 'External report', contrastName: 'B_vs_A', conditionA: 'A', conditionB: 'B', species: 'human' },
      builtAt: '2026-11-10T00:00:00Z', significantPadjThreshold: 0.05,
      referenceSummary: { reactomePathways: 0, hallmarkPathways: 0, ppiGenes: 0, ppiEdges: 0, hallmarkMode: 'leading-edge-only', stringScoreCutoff: 700 },
      issues: [], pathways: [],
    });
    const file = new File([content], 'external.json');
    Object.defineProperty(file, 'text', { value: async () => content });
    fireEvent.change(screen.getByLabelText('Import analysis results'), { target: { files: [file] } });
    expect(await screen.findByText('Imported results: external.json')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download report.html' })).toBeEnabled();
    expect(screen.getByText(/Source verification: Not verified/)).toBeInTheDocument();
  });
});
