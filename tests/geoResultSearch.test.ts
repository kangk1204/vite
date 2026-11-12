import { describe, expect, it } from 'vitest';
import { createGeoResultSearchEngine } from '../src/lib/geoResultSearch';
import type { GeoSearchResult } from '../src/lib/geoSearch';

function createResults(): GeoSearchResult[] {
  return [
    {
      accession: 'GSE157951',
      title: 'Psoriasis skin RNA-seq',
      summary: 'Bulk RNA-seq of lesional and healthy skin',
      organism: 'Homo sapiens',
      sampleCount: 120,
      geoUrl: 'https://example.org/1',
      downloadUrl: 'https://example.org/dl-1',
      hasNcbiGeneratedRawCounts: true,
      pubmedId: '32165498',
      eligibilityStatus: 'eligible',
      isEligible: true,
    },
    {
      accession: 'GSE121212',
      title: 'Atopic dermatitis epidermis',
      summary: 'Transcriptome profiling with treated and control arms',
      organism: 'Homo sapiens',
      sampleCount: 92,
      geoUrl: 'https://example.org/2',
      downloadUrl: 'https://example.org/dl-2',
      hasNcbiGeneratedRawCounts: true,
      pubmedId: '29876543',
      eligibilityStatus: 'checking',
      isEligible: false,
      eligibilityReason: 'Checking NCBI-generated raw counts…',
    },
    {
      accession: 'GSE909090',
      title: 'Mouse liver RNA-seq',
      summary: 'Non-human dataset with sequencing replicates',
      organism: 'Mus musculus',
      sampleCount: 24,
      geoUrl: 'https://example.org/3',
      downloadUrl: 'https://example.org/dl-3',
      hasNcbiGeneratedRawCounts: false,
      pubmedId: '18765432',
      eligibilityStatus: 'excluded',
      isEligible: false,
      eligibilityReason: 'Excluded by constraints',
    },
  ];
}

describe('createGeoResultSearchEngine', () => {
  it('returns every result index for empty queries', () => {
    const engine = createGeoResultSearchEngine(createResults());
    expect(engine.filterIndices('')).toEqual([0, 1, 2]);
    expect(engine.filterIndices('   ')).toEqual([0, 1, 2]);
    expect(engine.filterSnapshot('').counts).toEqual({
      all: 3,
      eligible: 1,
      checking: 1,
      excluded: 1,
    });
  });

  it('reuses default all-results snapshot for blank and single-character queries', () => {
    const engine = createGeoResultSearchEngine(createResults());
    const first = engine.filterSnapshot('');
    const second = engine.filterSnapshot(' ');
    const third = engine.filterSnapshot('a');

    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('matches accession, title, summary, and organism tokens', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('gse157951')).toEqual([0]);
    expect(engine.filterIndices('atopic dermatitis')).toEqual([1]);
    expect(engine.filterIndices('healthy skin')).toEqual([0]);
    expect(engine.filterIndices('mus musculus')).toEqual([2]);
  });

  it('reuses simple-query snapshots when token order changes', () => {
    const engine = createGeoResultSearchEngine(createResults());
    const first = engine.filterSnapshot('psoriasis skin');
    const second = engine.filterSnapshot('skin psoriasis');

    expect(second).toBe(first);
    expect(second.allIndices).toEqual([0]);
  });

  it('handles exact GEO accession queries with fast exact-match semantics', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices(' GSE121212 ')).toEqual([1]);
    expect(engine.filterIndices('gse121212', 'checking')).toEqual([1]);
    expect(engine.filterIndices('gse121212', 'eligible')).toEqual([]);
    expect(engine.filterIndices('gse121212x')).toEqual([]);
  });

  it('returns no results immediately for unknown accession-like prefixes', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('gse9999')).toEqual([]);
    expect(engine.filterSnapshot('gse9999').counts).toEqual({
      all: 0,
      eligible: 0,
      checking: 0,
      excluded: 0,
    });
  });

  it('does not bypass phrase constraints when accession token is present', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('gse121212 "psoriasis skin"')).toEqual([]);
    expect(engine.filterIndices('gse121212 -"treated and control"')).toEqual([]);
  });

  it('supports partial-token matching and repeated query tokens', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('psor')).toEqual([0]);
    expect(engine.filterIndices('gse12')).toEqual([1]);
    expect(engine.filterIndices('dermatitis dermatitis')).toEqual([1]);
  });

  it('treats single-character queries as non-filtering input for fast interactive typing', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('a')).toEqual([0, 1, 2]);
    expect(engine.filterIndices('a', 'eligible')).toEqual([0]);
  });

  it('accelerates accession-prefix queries with stable multi-hit results', () => {
    const engine = createGeoResultSearchEngine([
      ...createResults(),
      {
        accession: 'GSE129999',
        title: 'Additional skin cohort',
        summary: 'Independent bulk RNA-seq validation cohort',
        organism: 'Homo sapiens',
        sampleCount: 80,
        geoUrl: 'https://example.org/4',
        downloadUrl: 'https://example.org/dl-4',
        hasNcbiGeneratedRawCounts: true,
        eligibilityStatus: 'eligible',
        isEligible: true,
      },
    ]);

    expect(engine.filterIndices('gse12')).toEqual([1, 3]);
    expect(engine.filterIndices('gse129')).toEqual([3]);
  });

  it('intersects multiple tokens to narrow results', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('homo control')).toEqual([1]);
    expect(engine.filterIndices('homo skin')).toEqual([0]);
    expect(engine.filterIndices('homo liver')).toEqual([]);
  });

  it('supports negated tokens to quickly exclude broad matches', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('homo -dermatitis')).toEqual([0]);
    expect(engine.filterIndices('rna -mouse')).toEqual([0]);
  });

  it('supports field-scoped filters for accession/title/summary/organism/pmid', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('accession:gse121')).toEqual([1]);
    expect(engine.filterIndices('title:psoriasis')).toEqual([0]);
    expect(engine.filterIndices('summary:treated organism:homo')).toEqual([1]);
    expect(engine.filterIndices('organism:mus -title:liver')).toEqual([]);
    expect(engine.filterIndices('pmid:32165498')).toEqual([0]);
  });

  it('returns empty immediately for unknown accession field prefixes', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('accession:gse9999')).toEqual([]);
    expect(engine.filterIndices('acc:gse9999 title:psoriasis')).toEqual([]);
    expect(engine.filterSnapshot('accession:gse9999').counts).toEqual({
      all: 0,
      eligible: 0,
      checking: 0,
      excluded: 0,
    });
  });

  it('supports quoted phrase filters with optional negation', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('"psoriasis skin"')).toEqual([0]);
    expect(engine.filterIndices('"homo sapiens" -"treated and control"')).toEqual([0]);
    expect(engine.filterIndices('title:"atopic dermatitis"')).toEqual([1]);
    expect(engine.filterIndices('summary:"treated and control" -summary:"healthy skin"')).toEqual([1]);
  });

  it('narrowly intersects mixed exact and prefix token seeds', () => {
    const engine = createGeoResultSearchEngine([
      ...createResults(),
      {
        accession: 'GSE129999',
        title: 'Human skin validation cohort',
        summary: 'Additional bulk RNA-seq validation set',
        organism: 'Homo sapiens',
        sampleCount: 80,
        geoUrl: 'https://example.org/4',
        downloadUrl: 'https://example.org/dl-4',
        hasNcbiGeneratedRawCounts: true,
        eligibilityStatus: 'eligible',
        isEligible: true,
      },
    ]);

    expect(engine.filterIndices('homo gse129')).toEqual([3]);
  });

  it('applies eligibility status filters inside the search engine', () => {
    const engine = createGeoResultSearchEngine(createResults());

    expect(engine.filterIndices('', 'eligible')).toEqual([0]);
    expect(engine.filterIndices('homo', 'checking')).toEqual([1]);
    expect(engine.filterIndices('homo', 'excluded')).toEqual([]);
  });

  it('returns reusable query snapshot with per-status counts', () => {
    const engine = createGeoResultSearchEngine(createResults());
    const snapshot = engine.filterSnapshot('homo');

    expect(snapshot.allIndices).toEqual([0, 1]);
    expect(snapshot.statusIndices.eligible).toEqual([0]);
    expect(snapshot.statusIndices.checking).toEqual([1]);
    expect(snapshot.statusIndices.excluded).toEqual([]);
    expect(snapshot.counts).toEqual({
      all: 2,
      eligible: 1,
      checking: 1,
      excluded: 0,
    });
  });

  it('supports dynamic status overrides without rebuilding the text index', () => {
    const engine = createGeoResultSearchEngine(createResults());
    const initialSnapshot = engine.filterSnapshot('homo');
    expect(initialSnapshot.counts).toEqual({
      all: 2,
      eligible: 1,
      checking: 1,
      excluded: 0,
    });

    const overriddenSnapshot = engine.filterSnapshot('homo', ['checking', 'eligible', 'excluded']);
    expect(overriddenSnapshot.allIndices).toEqual([0, 1]);
    expect(overriddenSnapshot.statusIndices.eligible).toEqual([1]);
    expect(overriddenSnapshot.statusIndices.checking).toEqual([0]);
    expect(overriddenSnapshot.statusIndices.excluded).toEqual([]);
    expect(overriddenSnapshot.counts).toEqual({
      all: 2,
      eligible: 1,
      checking: 1,
      excluded: 0,
    });
    expect(engine.filterIndices('homo', 'eligible', ['checking', 'eligible', 'excluded'])).toEqual([1]);
  });

  it('accepts status accessor callbacks to avoid per-update status array allocations', () => {
    const engine = createGeoResultSearchEngine(createResults());
    const statusAccessor = (index: number) => (index === 0 ? 'checking' : index === 1 ? 'eligible' : 'excluded');
    const snapshot = engine.filterSnapshot('homo', statusAccessor);

    expect(snapshot.allIndices).toEqual([0, 1]);
    expect(snapshot.statusIndices.eligible).toEqual([1]);
    expect(snapshot.statusIndices.checking).toEqual([0]);
    expect(snapshot.statusIndices.excluded).toEqual([]);
    expect(engine.filterIndices('homo', 'eligible', statusAccessor)).toEqual([1]);
  });

  it('reuses the same snapshot object for identical query and status source', () => {
    const engine = createGeoResultSearchEngine(createResults());
    const statusAccessor = (index: number) => (index === 0 ? 'eligible' : index === 1 ? 'checking' : 'excluded');

    const first = engine.filterSnapshot('homo', statusAccessor);
    const second = engine.filterSnapshot('homo', statusAccessor);

    expect(second).toBe(first);
  });

  it('reuses status-override snapshots when status cache key is stable', () => {
    const engine = createGeoResultSearchEngine(createResults());
    const firstStatusArray: GeoSearchResult['eligibilityStatus'][] = ['checking', 'eligible', 'excluded'];
    const secondStatusArray: GeoSearchResult['eligibilityStatus'][] = ['checking', 'eligible', 'excluded'];

    const first = engine.filterSnapshot('homo', firstStatusArray, 'status:v1');
    const second = engine.filterSnapshot('homo', secondStatusArray, 'status:v1');
    const third = engine.filterSnapshot('homo', secondStatusArray, 'status:v2');

    expect(second).toBe(first);
    expect(third).not.toBe(first);
    expect(engine.filterIndices('homo', 'eligible', secondStatusArray, 'status:v1')).toEqual([1]);
  });

  it('reuses keyed status snapshots even when query result is served from query cache', () => {
    const engine = createGeoResultSearchEngine(createResults());
    const firstStatusArray: GeoSearchResult['eligibilityStatus'][] = ['checking', 'eligible', 'excluded'];
    const secondStatusArray: GeoSearchResult['eligibilityStatus'][] = ['checking', 'eligible', 'excluded'];

    const first = engine.filterSnapshot('homo', firstStatusArray, 'status:v1');
    // Move off the last-query fast path so the next lookup uses cached query indices.
    engine.filterSnapshot('psoriasis');
    const second = engine.filterSnapshot('homo', secondStatusArray, 'status:v1');

    expect(second).toBe(first);
    expect(engine.filterIndices('homo', 'eligible', secondStatusArray, 'status:v1')).toEqual([1]);
  });

  it('keeps matching stable with large result sets using on-demand search text cache', () => {
    const base = createResults();
    const largeResults: GeoSearchResult[] = [];
    for (let index = 0; index < 280; index += 1) {
      largeResults.push({
        ...base[index % base.length],
        accession: `GSE9${String(index).padStart(5, '0')}`,
        title: `Synthetic cohort ${index}`,
        summary: index === 173 ? 'rare psoriasis biomarker signature in epidermis' : `control summary ${index}`,
        geoUrl: `https://example.org/${index + 10}`,
        downloadUrl: `https://example.org/dl-${index + 10}`,
      });
    }
    const engine = createGeoResultSearchEngine(largeResults);

    const firstPass = engine.filterIndices('rare psoriasis epidermis');
    const secondPass = engine.filterIndices('rare psoriasis epidermis signature');
    expect(firstPass.length).toBe(1);
    expect(secondPass.length).toBe(1);
    expect(secondPass[0]).toBe(173);
  });

  it('preserves search accuracy when frequent tokens exceed posting-list memory caps', () => {
    const base = createResults()[0];
    const largeResults: GeoSearchResult[] = Array.from({ length: 860 }, (_value, index) => ({
      ...base,
      accession: `GSE88${String(index).padStart(4, '0')}`,
      title: `Shared inflammation cohort ${index}`,
      summary: `common inflammation profile batch ${index}`,
      geoUrl: `https://example.org/shared-${index}`,
      downloadUrl: `https://example.org/shared-dl-${index}`,
    }));
    const engine = createGeoResultSearchEngine(largeResults);

    expect(engine.filterIndices('inflammation').length).toBe(860);
    expect(engine.filterIndices('inflammation batch 723')).toEqual([723]);
  });
});
