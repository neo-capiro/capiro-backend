/**
 * A8 — "a Hermes answer emits no citations, and P1-08 requires them".
 *
 * P1-08's vertical-slice criterion is "performs a permitted broker read, emits
 * supported progress/CITATIONS and saves one final response". Before this work
 * `grep -il citation` across the non-spec sources in apps/api/src/meri/hermes/
 * returned nothing: the Hermes path emitted the `tool.completed ->
 * {type:'sources'}` trust step (tool provenance) and no record-level citation,
 * while the V3 path cited its sources — a visible regression against "preserve
 * the existing Meri experience".
 *
 * WHAT THIS SPEC PROVES, END TO END, AGAINST REAL POSTGRES:
 *
 *  1. A governed recall performed in a run yields citations carrying the REAL
 *     `memory_items` source ids, on the PERSISTED assistant ClioMessage, in the
 *     same `metadata.citations` key and the same `MeriCitation` shape the V3
 *     path writes — and emitted in the same `{type:'citations'}` SSE frame the
 *     existing web client already consumes.
 *  2. A run with no retrieval yields no citations and no citations frame.
 *  3. Citations never leak a record the envelope did not authorize: the same
 *     query, run by a user who may not read the record, cites nothing.
 *
 * REAL vs STAND-IN. The recall is the REAL `MeriHermesBrokerService.recall()`
 * -> REAL `ContextPlaneRecallPort` -> REAL `MeriContextPlaneService` -> REAL
 * `ContextResolverService` -> REAL `InstitutionalKnowledgeRetrievalAdapter`
 * reading real rows out of the local fixture Postgres, with the real
 * governance/ethical-wall SQL predicates. The finalization is the REAL
 * `MeriHermesRuntimeAdapter.finalize()` against the REAL
 * `MeriHermesPrismaRunRepository`, writing a real `clio_messages` row. The only
 * stand-ins are the Hermes HTTP client (there is no worker container in this
 * tier) and the Context Plane gateway shim, which follows the precedent set by
 * meri-hermes-governed-recall.integration.spec.ts.
 *
 * ONE PENDING DEPENDENCY, DELIBERATELY NOT PAPERED OVER. See
 * `recordRecallForCitations()` below: `MeriHermesBrokerService.recall()`
 * currently appends its `memory.recalled` run event with counts only
 * (`{path, returned, coverage}`) and NOT the recalled items, and that file is
 * out of scope for this change. This spec therefore records the REAL recall
 * result (never a synthetic one) into the event the broker must write, and
 * becomes a no-op the moment the broker records it itself.
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
import { ContextPlaneRecallPort, type MeriHermesRecallResult } from './meri-hermes-recall.ports.js';
import { MeriHermesRuntimeAdapter } from './meri-hermes-runtime.adapter.js';
import type { MeriHermesArtifactStorageService } from './meri-hermes-artifact-storage.service.js';
import { MeriHermesPrismaRunRepository } from './meri-hermes-prisma-run-repository.js';
import type { MeriHermesRunRecord } from './meri-hermes-run-store.js';
import type { MeriHermesRuntimeClient } from './meri-hermes-runtime.client.js';
import type { MeriHermesAuthorizationEnvelope, MeriSseFrame } from './hermes-runtime.contracts.js';
import { privateExecutionScopeId } from './meri-hermes-worker-token.js';

function assertLocalFixtureDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is required to run meri-hermes-citations.integration.spec.ts');
  const parsed = new URL(url);
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new Error(
      `meri-hermes-citations.integration.spec.ts refuses to run against a non-local DATABASE_URL host (${parsed.hostname}). ` +
        'This suite writes and deletes rows and must only ever target the local fixture Postgres.',
    );
  }
}
assertLocalFixtureDatabase(process.env.DATABASE_URL);

jest.setTimeout(120_000);

describe('A8 — a Hermes turn cites the governed records it actually read (real local Postgres)', () => {
  let prisma: PrismaService;
  let repo: MeriHermesPrismaRunRepository;
  let broker: MeriHermesBrokerService;
  let adapter: MeriHermesRuntimeAdapter;

  const tenantId = randomUUID();
  const aliceId = randomUUID();
  const bobId = randomUUID();
  let aliceCtx: TenantContext;
  let bobCtx: TenantContext;

  /**
   * A second tenant with NO institutional memory at all, used to observe a
   * genuinely empty governed recall.
   *
   * A nonsense query is NOT a way to get one: with the embedding provider
   * unavailable the institutional-knowledge adapter falls back to lexical
   * ranking for the `lookup` query class, which RANKS rather than filters, so
   * an unmatched query still returns the tenant's visible governed rows. That
   * is the rail's real behaviour and this spec observes it rather than
   * pretending otherwise — so "the recall returned nothing" is staged by
   * having nothing to return.
   */
  const emptyTenantId = randomUUID();
  const carolId = randomUUID();
  let carolCtx: TenantContext;

  const firmFactId = randomUUID();
  const aliceFactId = randomUUID();
  const firmMarker = `firm-citation-marker-${randomUUID().slice(0, 8)}`;
  const privateMarker = `alice-citation-marker-${randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    prisma = new PrismaService();
    await prisma.$connect();
    repo = new MeriHermesPrismaRunRepository(prisma);

    // ---- real governed-recall rail (same construction as
    // meri-hermes-governed-recall.integration.spec.ts) --------------------
    const embeddingProvider: Pick<EmbeddingProvider, 'embed'> = {
      embed: async () => {
        throw new Error('no embeddings provider in this test');
      },
    };
    const retrievalAdapter = new InstitutionalKnowledgeRetrievalAdapter(
      {} as TemporalKnowledgeGraphService,
      prisma,
      embeddingProvider as EmbeddingProvider,
    );
    const retrieve = async (request: RetrievalRequest) => {
      const result = await retrievalAdapter.retrieve(
        { domain: 'institutional_knowledge' } as SemanticDatasetDescriptor,
        request,
      );
      return {
        records: result.records,
        coverage: buildCoverageManifest(request.requestedDomains, [result]),
        observability: {},
      };
    };
    const resolver = new ContextResolverService({} as never, { retrieve } as never);
    const gatewayShim = {
      requestContext: async ({ resolverRequest }: { resolverRequest: ContextResolutionRequest }) => ({
        kind: 'governed_packet' as const,
        context: await resolver.resolveAndRetrieve(resolverRequest),
        packet: { persisted: false, packetId: null, items: [], exclusions: [], rendered: [] },
      }),
    };
    const contextPlane = new MeriContextPlaneService(prisma, gatewayShim as never);
    const recallPort = new ContextPlaneRecallPort(contextPlane);

    // ---- real adapter, Hermes HTTP client stubbed -------------------------
    const runtime = {
      createRun: async () => ({ runId: `hermes-${randomUUID()}`, status: 'started', sessionId: null, replayed: false }),
      getRun: async (id: string) => ({ run_id: id, status: 'completed', output: '' }),
      streamRunEvents: async () => undefined,
      stopRun: async () => ({}),
    };
    adapter = new MeriHermesRuntimeAdapter(
      prisma,
      { isMeriHermesRuntimeEnabled: async () => true, isEnabled: async () => false } as never,
      { forScope: () => runtime } as unknown as MeriHermesRuntimeClient,
      repo,
      { securityEnvelope: async () => ({ authorizedClientIds: [], authorizedMailboxConnectionIds: [] }) } as never,
      { scheduleAfterTurnMaintenance: () => undefined } as never,
    );
    adapter.env = {
      ...process.env,
      MERI_HERMES_RUNTIME_URL: 'http://localhost:1/hermes-stub',
      MERI_HERMES_API_KEY: 'stub-key',
      MERI_HERMES_BROKER_SIGNING_KEY: 'x'.repeat(40),
      MERI_HERMES_MODEL: 'hermes-pinned-test-model',
    };

    broker = new MeriHermesBrokerService(
      prisma,
      repo,
      {} as MemoryCandidateService, // unused by recall()
      recallPort,
      adapter,
      {} as MeriHermesArtifactStorageService, // unused by recall()
    );

    // ---- fixture rows -----------------------------------------------------
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: { id: tenantId, slug: `meri-hermes-cite-${tenantId}`, name: 'Meri Hermes citations fixture', status: 'active' },
      });
      for (const id of [aliceId, bobId]) {
        await tx.user.create({ data: { id, clerkUserId: id, email: `${id}@meri-hermes-cite.example.test` } });
        await tx.tenantMembership.create({
          data: { tenantId, userId: id, role: 'standard_user', status: 'active', joinedAt: new Date() },
        });
      }

      // Firm-scope governed fact. The explicit memory_class / governed_status /
      // source_type / approval columns are what the REAL governance predicate
      // requires; the schema defaults would be filtered out as quarantined.
      const firmSections = JSON.stringify([
        { key: 'summary', heading: 'Summary', owner: 'human', body: `Firm citation checklist: ${firmMarker}.` },
      ]);
      await tx.$executeRaw`
        INSERT INTO memory_items (
          id, tenant_id, client_id, owner_user_id, type, visibility, slug, title,
          source, provenance, sections_jsonb, status, memory_class, memory_authority, governed_status,
          source_type, approved_by_user_id, approved_at
        ) VALUES (
          ${firmFactId}::uuid, ${tenantId}::uuid, NULL, NULL, 'note', 'tenant', ${'firm-cite-' + firmFactId}, 'Firm citation checklist',
          'manual', 'human', ${firmSections}::jsonb, 'active', 'institutional_authoritative', 'firm_approved', 'active',
          'manual', ${aliceId}::uuid, now()
        )`;

      // Alice's PRIVATE fact. Bob must never see it, and therefore must never
      // cite it.
      const privateSections = JSON.stringify([
        { key: 'summary', heading: 'Summary', owner: 'human', body: `Alice private citation note: ${privateMarker}.` },
      ]);
      await tx.$executeRaw`
        INSERT INTO memory_items (
          id, tenant_id, client_id, owner_user_id, type, visibility, slug, title,
          source, provenance, sections_jsonb, status, memory_class, memory_authority, governed_status, memory_scope,
          source_type, approved_by_user_id, approved_at
        ) VALUES (
          ${aliceFactId}::uuid, ${tenantId}::uuid, NULL, ${aliceId}::uuid, 'note', 'user', ${'alice-cite-' + aliceFactId}, 'Alice private citation note',
          'manual', 'human', ${privateSections}::jsonb, 'active', 'institutional_authoritative', 'user_asserted', 'active', 'user_private',
          'manual', ${aliceId}::uuid, now()
        )`;
    });

    // Second tenant, deliberately seeded with no memory_items at all.
    await prisma.withSystem(async (tx) => {
      await tx.tenant.create({
        data: { id: emptyTenantId, slug: `meri-hermes-cite-empty-${emptyTenantId}`, name: 'Meri Hermes citations empty fixture', status: 'active' },
      });
      await tx.user.create({ data: { id: carolId, clerkUserId: carolId, email: `${carolId}@meri-hermes-cite.example.test` } });
      await tx.tenantMembership.create({
        data: { tenantId: emptyTenantId, userId: carolId, role: 'standard_user', status: 'active', joinedAt: new Date() },
      });
    });

    aliceCtx = { tenantId, tenantSlug: 'fixture', userId: aliceId, clerkUserId: aliceId, role: 'standard_user' };
    bobCtx = { tenantId, tenantSlug: 'fixture', userId: bobId, clerkUserId: bobId, role: 'standard_user' };
    carolCtx = { tenantId: emptyTenantId, tenantSlug: 'fixture-empty', userId: carolId, clerkUserId: carolId, role: 'standard_user' };
  });

  afterAll(async () => {
    await prisma
      .withSystem((tx) => tx.$executeRaw`DELETE FROM memory_items WHERE id IN (${firmFactId}::uuid, ${aliceFactId}::uuid)`)
      .catch(() => undefined);
    for (const id of [tenantId, emptyTenantId]) {
      await prisma.withSystem((tx) => tx.tenant.delete({ where: { id } })).catch(() => undefined);
    }
    for (const id of [aliceId, bobId, carolId]) {
      await prisma.withSystem((tx) => tx.user.delete({ where: { id } })).catch(() => undefined);
    }
    await prisma.$disconnect();
  });

  // ---------------------------------------------------------------------------
  // fixture helpers
  // ---------------------------------------------------------------------------

  function envelope(ctx: TenantContext, conversationId: string): MeriHermesAuthorizationEnvelope {
    return {
      version: 1,
      tenantId: ctx.tenantId,
      actorType: 'user',
      actorId: ctx.userId,
      conversationId,
      workspaceId: null,
      executionScopeId: privateExecutionScopeId(ctx.tenantId, ctx.userId),
      audience: 'private',
      authorizedClientIds: [],
      authorizedMailboxConnectionIds: [],
      toolPolicy: { allow: ['meri_memory_search'], deny: [], readOnly: true },
      authorizationVersion: 'v1',
      runId: randomUUID(),
      traceId: randomUUID(),
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      budget: { maxToolCalls: 40, maxOutputTokens: 8000, maxWallClockMs: 600_000 },
    };
  }

  async function newConversation(ctx: TenantContext): Promise<string> {
    const id = randomUUID();
    await prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.create({ data: { id, tenantId: ctx.tenantId, userId: ctx.userId, title: 'Citations fixture' } }),
    );
    return id;
  }

  /** A live run, bound to Hermes, ready to take broker calls. */
  async function liveRun(ctx: TenantContext): Promise<MeriHermesRunRecord> {
    const conversationId = await newConversation(ctx);
    const created = await repo.create({
      envelope: envelope(ctx, conversationId),
      actorContext: ctx,
      idempotencyKey: `meri:${randomUUID()}`,
      userMessageId: null,
    });
    await repo.update(created.runId, { hermesRunId: `hermes-cite-${randomUUID()}`, status: 'running' });
    return (await repo.get(created.runId))!;
  }

  function authFor(run: MeriHermesRunRecord): MeriHermesBrokerAuth {
    return { claims: {} as never, run, membershipRole: 'standard_user' };
  }

  /**
   * Record the recall the broker just performed in the durable run event the
   * citation translator reads.
   *
   * `MeriHermesBrokerService.recall()` already appends `memory.recalled`, but
   * today it appends COUNTS only (`{path, returned, coverage}`) — the recalled
   * items are returned over HTTP to the worker and never written down. The
   * consuming/finalizing replica is a different process from the one that
   * served the broker call, so the durable event is the only place the items
   * can be read back from, and building citations from anything else (the
   * truncated `tool.completed` preview, a second query) would either fabricate
   * or widen.
   *
   * Recording them is a one-line change inside `recall()`, which is owned by
   * the concurrent authorization workstream and out of scope here. So this
   * helper writes the event the broker MUST write, from the REAL recall result
   * — never from a synthetic one — and no-ops as soon as the broker records the
   * items itself, at which point this spec is an unmodified end-to-end test.
   */
  async function recordRecallForCitations(
    run: MeriHermesRunRecord,
    result: MeriHermesRecallResult,
  ): Promise<void> {
    const events = await repo.eventsAfter(run.runId, 0, 'all');
    const alreadyRecorded = events.some(
      (event) => event.kind === 'memory.recalled' && Array.isArray(event.payload.items),
    );
    if (alreadyRecorded) return;
    await repo.append(
      run.runId,
      'memory.recalled',
      { path: result.path, returned: result.items.length, coverage: result.coverage, items: result.items, frames: [] },
      'internal',
    );
  }

  /** Finalize the turn through the REAL adapter and read back what it published. */
  async function finalizeAndRead(run: MeriHermesRunRecord, answer: string) {
    const current = (await repo.get(run.runId))!;
    await adapter.stopWorkerAndFinalize(current, {
      finishReason: 'stop',
      partial: false,
      output: answer,
      error: null,
    });
    const after = (await repo.get(run.runId))!;
    const message = await prisma.withTenant(run.envelope.tenantId, (tx) =>
      tx.clioMessage.findFirst({
        where: { conversationId: run.envelope.conversationId, role: 'assistant' },
        select: { id: true, body: true, metadata: true },
      }),
    );
    const events = await repo.eventsAfter(run.runId, 0, 'public');
    const finalEvent = events.find((event) => event.payload.final === true);
    const frames = (Array.isArray(finalEvent?.payload.frames) ? finalEvent!.payload.frames : []) as MeriSseFrame[];
    const metadata = JSON.parse(JSON.stringify(message?.metadata ?? {})) as Record<string, unknown>;
    return { run: after, message, metadata, frames };
  }

  const citationsOf = (metadata: Record<string, unknown>) =>
    (Array.isArray(metadata.citations) ? metadata.citations : []) as Array<Record<string, unknown>>;

  // ---------------------------------------------------------------------------
  // 1. a governed recall in a run yields citations with REAL source ids
  // ---------------------------------------------------------------------------

  test('a governed recall yields citations with the REAL memory_items source id on the persisted assistant message', async () => {
    const run = await liveRun(aliceCtx);

    // REAL broker read: assertTool -> ContextPlaneRecallPort -> Context Plane
    // -> resolver -> institutional-knowledge adapter -> Postgres, then the F-1
    // pre-release recheck.
    const result = await broker.recall(authFor(run), { query: firmMarker, limit: 8 });
    expect(result.path).toBe('context_plane');
    const recalled = result.items.find((item) => item.sourceId === firmFactId);
    expect(recalled).toBeDefined();
    await recordRecallForCitations(run, result);

    const { message, metadata, frames } = await finalizeAndRead(run, 'The checklist requires a conflict check.');

    // (a) persisted on the assistant message, in the V3 key and shape
    expect(message).not.toBeNull();
    const citations = citationsOf(metadata);
    const cited = citations.find((citation) => citation.id === firmFactId);
    expect(cited).toBeDefined();
    expect(cited).toMatchObject({
      n: expect.any(Number),
      type: 'memory',
      id: firmFactId, // the REAL memory_items row id, not a run id or a tool name
      title: 'Firm citation checklist',
      url: null,
      tool: 'meri_memory_search',
      source: { kind: 'memory', recordId: firmFactId },
    });
    expect(String(cited!.snippet)).toContain(firmMarker);

    // (b) emitted as the frame the existing UI already consumes, before `done`
    const citationsFrame = frames.find((frame) => frame.type === 'citations');
    expect(citationsFrame).toBeDefined();
    expect(citationsFrame!.citations).toEqual(citations);
    expect(frames.findIndex((f) => f.type === 'citations')).toBeLessThan(
      frames.findIndex((f) => f.type === 'done'),
    );

    // (c) the pre-existing tool-progress signal is untouched: trust steps are
    //     still tool provenance and are a different thing from citations.
    expect(metadata).toHaveProperty('trustSteps');
  });

  // ---------------------------------------------------------------------------
  // 2. no retrieval -> no citations
  // ---------------------------------------------------------------------------

  test('a run with no retrieval yields no citations and no citations frame', async () => {
    const run = await liveRun(aliceCtx);
    const { metadata, frames } = await finalizeAndRead(run, 'Answered from the conversation alone.');

    expect(citationsOf(metadata)).toEqual([]);
    expect(frames.find((frame) => frame.type === 'citations')).toBeUndefined();
    expect(frames.some((frame) => frame.type === 'done')).toBe(true);
  });

  test('a governed recall that released NOTHING is never turned into a citation', async () => {
    // Carol's tenant has no institutional memory, so the REAL rail returns a
    // real empty result: `returned: 0` with a coverage manifest that still
    // reports a healthy source. Nothing in that — not the query, not the
    // coverage row, not the fact that a permitted tool ran — may become a
    // source chip.
    const run = await liveRun(carolCtx);
    const result = await broker.recall(authFor(run), { query: 'quarterly diligence checklist', limit: 8 });
    expect(result.path).toBe('context_plane');
    expect(result.items).toEqual([]);
    await recordRecallForCitations(run, result);

    const { metadata, frames } = await finalizeAndRead(run, 'I could not find anything on that.');
    expect(citationsOf(metadata)).toEqual([]);
    expect(frames.find((frame) => frame.type === 'citations')).toBeUndefined();
    // The tool DID run, and its trust step is still recorded — the point is
    // that tool provenance is not promoted into a record-level citation.
    const recallEvents = (await repo.eventsAfter(run.runId, 0, 'all')).filter((e) => e.kind === 'memory.recalled');
    expect(recallEvents.length).toBeGreaterThan(0);
  });

  test('the citation set is EXACTLY what the governed recall released — never widened', async () => {
    const run = await liveRun(aliceCtx);
    const result = await broker.recall(authFor(run), { query: firmMarker, limit: 8 });
    expect(result.items.length).toBeGreaterThan(0);
    await recordRecallForCitations(run, result);

    const { metadata } = await finalizeAndRead(run, 'Here is what the firm record says.');
    expect(citationsOf(metadata).map((citation) => citation.id)).toEqual(
      result.items.map((item) => item.sourceId),
    );
  });

  // ---------------------------------------------------------------------------
  // 3. citations never leak an unauthorized record
  // ---------------------------------------------------------------------------

  test("citations do not leak a record the envelope did not authorize: Bob cites nothing for Alice's private note", async () => {
    // Control: Alice CAN read her own private note, so it IS citable for her.
    const aliceRun = await liveRun(aliceCtx);
    const aliceResult = await broker.recall(authFor(aliceRun), { query: privateMarker, limit: 8 });
    expect(aliceResult.items.some((item) => item.sourceId === aliceFactId)).toBe(true);
    await recordRecallForCitations(aliceRun, aliceResult);
    const alice = await finalizeAndRead(aliceRun, 'Your note says the following.');
    expect(citationsOf(alice.metadata).map((c) => c.id)).toContain(aliceFactId);

    // Bob runs the SAME query. The recall is authorization-filtered upstream,
    // so the record never reaches the run, and therefore never reaches the
    // citations — the citation path inherits the filter and does not widen it.
    const bobRun = await liveRun(bobCtx);
    const bobResult = await broker.recall(authFor(bobRun), { query: privateMarker, limit: 8 });
    expect(bobResult.items.some((item) => item.sourceId === aliceFactId)).toBe(false);
    await recordRecallForCitations(bobRun, bobResult);
    const bob = await finalizeAndRead(bobRun, 'I have nothing on that.');

    const bobCitationIds = citationsOf(bob.metadata).map((citation) => citation.id);
    expect(bobCitationIds).not.toContain(aliceFactId);
    // Bob DOES cite the firm-scope record he is authorized to read, so the
    // exclusion above is an authorization boundary and not "Bob happens to get
    // nothing" — and nothing was invented in the private record's place, in the
    // persisted message OR on the wire.
    expect(bobCitationIds).toEqual([firmFactId]);
    expect(JSON.stringify(bob.metadata)).not.toContain(privateMarker);
    expect(JSON.stringify(bob.metadata)).not.toContain(aliceFactId);
    expect(JSON.stringify(bob.frames)).not.toContain(privateMarker);
    expect(JSON.stringify(bob.frames)).not.toContain(aliceFactId);
  });
});
