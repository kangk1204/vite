import { describe, expect, it } from 'vitest';
import { createReportHtml } from '../src/lib/reportHtml';
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
  };
}

describe('createReportHtml', () => {
  it('escapes project title content in the HTML title tag', () => {
    const projectTitle = '</title><script>alert(1)</script>&"\'';
    const html = createReportHtml(makeViewerData(projectTitle));

    expect(html).toContain('<title>&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&quot;&#39;');
    expect(html).not.toContain('<title></title><script>alert(1)</script>');
  });
});
