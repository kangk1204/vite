const MAX_CELLS = 45_000_000;
const MAX_SAMPLES = 1500;

function record(value, label, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key) || (allowed && !allowed.includes(key))) {
      throw new Error(`${label} contains an unsupported field: ${key}`);
    }
  }
  return value;
}

function text(value, label, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\0\r\n\t]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line value (up to ${max} characters).`);
  }
  return value.trim();
}

function unquote(value) {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1).replace(/""/g, '"') : trimmed;
}

function fields(line) {
  return line.split('\t').map(unquote);
}

function normalizeSample(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function parseSampleMetadata(seriesMatrixText) {
  const columns = new Map();
  for (const line of seriesMatrixText.split(/\r?\n/)) {
    const [key, ...values] = fields(line);
    if (key === '!Sample_geo_accession' || key === '!Sample_title') columns.set(key, values);
  }
  const ids = columns.get('!Sample_geo_accession');
  if (!ids?.length || ids.some(id => !id) || new Set(ids).size !== ids.length) throw new Error('Series metadata must contain unique sample accessions.');
  const titles = columns.get('!Sample_title') ?? ids;
  if (titles.length !== ids.length) throw new Error('Series metadata titles and accessions have different lengths.');
  return ids.map((id, index) => ({ id: text(id, 'Sample accession'), title: text(titles[index], 'Sample title') }));
}

function parseCountHeaders(rawCountsText) {
  const lines = rawCountsText.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('Raw counts require a header and at least one gene.');
  const [, ...samples] = fields(lines[0]);
  if (!samples.length || samples.length > MAX_SAMPLES) throw new Error(`Raw count matrix must have 1–${MAX_SAMPLES} samples.`);
  samples.forEach(sample => text(sample, 'Raw count sample'));
  if (new Set(samples).size !== samples.length) throw new Error('Duplicate raw count sample columns are not allowed.');
  if ((lines.length - 1) * samples.length > MAX_CELLS) throw new Error('Raw count matrix exceeds the 45 million cell limit.');
  for (const [index, line] of lines.slice(1).entries()) {
    const [gene, ...counts] = fields(line);
    if (!gene || counts.length !== samples.length || counts.some(value => !/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) || !Number.isSafeInteger(Number(value)))) {
      throw new Error(`Raw count row ${index + 2} must contain a gene and non-negative integer counts for every sample.`);
    }
  }
  return { samples, geneIdentifierType: 'auto' };
}

function alignSamples(samples, rawSamples) {
  const matches = new Map();
  const used = new Set();
  const passes = [
    [sample => sample.id, value => value.toLowerCase()],
    [sample => sample.id, normalizeSample],
    [sample => sample.title, value => value.toLowerCase()],
    [sample => sample.title, normalizeSample],
  ];
  for (const [candidateFor, normalize] of passes) {
    const proposals = new Map();
    for (const sample of samples.filter(sample => !matches.has(sample.id))) {
      const candidates = rawSamples.filter(raw => !used.has(raw) && normalize(candidateFor(sample)) === normalize(raw));
      if (candidates.length === 1) {
        const raw = candidates[0];
        proposals.set(raw, [...(proposals.get(raw) || []), sample.id]);
      }
    }
    for (const [raw, owners] of proposals) if (owners.length === 1) {
      matches.set(owners[0], raw); used.add(raw);
    }
  }
  return matches;
}

export function prepareLocalInput(input) {
  record(input, 'Bundle', ['schemaVersion', 'kind', 'project', 'rawCountsText', 'seriesMatrixText', 'design']);
  if (input.schemaVersion !== 1 || input.kind !== 'pnv-local-analysis-input') throw new Error('Unsupported local input schema version or kind.');
  const project = record(input.project, 'Project', ['title', 'accession', 'organism', 'conditionA', 'conditionB']);
  const title = text(project.title, 'Project title');
  const accession = text(project.accession, 'Dataset accession');
  const organism = text(project.organism, 'Organism');
  if (!/^(human|homo sapiens)$/i.test(organism)) throw new Error('Only human bulk RNA-seq inputs are supported.');
  const conditionA = text(project.conditionA, 'Reference condition');
  const conditionB = text(project.conditionB, 'Test condition');
  if (conditionA === conditionB) throw new Error('Reference and test conditions must be distinct.');
  for (const key of ['rawCountsText', 'seriesMatrixText']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].includes('\0')) throw new Error(`${key} must contain text.`);
  }
  const design = record(input.design, 'Design', ['groupBySample', 'batchBySample', 'batchFactorName']);
  const groups = record(design.groupBySample, 'Group assignments');
  const samples = parseSampleMetadata(input.seriesMatrixText);
  const knownIds = new Set(samples.map(sample => sample.id));
  for (const id of Object.keys(groups)) if (!knownIds.has(id)) throw new Error(`Group assignment refers to unknown sample: ${id}`);
  for (const sample of samples) if (!Object.hasOwn(groups, sample.id) || !['A', 'B', 'U'].includes(groups[sample.id])) throw new Error(`Sample ${sample.id} requires an explicit A/B/U assignment.`);
  const batch = design.batchBySample == null ? null : record(design.batchBySample, 'Batch assignments');
  if (batch) for (const id of Object.keys(batch)) if (!knownIds.has(id)) throw new Error(`Batch assignment refers to unknown sample: ${id}`);
  const counts = parseCountHeaders(input.rawCountsText);
  const aligned = alignSamples(samples, counts.samples);
  const selected = samples.filter(sample => groups[sample.id] !== 'U').map(sample => {
    const rawId = aligned.get(sample.id);
    if (!rawId) throw new Error(`Cannot uniquely align metadata sample ${sample.id} to a raw count column.`);
    return { sample: rawId, originalSample: sample.id, group: groups[sample.id], ...(batch ? { batch: text(batch[sample.id], `Batch for ${sample.id}`) } : {}) };
  });
  if (['A', 'B'].some(group => selected.filter(sample => sample.group === group).length < 2)) throw new Error('At least two biological samples are required in each group.');
  if (batch && new Set(selected.map(sample => sample.batch)).size < 2) throw new Error('Requested batch covariate has fewer than two levels; explicitly remove it before analysis.');
  const columns = batch ? ['sample', 'group', 'batch'] : ['sample', 'group'];
  return {
    rawCountsText: input.rawCountsText,
    seriesMatrixText: input.seriesMatrixText,
    metadataTsv: `${[columns.join('\t'), ...selected.map(sample => columns.map(column => sample[column]).join('\t'))].join('\n')}\n`,
    sampleAlignment: selected.map(({ sample, originalSample }) => ({ originalSample, countSample: sample })),
    excludedSamples: samples.filter(sample => groups[sample.id] === 'U').map(sample => sample.id),
    config: {
      projectTitle: title, datasetIdentifier: accession, conditionA, conditionB,
      contrastName: `${conditionB}_vs_${conditionA}`, designFormula: batch ? '~ batch + group' : '~ group',
      geneIdentifierType: counts.geneIdentifierType, seed: 20261110, alpha: 0.05, camera: true, bootstrapReplicates: 0,
      filterMinCount: 10, filterMinFraction: 0.15,
    },
  };
}
