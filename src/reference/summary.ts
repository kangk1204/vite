import metadata from './generated/metadata.json';
import type { ReferenceSummary } from '../types';

const summary = metadata as ReferenceSummary;

export function getReferenceSummaryLite(): ReferenceSummary {
  return summary;
}
