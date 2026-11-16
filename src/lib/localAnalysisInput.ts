import { alignGeoInputSamples, parseGeoTabLine, previewGeoSeriesDesignFromText, type AnalyzeGeoFromTextOptions } from './geo';
import { slugify } from './utils';

export interface LocalAnalysisInput {
  schemaVersion: 1;
  kind: 'pnv-local-analysis-input';
  project: { title: string; accession: string; organism: string; conditionA: string; conditionB: string };
  rawCountsText: string;
  seriesMatrixText: string;
  design: {
    groupBySample: Record<string, 'A' | 'B' | 'U'>;
    batchBySample?: Record<string, string>;
    batchFactorName?: string;
  };
}

const MAX_INPUT_TEXT_LENGTH = 128 * 1024 * 1024;
const MAX_SAMPLES = 1500;
const MAX_MATRIX_CELLS = 45_000_000;

function validateCountMatrix(text: string): string[] {
  if (text.length > MAX_INPUT_TEXT_LENGTH) {
    throw new Error('Input exceeds browser memory limits. Prepare this analysis directly in local R.');
  }
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) throw new Error('Raw counts file must contain a header and gene rows.');
  const sampleIds = parseGeoTabLine(lines[0]).slice(1);
  if (sampleIds.length > MAX_SAMPLES || sampleIds.length * (lines.length - 1) > MAX_MATRIX_CELLS) {
    throw new Error('Matrix exceeds browser memory limits. Use the local R workflow directly.');
  }
  if (sampleIds.length < 2 || sampleIds.some((id) => !id) || new Set(sampleIds).size !== sampleIds.length) {
    throw new Error('Raw counts header has missing or duplicate sample IDs.');
  }
  for (let index = 1; index < lines.length; index += 1) {
    const fields = parseGeoTabLine(lines[index]);
    if (!fields[0] || fields.length !== sampleIds.length + 1) {
      throw new Error(`Raw counts row ${index + 1} does not match the sample header.`);
    }
    if (fields.slice(1).some((value) => !value || !Number.isSafeInteger(Number(value)) || Number(value) < 0)) {
      throw new Error(`Raw counts row ${index + 1} must contain non-negative integer counts.`);
    }
  }
  return sampleIds;
}

function prepareBatches(
  groups: LocalAnalysisInput['design']['groupBySample'],
  values: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
  if (!values) return undefined;
  const included = Object.keys(groups).filter((sample) => groups[sample] !== 'U');
  const entries = included.map((sample) => {
    const batch = values[sample]?.trim();
    if (!batch) throw new Error(`Missing batch value for included sample ${sample}.`);
    return [sample, batch] as const;
  });
  const batches = Object.fromEntries(entries);
  const levels = [...new Set(entries.map(([, batch]) => batch))];
  if (levels.length < 2) throw new Error('Batch adjustment requires at least two levels. Disable batch to use a group-only model.');
  const mixedLevelExists = levels.some((level) => new Set(included.filter((sample) => batches[sample] === level).map((sample) => groups[sample])).size === 2);
  if (!mixedLevelExists) throw new Error('Batch is fully confounded with group; the requested contrast cannot be estimated.');
  if (included.length <= levels.length + 1) throw new Error('Batch and group leave no residual degrees of freedom. Use more biological replicates or a scientifically justified simpler design.');
  return batches;
}

/** Validates and preserves inputs; it never computes inferential statistics. */
export function createLocalAnalysisInput(options: AnalyzeGeoFromTextOptions): LocalAnalysisInput {
  const rawSampleIds = validateCountMatrix(options.rawCountsText);
  if (options.seriesMatrixText.length > MAX_INPUT_TEXT_LENGTH) throw new Error('Metadata exceeds browser memory limits.');
  const preview = previewGeoSeriesDesignFromText(options.seriesMatrixText);
  const organism = options.organism?.trim() || 'human';
  if (!/^(human|homo sapiens)$/i.test(organism)) throw new Error('This analysis workflow supports human RNA-seq only.');
  const conditionA = options.design?.conditionA?.trim() || preview.defaultConditionA;
  const conditionB = options.design?.conditionB?.trim() || preview.defaultConditionB;
  if (conditionA === conditionB) throw new Error('Condition labels must be different.');
  const assignments = options.design?.groupBySample ?? preview.defaultGroupBySample;
  const groupBySample = Object.fromEntries(preview.sampleIds.map((sample) => {
    if (!Object.hasOwn(assignments, sample)) throw new Error(`Missing group assignment for ${sample}.`);
    const assignment = assignments[sample];
    if (assignment !== 'A' && assignment !== 'B' && assignment !== '') throw new Error(`Invalid group assignment for ${sample}.`);
    return [sample, assignment || 'U'];
  })) as LocalAnalysisInput['design']['groupBySample'];
  const alignment = alignGeoInputSamples(options.seriesMatrixText, rawSampleIds);
  const unresolvedIncluded = alignment.unresolvedSeriesSampleIds.filter((sample) => groupBySample[sample] !== 'U');
  if (unresolvedIncluded.length) throw new Error(`Cannot align included metadata sample ${unresolvedIncluded[0]} to a unique raw-count column.`);
  for (const group of ['A', 'B']) {
    if (Object.values(groupBySample).filter((value) => value === group).length < 2) {
      throw new Error('Assign at least 2 biological samples to each group.');
    }
  }
  const batchBySample = prepareBatches(groupBySample, options.design?.batchBySample);
  return {
    schemaVersion: 1, kind: 'pnv-local-analysis-input',
    project: { title: options.title?.trim() || 'Local RNA-seq analysis', accession: options.accession?.trim() || 'USER_DATA', organism, conditionA, conditionB },
    rawCountsText: options.rawCountsText, seriesMatrixText: options.seriesMatrixText,
    design: { groupBySample, ...(batchBySample ? { batchBySample, batchFactorName: options.design?.batchFactorName?.trim() || 'batch' } : {}) },
  };
}

export function localAnalysisInputFilename(accession: string): string {
  return `${slugify(accession) || 'local-analysis'}.local-analysis.json`;
}
