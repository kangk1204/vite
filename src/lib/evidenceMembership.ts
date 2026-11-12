import type { EnrichmentCurve, PathwayRecord, ReportEvidence, ViewerData, ViewerNode } from '../types';

type Ranking = NonNullable<ViewerData['rankedGenes']>;
type SourceTable = NonNullable<ReportEvidence['sourceTables']>[string];

/** The fgsea standard score, calculated at hit tops/bottoms without display rounding. */
export function enrichmentFromHits(ranking: Ranking, hitIndices: number[]): EnrichmentCurve {
  const hits = [...hitIndices].sort((a, b) => a - b);
  const n = ranking.length, m = hits.length;
  if (new Set(hits).size !== m || hits.some(index => !Number.isInteger(index) || index < 1 || index > n)) throw new Error('Invalid exact enrichment hit indices.');
  if (!m || m === n) return { representation: 'ranked-hits-v1', points: [], hitIndices: hits, maxAbsValue: 0, es: null,
    unavailableReason: m ? 'GSEA ES is undefined when every ranked gene belongs to the set.' : 'No tested pathway genes occur in the rank universe.' };
  const weights = hits.map(index => Math.abs(ranking[index - 1].metric));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  let cumulative = 0, maximum = -Infinity, minimum = Infinity;
  hits.forEach((rank, index) => {
    cumulative += weights[index];
    const top = (total ? cumulative / total : (index + 1) / m) - (rank - index - 1) / (n - m);
    const bottom = top - (total ? weights[index] / total : 1 / m);
    maximum = Math.max(maximum, top); minimum = Math.min(minimum, bottom);
  });
  return { representation: 'ranked-hits-v1', points: [], hitIndices: hits,
    maxAbsValue: Math.max(Math.abs(maximum), Math.abs(minimum)),
    es: maximum === -minimum ? 0 : maximum > -minimum ? maximum : minimum };
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sourceNodes(viewer: ViewerData): Map<string, ViewerNode> {
  const nodes = new Map<string, ViewerNode>();
  for (const pathway of viewer.pathways) for (const node of pathway.nodes) {
    const gene = node.originalId || node.id;
    if (!nodes.has(gene)) nodes.set(gene, { ...node, id: gene, originalId: gene,
      sampleValues: Object.keys(node.sampleValues).length ? node.sampleValues : viewer.sampleValuesByGene?.[node.id] ?? {} });
  }
  const table = viewer.evidence?.sourceTables?.Genes;
  if (!table) return nodes;
  const columns = new Map(table.columns.map((column, index) => [column, index]));
  const geneColumn = columns.get('gene_symbol');
  if (geneColumn === undefined) throw new Error('Exact membership requires a source gene identifier column.');
  const seen = new Set<string>();
  const reserved = new Set(['gene_symbol', 'log2fc', 'padj', 'pvalue', 'rank_metric', 'condition_a_mean', 'condition_b_mean', 'statistics_reason', 'missing_reason', 'unshrunk_log2fc', 'lfc_se']);
  for (const row of table.rows) {
    const gene = String(row[geneColumn] ?? '');
    if (!gene) continue;
    if (seen.has(gene)) throw new Error(`Exact membership has duplicate source gene ID: ${gene}`);
    seen.add(gene);
    const existing = nodes.get(gene);
    const statistic = (column: string, fallback: number | null = null) => {
      const value = columns.has(column) ? finite(row[columns.get(column)!]) : fallback;
      if ((column === 'padj' || column === 'pvalue') && value !== null && (value < 0 || value > 1)) throw new Error(`Source probability is outside [0, 1]: ${gene}/${column}.`);
      return value;
    };
    const samples: Record<string, number> = Object.create(null);
    table.columns.forEach((column, index) => {
      const value = finite(row[index]);
      if (!reserved.has(column) && value !== null) samples[column] = value;
    });
    const padj = statistic('padj', existing?.padj);
    const reason = row[columns.get('missing_reason') ?? columns.get('statistics_reason') ?? -1];
    nodes.set(gene, {
      id: gene, originalId: gene, label: existing && existing.label !== existing.id ? existing.label : gene,
      labelPriority: existing?.labelPriority ?? 0,
      log2fc: statistic('log2fc', existing?.log2fc), padj, pvalue: statistic('pvalue', existing?.pvalue),
      conditionAMean: statistic('condition_a_mean', existing?.conditionAMean), conditionBMean: statistic('condition_b_mean', existing?.conditionBMean),
      sizeMetric: padj === null ? 0 : Math.min(12, -Math.log10(Math.max(padj, 1e-12))),
      sampleValues: Object.keys(samples).length ? samples : existing?.sampleValues ?? {},
      statisticsReason: reason ? String(reason) : existing?.statisticsReason, isLeadingEdge: false,
    });
  }
  return nodes;
}

function leadingEdgeFromSource(viewer: ViewerData, pathway: PathwayRecord, source?: { table: string; row: number }): string[] {
  const table: SourceTable | undefined = source ? viewer.evidence?.sourceTables?.[source.table] : undefined;
  const column = table?.columns.findIndex(name => name === 'leadingEdge' || name === 'leading_edge_genes') ?? -1;
  if (table && source && column >= 0) {
    const row = table.rows[source.row - 1];
    if (!row) throw new Error(`Pathway ${pathway.key} refers to a missing source row.`);
    return String(row[column] ?? '').split(/[;,|\n\r\t]+/).map(gene => gene.trim()).filter(Boolean);
  }
  return pathway.leadingEdgeGenes;
}

export function applyTestedMembership(viewer: ViewerData): ViewerData {
  const evidence = viewer.evidence;
  const detailFor = (pathway: PathwayRecord) => evidence?.pathways[pathway.pathwayId || ''] ?? evidence?.pathways[pathway.key];
  const hasExact = viewer.pathways.some(pathway => detailFor(pathway)?.testedGenes !== undefined);
  if (!hasExact) return { ...viewer, pathways: viewer.pathways.map(pathway => ({ ...pathway,
    enrichment: { ...pathway.enrichment, validation: 'reconstructed_unverified' },
  })) };
  const ranking = evidence?.rankedGenes;
  if (!ranking) throw new Error('Exact tested membership requires the original R-sorted rank universe.');
  const positions = new Map(ranking.map((entry, index) => [entry.gene, index + 1]));
  if (positions.size !== ranking.length || ranking.some(entry => !entry.gene || !Number.isFinite(entry.metric))) throw new Error('Original ranked genes must have unique exact IDs and finite statistics.');
  const exactNodes = sourceNodes(viewer);
  const pathways = viewer.pathways.map(pathway => {
    const detail = detailFor(pathway);
    if (detail?.testedGenes === undefined) return { ...pathway, enrichment: {
      representation: 'ranked-hits-v1' as const, points: [], hitIndices: [], maxAbsValue: 0, es: null,
      validation: 'unavailable' as const, unavailableReason: 'Original tested membership was not supplied for this pathway; the report uses an exact R rank universe.',
    } };
    const genes = detail.testedGenes, membership = new Set(genes);
    if (membership.size !== genes.length || detail.testedSize !== genes.length) throw new Error(`Tested membership size disagrees for ${pathway.key}.`);
    if (genes.some(gene => !positions.has(gene))) throw new Error(`Tested membership contains a gene absent from the exact rank universe: ${pathway.key}.`);
    const leading = leadingEdgeFromSource(viewer, pathway, detail.source || pathway.source);
    if (new Set(leading).size !== leading.length || leading.some(gene => !membership.has(gene))) throw new Error(`Leading edge is not an exact subset of tested membership: ${pathway.key}.`);
    const curve = enrichmentFromHits(ranking, genes.map(gene => positions.get(gene)!));
    if (detail.originalEs !== null && (typeof detail.originalEs !== 'number' || curve.es === null || Math.abs(curve.es! - detail.originalEs) > 1e-8)) {
      throw new Error(`Reconstructed ES differs from the recorded R ES for ${pathway.key}.`);
    }
    const nodes = genes.map(gene => {
      const node = exactNodes.get(gene);
      if (!node) throw new Error(`No exact gene statistics were supplied for tested gene ${gene}.`);
      return { ...node, isLeadingEdge: leading.includes(gene) };
    });
    // PPI annotation may use aliases, but only explicit original IDs can map an
    // existing edge into the tested view. Case conversion is never membership.
    const ids = new Map(pathway.nodes.filter(node => membership.has(node.originalId || node.id)).map(node => [node.id, node.originalId || node.id]));
    const edges = (pathway.edgeIndices ? pathway.edgeIndices.map(index => viewer.sharedEdges![index]) : pathway.edges)
      .flatMap(edge => {
        const source = ids.get(edge.source), target = ids.get(edge.target);
        return source && target && source !== target ? [{ ...edge, source, target }] : [];
      });
    return { ...pathway, allGenes: [...genes], leadingEdgeGenes: [...leading], nodes, edges, edgeIndices: undefined,
      hasReferenceMembership: true, fallbackToLeadingEdge: false, missingGenes: [],
      enrichment: detail.originalEs === null
        ? { ...curve, es: null, validation: 'unavailable' as const, unavailableReason: 'The original R analysis did not estimate ES for this pathway.' }
        : { ...curve, validation: 'matches_recorded_es' as const },
    };
  });
  return { ...viewer, rankedGenes: ranking, pathways };
}
