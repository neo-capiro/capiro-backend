import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const API_ROOT = process.cwd();
const REPO_ROOT = join(API_ROOT, '../..');
const read = (path: string) => readFileSync(path, 'utf8');

/**
 * Absence of a retired marker must be proven against CODE, not prose.
 *
 * A doc comment that NAMES a retired bypass in order to state that the code no
 * longer uses it is not a violation — asserting `not.toContain` on raw source
 * made these contracts permanently red (the Strategy pack comment says it owns
 * no `search_memory` call; the artifact client comment says it has no
 * send/dispatch/deliver path). Positive assertions still run against raw
 * source, because the markers they look for are real code or prompt literals.
 */
const code = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

describe('Knowledge Plane Phase 26 production-readiness architecture', () => {
  test('all declared product operations are packet-required with zero migration debt', () => {
    const registry = read(join(API_ROOT, 'src/context/context-plane-operation-registry.ts'));
    expect(registry).toContain("id: 'strategies.generate'");
    expect(registry).toContain('context_operation_migration_debt_remains');
    expect(registry).not.toContain('defineContextMigrationException');
    expect(registry).not.toContain('phase25-strategies-adoption');
    expect(registry).not.toContain('legacyPaths: [');
  });

  test('the main API owns Strategy scope, Retrieval V2 and ContextPacket compilation', () => {
    const service = read(join(API_ROOT, 'src/context/strategy-context-plane.service.ts'));
    const controller = read(join(API_ROOT, 'src/context/internal-strategy-context.controller.ts'));

    expect(service).toContain('ContextPlaneGatewayService');
    expect(service).toContain('this.contextPlane.requestContext');
    expect(service).toContain("operationId: 'strategies.generate'");
    expect(service).toContain("operationId: 'workspace.generate'");
    expect(service).toContain("operationId: 'outreach.generate'");
    expect(service).toContain('currentPhase: PHASE_26');
    // The active-membership requirement is still enforced, but it must be a
    // TENANT-SCOPED query, never a `memberships: { some: ... }` relation filter
    // hung off the un-scoped `users` lookup. `tenant_memberships` is FORCE ROW
    // LEVEL SECURITY and `capiro_app` has no BYPASSRLS, so that relation filter
    // matched zero rows for every caller in production and the whole bridge
    // failed closed. Mocked-Prisma unit tests cannot see it; this contract can.
    expect(service).toContain('this.prisma.withTenant(');
    expect(service).toContain('tx.tenantMembership.findFirst(');
    expect(service).toContain("status: 'active'");
    expect(code(service)).not.toContain('memberships: { some:');
    expect(service).toContain('memoryAccessGrants');
    expect(service).toContain('createdByUserId: user.id');
    expect(service).toContain('allowExternalLookup: false');
    const serviceCode = code(service);
    expect(serviceCode).not.toContain('Anthropic');
    expect(serviceCode).not.toContain('OpenAI');
    expect(serviceCode).not.toContain('Embedding');
    expect(serviceCode).not.toContain('vectorStore');
    expect(controller).toContain('@UseGuards(InternalServiceGuard)');
    expect(controller).toContain('artifactKind');
  });

  test('api-strategy resolves one governed bundle before its mature reasoning/mutation engine', () => {
    const client = read(
      join(REPO_ROOT, 'apps/api-strategy/src/meri/strategy-context-plane.client.ts'),
    );
    const factory = read(
      join(REPO_ROOT, 'apps/api-strategy/src/meri/governed-strategy-meri.factory.ts'),
    );
    const module = read(join(REPO_ROOT, 'apps/api-strategy/src/meri/meri.module.ts'));
    const outbound = read(
      join(REPO_ROOT, 'apps/api-strategy/src/meri/strategy-orchestrator.client.ts'),
    );

    expect(client).toContain('/api/internal/strategy/context/compile');
    expect(client).toContain("'x-internal-service-secret'");
    expect(client).toContain('Strategy Context Plane scope validation failed');
    expect(factory).toContain('RAW_STRATEGY_MERI_SERVICE');
    expect(factory).toContain('contextPlane.compile');
    expect(factory).toContain('runWithStrategyGovernedContext');
    expect(module).toContain('useFactory: createGovernedStrategyMeriService');
    expect(outbound).toContain('currentStrategyGovernedContext');
    expect(outbound).toContain('Strategy reasoning requires governed Context Plane input');
    expect(outbound).toContain('governedContext: governed');
  });

  test('the orchestrator validates the proxy and projects the shared packet instead of compiling another pack', () => {
    const controller = read(
      join(REPO_ROOT, 'apps/meriv2-orchestrator/src/meri/strategy/strategy.controller.ts'),
    );
    const pack = read(
      join(
        REPO_ROOT,
        'apps/meriv2-orchestrator/src/meri/strategy/strategy-context-pack.service.ts',
      ),
    );

    expect(controller).toContain('requireInternalContextProxy');
    expect(controller).toContain('requireGovernedContext');
    expect(controller).toContain('this.resolver.resolveIdentity');
    expect(controller).toContain("'workspace.generate'");
    expect(controller).toContain("'outreach.generate'");
    const packCode = code(pack);
    expect(pack).toContain('currentGovernedMeriContext');
    expect(packCode).not.toContain('ApiToolExecutorRepo');
    expect(packCode).not.toContain('search_memory');
    expect(packCode).not.toContain('query_knowledge_graph');
    expect(packCode).not.toContain('search_client_knowledge');
    expect(packCode).not.toContain('get_client_context');
    expect(packCode).not.toContain('Embedding');
    expect(packCode).not.toContain('vector');
  });

  test('Strategy-owned Retrieval V2 projection excludes execution authority and private conversations', () => {
    const adapter = read(
      join(
        API_ROOT,
        'src/retrieval/adapters/strategy-work-retrieval.adapter.ts',
      ),
    );
    const retrievalModule = read(join(API_ROOT, 'src/retrieval/retrieval.module.ts'));

    expect(adapter).toContain("readonly key = 'strategies-work'");
    expect(adapter).toContain('sp_strategy');
    expect(adapter).toContain('sp_node');
    expect(adapter).toContain('sp_context_document');
    expect(adapter).toContain('sp_context_fact');
    expect(adapter).toContain('sp_context_conflict');
    const adapterCode = code(adapter);
    for (const forbiddenTable of [
      'sp_agent_run',
      'sp_change_set',
      'sp_event_outbox',
      'sp_strategy_chat_message',
    ]) {
      expect(adapterCode).not.toContain(forbiddenTable);
    }
    expect(retrievalModule).toContain('StrategyWorkRetrievalAdapter');
    expect(retrievalModule).toContain('[core, institutional, strategyWork]');
  });

  test('Context packets do not grant execution or send authority', () => {
    const strategyPrompt = read(
      join(API_ROOT, 'src/context/strategy-context-plane.service.ts'),
    );
    const execution = read(
      join(REPO_ROOT, 'apps/api-strategy/src/agents/execution.service.ts'),
    );
    const artifactClient = read(
      join(REPO_ROOT, 'apps/api-strategy/src/agents/execution-artifact.client.ts'),
    );

    expect(strategyPrompt).toContain('It cannot authorize execution, sending, approval');
    expect(execution).toContain('awaiting send approval');
    expect(execution).toContain('verifyRunApproval');
    expect(execution).toContain('evaluateG0');
    const artifactClientCode = code(artifactClient);
    expect(artifactClientCode).not.toContain('/send');
    expect(artifactClientCode).not.toContain('/dispatch');
    expect(artifactClientCode).not.toContain('/deliver');
  });
});
