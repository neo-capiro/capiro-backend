import fs from 'node:fs';
import path from 'node:path';

const apiRoot = process.cwd();
const resolverPath = path.join(apiRoot, 'src/context/context-resolver.service.ts');
const typesPath = path.join(apiRoot, 'src/context/context-resolver.types.ts');
const modulePath = path.join(apiRoot, 'src/context/context.module.ts');

describe('Knowledge Plane Phase 15 Context Resolver architecture', () => {
  test('uses the shared entity resolver and Retrieval V2 without owning storage or reasoning', () => {
    const source = fs.readFileSync(resolverPath, 'utf8');

    expect(source).toContain('UniversalEntityResolutionOrchestratorService');
    expect(source).toContain('RetrievalV2Service');
    expect(source).not.toContain('PrismaService');
    expect(source).not.toContain('Anthropic');
    expect(source).not.toContain('OpenAI');
    expect(source).not.toContain('EmbeddingProvider');
    expect(source).not.toContain('RERANKING_PROVIDER');
  });

  test('resolves scope before retrieval and never auto-registers a public entity', () => {
    const source = fs.readFileSync(resolverPath, 'utf8');
    const resolveIndex = source.indexOf('const resolution = await this.resolve(request)');
    const retrievalIndex = source.indexOf(
      'this.retrieval.retrieve(resolution.retrievalRequest)',
    );

    expect(resolveIndex).toBeGreaterThan(-1);
    expect(retrievalIndex).toBeGreaterThan(resolveIndex);
    expect(source).toContain('allowAuthoritativePublicRegistration: false');
  });

  test('requires request and SecurityScope permission before external lookup', () => {
    const source = fs.readFileSync(resolverPath, 'utf8');

    expect(source).toContain('request.subject?.allowExternalLookup === true');
    expect(source).toContain('securityScope.allowExternalLookup');
    expect(source).toContain(
      'allowExternalLookup: request.securityScope.allowExternalLookup === true',
    );
  });

  test('reuses the compiler ContextSurface vocabulary rather than creating a parallel list', () => {
    const source = fs.readFileSync(typesPath, 'utf8');

    expect(source).toContain('ContextSurface as CompilerContextSurface');
    expect(source).toContain('CONTEXT_RESOLVER_ADDITIONAL_SURFACES');
    expect(source).not.toContain('export const CONTEXT_SURFACES');
  });

  test('extends the existing shared ContextModule instead of replacing its compiler boundary', () => {
    const source = fs.readFileSync(modulePath, 'utf8');

    expect(source).toContain('ContextCompilerService');
    expect(source).toContain('ContextPersistenceBoundaryService');
    expect(source).toContain('ContextResolverService');
    expect(source).toContain('KnowledgeModule');
    expect(source).toContain('RetrievalModule');
  });

  test('does not implement Phase 17 ContextPacket V2 persistence', () => {
    const source = fs.readFileSync(resolverPath, 'utf8');

    expect(source).not.toContain('contextPacket.create');
    expect(source).not.toContain('contextPacket.update');
    expect(source).not.toContain('ContextPacketStatus');
  });
});
