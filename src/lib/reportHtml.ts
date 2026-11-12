import type { ViewerData } from '../types';
import { adaptViewerData } from './evidence';
import { applyTestedMembership } from './evidenceMembership';
import { escapeHtml, normalizePathwayName, safeHtmlScriptPayload, slugify } from './utils';

interface ReportAssetSources {
  cytoscapeSource: string;
  cytoscapeSvgSource: string;
  layoutBaseSource: string;
  coseBaseSource: string;
  cytoscapeFcoseSource: string;
  elkBundledSource: string;
  cytoscapeElkSource: string;
  jspdfSource: string;
  plotlySource: string;
  svg2pdfSource: string;
  reportRuntimeSource: string;
  reportStylesSource: string;
}

let reportAssetSourcesPromise: Promise<ReportAssetSources> | null = null;
const reportAssetTextCache = new Map<string, string>();

function cacheReportAssetSources(sources: ReportAssetSources): ReportAssetSources {
  return sources;
}

async function fetchAssetText(url: string): Promise<string> {
  const cached = reportAssetTextCache.get(url);
  if (cached !== undefined) {
    return cached;
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to load report asset: ${url} (${response.status})`);
  }
  const text = await response.text();
  reportAssetTextCache.set(url, text);
  return text;
}

function createReportAssetSourcesPromise(): Promise<ReportAssetSources> {
  return (import.meta.env.MODE === 'test'
    ? Promise.all([
        import('../vendor/cytoscape.min.js?raw'),
        import('../vendor/cytoscape-svg.js?raw'),
        import('../vendor/layout-base.js?raw'),
        import('../vendor/cose-base.js?raw'),
        import('../vendor/cytoscape-fcose.js?raw'),
        import('../vendor/elk.bundled.js?raw'),
        import('../vendor/cytoscape-elk.js?raw'),
        import('../vendor/jspdf.umd.min.js?raw'),
        import('../vendor/plotly.min.js?raw'),
        import('../vendor/svg2pdf.umd.min.js?raw'),
        import('../report/runtime.js?raw'),
        import('../report/styles.css?raw'),
      ]).then(
        ([
          cytoscapeSource,
          cytoscapeSvgSource,
          layoutBaseSource,
          coseBaseSource,
          cytoscapeFcoseSource,
          elkBundledSource,
          cytoscapeElkSource,
          jspdfSource,
          plotlySource,
          svg2pdfSource,
          reportRuntimeSource,
          reportStylesSource,
        ]) => ({
          cytoscapeSource: cytoscapeSource.default,
          cytoscapeSvgSource: cytoscapeSvgSource.default,
          layoutBaseSource: layoutBaseSource.default,
          coseBaseSource: coseBaseSource.default,
          cytoscapeFcoseSource: cytoscapeFcoseSource.default,
          elkBundledSource: elkBundledSource.default,
          cytoscapeElkSource: cytoscapeElkSource.default,
          jspdfSource: jspdfSource.default,
          plotlySource: plotlySource.default,
          svg2pdfSource: svg2pdfSource.default,
          reportRuntimeSource: reportRuntimeSource.default,
          reportStylesSource: reportStylesSource.default,
        }),
      )
    : Promise.all([
        import('../vendor/cytoscape.min.js?url'),
        import('../vendor/cytoscape-svg.js?url'),
        import('../vendor/layout-base.js?url'),
        import('../vendor/cose-base.js?url'),
        import('../vendor/cytoscape-fcose.js?url'),
        import('../vendor/elk.bundled.js?url'),
        import('../vendor/cytoscape-elk.js?url'),
        import('../vendor/jspdf.umd.min.js?url'),
        import('../vendor/plotly.min.js?url'),
        import('../vendor/svg2pdf.umd.min.js?url'),
        import('../report/runtime.js?raw'),
        import('../report/styles.css?raw'),
      ]).then(
        async ([
          cytoscapeSourceUrl,
          cytoscapeSvgSourceUrl,
          layoutBaseSourceUrl,
          coseBaseSourceUrl,
          cytoscapeFcoseSourceUrl,
          elkBundledSourceUrl,
          cytoscapeElkSourceUrl,
          jspdfSourceUrl,
          plotlySourceUrl,
          svg2pdfSourceUrl,
          reportRuntimeSource,
          reportStylesSource,
        ]) => {
          const [
            cytoscapeSource,
            cytoscapeSvgSource,
            layoutBaseSource,
            coseBaseSource,
            cytoscapeFcoseSource,
            elkBundledSource,
            cytoscapeElkSource,
            jspdfSource,
            plotlySource,
            svg2pdfSource,
          ] = await Promise.all([
            fetchAssetText(cytoscapeSourceUrl.default),
            fetchAssetText(cytoscapeSvgSourceUrl.default),
            fetchAssetText(layoutBaseSourceUrl.default),
            fetchAssetText(coseBaseSourceUrl.default),
            fetchAssetText(cytoscapeFcoseSourceUrl.default),
            fetchAssetText(elkBundledSourceUrl.default),
            fetchAssetText(cytoscapeElkSourceUrl.default),
            fetchAssetText(jspdfSourceUrl.default),
            fetchAssetText(plotlySourceUrl.default),
            fetchAssetText(svg2pdfSourceUrl.default),
          ]);
          return {
            cytoscapeSource,
            cytoscapeSvgSource,
            layoutBaseSource,
            coseBaseSource,
            cytoscapeFcoseSource,
            elkBundledSource,
            cytoscapeElkSource,
            jspdfSource,
            plotlySource,
            svg2pdfSource,
            reportRuntimeSource: reportRuntimeSource.default,
            reportStylesSource: reportStylesSource.default,
          };
        },
      )) as Promise<ReportAssetSources>;
}

if (import.meta.env.MODE === 'test') {
  reportAssetSourcesPromise = createReportAssetSourcesPromise().then(cacheReportAssetSources);
  void reportAssetSourcesPromise.catch(() => {});
}

async function loadReportAssetSources(): Promise<ReportAssetSources> {
  if (!reportAssetSourcesPromise) {
    reportAssetSourcesPromise = createReportAssetSourcesPromise().then(cacheReportAssetSources);
  }
  return reportAssetSourcesPromise;
}

function inlineStyle(css: string): string {
  return css.replace(/<\/style/gi, '<\\/style');
}

function inlineScript(js: string): string {
  return safeHtmlScriptPayload(js);
}

export function reportFilenameForProject(projectTitle: string): string {
  const base = slugify(projectTitle) || 'pathway-network-report';
  return `${base}.report.html`;
}

export function prepareViewerDataForReport(viewerData: ViewerData): ViewerData {
  const adapted = applyTestedMembership(adaptViewerData(viewerData));
  const sampleValuesByGene = { ...(adapted.sampleValuesByGene ?? {}) };
  const sharedEdges = [...(adapted.sharedEdges ?? [])];
  const edgeKey = (edge: import('../types').ViewerEdge) => JSON.stringify([edge.source, edge.target, edge.score, Boolean(edge.isString), Boolean(edge.isHuRI), Boolean(edge.isCustom)]);
  const edgeIndex = new Map(sharedEdges.map((edge, index) => [edgeKey(edge), index]));
  const pathways = adapted.pathways.map(pathway => ({
    ...pathway,
    searchNameNormalized: pathway.searchNameNormalized || normalizePathwayName(pathway.pathwayName),
    edgeIndices: pathway.edgeIndices ?? pathway.edges.map(edge => {
      const key = edgeKey(edge);
      let index = edgeIndex.get(key);
      if (index === undefined) { index = sharedEdges.length; edgeIndex.set(key, index); sharedEdges.push(edge); }
      return index;
    }),
    edges: [],
    nodes: pathway.nodes.map(node => {
      if (!Object.keys(node.sampleValues).length) return node;
      if (!sampleValuesByGene[node.id]) sampleValuesByGene[node.id] = node.sampleValues;
      const shared = sampleValuesByGene[node.id];
      const compatible = shared === node.sampleValues || JSON.stringify(shared) === JSON.stringify(node.sampleValues);
      return compatible ? { ...node, sampleValues: {} } : node;
    }),
  }));
  return { ...adapted, sampleValuesByGene, sharedEdges, provenance: viewerData.provenance ? { ...viewerData.provenance } : undefined, pathways };
}

export async function createReportHtml(viewerData: ViewerData, options: { condition?: 'full' | 'basic' } = {}): Promise<string> {
  const reportAssets = await loadReportAssetSources();
  const reportViewerData = prepareViewerDataForReport({ ...viewerData, reportCondition: options.condition ?? viewerData.reportCondition ?? 'full' });
  const title = `${reportViewerData.project.projectTitle} — Pathway Network Viewer`;
  const escapedTitle = escapeHtml(title);
  const serializedData = JSON.stringify(reportViewerData).replace(/</g, '\\u003c');
  const requiredRuntimeScriptIds = [
    'pnv-cytoscape-source',
    'pnv-cytoscape-svg-source',
    'pnv-layout-base-source',
    'pnv-cose-base-source',
    'pnv-cytoscape-fcose-source',
    'pnv-elk-bundled-source',
    'pnv-cytoscape-elk-source',
  ];
  const serializedRequiredScriptIds = JSON.stringify(requiredRuntimeScriptIds).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <style>${inlineStyle(reportAssets.reportStylesSource)}</style>
  </head>
  <body>
    <div id="app"></div>
    <script id="pnv-cytoscape-source" type="text/plain">${inlineScript(reportAssets.cytoscapeSource)}</script>
    <script id="pnv-cytoscape-svg-source" type="text/plain">${inlineScript(reportAssets.cytoscapeSvgSource)}</script>
    <script id="pnv-layout-base-source" type="text/plain">${inlineScript(reportAssets.layoutBaseSource)}</script>
    <script id="pnv-cose-base-source" type="text/plain">${inlineScript(reportAssets.coseBaseSource)}</script>
    <script id="pnv-cytoscape-fcose-source" type="text/plain">${inlineScript(reportAssets.cytoscapeFcoseSource)}</script>
    <script id="pnv-elk-bundled-source" type="text/plain">${inlineScript(reportAssets.elkBundledSource)}</script>
    <script id="pnv-cytoscape-elk-source" type="text/plain">${inlineScript(reportAssets.cytoscapeElkSource)}</script>
    <script id="pnv-plotly-source" type="text/plain">${inlineScript(reportAssets.plotlySource)}</script>
    <script id="pnv-jspdf-source" type="text/plain">${inlineScript(reportAssets.jspdfSource)}</script>
    <script id="pnv-svg2pdf-source" type="text/plain">${inlineScript(reportAssets.svg2pdfSource)}</script>
    <script>
      window.__PNV_LOAD_REQUIRED_REPORT_RUNTIME__ = (function () {
        let loaded = false;
        return function () {
          if (loaded) {
            return;
          }
          loaded = true;
          const scriptIds = ${serializedRequiredScriptIds};
          scriptIds.forEach((id) => {
            const sourceNode = document.getElementById(id);
            if (!sourceNode || !sourceNode.textContent) {
              return;
            }
            const runtimeScript = document.createElement('script');
            runtimeScript.text = sourceNode.textContent;
            document.head.appendChild(runtimeScript);
          });
          window.cytoscapeSvg && window.cytoscapeSvg(window.cytoscape);
        };
      })();
      window.__PNV_LOAD_REQUIRED_REPORT_RUNTIME__();
      window.__PNV_DATA__ = ${serializedData};
    </script>
    <script>${inlineScript(reportAssets.reportRuntimeSource)}</script>
  </body>
</html>`;
}
