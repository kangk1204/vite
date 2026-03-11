import { describe, expect, it } from 'vitest';
import {
  createDesignSession,
  createInitialDraftAnalysisState,
  draftAnalysisReducer,
} from '../src/lib/builderState';
import type { WorkbookParseResult } from '../src/types';
import type { GeoSeriesDesignPreview } from '../src/lib/geo';

function makePreview(): GeoSeriesDesignPreview {
  return {
    sampleIds: ['S1', 'S2', 'S3', 'S4'],
    sampleTitles: {
      S1: 'Control 1',
      S2: 'Control 2',
      S3: 'Treated 1',
      S4: 'Treated 2',
    },
    factors: [
      {
        id: 'characteristic:group',
        label: 'Group',
        uniqueValues: ['control', 'treated'],
        orderedBinaryValues: ['control', 'treated'],
        valuesBySample: {
          S1: 'control',
          S2: 'control',
          S3: 'treated',
          S4: 'treated',
        },
      },
    ],
    defaultGroupFactorId: 'characteristic:group',
    defaultConditionA: 'control',
    defaultConditionB: 'treated',
    defaultGroupBySample: {
      S1: 'A',
      S2: 'A',
      S3: 'B',
      S4: 'B',
    },
  };
}

function makeResult(): WorkbookParseResult {
  return {
    viewerData: null,
    issues: [],
    summary: {
      totalGenes: 0,
      totalPathways: 0,
      significantPathways: 0,
      fallbackPathways: 0,
      unknownGenes: 0,
    },
  };
}

describe('draftAnalysisReducer', () => {
  it('marks analysis results stale after design edits', () => {
    const session = createDesignSession(makePreview(), 'ncbi');
    let state = createInitialDraftAnalysisState();
    state = draftAnalysisReducer(state, {
      type: 'setup_session',
      session,
      loadedFileName: 'GSE100 (setup ready)',
    });
    state = draftAnalysisReducer(state, {
      type: 'set_analysis_result',
      result: makeResult(),
      loadedFileName: 'GSE100 (configured analysis)',
    });

    expect(state.isDirtySinceLastRun).toBe(false);

    state = draftAnalysisReducer(state, {
      type: 'set_condition_label',
      key: 'B',
      value: 'Cancer',
    });

    expect(state.isDirtySinceLastRun).toBe(true);
  });

  it('clears dirty state after a rerun stores a fresh analysis snapshot', () => {
    const session = createDesignSession(makePreview(), 'files');
    let state = createInitialDraftAnalysisState();
    state = draftAnalysisReducer(state, {
      type: 'setup_session',
      session,
      loadedFileName: 'files (setup ready)',
    });
    state = draftAnalysisReducer(state, {
      type: 'set_analysis_result',
      result: makeResult(),
      loadedFileName: 'files (configured analysis)',
    });
    state = draftAnalysisReducer(state, {
      type: 'update_sample_group',
      sampleId: 'S4',
      value: '',
    });

    expect(state.isDirtySinceLastRun).toBe(true);

    state = draftAnalysisReducer(state, {
      type: 'set_analysis_result',
      result: makeResult(),
      loadedFileName: 'files (configured analysis rerun)',
    });

    expect(state.isDirtySinceLastRun).toBe(false);
  });
});
