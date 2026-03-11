import type {
  GeoGroupAssignment,
  GeoSearchResult,
  GeoSeriesDesignPreview,
  GeoSeriesFactorOption,
} from './geo';
import type { WorkbookParseResult } from '../types';

export type IntakeMode = 'public' | 'private';
export type DesignSource = 'ncbi' | 'files';

export interface DesignSession {
  source: DesignSource;
  preview: GeoSeriesDesignPreview;
  dataset?: GeoSearchResult;
  rawCountsFile?: File;
  seriesMatrixFile?: File;
  accession?: string;
  title?: string;
  organism?: string;
  groupFactorId: string;
  batchFactorId: string;
  conditionA: string;
  conditionB: string;
  groupBySample: Record<string, GeoGroupAssignment>;
  batchBySample: Record<string, string>;
}

export interface DraftAnalysisState {
  designSession: DesignSession | null;
  result: WorkbookParseResult | null;
  loadedFileName: string;
  sampleFilter: string;
  bulkBatchValue: string;
  analysisSignature: string;
  isDirtySinceLastRun: boolean;
}

export const NO_BATCH_FACTOR = '__none__';
export const MAX_VISIBLE_SAMPLE_ROWS = 320;

type DraftAnalysisAction =
  | { type: 'setup_session'; session: DesignSession; loadedFileName: string }
  | { type: 'reset' }
  | { type: 'set_analysis_result'; result: WorkbookParseResult; loadedFileName: string }
  | { type: 'set_sample_filter'; value: string }
  | { type: 'set_bulk_batch_value'; value: string }
  | { type: 'set_group_factor'; factorId: string }
  | { type: 'set_batch_factor'; factorId: string }
  | { type: 'set_condition_label'; key: 'A' | 'B'; value: string }
  | { type: 'update_sample_group'; sampleId: string; value: GeoGroupAssignment }
  | { type: 'update_sample_batch'; sampleId: string; value: string }
  | { type: 'assign_filtered_group'; sampleIds: string[]; value: GeoGroupAssignment }
  | { type: 'assign_filtered_batch'; sampleIds: string[]; value: string };

export function findFactorById(
  preview: GeoSeriesDesignPreview,
  factorId: string,
): GeoSeriesFactorOption | undefined {
  return preview.factors.find((factor) => factor.id === factorId);
}

export function createDesignSession(
  preview: GeoSeriesDesignPreview,
  source: DesignSource,
  options: {
    dataset?: GeoSearchResult;
    rawCountsFile?: File;
    seriesMatrixFile?: File;
    accession?: string;
    title?: string;
    organism?: string;
  } = {},
): DesignSession {
  const defaultBatchFactor = preview.defaultBatchFactorId
    ? findFactorById(preview, preview.defaultBatchFactorId)
    : undefined;
  const batchBySample: Record<string, string> = {};
  for (const sampleId of preview.sampleIds) {
    batchBySample[sampleId] = defaultBatchFactor?.valuesBySample[sampleId] ?? '';
  }

  return {
    source,
    preview,
    dataset: options.dataset,
    rawCountsFile: options.rawCountsFile,
    seriesMatrixFile: options.seriesMatrixFile,
    accession: options.accession,
    title: options.title,
    organism: options.organism,
    groupFactorId: preview.defaultGroupFactorId,
    batchFactorId: preview.defaultBatchFactorId ?? NO_BATCH_FACTOR,
    conditionA: preview.defaultConditionA,
    conditionB: preview.defaultConditionB,
    groupBySample: { ...preview.defaultGroupBySample },
    batchBySample,
  };
}

export function applyGroupFactor(
  current: DesignSession,
  factorId: string,
): Pick<DesignSession, 'groupFactorId' | 'conditionA' | 'conditionB' | 'groupBySample'> {
  const factor = findFactorById(current.preview, factorId);
  if (!factor || !factor.orderedBinaryValues) {
    return {
      groupFactorId: factorId,
      conditionA: current.conditionA,
      conditionB: current.conditionB,
      groupBySample: current.groupBySample,
    };
  }

  const [conditionA, conditionB] = factor.orderedBinaryValues;
  const groupBySample: Record<string, GeoGroupAssignment> = {};
  for (const sampleId of current.preview.sampleIds) {
    const value = factor.valuesBySample[sampleId];
    if (value === conditionA) {
      groupBySample[sampleId] = 'A';
    } else if (value === conditionB) {
      groupBySample[sampleId] = 'B';
    } else {
      groupBySample[sampleId] = '';
    }
  }

  return {
    groupFactorId: factorId,
    conditionA,
    conditionB,
    groupBySample,
  };
}

export function applyBatchFactor(
  current: DesignSession,
  factorId: string,
): Pick<DesignSession, 'batchFactorId' | 'batchBySample'> {
  if (factorId === NO_BATCH_FACTOR) {
    return {
      batchFactorId: NO_BATCH_FACTOR,
      batchBySample: {},
    };
  }

  const factor = findFactorById(current.preview, factorId);
  if (!factor) {
    return {
      batchFactorId: NO_BATCH_FACTOR,
      batchBySample: {},
    };
  }

  const batchBySample: Record<string, string> = {};
  for (const sampleId of current.preview.sampleIds) {
    batchBySample[sampleId] = factor.valuesBySample[sampleId] ?? '';
  }

  return {
    batchFactorId: factorId,
    batchBySample,
  };
}

export function createInitialDraftAnalysisState(): DraftAnalysisState {
  return {
    designSession: null,
    result: null,
    loadedFileName: '',
    sampleFilter: '',
    bulkBatchValue: '',
    analysisSignature: '',
    isDirtySinceLastRun: false,
  };
}

export function computeDesignSignature(session: DesignSession): string {
  return JSON.stringify({
    source: session.source,
    groupFactorId: session.groupFactorId,
    batchFactorId: session.batchFactorId,
    conditionA: session.conditionA.trim(),
    conditionB: session.conditionB.trim(),
    groups: session.preview.sampleIds.map((sampleId) => [sampleId, session.groupBySample[sampleId] ?? '']),
    batches: session.preview.sampleIds.map((sampleId) => [sampleId, session.batchBySample[sampleId] ?? '']),
  });
}

function withUpdatedSession(
  state: DraftAnalysisState,
  nextSession: DesignSession,
  overrides: Partial<DraftAnalysisState> = {},
): DraftAnalysisState {
  const nextSignature = computeDesignSignature(nextSession);
  return {
    ...state,
    designSession: nextSession,
    isDirtySinceLastRun: Boolean(state.result && state.analysisSignature && nextSignature !== state.analysisSignature),
    ...overrides,
  };
}

export function draftAnalysisReducer(
  state: DraftAnalysisState,
  action: DraftAnalysisAction,
): DraftAnalysisState {
  switch (action.type) {
    case 'setup_session':
      return {
        ...createInitialDraftAnalysisState(),
        designSession: action.session,
        loadedFileName: action.loadedFileName,
      };
    case 'reset':
      return createInitialDraftAnalysisState();
    case 'set_analysis_result':
      return {
        ...state,
        result: action.result,
        loadedFileName: action.loadedFileName,
        analysisSignature: state.designSession ? computeDesignSignature(state.designSession) : '',
        isDirtySinceLastRun: false,
      };
    case 'set_sample_filter':
      return {
        ...state,
        sampleFilter: action.value,
      };
    case 'set_bulk_batch_value':
      return {
        ...state,
        bulkBatchValue: action.value,
      };
    case 'set_group_factor': {
      if (!state.designSession) {
        return state;
      }
      return withUpdatedSession(state, {
        ...state.designSession,
        ...applyGroupFactor(state.designSession, action.factorId),
      });
    }
    case 'set_batch_factor': {
      if (!state.designSession) {
        return state;
      }
      return withUpdatedSession(
        state,
        {
          ...state.designSession,
          ...applyBatchFactor(state.designSession, action.factorId),
        },
        action.factorId === NO_BATCH_FACTOR ? { bulkBatchValue: '' } : {},
      );
    }
    case 'set_condition_label': {
      if (!state.designSession) {
        return state;
      }
      return withUpdatedSession(state, {
        ...state.designSession,
        conditionA: action.key === 'A' ? action.value : state.designSession.conditionA,
        conditionB: action.key === 'B' ? action.value : state.designSession.conditionB,
      });
    }
    case 'update_sample_group': {
      if (!state.designSession) {
        return state;
      }
      return withUpdatedSession(state, {
        ...state.designSession,
        groupBySample: {
          ...state.designSession.groupBySample,
          [action.sampleId]: action.value,
        },
      });
    }
    case 'update_sample_batch': {
      if (!state.designSession) {
        return state;
      }
      return withUpdatedSession(state, {
        ...state.designSession,
        batchBySample: {
          ...state.designSession.batchBySample,
          [action.sampleId]: action.value,
        },
      });
    }
    case 'assign_filtered_group': {
      if (!state.designSession || !action.sampleIds.length) {
        return state;
      }
      const groupBySample = { ...state.designSession.groupBySample };
      action.sampleIds.forEach((sampleId) => {
        groupBySample[sampleId] = action.value;
      });
      return withUpdatedSession(state, {
        ...state.designSession,
        groupBySample,
      });
    }
    case 'assign_filtered_batch': {
      if (!state.designSession || !action.sampleIds.length || !action.value.trim()) {
        return state;
      }
      const batchBySample = { ...state.designSession.batchBySample };
      action.sampleIds.forEach((sampleId) => {
        batchBySample[sampleId] = action.value;
      });
      return withUpdatedSession(state, {
        ...state.designSession,
        batchBySample,
      });
    }
    default:
      return state;
  }
}
