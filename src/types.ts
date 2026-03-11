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
  log2fc: number;
  padj: number;
  pvalue: number;
  rankMetric: number;
  conditionAMean: number;
  conditionBMean: number;
  sampleValues: Record<string, number>;
  label?: string;
  labelPriority?: number;
}

export interface PathwayRecord {
  key: string;
  pathwayId?: string;
  pathwayName: string;
  collection: string;
  nes: number;
  padj: number;
  leadingEdgeGenes: string[];
  allGenes: string[];
  hasReferenceMembership: boolean;
  fallbackToLeadingEdge: boolean;
  missingGenes: string[];
  nodes: ViewerNode[];
  edges: ViewerEdge[];
  enrichment: EnrichmentCurve;
}

export interface ViewerNode {
  id: string;
  label: string;
  labelPriority: number;
  log2fc: number;
  padj: number;
  pvalue: number;
  sizeMetric: number;
  conditionAMean: number;
  conditionBMean: number;
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
  points: EnrichmentPoint[];
  hitIndices: number[];
  maxAbsValue: number;
}

export interface ViewerData {
  project: ProjectMeta;
  builtAt: string;
  significantPadjThreshold: number;
  referenceSummary: ReferenceSummary;
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
