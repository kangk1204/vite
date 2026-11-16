// Compare a rendered report to direct fgsea ES calculations from a frozen R
// snapshot. This never reruns differential-expression or bootstrap fits.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const [viewerPath, snapshotPath] = process.argv.slice(2);
if (!viewerPath || !snapshotPath) throw new Error('Usage: node tests/e2e/enrichment-parity.mjs viewer.json reference_input.rds');
const viewer = JSON.parse(fs.readFileSync(viewerPath, 'utf8'));
const reference = JSON.parse(execFileSync('Rscript', ['-e', `
bundle <- readRDS(commandArgs(TRUE)[1])
genes <- bundle$expected$genes
ranks <- setNames(genes$stat, genes$gene)
ranks <- ranks[is.finite(ranks)]
ranks <- ranks[order(-ranks, names(ranks))]
rows <- bundle$expected$pathways
result <- lapply(seq_len(nrow(rows)), function(i) {
  members <- intersect(unique(bundle$pathways[[rows$pathway[[i]]]]), names(ranks))
  hits <- which(names(ranks) %in% members)
  score <- if (is.finite(rows$ES[[i]])) fgsea::calcGseaStat(ranks, hits, gseaParam=1, scoreType="std") else NULL
  leading <- as.character(rows$leadingEdge[[i]])
  if (length(leading) == 1L) leading <- strsplit(leading, ";", fixed=TRUE)[[1]]
  list(id=sub(" :: .*", "", rows$pathway[[i]]), testedGenes=I(members), hitIndices=I(hits),
    es=score, originalEs=rows$ES[[i]], nes=rows$NES[[i]], padj=rows$padj[[i]],
    leadingEdge=I(leading))
})
cat(jsonlite::toJSON(result,auto_unbox=TRUE,digits=NA,na="null",null="null"))
`, path.resolve(snapshotPath)], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }));
const expectedById = new Map(reference.map(row => [row.id, row]));
assert.equal(viewer.pathways.length, expectedById.size, 'All tested pathways must remain in the report');
const equalNumber = (actual, expected, label) => {
  if (expected === null) { assert.equal(actual, null, label); return; }
  assert.equal(typeof actual, 'number', label);
  assert.ok(Math.abs(actual - expected) <= 1e-8 + 1e-8 * Math.abs(expected), `${label}: ${actual} vs ${expected}`);
};
let finiteEs = 0;
for (const pathway of viewer.pathways) {
  const reference = expectedById.get(pathway.pathwayId);
  assert.ok(reference, `Unknown pathway ${pathway.pathwayId}`);
  assert.deepEqual([...pathway.allGenes].sort(), [...reference.testedGenes].sort(), `Exact tested membership: ${pathway.pathwayId}`);
  assert.deepEqual(pathway.enrichment.hitIndices, reference.hitIndices, `Exact ranked hits: ${pathway.pathwayId}`);
  assert.deepEqual(pathway.leadingEdgeGenes, reference.leadingEdge.filter(Boolean), `Original leading edge: ${pathway.pathwayId}`);
  equalNumber(pathway.enrichment.es, reference.es, `Direct fgsea ES: ${pathway.pathwayId}`);
  equalNumber(pathway.enrichment.es, reference.originalEs, `Original ES: ${pathway.pathwayId}`);
  equalNumber(pathway.nes, reference.nes, `Unchanged NES: ${pathway.pathwayId}`);
  equalNumber(pathway.padj, reference.padj, `Unchanged FDR: ${pathway.pathwayId}`);
  if (reference.es !== null) finiteEs += 1;
}
console.log(JSON.stringify({ passed: true, pathways: viewer.pathways.length, finiteEs, tolerance: 1e-8, comparison: 'direct fgsea::calcGseaStat on frozen R ranks and exact membership' }, null, 2));
