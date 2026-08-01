import { GenerationService, type GenerationRunResult } from './generation.service';
import type { PrismaService } from '../prisma/prisma.service';
import type { AiCredentialService, ResolvedAiCredential } from './ai-credential.service';
import type { PeResolverService } from './pe-resolver.service';
import type { MeriV2FlagsService } from '../meriv2/meriv2-flags.service';
import type { MeriV2OrchestratorClient } from '../meriv2/meriv2-orchestrator.client';
import type { WorkspaceContextCompilerService } from './context-compiler.service';
import type { CollaboratorsService } from '../collaborators/collaborators.service';
import type { GenerationRunSummary } from './generation-run';

/**
 * Honest generation-run contract (Phase 1 Step 2). These tests exist because the
 * previous implementation swallowed section failures, relabelled pre-failure
 * content as newly generated, and created the "As generated" snapshot
 * fire-and-forget — so a run could report success it had not achieved.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const DRAFT = '22222222-2222-4222-8222-222222222222';
const PACKET = '33333333-3333-4333-8333-333333333333';
const CLIENT = '44444444-4444-4444-8444-444444444444';

interface Harness {
  service: GenerationService;
  config: () => Record<string, unknown>;
  versions: () => Array<{ id: string; label: string }>;
  promptsFor: (section: string) => number;
  setSectionOutcome: (section: string, outcome: SectionOutcome) => void;
  compileCalls: () => Array<Record<string, unknown>>;
}

type SectionOutcome =
  | { kind: 'ok'; html?: string }
  | { kind: 'http'; status: number; body?: unknown };

function harness(
  opts: {
    sections?: string[];
    sectionContent?: Record<string, string>;
    client?: string | null;
    credential?: ResolvedAiCredential | null;
    packetPersisted?: boolean;
    resolveClientId?: string | null;
    /** Simulate a walled client the caller holds no grant for (closeout §6). */
    ethicalWallDenied?: boolean;
    snapshotFails?: boolean;
  } = {},
): Harness {
  const sections = opts.sections ?? ['Overview', 'Request'];
  let config: Record<string, unknown> = {
    sections,
    client: opts.client ?? null,
    sectionContent: { ...(opts.sectionContent ?? {}) },
    sectionMeta: {},
  };
  const versions: Array<{ id: string; label: string }> = [];
  const outcomes = new Map<string, SectionOutcome>();
  const promptCounts = new Map<string, number>();
  const compileCalls: Array<Record<string, unknown>> = [];

  const prisma = {
    wsDraft: {
      findFirst: async () => ({
        id: DRAFT,
        tenantId: TENANT,
        ownerId: 'clerk_owner',
        docTitle: 'Test draft',
        industry: 'Defense & Aerospace',
        product: 'White paper',
        client: opts.client ?? null,
        ask: 'n/a',
        config,
        context: [],
        documents: [{ id: 'doc-1', name: 'White paper', ordinal: 0, body: { blocks: [] } }],
      }),
      updateMany: async ({ data }: { data: { config: Record<string, unknown> } }) => {
        config = { ...data.config };
        return { count: 1 };
      },
    },
    wsDocVersion: {
      create: async ({ data }: { data: { label: string } }) => {
        if (opts.snapshotFails) throw new Error('version table unavailable');
        const created = { id: `ver-${versions.length + 1}`, label: data.label };
        versions.push(created);
        return created;
      },
    },
  } as unknown as PrismaService;

  const creds = {
    resolveAnthropic: async () =>
      opts.credential === undefined
        ? {
            provider: 'anthropic' as const,
            secret: 'sk-tenant-secret',
            model: 'claude-sonnet-tenant',
            usedTenantKey: true,
          }
        : opts.credential,
    defaultModel: () => 'claude-sonnet-platform-default',
  } as unknown as AiCredentialService;

  const peResolver = {
    resolve: async () => [],
    groundingText: () => '',
    toValidationRecord: (record: unknown) => record,
    toAmountForComparison: () => null,
  } as unknown as PeResolverService;

  const contextCompiler = {
    resolveClientIdByExactName: async () => opts.resolveClientId ?? null,
    // Server-derived ethical-wall decision (closeout §6). Defaults to allowed so
    // these fixtures keep exercising generation rather than the wall; the wall's
    // own fail-closed behaviour is covered in meriv2-core's compiler-v2 spec and
    // by `ethicalWallDenied` below.
    resolveEthicalWallAllowedForClerkOwner: async () => opts.ethicalWallDenied !== true,
    compileForClerkOwner: async (request: Record<string, unknown>) => {
      compileCalls.push(request);
      return {
        packetId: PACKET,
        version: 1,
        surface: request.surface,
        tenantId: TENANT,
        userId: 'user-1',
        clientId: request.clientId ?? null,
        ref: request.ref ?? {},
        items: [],
        exclusions: [],
        rendered: [
          {
            layer: 'firm-identity',
            id: 'mi-1',
            type: 'firm-soul',
            slug: 'firm',
            title: null,
            body: 'We are a defense-focused firm.',
            contentHash: 'h1',
          },
          ...(request.clientId
            ? [
                {
                  layer: 'client-steering',
                  id: 'mi-2',
                  type: 'client-compass',
                  slug: 'acme',
                  title: null,
                  body: 'Lead with readiness, never cost.',
                  contentHash: 'h2',
                },
              ]
            : []),
        ],
        traceHash: 'trace-hash-1',
        persisted: opts.packetPersisted ?? true,
        compiledAt: '2026-07-28T00:00:00.000Z',
      };
    },
  } as unknown as WorkspaceContextCompilerService;

  const service = new GenerationService(
    prisma,
    creds,
    peResolver,
    { isWorkspaceGenEnabled: async () => false } as unknown as MeriV2FlagsService,
    { proxyGenerateAllSections: async () => ({}) } as unknown as MeriV2OrchestratorClient,
    contextCompiler,
    { assertCan: async () => undefined } as unknown as CollaboratorsService,
  );

  // Provider stub: routes by the section name embedded in the prompt so a test
  // can fail one section while others succeed.
  global.fetch = (async (_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { messages: Array<{ content: string }> };
    const prompt = payload.messages[0]?.content ?? '';
    const section = /Draft the "([^"]+)" section/.exec(prompt)?.[1] ?? 'unknown';
    promptCounts.set(section, (promptCounts.get(section) ?? 0) + 1);
    const outcome = outcomes.get(section) ?? { kind: 'ok' as const };
    if (outcome.kind === 'http') {
      return {
        ok: false,
        status: outcome.status,
        json: async () => outcome.body ?? {},
        text: async () => JSON.stringify(outcome.body ?? {}),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: outcome.html ?? `<p>Fresh ${section} prose.</p>` }],
      }),
    };
  }) as unknown as typeof fetch;

  return {
    service,
    config: () => config,
    versions: () => versions,
    promptsFor: (section) => promptCounts.get(section) ?? 0,
    setSectionOutcome: (section, outcome) => outcomes.set(section, outcome),
    compileCalls: () => compileCalls,
  };
}

function runOf(result: GenerationRunResult): GenerationRunSummary {
  const run = result.generationRun;
  if (!run) throw new Error('expected a generation run summary');
  return run;
}

describe('GenerationService generation runs', () => {
  it('reports complete when every requested section succeeds', async () => {
    const h = harness();
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(run.status).toBe('complete');
    expect(run.requestedSections).toEqual(['Overview', 'Request']);
    expect(run.succeededSections).toEqual(['Overview', 'Request']);
    expect(run.failedSections).toEqual([]);
    expect(run.retryOfRunId).toBeNull();

    const content = h.config().sectionContent as Record<string, string>;
    expect(content.Overview).toContain('Fresh Overview prose.');
    const meta = h.config().sectionMeta as Record<string, Record<string, unknown>>;
    expect(meta.Overview).toMatchObject({
      status: 'review',
      generationStatus: 'succeeded',
      stale: false,
    });
  });

  it('reports partial and preserves failed-section content as explicitly stale', async () => {
    const h = harness({ sectionContent: { Request: '<p>Previously approved ask.</p>' } });
    h.setSectionOutcome('Request', { kind: 'http', status: 503 });

    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(run.status).toBe('partial');
    expect(run.succeededSections).toEqual(['Overview']);
    expect(run.failedSections).toEqual([
      expect.objectContaining({
        section: 'Request',
        status: 'failed',
        errorCode: 'provider_unavailable',
        staleContentPreserved: true,
      }),
    ]);

    // Old content survives untouched...
    const content = h.config().sectionContent as Record<string, string>;
    expect(content.Request).toBe('<p>Previously approved ask.</p>');
    // ...and is NOT presented as newly generated.
    const meta = h.config().sectionMeta as Record<string, Record<string, unknown>>;
    expect(meta.Request).toMatchObject({ generationStatus: 'failed', stale: true });
    expect(meta.Request?.status).not.toBe('review');
    expect(meta.Request?.lastGeneratedAt).toBeUndefined();
  });

  it('marks a failed section with no prior content as not stale-preserved', async () => {
    const h = harness();
    h.setSectionOutcome('Request', { kind: 'http', status: 503 });
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));
    expect(run.failedSections[0]).toMatchObject({
      section: 'Request',
      staleContentPreserved: false,
    });
  });

  it('reports failed when no requested section succeeds', async () => {
    const h = harness();
    h.setSectionOutcome('Overview', { kind: 'http', status: 500 });
    h.setSectionOutcome('Request', { kind: 'http', status: 500 });

    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));
    expect(run.status).toBe('failed');
    expect(run.succeededSections).toEqual([]);
    expect(run.failedSections).toHaveLength(2);
  });

  it('reports failed — never complete — when no credential is available', async () => {
    const h = harness({ credential: null });
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(run.status).toBe('failed');
    expect(run.failedSections.map((entry) => entry.errorCode)).toEqual([
      'credential_unavailable',
      'credential_unavailable',
    ]);
    // The provider was never called.
    expect(h.promptsFor('Overview')).toBe(0);
  });

  it('awaits the As generated snapshot and reports its version id', async () => {
    const h = harness();
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    // Awaited: the version exists the instant the run resolves — no trailing tick.
    expect(h.versions()).toHaveLength(1);
    expect(h.versions()[0]?.label).toBe('As generated');
    expect(run.snapshot).toEqual({ status: 'created', versionId: 'ver-1' });
  });

  it('downgrades to complete_with_warnings when snapshot persistence fails', async () => {
    const h = harness({ snapshotFails: true });
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(run.status).toBe('complete_with_warnings');
    expect(run.snapshot).toEqual({
      status: 'failed',
      versionId: null,
      errorCode: 'snapshot_persistence_failed',
    });
    // Sections themselves did land.
    expect(run.succeededSections).toEqual(['Overview', 'Request']);
  });

  it('reports complete_with_warnings when a citation token could not be resolved', async () => {
    const h = harness({ sections: ['Overview'] });
    h.setSectionOutcome('Overview', {
      kind: 'ok',
      html: '<p>The request is $72.1M. [S:pe:0603851F]</p>',
    });
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(run.status).toBe('complete_with_warnings');
    expect(run.invalidCitations).toEqual([{ section: 'Overview', token: '[S:pe:0603851F]' }]);
  });

  it('records the durable context packet and the credential that actually ran', async () => {
    const h = harness();
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(run.contextPacketId).toBe(PACKET);
    expect(run.contextTraceHash).toBe('trace-hash-1');
    expect(run.contextDegraded).toBe(false);
    expect(run.provider).toBe('anthropic');
    expect(run.model).toBe('claude-sonnet-tenant');
    expect(run.credentialSource).toBe('tenant');

    // The same facts are persisted as draft provenance.
    const provenance = h.config().contextProvenance as Record<string, unknown>;
    expect(provenance).toMatchObject({
      contextPacketId: PACKET,
      contextTraceHash: 'trace-hash-1',
      contextDegraded: false,
      provider: 'anthropic',
      model: 'claude-sonnet-tenant',
      credentialSource: 'tenant',
    });
  });

  it('records the platform credential source when no tenant key is configured', async () => {
    const h = harness({
      credential: {
        provider: 'anthropic',
        secret: 'sk-platform',
        model: 'claude-sonnet-platform',
        usedTenantKey: false,
      },
    });
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));
    expect(run.credentialSource).toBe('platform');
    expect(run.model).toBe('claude-sonnet-platform');
  });

  it('never claims a packet id when the packet row was not persisted', async () => {
    const h = harness({ packetPersisted: false });
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(run.contextPacketId).toBeNull();
    expect(run.contextDegraded).toBe(true);
    // A degraded context is a warning, not a silent success.
    expect(run.status).toBe('complete_with_warnings');
  });

  it('compiles one client-aware packet for the whole run at the workspace-gen surface', async () => {
    const h = harness({ client: 'Acme Defense', resolveClientId: CLIENT });
    await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner');

    // Exactly ONE compilation for a two-section run, at the right surface, with
    // the resolved client and the client layers.
    expect(h.compileCalls()).toHaveLength(1);
    expect(h.compileCalls()[0]).toMatchObject({
      tenantId: TENANT,
      surface: 'workspace-gen',
      clientId: CLIENT,
      layers: ['firm-identity', 'user-voice', 'client-steering', 'client-people'],
      ref: { draftId: DRAFT },
    });
  });

  it('degrades instead of guessing when the workspace client name does not resolve', async () => {
    const h = harness({ client: 'Ambiguous Co', resolveClientId: null });
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(h.compileCalls()[0]).toMatchObject({
      clientId: null,
      layers: ['firm-identity', 'user-voice'],
    });
    expect(run.contextDegraded).toBe(true);
  });

  /**
   * Closeout §6. The wall decision is resolved server-side from the database
   * before the packet is compiled. When the caller holds no grant for a walled
   * client, the run must say its context is degraded rather than quietly
   * generating a client deliverable as though it had the client's steering
   * material — a silent success here is the leak-shaped failure.
   */
  it('degrades when the caller is walled off from the resolved client', async () => {
    const h = harness({
      client: 'Acme Defense',
      resolveClientId: CLIENT,
      ethicalWallDenied: true,
    });
    const run = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));

    expect(run.contextDegraded).toBe(true);
    // The client is still the compile scope — the wall governs which ROWS the
    // compiler may admit, and it is the compiler that withholds them.
    expect(h.compileCalls()[0]).toMatchObject({ clientId: CLIENT });
  });

  it('never persists or returns a provider error body or API key', async () => {
    const h = harness({ sections: ['Overview'] });
    h.setSectionOutcome('Overview', {
      kind: 'http',
      status: 429,
      body: { error: { message: 'rate limited for api-key=sk-leaked-secret' } },
    });

    const result = await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner');
    const serialized = `${JSON.stringify(result)}${JSON.stringify(h.config())}`;

    expect(serialized).not.toContain('sk-leaked-secret');
    expect(serialized).not.toContain('sk-tenant-secret');
    expect(runOf(result).failedSections[0]).toMatchObject({
      errorCode: 'provider_rate_limited',
      message: 'The model provider rate-limited this section.',
    });
  });
});

describe('GenerationService.retryFailedSections', () => {
  it('retries only the failed sections and leaves successful ones untouched', async () => {
    const h = harness({ sections: ['Overview', 'Request', 'Budget'] });
    h.setSectionOutcome('Request', { kind: 'http', status: 503 });

    const first = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));
    expect(first.status).toBe('partial');
    expect(h.promptsFor('Overview')).toBe(1);
    expect(h.promptsFor('Budget')).toBe(1);

    const successfulContentBefore = (h.config().sectionContent as Record<string, string>).Overview;

    // The provider recovers.
    h.setSectionOutcome('Request', { kind: 'ok', html: '<p>Recovered ask.</p>' });
    const retry = runOf(await h.service.retryFailedSections(TENANT, DRAFT, 'clerk_owner'));

    expect(retry.status).toBe('complete');
    expect(retry.requestedSections).toEqual(['Request']);
    expect(retry.succeededSections).toEqual(['Request']);
    expect(retry.retryOfRunId).toBe(first.id);

    // Successful sections were NOT regenerated…
    expect(h.promptsFor('Overview')).toBe(1);
    expect(h.promptsFor('Budget')).toBe(1);
    expect(h.promptsFor('Request')).toBe(2);
    // …and their content is byte-identical.
    expect((h.config().sectionContent as Record<string, string>).Overview).toBe(
      successfulContentBefore,
    );

    // The recovered section is fresh, reviewable, and no longer stale.
    const meta = h.config().sectionMeta as Record<string, Record<string, unknown>>;
    expect(meta.Request).toMatchObject({
      status: 'review',
      generationStatus: 'succeeded',
      stale: false,
    });
    expect(meta.Request?.lastGenerationError).toBeUndefined();
  });

  it('keeps a still-failing retry honest rather than reporting success', async () => {
    const h = harness({ sections: ['Overview', 'Request'] });
    h.setSectionOutcome('Request', { kind: 'http', status: 503 });
    await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner');

    const retry = runOf(await h.service.retryFailedSections(TENANT, DRAFT, 'clerk_owner'));
    expect(retry.status).toBe('failed');
    expect(retry.requestedSections).toEqual(['Request']);
  });

  it('is a no-op that calls no provider when the latest run had no failures', async () => {
    const h = harness({ sections: ['Overview'] });
    const first = runOf(await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner'));
    expect(first.status).toBe('complete');

    const retry = await h.service.retryFailedSections(TENANT, DRAFT, 'clerk_owner');
    expect(h.promptsFor('Overview')).toBe(1);
    expect(retry.generationRun?.id).toBe(first.id);
  });

  it('will not resurrect a failed section the draft no longer declares', async () => {
    const h = harness({ sections: ['Overview', 'Retired'] });
    h.setSectionOutcome('Retired', { kind: 'http', status: 503 });
    await h.service.generateAllSectionsInProcess(TENANT, DRAFT, 'clerk_owner');

    // The user removes the section from the outline.
    const config = h.config();
    config.sections = ['Overview'];

    h.setSectionOutcome('Retired', { kind: 'ok' });
    await h.service.retryFailedSections(TENANT, DRAFT, 'clerk_owner');
    expect(h.promptsFor('Retired')).toBe(1);
  });
});
