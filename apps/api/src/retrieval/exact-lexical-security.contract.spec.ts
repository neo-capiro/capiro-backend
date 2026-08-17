import fs from 'node:fs';
import path from 'node:path';

describe('Phase 11 exact lexical security and authority contract', () => {
  const source = fs.readFileSync(
    path.join(process.cwd(), 'src/retrieval/exact-lexical-retrieval.service.ts'),
    'utf8',
  );

  it('keeps tenant CRM retrieval behind withTenant and the existing memory wall/grant boundary', () => {
    expect(source).toContain('this.prisma.withTenant(request.caller.tenantId');
    expect(source).toContain('{ memoryWall: false }');
    expect(source).toContain('memoryAccessGrants');
    expect(source).toContain('requested_client_scope_not_fully_authorized');
  });

  it('uses read-only canonical preview and never mutates identity during lookup', () => {
    expect(source).toContain('this.entityResolver.preview(');
    expect(source).not.toContain('this.entityResolver.resolve(');
    expect(source).not.toContain('canonicalEntity.create');
    expect(source).not.toContain('entityAlias.create');
    expect(source).not.toContain('entityIdentifier.create');
  });

  it('reads government exact facts from existing authoritative source delegates/tables', () => {
    expect(source).toContain('this.prisma.programElement.findMany');
    expect(source).toContain('this.prisma.programAlias.findMany');
    expect(source).toContain('this.prisma.congressBill.findMany');
    expect(source).toContain('FROM sam_opportunity');
    expect(source).toContain('FROM federal_award');
  });

  it('never calls a model, vector store, or web search from exact lookup', () => {
    expect(source).not.toMatch(/anthropic|openai|bedrock|pinecone|qdrant|weaviate|chromadb/i);
    expect(source).not.toMatch(/webSearch|searchWeb|semantic_recall/);
  });
});
