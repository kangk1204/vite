import { describe, expect, it } from 'vitest';
import { createReportHtml, prepareViewerDataForReport } from '../src/lib/reportHtml';
import type { ViewerData } from '../src/types';

function makeViewerData(projectTitle: string): ViewerData {
  return {
    project: {
      projectTitle,
      contrastName: 'Drug_vs_Control',
      conditionA: 'Control',
      conditionB: 'Drug',
      species: 'human',
    },
    builtAt: '2026-03-11T00:00:00.000Z',
    significantPadjThreshold: 0.25,
    referenceSummary: {
      reactomePathways: 0,
      hallmarkPathways: 0,
      ppiGenes: 0,
      ppiEdges: 0,
      hallmarkMode: 'stub',
      stringScoreCutoff: 700,
    },
    issues: [],
    pathways: [
      {
        key: 'Hallmark::HALLMARK_P53_PATHWAY',
        pathwayName: 'HALLMARK_P53_PATHWAY',
        collection: 'Hallmark',
        nes: 2.1,
        padj: 0.01,
        leadingEdgeGenes: ['TP53'],
        allGenes: ['TP53'],
        hasReferenceMembership: true,
        fallbackToLeadingEdge: false,
        missingGenes: [],
        nodes: [
          {
            id: 'TP53',
            label: 'TP53',
            labelPriority: 0,
            log2fc: -1.2,
            padj: 0.001,
            pvalue: 0.0001,
            sizeMetric: 3,
            conditionAMean: 5,
            conditionBMean: 3,
            sampleValues: {},
            isLeadingEdge: true,
          },
        ],
        edges: [],
        enrichment: {
          points: [{ index: 0, value: 0 }],
          hitIndices: [],
          maxAbsValue: 0,
        },
      },
    ],
    provenance: {
      datasetIdentifier: 'GSE121212',
      contrastDefinition: 'Psoriasis lesion versus healthy skin',
      sampleGroupSource: 'Parsed from GEO sample titles',
      batchHandlingRule: 'Not modeled',
      analysisTimestamp: '2026-03-11T00:00:00.000Z',
      gitCommit: 'abc1234',
      referenceAssetVersion: 'reactome-1.hallmark-0.string-700.huri-0.mode-stub',
      notes: 'Case-study test payload',
    },
  };
}

describe('createReportHtml', () => {
  it('marks legacy statistics unverified without inventing an analysis git commit', () => {
    const source = makeViewerData('Legacy');
    delete source.provenance;
    const prepared = prepareViewerDataForReport(source);
    expect(prepared.schemaVersion).toBe(2);
    expect(prepared.evidence?.verification.status).toBe('unverifiable');
    expect(prepared.provenance?.gitCommit).toBeUndefined();
    expect(prepared.provenance?.analysisTimestamp).toBeUndefined();
    expect(prepared.significantPadjThreshold).toBe(0.25);
    expect(prepared.evidence?.analysis.alpha).toBeNull();
  });

  it('distinguishes generation-time verification from offline viewing and preserves the actual legacy threshold', async () => {
    const html = await createReportHtml(makeViewerData('Legacy threshold'));
    expect(html.includes('Opening this report offline does not recheck original files')).toBe(true);
    expect(html.includes('Report significance threshold:')).toBe(true);
    expect(html.includes('Original analysis alpha:')).toBe(true);
    expect(html.includes('"significantPadjThreshold":0.25')).toBe(true);
  });

  it('preserves raw evidence and null statistics in the basic report condition', async () => {
    const source = makeViewerData('Null study');
    source.pathways[0].nes = null;
    source.pathways[0].padj = null;
    const html = await createReportHtml(source, { condition: 'basic' });
    expect(html.includes('"reportCondition":"basic"')).toBe(true);
    expect(html).toContain('"nes":null');
    expect(html).toContain('"padj":null');
  });

  it('stores shared expression once while retaining pathway-specific statistics', () => {
    const source = makeViewerData('Shared expression');
    source.pathways[0].nodes[0].sampleValues = { A1: 10, B1: 20 };
    source.pathways.push({ ...source.pathways[0], key: 'second', nodes: [{ ...source.pathways[0].nodes[0], isLeadingEdge: false }] });
    const prepared = prepareViewerDataForReport(source);
    expect(prepared.sampleValuesByGene?.TP53).toEqual({ A1: 10, B1: 20 });
    expect(prepared.pathways.every(pathway => Object.keys(pathway.nodes[0].sampleValues).length === 0)).toBe(true);
    expect(prepared.pathways[1].nodes[0].isLeadingEdge).toBe(false);
    expect(prepareViewerDataForReport(prepared)).toEqual(prepared);
    expect(source.pathways[0].nodes[0].sampleValues).toEqual({ A1: 10, B1: 20 });
  });
  it('escapes project title content in the HTML title tag', async () => {
    const projectTitle = '</title><script>alert(1)</script>&"\'';
    const html = await createReportHtml(makeViewerData(projectTitle));

    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
    expect(html).not.toContain('<title></title><script>alert(1)</script>');
  }, 12_000);

  it('adds normalized pathway search text for report-side matching', async () => {
    const prepared = prepareViewerDataForReport(makeViewerData('Search test'));

    expect(prepared.pathways[0]?.searchNameNormalized).toBe('hallmark p53 pathway');
    await expect(createReportHtml(makeViewerData('Search test'))).resolves.toContain(
      '"searchNameNormalized":"hallmark p53 pathway"',
    );
  });

  it('serializes provenance metadata into the report payload', async () => {
    const prepared = prepareViewerDataForReport(makeViewerData('Search test'));

    expect(prepared.provenance?.datasetIdentifier).toBe('GSE121212');
    expect(prepared.provenance?.gitCommit).toBe('abc1234');
    await expect(createReportHtml(makeViewerData('Search test'))).resolves.toContain(
      '"datasetIdentifier":"GSE121212"',
    );
    await expect(createReportHtml(makeViewerData('Search test'))).resolves.toContain('"gitCommit":"abc1234"');
  });

  it('embeds report runtime payloads as deferred script content', async () => {
    const html = await createReportHtml(makeViewerData('Deferred runtime test'));

    expect(html).toContain('id="pnv-cytoscape-source" type="text/plain"');
    expect(html).toContain('id="pnv-plotly-source" type="text/plain"');
    expect(html).toContain('id="pnv-jspdf-source" type="text/plain"');
    expect(html).toContain('id="pnv-svg2pdf-source" type="text/plain"');
    expect(html).toContain('__PNV_LOAD_REQUIRED_REPORT_RUNTIME__');
    expect(html).toContain('__PNV_ENSURE_PLOTLY_RUNTIME__');
    expect(html).toContain('__PNV_ENSURE_PDF_EXPORT_RUNTIME__');
  });
});
