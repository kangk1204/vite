(function () {
  const data = window.__PNV_DATA__;
  const { cytoscape } = window;
  const STORAGE_KEY = 'pnv.viewer.preferences.v1';
  const LAYOUT_OPTIONS = new Set(['fcose', 'elk-stress', 'elk-force', 'elk-layered', 'cose', 'concentric', 'circle']);
  const PPI_OPTIONS = new Set(['all', 'string', 'huri', 'custom']);
  const TOP_GENE_OPTIONS = new Set([0, 15, 25, 40, 60]);
  const TOP_EDGE_PERCENTILE_OPTIONS = new Set([25, 50, 75, 100]);
  const NODE_SIZE_SCALE_OPTIONS = new Set([0.75, 1, 1.25, 1.5]);

  const EXPORT_PRESETS = {
    '1-column': { key: '1-column', label: '1-column', widthInches: 3.54, heightInches: 2.7 },
    '2-column': { key: '2-column', label: '2-column', widthInches: 7.2, heightInches: 4.8 },
    slide: { key: 'slide', label: 'Slide', widthInches: 13.33, heightInches: 7.5 },
  };
  const DEFAULT_HOVER_SUMMARY = 'Hover over a node to inspect expression and DEG statistics. Ctrl/Cmd-click or Shift+drag to select genes, then click Heatmap for a figure-ready clustered view.';
  const SAVE_PREFERENCES_DEBOUNCE_MS = 120;
  const LABEL_COLLISION_DEBOUNCE_MS = 56;
  const LABEL_BUCKET_SIZE = 44;
  const PATHWAY_SEARCH_CACHE_LIMIT = 28;
  const PATHWAY_SEARCH_TOKEN_CACHE_LIMIT = 96;
  const PATHWAY_SEARCH_CACHEABLE_MATCH_LIMIT = 1800;
  const PATHWAY_SEARCH_PREFIX_TOKEN_LENGTH = 3;
  const PATHWAY_SEARCH_MIN_PREFIX_TOKEN_LENGTH = 2;
  const PATHWAY_SEARCH_PREFIX_INTERSECTION_LIMIT = 3;
  const PATHWAY_LIST_RENDER_BATCH_SIZE = 180;
  const PATHWAY_SEARCH_BASE_DEBOUNCE_MS = 36;
  const PATHWAY_SEARCH_MAX_DEBOUNCE_MS = 112;
  const DEVICE_MEMORY_GB =
    typeof navigator !== 'undefined' && Number.isFinite(Number(navigator.deviceMemory))
      ? Number(navigator.deviceMemory)
      : 4;
  const PATHWAY_LIST_INITIAL_VISIBLE =
    DEVICE_MEMORY_GB <= 2 ? 140 : DEVICE_MEMORY_GB >= 8 ? 240 : 180;
  const PATHWAY_LIST_INCREMENT =
    DEVICE_MEMORY_GB <= 2 ? 100 : DEVICE_MEMORY_GB >= 8 ? 220 : 160;
  const LABEL_COLLISION_NODE_HARD_LIMIT =
    DEVICE_MEMORY_GB <= 2 ? 180 : DEVICE_MEMORY_GB >= 8 ? 420 : 300;
  const PREFERS_REDUCED_MOTION =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    currentPathwayKey: null,
    search: '',
    showAllGenes: false,
    selectedGeneId: null,
    highlightedGeneIds: [],
    pendingFocusGeneId: null,
    tableSortKey: 'padj',
    tableSortDir: 'asc',
    ppiMode: 'all',
    edgeScoreMin: Number(data.referenceSummary?.stringScoreCutoff || 700),
    topGeneCount: 0,
    topEdgePercentile: 100,
    nodeSizeScale: 1,
    layoutMode: 'fcose',
    tablePage: 1,
  };
  applySavedPreferences();

  const app = document.getElementById('app');
  if (!app) {
    return;
  }
  if (!data || !Array.isArray(data.pathways)) {
    app.innerHTML = '<main style="padding:24px;font-family:Arial,sans-serif;color:#102039">Unable to load report data. Please regenerate report.html from the builder.</main>';
    return;
  }
  if (typeof cytoscape !== 'function') {
    app.innerHTML = '<main style="padding:24px;font-family:Arial,sans-serif;color:#102039">Required visualization runtime is unavailable. Please regenerate report.html and open it in a modern browser.</main>';
    return;
  }
  const contrastTechnicalLabel = String(data.project?.contrastName || '').trim();
  const contrastDisplayTitle = buildReadableContrastTitle(data.project);
  const conditionSummary = `${formatConditionLabel(data.project.conditionB)} versus ${formatConditionLabel(data.project.conditionA)}`;
  const hoverConditionALabel = escapeHtml(formatConditionLabel(data.project.conditionA));
  const hoverConditionBLabel = escapeHtml(formatConditionLabel(data.project.conditionB));
  const provenance = data.provenance || {};
  const evidence = data.evidence || {};
  const fullEvidence = data.reportCondition !== 'basic';
  const sourceTables = evidence.sourceTables || {};
  let sourceTableOffset = 0;

  app.innerHTML = `
    <div class="report-shell">
      <header class="report-header">
        <div class="header-main">
          <div class="header-kicker-row">
            <p class="eyebrow">${escapeHtml(contrastTechnicalLabel || 'Contrast')}</p>
            <span class="header-pill">Built ${formatDate(data.builtAt)}</span>
          </div>
          <h1>${escapeHtml(contrastDisplayTitle)}</h1>
          <p class="headline-subtitle">${escapeHtml(data.project.projectTitle)}</p>
          <p class="muted header-condition-line">${escapeHtml(conditionSummary)}</p>
          <dl class="provenance-grid" aria-label="Analysis provenance" ${fullEvidence ? '' : 'hidden'}>
            <div class="provenance-item">
              <dt>Dataset</dt>
              <dd>${escapeHtml(formatProvenanceValue(provenance.datasetIdentifier, 'Not recorded'))}</dd>
            </div>
            <div class="provenance-item">
              <dt>Contrast</dt>
              <dd>${escapeHtml(formatProvenanceValue(provenance.contrastDefinition, conditionSummary))}</dd>
            </div>
            <div class="provenance-item">
              <dt>Sample groups</dt>
              <dd>${escapeHtml(formatProvenanceValue(provenance.sampleGroupSource, 'Not recorded'))}</dd>
            </div>
            <div class="provenance-item">
              <dt>Batch rule</dt>
              <dd>${escapeHtml(formatProvenanceValue(provenance.batchHandlingRule, 'Not recorded'))}</dd>
            </div>
            <div class="provenance-item">
              <dt>Git commit</dt>
              <dd>${escapeHtml(formatProvenanceValue(provenance.gitCommit, 'Not recorded'))}</dd>
            </div>
            <div class="provenance-item">
              <dt>Reference assets</dt>
              <dd>${escapeHtml(formatProvenanceValue(provenance.referenceAssetVersion, 'Not recorded'))}</dd>
            </div>
          </dl>
          ${
            fullEvidence && provenance.notes
              ? `<p class="provenance-notes muted">${escapeHtml(String(provenance.notes))}</p>`
              : ''
          }
          <div class="header-export">
            <div class="detail-head">
              <strong>Figure export</strong>
              <span class="muted">Current view aware</span>
            </div>
            <div class="export-grid">
              <select id="export-target" class="select-control">
                <option value="full">Full Figure</option>
                <option value="network">Network Only</option>
                <option value="plot">Enrichment Plot Only</option>
              </select>
              <select id="export-format" class="select-control">
                <option value="pdf">PDF</option>
                <option value="svg">SVG</option>
                <option value="png">PNG</option>
                <option value="jpg">JPG</option>
              </select>
              <select id="export-preset" class="select-control">
                <option value="1-column">1-column</option>
                <option value="2-column" selected>2-column</option>
                <option value="slide">Slide</option>
              </select>
              <div class="export-save-group">
                <select id="export-dpi" class="select-control">
                  <option value="300" selected>300 dpi</option>
                  <option value="600">600 dpi</option>
                </select>
                <button id="export-button" class="action-button" type="button">
                  <span class="save-icon" aria-hidden="true">&#8595;</span>
                  <span>Save Figure</span>
                </button>
              </div>
            </div>
          </div>
        </div>
        <div class="header-badges">
          <span class="legend-badge">Node size = −log10(FDR); missing FDR uses minimum size</span>
          <span class="legend-badge">Leading edge = blue · pathway member = light blue · outside = gray</span>
          <span class="legend-badge">PPI edges are reference associations, not inferred causal effects</span>
          <span class="legend-badge">Interactive standalone HTML</span>
        </div>
      </header>
      ${renderEvidenceHeader()}
      <div class="report-grid">
        <section class="panel network-panel" id="network-panel">
          <div class="network-toolbar">
            <div class="pathway-meta">
              <h2 id="current-pathway-name"></h2>
              <p id="current-pathway-summary"></p>
              <div id="pathway-evidence" class="pathway-evidence" ${fullEvidence ? '' : 'hidden'}></div>
              <div class="focused-gene-chip" id="focused-gene-chip" hidden>Focused gene</div>
            </div>
            <div class="toolbar-controls">
              <label class="toggle-chip">
                <input id="toggle-all-genes" type="checkbox" />
                <span id="toggle-all-genes-label">Show all pathway genes</span>
              </label>
              <select id="layout-mode" class="select-control">
                <option value="fcose">Layout: fCoSE</option>
                <option value="elk-stress">Layout: ELK stress</option>
                <option value="elk-force">Layout: ELK force</option>
                <option value="elk-layered">Layout: ELK layered</option>
                <option value="cose">Layout: CoSE</option>
                <option value="concentric">Layout: Concentric</option>
                <option value="circle">Layout: Circle</option>
              </select>
              <select id="ppi-mode" class="select-control">
                <option value="all">PPI: All</option>
                <option value="string">PPI: STRING only</option>
                <option value="huri">PPI: HuRI only</option>
                <option value="custom">PPI: Custom only</option>
              </select>
              <label class="range-chip">
                <span id="edge-score-label">Min score ≥ 700</span>
                <input id="edge-score" type="range" min="0" max="1000" step="25" value="700" aria-label="Edge minimum score" />
              </label>
              <select id="top-genes" class="select-control">
                <option value="0">Genes: All</option>
                <option value="15">Genes: Top 15</option>
                <option value="25">Genes: Top 25</option>
                <option value="40">Genes: Top 40</option>
                <option value="60">Genes: Top 60</option>
              </select>
              <select id="node-size-scale" class="select-control">
                <option value="0.75">Node: 75%</option>
                <option value="1" selected>Node: 100%</option>
                <option value="1.25">Node: 125%</option>
                <option value="1.5">Node: 150%</option>
              </select>
              <select id="edge-percentile" class="select-control">
                <option value="100">Edges: All</option>
                <option value="75">Edges: Top 75%</option>
                <option value="50">Edges: Top 50%</option>
                <option value="25">Edges: Top 25%</option>
              </select>
              <div class="zoom-controls">
                <button id="zoom-out-button" class="tool-button" type="button">−</button>
                <button id="zoom-reset-button" class="tool-button tool-button-wide" type="button">Reset</button>
                <button id="zoom-in-button" class="tool-button" type="button">+</button>
              </div>
              <button id="heatmap-button" class="action-button heatmap-button" type="button" disabled title="Select at least 2 genes with Ctrl/Cmd-click to generate heatmap">
                <span class="heatmap-icon" aria-hidden="true">▦</span>
                <span>Heatmap</span>
              </button>
            </div>
          </div>
          <div class="network-stage">
            <div id="network-container"></div>
            <div class="hover-summary" id="hover-summary">${escapeHtml(DEFAULT_HOVER_SUMMARY)}</div>
          </div>
        </section>
        <aside class="sidebar">
          <section class="panel plot-panel">
            <div class="sidebar-head">
              <strong>Ranked-gene running sum</strong>
              <span class="muted" id="plot-caption"></span>
            </div>
            <div id="plot-container"></div>
          </section>
          <section class="panel list-panel">
            <div class="sidebar-head">
              <strong>Tested pathways</strong>
              <span class="muted" id="pathway-count" aria-live="polite"></span>
            </div>
            <div style="margin: 12px 0">
              <div class="search-wrap">
                <input id="pathway-search" class="search-control" placeholder="Search pathway name" aria-label="Search pathway name" />
                <button id="pathway-search-clear" class="search-clear-button" type="button" aria-label="Clear pathway search" hidden>Clear</button>
              </div>
            </div>
            <div class="pathway-list" id="pathway-list" role="listbox" aria-label="Enriched pathway list"></div>
            <div class="pathway-list-footer" id="pathway-list-footer" hidden>
              <span class="muted pathway-list-progress" id="pathway-list-progress"></span>
              <button id="pathway-list-more" class="tool-button pathway-list-more" type="button">Load more</button>
            </div>
          </section>
        </aside>
        <section class="panel detail-panel table-panel">
          <div class="table-panel-top">
            <div class="detail-section">
              <div class="detail-head">
                <strong>Gene detail</strong>
                <span class="muted" id="detail-caption"></span>
              </div>
              <div id="gene-detail" class="empty-card">Click a gene node to see expression, DEG statistics, and membership details.</div>
            </div>
          </div>
          <div class="gene-table-block">
            <div class="detail-head">
              <strong>Pathway genes</strong>
              <span class="muted" id="gene-table-caption"></span>
            </div>
            <div id="gene-table" class="gene-table-shell"></div>
          </div>
        </section>
      </div>
    </div>
  `;

  const toggleAllGenesEl = document.getElementById('toggle-all-genes');
  const hoverSummaryEl = document.getElementById('hover-summary');
  const networkPanelEl = document.getElementById('network-panel');
  const pathwaySearchEl = document.getElementById('pathway-search');
  const pathwaySearchClearEl = document.getElementById('pathway-search-clear');
  const pathwayListEl = document.getElementById('pathway-list');
  const pathwayListFooterEl = document.getElementById('pathway-list-footer');
  const pathwayListProgressEl = document.getElementById('pathway-list-progress');
  const pathwayListMoreButtonEl = document.getElementById('pathway-list-more');
  const pathwayCountEl = document.getElementById('pathway-count');
  const currentPathwayNameEl = document.getElementById('current-pathway-name');
  const currentPathwaySummaryEl = document.getElementById('current-pathway-summary');
  const focusedGeneChipEl = document.getElementById('focused-gene-chip');
  const plotCaptionEl = document.getElementById('plot-caption');
  const detailCaptionEl = document.getElementById('detail-caption');
  const geneDetailEl = document.getElementById('gene-detail');
  const geneTableEl = document.getElementById('gene-table');
  const geneTableCaptionEl = document.getElementById('gene-table-caption');
  const layoutModeEl = document.getElementById('layout-mode');
  const ppiModeEl = document.getElementById('ppi-mode');
  const edgeScoreEl = document.getElementById('edge-score');
  const edgeScoreLabelEl = document.getElementById('edge-score-label');
  const topGenesEl = document.getElementById('top-genes');
  const nodeSizeScaleEl = document.getElementById('node-size-scale');
  const edgePercentileEl = document.getElementById('edge-percentile');
  const zoomOutButtonEl = document.getElementById('zoom-out-button');
  const zoomResetButtonEl = document.getElementById('zoom-reset-button');
  const zoomInButtonEl = document.getElementById('zoom-in-button');
  const heatmapButtonEl = document.getElementById('heatmap-button');
  const exportTargetEl = document.getElementById('export-target');
  const exportFormatEl = document.getElementById('export-format');
  const exportPresetEl = document.getElementById('export-preset');
  const exportDpiEl = document.getElementById('export-dpi');
  const exportButtonEl = document.getElementById('export-button');

  installEvidenceControls();

  const significantPathways = data.pathways.filter(
    (pathway) => Number.isFinite(pathway.padj) && pathway.padj <= data.significantPadjThreshold,
  );
  const allPathways = data.pathways.map(pathway => ({ ...pathway, nodes: pathway.nodes.map(node => ({ ...node, sampleValues: Object.keys(node.sampleValues || {}).length ? node.sampleValues : data.sampleValuesByGene?.[node.id] || {} })) }));
  const enrichmentCache = new Map();
  const defaultPathways = allPathways;
  const pathwaySearchIndex = allPathways.map((pathway) => ({
    pathway,
    nameNormalized: pathway.searchNameNormalized || normalizeMatchToken(pathway.pathwayName),
  }));
  const pathwaySearchEngine = createPathwaySearchEngine(pathwaySearchIndex);
  const pathwayByKey = new Map(allPathways.map((pathway) => [pathway.key, pathway]));
  const tableSortCache = new Map();
  const pathwayNodeLookupCache = new Map();
  const pathwayRenderPrepCache = new Map();
  const pathwayGeneSetCache = new Map();
  const geneDetailSampleRowsCache = new Map();
  const networkViewCache = new Map();
  const geneSampleValueCountCache = new WeakMap();
  const MAX_TABLE_SORT_CACHE_ENTRIES =
    DEVICE_MEMORY_GB <= 2 ? 120 : DEVICE_MEMORY_GB >= 8 ? 240 : 180;
  const MAX_NETWORK_VIEW_CACHE_ENTRIES =
    DEVICE_MEMORY_GB <= 2 ? 150 : DEVICE_MEMORY_GB >= 8 ? 320 : 260;
  const MAX_GENE_DETAIL_SAMPLE_CACHE_ENTRIES =
    DEVICE_MEMORY_GB <= 2 ? 140 : DEVICE_MEMORY_GB >= 8 ? 420 : 280;
  const MAX_PATHWAY_NODE_LOOKUP_CACHE_ENTRIES =
    DEVICE_MEMORY_GB <= 2 ? 120 : DEVICE_MEMORY_GB >= 8 ? 380 : 250;
  const MAX_PATHWAY_RENDER_PREP_CACHE_ENTRIES =
    DEVICE_MEMORY_GB <= 2 ? 100 : DEVICE_MEMORY_GB >= 8 ? 300 : 200;
  const MAX_PATHWAY_GENE_SET_CACHE_ENTRIES =
    DEVICE_MEMORY_GB <= 2 ? 130 : DEVICE_MEMORY_GB >= 8 ? 400 : 270;
  let filteredPathwaysCache = null;
  let filteredPathwaysCacheSearch = null;
  let highlightedGeneSet = new Set();
  let renderPathwayTimerId = null;
  let pathwaySearchTimerId = null;
  let pathwayListRenderFrameId = null;
  let pathwayListRenderToken = 0;
  let pathwayListVisibleCount = PATHWAY_LIST_INITIAL_VISIBLE;
  let labelCollisionFrameId = null;
  let labelCollisionTimerId = null;
  let savePreferencesTimerId = null;
  let lastRenderedPathwayKey = null;
  let lastRenderedLayoutMode = null;
  let lastRenderedNodeSignature = '';
  let lastLabelLayoutSignature = '';
  let lastPlottedPathwayKey = null;
  let lastRenderedPathwayListSearch = null;
  let lastRenderedPathwayListRef = null;
  let lastRenderedPathwayListActiveKey = null;
  let lastRenderedPathwayListVisibleCount = -1;
  let lastRenderedGeneTableSignature = '';
  let lastRenderedGeneTableActiveGeneId = null;
  let lastRenderedGeneTableHighlightedSignature = '';
  let lastAppliedHighlightedGeneSet = new Set();
  let lastAppliedSelectedGeneId = null;
  let handleGlobalKeydownListener = null;

  state.currentPathwayKey = defaultPathways[0]?.key || allPathways[0]?.key || null;

  const cy = cytoscape({
    container: document.getElementById('network-container'),
    elements: [],
    wheelSensitivity: 0.62,
    boxSelectionEnabled: true,
    selectionType: 'additive',
    style: [
      {
        selector: 'node',
        style: {
          label: 'data(displayLabel)',
          'font-size': 12,
          'font-weight': 700,
          color: '#12233d',
          'text-valign': 'top',
          'text-halign': 'center',
          'text-margin-y': -10,
          'text-wrap': 'wrap',
          'text-max-width': 110,
          'text-outline-color': '#ffffff',
          'text-outline-width': 2,
          width: 'data(renderSize)',
          height: 'data(renderSize)',
          'background-color': 'data(fillColor)',
          'border-color': 'data(borderColor)',
          'border-width': 'data(borderWidth)',
          'overlay-opacity': 0,
          'shadow-blur': 16,
          'shadow-color': 'rgba(58, 90, 150, 0.18)',
          'shadow-opacity': 0.8,
          'shadow-offset-x': 0,
          'shadow-offset-y': 10,
        },
      },
      {
        selector: 'edge',
        style: {
          width: 'data(renderWidth)',
          'line-color': 'data(lineColor)',
          opacity: 'data(opacity)',
          'curve-style': 'bezier',
        },
      },
      {
        selector: '.highlighted-node',
        style: {
          'border-color': '#ff8a3d',
          'border-width': 3.6,
          'text-background-color': 'rgba(255, 255, 255, 0.94)',
          'text-background-opacity': 1,
          'text-background-shape': 'roundrectangle',
          'text-background-padding': 4,
          'text-border-color': 'rgba(255, 138, 61, 0.16)',
          'text-border-width': 1,
        },
      },
      {
        selector: ':selected',
        style: {
          'border-color': '#102039',
          'border-width': 4,
          'text-background-color': 'rgba(255, 255, 255, 0.96)',
          'text-background-opacity': 1,
          'text-background-shape': 'roundrectangle',
          'text-background-padding': 4,
          'text-border-color': 'rgba(16, 32, 57, 0.14)',
          'text-border-width': 1,
        },
      },
    ],
  });
  let boxSelectionBaselineIds = [];
  document.getElementById('network-container').addEventListener('contextmenu', (event) => event.preventDefault());

  cy.on('tap', 'node', handleNodeInteraction);
  cy.on('cxttap', 'node', handleNodeInteraction);
  cy.on('boxstart', () => {
    boxSelectionBaselineIds = cy.$(':selected').nodes().map((node) => node.id());
  });
  cy.on('boxend', () => {
    window.setTimeout(handleBoxSelection, 0);
  });

  cy.on('mouseover', 'node', (event) => {
    const node = event.target.data();
    hoverSummaryEl.innerHTML = `
      <strong>${escapeHtml(node.label)}</strong><br />
      log2FC ${formatNumber(node.log2fc)} · FDR ${formatSci(node.padj)} · ${hoverConditionALabel} ${formatNumber(node.conditionAMean)} / ${hoverConditionBLabel} ${formatNumber(node.conditionBMean)}
    `;
  });

  cy.on('mouseout', () => {
    hoverSummaryEl.textContent = DEFAULT_HOVER_SUMMARY;
  });
  cy.on('pan zoom resize', () => {
    scheduleLabelCollisionAvoidance();
  });

  toggleAllGenesEl.addEventListener('change', () => {
    state.showAllGenes = toggleAllGenesEl.checked;
    scheduleSavePreferences();
    renderCurrentPathway();
  });

  layoutModeEl.value = state.layoutMode;
  layoutModeEl.addEventListener('change', () => {
    state.layoutMode = layoutModeEl.value;
    scheduleSavePreferences();
    renderCurrentPathway();
  });

  ppiModeEl.value = state.ppiMode;
  ppiModeEl.addEventListener('change', () => {
    state.ppiMode = ppiModeEl.value;
    scheduleSavePreferences();
    renderCurrentPathway();
  });

  edgeScoreEl.value = String(state.edgeScoreMin);
  edgeScoreLabelEl.textContent = `Min score ≥ ${state.edgeScoreMin}`;
  edgeScoreEl.addEventListener('input', () => {
    state.edgeScoreMin = Number(edgeScoreEl.value);
    edgeScoreLabelEl.textContent = `Min score ≥ ${state.edgeScoreMin}`;
    scheduleSavePreferences();
    scheduleRenderCurrentPathway(90);
  });

  topGenesEl.value = String(state.topGeneCount);
  topGenesEl.addEventListener('change', () => {
    state.topGeneCount = Number(topGenesEl.value);
    scheduleSavePreferences();
    renderCurrentPathway();
  });

  nodeSizeScaleEl.value = String(state.nodeSizeScale);
  nodeSizeScaleEl.addEventListener('change', () => {
    const nextScale = Number(nodeSizeScaleEl.value);
    if (!NODE_SIZE_SCALE_OPTIONS.has(nextScale)) {
      return;
    }
    state.nodeSizeScale = nextScale;
    scheduleSavePreferences();
    renderCurrentPathway();
  });

  edgePercentileEl.value = String(state.topEdgePercentile);
  edgePercentileEl.addEventListener('change', () => {
    state.topEdgePercentile = Number(edgePercentileEl.value);
    scheduleSavePreferences();
    renderCurrentPathway();
  });

  zoomOutButtonEl.addEventListener('click', () => {
    adjustZoom(1 / 1.35);
  });

  zoomInButtonEl.addEventListener('click', () => {
    adjustZoom(1.35);
  });

  zoomResetButtonEl.addEventListener('click', () => {
    cy.animate({
      fit: {
        eles: cy.elements(),
        padding: 72,
      },
      duration: PREFERS_REDUCED_MOTION ? 0 : 180,
      easing: 'ease-out',
    });
  });

  pathwaySearchEl.addEventListener('input', (event) => {
    const nextSearch = normalizeMatchToken(event.target.value);
    schedulePathwaySearchUpdate(nextSearch);
  });
  pathwaySearchEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') {
      return;
    }
    event.preventDefault();
    pathwaySearchEl.value = '';
    schedulePathwaySearchUpdate('');
  });
  pathwaySearchClearEl.addEventListener('click', () => {
    pathwaySearchEl.value = '';
    schedulePathwaySearchUpdate('');
    pathwaySearchEl.focus();
  });
  pathwayListMoreButtonEl.addEventListener('click', () => {
    const pathways = getFilteredPathways();
    if (!pathways.length) {
      return;
    }
    if (!expandPathwayListVisibleCount(pathways.length)) {
      return;
    }
    const activePathwayKey = state.currentPathwayKey;
    renderPathwayList();
    if (activePathwayKey) {
      const nextButton = pathwayListEl.querySelector(
        `[data-pathway-key="${escapeCss(activePathwayKey)}"]`,
      );
      if (nextButton instanceof HTMLElement) {
        nextButton.focus();
      }
    }
  });
  pathwayListEl.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const button = target ? target.closest('[data-pathway-key]') : null;
    if (!button) {
      return;
    }
    const pathwayKey = button.getAttribute('data-pathway-key');
    if (!pathwayKey || pathwayKey === state.currentPathwayKey) {
      return;
    }
    selectPathway(pathwayKey);
  });
  pathwayListEl.addEventListener('keydown', (event) => {
    const activeButton = event.target instanceof Element ? event.target.closest('[data-pathway-key]') : null;
    if (!activeButton) {
      return;
    }
    const pathways = getFilteredPathways();
    if (!pathways.length) {
      return;
    }
    const activePathwayKey = activeButton.getAttribute('data-pathway-key');
    const currentIndex = pathways.findIndex((pathway) => pathway.key === activePathwayKey);
    if (currentIndex < 0) {
      return;
    }

    let targetIndex = currentIndex;
    if (event.key === 'ArrowDown') {
      targetIndex = Math.min(pathways.length - 1, currentIndex + 1);
    } else if (event.key === 'ArrowUp') {
      targetIndex = Math.max(0, currentIndex - 1);
    } else if (event.key === 'Home') {
      targetIndex = 0;
    } else if (event.key === 'End') {
      targetIndex = pathways.length - 1;
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      selectPathway(activePathwayKey);
      return;
    } else {
      return;
    }

    event.preventDefault();
    const nextPathwayKey = pathways[targetIndex]?.key;
    if (!nextPathwayKey) {
      return;
    }
    ensurePathwayListIncludesIndex(targetIndex, pathways.length);
    selectPathway(nextPathwayKey);
    const nextButton = pathwayListEl.querySelector(`[data-pathway-key="${escapeCss(nextPathwayKey)}"]`);
    if (nextButton instanceof HTMLElement) {
      nextButton.focus();
    }
  });
  handleGlobalKeydownListener = (event) => {
    if (isTypingContext(event.target)) {
      return;
    }
    if (event.key === '/') {
      event.preventDefault();
      pathwaySearchEl.focus();
      pathwaySearchEl.select();
      return;
    }
    if (event.key === '-' || event.key === '_') {
      event.preventDefault();
      adjustZoom(1 / 1.35);
      return;
    }
    if (event.key === '+' || event.key === '=') {
      event.preventDefault();
      adjustZoom(1.35);
      return;
    }
    if ((event.key === 'f' || event.key === 'F') && state.selectedGeneId) {
      event.preventDefault();
      focusGeneInNetwork(state.selectedGeneId);
      return;
    }
    if (event.key === '0') {
      event.preventDefault();
      cy.animate({
        fit: {
          eles: cy.elements(),
          padding: 72,
        },
        duration: PREFERS_REDUCED_MOTION ? 0 : 180,
        easing: 'ease-out',
      });
    }
  };
  document.addEventListener('keydown', handleGlobalKeydownListener);

  function scheduleRenderCurrentPathway(delayMs = 0) {
    if (renderPathwayTimerId !== null) {
      window.clearTimeout(renderPathwayTimerId);
    }
    renderPathwayTimerId = window.setTimeout(() => {
      renderPathwayTimerId = null;
      renderCurrentPathway();
    }, delayMs);
  }

  function queueLabelCollisionAvoidanceFrame() {
    if (labelCollisionFrameId !== null) {
      return;
    }
    labelCollisionFrameId = window.requestAnimationFrame(() => {
      labelCollisionFrameId = null;
      applyLabelCollisionAvoidance();
    });
  }

  function scheduleLabelCollisionAvoidance(immediate = false) {
    if (labelCollisionTimerId !== null) {
      window.clearTimeout(labelCollisionTimerId);
      labelCollisionTimerId = null;
    }
    if (immediate) {
      queueLabelCollisionAvoidanceFrame();
      return;
    }
    labelCollisionTimerId = window.setTimeout(() => {
      labelCollisionTimerId = null;
      queueLabelCollisionAvoidanceFrame();
    }, LABEL_COLLISION_DEBOUNCE_MS);
  }
  geneTableEl.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) {
      return;
    }
    const sortButton = target.closest('[data-sort-key]');
    if (sortButton) {
      const sortKey = sortButton.getAttribute('data-sort-key');
      if (!sortKey) {
        return;
      }
      if (state.tableSortKey === sortKey) {
        state.tableSortDir = state.tableSortDir === 'asc' ? 'desc' : 'asc';
      } else {
        state.tableSortKey = sortKey;
        state.tableSortDir = sortKey === 'label' || sortKey === 'padj' || sortKey === 'pvalue' ? 'asc' : 'desc';
      }
      state.tablePage = 1;
      renderGeneTable(getCurrentPathway());
      return;
    }

    const geneButton = target.closest('[data-gene-id]');
    if (geneButton) {
      const geneId = geneButton.getAttribute('data-gene-id');
      if (geneId) {
        focusPathwayGene(geneId);
      }
      return;
    }

    const pageButton = target.closest('[data-page]');
    if (pageButton) {
      const page = Number(pageButton.getAttribute('data-page'));
      if (Number.isFinite(page)) {
        state.tablePage = page;
        renderGeneTable(getCurrentPathway());
      }
    }
  });

  function syncExportControls() {
    const isPlotExport = exportTargetEl.value === 'plot';
    if (isPlotExport) {
      exportFormatEl.value = 'pdf';
      exportFormatEl.disabled = true;
      exportPresetEl.value = '2-column';
      exportPresetEl.disabled = true;
      return;
    }

    exportFormatEl.disabled = false;
    exportPresetEl.disabled = false;
  }

  exportTargetEl.addEventListener('change', syncExportControls);
  syncExportControls();

  exportButtonEl.addEventListener('click', async () => {
    const target = exportTargetEl.value;
    const format = exportFormatEl.value;
    const preset = EXPORT_PRESETS[exportPresetEl.value];
    const dpi = Number(exportDpiEl instanceof HTMLSelectElement ? exportDpiEl.value : 300);
    const pathway = getCurrentPathway();
    if (!pathway) {
      return;
    }

    const previousExportButtonMarkup = exportButtonEl.innerHTML;
    exportButtonEl.disabled = true;
    exportButtonEl.setAttribute('aria-busy', 'true');
    exportButtonEl.innerHTML = '<span>Exporting...</span>';
    try {
      await exportFigure(pathway, target, format, preset, dpi);
    } catch (error) {
      console.error(error);
      window.alert(
        error instanceof Error
          ? `Figure export failed: ${error.message}`
          : 'Figure export failed due to an unknown error.',
      );
    } finally {
      exportButtonEl.disabled = false;
      exportButtonEl.setAttribute('aria-busy', 'false');
      exportButtonEl.innerHTML = previousExportButtonMarkup;
    }
  });

  heatmapButtonEl.addEventListener('click', async () => {
    const pathway = getCurrentPathway();
    if (!pathway) {
      return;
    }

    const previousMarkup = heatmapButtonEl.innerHTML;
    const wasDisabled = heatmapButtonEl.disabled;
    heatmapButtonEl.disabled = true;
    heatmapButtonEl.setAttribute('aria-busy', 'true');
    heatmapButtonEl.innerHTML = '<span>Preparing...</span>';
    try {
      await ensurePlotlyRuntimeLoaded();
      await openHeatmapFigureWindow(pathway);
    } catch (error) {
      console.error(error);
      window.alert(
        error instanceof Error
          ? `Heatmap generation failed: ${error.message}`
          : 'Heatmap generation failed due to an unknown error.',
      );
    } finally {
      heatmapButtonEl.setAttribute('aria-busy', 'false');
      heatmapButtonEl.innerHTML = previousMarkup;
      heatmapButtonEl.disabled = wasDisabled;
      updateHeatmapButtonState();
    }
  });

  renderPathwayList();
  renderCurrentPathway();
  updateHeatmapButtonState();

  function schedulePathwaySearchUpdate(nextSearch) {
    if (pathwaySearchTimerId !== null) {
      window.clearTimeout(pathwaySearchTimerId);
    }
    const delayMs = getPathwaySearchDebounceMs(nextSearch);
    pathwaySearchTimerId = window.setTimeout(() => {
      if (nextSearch === state.search) {
        pathwaySearchClearEl.hidden = !state.search;
        pathwaySearchTimerId = null;
        return;
      }
      state.search = nextSearch;
      invalidateFilteredPathwaysCache();
      pathwaySearchClearEl.hidden = !state.search;
      const pathwayChanged = renderPathwayList();
      if (pathwayChanged) {
        renderCurrentPathway();
      }
      pathwaySearchTimerId = null;
    }, delayMs);
  }

  function getPathwaySearchDebounceMs(query) {
    const normalizedQuery = String(query || '');
    if (!normalizedQuery) {
      return PATHWAY_SEARCH_BASE_DEBOUNCE_MS;
    }
    const corpusScale = Math.min(1.85, Math.max(1, allPathways.length / 1700));
    const queryLengthFactor = normalizedQuery.length >= 10 ? 0.72 : normalizedQuery.length >= 6 ? 0.86 : 1;
    const memoryFactor = DEVICE_MEMORY_GB <= 2 ? 1.32 : DEVICE_MEMORY_GB >= 8 ? 0.82 : 1;
    const estimated = Math.round(
      PATHWAY_SEARCH_BASE_DEBOUNCE_MS * corpusScale * queryLengthFactor * memoryFactor,
    );
    return clamp(estimated, PATHWAY_SEARCH_BASE_DEBOUNCE_MS, PATHWAY_SEARCH_MAX_DEBOUNCE_MS);
  }

  function getFilteredPathways() {
    if (filteredPathwaysCacheSearch === state.search && filteredPathwaysCache) {
      return filteredPathwaysCache;
    }

    const pathways = !state.search
      ? defaultPathways
      : pathwaySearchEngine.filter(state.search);
    filteredPathwaysCacheSearch = state.search;
    filteredPathwaysCache = pathways;
    return pathways;
  }

  function getPathwayGeneSet(pathway) {
    const cached = pathwayGeneSetCache.get(pathway.key);
    if (cached) {
      return cached;
    }
    const pathwayGeneSet = new Set(pathway.allGenes);
    setBoundedMapEntry(
      pathwayGeneSetCache,
      pathway.key,
      pathwayGeneSet,
      MAX_PATHWAY_GENE_SET_CACHE_ENTRIES,
    );
    return pathwayGeneSet;
  }

  function invalidateFilteredPathwaysCache() {
    filteredPathwaysCacheSearch = null;
    filteredPathwaysCache = null;
  }

  function withEnrichmentPoints(pathway) {
    if (!pathway) return pathway;
    if (enrichmentCache.has(pathway.key)) return enrichmentCache.get(pathway.key);
    const edges = pathway.edgeIndices ? pathway.edgeIndices.map(index => data.sharedEdges[index]) : pathway.edges;
    if (pathway.enrichment?.representation !== 'ranked-hits-v1') return { ...pathway, edges };
    const ranking = data.rankedGenes || [];
    const hits = new Set(pathway.enrichment.hitIndices);
    const total = [...hits].reduce((sum, index) => sum + Math.abs(ranking[index - 1]?.metric || 0), 0);
    const points = [];
    if (!pathway.enrichment.unavailableReason && hits.size > 0 && hits.size < ranking.length) {
      const miss = ranking.length === hits.size ? 0 : 1 / (ranking.length - hits.size);
      let running = 0;
      points.push({ index: 0, value: 0 });
      ranking.forEach((entry, index) => {
        const isHit = hits.has(index + 1);
        running += isHit ? (total ? Math.abs(entry.metric) / total : 1 / hits.size) : -miss;
        points.push({ index: index + 1, value: running, gene: entry.gene, isHit });
      });
    }
    const hydrated = { ...pathway, edges, enrichment: { ...pathway.enrichment, points } };
    if (enrichmentCache.size >= 3) enrichmentCache.delete(enrichmentCache.keys().next().value);
    enrichmentCache.set(pathway.key, hydrated);
    return hydrated;
  }

  function getCurrentPathway() {
    if (state.currentPathwayKey && pathwayByKey.has(state.currentPathwayKey)) {
      return withEnrichmentPoints(pathwayByKey.get(state.currentPathwayKey));
    }
    const filteredPathways = getFilteredPathways();
    return withEnrichmentPoints(filteredPathways[0] || defaultPathways[0] || allPathways[0] || null);
  }

  function getVisibleGeneIds(pathway) {
    return new Set(
      state.showAllGenes && !pathway.fallbackToLeadingEdge
        ? pathway.allGenes
        : pathway.leadingEdgeGenes.length
          ? pathway.leadingEdgeGenes
          : pathway.allGenes,
    );
  }

  function setHighlightedGenes(nextGeneIds) {
    state.highlightedGeneIds = Array.from(new Set((nextGeneIds || []).filter(Boolean)));
    highlightedGeneSet = new Set(state.highlightedGeneIds);
    updateHeatmapButtonState();
  }

  function updateHeatmapButtonState() {
    const pathway = getCurrentPathway();
    if (!pathway) {
      heatmapButtonEl.disabled = true;
      heatmapButtonEl.title = 'No pathway selected.';
      return;
    }

    const { nodeById } = getPathwayNodeLookup(pathway);
    const selectedGenes = state.highlightedGeneIds.filter((geneId) => {
      const gene = nodeById.get(geneId);
      return getGeneSampleValueCount(gene) >= 2;
    });
    const hasEnoughGenes = selectedGenes.length >= 2;
    heatmapButtonEl.disabled = !hasEnoughGenes;
    heatmapButtonEl.title = hasEnoughGenes
      ? `Generate clustered heatmap for ${selectedGenes.length} selected genes.`
      : 'Select at least 2 genes with Ctrl/Cmd-click (or Shift+drag) to enable heatmap.';
  }

  function getPathwayNodeLookup(pathway) {
    const cached = pathwayNodeLookupCache.get(pathway.key);
    if (cached) {
      return cached;
    }

    const nodeById = new Map(pathway.nodes.map((node) => [node.id, node]));
    const lookup = { nodeById };
    setBoundedMapEntry(
      pathwayNodeLookupCache,
      pathway.key,
      lookup,
      MAX_PATHWAY_NODE_LOOKUP_CACHE_ENTRIES,
    );
    return lookup;
  }

  function getGeneSampleValueCount(gene) {
    if (!gene || !gene.sampleValues) {
      return 0;
    }
    const cachedCount = geneSampleValueCountCache.get(gene);
    if (cachedCount !== undefined) {
      return cachedCount;
    }
    const count = Object.keys(gene.sampleValues).length;
    geneSampleValueCountCache.set(gene, count);
    return count;
  }

  function setTableSortCacheEntry(cacheKey, sortedGenes) {
    setBoundedMapEntry(tableSortCache, cacheKey, sortedGenes, MAX_TABLE_SORT_CACHE_ENTRIES);
  }

  function setNetworkViewCacheEntry(cacheKey, renderData) {
    setBoundedMapEntry(networkViewCache, cacheKey, renderData, MAX_NETWORK_VIEW_CACHE_ENTRIES);
  }

  function setGeneDetailSampleRowsCacheEntry(cacheKey, sampleRowsMarkup) {
    setBoundedMapEntry(
      geneDetailSampleRowsCache,
      cacheKey,
      sampleRowsMarkup,
      MAX_GENE_DETAIL_SAMPLE_CACHE_ENTRIES,
    );
  }

  function setBoundedMapEntry(map, key, value, maxEntries) {
    if (map.has(key)) {
      map.delete(key);
    } else if (map.size >= maxEntries) {
      const oldestKey = map.keys().next().value;
      if (oldestKey !== undefined) {
        map.delete(oldestKey);
      }
    }
    map.set(key, value);
  }

  function getLruMapEntry(map, key) {
    if (!map.has(key)) {
      return null;
    }
    const value = map.get(key);
    map.delete(key);
    map.set(key, value);
    return value;
  }

  function getPathwayRenderData(pathway) {
    const visibilityMode = state.showAllGenes && !pathway.fallbackToLeadingEdge ? 'all' : 'lead';
    const cacheKey = [
      pathway.key,
      visibilityMode,
      state.topGeneCount,
      state.ppiMode,
      state.edgeScoreMin,
      state.topEdgePercentile,
    ].join('::');
    const cached = getLruMapEntry(networkViewCache, cacheKey);
    if (cached) {
      return cached;
    }

    const renderPrep = getPathwayRenderPrep(pathway);
    const baseNodes =
      state.showAllGenes && !pathway.fallbackToLeadingEdge ? renderPrep.allNodes : renderPrep.leadingNodes;
    const visibleNodes =
      !state.topGeneCount || baseNodes.length <= state.topGeneCount
        ? baseNodes
        : baseNodes === renderPrep.allNodes
          ? renderPrep.allNodesSortedBySize.slice(0, state.topGeneCount)
          : renderPrep.leadingNodesSortedBySize.slice(0, state.topGeneCount);
    const visibleGeneIds = new Set(visibleNodes.map((node) => node.id));
    const baseEdges = renderPrep.edgesByMode[state.ppiMode] || renderPrep.edgesByMode.all;
    let visibleEdges = baseEdges.filter(
      (edge) =>
        visibleGeneIds.has(edge.source) &&
        visibleGeneIds.has(edge.target) &&
        Number(edge.score) >= state.edgeScoreMin,
    );
    if (state.topEdgePercentile < 100 && visibleEdges.length > 1) {
      const keepCount = Math.max(1, Math.ceil(visibleEdges.length * (state.topEdgePercentile / 100)));
      visibleEdges = visibleEdges.slice(0, keepCount);
    }

    const visibleNodeSignature = `${visibleNodes.length}::${visibleNodes.map((node) => node.id).join('|')}`;
    const labelCutoff = Math.max(12, Math.min(24, Math.round(visibleNodes.length * 0.42)));
    const labelIds = new Set(
      [...visibleNodes]
        .sort((left, right) => right.labelPriority - left.labelPriority || right.sizeMetric - left.sizeMetric)
        .slice(0, labelCutoff)
        .map((node) => node.id),
    );
    // Always keep leading-edge labels visible when a pathway is selected.
    visibleNodes.forEach((node) => {
      if (node.isLeadingEdge) {
        labelIds.add(node.id);
      }
    });

    const renderData = {
      visibleNodes,
      visibleEdges,
      visibleGeneIds,
      visibleNodeSignature,
      labelIds,
    };
    setNetworkViewCacheEntry(cacheKey, renderData);
    return renderData;
  }

  function sortNodesByVisualPriority(nodes) {
    return [...nodes].sort(
      (left, right) =>
        right.sizeMetric - left.sizeMetric ||
        right.labelPriority - left.labelPriority ||
        left.label.localeCompare(right.label),
    );
  }

  function sortEdgesByScore(edges) {
    return [...edges].sort((left, right) => Number(right.score) - Number(left.score));
  }

  function getPathwayRenderPrep(pathway) {
    const cached = getLruMapEntry(pathwayRenderPrepCache, pathway.key);
    if (cached) {
      return cached;
    }

    const leadingGeneIds = new Set(pathway.leadingEdgeGenes.length ? pathway.leadingEdgeGenes : pathway.allGenes);
    const allNodes = pathway.nodes;
    const leadingNodes = allNodes.filter((node) => leadingGeneIds.has(node.id));
    const allEdgesSorted = sortEdgesByScore(pathway.edges);
    const prep = {
      allNodes,
      leadingNodes: leadingNodes.length ? leadingNodes : allNodes,
      allNodesSortedBySize: sortNodesByVisualPriority(allNodes),
      leadingNodesSortedBySize: sortNodesByVisualPriority(leadingNodes.length ? leadingNodes : allNodes),
      edgesByMode: {
        all: allEdgesSorted,
        string: allEdgesSorted.filter((edge) => edge.isString),
        huri: allEdgesSorted.filter((edge) => edge.isHuRI),
        custom: allEdgesSorted.filter((edge) => edge.isCustom),
      },
    };
    setBoundedMapEntry(
      pathwayRenderPrepCache,
      pathway.key,
      prep,
      MAX_PATHWAY_RENDER_PREP_CACHE_ENTRIES,
    );
    return prep;
  }

  function createLayoutOptions(nodeCount) {
    const spacing = Math.min(1.85, 1.08 + nodeCount / 30);

    if (state.layoutMode === 'fcose') {
      return {
        name: 'fcose',
        quality: 'default',
        animate: true,
        animationDuration: PREFERS_REDUCED_MOTION ? 0 : 360,
        fit: true,
        randomize: true,
        padding: 68,
        nodeSeparation: 92 * spacing,
        nodeRepulsion: () => 14000 * spacing,
        idealEdgeLength: () => 130 * spacing,
        edgeElasticity: () => 0.28,
        nestingFactor: 0.75,
        gravity: 0.04,
        numIter: 2200,
        tile: true,
        nodeDimensionsIncludeLabels: true,
      };
    }

    if (state.layoutMode === 'elk-stress' || state.layoutMode === 'elk-force' || state.layoutMode === 'elk-layered') {
      const algorithm =
        state.layoutMode === 'elk-stress'
          ? 'stress'
          : state.layoutMode === 'elk-force'
            ? 'force'
            : 'layered';
      return {
        name: 'elk',
        animate: true,
        animationDuration: PREFERS_REDUCED_MOTION ? 0 : 320,
        fit: true,
        padding: 68,
        nodeDimensionsIncludeLabels: true,
        elk: {
          algorithm,
          'elk.spacing.nodeNode': Math.round(42 * spacing),
          'elk.spacing.edgeNode': 24,
          'elk.layered.spacing.nodeNodeBetweenLayers': Math.round(78 * spacing),
          'elk.direction': 'RIGHT',
        },
      };
    }

    if (state.layoutMode === 'circle') {
      return {
        name: 'circle',
        animate: true,
        animationDuration: PREFERS_REDUCED_MOTION ? 0 : 260,
        fit: true,
        padding: 72,
        spacingFactor: 1.35 * spacing,
      };
    }

    if (state.layoutMode === 'concentric') {
      return {
        name: 'concentric',
        animate: true,
        animationDuration: PREFERS_REDUCED_MOTION ? 0 : 260,
        fit: true,
        padding: 72,
        spacingFactor: 1.28 * spacing,
        concentric: (node) => node.data('sizeMetric'),
        levelWidth: () => 1.5,
      };
    }

    return {
      name: 'cose',
      animate: true,
      animationDuration: PREFERS_REDUCED_MOTION ? 0 : 340,
      fit: true,
      randomize: true,
      padding: 60,
      componentSpacing: 140,
      nodeOverlap: 12,
      nodeRepulsion: 1100000 * spacing,
      idealEdgeLength: 122 * spacing,
      edgeElasticity: 0.08,
      nestingFactor: 0.7,
      gravity: 0.08,
      numIter: 1400,
      initialTemp: 180,
      coolingFactor: 0.97,
      minTemp: 1.0,
    };
  }

  function renderPathwayList() {
    const previousPathwayKey = state.currentPathwayKey;
    const pathways = getFilteredPathways();
    const shouldResetVisibleWindow =
      lastRenderedPathwayListSearch !== state.search || lastRenderedPathwayListRef !== pathways;
    if (shouldResetVisibleWindow) {
      const searchBoost = state.search ? Math.floor(PATHWAY_LIST_INCREMENT * 0.6) : 0;
      pathwayListVisibleCount = Math.min(
        pathways.length,
        PATHWAY_LIST_INITIAL_VISIBLE + searchBoost,
      );
    }
    const hasCurrent = pathways.some((pathway) => pathway.key === state.currentPathwayKey);
    if (pathways.length && !hasCurrent) {
      state.currentPathwayKey = pathways[0]?.key || defaultPathways[0]?.key || allPathways[0]?.key || null;
    }
    const currentPathwayIndex = pathways.findIndex((pathway) => pathway.key === state.currentPathwayKey);
    if (currentPathwayIndex >= 0) {
      ensurePathwayListIncludesIndex(currentPathwayIndex, pathways.length);
    }
    pathwayCountEl.textContent = state.search
      ? `${pathways.length} matches / ${allPathways.length} total`
      : defaultPathways.length === allPathways.length
        ? `${pathways.length} shown`
        : `${pathways.length} significant shown / ${allPathways.length} total`;
    if (!pathways.length) {
      state.currentPathwayKey = null;
      const shouldRebuildEmptyState =
        lastRenderedPathwayListSearch !== state.search || lastRenderedPathwayListRef !== pathways;
      if (shouldRebuildEmptyState) {
        pathwayListEl.innerHTML = '<p class="pathway-list-empty">No pathways match this search.</p>';
        lastRenderedPathwayListSearch = state.search;
        lastRenderedPathwayListRef = pathways;
      }
      lastRenderedPathwayListActiveKey = null;
      lastRenderedPathwayListVisibleCount = 0;
      pathwayListFooterEl.hidden = true;
      return previousPathwayKey !== state.currentPathwayKey;
    }

    const visiblePathways = pathways.slice(0, pathwayListVisibleCount);
    const shouldRebuildList =
      lastRenderedPathwayListSearch !== state.search ||
      lastRenderedPathwayListRef !== pathways ||
      lastRenderedPathwayListVisibleCount !== pathwayListVisibleCount;
    if (shouldRebuildList) {
      rebuildPathwayListButtons(visiblePathways);
      lastRenderedPathwayListSearch = state.search;
      lastRenderedPathwayListRef = pathways;
      lastRenderedPathwayListActiveKey = state.currentPathwayKey;
      lastRenderedPathwayListVisibleCount = pathwayListVisibleCount;
    } else if (lastRenderedPathwayListActiveKey !== state.currentPathwayKey) {
      syncPathwayListActiveState();
    }
    updatePathwayListFooter(pathways.length);
    return previousPathwayKey !== state.currentPathwayKey;
  }

  function expandPathwayListVisibleCount(totalCount) {
    const normalizedTotalCount = Math.max(0, Number(totalCount) || 0);
    if (pathwayListVisibleCount >= normalizedTotalCount) {
      return false;
    }
    pathwayListVisibleCount = Math.min(
      normalizedTotalCount,
      pathwayListVisibleCount + PATHWAY_LIST_INCREMENT,
    );
    return true;
  }

  function ensurePathwayListIncludesIndex(targetIndex, totalCount) {
    if (!Number.isFinite(targetIndex) || targetIndex < 0) {
      return;
    }
    const normalizedTotalCount = Math.max(0, Number(totalCount) || 0);
    if (!normalizedTotalCount) {
      return;
    }
    while (targetIndex >= pathwayListVisibleCount && pathwayListVisibleCount < normalizedTotalCount) {
      if (!expandPathwayListVisibleCount(normalizedTotalCount)) {
        break;
      }
    }
  }

  function updatePathwayListFooter(totalCount) {
    const normalizedTotalCount = Math.max(0, Number(totalCount) || 0);
    const visibleCount = Math.min(pathwayListVisibleCount, normalizedTotalCount);
    const hasMore = visibleCount < normalizedTotalCount;
    pathwayListFooterEl.hidden = !normalizedTotalCount;
    if (!normalizedTotalCount) {
      pathwayListProgressEl.textContent = '';
      pathwayListMoreButtonEl.hidden = true;
      return;
    }
    pathwayListProgressEl.textContent = `${visibleCount} / ${normalizedTotalCount} rendered`;
    pathwayListMoreButtonEl.hidden = !hasMore;
    if (hasMore) {
      const nextCount = Math.min(PATHWAY_LIST_INCREMENT, normalizedTotalCount - visibleCount);
      pathwayListMoreButtonEl.textContent = `Load ${nextCount} more`;
      pathwayListMoreButtonEl.setAttribute('aria-label', `Load ${nextCount} more pathways`);
    } else {
      pathwayListMoreButtonEl.textContent = 'All pathways loaded';
      pathwayListMoreButtonEl.setAttribute('aria-label', 'All pathways loaded');
    }
  }

  function syncPathwayListActiveState() {
    const buttons = pathwayListEl.querySelectorAll('[data-pathway-key]');
    buttons.forEach((button) => {
      if (!(button instanceof HTMLElement)) {
        return;
      }
      const pathwayKey = button.getAttribute('data-pathway-key');
      const isActive = pathwayKey === state.currentPathwayKey;
      button.classList.toggle('active', isActive);
      button.setAttribute('aria-current', isActive ? 'true' : 'false');
      button.setAttribute('aria-selected', isActive ? 'true' : 'false');
      button.tabIndex = isActive ? 0 : -1;
    });
    lastRenderedPathwayListActiveKey = state.currentPathwayKey;
  }

  function createPathwayButton(pathway, isActive) {
    const button = document.createElement('button');
    button.className = `pathway-button ${isActive ? 'active' : ''}`;
    button.setAttribute('data-pathway-key', pathway.key);
    button.setAttribute('role', 'option');
    button.setAttribute('aria-current', isActive ? 'true' : 'false');
    button.setAttribute('aria-selected', isActive ? 'true' : 'false');
    button.tabIndex = isActive ? 0 : -1;

    const title = document.createElement('strong');
    title.textContent = pathway.pathwayName;
    button.appendChild(title);
    button.appendChild(document.createElement('br'));

    const summary = document.createElement('small');
    summary.textContent =
      `${pathway.collection} · NES ${formatNumber(pathway.nes)} · FDR ${formatSci(pathway.padj)}`;
    button.appendChild(summary);

    return button;
  }

  function rebuildPathwayListButtons(pathways) {
    pathwayListEl.innerHTML = '';
    if (pathwayListRenderFrameId !== null) {
      window.cancelAnimationFrame(pathwayListRenderFrameId);
      pathwayListRenderFrameId = null;
    }
    pathwayListRenderToken += 1;
    const renderToken = pathwayListRenderToken;

    const appendRange = (startIndex) => {
      if (renderToken !== pathwayListRenderToken) {
        return;
      }
      const fragment = document.createDocumentFragment();
      const endIndex = Math.min(startIndex + PATHWAY_LIST_RENDER_BATCH_SIZE, pathways.length);
      for (let index = startIndex; index < endIndex; index += 1) {
        const pathway = pathways[index];
        if (!pathway) {
          continue;
        }
        fragment.appendChild(createPathwayButton(pathway, pathway.key === state.currentPathwayKey));
      }
      pathwayListEl.appendChild(fragment);
      if (endIndex < pathways.length) {
        pathwayListRenderFrameId = window.requestAnimationFrame(() => appendRange(endIndex));
      } else {
        pathwayListRenderFrameId = null;
      }
    };

    appendRange(0);
  }

  function selectPathway(pathwayKey) {
    if (!pathwayKey || pathwayKey === state.currentPathwayKey) {
      return;
    }
    state.currentPathwayKey = pathwayKey;
    state.tablePage = 1;
    renderPathwayList();
    renderCurrentPathway();
  }

  function renderCurrentPathway() {
    const pathway = getCurrentPathway();
    if (!pathway) {
      document.getElementById('pathway-evidence').textContent = '';
      lastRenderedPathwayKey = null;
      lastRenderedLayoutMode = null;
      lastRenderedNodeSignature = '';
      lastLabelLayoutSignature = '';
      lastPlottedPathwayKey = null;
      state.selectedGeneId = null;
      setHighlightedGenes([]);
      lastAppliedHighlightedGeneSet = new Set();
      lastAppliedSelectedGeneId = null;
      currentPathwayNameEl.textContent = state.search
        ? 'No pathways match your search'
        : 'No pathway available';
      currentPathwaySummaryEl.textContent = state.search
        ? 'Try a broader search term to restore pathway results.'
        : 'No pathways were tested or supplied. No significance was inferred.';
      plotCaptionEl.textContent = 'No enrichment plot to render';
      toggleAllGenesEl.checked = false;
      toggleAllGenesEl.disabled = true;
      exportButtonEl.disabled = true;
      cy.elements().remove();
      const plotContainer = document.getElementById('plot-container');
      if (plotContainer) {
        plotContainer.innerHTML = '';
      }
      renderGeneDetail(null, null);
      renderGeneTable(null);
      lastRenderedGeneTableSignature = '';
      lastRenderedGeneTableActiveGeneId = null;
      lastRenderedGeneTableHighlightedSignature = '';
      updateHeatmapButtonState();
      return;
    }
    exportButtonEl.disabled = false;

    if (pathway.fallbackToLeadingEdge) {
      state.showAllGenes = false;
    }

    toggleAllGenesEl.checked = state.showAllGenes && !pathway.fallbackToLeadingEdge;
    toggleAllGenesEl.disabled = pathway.fallbackToLeadingEdge;

    const renderData = getPathwayRenderData(pathway);
    const { visibleNodes, visibleGeneIds, visibleEdges, visibleNodeSignature, labelIds } = renderData;
    setHighlightedGenes(state.highlightedGeneIds.filter((geneId) => visibleGeneIds.has(geneId)));

    renderPathwayEvidence(pathway);
    currentPathwayNameEl.textContent = pathway.pathwayName;
    currentPathwaySummaryEl.textContent = `${pathway.collection} · NES ${formatNumber(pathway.nes)} · FDR ${formatSci(pathway.padj)} · ${visibleNodes.length}/${pathway.allGenes.length} genes · ${visibleEdges.length} edges`;
    const exactMembership = pathway.enrichment?.validation === 'matches_recorded_es' || Boolean((evidence.pathways?.[pathway.pathwayId]?.testedGenes || evidence.pathways?.[pathway.key]?.testedGenes));
    document.getElementById('toggle-all-genes-label').textContent = exactMembership ? 'Show all tested pathway genes' : 'Show supplied/reference pathway genes';
    plotCaptionEl.textContent = exactMembership ? (pathway.enrichment.validation === 'matches_recorded_es' ? 'Exact tested membership; ES matches recorded R result' : 'Exact tested membership; original ES unavailable') : 'Reconstructed view; original tested membership was not supplied';
    const canReusePositions =
      pathway.key === lastRenderedPathwayKey &&
      state.layoutMode === lastRenderedLayoutMode &&
      visibleNodeSignature === lastRenderedNodeSignature;
    const previousNodePositions = canReusePositions
      ? new Map(cy.nodes().map((node) => [node.id(), node.position()]))
      : null;
    const pathwayGeneIds = getPathwayGeneSet(pathway);
    const elements = [
      ...visibleNodes.map((node) => ({
        data: {
          ...node,
          preferredLabel: labelIds.has(node.id) ? node.label : '',
          displayLabel: '',
          fillColor: colorForPathwayMembership(node, pathwayGeneIds),
          borderColor: node.isLeadingEdge ? '#102039' : 'rgba(98, 118, 162, 0.28)',
          borderWidth: node.isLeadingEdge ? 2.8 : 1.2,
          renderSize: (18 + node.sizeMetric * 2.35) * state.nodeSizeScale,
        },
        ...(previousNodePositions?.has(node.id) ? { position: previousNodePositions.get(node.id) } : {}),
      })),
      ...visibleEdges.map((edge) => ({
          data: {
            ...edge,
            renderWidth: 1.3 + (edge.score / 1000) * 5.5,
            opacity: Math.min(0.84, 0.16 + edge.score / 1200),
            lineColor: edge.isCustom
              ? 'rgba(67, 92, 235, 0.7)'
              : edge.isHuRI && !edge.isString
                ? 'rgba(25, 128, 104, 0.65)'
                : edge.isHuRI && edge.isString
                  ? 'rgba(52, 111, 202, 0.68)'
                  : 'rgba(126, 144, 182, 0.48)',
          },
        })),
    ];

    lastLabelLayoutSignature = '';
    lastAppliedHighlightedGeneSet = new Set();
    lastAppliedSelectedGeneId = null;
    cy.elements().remove();
    cy.add(elements);
    const layout = canReusePositions
      ? cy.layout({
          name: 'preset',
          fit: false,
          animate: false,
          padding: 0,
        })
      : cy.layout(createLayoutOptions(visibleNodes.length));
    lastRenderedPathwayKey = pathway.key;
    lastRenderedLayoutMode = state.layoutMode;
    lastRenderedNodeSignature = visibleNodeSignature;
    layout.one('layoutstop', () => {
      if (state.pendingFocusGeneId) {
        focusGeneInNetwork(state.pendingFocusGeneId);
        state.pendingFocusGeneId = null;
        scheduleLabelCollisionAvoidance(true);
        return;
      }
      applyGeneHighlightState();
      scheduleLabelCollisionAvoidance(true);
    });
    layout.run();

    if (pathway.key !== lastPlottedPathwayKey) {
      renderPlot(pathway);
      lastPlottedPathwayKey = pathway.key;
    }

    const fallbackGene =
      (state.selectedGeneId && visibleGeneIds.has(state.selectedGeneId) && state.selectedGeneId) ||
      state.highlightedGeneIds[state.highlightedGeneIds.length - 1] ||
      (visibleNodes[0]?.id || pathway.leadingEdgeGenes[0] || null);
    state.selectedGeneId = fallbackGene;
    renderGeneDetail(pathway, fallbackGene);
    renderGeneTable(pathway);
  }

  function renderPlot(pathway) {
    const plotContainer = document.getElementById('plot-container');
    if (!plotContainer) {
      return;
    }
    const width = Math.max(260, Math.round(plotContainer.clientWidth || 680));
    const height = Math.max(300, Math.round(plotContainer.clientHeight || 340));
    plotContainer.innerHTML = buildEnrichmentPlotSvg(pathway, {
      width,
      height,
      showFrame: false,
    });
  }

  function renderGeneDetail(pathway, geneId) {
    if (!pathway) {
      detailCaptionEl.textContent = 'No gene selected';
      updateFocusedGeneChip(null);
      geneDetailEl.className = 'empty-card';
      geneDetailEl.textContent = 'Select a pathway to inspect gene-level details.';
      return;
    }

    detailCaptionEl.textContent = geneId ? geneId : 'No gene selected';
    if (!geneId) {
      updateFocusedGeneChip(null);
      geneDetailEl.className = 'empty-card';
      geneDetailEl.textContent = 'Click a gene node to see expression, DEG statistics, and membership details.';
      return;
    }

    const { nodeById } = getPathwayNodeLookup(pathway);
    const gene = nodeById.get(geneId);
    if (!gene) {
      updateFocusedGeneChip(null);
      geneDetailEl.className = 'empty-card';
      geneDetailEl.textContent = 'Selected gene is not visible in the current pathway view.';
      return;
    }
    updateFocusedGeneChip(gene);

    const sampleRows = getGeneDetailSampleRows(pathway.key, gene);

    geneDetailEl.className = '';
    geneDetailEl.innerHTML = `
      <strong>${escapeHtml(gene.label)}</strong>
      ${fullEvidence ? geneEvidenceMarkup(gene) : ''}
      <div class="detail-grid">
        <div class="detail-card">
          <small>log2FC</small>
          <div><strong>${formatNumber(gene.log2fc)}</strong></div>
        </div>
        <div class="detail-card">
          <small>FDR</small>
          <div><strong>${formatSci(gene.padj)}</strong></div>
        </div>
        <div class="detail-card">
          <small>${escapeHtml(data.project.conditionA)} mean</small>
          <div><strong>${formatNumber(gene.conditionAMean)}</strong></div>
        </div>
        <div class="detail-card">
          <small>${escapeHtml(data.project.conditionB)} mean</small>
          <div><strong>${formatNumber(gene.conditionBMean)}</strong></div>
        </div>
      </div>
      <div class="mini-table">
        <div class="mini-row">
          <span>Leading edge</span>
          <strong>${gene.isLeadingEdge ? 'Yes' : 'No'}</strong>
        </div>
        <div class="mini-row">
          <span>P value</span>
          <strong>${formatSci(gene.pvalue)}</strong>
        </div>
        <div class="mini-row">
          <span>Visible network</span>
          <strong>${state.showAllGenes && !pathway.fallbackToLeadingEdge ? ((evidence.pathways?.[pathway.pathwayId]?.testedGenes || evidence.pathways?.[pathway.key]?.testedGenes) ? 'All tested pathway genes' : 'Supplied/reference genes') : 'Leading edge'}</strong>
        </div>
      </div>
      ${
        sampleRows
          ? `<div class="mini-table" style="margin-top:12px">${sampleRows}</div>`
          : ''
      }
    `;
  }

  function renderGeneTable(pathway) {
    if (!pathway) {
      geneTableEl.innerHTML = '';
      geneTableCaptionEl.textContent = '';
      lastRenderedGeneTableSignature = '';
      lastRenderedGeneTableActiveGeneId = null;
      lastRenderedGeneTableHighlightedSignature = '';
      return;
    }

    const pageSize = 20;
    const sortedGenes = getSortedTableGenes(pathway);
    const totalPages = Math.max(1, Math.ceil(sortedGenes.length / pageSize));
    state.tablePage = Math.min(Math.max(1, state.tablePage), totalPages);
    const startIndex = (state.tablePage - 1) * pageSize;
    const pageGenes = sortedGenes.slice(startIndex, startIndex + pageSize);
    const highlightedSignature = state.highlightedGeneIds.join('|');
    const tableSignature = [
      pathway.key,
      pathway.fallbackToLeadingEdge ? 'lead' : 'all',
      state.tableSortKey,
      state.tableSortDir,
      state.tablePage,
    ].join('::');
    geneTableCaptionEl.textContent = `${sortedGenes.length} genes · page ${state.tablePage}/${totalPages} · click gene to focus`;

    if (lastRenderedGeneTableSignature === tableSignature) {
      syncGeneTableActiveState();
      lastRenderedGeneTableActiveGeneId = state.selectedGeneId;
      lastRenderedGeneTableHighlightedSignature = highlightedSignature;
      return;
    }

    geneTableEl.innerHTML = `
      <table class="gene-table">
        <thead>
          <tr>
            ${renderSortHeader('label', 'Gene')}
            ${renderSortHeader('isLeadingEdge', 'Lead')}
            ${renderSortHeader('log2fc', 'log2FC')}
            ${renderSortHeader('padj', 'FDR')}
            ${renderSortHeader('pvalue', 'P')}
            ${renderSortHeader('conditionAMean', shortLabel(data.project.conditionA))}
            ${renderSortHeader('conditionBMean', shortLabel(data.project.conditionB))}
          </tr>
        </thead>
        <tbody>
          ${pageGenes
            .map((gene) => {
              const rowClass = [
                'gene-table-row',
                gene.id === state.selectedGeneId ? 'active' : '',
                gene.id !== state.selectedGeneId && highlightedGeneSet.has(gene.id) ? 'highlighted' : '',
                gene.isLeadingEdge ? 'leading-edge' : '',
              ]
                .filter(Boolean)
                .join(' ');
              return `
                <tr class="${rowClass}" data-gene-row-id="${escapeHtml(gene.id)}">
                  <td>
                    <button class="gene-link" data-gene-id="${escapeHtml(gene.id)}">${escapeHtml(gene.label)}</button>
                  </td>
                  <td><span class="gene-chip ${gene.isLeadingEdge ? 'active' : ''}">${gene.isLeadingEdge ? 'Yes' : 'No'}</span></td>
                  <td>${formatSignedNumber(gene.log2fc)}</td>
                  <td>${formatSci(gene.padj)}</td>
                  <td>${formatSci(gene.pvalue)}</td>
                  <td>${formatNumber(gene.conditionAMean)}</td>
                  <td>${formatNumber(gene.conditionBMean)}</td>
                </tr>
              `;
            })
            .join('')}
        </tbody>
      </table>
      <div class="table-pagination">
        <button class="page-button" data-page="${Math.max(1, state.tablePage - 1)}" ${state.tablePage === 1 ? 'disabled' : ''}>Prev</button>
        ${renderPageButtons(totalPages)}
        <button class="page-button" data-page="${Math.min(totalPages, state.tablePage + 1)}" ${state.tablePage === totalPages ? 'disabled' : ''}>Next</button>
      </div>
    `;
    lastRenderedGeneTableSignature = tableSignature;
    lastRenderedGeneTableActiveGeneId = state.selectedGeneId;
    lastRenderedGeneTableHighlightedSignature = highlightedSignature;
  }

  function syncGeneTableActiveState() {
    const nextActiveGeneId = state.selectedGeneId || null;
    const nextHighlighted = new Set(state.highlightedGeneIds);
    const nextHighlightedSignature = state.highlightedGeneIds.join('|');
    if (
      lastRenderedGeneTableActiveGeneId === nextActiveGeneId &&
      lastRenderedGeneTableHighlightedSignature === nextHighlightedSignature
    ) {
      return;
    }

    const rows = geneTableEl.querySelectorAll('[data-gene-row-id]');
    rows.forEach((row) => {
      if (!(row instanceof HTMLElement)) {
        return;
      }
      const geneId = row.getAttribute('data-gene-row-id');
      if (!geneId) {
        return;
      }
      const isActive = geneId === nextActiveGeneId;
      const isHighlighted = !isActive && nextHighlighted.has(geneId);
      row.classList.toggle('active', isActive);
      row.classList.toggle('highlighted', isHighlighted);
    });
    lastRenderedGeneTableActiveGeneId = nextActiveGeneId;
    lastRenderedGeneTableHighlightedSignature = nextHighlightedSignature;
  }

  function renderSortHeader(key, label) {
    const arrow =
      state.tableSortKey === key
        ? state.tableSortDir === 'asc'
          ? ' ↑'
          : ' ↓'
        : '';
    return `
      <th>
        <button class="sort-button" data-sort-key="${escapeHtml(key)}">${escapeHtml(label)}${arrow}</button>
      </th>
    `;
  }

  function renderPageButtons(totalPages) {
    const pages = [];
    const pageWindow = 5;
    const startPage = Math.max(1, Math.min(state.tablePage - 2, totalPages - pageWindow + 1));
    const endPage = Math.min(totalPages, startPage + pageWindow - 1);

    for (let page = startPage; page <= endPage; page += 1) {
      pages.push(
        `<button class="page-button ${page === state.tablePage ? 'active' : ''}" data-page="${page}">${page}</button>`,
      );
    }

    return pages.join('');
  }

  function getSortedTableGenes(pathway) {
    const cacheKey = `${pathway.key}::${pathway.fallbackToLeadingEdge ? 'lead' : 'all'}::${state.tableSortKey}::${state.tableSortDir}`;
    const cached = getLruMapEntry(tableSortCache, cacheKey);
    if (cached) {
      return cached;
    }

    const tableGenes = (pathway.fallbackToLeadingEdge
      ? pathway.nodes.filter((node) => node.isLeadingEdge)
      : pathway.nodes
    ).slice();
    const sorted = sortGenes(tableGenes);
    setTableSortCacheEntry(cacheKey, sorted);
    return sorted;
  }

  function getGeneDetailSampleRows(pathwayKey, gene) {
    if (!gene || !gene.sampleValues) {
      return '';
    }
    const cacheKey = `${pathwayKey}::${gene.id}`;
    const cached = getLruMapEntry(geneDetailSampleRowsCache, cacheKey);
    if (cached !== null) {
      return cached;
    }
    const sampleRowsMarkup = Object.entries(gene.sampleValues)
      .sort((left, right) => left[0].localeCompare(right[0]))
      .slice(0, 12)
      .map(
        ([name, value]) => `
          <div class="mini-row">
            <span>${escapeHtml(name)}</span>
            <strong>${formatNumber(value)}</strong>
          </div>
        `,
      )
      .join('');
    setGeneDetailSampleRowsCacheEntry(cacheKey, sampleRowsMarkup);
    return sampleRowsMarkup;
  }

  function sortGenes(genes) {
    const direction = state.tableSortDir === 'asc' ? 1 : -1;
    return genes.sort((left, right) => {
      const key = state.tableSortKey;
      let result = 0;
      if (key === 'label') {
        result = left.label.localeCompare(right.label);
      } else if (key === 'isLeadingEdge') {
        result = Number(left.isLeadingEdge) - Number(right.isLeadingEdge);
      } else {
        const leftValue = nullableNumber(left[key]), rightValue = nullableNumber(right[key]);
        if (leftValue === null || rightValue === null) {
          if (leftValue !== rightValue) return leftValue === null ? 1 : -1;
        } else result = leftValue - rightValue;
      }

      if (result === 0) {
        result = left.label.localeCompare(right.label);
      }
      return result * direction;
    });
  }

  function focusPathwayGene(geneId) {
    const pathway = getCurrentPathway();
    if (!pathway) {
      return;
    }
    scrollNetworkIntoView();

    const visibleGeneIds = getVisibleGeneIds(pathway);
    const { visibleGeneIds: visibleNetworkGeneIds } = getPathwayRenderData(pathway);
    state.selectedGeneId = geneId;
    setHighlightedGenes([geneId]);

    if (!visibleGeneIds.has(geneId) && !pathway.fallbackToLeadingEdge) {
      state.showAllGenes = true;
      toggleAllGenesEl.checked = true;
      scheduleSavePreferences();
    }

    if (!visibleNetworkGeneIds.has(geneId)) {
      state.topGeneCount = 0;
      topGenesEl.value = '0';
      scheduleSavePreferences();
    }

    if (!visibleGeneIds.has(geneId) || !visibleNetworkGeneIds.has(geneId)) {
      state.pendingFocusGeneId = geneId;
      renderCurrentPathway();
      return;
    }

    renderGeneDetail(pathway, geneId);
    renderGeneTable(pathway);
    focusGeneInNetwork(geneId);
  }

  function handleNodeInteraction(event) {
    const geneId = event.target.id();
    const isModifierGesture = isModifierHighlightEvent(event);
    if (event.type === 'cxttap' && !isModifierGesture) {
      return;
    }

    if (isModifierGesture) {
      const highlighted = new Set(state.highlightedGeneIds);
      if (highlighted.has(geneId)) {
        highlighted.delete(geneId);
      } else {
        highlighted.add(geneId);
      }
      setHighlightedGenes([...highlighted]);
      state.selectedGeneId = state.highlightedGeneIds.includes(geneId)
        ? geneId
        : state.highlightedGeneIds[state.highlightedGeneIds.length - 1] || null;
    } else {
      state.selectedGeneId = geneId;
      setHighlightedGenes([geneId]);
    }

    renderGeneDetail(getCurrentPathway(), state.selectedGeneId);
    renderGeneTable(getCurrentPathway());
    if (state.selectedGeneId) {
      focusGeneInNetwork(state.selectedGeneId);
      return;
    }
    applyGeneHighlightState();
    scheduleLabelCollisionAvoidance(true);
  }

  function escapeCss(value) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value);
    }
    return String(value).replace(/[^a-zA-Z0-9_-]/g, (char) => `\\${char}`);
  }

  function handleBoxSelection() {
    const selectedIds = cy.$(':selected').nodes().map((node) => node.id());
    const baselineIds = new Set(boxSelectionBaselineIds);
    const boxedGeneIds = selectedIds.filter((geneId) => !baselineIds.has(geneId));
    if (!boxedGeneIds.length) {
      applyGeneHighlightState();
      scheduleLabelCollisionAvoidance(true);
      return;
    }

    const highlighted = new Set(state.highlightedGeneIds);
    boxedGeneIds.forEach((geneId) => highlighted.add(geneId));
    setHighlightedGenes([...highlighted]);
    state.selectedGeneId = boxedGeneIds[boxedGeneIds.length - 1];
    renderGeneDetail(getCurrentPathway(), state.selectedGeneId);
    renderGeneTable(getCurrentPathway());
    applyGeneHighlightState();
    scheduleLabelCollisionAvoidance(true);
  }

  function isModifierHighlightEvent(event) {
    const originalEvent = event.originalEvent || {};
    return Boolean(originalEvent.ctrlKey || originalEvent.metaKey || originalEvent.shiftKey);
  }

  function isHighlightedGene(geneId) {
    return highlightedGeneSet.has(geneId);
  }

  function setNodeDisplayLabel(node, nextLabel) {
    const currentLabel = node.data('displayLabel');
    if (currentLabel !== nextLabel) {
      node.data('displayLabel', nextLabel);
    }
  }

  function applyGeneHighlightState() {
    const nextHighlightedGeneSet = new Set(state.highlightedGeneIds);
    const nextSelectedGeneId = state.selectedGeneId || null;
    cy.batch(() => {
      lastAppliedHighlightedGeneSet.forEach((geneId) => {
        if (nextHighlightedGeneSet.has(geneId)) {
          return;
        }
        const node = cy.getElementById(geneId);
        if (node && node.length) {
          node.removeClass('highlighted-node');
        }
      });
      nextHighlightedGeneSet.forEach((geneId) => {
        if (lastAppliedHighlightedGeneSet.has(geneId)) {
          return;
        }
        const node = cy.getElementById(geneId);
        if (node && node.length) {
          node.addClass('highlighted-node');
        }
      });

      if (lastAppliedSelectedGeneId && lastAppliedSelectedGeneId !== nextSelectedGeneId) {
        const previousSelectedNode = cy.getElementById(lastAppliedSelectedGeneId);
        if (previousSelectedNode && previousSelectedNode.length) {
          previousSelectedNode.unselect();
        }
      }
      if (nextSelectedGeneId) {
        const nextSelectedNode = cy.getElementById(nextSelectedGeneId);
        if (nextSelectedNode && nextSelectedNode.length) {
          cy.$(':selected')
            .nodes()
            .forEach((node) => {
              if (node.id() !== nextSelectedGeneId) {
                node.unselect();
              }
            });
          nextSelectedNode.select();
        } else {
          cy.$(':selected').unselect();
        }
      } else {
        cy.$(':selected').unselect();
      }
    });
    lastAppliedHighlightedGeneSet = nextHighlightedGeneSet;
    lastAppliedSelectedGeneId = nextSelectedGeneId;
  }

  function focusGeneInNetwork(geneId) {
    const node = cy.getElementById(geneId);
    if (!node || !node.length) {
      return;
    }

    applyGeneHighlightState();
    scheduleLabelCollisionAvoidance(true);
    cy.animate({
      center: {
        eles: node,
      },
      zoom: Math.max(cy.zoom(), 1.85),
      duration: PREFERS_REDUCED_MOTION ? 0 : 480,
      easing: 'ease-in-out',
    });
  }

  function adjustZoom(factor) {
    const currentZoom = cy.zoom();
    const nextZoom = Math.max(cy.minZoom(), Math.min(cy.maxZoom(), currentZoom * factor));
    cy.animate({
      zoom: nextZoom,
      renderedPosition: {
        x: cy.width() / 2,
        y: cy.height() / 2,
      },
      duration: PREFERS_REDUCED_MOTION ? 0 : 140,
      easing: 'ease-out',
    });
  }

  function updateFocusedGeneChip(gene) {
    if (!gene) {
      focusedGeneChipEl.hidden = true;
      focusedGeneChipEl.textContent = '';
      return;
    }

    focusedGeneChipEl.hidden = false;
    focusedGeneChipEl.textContent = `Focused gene: ${gene.label}`;
  }

  function scrollNetworkIntoView() {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight || 0;
    const panelBounds = networkPanelEl.getBoundingClientRect();
    const alreadyInViewport = panelBounds.top >= 0 && panelBounds.bottom <= viewportHeight;
    if (alreadyInViewport) {
      return;
    }
    networkPanelEl.scrollIntoView({
      behavior: PREFERS_REDUCED_MOTION ? 'auto' : 'smooth',
      block: 'start',
      inline: 'nearest',
    });
  }

  function applyLabelCollisionAvoidance() {
    const pan = cy.pan();
    const nextLabelLayoutSignature = [
      state.currentPathwayKey || '',
      lastRenderedNodeSignature,
      state.selectedGeneId || '',
      state.highlightedGeneIds.join('|'),
      Math.round(cy.zoom() * 1000),
      Math.round(pan.x),
      Math.round(pan.y),
    ].join('::');
    if (nextLabelLayoutSignature === lastLabelLayoutSignature) {
      return;
    }
    lastLabelLayoutSignature = nextLabelLayoutSignature;

    const occupied = [];
    const occupiedBuckets = new Map();
    const bucketKey = (x, y) => `${x},${y}`;
    const addRectToBuckets = (rect) => {
      const xStart = Math.floor(rect.x1 / LABEL_BUCKET_SIZE);
      const xEnd = Math.floor(rect.x2 / LABEL_BUCKET_SIZE);
      const yStart = Math.floor(rect.y1 / LABEL_BUCKET_SIZE);
      const yEnd = Math.floor(rect.y2 / LABEL_BUCKET_SIZE);
      for (let x = xStart; x <= xEnd; x += 1) {
        for (let y = yStart; y <= yEnd; y += 1) {
          const key = bucketKey(x, y);
          const bucket = occupiedBuckets.get(key);
          if (bucket) {
            bucket.push(rect);
          } else {
            occupiedBuckets.set(key, [rect]);
          }
        }
      }
    };
    const getNearbyRects = (rect) => {
      const xStart = Math.floor(rect.x1 / LABEL_BUCKET_SIZE);
      const xEnd = Math.floor(rect.x2 / LABEL_BUCKET_SIZE);
      const yStart = Math.floor(rect.y1 / LABEL_BUCKET_SIZE);
      const yEnd = Math.floor(rect.y2 / LABEL_BUCKET_SIZE);
      const seen = new Set();
      const nearby = [];
      for (let x = xStart; x <= xEnd; x += 1) {
        for (let y = yStart; y <= yEnd; y += 1) {
          const key = bucketKey(x, y);
          const bucket = occupiedBuckets.get(key);
          if (!bucket) {
            continue;
          }
          bucket.forEach((candidateRect) => {
            if (seen.has(candidateRect)) {
              return;
            }
            seen.add(candidateRect);
            nearby.push(candidateRect);
          });
        }
      }
      return nearby.length ? nearby : occupied;
    };
    const nodes = cy
      .nodes()
      .filter((node) => {
        if (node.id() === state.selectedGeneId || isHighlightedGene(node.id())) {
          return true;
        }
        return Boolean(node.data('preferredLabel'));
      })
      .toArray()
      .sort((left, right) => {
        const leftSelected = left.id() === state.selectedGeneId ? 1 : 0;
        const rightSelected = right.id() === state.selectedGeneId ? 1 : 0;
        const leftHighlighted = isHighlightedGene(left.id()) ? 1 : 0;
        const rightHighlighted = isHighlightedGene(right.id()) ? 1 : 0;
        return (
          rightSelected - leftSelected ||
          rightHighlighted - leftHighlighted ||
          Number(right.data('isLeadingEdge')) - Number(left.data('isLeadingEdge')) ||
          Number(right.data('labelPriority')) - Number(left.data('labelPriority')) ||
          Number(right.data('sizeMetric')) - Number(left.data('sizeMetric'))
        );
      });

    if (nodes.length > LABEL_COLLISION_NODE_HARD_LIMIT) {
      cy.batch(() => {
        nodes.forEach((node) => {
          const isSelected = node.id() === state.selectedGeneId;
          const isHighlighted = isHighlightedGene(node.id());
          const isLeadingEdge = Boolean(node.data('isLeadingEdge'));
          const preferredLabel =
            isSelected || isHighlighted
              ? node.data('label') || node.data('preferredLabel')
              : node.data('preferredLabel');
          if (isSelected || isHighlighted || isLeadingEdge) {
            setNodeDisplayLabel(node, preferredLabel || '');
            return;
          }
          setNodeDisplayLabel(node, '');
        });
      });
      return;
    }

    nodes.forEach((node) => {
      const isHighlighted = isHighlightedGene(node.id());
      const isLeadingEdge = Boolean(node.data('isLeadingEdge'));
      const preferredLabel =
        node.id() === state.selectedGeneId || isHighlighted
          ? node.data('label') || node.data('preferredLabel')
          : node.data('preferredLabel');
      if (!preferredLabel) {
        setNodeDisplayLabel(node, '');
        return;
      }

      const position = node.renderedPosition();
      const radius = Math.max(node.renderedOuterWidth(), node.renderedOuterHeight()) / 2;
      const labelWidth = Math.min(190, 16 + preferredLabel.length * 7.2);
      const labelHeight = 18;
      const yCenter = position.y - radius - 14;
      const rect = {
        x1: position.x - labelWidth / 2,
        x2: position.x + labelWidth / 2,
        y1: yCenter - labelHeight / 2,
        y2: yCenter + labelHeight / 2,
      };

      if (node.id() === state.selectedGeneId || isHighlighted || isLeadingEdge) {
        setNodeDisplayLabel(node, preferredLabel);
        occupied.push(rect);
        addRectToBuckets(rect);
        return;
      }

      const overlaps = getNearbyRects(rect).some((box) =>
        !(rect.x2 < box.x1 - 8 || rect.x1 > box.x2 + 8 || rect.y2 < box.y1 - 4 || rect.y1 > box.y2 + 4),
      );

      setNodeDisplayLabel(node, overlaps ? '' : preferredLabel);
      if (!overlaps) {
        occupied.push(rect);
        addRectToBuckets(rect);
      }
    });
  }

  async function openHeatmapFigureWindow(pathway) {
    const popup = window.open('', '_blank');
    if (!popup) {
      throw new Error('Popup was blocked. Please allow popups for this report to open the heatmap figure.');
    }
    popup.document.open();
    popup.document.write(`
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <title>Preparing heatmap...</title>
          <style>
            body { margin: 0; font-family: "Avenir Next", "Segoe UI", sans-serif; background: #f4f8ff; color: #1b2f4f; }
            .loading { min-height: 100vh; display: grid; place-items: center; letter-spacing: 0.01em; }
          </style>
        </head>
        <body><div class="loading">Preparing clustered heatmap...</div></body>
      </html>
    `);
    popup.document.close();

    let payload;
    try {
      payload = buildHeatmapPayload(pathway);
    } catch (error) {
      popup.close();
      throw error;
    }

    const html = buildHeatmapWindowHtml(payload);
    popup.document.open();
    popup.document.write(html);
    popup.document.close();
  }

  function buildHeatmapPayload(pathway) {
    const { nodeById } = getPathwayNodeLookup(pathway);
    const selectedNodes = state.highlightedGeneIds
      .map((geneId) => nodeById.get(geneId))
      .filter((node) => getGeneSampleValueCount(node) >= 2);

    if (selectedNodes.length < 2) {
      throw new Error('Select at least 2 genes with Ctrl/Cmd-click (or Shift+drag) before opening heatmap.');
    }
    if (selectedNodes.length > 180) {
      throw new Error('Heatmap currently supports up to 180 selected genes. Please narrow the selection.');
    }

    const sampleSet = new Set();
    const sampleKeys = [];
    selectedNodes.forEach((node) => {
      Object.entries(node.sampleValues || {}).forEach(([sampleKey, value]) => {
        const numericValue = Number(value);
        if (!Number.isFinite(numericValue)) {
          return;
        }
        if (!sampleSet.has(sampleKey)) {
          sampleSet.add(sampleKey);
          sampleKeys.push(sampleKey);
        }
      });
    });

    if (sampleKeys.length < 2) {
      throw new Error('Selected genes do not have enough per-sample values to build a heatmap.');
    }

    const sampleKeyRank = new Map(sampleKeys.map((sampleKey, index) => [sampleKey, index]));
    const sampleGroupCache = new Map();
    const getSampleMeta = (sampleKey) =>
      data.samplesById && Object.prototype.hasOwnProperty.call(data.samplesById, sampleKey)
        ? data.samplesById[sampleKey]
        : null;
    const getSampleGroup = (sampleKey) => {
      if (!sampleGroupCache.has(sampleKey)) {
        const sampleMeta = getSampleMeta(sampleKey);
        if (sampleMeta?.groupKey) {
          sampleGroupCache.set(sampleKey, {
            key: sampleMeta.groupKey,
            label: sampleMeta.groupLabel || sampleMeta.label || 'Unassigned',
          });
        } else {
          sampleGroupCache.set(
            sampleKey,
            data.schemaVersion === 2 ? { key: 'U', label: 'Unassigned' } : inferSampleGroupFromName(sampleKey, data.project.conditionA, data.project.conditionB),
          );
        }
      }
      return sampleGroupCache.get(sampleKey);
    };
    const groupRank = { A: 0, B: 1, U: 2 };
    const detectedGroups = sampleKeys.map((sampleKey) => getSampleGroup(sampleKey));
    const hasDetectedAB =
      detectedGroups.some((group) => group.key === 'A') && detectedGroups.some((group) => group.key === 'B');
    const orderedSampleKeys = hasDetectedAB
      ? sampleKeys
          .slice()
          .sort((left, right) => {
            const leftGroup = getSampleGroup(left);
            const rightGroup = getSampleGroup(right);
            return (
              groupRank[leftGroup.key] - groupRank[rightGroup.key] ||
              (sampleKeyRank.get(left) ?? 0) - (sampleKeyRank.get(right) ?? 0)
            );
          })
      : sampleKeys;

    const rawMatrix = selectedNodes.map((node) => {
      const values = orderedSampleKeys.map((sampleKey) => Number(node.sampleValues?.[sampleKey]));
      const finiteValues = values.filter((value) => Number.isFinite(value));
      const fallbackMean = finiteValues.length
        ? finiteValues.reduce((sum, value) => sum + value, 0) / finiteValues.length
        : 0;
      return values.map((value) => (Number.isFinite(value) ? value : fallbackMean));
    });

    const zMatrix = rawMatrix.map((row) => {
      const mean = row.reduce((sum, value) => sum + value, 0) / row.length;
      const variance = row.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(row.length - 1, 1);
      const sd = Math.sqrt(variance);
      if (!(sd > 1e-8)) {
        return row.map(() => 0);
      }
      return row.map((value) => clamp((value - mean) / sd, -4.5, 4.5));
    });

    const rowOrder = hierarchicalLeafOrder(zMatrix);
    const columnVectors = transposeMatrix(zMatrix);
    const columnOrder = hierarchicalLeafOrder(columnVectors);

    const orderedRawMatrix = rowOrder.map((rowIndex) => columnOrder.map((columnIndex) => rawMatrix[rowIndex][columnIndex]));
    const orderedZMatrix = rowOrder.map((rowIndex) => columnOrder.map((columnIndex) => zMatrix[rowIndex][columnIndex]));
    const orderedSampleKeysByCluster = columnOrder.map((columnIndex) => orderedSampleKeys[columnIndex]);
    const orderedSamples = orderedSampleKeysByCluster.map(
      (sampleKey) => getSampleMeta(sampleKey)?.label || prettifySampleKey(sampleKey),
    );
    const orderedGroups = orderedSampleKeysByCluster.map((sampleKey) => getSampleGroup(sampleKey));
    const orderedGenes = rowOrder.map((rowIndex) => selectedNodes[rowIndex].label || selectedNodes[rowIndex].id);
    const orderedGeneIds = rowOrder.map((rowIndex) => selectedNodes[rowIndex].id);

    return {
      projectTitle: data.project.projectTitle,
      pathwayName: pathway.pathwayName,
      pathwayCollection: pathway.collection,
      conditionA: formatConditionLabel(data.project.conditionA),
      conditionB: formatConditionLabel(data.project.conditionB),
      genes: orderedGenes,
      geneIds: orderedGeneIds,
      sampleKeys: orderedSampleKeysByCluster,
      samples: orderedSamples,
      sampleGroups: orderedGroups,
      matrixRaw: orderedRawMatrix.map((row) => row.map((value) => Number(value.toFixed(6)))),
      matrixZ: orderedZMatrix.map((row) => row.map((value) => Number(value.toFixed(6)))),
      filenameBase: `${slugify(data.project.projectTitle) || 'project'}.${slugify(pathway.pathwayName) || 'pathway'}`,
      createdAt: new Date().toISOString(),
    };
  }

  function tokenizeMatchQuery(value) {
    if (!value) {
      return [];
    }
    const tokens = [];
    const seen = new Set();
    const length = value.length;
    let cursor = 0;
    while (cursor < length) {
      while (cursor < length && value[cursor] === ' ') {
        cursor += 1;
      }
      if (cursor >= length) {
        break;
      }
      const start = cursor;
      while (cursor < length && value[cursor] !== ' ') {
        cursor += 1;
      }
      const token = value.slice(start, cursor);
      if (!token || seen.has(token)) {
        continue;
      }
      seen.add(token);
      tokens.push(token);
    }
    return tokens;
  }

  function intersectSortedIndices(left, right) {
    if (!left.length || !right.length) {
      return [];
    }
    const matched = [];
    let leftIndex = 0;
    let rightIndex = 0;
    while (leftIndex < left.length && rightIndex < right.length) {
      const leftValue = left[leftIndex];
      const rightValue = right[rightIndex];
      if (leftValue === rightValue) {
        matched.push(leftValue);
        leftIndex += 1;
        rightIndex += 1;
        continue;
      }
      if (leftValue < rightValue) {
        leftIndex += 1;
      } else {
        rightIndex += 1;
      }
    }
    return matched;
  }

  function createPathwaySearchEngine(searchIndex) {
    const queryCache = new Map();
    const queryTokenCache = new Map();
    const prefixIndex = new Map();
    const exactTokenIndex = new Map();
    const allEntryIndices = new Array(searchIndex.length);
    const allPathways = [];
    let lastQuery = '';
    let lastQueryIndices = allEntryIndices;
    let lastQueryPathways = allPathways;

    for (let index = 0; index < searchIndex.length; index += 1) {
      allEntryIndices[index] = index;
      const entry = searchIndex[index];
      if (!entry) {
        continue;
      }
      allPathways.push(entry.pathway);
      const uniqueTokens = new Set(tokenizeMatchQuery(entry.nameNormalized));
      const prefixes = new Set();
      for (const token of uniqueTokens) {
        if (token.length < PATHWAY_SEARCH_MIN_PREFIX_TOKEN_LENGTH) {
          continue;
        }
        const exactPostingList = exactTokenIndex.get(token);
        if (exactPostingList) {
          exactPostingList.push(index);
        } else {
          exactTokenIndex.set(token, [index]);
        }
        prefixes.add(token.slice(0, Math.min(PATHWAY_SEARCH_PREFIX_TOKEN_LENGTH, token.length)));
      }
      for (const prefix of prefixes) {
        const postingList = prefixIndex.get(prefix);
        if (postingList) {
          postingList.push(index);
        } else {
          prefixIndex.set(prefix, [index]);
        }
      }
    }

    function getCachedQueryResult(query) {
      const cached = queryCache.get(query);
      if (!cached) {
        return null;
      }
      queryCache.delete(query);
      queryCache.set(query, cached);
      return cached;
    }

    function cacheQueryResult(query, matchedIndices, matchedPathways) {
      if (matchedIndices.length > PATHWAY_SEARCH_CACHEABLE_MATCH_LIMIT) {
        return;
      }
      setBoundedMapEntry(
        queryCache,
        query,
        {
          indices: matchedIndices,
          pathways: matchedPathways,
        },
        PATHWAY_SEARCH_CACHE_LIMIT,
      );
    }

    function getCachedQueryTokens(query) {
      const cached = getLruMapEntry(queryTokenCache, query);
      if (cached !== null) {
        return cached;
      }
      const tokens = tokenizeMatchQuery(query)
        .filter((token) => token.length >= PATHWAY_SEARCH_MIN_PREFIX_TOKEN_LENGTH)
        .sort((left, right) => right.length - left.length);
      setBoundedMapEntry(queryTokenCache, query, tokens, PATHWAY_SEARCH_TOKEN_CACHE_LIMIT);
      return tokens;
    }

    function mapIndicesToPathways(indices) {
      const pathways = [];
      for (let index = 0; index < indices.length; index += 1) {
        const entry = searchIndex[indices[index]];
        if (entry && entry.pathway) {
          pathways.push(entry.pathway);
        }
      }
      return pathways;
    }

    function rankMatchedEntryIndices(indices, tokens, query) {
      if (indices.length <= 1 || indices.length > 1200) {
        return indices;
      }
      const paddedQuery = ` ${query} `;
      return indices
        .slice()
        .sort((leftIndex, rightIndex) => {
          const leftEntry = searchIndex[leftIndex];
          const rightEntry = searchIndex[rightIndex];
          if (!leftEntry || !rightEntry) {
            return leftIndex - rightIndex;
          }

          const leftName = leftEntry.nameNormalized || '';
          const rightName = rightEntry.nameNormalized || '';
          const leftPaddedName = ` ${leftName} `;
          const rightPaddedName = ` ${rightName} `;
          let leftScore = 0;
          let rightScore = 0;

          if (leftName === query) {
            leftScore += 48;
          } else if (leftName.startsWith(query)) {
            leftScore += 18;
          } else if (leftPaddedName.includes(paddedQuery)) {
            leftScore += 12;
          }
          if (rightName === query) {
            rightScore += 48;
          } else if (rightName.startsWith(query)) {
            rightScore += 18;
          } else if (rightPaddedName.includes(paddedQuery)) {
            rightScore += 12;
          }

          for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
            const token = tokens[tokenIndex];
            const paddedToken = ` ${token} `;
            if (leftPaddedName.includes(paddedToken)) {
              leftScore += 7;
            } else if (leftName.includes(token)) {
              leftScore += 3;
            }
            if (rightPaddedName.includes(paddedToken)) {
              rightScore += 7;
            } else if (rightName.includes(token)) {
              rightScore += 3;
            }
          }

          if (leftScore !== rightScore) {
            return rightScore - leftScore;
          }

          const leftPadj = nullableNumber(leftEntry.pathway?.padj);
          const rightPadj = nullableNumber(rightEntry.pathway?.padj);
          const leftPadjSafe = Number.isFinite(leftPadj) ? leftPadj : Number.POSITIVE_INFINITY;
          const rightPadjSafe = Number.isFinite(rightPadj) ? rightPadj : Number.POSITIVE_INFINITY;
          if (leftPadjSafe !== rightPadjSafe) {
            return leftPadjSafe - rightPadjSafe;
          }

          const leftNesAbs = Math.abs(Number(leftEntry.pathway?.nes || 0));
          const rightNesAbs = Math.abs(Number(rightEntry.pathway?.nes || 0));
          if (leftNesAbs !== rightNesAbs) {
            return rightNesAbs - leftNesAbs;
          }

          return leftIndex - rightIndex;
        });
    }

    function selectSeedEntryIndices(tokens) {
      const postingLists = [];
      const seenTokens = new Set();
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index];
        if (seenTokens.has(token)) {
          continue;
        }
        seenTokens.add(token);
        const exactPostingList = exactTokenIndex.get(token);
        if (exactPostingList && exactPostingList.length) {
          postingLists.push(exactPostingList);
          continue;
        }
        if (token.length < PATHWAY_SEARCH_MIN_PREFIX_TOKEN_LENGTH) {
          continue;
        }
        const prefix = token.slice(0, Math.min(PATHWAY_SEARCH_PREFIX_TOKEN_LENGTH, token.length));
        const postingList = prefixIndex.get(prefix);
        if (postingList && postingList.length) {
          postingLists.push(postingList);
        }
      }
      if (!postingLists.length) {
        return null;
      }

      postingLists.sort((left, right) => left.length - right.length);
      let candidateIndices = postingLists[0].slice();
      const mergeLimit = Math.min(PATHWAY_SEARCH_PREFIX_INTERSECTION_LIMIT, postingLists.length);
      for (let index = 1; index < mergeLimit; index += 1) {
        if (!candidateIndices.length) {
          break;
        }
        candidateIndices = intersectSortedIndices(candidateIndices, postingLists[index]);
      }

      return candidateIndices;
    }

    return {
      filter(query) {
        if (!query) {
          lastQuery = '';
          lastQueryIndices = allEntryIndices;
          lastQueryPathways = allPathways;
          return [];
        }

        if (query === lastQuery) {
          return lastQueryPathways;
        }

        const cached = getCachedQueryResult(query);
        if (cached) {
          lastQuery = query;
          lastQueryIndices = cached.indices;
          lastQueryPathways = cached.pathways;
          return cached.pathways;
        }

        const tokens = getCachedQueryTokens(query);
        if (!tokens.length) {
          lastQuery = query;
          lastQueryIndices = allEntryIndices;
          lastQueryPathways = allPathways;
          return allPathways;
        }

        const incrementalSeed =
          lastQuery && query.startsWith(lastQuery) ? lastQueryIndices : null;
        const prefixSeedIndices = selectSeedEntryIndices(tokens);
        const baseEntryIndices = incrementalSeed || prefixSeedIndices || allEntryIndices;

        const matchedEntryIndices = [];
        for (let baseIndex = 0; baseIndex < baseEntryIndices.length; baseIndex += 1) {
          const entryIndex = baseEntryIndices[baseIndex];
          const entry = searchIndex[entryIndex];
          if (!entry) {
            continue;
          }
          let matchesAllTokens = true;
          for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
            if (!entry.nameNormalized.includes(tokens[tokenIndex])) {
              matchesAllTokens = false;
              break;
            }
          }
          if (matchesAllTokens) {
            matchedEntryIndices.push(entryIndex);
          }
        }

        const rankedEntryIndices = rankMatchedEntryIndices(matchedEntryIndices, tokens, query);
        const matchedPathways = mapIndicesToPathways(rankedEntryIndices);
        cacheQueryResult(query, rankedEntryIndices, matchedPathways);
        lastQuery = query;
        lastQueryIndices = rankedEntryIndices;
        lastQueryPathways = matchedPathways;
        return matchedPathways;
      },
    };
  }

  function normalizeMatchToken(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function inferSampleGroupFromName(sampleKey, conditionA, conditionB) {
    const normalizedSample = normalizeMatchToken(sampleKey);
    const normalizedA = normalizeMatchToken(conditionA);
    const normalizedB = normalizeMatchToken(conditionB);
    const compactSample = normalizedSample.replace(/\s+/g, '');
    const compactA = normalizedA.replace(/\s+/g, '');
    const compactB = normalizedB.replace(/\s+/g, '');

    if ((normalizedA && normalizedSample.includes(normalizedA)) || (compactA && compactSample.includes(compactA))) {
      return { key: 'A', label: formatConditionLabel(conditionA) };
    }
    if ((normalizedB && normalizedSample.includes(normalizedB)) || (compactB && compactSample.includes(compactB))) {
      return { key: 'B', label: formatConditionLabel(conditionB) };
    }

    const controlPattern = /\b(ctrl|control|healthy|normal|untreated|vehicle|wt|wildtype)\b/i;
    const casePattern = /\b(case|disease|lesional|treated|ko|knockout|mutant|tumou?r|cancer|infected)\b/i;
    if (controlPattern.test(sampleKey)) {
      return { key: 'A', label: formatConditionLabel(conditionA) };
    }
    if (casePattern.test(sampleKey)) {
      return { key: 'B', label: formatConditionLabel(conditionB) };
    }

    return { key: 'U', label: 'Unassigned' };
  }

  function hierarchicalLeafOrder(vectors) {
    const length = vectors.length;
    if (length <= 1) {
      return [0];
    }
    if (length === 2) {
      return [0, 1];
    }

    const distanceMatrix = Array.from({ length }, () => Array(length).fill(0));
    for (let left = 0; left < length; left += 1) {
      for (let right = left + 1; right < length; right += 1) {
        const distance = euclideanDistance(vectors[left], vectors[right]);
        distanceMatrix[left][right] = distance;
        distanceMatrix[right][left] = distance;
      }
    }

    let clusters = Array.from({ length }, (_, index) => ({
      members: [index],
      order: [index],
    }));

    while (clusters.length > 1) {
      let bestLeft = 0;
      let bestRight = 1;
      let bestDistance = Number.POSITIVE_INFINITY;

      for (let left = 0; left < clusters.length; left += 1) {
        for (let right = left + 1; right < clusters.length; right += 1) {
          const distance = averageClusterDistance(clusters[left].members, clusters[right].members, distanceMatrix);
          if (distance < bestDistance) {
            bestDistance = distance;
            bestLeft = left;
            bestRight = right;
          }
        }
      }

      const leftCluster = clusters[bestLeft];
      const rightCluster = clusters[bestRight];
      const mergedOrder = chooseMergeOrientation(leftCluster.order, rightCluster.order, distanceMatrix);
      const mergedCluster = {
        members: [...leftCluster.members, ...rightCluster.members],
        order: mergedOrder,
      };

      const nextClusters = [];
      for (let index = 0; index < clusters.length; index += 1) {
        if (index === bestLeft || index === bestRight) {
          continue;
        }
        nextClusters.push(clusters[index]);
      }
      nextClusters.push(mergedCluster);
      clusters = nextClusters;
    }

    return clusters[0].order;
  }

  function averageClusterDistance(leftMembers, rightMembers, distanceMatrix) {
    let sum = 0;
    let count = 0;
    for (let leftIndex = 0; leftIndex < leftMembers.length; leftIndex += 1) {
      for (let rightIndex = 0; rightIndex < rightMembers.length; rightIndex += 1) {
        sum += distanceMatrix[leftMembers[leftIndex]][rightMembers[rightIndex]];
        count += 1;
      }
    }
    return count ? sum / count : Number.POSITIVE_INFINITY;
  }

  function chooseMergeOrientation(leftOrder, rightOrder, distanceMatrix) {
    const leftNormal = leftOrder.slice();
    const leftReverse = leftOrder.slice().reverse();
    const rightNormal = rightOrder.slice();
    const rightReverse = rightOrder.slice().reverse();
    const candidates = [
      [leftNormal, rightNormal],
      [leftNormal, rightReverse],
      [leftReverse, rightNormal],
      [leftReverse, rightReverse],
    ];

    let bestOrder = [...leftNormal, ...rightNormal];
    let bestBoundaryDistance = Number.POSITIVE_INFINITY;
    candidates.forEach(([leftCandidate, rightCandidate]) => {
      const leftBoundary = leftCandidate[leftCandidate.length - 1];
      const rightBoundary = rightCandidate[0];
      const distance = distanceMatrix[leftBoundary][rightBoundary];
      if (distance < bestBoundaryDistance) {
        bestBoundaryDistance = distance;
        bestOrder = [...leftCandidate, ...rightCandidate];
      }
    });
    return bestOrder;
  }

  function euclideanDistance(left, right) {
    const limit = Math.min(left.length, right.length);
    let sumSquares = 0;
    for (let index = 0; index < limit; index += 1) {
      const diff = Number(left[index] || 0) - Number(right[index] || 0);
      sumSquares += diff * diff;
    }
    return Math.sqrt(sumSquares);
  }

  function transposeMatrix(matrix) {
    if (!matrix.length) {
      return [];
    }
    const width = matrix[0].length;
    return Array.from({ length: width }, (_, columnIndex) =>
      matrix.map((row) => row[columnIndex]),
    );
  }

  function prettifySampleKey(sampleKey) {
    const cleaned = String(sampleKey || '')
      .replace(/^sample_/i, '')
      .replace(/^tpm_/i, '')
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || sampleKey;
  }

  function buildHeatmapWindowHtml(payload) {
    const payloadScript = escapeScriptPayload(JSON.stringify(payload));
    const title = `${payload.pathwayName} · Heatmap`;
    return `
      <!doctype html>
      <html lang="en">
        <head>
          <meta charset="utf-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1" />
          <title>${escapeHtml(title)}</title>
          <style>
            :root {
              color-scheme: light;
              --bg: #eef3fb;
              --card: #ffffff;
              --line: rgba(111, 141, 188, 0.22);
              --text: #132744;
              --muted: #57739b;
              --accent: #2f78ff;
            }
            * { box-sizing: border-box; }
            body {
              margin: 0;
              font-family: "Avenir Next", "Segoe UI", "Noto Sans", sans-serif;
              color: var(--text);
              background:
                radial-gradient(circle at 10% -5%, rgba(118, 168, 255, 0.24), transparent 28%),
                radial-gradient(circle at 95% 6%, rgba(255, 157, 96, 0.2), transparent 24%),
                var(--bg);
              min-height: 100vh;
            }
            .shell {
              max-width: 1520px;
              margin: 0 auto;
              padding: 20px 20px 28px;
            }
            .hero {
              border: 1px solid var(--line);
              border-radius: 22px;
              background: rgba(255, 255, 255, 0.84);
              box-shadow: 0 18px 46px rgba(28, 58, 112, 0.14);
              backdrop-filter: blur(10px);
              padding: 18px 20px;
              display: grid;
              gap: 12px;
            }
            .hero-top {
              display: flex;
              justify-content: space-between;
              gap: 12px;
              flex-wrap: wrap;
              align-items: center;
            }
            .eyebrow {
              margin: 0;
              font-size: 0.76rem;
              font-weight: 800;
              letter-spacing: 0.14em;
              text-transform: uppercase;
              color: #5a79ad;
            }
            h1 {
              margin: 6px 0 0;
              font-size: clamp(1.2rem, 2.4vw, 1.9rem);
              line-height: 1.14;
            }
            .subtitle {
              margin: 8px 0 0;
              color: var(--muted);
              font-size: 0.95rem;
            }
            .badges {
              display: flex;
              flex-wrap: wrap;
              gap: 8px;
            }
            .badge {
              border-radius: 999px;
              padding: 7px 10px;
              background: #f5f8ff;
              border: 1px solid var(--line);
              font-size: 0.82rem;
              color: #3f5f8d;
            }
            .actions {
              display: flex;
              flex-wrap: wrap;
              gap: 8px;
            }
            button {
              border: 0;
              border-radius: 999px;
              padding: 10px 14px;
              font-weight: 700;
              background: linear-gradient(135deg, #2f78ff, #4a9bcf);
              color: white;
              cursor: pointer;
            }
            button.secondary {
              background: white;
              color: #21416f;
              border: 1px solid var(--line);
            }
            .canvas {
              margin-top: 16px;
              border-radius: 22px;
              border: 1px solid var(--line);
              background: var(--card);
              box-shadow: 0 16px 42px rgba(23, 50, 97, 0.12);
              padding: 12px;
            }
            #heatmap {
              width: 100%;
              min-height: 620px;
            }
            .foot {
              margin-top: 10px;
              color: var(--muted);
              font-size: 0.84rem;
            }
            @media (max-width: 780px) {
              .shell { padding: 12px; }
              .hero { border-radius: 16px; padding: 12px; }
              .canvas { border-radius: 16px; padding: 8px; }
              #heatmap { min-height: 520px; }
            }
          </style>
        </head>
        <body>
          <main class="shell">
            <section class="hero">
              <div class="hero-top">
                <div>
                  <p class="eyebrow">Publication Heatmap</p>
                  <h1>${escapeHtml(payload.pathwayName)}</h1>
                  <p class="subtitle">${escapeHtml(payload.projectTitle)} · ${escapeHtml(payload.pathwayCollection)} · ${escapeHtml(payload.conditionB)} versus ${escapeHtml(payload.conditionA)}</p>
                </div>
                <div class="actions">
                  <button id="download-svg" class="secondary" type="button">Download SVG</button>
                  <button id="download-pdf" class="secondary" type="button">Download PDF</button>
                  <button id="download-png" class="secondary" type="button">Download PNG (600dpi)</button>
                  <button id="download-tsv" class="secondary" type="button">Download Matrix TSV</button>
                </div>
              </div>
              <div class="badges">
                <span class="badge">Rows: selected genes (${payload.genes.length})</span>
                <span class="badge">Columns: samples (${payload.samples.length})</span>
                <span class="badge">Distance: Euclidean</span>
                <span class="badge">Linkage: Average</span>
                <span class="badge">Row scaling: z-score</span>
              </div>
            </section>
            <section class="canvas">
              <div id="heatmap"></div>
              <p class="foot">Clustered heatmap is generated from Ctrl/Cmd-click selected genes in the network panel.</p>
            </section>
          </main>
          <script>
            (async function () {
              const payload = ${payloadScript};
              const openerWindow = window.opener || null;
              const ensurePlotlyRuntime =
                (openerWindow && typeof openerWindow.__PNV_ENSURE_PLOTLY_RUNTIME__ === 'function'
                  ? openerWindow.__PNV_ENSURE_PLOTLY_RUNTIME__
                  : typeof window.__PNV_ENSURE_PLOTLY_RUNTIME__ === 'function'
                    ? window.__PNV_ENSURE_PLOTLY_RUNTIME__
                    : null);
              let Plotly = window.Plotly || (openerWindow && openerWindow.Plotly ? openerWindow.Plotly : null);
              const runtimeSource = openerWindow || window;
              let JsPdfCtor = runtimeSource.jspdf && runtimeSource.jspdf.jsPDF ? runtimeSource.jspdf.jsPDF : null;
              let svg2pdf = typeof runtimeSource.svg2pdf === 'function'
                ? runtimeSource.svg2pdf
                : runtimeSource.svg2pdf && typeof runtimeSource.svg2pdf.svg2pdf === 'function'
                  ? runtimeSource.svg2pdf.svg2pdf
                  : null;
              const ensurePdfRuntime =
                (openerWindow && typeof openerWindow.__PNV_ENSURE_PDF_EXPORT_RUNTIME__ === 'function'
                  ? openerWindow.__PNV_ENSURE_PDF_EXPORT_RUNTIME__
                  : typeof window.__PNV_ENSURE_PDF_EXPORT_RUNTIME__ === 'function'
                    ? window.__PNV_ENSURE_PDF_EXPORT_RUNTIME__
                    : null);
              const plotEl = document.getElementById('heatmap');
              if (!Plotly && ensurePlotlyRuntime) {
                try {
                  Plotly = await ensurePlotlyRuntime();
                } catch {}
              }
              if (!Plotly) {
                plotEl.innerHTML = '<div style="padding:24px;color:#8a2640">Plotly runtime is unavailable. Re-open heatmap from the generated report to restore plotting support.</div>';
                document.getElementById('download-svg').disabled = true;
                document.getElementById('download-pdf').disabled = true;
                document.getElementById('download-png').disabled = true;
                return;
              }
              if (!JsPdfCtor || !svg2pdf) {
                if (!ensurePdfRuntime) {
                  const pdfButton = document.getElementById('download-pdf');
                  pdfButton.disabled = true;
                  pdfButton.title = 'PDF export runtime is unavailable in this browser session.';
                }
              }

              const baseWidth = Math.max(980, payload.samples.length * 34 + 340);
              const baseHeight = Math.max(580, payload.genes.length * 24 + 240);
              const groupCodes = payload.sampleGroups.map((group) => {
                if (group.key === 'A') return 0;
                if (group.key === 'B') return 1;
                return 2;
              });
              const groupLabels = payload.sampleGroups.map((group) => group.label || 'Unassigned');

              const traces = [
                {
                  x: payload.samples,
                  y: payload.genes,
                  z: payload.matrixZ,
                  type: 'heatmap',
                  xaxis: 'x',
                  yaxis: 'y',
                  zmid: 0,
                  zmin: -2.5,
                  zmax: 2.5,
                  colorscale: [
                    [0, '#0f3460'],
                    [0.2, '#2f78ff'],
                    [0.5, '#f7f9ff'],
                    [0.8, '#ff9264'],
                    [1, '#7a102f'],
                  ],
                  colorbar: {
                    title: 'Row z-score',
                    thickness: 13,
                    outlinewidth: 0,
                  },
                  customdata: payload.matrixRaw,
                  hovertemplate: 'Gene %{y}<br>Sample %{x}<br>Z %{z:.2f}<br>Expression %{customdata:.3f}<extra></extra>',
                },
                {
                  x: payload.samples,
                  y: ['Group'],
                  z: [groupCodes],
                  customdata: [groupLabels],
                  type: 'heatmap',
                  xaxis: 'x',
                  yaxis: 'y2',
                  zmin: 0,
                  zmax: 2,
                  showscale: false,
                  colorscale: [
                    [0, '#73a6ff'],
                    [0.3333, '#73a6ff'],
                    [0.3334, '#ff9b64'],
                    [0.6666, '#ff9b64'],
                    [0.6667, '#bcc8db'],
                    [1, '#bcc8db'],
                  ],
                  hovertemplate: 'Sample %{x}<br>Group %{customdata}<extra></extra>',
                },
              ];

              const layout = {
                width: baseWidth,
                height: baseHeight,
                paper_bgcolor: '#ffffff',
                plot_bgcolor: '#ffffff',
                margin: { l: 188, r: 72, t: 110, b: 168 },
                title: {
                  text: payload.pathwayName + '<br><span style="font-size:12px;color:#5f78a0">' + payload.conditionB + ' versus ' + payload.conditionA + '</span>',
                  x: 0.01,
                  xanchor: 'left',
                  y: 0.98,
                  yanchor: 'top',
                },
                xaxis: {
                  tickangle: -45,
                  tickfont: { size: 10 },
                  side: 'bottom',
                  showgrid: false,
                  automargin: true,
                },
                yaxis: {
                  domain: [0, 0.88],
                  tickfont: { size: 11 },
                  automargin: true,
                  autorange: 'reversed',
                  showgrid: false,
                },
                yaxis2: {
                  domain: [0.91, 1],
                  showticklabels: false,
                  fixedrange: true,
                },
                hoverlabel: { bgcolor: '#ffffff', bordercolor: '#d3def0', font: { color: '#1e355b' } },
              };

              const config = {
                responsive: true,
                displaylogo: false,
                modeBarButtonsToRemove: ['lasso2d', 'select2d', 'hoverCompareCartesian'],
              };

              Plotly.newPlot(plotEl, traces, layout, config);

              function dataUrlToText(dataUrl) {
                const parts = String(dataUrl).split(',');
                const payload = parts[1] || '';
                if (dataUrl.indexOf(';base64,') >= 0) {
                  return atob(payload);
                }
                return decodeURIComponent(payload);
              }

              function downloadBlob(filename, blob) {
                const href = URL.createObjectURL(blob);
                const anchor = document.createElement('a');
                anchor.href = href;
                anchor.download = filename;
                anchor.click();
                setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
              }

              async function downloadSvg() {
                const svgDataUrl = await Plotly.toImage(plotEl, {
                  format: 'svg',
                  width: Math.round(baseWidth * 1.15),
                  height: Math.round(baseHeight * 1.15),
                });
                const svgText = dataUrlToText(svgDataUrl);
                downloadBlob(payload.filenameBase + '.heatmap.svg', new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
              }

              async function downloadPng() {
                const pngDataUrl = await Plotly.toImage(plotEl, {
                  format: 'png',
                  width: Math.round(baseWidth * 2),
                  height: Math.round(baseHeight * 2),
                  scale: 3,
                });
                const anchor = document.createElement('a');
                anchor.href = pngDataUrl;
                anchor.download = payload.filenameBase + '.heatmap.600dpi.png';
                anchor.click();
              }

              async function downloadPdf() {
                if ((!JsPdfCtor || !svg2pdf) && ensurePdfRuntime) {
                  try {
                    const loaded = await ensurePdfRuntime();
                    JsPdfCtor = loaded && loaded.jsPDF ? loaded.jsPDF : JsPdfCtor;
                    svg2pdf = loaded && loaded.svg2pdf ? loaded.svg2pdf : svg2pdf;
                  } catch {}
                }
                if (!JsPdfCtor || !svg2pdf) {
                  window.alert('PDF export runtime is unavailable in this browser session. Use SVG export.');
                  return;
                }

                const svgDataUrl = await Plotly.toImage(plotEl, {
                  format: 'svg',
                  width: Math.round(baseWidth * 1.15),
                  height: Math.round(baseHeight * 1.15),
                });
                const svgText = dataUrlToText(svgDataUrl);
                const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
                const svgElement = doc.documentElement;
                const pdfWidthPt = Math.round(baseWidth * 0.75);
                const pdfHeightPt = Math.round(baseHeight * 0.75);
                const pdf = new JsPdfCtor({
                  unit: 'pt',
                  format: [pdfWidthPt, pdfHeightPt],
                });
                await svg2pdf(svgElement, pdf, {
                  x: 0,
                  y: 0,
                  width: pdfWidthPt,
                  height: pdfHeightPt,
                });
                pdf.save(payload.filenameBase + '.heatmap.pdf');
              }

              function downloadTsv() {
                const header = ['Gene', ...payload.sampleKeys];
                const lines = [header.join('\\t')];
                for (let rowIndex = 0; rowIndex < payload.genes.length; rowIndex += 1) {
                  const values = payload.matrixRaw[rowIndex].map((value) => Number(value).toFixed(6));
                  lines.push([payload.genes[rowIndex], ...values].join('\\t'));
                }
                const content = lines.join('\\n');
                downloadBlob(payload.filenameBase + '.heatmap.matrix.tsv', new Blob([content], { type: 'text/tab-separated-values;charset=utf-8' }));
              }

              document.getElementById('download-svg').addEventListener('click', function () {
                downloadSvg().catch(function (error) {
                  window.alert('SVG download failed: ' + (error && error.message ? error.message : 'unknown error'));
                });
              });
              document.getElementById('download-png').addEventListener('click', function () {
                downloadPng().catch(function (error) {
                  window.alert('PNG download failed: ' + (error && error.message ? error.message : 'unknown error'));
                });
              });
              document.getElementById('download-pdf').addEventListener('click', function () {
                downloadPdf().catch(function (error) {
                  window.alert('PDF download failed: ' + (error && error.message ? error.message : 'unknown error'));
                });
              });
              document.getElementById('download-tsv').addEventListener('click', downloadTsv);
            })();
          </script>
        </body>
      </html>
    `;
  }

  function escapeScriptPayload(value) {
    return String(value || '').replace(/<\/script/gi, '<\\/script');
  }

  function getSvg2PdfRuntime(runtimeSource = window) {
    if (typeof runtimeSource.svg2pdf === 'function') {
      return runtimeSource.svg2pdf;
    }
    if (runtimeSource.svg2pdf && typeof runtimeSource.svg2pdf.svg2pdf === 'function') {
      return runtimeSource.svg2pdf.svg2pdf;
    }
    return null;
  }

  function hydrateEmbeddedRuntimeScript(sourceId) {
    const sourceEl = document.getElementById(sourceId);
    if (!sourceEl) {
      return false;
    }
    const sourceText = sourceEl.textContent || '';
    sourceEl.remove();
    if (!sourceText.trim()) {
      return false;
    }
    const scriptEl = document.createElement('script');
    scriptEl.text = sourceText;
    scriptEl.setAttribute('data-pnv-runtime-source', sourceId);
    document.head.appendChild(scriptEl);
    return true;
  }

  async function ensurePlotlyRuntimeLoaded() {
    if (window.Plotly) {
      return window.Plotly;
    }
    const loaded = hydrateEmbeddedRuntimeScript('pnv-plotly-source');
    if (loaded) {
      await Promise.resolve();
    }
    if (!window.Plotly) {
      throw new Error('Plot runtime is unavailable');
    }
    return window.Plotly;
  }

  async function ensurePdfExportRuntimeLoaded() {
    let jsPDF = window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : null;
    let svg2pdf = getSvg2PdfRuntime(window);
    if (jsPDF && svg2pdf) {
      return { jsPDF, svg2pdf };
    }

    const loadedPdf = hydrateEmbeddedRuntimeScript('pnv-jspdf-source');
    const loadedSvg = hydrateEmbeddedRuntimeScript('pnv-svg2pdf-source');
    const loadedAnyScript = loadedPdf || loadedSvg;
    if (loadedAnyScript) {
      await Promise.resolve();
      jsPDF = window.jspdf && window.jspdf.jsPDF ? window.jspdf.jsPDF : null;
      svg2pdf = getSvg2PdfRuntime(window);
    }
    if (!jsPDF || !svg2pdf) {
      throw new Error('PDF export runtime is unavailable');
    }
    return { jsPDF, svg2pdf };
  }

  window.__PNV_ENSURE_PLOTLY_RUNTIME__ = ensurePlotlyRuntimeLoaded;
  window.__PNV_ENSURE_PDF_EXPORT_RUNTIME__ = ensurePdfExportRuntimeLoaded;

  async function exportFigure(pathway, target, format, preset, dpi) {
    if (!preset) {
      throw new Error('Unknown export preset selected.');
    }
    const isPlotExport = target === 'plot';
    const effectiveFormat = isPlotExport ? 'pdf' : format;
    const effectivePreset = isPlotExport ? getLandscapeExportPreset(preset) : preset;
    const projectSlug = slugify(data.project.projectTitle) || 'project';
    const pathwaySlug = slugify(pathway.pathwayName) || 'pathway';
    const filenameBase = `${projectSlug}.${pathwaySlug}.${target}.${effectivePreset.key}`;

    if (target === 'network') {
      const svgText = wrapStandaloneSvg(cy.svg({ full: true, bg: '#ffffff' }), effectivePreset);
      await downloadByFormat(filenameBase, effectiveFormat, svgText, effectivePreset, dpi);
      return;
    }

    if (target === 'plot') {
      const plotFigureSvg = await buildPlotFigureSvg(pathway, effectivePreset);
      await downloadByFormat(filenameBase, effectiveFormat, plotFigureSvg, effectivePreset, dpi);
      return;
    }

    const fullSvg = await buildFullFigureSvg(pathway, effectivePreset);
    await downloadByFormat(filenameBase, effectiveFormat, fullSvg, effectivePreset, dpi);
  }

  function getLandscapeExportPreset(preset) {
    const base = preset || EXPORT_PRESETS['2-column'];
    let widthInches = Math.max(base.widthInches, base.heightInches);
    let heightInches = Math.min(base.widthInches, base.heightInches);
    const minWidthInches = 7.2;
    widthInches = Math.max(widthInches, minWidthInches);
    const minLandscapeRatio = 1.45;
    if (widthInches / heightInches < minLandscapeRatio) {
      heightInches = widthInches / minLandscapeRatio;
    }
    return {
      key: `${base.key}-landscape`,
      label: `${base.label} landscape`,
      widthInches,
      heightInches,
    };
  }

  function buildEnrichmentPlotSvg(pathway, options = {}) {
    const width = Math.max(260, Number(options.width) || 920);
    const height = Math.max(220, Number(options.height) || 460);
    const showFrame = options.showFrame !== false;
    const points = Array.isArray(pathway?.enrichment?.points) ? pathway.enrichment.points : [];
    const hitIndices = Array.isArray(pathway?.enrichment?.hitIndices) ? pathway.enrichment.hitIndices : [];
    if (!points.length) {
      return `
        <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
          <rect width="100%" height="100%" fill="${showFrame ? '#f8fbff' : 'transparent'}" rx="${showFrame ? 14 : 0}" />
          <text x="${width / 2}" y="${height / 2}" font-size="13" text-anchor="middle" fill="#6b7f9f">No enrichment points available</text>
        </svg>
      `;
    }

    const margin = { left: 54, right: 18, top: 16, bottom: 40 };
    const innerWidth = Math.max(120, width - margin.left - margin.right);
    const innerHeight = Math.max(90, height - margin.top - margin.bottom);
    const maxRank = Math.max(1, Number(points[points.length - 1]?.index || points.length - 1));
    const maxAbsValue = Math.max(0.08, Number(pathway?.enrichment?.maxAbsValue || 0.08));
    const safeValue = (value) => {
      const numeric = Number(value);
      if (!Number.isFinite(numeric)) {
        return 0;
      }
      return clamp(numeric, -maxAbsValue, maxAbsValue);
    };
    const xAt = (rank) => margin.left + (clamp(Number(rank) || 0, 0, maxRank) / maxRank) * innerWidth;
    const yAt = (value) => margin.top + ((maxAbsValue - safeValue(value)) / (maxAbsValue * 2)) * innerHeight;
    const pathD = points
      .map((point, index) => `${index === 0 ? 'M' : 'L'} ${xAt(point.index).toFixed(2)} ${yAt(point.value).toFixed(2)}`)
      .join(' ');
    const zeroY = yAt(0);
    const axisBottom = margin.top + innerHeight;
    const hitLimit = innerWidth < 460 ? 460 : innerWidth < 700 ? 720 : 960;
    const hitStride = hitIndices.length > hitLimit ? Math.ceil(hitIndices.length / hitLimit) : 1;
    const hitTickHeight = Math.max(7, innerHeight * 0.06);
    const sampledHits = hitIndices.filter((_, index) => index % hitStride === 0);
    const hitLines = sampledHits
      .map((rank) => {
        const x = xAt(rank).toFixed(2);
        return `<line x1="${x}" y1="${(axisBottom - hitTickHeight).toFixed(2)}" x2="${x}" y2="${axisBottom.toFixed(2)}" stroke="#102039" stroke-opacity="0.66" stroke-width="1"/>`;
      })
      .join('');
    const peak = summarizeEnrichment(pathway);
    const peakX = xAt(peak.peakRank || 0);
    const peakY = yAt(peak.peakEs || 0);
    const axisLabelY = height - 8;
    const yAxisLabelX = 14;
    const yAxisLabelY = margin.top + innerHeight / 2;
    const roundedRankTicks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => Math.round(maxRank * fraction));
    const rankTicks = Array.from(new Set(roundedRankTicks))
      .map((rank) => {
        const x = xAt(rank);
        return `<line x1="${x.toFixed(2)}" y1="${axisBottom.toFixed(2)}" x2="${x.toFixed(2)}" y2="${(axisBottom + 4).toFixed(2)}" stroke="#7a97c9" stroke-width="1"/><text x="${x.toFixed(2)}" y="${(axisBottom + 16).toFixed(2)}" text-anchor="middle" font-size="10" fill="#5d708e">${rank}</text>`;
      })
      .join('');

    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <defs>
          <linearGradient id="pnv-plot-bg" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="#f7faff"/>
            <stop offset="100%" stop-color="#edf4ff"/>
          </linearGradient>
          <linearGradient id="pnv-plot-line" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stop-color="#245ed6"/>
            <stop offset="100%" stop-color="#2f78ff"/>
          </linearGradient>
        </defs>
        <rect x="0" y="0" width="${width}" height="${height}" fill="${showFrame ? 'url(#pnv-plot-bg)' : 'transparent'}" rx="${showFrame ? 14 : 0}" />
        <rect x="${margin.left}" y="${margin.top}" width="${innerWidth}" height="${innerHeight}" fill="rgba(255,255,255,0.62)" stroke="#d6e3f8"/>
        <line x1="${margin.left}" y1="${zeroY.toFixed(2)}" x2="${(margin.left + innerWidth).toFixed(2)}" y2="${zeroY.toFixed(2)}" stroke="#8ea6cc" stroke-dasharray="5 4" stroke-width="1"/>
        ${hitLines}
        <path d="${pathD}" fill="none" stroke="url(#pnv-plot-line)" stroke-width="2.6" stroke-linejoin="round" stroke-linecap="round"/>
        <circle cx="${peakX.toFixed(2)}" cy="${peakY.toFixed(2)}" r="4.2" fill="#102039" />
        <text x="${Math.max(margin.left + 8, Math.min(width - margin.right - 80, peakX + 8)).toFixed(2)}" y="${(Math.max(margin.top + 14, peakY - 10)).toFixed(2)}" font-size="10" fill="#102039">Peak ${formatSignedNumber(peak.peakEs)}</text>
        <line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${axisBottom}" stroke="#7a97c9" stroke-width="1.1"/>
        <line x1="${margin.left}" y1="${axisBottom}" x2="${(margin.left + innerWidth).toFixed(2)}" y2="${axisBottom}" stroke="#7a97c9" stroke-width="1.1"/>
        ${rankTicks}
        <text x="${margin.left + innerWidth / 2}" y="${axisLabelY}" text-anchor="middle" font-size="11" fill="#4b6286">Rank in ordered gene list</text>
        <text x="${yAxisLabelX}" y="${yAxisLabelY.toFixed(2)}" transform="rotate(-90 ${yAxisLabelX} ${yAxisLabelY.toFixed(2)})" text-anchor="middle" font-size="11" fill="#4b6286">Running enrichment score</text>
      </svg>
    `;
  }

  async function buildPlotFigureSvg(pathway, preset) {
    const widthPt = preset.widthInches * 72;
    const baseHeightPt = preset.heightInches * 72;
    const summary = summarizeEnrichment(pathway);
    const titleLines = wrapTitleLines(pathway.pathwayName, widthPt < 300 ? 24 : widthPt < 420 ? 38 : 62);
    const titleFontSize = widthPt < 300 ? 14 : widthPt < 420 ? 16 : 18;
    const titleLineHeight = titleFontSize + 4;
    const titleBlockHeight = titleLines.length * titleLineHeight;
    const headerHeight = 72 + titleBlockHeight;
    const plotY = headerHeight + 14;
    const minPlotHeight = 210;
    const heightPt = Math.max(baseHeightPt, plotY + minPlotHeight + 18);
    const plotHeight = Math.max(minPlotHeight, heightPt - plotY - 18);
    const plotSvg = wrapStandaloneSvg(buildEnrichmentPlotSvg(pathway, { width: 1100, height: 620 }), {
      key: 'plot',
      widthInches: Math.max(1, (widthPt - 28) / 72),
      heightInches: Math.max(1, plotHeight / 72),
    });
    const titleTspans = titleLines
      .map((line, index) => `<tspan x="24" dy="${index === 0 ? 0 : titleLineHeight}">${escapeXml(line)}</tspan>`)
      .join('');
    const statsLineA = `NES ${formatSignedNumber(pathway.nes)} · FDR ${formatSci(pathway.padj)} · Peak ES ${formatSignedNumber(summary.peakEs)} · Peak rank ${summary.peakRank ?? 'NA'}/${summary.rankedListSize}`;
    const statsLineB = `Hits ${summary.hitCount} · Leading edge ${summary.leadingEdgeCount} · Members ${summary.memberCount}${summary.peakGene ? ` · Peak gene ${summary.peakGene}` : ''}`;

    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="${widthPt}pt" height="${heightPt}pt" viewBox="0 0 ${widthPt} ${heightPt}">
        <defs>
          <filter id="plotCardShadow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#8aa2cb" flood-opacity="0.16"/>
          </filter>
        </defs>
        <rect width="100%" height="100%" rx="18" fill="#ffffff" />
        <text x="24" y="24" font-size="10" font-weight="700" letter-spacing="1.2" fill="#6b7f9f">GSEA ENRICHMENT PLOT</text>
        <text x="${widthPt - 24}" y="24" font-size="10" font-weight="600" text-anchor="end" fill="#6b7f9f">${escapeXml(data.project.conditionA)} → ${escapeXml(data.project.conditionB)}</text>
        <text x="24" y="48" font-size="${titleFontSize}" font-weight="700" fill="#102039">${titleTspans}</text>
        <text x="24" y="${48 + titleBlockHeight + 12}" font-size="11" fill="#5d708e">${escapeXml(pathway.collection)}</text>
        <text x="24" y="${48 + titleBlockHeight + 30}" font-size="11" fill="#334968">${escapeXml(statsLineA)}</text>
        <text x="24" y="${48 + titleBlockHeight + 46}" font-size="11" fill="#334968">${escapeXml(statsLineB)}</text>
        <rect x="14" y="${plotY - 8}" width="${widthPt - 28}" height="${plotHeight + 10}" rx="18" fill="#f8fbff" stroke="#d8e4f6" filter="url(#plotCardShadow)" />
        ${nestSvg(plotSvg, 18, plotY, widthPt - 36, plotHeight)}
      </svg>
    `;
  }

  async function buildFullFigureSvg(pathway, preset) {
    const widthPt = preset.widthInches * 72;
    const heightPt = preset.heightInches * 72;
    const summary = summarizeEnrichment(pathway);
    const { visibleNodes, visibleEdges } = getPathwayRenderData(pathway);
    const titleLines = wrapTitleLines(pathway.pathwayName, widthPt < 420 ? 44 : 68);
    const titleFontSize = widthPt < 420 ? 17 : 20;
    const titleLineHeight = titleFontSize + 5;
    const titleBlockHeight = titleLines.length * titleLineHeight;
    const headerHeight = 88 + titleBlockHeight;
    const contentTop = headerHeight + 12;
    const contentHeight = heightPt - contentTop - 18;
    const gutter = 18;
    const networkCardWidth = widthPt * 0.63;
    const plotCardWidth = widthPt - networkCardWidth - gutter - 28;
    const networkCardHeight = contentHeight;
    const plotCardHeight = contentHeight;
    const innerPad = 12;
    const networkSvg = wrapStandaloneSvg(cy.svg({ full: true, bg: '#ffffff' }), {
      key: 'network',
      widthInches: Math.max(1, (networkCardWidth - innerPad * 2) / 72),
      heightInches: Math.max(1, (networkCardHeight - 46 - innerPad * 2) / 72),
    });
    const plotSvg = wrapStandaloneSvg(buildEnrichmentPlotSvg(pathway, { width: 1100, height: 700 }), {
      key: 'plot',
      widthInches: Math.max(1, (plotCardWidth - innerPad * 2) / 72),
      heightInches: Math.max(1, (plotCardHeight - 46 - innerPad * 2) / 72),
    });
    const titleTspans = titleLines
      .map((line, index) => `<tspan x="24" dy="${index === 0 ? 0 : titleLineHeight}">${escapeXml(line)}</tspan>`)
      .join('');
    const statsLineA = `NES ${formatSignedNumber(pathway.nes)} · FDR ${formatSci(pathway.padj)} · Peak ES ${formatSignedNumber(summary.peakEs)} · Peak rank ${summary.peakRank ?? 'NA'}/${summary.rankedListSize}`;
    const statsLineB = `Visible genes ${visibleNodes.length}/${pathway.allGenes.length} · Edges ${visibleEdges.length} · Leading edge ${summary.leadingEdgeCount} · Hits ${summary.hitCount}${summary.peakGene ? ` · Peak gene ${summary.peakGene}` : ''}`;
    const viewLine = `View ${state.showAllGenes && !pathway.fallbackToLeadingEdge ? ((evidence.pathways?.[pathway.pathwayId]?.testedGenes || evidence.pathways?.[pathway.key]?.testedGenes) ? 'All tested pathway genes' : 'Supplied/reference genes') : 'Leading edge'} · PPI ${state.ppiMode} · Min score ${state.edgeScoreMin} · Top genes ${state.topGeneCount || 'All'} · Top edges ${state.topEdgePercentile}% · Node size ${Math.round(state.nodeSizeScale * 100)}%`;

    return `
      <svg xmlns="http://www.w3.org/2000/svg" width="${widthPt}pt" height="${heightPt}pt" viewBox="0 0 ${widthPt} ${heightPt}">
        <defs>
          <filter id="fullCardShadow" x="-10%" y="-10%" width="120%" height="120%">
            <feDropShadow dx="0" dy="10" stdDeviation="10" flood-color="#8aa2cb" flood-opacity="0.14"/>
          </filter>
        </defs>
        <rect width="100%" height="100%" fill="#ffffff" rx="18" />
        <text x="24" y="24" font-size="10" font-weight="700" letter-spacing="1.2" fill="#6b7f9f">PATHWAY NETWORK SUMMARY</text>
        <text x="${widthPt - 24}" y="24" font-size="10" font-weight="600" text-anchor="end" fill="#6b7f9f">${escapeXml(data.project.conditionA)} → ${escapeXml(data.project.conditionB)}</text>
        <text x="24" y="50" font-size="${titleFontSize}" font-weight="700" fill="#102039">${titleTspans}</text>
        <text x="24" y="${50 + titleBlockHeight + 10}" font-size="11" fill="#5d708e">${escapeXml(data.project.projectTitle)} · ${escapeXml(pathway.collection)}</text>
        <text x="24" y="${50 + titleBlockHeight + 28}" font-size="11" fill="#334968">${escapeXml(statsLineA)}</text>
        <text x="24" y="${50 + titleBlockHeight + 44}" font-size="11" fill="#334968">${escapeXml(statsLineB)}</text>
        <text x="24" y="${50 + titleBlockHeight + 60}" font-size="10" fill="#6b7f9f">${escapeXml(viewLine)}</text>

        <rect x="14" y="${contentTop}" width="${networkCardWidth}" height="${networkCardHeight}" rx="18" fill="#f8fbff" stroke="#d8e4f6" filter="url(#fullCardShadow)" />
        <text x="30" y="${contentTop + 22}" font-size="10" font-weight="700" letter-spacing="1.0" fill="#6b7f9f">NETWORK VIEW</text>
        <text x="30" y="${contentTop + 38}" font-size="11" fill="#5d708e">Node size −log10(FDR) · color leading edge/pathway/context · edge width STRING score</text>
        ${nestSvg(networkSvg, 18 + innerPad, contentTop + 46, networkCardWidth - innerPad * 2, networkCardHeight - 46 - innerPad)}

        <rect x="${18 + networkCardWidth + gutter - 4}" y="${contentTop}" width="${plotCardWidth}" height="${plotCardHeight}" rx="18" fill="#f8fbff" stroke="#d8e4f6" filter="url(#fullCardShadow)" />
        <text x="${18 + networkCardWidth + gutter + 12}" y="${contentTop + 22}" font-size="10" font-weight="700" letter-spacing="1.0" fill="#6b7f9f">GSEA ENRICHMENT</text>
        <text x="${18 + networkCardWidth + gutter + 12}" y="${contentTop + 38}" font-size="11" fill="#5d708e">Running enrichment score with ranked hits</text>
        ${nestSvg(plotSvg, 18 + networkCardWidth + gutter + 8, contentTop + 46, plotCardWidth - innerPad * 2, plotCardHeight - 46 - innerPad)}
      </svg>
    `;
  }

  async function downloadByFormat(filenameBase, format, svgText, preset, dpi) {
    if (format === 'svg') {
      downloadBlob(`${filenameBase}.svg`, new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' }));
      return;
    }

    if (format === 'pdf') {
      const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
      const svgElement = doc.documentElement;
      const { jsPDF, svg2pdf } = await ensurePdfExportRuntimeLoaded();
      const pdf = new jsPDF({
        unit: 'pt',
        format: [preset.widthInches * 72, preset.heightInches * 72],
      });
      await svg2pdf(svgElement, pdf, {
        x: 0,
        y: 0,
        width: preset.widthInches * 72,
        height: preset.heightInches * 72,
      });
      pdf.save(`${filenameBase}.pdf`);
      return;
    }

    const mimeType = format === 'jpg' ? 'image/jpeg' : 'image/png';
    const quality = format === 'jpg' ? 0.94 : undefined;
    const blob = await rasterizeSvg(svgText, preset, dpi, mimeType, quality);
    downloadBlob(`${filenameBase}.${format === 'jpg' ? 'jpg' : 'png'}`, blob);
  }

  function wrapStandaloneSvg(svgText, preset) {
    const widthPt = preset.widthInches * 72;
    const heightPt = preset.heightInches * 72;
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.documentElement;
    const viewBox =
      root.getAttribute('viewBox') ||
      `0 0 ${root.getAttribute('width') || widthPt} ${root.getAttribute('height') || heightPt}`;
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    root.setAttribute('width', `${widthPt}pt`);
    root.setAttribute('height', `${heightPt}pt`);
    root.setAttribute('viewBox', viewBox);
    return root.outerHTML;
  }

  function nestSvg(svgText, x, y, width, height) {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.documentElement;
    const viewBox =
      root.getAttribute('viewBox') ||
      `0 0 ${root.getAttribute('width') || width} ${root.getAttribute('height') || height}`;
    return `<svg x="${x}" y="${y}" width="${width}" height="${height}" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">${root.innerHTML}</svg>`;
  }

  async function rasterizeSvg(svgText, preset, dpi, mimeType, quality) {
    const svgBlob = new Blob([svgText], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    try {
      const image = await loadImage(url);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(preset.widthInches * dpi);
      canvas.height = Math.round(preset.heightInches * dpi);
      const context = canvas.getContext('2d');
      if (!context) {
        throw new Error('Canvas rendering context is unavailable for raster export.');
      }
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, mimeType, quality),
      );
      if (!blob) {
        throw new Error('Raster export encoder returned an empty image.');
      }
      return blob;
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = reject;
      image.src = url;
    });
  }

  function downloadBlob(filename, blob) {
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = href;
    anchor.download = filename;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function colorForPathwayMembership(node, pathwayGeneIds) {
    if (node.isLeadingEdge) {
      return '#2f78ff';
    }
    if (pathwayGeneIds && pathwayGeneIds.has(node.id)) {
      return '#cfe2ff';
    }
    return '#d5d9e2';
  }

  function summarizeEnrichment(pathway) {
    const points = pathway?.enrichment?.points || [];
    const rankedListSize = points.length ? Number(points[points.length - 1].index || 0) : 0;
    let peakPoint = points[0] || { index: 0, value: 0, gene: '' };
    const recordedEs = nullableNumber(pathway?.enrichment?.es);
    const unavailableEs = pathway?.enrichment?.validation === 'unavailable' || pathway?.enrichment?.es === null || !points.length;
    const preferPositive = (recordedEs === null ? Number(pathway?.nes || 0) : recordedEs) >= 0;

    points.forEach((point) => {
      if (!Number.isFinite(Number(point?.value))) {
        return;
      }
      if (preferPositive) {
        if (Number(point.value) > Number(peakPoint.value || 0)) {
          peakPoint = point;
        }
        return;
      }
      if (Number(point.value) < Number(peakPoint.value || 0)) {
        peakPoint = point;
      }
    });

    return {
      peakEs: unavailableEs ? null : recordedEs === null ? Number(peakPoint?.value || 0) : recordedEs,
      peakRank: unavailableEs ? null : recordedEs === 0 ? 0 : Number(peakPoint?.index || 0),
      peakGene: peakPoint?.gene || '',
      hitCount: Number(pathway?.enrichment?.hitIndices?.length || 0),
      leadingEdgeCount: Number(pathway?.leadingEdgeGenes?.length || 0),
      memberCount: Number(pathway?.allGenes?.length || 0),
      rankedListSize,
    };
  }

  function wrapTitleLines(value, maxChars) {
    const words = String(value || '').trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      return ['Untitled pathway'];
    }

    const lines = [];
    let currentLine = words[0];
    for (let index = 1; index < words.length; index += 1) {
      const next = `${currentLine} ${words[index]}`;
      if (next.length <= maxChars || currentLine.length < Math.floor(maxChars * 0.55)) {
        currentLine = next;
      } else {
        lines.push(currentLine);
        currentLine = words[index];
      }
    }
    lines.push(currentLine);
    return lines.slice(0, 3);
  }

  function slugify(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80);
  }

  function renderEvidenceHeader() {
    const verification = evidence.verification || { status: 'unverifiable', checks: [], limitations: [] };
    const labels = {
      verified_against_supplied_artifacts: 'Verified against supplied artifacts at report generation',
      internally_consistent: 'Internal consistency only', unverifiable: 'Source verification unavailable', mismatch: 'Evidence mismatch detected',
    };
    const analysis = evidence.analysis || {};
    const integrated = fullEvidence ? `<div id="evidence-summary" class="evidence-summary">
      <h2>Analysis evidence</h2><strong>${escapeHtml(labels[verification.status] || labels.unverifiable)}</strong>
      <p>Method: ${escapeHtml(analysis.method || 'Not recorded')} · Design: ${escapeHtml(analysis.designFormula || 'Not recorded')} · Rank: ${escapeHtml(analysis.rankMetric || 'Not recorded')}</p>
      <p>Effect estimate: ${escapeHtml(analysis.lfcMethod || 'Not recorded')} · Adjustment: ${escapeHtml(analysis.adjustment || 'Not recorded')}</p>
      <p>Report significance threshold: ${formatNumber(data.significantPadjThreshold)} · Original analysis alpha: ${formatNumber(analysis.alpha)}</p>
      <p>Verification describes checks performed at report generation. Opening this report offline does not recheck original files that are unavailable to the report.</p>
      <p>Run: ${escapeHtml(evidence.runId || 'Not recorded')}. A digest checks file identity; it does not establish biological truth or validate original sample labels.</p>
      ${(verification.checks || []).map(check => `<div class="evidence-check"><strong>${escapeHtml(check.status)}</strong> ${escapeHtml(check.message)}</div>`).join('')}
      ${(verification.limitations || []).map(item => `<p class="muted">${escapeHtml(item)}</p>`).join('')}
    </div>` : '';
    return `<section class="panel evidence-panel" aria-label="Report evidence">${integrated}
      <details id="raw-evidence"><summary>Source tables and analysis records</summary>
        <p>These source records are available in both report conditions. Row numbers count data rows, excluding the header.</p>
        <button type="button" id="download-evidence" class="tool-button">Download all evidence JSON</button>
        <label>Source table <select id="source-table-select" class="select-control">${Object.keys(sourceTables).map(name => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`).join('')}</select></label>
        <button type="button" id="download-source-table" class="tool-button">Download selected table TSV</button>
        <div class="source-table-controls"><button type="button" id="source-previous" class="tool-button">Previous rows</button><span id="source-table-position"></span><button type="button" id="source-next" class="tool-button">Next rows</button></div>
        <div id="source-table-content" class="source-table-content"></div>
        <details><summary>Method, provenance and sensitivity records</summary><pre id="raw-evidence-records"></pre></details>
      </details>
    </section>`;
  }

  function installEvidenceControls() {
    const raw = document.getElementById('raw-evidence');
    const select = document.getElementById('source-table-select');
    raw.addEventListener('toggle', () => { if (raw.open) renderSourceTable(); });
    select.addEventListener('change', () => { sourceTableOffset = 0; renderSourceTable(); });
    document.getElementById('source-previous').addEventListener('click', () => { sourceTableOffset = Math.max(0, sourceTableOffset - 50); renderSourceTable(); });
    document.getElementById('source-next').addEventListener('click', () => {
      const total = sourceTables[select.value]?.rows.length || 0;
      sourceTableOffset = Math.min(Math.max(0, total - 1), sourceTableOffset + 50); renderSourceTable();
    });
    document.getElementById('download-evidence').addEventListener('click', () => saveEvidenceFile('analysis-evidence.json', JSON.stringify(evidence, null, 2), 'application/json'));
    document.getElementById('download-source-table').addEventListener('click', () => {
      const table = sourceTables[select.value];
      if (!table) return;
      const cell = value => String(value ?? '').replace(/[\t\r\n]/g, ' ');
      saveEvidenceFile(`${slugify(select.value) || 'source'}.tsv`, [table.columns, ...table.rows].map(row => row.map(cell).join('\t')).join('\n'), 'text/tab-separated-values');
    });
    const { sourceTables: omitted, ...records } = evidence;
    document.getElementById('raw-evidence-records').textContent = JSON.stringify({ provenance: data.provenance || {}, ...records }, null, 2);
    app.addEventListener('click', event => {
      const button = event.target.closest?.('[data-source-table]');
      if (!button || !Object.hasOwn(sourceTables, button.dataset.sourceTable)) return;
      select.value = button.dataset.sourceTable;
      sourceTableOffset = Math.max(0, Number(button.dataset.sourceRow || 1) - 1);
      raw.open = true; renderSourceTable(); raw.scrollIntoView({ block: 'start', behavior: 'smooth' });
    });
  }

  function saveEvidenceFile(filename, text, mime) {
    const href = URL.createObjectURL(new Blob([text], { type: mime }));
    const anchor = document.createElement('a'); anchor.href = href; anchor.download = filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  }

  function renderSourceTable() {
    const name = document.getElementById('source-table-select').value;
    const table = sourceTables[name];
    const container = document.getElementById('source-table-content');
    if (!table) { container.textContent = 'No source table was supplied.'; return; }
    const rows = table.rows.slice(sourceTableOffset, sourceTableOffset + 50);
    document.getElementById('source-table-position').textContent = `${table.rows.length ? sourceTableOffset + 1 : 0}–${sourceTableOffset + rows.length} / ${table.rows.length}`;
    document.getElementById('source-previous').disabled = sourceTableOffset === 0;
    document.getElementById('source-next').disabled = sourceTableOffset + rows.length >= table.rows.length;
    container.innerHTML = `<table><thead><tr><th>Row</th>${table.columns.map(column => `<th>${escapeHtml(column)}</th>`).join('')}</tr></thead><tbody>${rows.map((row, index) => `<tr><td>${sourceTableOffset + index + 1}</td>${row.map(value => `<td>${value === null ? 'NA' : escapeHtml(String(value))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  }

  function geneEvidenceMarkup(gene) {
    let source = '';
    for (const tableName of ['genes', 'Genes']) {
      const table = sourceTables[tableName];
      if (!table) continue;
      const column = table.columns.findIndex(name => ['gene', 'gene_symbol'].includes(name));
      if (column < 0) continue;
      const row = table.rows.findIndex(values => values[column] === gene.id);
      if (row >= 0) {
        source = `<button type="button" class="tool-button" data-source-table="${escapeHtml(tableName)}" data-source-row="${row + 1}">Gene source row ${row + 1}</button>`;
        break;
      }
    }
    return `${source}${gene.statisticsReason ? `<p class="muted">${escapeHtml(gene.statisticsReason)}</p>` : ''}`;
  }

  function renderPathwayEvidence(pathway) {
    const element = document.getElementById('pathway-evidence');
    if (!fullEvidence) return;
    const detail = evidence.pathways?.[pathway.pathwayId] || evidence.pathways?.[pathway.key] || {};
    const source = detail.source || pathway.source;
    const sourceLink = source && Object.hasOwn(sourceTables, source.table)
      ? `<button type="button" class="tool-button" data-source-table="${escapeHtml(source.table)}" data-source-row="${escapeHtml(String(source.row))}">Source: ${escapeHtml(source.table)}, row ${escapeHtml(String(source.row))}</button>` : '<span>Source row not recorded</span>';
    const camera = detail.camera, bootstrap = detail.bootstrap;
    element.innerHTML = `${sourceLink}${pathway.statisticsReason ? `<p>${escapeHtml(pathway.statisticsReason)}</p>` : ''}
      ${(detail.designSensitivity || []).map(design => `<p>Design sensitivity: ${escapeHtml(design.designFormula)} · NES ${formatNumber(design.nes)} · FDR ${formatSci(design.padj)}. The prespecified primary design remains unchanged.${design.source && Object.hasOwn(sourceTables, design.source.table) ? ` <button type="button" class="tool-button" data-source-table="${escapeHtml(design.source.table)}" data-source-row="${escapeHtml(String(design.source.row))}">Design source row ${escapeHtml(String(design.source.row))}</button>` : ''}</p>`).join('')}
      ${camera ? `<p>CAMERA sensitivity: direction ${escapeHtml(camera.direction || 'NA')} · FDR ${formatSci(camera.padj)}. This is a different competitive test; its FDR is not combined with fgsea.</p>` : ''}
      ${bootstrap ? `<p>Sample resampling: selected ${formatNumber(bootstrap.selectionFrequency === null ? null : 100 * bootstrap.selectionFrequency)}% · direction retained ${formatNumber(bootstrap.directionConsistency === null ? null : 100 * bootstrap.directionConsistency)}% · tested ${bootstrap.valid}/${bootstrap.requested} repetitions.</p><p class="muted">Descriptive stability within these data; not a replication probability or an adjusted p-value.</p>${bootstrap.warning || bootstrap.validFraction < 0.9 ? `<p class="evidence-warning">${escapeHtml(bootstrap.warning || 'Fewer than 90% of repetitions were testable.')}</p>` : ''}` : ''}`;
  }

  function nullableNumber(value) {
    if (value === null || value === undefined || value === '') return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
  }

  function formatNumber(value) {
    const numeric = nullableNumber(value);
    if (!Number.isFinite(numeric)) {
      return 'NA';
    }
    return numeric.toFixed(Math.abs(numeric) >= 10 ? 1 : 2);
  }

  function formatSignedNumber(value) {
    const numeric = nullableNumber(value);
    return numeric === null ? 'NA' : `${numeric > 0 ? '+' : ''}${formatNumber(numeric)}`;
  }

  function formatSci(value) {
    const numeric = nullableNumber(value);
    return Number.isFinite(numeric) ? numeric.toExponential(2) : 'NA';
  }

  function formatDate(value) {
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function formatProvenanceValue(value, fallback) {
    const normalized = String(value || '').trim();
    return normalized || fallback;
  }

  function formatConditionLabel(value) {
    const raw = String(value || '').trim();
    if (!raw) {
      return 'Unknown condition';
    }

    const normalized = raw
      .replace(/[_-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const tokenMap = {
      ctrl: 'Control',
      wt: 'WT',
      ko: 'KO',
      vs: 'versus',
      v: 'versus',
    };
    return normalized
      .split(' ')
      .map((token) => {
        const mapped = tokenMap[token.toLowerCase()];
        if (mapped) {
          return mapped;
        }
        const lowerToken = token.toLowerCase();
        if (token === token.toUpperCase() && token.length <= 5) {
          return token;
        }
        return lowerToken.charAt(0).toUpperCase() + lowerToken.slice(1);
      })
      .join(' ');
  }

  function buildReadableContrastTitle(project) {
    const conditionA = formatConditionLabel(project?.conditionA);
    const conditionB = formatConditionLabel(project?.conditionB);
    if (conditionA && conditionB) {
      return `${conditionB} versus ${conditionA}`;
    }
    return formatConditionLabel(project?.contrastName || 'Study contrast');
  }

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function escapeXml(value) {
    return escapeHtml(value);
  }

  function shortLabel(value) {
    const cleaned = String(value || '').trim();
    return cleaned.length > 10 ? `${cleaned.slice(0, 10)}…` : cleaned;
  }

  function isTypingContext(target) {
    if (!(target instanceof Element)) {
      return false;
    }
    if (target.closest('[contenteditable="true"]')) {
      return true;
    }
    if (!(target instanceof HTMLElement)) {
      return false;
    }
    return (
      target.tagName === 'INPUT' ||
      target.tagName === 'TEXTAREA' ||
      target.tagName === 'SELECT' ||
      target.isContentEditable
    );
  }

  function persistPreferences() {
    try {
      window.localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          showAllGenes: state.showAllGenes,
          layoutMode: state.layoutMode,
          ppiMode: state.ppiMode,
          edgeScoreMin: state.edgeScoreMin,
          topGeneCount: state.topGeneCount,
          topEdgePercentile: state.topEdgePercentile,
          nodeSizeScale: state.nodeSizeScale,
        }),
      );
    } catch {}
  }

  function scheduleSavePreferences(delayMs = SAVE_PREFERENCES_DEBOUNCE_MS) {
    if (savePreferencesTimerId !== null) {
      window.clearTimeout(savePreferencesTimerId);
    }
    savePreferencesTimerId = window.setTimeout(() => {
      savePreferencesTimerId = null;
      persistPreferences();
    }, delayMs);
  }

  function flushScheduledPreferenceSave() {
    if (savePreferencesTimerId !== null) {
      window.clearTimeout(savePreferencesTimerId);
      savePreferencesTimerId = null;
      persistPreferences();
    }
  }

  window.__PNV_RUNTIME_DEBUG__ = function runtimeDebugSnapshot() {
    return {
      pathwayCount: allPathways.length,
      filteredPathwayCount: getFilteredPathways().length,
      currentPathwayKey: state.currentPathwayKey,
      search: state.search,
      cache: {
        tableSort: tableSortCache.size,
        networkView: networkViewCache.size,
        geneDetailSampleRows: geneDetailSampleRowsCache.size,
        pathwayNodeLookup: pathwayNodeLookupCache.size,
        pathwayRenderPrep: pathwayRenderPrepCache.size,
        pathwayGeneSet: pathwayGeneSetCache.size,
      },
      pathwayList: {
        visibleCount: Math.min(pathwayListVisibleCount, getFilteredPathways().length),
        totalCount: getFilteredPathways().length,
      },
      network: {
        nodeCount: cy.nodes().length,
        edgeCount: cy.edges().length,
        layoutMode: state.layoutMode,
        ppiMode: state.ppiMode,
        topGeneCount: state.topGeneCount,
        topEdgePercentile: state.topEdgePercentile,
      },
      memoryHintGb: DEVICE_MEMORY_GB,
      timestamp: new Date().toISOString(),
    };
  };

  function applySavedPreferences() {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) {
        return;
      }

      const saved = JSON.parse(raw);
      if (typeof saved.showAllGenes === 'boolean') {
        state.showAllGenes = saved.showAllGenes;
      }
      if (typeof saved.layoutMode === 'string' && LAYOUT_OPTIONS.has(saved.layoutMode)) {
        state.layoutMode = saved.layoutMode;
      }
      if (typeof saved.ppiMode === 'string' && PPI_OPTIONS.has(saved.ppiMode)) {
        state.ppiMode = saved.ppiMode;
      }
      if (Number.isFinite(Number(saved.edgeScoreMin))) {
        state.edgeScoreMin = clamp(Number(saved.edgeScoreMin), 0, 1000);
      }
      if (Number.isFinite(Number(saved.topGeneCount)) && TOP_GENE_OPTIONS.has(Number(saved.topGeneCount))) {
        state.topGeneCount = Number(saved.topGeneCount);
      }
      if (
        Number.isFinite(Number(saved.topEdgePercentile)) &&
        TOP_EDGE_PERCENTILE_OPTIONS.has(Number(saved.topEdgePercentile))
      ) {
        state.topEdgePercentile = Number(saved.topEdgePercentile);
      }
      if (
        Number.isFinite(Number(saved.nodeSizeScale)) &&
        NODE_SIZE_SCALE_OPTIONS.has(Number(saved.nodeSizeScale))
      ) {
        state.nodeSizeScale = Number(saved.nodeSizeScale);
      }
    } catch {}
  }

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  window.addEventListener('beforeunload', () => {
    if (handleGlobalKeydownListener) {
      document.removeEventListener('keydown', handleGlobalKeydownListener);
    }
    flushScheduledPreferenceSave();
    if (renderPathwayTimerId !== null) {
      window.clearTimeout(renderPathwayTimerId);
    }
    if (pathwaySearchTimerId !== null) {
      window.clearTimeout(pathwaySearchTimerId);
    }
    if (labelCollisionFrameId !== null) {
      window.cancelAnimationFrame(labelCollisionFrameId);
    }
    if (pathwayListRenderFrameId !== null) {
      window.cancelAnimationFrame(pathwayListRenderFrameId);
    }
    if (labelCollisionTimerId !== null) {
      window.clearTimeout(labelCollisionTimerId);
    }
    if (typeof cy?.destroy === 'function') {
      cy.destroy();
    }
  });
})();
