/**
 * Phase 1 backlog #6 — "Governed recall in the full API".
 *
 * Phase 0's checks-report.md blocker for D2a/D2 was NOT missing wiring:
 * `meri.module.ts` already binds `MERI_HERMES_RECALL_PORT` to the real
 * `ContextPlaneRecallPort` (which re-enters `MeriContextPlaneService.
 * searchToolData` — the exact canonical boundary `search_memory` uses), never
 * the harness's `DirectMemoryItemsRecallPort` prototype. The blocker was that
 * this had never been run END TO END against real data. This spec is that
 * missing evidence.
 *
 * It boots the REAL classes on the real institutional-memory rail:
 * `MeriHermesBrokerService.recall()` -> `ContextPlaneRecallPort.recall()` ->
 * `MeriContextPlaneService.searchToolData()` -> a governed `resolverRequest`
 * -> the REAL `ContextResolverService.resolveAndRetrieve()` -> the REAL
 * `InstitutionalKnowledgeRetrievalAdapter.retrieve()`, which reads real rows
 * from `memory_items` in the LOCAL fixture Postgres (container
 * `capiro-postgres`) with the real governance/ethical-wall SQL predicates.
 *
 * The only stand-in is `ContextPlaneGatewayService` itself (the full gateway
 * additionally orchestrates domains this ticket does not touch, audit
 * logging and packet compilation): in its place a minimal shim calls the
 * real resolver directly, exactly as the existing (mocked-persistence)
 * `meri-memory-context.integration.spec.ts` already does — this spec follows
 * that same precedent but swaps the fake `tx` for the real local database, no
 * existing spec already goes further than that. `UniversalEntityResolutionOrchestratorService`
 * and `TemporalKnowledgeGraphService` are unused by the institutional-memory
 * governed-memory query class (`lookup`), same as that precedent, so a dummy
 * is safe. The embedding provider is a stub that rejects (real production
 * behaviour already tolerates an unavailable embedding provider and falls
 * back to lexical ranking — proven by the same precedent spec) so this test
 * needs no external embeddings API.
 */
import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { MemoryCandidateService } from '../../memory/memory-candidate.service.js';
import { MeriContextPlaneService } from '../meri-context-plane.service.js';
import { ContextResolverService } from '../../context/context-resolver.service.js';
import type { ContextResolutionRequest } from '../../context/context-resolver.types.js';
import { InstitutionalKnowledgeRetrievalAdapter } from '../../retrieval/adapters/institutional-knowledge-retrieval.adapter.js';
import { buildCoverageManifest } from '../../retrieval/coverage-manifest.js';
import type { RetrievalRequest, SemanticDatasetDescriptor } from '../../retrieval/retrieval-v2.types.js';
import type { TemporalKnowledgeGraphService } from '../../knowledge/graph/temporal-knowledge-graph.service.js';
import type { EmbeddingProvider } from '../../embeddings/embedding-provider.js';
import { MeriHermesBrokerService, type MeriHermesBrokerAuth } from './meri-hermes-broker.service.js';
import { ContextPlaneRecallPort } from './meri-hermes-recall.ports.js';
import type { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import type { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';
import { MeriHermesRunStore } from './meri-hermes-run-store.js';
import type { MeriHermesAuthorizationEnvelope } from './hermes-runtime.contracts.js';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-governed-recall.integration.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-governed-recall.integration.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

describe('Phase 1 backlog #6 — governed recall through the REAL ContextPlaneRecallPort / MeriContextPlaneService, against real Postgres', () => {
  let prisma: PrismaService;
  let runs: MeriHermesRunStore;
  let broker: MeriHermesBrokerService;
  const tenantId = randomUUID();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  let aliceCtx: TenantContext;
  let bobCtx: TenantContext;
  const firmFactId = randomUUID();
  const aliceFactId = randomUUID();
  const firmMarker = `firm-diligence-marker-${randomUUID().slice(0, 8)}`;
  const privateMarker = `alice-private-marker-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    runs = new MeriHermesRunStore();

    // Real resolver + real institutional-memory adapter against the real
    // local database; the embedding provider rejects (no external calls),
    // which the production adapter already tolerates (lexical fallback).
    const embeddingProvider: Pick<EmbeddingProvider, 'embed'> = {
      embed: async () => {
        throw new Error('no embeddings provider in this test');
      },
    };
    const adapter = new InstitutionalKnowledgeRetrievalAdapter(
      {} as TemporalKnowledgeGraphService, // unused: query class 'lookup' never reaches the temporal-graph path
      prisma,
      embeddingProvider as EmbeddingProvider,
    );
    const retrieve = async (request: RetrievalRequest) => {
      const result = await adapter.retrieve({ domain: 'institutional_knowledge' } as SemanticDatasetDescriptor, request);
      return { records: result.records, coverage: buildCoverageManifest(request.requestedDomains, [result]), observability: {} };
    };
    const resolver = new ContextResolverService(
      {} as never, // unused: subjectScope 'general'/'client' with no `subject` input never calls the entity resolver
      { retrieve } as never,
    );
    const gatewayShim = {
      requestContext: async ({ resolverRequest }: { resolverRequest: ContextResolutionRequest }) => ({
        kind: 'governed_packet' as const,
        context: await resolver.resolveAndRetrieve(resolverRequest),
        packet: { persisted: false, packetId: null, items: [], exclusions: [], rendered: [] },
      }),
    };
    const contextPlane = new MeriContextPlaneService(prisma, gatewayShim as never);
    const recallPort = new ContextPlaneRecallPort(contextPlane);

    broker = new MeriHermesBrokerService(
      prisma,
      runs,
      {} as MemoryCandidateService, // unused by recall()
      recallPort,
      {} as MeriHermesRuntimeAdapter, // unused by recall()
      {} as MeriHermesArtifactStorageService, // unused by recall()
    );

    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `meri-hermes-recall-${tenantId}`, name: 'Meri Hermes governed recall fixture', status: 'active' },
      });
      for (const id of [aliceId, bobId]) {
        await tx.user.create({ data: { id, clerkUserId: id, email: `${id}@meri-hermes-recall.example.test` } });
        await tx.tenantMembership.create({ data: { tenantId, userId: id, role: 'standard_user', status: 'active', joinedAt: new Date() } });
      }

      // Firm-scope fact: memory_class + governed_status set to an eligible,
      // approved state (the columns' schema DEFAULTS are 'legacy_unclassified'
      // / 'pending_review' — a quarantine state that the real governed SQL
      // filter deliberately excludes; see MemoryItem in schema.prisma). This
      // is the gap the Phase 0 harness's simpler seed script does not close —
      // its rows never satisfy the real production governance predicate.
      //
      // `institutional_authoritative`'s MEMORY_CLASS_POLICIES entry
      // (packages/meriv2-core/src/memory/governance.ts) additionally requires
      // a real source (source_type != 'unknown', the schema default) and
      // human approval (approved_by_user_id set) — filterGovernedMemory()
      // silently excludes an otherwise-eligible row missing either, which a
      // first pass at this fixture (memory_class + governed_status alone)
      // missed entirely.
      const firmSections = JSON.stringify([
        { key: 'summary', heading: 'Summary', owner: 'human', body: `Firm diligence checklist: ${firmMarker}.` },
      ]);
      await tx.$executeRaw`
        INSERT INTO memory_items (
          id, tenant_id, client_id, owner_user_id, type, visibility, slug, title,
          source, provenance, sections_jsonb, status, memory_class, memory_authority, governed_status,
          source_type, approved_by_user_id, approved_at
        ) VALUES (
          ${firmFactId}::uuid, ${tenantId}::uuid, NULL, NULL, 'note', 'tenant', ${'firm-diligence-' + firmFactId}, 'Firm diligence checklist',
          'manual', 'human', ${firmSections}::jsonb, 'active', 'institutional_authoritative', 'firm_approved', 'active',
          'manual', ${aliceId}::uuid, now()
        )`;

      // Alice's PRIVATE fact: memory_scope='user_private', owner=Alice. Bob
      // must never see it, governed by filterGovernedMemory's wrong_user
      // check, not by the coarser `visibility` column alone. Same source +
      // approval requirements as the firm fact above (same memory_class).
      const privateSections = JSON.stringify([
        { key: 'summary', heading: 'Summary', owner: 'human', body: `Alice's private note: ${privateMarker}.` },
      ]);
      await tx.$executeRaw`
        INSERT INTO memory_items (
          id, tenant_id, client_id, owner_user_id, type, visibility, slug, title,
          source, provenance, sections_jsonb, status, memory_class, memory_authority, governed_status, memory_scope,
          source_type, approved_by_user_id, approved_at
        ) VALUES (
          ${aliceFactId}::uuid, ${tenantId}::uuid, NULL, ${aliceId}::uuid, 'note', 'user', ${'alice-private-' + aliceFactId}, 'Alice private note',
          'manual', 'human', ${privateSections}::jsonb, 'active', 'institutional_authoritative', 'user_asserted', 'active', 'user_private',
          'manual', ${aliceId}::uuid, now()
        )`;
    });

    aliceCtx = { tenantId, tenantSlug: 'fixture', userId: aliceId, clerkUserId: aliceId, role: 'standard_user' };
    bobCtx = { tenantId, tenantSlug: 'fixture', userId: bobId, clerkUserId: bobId, role: 'standard_user' };
  });

  afterAll(async () => {
    await prisma.withSystem((tx) => tx.$executeRaw`DELETE FROM memory_items WHERE id IN (${firmFactId}::uuid, ${aliceFactId}::uuid)`).catch(() => undefined);
    await prisma.withSystem((tx) => tx.tenant.delete({ where: { id: tenantId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: aliceId } })).catch(() => undefined);
    await prisma.withSystem((tx) => tx.user.delete({ where: { id: bobId } })).catch(() => undefined);
    await prisma.$disconnect();
  });

  function envelope(ctx: TenantContext): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      conversationId: randomUUID(),
      workspaceId: null,
      executionScopeId: privateExecutionScopeId(ctx.tenantId, ctx.userId),
      audience: 'private',
      authorizedClientIds: [],
      authorizedMailboxConnectionIds: [],
      toolPolicy: { allow: ['meri_memory_search'], deny: [], readOnly: false },
      authorizationVersion: 'v1',
      runId: randomUUID(),
      traceId: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      budget: { maxToolCalls: 40, maxOutputTokens: 8000, maxWallClockMs: 600_000 },
    };
  }

  async function authFor(ctx: TenantContext): Promise<MeriHermesBrokerAuth> {
    const run = await runs.create({
      envelope: envelope(ctx),
      actorContext: ctx,
      idempotencyKey: `meri:${randomUUID()}`,
      userMessageId: null,
    });
    await runs.update(run.runId, { hermesRunId: `hermes-recall-${randomUUID()}`, status: 'running' });
    return { claims: {} as never, run: (await runs.get(run.runId))!, membershipRole: 'standard_user' };
  }

  test('a firm-scope memory fact is returned via broker.recall() -> ContextPlaneRecallPort with a real sourceId and coverage, path=context_plane', async () => {
    const auth = await authFor(aliceCtx);
    const result = await broker.recall(auth, { query: firmMarker, limit: 8 });

    expect(result.path).toBe('context_plane');
    expect(result.coverage).toBeDefined();
    expect(typeof result.coverage.returned).toBe('number');
    const match = result.items.find((item) => item.sourceId === firmFactId);
    expect(match).toBeDefined();
    expect(match?.excerpt).toContain(firmMarker);
  });

  test("a different user's private fact is NOT returned to an unauthorized caller (Bob never sees Alice's user_private note)", async () => {
    const auth = await authFor(bobCtx);
    const result = await broker.recall(auth, { query: privateMarker, limit: 8 });

    expect(result.path).toBe('context_plane');
    expect(result.items.find((item) => item.sourceId === aliceFactId)).toBeUndefined();
  });

  test("the owning user CAN recall her own private fact (proves the exclusion above is ownership-based, not a query miss)", async () => {
    const auth = await authFor(aliceCtx);
    const result = await broker.recall(auth, { query: privateMarker, limit: 8 });

    expect(result.path).toBe('context_plane');
    const match = result.items.find((item) => item.sourceId === aliceFactId);
    expect(match).toBeDefined();
    expect(match?.excerpt).toContain(privateMarker);
  });
});
