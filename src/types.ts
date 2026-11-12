export type ValidationLevel = 'error' | 'warning' | 'info';

export interface ValidationIssue {
  level: ValidationLevel;
  message: string;
  context?: string;
}

export interface ProjectMeta {
  projectTitle: string;
  contrastName: string;
  conditionA: string;
  conditionB: string;
  species: string;
}

export interface ViewerProvenance {
  datasetIdentifier?: string;
  contrastDefinition?: string;
  sampleGroupSource?: string;
  batchHandlingRule?: string;
  analysisTimestamp?: string;
  gitCommit?: string;
  referenceAssetVersion?: string;
  notes?: string;
}

export type ViewerSampleGroupKey = 'A' | 'B' | 'U';

export interface ViewerSampleMeta {
  id: string;
  label?: string;
  groupKey?: ViewerSampleGroupKey;
  groupLabel?: string;
  batch?: string;
}

export interface GeneRecord {
  symbol: string;
  originalSymbol: string;
  log2fc: number | null;
  padj: number | null;
  pvalue: number | null;
  rankMetric: number | null;
  conditionAMean: number | null;
  conditionBMean: number | null;
  statisticsReason?: string;
  sampleValues: Record<string, number>;
  label?: string;
  labelPriority?: number;
}

export interface PathwayRecord {
  key: string;
  pathwayId?: string;
  pathwayName: string;
  searchNameNormalized?: string;
  collection: string;
  nes: number | null;
  padj: number | null;
  statisticsReason?: string;
  source?: { table: string; row: number };
  leadingEdgeGenes: string[];
  allGenes: string[];
  hasReferenceMembership: boolean;
  fallbackToLeadingEdge: boolean;
  missingGenes: string[];
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  edgeIndices?: number[];
  enrichment: EnrichmentCurve;
}

export interface ViewerNode {
  id: string;
  originalId?: string;
  label: string;
  labelPriority: number;
  log2fc: number | null;
  padj: number | null;
  pvalue: number | null;
  sizeMetric: number;
  conditionAMean: number | null;
  conditionBMean: number | null;
  statisticsReason?: string;
  sampleValues: Record<string, number>;
  isLeadingEdge: boolean;
}

export interface ViewerEdge {
  source: string;
  target: string;
  score: number;
  isCustom?: boolean;
  isString?: boolean;
  isHuRI?: boolean;
}

export interface EnrichmentPoint {
  index: number;
  value: number;
  gene?: string;
  isHit?: boolean;
}

export interface EnrichmentCurve {
  representation?: 'ranked-hits-v1';
  unavailableReason?: string;
  es?: number | null;
  validation?: 'matches_recorded_es' | 'reconstructed_unverified' | 'unavailable';
  points: EnrichmentPoint[];
  hitIndices: number[];
  maxAbsValue: number;
}

export type VerificationStatus = 'verified_against_supplied_artifacts' | 'internally_consistent' | 'unverifiable' | 'mismatch';

export interface ReportEvidence {
  runId: string | null;
  rankedGenes?: Array<{ gene: string; metric: number }>;
  analysis: {
    method: string;
    versions: Record<string, string>;
    contrast: { conditionA: string; conditionB: string };
    designFormula: string | null;
    seed: number | null;
    alpha: number | null;
    geneHypothesisCount: number | null;
    pathwayHypothesisCount: number | null;
    filterRule: string | null;
    rankMetric: string | null;
    lfcMethod: string | null;
    adjustment: string | null;
  };
  verification: {
    status: VerificationStatus;
    checks: Array<{ id: string; status: 'pass' | 'fail' | 'unknown'; message: string }>;
    limitations: string[];
  };
  artifacts: Array<{ role: string; path: string; sha256: string; sizeBytes: number }>;
  pathways: Record<string, {
    testedGenes?: string[];
    testedSize?: number;
    originalEs?: number | null;
    camera?: { pvalue: number | null; padj: number | null; direction: string | null };
    designSensitivity?: Array<{ designFormula: string; nes: number | null; padj: number | null; source?: { table: string; row: number } }>;
    bootstrap?: {
      requested: number; valid: number; selected: number; directionMatches: number | null;
      selectionFrequency: number | null; directionConsistency: number | null;
      validFraction: number; warning: string | null;
    };
    source?: { table: string; row: number };
  }>;
  sourceTables?: Record<string, { columns: string[]; rows: Array<Array<string | number | null>> }>;
}

export interface ViewerData {
  schemaVersion?: 1 | 2;
  evidence?: ReportEvidence;
  reportCondition?: 'full' | 'basic';
  rankedGenes?: Array<{ gene: string; metric: number }>;
  sharedEdges?: ViewerEdge[];
  sampleValuesByGene?: Record<string, Record<string, number>>;
  project: ProjectMeta;
  builtAt: string;
  significantPadjThreshold: number;
  referenceSummary: ReferenceSummary;
  provenance?: ViewerProvenance;
  issues: ValidationIssue[];
  pathways: PathwayRecord[];
  samplesById?: Record<string, ViewerSampleMeta>;
}

export interface WorkbookParseResult {
  viewerData: ViewerData | null;
  issues: ValidationIssue[];
  summary: BuilderSummary;
}

export interface BuilderSummary {
  totalGenes: number;
  totalPathways: number;
  significantPathways: number;
  fallbackPathways: number;
  unknownGenes: number;
}

export interface ReferenceSummary {
  reactomePathways: number;
  hallmarkPathways: number;
  ppiGenes: number;
  ppiEdges: number;
  stringPpiGenes?: number;
  stringPpiEdges?: number;
  huriPpiGenes?: number;
  huriPpiEdges?: number;
  hallmarkMode: string;
  stringScoreCutoff: number;
}

export interface ReferencePathway {
  id: string;
  name: string;
  collection: string;
  genes: string[];
}

export interface ReferencePathwayIndex {
  byId: Record<string, ReferencePathway>;
  byKey: Record<string, string>;
}

export interface ExportPreset {
  key: string;
  label: string;
  widthInches: number;
  heightInches: number;
}
