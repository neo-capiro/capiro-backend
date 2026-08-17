import fs from 'node:fs';
import path from 'node:path';

const apiRoot = process.cwd();
const scoringPath = path.join(apiRoot, 'src/retrieval/retrieval-scoring.service.ts');
const retrievalPath = path.join(apiRoot, 'src/retrieval/retrieval-v2.service.ts');

describe('Knowledge Plane Phase 14 scoring architecture', () => {
  test('uses rank fusion rather than summing heterogeneous raw signal values', () => {
    const source = fs.readFileSync(scoringPath, 'utf8');

    expect(source).toContain('1 / (rrfK + signalRank)');
    expect(source).toContain('signalClass: SIGNAL_CLASS[signal]');
    expect(source).toContain("entity_match_confidence: 'confidence'");
    expect(source).toContain("source_authority: 'authority'");
    expect(source).toContain("temporal_validity: 'validity'");
  });

  test('proves coverage first, then fuses candidates, then invokes the NVIDIA reranker', () => {
    const source = fs.readFileSync(retrievalPath, 'utf8');
    const coverageIndex = source.indexOf('buildCoverageManifest(requestedDomains, results)');
    const scoringIndex = source.indexOf('this.scoring.score(request, baselineRecords)');
    const rerankIndex = source.indexOf('this.reranker.rerank(request, scored.records)');

    expect(coverageIndex).toBeGreaterThan(-1);
    expect(scoringIndex).toBeGreaterThan(coverageIndex);
    expect(rerankIndex).toBeGreaterThan(scoringIndex);
  });

  test('does not read or rewrite provenance while computing retrieval priority', () => {
    const source = fs.readFileSync(scoringPath, 'utf8');

    expect(source).not.toContain('record.provenance');
    expect(source).not.toContain('CoverageManifest');
    expect(source).not.toContain('coverageComplete');
  });
});
