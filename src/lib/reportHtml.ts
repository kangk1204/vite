import cytoscapeSource from '../vendor/cytoscape.min.js?raw';
import cytoscapeSvgSource from '../vendor/cytoscape-svg.js?raw';
import layoutBaseSource from '../vendor/layout-base.js?raw';
import coseBaseSource from '../vendor/cose-base.js?raw';
import cytoscapeFcoseSource from '../vendor/cytoscape-fcose.js?raw';
import elkBundledSource from '../vendor/elk.bundled.js?raw';
import cytoscapeElkSource from '../vendor/cytoscape-elk.js?raw';
import jspdfSource from '../vendor/jspdf.umd.min.js?raw';
import plotlySource from '../vendor/plotly.min.js?raw';
import svg2pdfSource from '../vendor/svg2pdf.umd.min.js?raw';
import reportRuntimeSource from '../report/runtime.js?raw';
import reportStylesSource from '../report/styles.css?raw';
import type { ViewerData } from '../types';
import { escapeHtml, safeHtmlScriptPayload, slugify } from './utils';

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

export function createReportHtml(viewerData: ViewerData): string {
  const title = `${viewerData.project.projectTitle} — Pathway Network Viewer`;
  const escapedTitle = escapeHtml(title);
  const serializedData = JSON.stringify(viewerData).replace(/</g, '\\u003c');

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapedTitle}</title>
    <style>${inlineStyle(reportStylesSource)}</style>
  </head>
  <body>
    <div id="app"></div>
    <script>${inlineScript(cytoscapeSource)}</script>
    <script>${inlineScript(cytoscapeSvgSource)}</script>
    <script>${inlineScript(layoutBaseSource)}</script>
    <script>${inlineScript(coseBaseSource)}</script>
    <script>${inlineScript(cytoscapeFcoseSource)}</script>
    <script>${inlineScript(elkBundledSource)}</script>
    <script>${inlineScript(cytoscapeElkSource)}</script>
    <script>${inlineScript(plotlySource)}</script>
    <script>${inlineScript(jspdfSource)}</script>
    <script>${inlineScript(svg2pdfSource)}</script>
    <script>
      window.cytoscapeSvg && window.cytoscapeSvg(window.cytoscape);
      window.__PNV_DATA__ = ${serializedData};
    </script>
    <script>${inlineScript(reportRuntimeSource)}</script>
  </body>
</html>`;
}
