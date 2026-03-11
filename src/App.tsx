import { startTransition, useDeferredValue, useMemo, useReducer, useRef, useState } from 'react';
import { downloadBlob } from './lib/utils';
import type {
  GeoAnalysisDesign,
  GeoGroupAssignment,
  GeoSearchResult,
  GeoSearchResponse,
} from './lib/geo';
import type { WorkbookParseResult } from './types';
import { getReferenceSummaryLite } from './reference/summary';
import {
  createDesignSession,
  createInitialDraftAnalysisState,
  draftAnalysisReducer,
  type DesignSession,
  findFactorById,
  type IntakeMode,
  MAX_VISIBLE_SAMPLE_ROWS,
  NO_BATCH_FACTOR,
} from './lib/builderState';

export function App() {
  const [mode, setMode] = useState<IntakeMode>('public');
  const [isParsing, setIsParsing] = useState(false);
  const [isPreparingDesign, setIsPreparingDesign] = useState(false);
  const [isGeneratingReport, setIsGeneratingReport] = useState(false);
  const [isGeoSearching, setIsGeoSearching] = useState(false);
  const [draftState, dispatch] = useReducer(draftAnalysisReducer, undefined, createInitialDraftAnalysisState);
  const [appError, setAppError] = useState<string>('');
  const [geoError, setGeoError] = useState<string>('');
  const [geoQuery, setGeoQuery] = useState<string>('');
  const [geoResults, setGeoResults] = useState<GeoSearchResult[]>([]);
  const [geoSearchSummary, setGeoSearchSummary] = useState<GeoSearchResponse | null>(null);
  const [activeGeoActionKey, setActiveGeoActionKey] = useState<string>('');
  const [geoRawCountsFile, setGeoRawCountsFile] = useState<File | null>(null);
  const [geoSeriesMatrixFile, setGeoSeriesMatrixFile] = useState<File | null>(null);
  const [geoAccessionInput, setGeoAccessionInput] = useState<string>('');
  const [geoTitleInput, setGeoTitleInput] = useState<string>('');
  const [geoOrganismInput, setGeoOrganismInput] = useState<string>('human');

  const parseRequestIdRef = useRef(0);
  const referenceSummary = useMemo(() => getReferenceSummaryLite(), []);
  const {
    designSession,
    result,
    loadedFileName,
    sampleFilter,
    bulkBatchValue,
    isDirtySinceLastRun,
  } = draftState;
  const deferredSampleFilter = useDeferredValue(sampleFilter);

  const groupCounts = useMemo(() => {
    if (!designSession) {
      return { A: 0, B: 0, excluded: 0 };
    }
    let a = 0;
    let b = 0;
    let excluded = 0;
    for (const sampleId of designSession.preview.sampleIds) {
      const group = designSession.groupBySample[sampleId] ?? '';
      if (group === 'A') {
        a += 1;
      } else if (group === 'B') {
        b += 1;
      } else {
        excluded += 1;
      }
    }
    return { A: a, B: b, excluded };
  }, [designSession]);

  const filteredSampleIds = useMemo(() => {
    if (!designSession) {
      return [] as string[];
    }

    const query = deferredSampleFilter.trim().toLowerCase();
    if (!query) {
      return designSession.preview.sampleIds;
    }

    return designSession.preview.sampleIds.filter((sampleId) => {
      const title = designSession.preview.sampleTitles[sampleId] ?? '';
      if (sampleId.toLowerCase().includes(query) || title.toLowerCase().includes(query)) {
        return true;
      }
      return designSession.preview.factors.some((factor) =>
        (factor.valuesBySample[sampleId] ?? '').toLowerCase().includes(query),
      );
    });
  }, [deferredSampleFilter, designSession]);

  const visibleSampleIds = filteredSampleIds.slice(0, MAX_VISIBLE_SAMPLE_ROWS);

  const handleSearchGeo = async () => {
    const query = geoQuery.trim();
    if (!query) {
      setGeoError('Enter a keyword or GSE accession first (example: GSE157951).');
      return;
    }
    if (isGeoSearching || isParsing || isGeneratingReport || isPreparingDesign) {
      return;
    }

    setIsGeoSearching(true);
    setGeoError('');
    try {
      const { searchGeoDatasets } = await import('./lib/geo');
      const searchResponse = await searchGeoDatasets(query, 12);
      startTransition(() => {
        setGeoSearchSummary(searchResponse);
        setGeoResults(searchResponse.results);
      });
      if (!searchResponse.rawHitCount) {
        setGeoError('No GEO series matched this query.');
      } else if (!searchResponse.eligibleCount) {
        setGeoError(
          `Found ${searchResponse.rawHitCount} GEO hit(s), but none met the current builder constraints.`,
        );
      }
    } catch (error) {
      setGeoResults([]);
      setGeoSearchSummary(null);
      setGeoError(
        error instanceof Error
          ? `GEO search failed: ${error.message}`
          : 'GEO search failed due to an unknown error.',
      );
    } finally {
      setIsGeoSearching(false);
    }
  };

  const handlePrepareGeoDesignFromNcbi = async (dataset: GeoSearchResult) => {
    if (isParsing || isGeneratingReport || isPreparingDesign || isGeoSearching) {
      return;
    }

    setIsPreparingDesign(true);
    setActiveGeoActionKey(`setup:${dataset.accession}`);
    setAppError('');
    setGeoError('');

    try {
      const { previewGeoSeriesDesignFromNcbi } = await import('./lib/geo');
      const preview = await previewGeoSeriesDesignFromNcbi(dataset);
      dispatch({
        type: 'setup_session',
        session: createDesignSession(preview, 'ncbi', { dataset }),
        loadedFileName: `${dataset.accession} (setup ready)`,
      });
    } catch (error) {
      setGeoError(
        error instanceof Error
          ? `Failed to load sample metadata: ${error.message}`
          : 'Failed to load sample metadata due to an unknown error.',
      );
    } finally {
      setIsPreparingDesign(false);
      setActiveGeoActionKey('');
    }
  };

  const handlePreparePrivateDesign = async () => {
    if (isParsing || isGeneratingReport || isPreparingDesign) {
      return;
    }
    if (!geoRawCountsFile) {
      setGeoError('Select a raw counts file first (.tsv/.txt/.gz).');
      return;
    }
    if (!geoSeriesMatrixFile) {
      setGeoError('Select a series matrix file first (.txt/.tsv/.gz).');
      return;
    }

    setIsPreparingDesign(true);
    setActiveGeoActionKey('setup:files');
    setGeoError('');
    setAppError('');

    try {
      const { previewGeoSeriesDesignFromFile } = await import('./lib/geo');
      const preview = await previewGeoSeriesDesignFromFile(geoSeriesMatrixFile);
      dispatch({
        type: 'setup_session',
        session: createDesignSession(preview, 'files', {
          rawCountsFile: geoRawCountsFile,
          seriesMatrixFile: geoSeriesMatrixFile,
          accession: geoAccessionInput.trim() || undefined,
          title: geoTitleInput.trim() || undefined,
          organism: geoOrganismInput.trim() || undefined,
        }),
        loadedFileName: `${geoRawCountsFile.name} + ${geoSeriesMatrixFile.name} (setup ready)`,
      });
    } catch (error) {
      setGeoError(
        error instanceof Error
          ? `Failed to parse uploaded series metadata: ${error.message}`
          : 'Failed to parse uploaded series metadata due to an unknown error.',
      );
    } finally {
      setIsPreparingDesign(false);
      setActiveGeoActionKey('');
    }
  };

  const handleRunConfiguredAnalysis = async () => {
    if (!designSession || isParsing || isPreparingDesign || isGeneratingReport) {
      return;
    }

    if (groupCounts.A < 2 || groupCounts.B < 2) {
      setAppError(
        `Need at least 2 samples in each group before analysis (A=${groupCounts.A}, B=${groupCounts.B}).`,
      );
      return;
    }

    const requestId = parseRequestIdRef.current + 1;
    parseRequestIdRef.current = requestId;
    setIsParsing(true);
    setAppError('');
    setGeoError('');
    setActiveGeoActionKey('run:analysis');

    try {
      const groupFactorLabel =
        findFactorById(designSession.preview, designSession.groupFactorId)?.label ?? designSession.groupFactorId;
      const analysisDesign: GeoAnalysisDesign = {
        conditionA: designSession.conditionA,
        conditionB: designSession.conditionB,
        groupBySample: designSession.groupBySample,
        groupFactorName: groupFactorLabel,
      };

      if (designSession.batchFactorId !== NO_BATCH_FACTOR) {
        analysisDesign.batchBySample = designSession.batchBySample;
        analysisDesign.batchFactorName =
          findFactorById(designSession.preview, designSession.batchFactorId)?.label ??
          designSession.batchFactorId;
      }

      const { analyzeGeoDatasetFromFiles, analyzeGeoDatasetFromNcbi } = await import('./lib/geo');
      let parsed: WorkbookParseResult;
      if (designSession.source === 'ncbi' && designSession.dataset) {
        parsed = await analyzeGeoDatasetFromNcbi(designSession.dataset, analysisDesign);
      } else if (
        designSession.source === 'files' &&
        designSession.rawCountsFile &&
        designSession.seriesMatrixFile
      ) {
        parsed = await analyzeGeoDatasetFromFiles({
          accession: designSession.accession,
          title: designSession.title,
          organism: designSession.organism,
          rawCountsFile: designSession.rawCountsFile,
          seriesMatrixFile: designSession.seriesMatrixFile,
          design: analysisDesign,
        });
      } else {
        throw new Error('Configured analysis source is incomplete. Re-open setup and try again.');
      }

      if (requestId !== parseRequestIdRef.current) {
        return;
      }

      dispatch({
        type: 'set_analysis_result',
        result: parsed,
        loadedFileName:
          designSession.source === 'ncbi'
            ? `${designSession.dataset?.accession ?? 'GEO'} (configured analysis)`
            : `${designSession.rawCountsFile?.name ?? 'raw counts'} (configured analysis)`,
      });
    } catch (error) {
      if (requestId !== parseRequestIdRef.current) {
        return;
      }
      setAppError(
        error instanceof Error
          ? `Analysis failed: ${error.message}`
          : 'Analysis failed due to an unknown error.',
      );
    } finally {
      if (requestId === parseRequestIdRef.current) {
        setIsParsing(false);
        setActiveGeoActionKey('');
      }
    }
  };

  const handleGenerateReport = async () => {
    if (!result?.viewerData) {
      return;
    }

    setIsGeneratingReport(true);
    setAppError('');
    try {
      const { createReportHtml, reportFilenameForProject } = await import('./lib/reportHtml');
      const html = createReportHtml(result.viewerData);
      downloadBlob(
        reportFilenameForProject(result.viewerData.project.projectTitle),
        new Blob([html], { type: 'text/html;charset=utf-8' }),
      );
    } catch (error) {
      setAppError(
        error instanceof Error
          ? `Failed to generate report: ${error.message}`
          : 'Failed to generate report due to an unknown error.',
      );
    } finally {
      setIsGeneratingReport(false);
    }
  };

  const setGroupFactor = (factorId: string) => {
    dispatch({ type: 'set_group_factor', factorId });
  };

  const setBatchFactor = (factorId: string) => {
    dispatch({ type: 'set_batch_factor', factorId });
  };

  const updateSampleGroup = (sampleId: string, value: GeoGroupAssignment) => {
    dispatch({ type: 'update_sample_group', sampleId, value });
  };

  const updateSampleBatch = (sampleId: string, value: string) => {
    dispatch({ type: 'update_sample_batch', sampleId, value });
  };

  const assignFilteredGroup = (value: GeoGroupAssignment) => {
    if (!designSession || !filteredSampleIds.length) {
      return;
    }
    dispatch({ type: 'assign_filtered_group', sampleIds: filteredSampleIds, value });
  };

  const assignFilteredBatch = () => {
    const value = bulkBatchValue.trim();
    if (!designSession || designSession.batchFactorId === NO_BATCH_FACTOR || !filteredSampleIds.length || !value) {
      return;
    }
    dispatch({ type: 'assign_filtered_batch', sampleIds: filteredSampleIds, value });
  };

  const binaryGroupFactors = designSession
    ? designSession.preview.factors.filter((factor) => Boolean(factor.orderedBinaryValues))
    : [];
  const isBatchEnabled = Boolean(designSession && designSession.batchFactorId !== NO_BATCH_FACTOR);
  const isReportDownloadDisabled =
    !result?.viewerData || isDirtySinceLastRun || isGeneratingReport || isParsing || isPreparingDesign;

  return (
    <main className="page-shell">
      <section className="hero-card launch-card">
        <div className="launch-header">
          <p className="eyebrow">Pathway Network Viewer</p>
          <h1>Search GEO or upload private data, then configure groups and batch in-browser</h1>
          <p className="hero-copy">
            Publication-focused workflow: discovery, sample assignment, pathway analysis, and
            standalone <code>report.html</code> export.
          </p>
        </div>

        <div className="mode-toggle" role="group" aria-label="Analysis mode">
          <button
            type="button"
            aria-pressed={mode === 'public'}
            className={`mode-chip ${mode === 'public' ? 'is-active' : ''}`}
            onClick={() => setMode('public')}
            disabled={isParsing || isPreparingDesign || isGeneratingReport}
          >
            Search - GSE analysis
          </button>
          <button
            type="button"
            aria-pressed={mode === 'private'}
            className={`mode-chip ${mode === 'private' ? 'is-active' : ''}`}
            onClick={() => setMode('private')}
            disabled={isParsing || isPreparingDesign || isGeneratingReport}
          >
            Private analysis
          </button>
        </div>

        {mode === 'public' ? (
          <div className="launch-search-block">
            <div className="launch-search-row">
              <input
                className="launch-search-input"
                type="text"
                value={geoQuery}
                placeholder="Search human GEO studies (example: GSE157951 or psoriasis skin)"
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoQuery(event.target.value);
                }}
                onKeyDown={(event) => {
                  if (event.key !== 'Enter') {
                    return;
                  }
                  event.preventDefault();
                  void handleSearchGeo();
                }}
              />
              <button
                className="primary-button"
                disabled={isGeoSearching || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  void handleSearchGeo();
                }}
              >
                {isGeoSearching ? 'Searching…' : 'Search GEO'}
              </button>
            </div>
            <p className="muted-text">
              Filtered to <strong>human</strong> studies with <strong>NCBI-generated raw counts</strong>.
            </p>
            {geoSearchSummary && (
              <p className="muted-text">
                Search hits: <strong>{geoSearchSummary.rawHitCount.toLocaleString()}</strong> raw GEO series ·{' '}
                <strong>{geoSearchSummary.eligibleCount.toLocaleString()}</strong> eligible ·{' '}
                <strong>{geoSearchSummary.excludedCount.toLocaleString()}</strong> excluded by builder constraints
              </p>
            )}
          </div>
        ) : (
          <div className="private-intake-grid">
            <label className="file-input-field">
              <span>Raw counts file</span>
              <input
                type="file"
                accept=".tsv,.txt,.gz"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoRawCountsFile(event.target.files?.[0] ?? null);
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Series matrix file</span>
              <input
                type="file"
                accept=".txt,.tsv,.gz"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoSeriesMatrixFile(event.target.files?.[0] ?? null);
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Accession (optional)</span>
              <input
                type="text"
                value={geoAccessionInput}
                placeholder="GSE157951"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoAccessionInput(event.target.value);
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Project title (optional)</span>
              <input
                type="text"
                value={geoTitleInput}
                placeholder="Psoriasis RNA-seq"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoTitleInput(event.target.value);
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Organism</span>
              <input
                type="text"
                value={geoOrganismInput}
                placeholder="human"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGeoOrganismInput(event.target.value);
                }}
              />
            </label>
            <div className="private-intake-actions">
              <button
                className="primary-button"
                disabled={!geoRawCountsFile || !geoSeriesMatrixFile || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  void handlePreparePrivateDesign();
                }}
              >
                {isPreparingDesign && activeGeoActionKey === 'setup:files'
                  ? 'Preparing setup…'
                  : 'Prepare sample setup'}
              </button>
            </div>
          </div>
        )}

        {geoError && <p className="issue warning">{geoError}</p>}
      </section>

      {mode === 'public' && geoResults.length > 0 && (
        <section className="panel geo-panel">
          <h2>GEO datasets</h2>
          <div className="geo-results">
            {geoResults.map((dataset) => (
              <article className="geo-result-card" key={dataset.accession}>
                <div className="geo-result-head">
                  <strong>{dataset.accession}</strong>
                  <span className={`status-tag ${dataset.isEligible ? 'status-tag-ok' : 'status-tag-muted'}`}>
                    {dataset.isEligible ? 'Eligible for builder analysis' : dataset.eligibilityReason || 'Excluded'}
                  </span>
                </div>
                <p className="geo-result-title">{dataset.title}</p>
                <p className="muted-text">{dataset.summary || 'No abstract summary available.'}</p>
                <p className="muted-text">
                  {dataset.organism} · {dataset.sampleCount.toLocaleString()} samples
                  {dataset.pubmedId ? ` · PMID ${dataset.pubmedId}` : ''}
                </p>
                <div className="geo-result-actions">
                  <button
                    className="file-button"
                    disabled={!dataset.isEligible || isParsing || isPreparingDesign || isGeneratingReport}
                    onClick={() => {
                      void handlePrepareGeoDesignFromNcbi(dataset);
                    }}
                  >
                    {!dataset.isEligible
                      ? 'Excluded from builder'
                      : isPreparingDesign && activeGeoActionKey === `setup:${dataset.accession}`
                        ? 'Loading samples…'
                        : 'Select and setup'}
                  </button>
                  <a className="link-button" href={dataset.geoUrl} target="_blank" rel="noreferrer">
                    Open GEO
                  </a>
                </div>
              </article>
            ))}
          </div>
        </section>
      )}

      {designSession && (
        <section className="panel design-panel">
          <div className="panel-header">
            <div>
              <h2>Sample group and batch setup</h2>
              <p className="muted-text">
                {designSession.source === 'ncbi'
                  ? `${designSession.dataset?.accession ?? 'GEO'} selected`
                  : 'Private files selected'}
                {' · '}
                A={groupCounts.A} / B={groupCounts.B} / Excluded={groupCounts.excluded}
              </p>
            </div>
            <div className="panel-actions">
              <button
                className="secondary-button"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  void handleRunConfiguredAnalysis();
                }}
              >
                {isParsing && activeGeoActionKey === 'run:analysis' ? 'Analyzing…' : 'Run pathway analysis'}
              </button>
              <button
                className="secondary-button"
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => {
                  dispatch({ type: 'reset' });
                  setActiveGeoActionKey('');
                  setAppError('');
                  setGeoError('');
                }}
              >
                Reset setup
              </button>
              <button
                className="file-button"
                onClick={() => {
                  void handleGenerateReport();
                }}
                disabled={isReportDownloadDisabled}
              >
                {isGeneratingReport
                  ? 'Generating report…'
                  : isDirtySinceLastRun
                    ? 'Rerun analysis to export'
                    : 'Download report.html'}
              </button>
            </div>
          </div>

          {isDirtySinceLastRun && (
            <p className="issue warning">
              Current sample setup has changed since the last analysis run. Re-run pathway analysis before exporting
              a report.
            </p>
          )}

          <div className="design-controls-grid">
            <label className="file-input-field">
              <span>Condition A label</span>
              <input
                type="text"
                value={designSession.conditionA}
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  dispatch({ type: 'set_condition_label', key: 'A', value: event.target.value });
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Condition B label</span>
              <input
                type="text"
                value={designSession.conditionB}
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  dispatch({ type: 'set_condition_label', key: 'B', value: event.target.value });
                }}
              />
            </label>
            <label className="file-input-field">
              <span>Group factor (binary)</span>
              <select
                value={designSession.groupFactorId}
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setGroupFactor(event.target.value);
                }}
              >
                {binaryGroupFactors.map((factor) => (
                  <option key={factor.id} value={factor.id}>
                    {factor.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="file-input-field">
              <span>Batch factor (optional)</span>
              <select
                value={designSession.batchFactorId}
                disabled={isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  setBatchFactor(event.target.value);
                }}
              >
                <option value={NO_BATCH_FACTOR}>No batch adjustment</option>
                {designSession.preview.factors.map((factor) => (
                  <option key={factor.id} value={factor.id}>
                    {factor.label} ({factor.uniqueValues.length} levels)
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="bulk-tools">
            <input
              className="geo-search-input"
              type="text"
              value={sampleFilter}
              placeholder="Filter samples by ID/title/metadata"
              disabled={isParsing || isPreparingDesign || isGeneratingReport}
              onChange={(event) => {
                dispatch({ type: 'set_sample_filter', value: event.target.value });
              }}
            />
            <div className="bulk-actions">
              <button
                className="secondary-button"
                disabled={!filteredSampleIds.length || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => assignFilteredGroup('A')}
              >
                Filtered -&gt; A
              </button>
              <button
                className="secondary-button"
                disabled={!filteredSampleIds.length || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => assignFilteredGroup('B')}
              >
                Filtered -&gt; B
              </button>
              <button
                className="secondary-button"
                disabled={!filteredSampleIds.length || isParsing || isPreparingDesign || isGeneratingReport}
                onClick={() => assignFilteredGroup('')}
              >
                Filtered -&gt; Exclude
              </button>
            </div>
            <div className="bulk-batch-row">
              <input
                className="geo-search-input"
                type="text"
                value={bulkBatchValue}
                placeholder="Batch label for filtered samples (example: Batch_2)"
                disabled={!isBatchEnabled || isParsing || isPreparingDesign || isGeneratingReport}
                onChange={(event) => {
                  dispatch({ type: 'set_bulk_batch_value', value: event.target.value });
                }}
              />
              <button
                className="secondary-button"
                disabled={
                  !isBatchEnabled ||
                  !filteredSampleIds.length ||
                  !bulkBatchValue.trim() ||
                  isParsing ||
                  isPreparingDesign ||
                  isGeneratingReport
                }
                onClick={assignFilteredBatch}
              >
                Apply batch label
              </button>
            </div>
            {!isBatchEnabled && (
              <p className="muted-text">Batch adjustment is off. Select a batch factor to enable batch labels.</p>
            )}
          </div>

          <div className="design-table-wrap">
            <div className="design-table">
              <div className="design-row design-head">
                <span>Sample</span>
                <span>Title</span>
                <span>Group</span>
                <span>Batch</span>
              </div>
              {visibleSampleIds.map((sampleId) => (
                <div className="design-row" key={sampleId}>
                  <span>{sampleId}</span>
                  <span>{designSession.preview.sampleTitles[sampleId] || '-'}</span>
                  <span>
                    <select
                      value={designSession.groupBySample[sampleId] ?? ''}
                      disabled={isParsing || isPreparingDesign || isGeneratingReport}
                      onChange={(event) => {
                        updateSampleGroup(sampleId, event.target.value as GeoGroupAssignment);
                      }}
                    >
                      <option value="A">A ({designSession.conditionA || 'Condition A'})</option>
                      <option value="B">B ({designSession.conditionB || 'Condition B'})</option>
                      <option value="">Exclude</option>
                    </select>
                  </span>
                  <span>
                    <input
                      type="text"
                      value={designSession.batchBySample[sampleId] ?? ''}
                      placeholder="Batch_1"
                      disabled={!isBatchEnabled || isParsing || isPreparingDesign || isGeneratingReport}
                      onChange={(event) => {
                        updateSampleBatch(sampleId, event.target.value);
                      }}
                    />
                  </span>
                </div>
              ))}
            </div>
            {filteredSampleIds.length > MAX_VISIBLE_SAMPLE_ROWS && (
              <p className="muted-text table-footnote">
                Showing first {MAX_VISIBLE_SAMPLE_ROWS.toLocaleString()} of{' '}
                {filteredSampleIds.length.toLocaleString()} filtered samples. Use the filter box for faster
                large-cohort editing.
              </p>
            )}
          </div>
        </section>
      )}

      <section className="grid-layout">
        <article className="panel">
          <h2>Data routes</h2>
          <ul className="compact-list">
            <li>
              Public route: search GEO, pick human dataset with NCBI-generated raw counts, assign groups/batch,
              run analysis.
            </li>
            <li>
              Private route: upload raw counts + series matrix, assign groups/batch, run analysis in browser.
            </li>
            <li>
              For large cohorts, filter + bulk assign tools speed up manual editing.
            </li>
            <li>
              Memory guard: very large matrices are stopped early with guidance for high-memory DESeq2 execution.
            </li>
          </ul>
        </article>

        <article className="panel">
          <h2>Built-in reference assets</h2>
          <div className="stats-grid">
            <div className="stat-card">
              <span>Reactome pathways</span>
              <strong>{referenceSummary.reactomePathways.toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>Hallmark pathways</span>
              <strong>{referenceSummary.hallmarkPathways.toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>PPI genes</span>
              <strong>{referenceSummary.ppiGenes.toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>PPI edges (total)</span>
              <strong>{referenceSummary.ppiEdges.toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>STRING edges</span>
              <strong>{(referenceSummary.stringPpiEdges ?? referenceSummary.ppiEdges).toLocaleString()}</strong>
            </div>
            <div className="stat-card">
              <span>HuRI edges</span>
              <strong>{(referenceSummary.huriPpiEdges ?? 0).toLocaleString()}</strong>
            </div>
          </div>
          <p className="muted-text">
            Hallmark mode: <strong>{referenceSummary.hallmarkMode}</strong> · STRING cutoff:{' '}
            <strong>{referenceSummary.stringScoreCutoff}</strong>
          </p>
        </article>
      </section>

      <section className="panel result-panel">
        <div className="panel-header">
          <div>
            <h2>Analysis snapshot</h2>
            <p className="muted-text">
              {loadedFileName ? `Latest run: ${loadedFileName}` : 'Run analysis to generate pathway results.'}
            </p>
          </div>
          {result?.viewerData ? (
            <button
              className="file-button"
              onClick={() => {
                void handleGenerateReport();
              }}
              disabled={isReportDownloadDisabled}
            >
              {isGeneratingReport
                ? 'Generating report…'
                : isDirtySinceLastRun
                  ? 'Rerun analysis to export'
                  : 'Download report.html'}
            </button>
          ) : null}
        </div>

        {isParsing && (
          <p className="status-pill" aria-live="polite">
            Running analysis…
          </p>
        )}
        {!isParsing && result && isDirtySinceLastRun && (
          <p className="issue warning">
            The visible design draft no longer matches the last analysis snapshot. Run analysis again before using
            or exporting these results.
          </p>
        )}
        {!isParsing && appError && <p className="issue error">{appError}</p>}

        {!isParsing && !result && (
          <p className="empty-state">
            Start from GEO search or private uploads, configure sample grouping/batch, and run analysis.
          </p>
        )}

        {result && (
          <>
            <div className="stats-grid">
              <div className="stat-card">
                <span>Genes</span>
                <strong>{result.summary.totalGenes.toLocaleString()}</strong>
              </div>
              <div className="stat-card">
                <span>Pathways</span>
                <strong>{result.summary.totalPathways.toLocaleString()}</strong>
              </div>
              <div className="stat-card">
                <span>Significant pathways</span>
                <strong>{result.summary.significantPathways.toLocaleString()}</strong>
              </div>
              <div className="stat-card">
                <span>Leading-edge fallback</span>
                <strong>{result.summary.fallbackPathways.toLocaleString()}</strong>
              </div>
            </div>

            <div className="issues-block">
              <h3>Validation report</h3>
              <ul className="issue-list">
                {result.issues.length ? (
                  result.issues.map((issue, index) => (
                    <li key={`${issue.message}-${index}`} className={`issue ${issue.level}`}>
                      <strong>{issue.level.toUpperCase()}</strong> {issue.message}
                      {issue.context ? <span> · {issue.context}</span> : null}
                    </li>
                  ))
                ) : (
                  <li className="issue success">No validation issues detected.</li>
                )}
              </ul>
            </div>

            {result.viewerData && (
              <div className="pathway-preview">
                <h3>Top pathways</h3>
                <div className="preview-table">
                  <div className="preview-row preview-head">
                    <span>Pathway</span>
                    <span>Collection</span>
                    <span>NES</span>
                    <span>FDR</span>
                    <span>Genes</span>
                  </div>
                  {result.viewerData.pathways.slice(0, 8).map((pathway) => (
                    <div className="preview-row" key={pathway.key}>
                      <span>{pathway.pathwayName}</span>
                      <span>{pathway.collection}</span>
                      <span>{pathway.nes.toFixed(2)}</span>
                      <span>{pathway.padj.toExponential(2)}</span>
                      <span>{pathway.allGenes.length}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
