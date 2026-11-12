import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describeArtifact, sha256 } from './provenance.mjs';

// Read the trusted, internally produced reference snapshot. No model fitting,
// identifier normalization, or reference-library substitution occurs here.
const EXTRACT = `
b <- readRDS(commandArgs(TRUE)[1])
g <- b$expected$genes
if (!all(c("gene","stat") %in% names(g))) stop("Snapshot lacks recorded Wald ranks")
ranks <- setNames(as.numeric(g$stat), as.character(g$gene))
if (anyDuplicated(names(ranks))) stop("Duplicate snapshot ranking identifiers")
ranks <- ranks[is.finite(ranks)]
ranks <- ranks[order(-ranks,names(ranks))]
p <- b$expected$pathways
ids <- sub(" :: .*", "", as.character(p$pathway))
if (anyDuplicated(ids)) stop("Duplicate stable pathway identifiers")
entries <- lapply(seq_len(nrow(p)), function(i) {
  reference <- unique(as.character(b$pathways[[as.character(p$pathway[[i]])]]))
  tested <- intersect(reference,names(ranks))
  if (length(tested) != p$size[[i]]) stop("Recorded tested size differs from snapshot membership")
  list(testedGenes=I(tested),originalEs=as.numeric(p$ES[[i]]),testedSize=length(tested),
    referenceCoverage=list(referenceTokenCount=length(reference),exactTestedCount=length(tested),
      unmatchedTokens=I(setdiff(reference,names(ranks))),reason="absent_from_ranked_universe"))
})
names(entries) <- ids
if (!length(entries)) entries <- structure(list(),names=character())
ranking <- unname(lapply(seq_along(ranks),function(i)list(gene=names(ranks)[[i]],metric=unname(ranks[[i]]))))
cat(jsonlite::toJSON(list(rankedGenes=ranking,pathways=entries),auto_unbox=TRUE,digits=NA,na="null",null="null"))
`;

function numericEqual(left, right, tolerance = 1e-8) {
  return typeof left === 'number' && typeof right === 'number' && Number.isFinite(left) && Number.isFinite(right) && Math.abs(left - right) <= tolerance + tolerance * Math.abs(right);
}

function tableRows(table) {
  return table.rows.map(row => Object.fromEntries(table.columns.map((column, index) => [column, row[index]])));
}

function finiteNumber(value) {
  return value === null || value === undefined || String(value).trim() === '' || !Number.isFinite(Number(value)) ? null : Number(value);
}

export function attachTestedMembership(evidence, snapshotPath, { root, projectRoot = root, execute = execFileSync } = {}) {
  const relative = path.relative(root, path.resolve(snapshotPath));
  const snapshot = describeArtifact('reference_snapshot', relative, { root, projectRoot });
  const helper = describeArtifact('report_membership_helper', 'project:scripts/lib/provenance_membership.mjs', { root, projectRoot });
  const result = JSON.parse(execute('Rscript', ['-e', EXTRACT, path.resolve(snapshotPath)], { cwd: projectRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  if (describeArtifact(snapshot.role, snapshot.path, { root, projectRoot }).sha256 !== snapshot.sha256 || describeArtifact(helper.role, helper.path, { root, projectRoot }).sha256 !== helper.sha256) throw new Error('Snapshot/helper changed during tested-membership extraction.');
  if (!Array.isArray(result.rankedGenes) || !result.pathways || Array.isArray(result.pathways)) throw new Error('Invalid tested-membership extraction result.');
  const ranking = result.rankedGenes;
  if (new Set(ranking.map(gene => gene.gene)).size !== ranking.length || ranking.some(gene => typeof gene.gene !== 'string' || !Number.isFinite(gene.metric))) throw new Error('Snapshot ranking is not finite and uniquely identified.');
  if (evidence.sourceTables?.genes) {
    const recorded = tableRows(evidence.sourceTables.genes).filter(gene => finiteNumber(gene.stat) !== null);
    const byId = new Map(recorded.map(gene => [String(gene.gene), finiteNumber(gene.stat)]));
    if (byId.size !== ranking.length || ranking.some(gene => !numericEqual(gene.metric, byId.get(gene.gene)))) throw new Error('Snapshot ranks differ from original R evidence.');
  }
  const pathways = Object.fromEntries(Object.entries(result.pathways).map(([id, value]) => {
    if (!Array.isArray(value.testedGenes) || new Set(value.testedGenes).size !== value.testedGenes.length || value.testedGenes.length !== value.testedSize) throw new Error(`Invalid captured membership for ${id}.`);
    return [id, { ...(evidence.pathways?.[id] || {}), ...value, testedMembershipSha256: sha256(JSON.stringify(value.testedGenes)) }];
  }));
  return {
    ...evidence, rankedGenes: ranking, rankedGenesSha256: sha256(JSON.stringify(ranking)),
    referenceMatching: 'exact case-sensitive upstream identifiers', pathways,
    artifacts: [...(evidence.artifacts || []).filter(artifact => ![snapshot.path, helper.path].includes(artifact.path)), snapshot, helper],
    sourceTables: { ...evidence.sourceTables, tested_membership_coverage: {
      columns: ['pathway_id', 'reference_token_count', 'exact_tested_count', 'unmatched_reference_tokens', 'unmatched_reason', 'membership_sha256'],
      rows: Object.entries(pathways).map(([id, value]) => [id, value.referenceCoverage.referenceTokenCount, value.testedSize, value.referenceCoverage.unmatchedTokens.join(';'), value.referenceCoverage.reason, value.testedMembershipSha256]),
    } },
    ...(evidence.verification ? { verification: { ...evidence.verification,
      checks: [...evidence.verification.checks, { id: 'exact-tested-membership', status: 'pass', message: 'Exact case-sensitive tested gene sets and finite Wald rank order were extracted from the captured R reference snapshot without refitting.' }],
      limitations: [...evidence.verification.limitations, 'Reference coverage records exact matches and tokens absent from the ranked universe; it does not infer biological reasons for unmatched identifiers.'],
    } } : {}),
  };
}

export function assertReportEnrichment(viewer, tolerance = 1e-8) {
  const expectedRanking = viewer.evidence?.rankedGenes;
  if (!Array.isArray(expectedRanking) || !Array.isArray(viewer.rankedGenes) || expectedRanking.length !== viewer.rankedGenes.length || expectedRanking.some((gene, index) => gene.gene !== viewer.rankedGenes[index].gene || !numericEqual(gene.metric, viewer.rankedGenes[index].metric, tolerance))) throw new Error('Report rank order differs from captured R ranks.');
  const rankPositions = new Map(viewer.rankedGenes.map((gene, index) => [gene.gene, index + 1]));
  let finiteEs = 0, maxAbsEsDifference = 0;
  for (const pathway of viewer.pathways) {
    const expected = viewer.evidence.pathways[pathway.pathwayId || pathway.key];
    if (!expected?.testedGenes) throw new Error('Report pathway lacks captured tested membership.');
    const expectedHits = expected.testedGenes.map(gene => rankPositions.get(gene)).filter(index => index !== undefined).sort((left, right) => left - right);
    const hits = pathway.enrichment.hitIndices;
    if (!Array.isArray(hits) || expectedHits.length !== expected.testedSize || JSON.stringify(hits) !== JSON.stringify(expectedHits)) throw new Error(`Report hit membership differs from R: ${pathway.pathwayId || pathway.key}`);
    if (expected.originalEs === null) {
      if (pathway.enrichment.es !== null) throw new Error('Report must preserve unavailable ES as null.');
      continue;
    }
    finiteEs += 1;
    const observedWeights = hits.map(index => Math.abs(viewer.rankedGenes[index - 1].metric));
    const observedTotal = observedWeights.reduce((sum, weight) => sum + weight, 0);
    const weights = observedTotal ? observedWeights : observedWeights.map(() => 1);
    const total = observedTotal || hits.length;
    if (!total || viewer.rankedGenes.length === hits.length) throw new Error('Recorded finite ES has an invalid enrichment denominator.');
    let cumulative = 0, high = -Infinity, low = Infinity;
    for (let index = 0; index < hits.length; index += 1) {
      cumulative += weights[index];
      const top = cumulative / total - (hits[index] - index - 1) / (viewer.rankedGenes.length - hits.length);
      high = Math.max(high, top); low = Math.min(low, top - weights[index] / total);
    }
    if (expected.originalEs === 0 && Math.abs(high + low) > tolerance) throw new Error(`Recorded zero ES does not have symmetric enrichment extrema: ${pathway.pathwayId || pathway.key}`);
    const computed = expected.originalEs === 0 ? 0 : expected.originalEs >= 0 ? high : low;
    const notMaximum = expected.originalEs !== 0 && Math.abs(expected.originalEs) + tolerance < Math.max(Math.abs(high), Math.abs(low));
    if (!numericEqual(computed, expected.originalEs, tolerance) || notMaximum || !numericEqual(pathway.enrichment.es, expected.originalEs, tolerance)) throw new Error(`Report ES differs from original R ES: ${pathway.pathwayId || pathway.key}`);
    maxAbsEsDifference = Math.max(maxAbsEsDifference, Math.abs(computed - expected.originalEs), Math.abs(pathway.enrichment.es - expected.originalEs));
  }
  return { pathways: viewer.pathways.length, finiteEs, tolerance, maxAbsEsDifference };
}
