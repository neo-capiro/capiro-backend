import fs from 'node:fs';
import path from 'node:path';

const apiRoot = process.cwd();
const nvidiaProviderPath = path.join(apiRoot, 'src/reranking/nvidia-reranking.provider.ts');
const rerankerPath = path.join(apiRoot, 'src/retrieval/retrieval-reranker.service.ts');
const retrievalPath = path.join(apiRoot, 'src/retrieval/retrieval-v2.service.ts');

const FORBIDDEN_NVIDIA_ARCHITECTURE_MARKERS = [
  'context_embeddings',
  'pgvector',
  'Pinecone',
  'Qdrant',
  'Weaviate',
  'kg_edge',
  'knowledge_graph',
  'TemporalKnowledgeGraph',
  'PrismaService',
] as const;

describe('Knowledge Plane Phase 13 reranking architecture', () => {
  it('keeps the NVIDIA adapter free of vector-store, graph, database and coverage responsibilities', () => {
    const source = fs.readFileSync(nvidiaProviderPath, 'utf8');
    for (const marker of FORBIDDEN_NVIDIA_ARCHITECTURE_MARKERS) {
      expect(source).not.toContain(marker);
    }
    expect(source).not.toContain('CoverageManifest');
    expect(source).not.toContain('RetrievalAuthority');
  });

  it('builds provider passages without provenance or internal record ids', () => {
    const source = fs.readFileSync(rerankerPath, 'utf8');
    const passageFunction = source.slice(source.indexOf('export function recordToRerankPassage'));
    expect(passageFunction).not.toContain('record.provenance');
    expect(passageFunction).not.toContain('record.recordId');
    expect(passageFunction).toContain('record.payload');
  });

  it('proves coverage before reranking and never derives coverage from rerank output', () => {
    const source = fs.readFileSync(retrievalPath, 'utf8');
    const coverageIndex = source.indexOf('buildCoverageManifest(requestedDomains, results)');
    const rerankIndex = source.indexOf('this.reranker.rerank(request, baselineRecords)');
    expect(coverageIndex).toBeGreaterThan(-1);
    expect(rerankIndex).toBeGreaterThan(coverageIndex);

    const afterRerank = source.slice(rerankIndex, source.indexOf('private async retrieveFromSource'));
    expect(afterRerank).not.toContain('coverage.complete =');
    expect(afterRerank).not.toContain('coverage.sources =');
  });
});
