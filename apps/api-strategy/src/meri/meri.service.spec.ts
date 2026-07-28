import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '../../generated/prisma-client/index.js';
import { CONTEXT_GAP_LABELS, MeriService } from './meri.service.js';
import { StrategyConversationService } from './strategy-conversation.service.js';
import { REQUIRED_TEMPLATE_KEYS } from '../context/steward.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { VersioningService } from '../strategy/versioning.service.js';
import type { StrategyAiCredentialResolver } from './strategy-ai-credential.resolver.js';
import type { StrategyAttachmentResolver } from './strategy-attachment.resolver.js';
import type { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import type { FirmPhasesService } from '../firm-phases/firm-phases.service.js';
import type { ReferenceService } from '../reference/reference.service.js';
import type { StewardService, StewardHealthReport } from '../context/steward.service.js';
import type { DraftStrategyDto, AssistantDto } from './dto/meri.dto.js';
import type { PlanEdit, StewardFactLine } from './meri.types.js';
import type { Grounding } from './meri.service.js';

/*
 * MeriService apply-pipeline tests with a STUBBED orchestrator (no LLM, no
 * network). An in-memory fake tx models sp_strategy/sp_node so we can assert the
 * post-write state, and withTenantUser snapshots+restores that store on throw —
 * modelling the real $transaction rollback so we can prove a malformed edit
 * leaves NO partial write (plan §9.3).
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const U = 'user-1';
const provider = { source: 'byok', model: 'claude-sonnet-4-6' } as unknown as Awaited<
  ReturnType<StrategyAiCredentialResolver['resolve']>
>;

function makeStore() {
  const strategies = new Map<string, Rec>();
  const nodes = new Map<string, Rec>();
  // Stage E: sp_context_fact rows the provenance fact-check resolves against.
  const contextFacts = new Map<string, Rec>();
  // Phase 2: sp_strategy_chat_message rows the durable conversation writes.
  const chatMessages = new Map<string, Rec>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  const nodesFor = (sid: string) =>
    [...nodes.values()]
      .filter((n) => n.strategyId === sid)
      .sort((a, b) => {
        const sa = (a.startsOn as Date).getTime();
        const sb = (b.startsOn as Date).getTime();
        if (sa !== sb) return sa - sb;
        return (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime();
      });
  // clientRows drives the tenant-scoped client-existence check (tx.$queryRaw
  // inside withTenant); default = client exists. Tests set [] to simulate an
  // unknown client.
  return {
    strategies,
    nodes,
    contextFacts,
    chatMessages,
    // Chat ids/timestamps must be unique ACROSS transactions: one send spans two
    // (the user message commits before the model call, the reply commits with
    // the plan edit), so a per-tx counter would mint the same id twice and the
    // second write would silently overwrite the first.
    chatSeq: 0,
    nextId,
    nodesFor,
    clientRows: [{ ok: 1 }] as Array<{ ok: number }>,
  };
}
type Store = ReturnType<typeof makeStore>;

/**
 * `scope` models what PrismaService's DMMF query hook does in production:
 * inject `where.tenantId` on every where-bearing op against a tenant-scoped
 * model. Without it this fake would happily serve another tenant's rows, and a
 * "tenant-isolated read" assertion here would prove nothing.
 */
function makeTx(store: Store, scope: string) {
  const now = new Date();
  const mine = (rec: Rec | undefined | null): boolean => !!rec && rec.tenantId === scope;
  const spNode = {
    createMany: async ({ data }: { data: Rec[] }) => {
      for (const d of data) {
        // A3: production pre-generates a real uuid per node (`draftNode`'s
        // explicit `id`) so dependsOn indexes resolve to it — a real createMany
        // persists that id verbatim, so the mock must not stomp it.
        const id = (d.id as string | undefined) ?? store.nextId('node');
        store.nodes.set(id, { ...d, id, createdAt: now });
      }
      return { count: data.length };
    },
    create: async ({ data }: { data: Rec }) => {
      const id = (data.id as string | undefined) ?? store.nextId('node');
      const rec = { ...data, id, createdAt: now };
      store.nodes.set(id, rec);
      return rec;
    },
    findFirst: async ({ where }: { where: { id: string; strategyId?: string } }) => {
      const rec = store.nodes.get(where.id);
      if (!mine(rec)) return null;
      if (where.strategyId && rec!.strategyId !== where.strategyId) return null;
      return rec;
    },
    // resolveEditDeps' DB-existence check for edit-op dependsOn.
    findMany: async ({ where }: { where: { strategyId: string; id: { in: string[] } } }) =>
      [...store.nodes.values()].filter(
        (n) => mine(n) && n.strategyId === where.strategyId && where.id.in.includes(n.id as string),
      ),
    delete: async ({ where }: { where: { id: string } }) => {
      const rec = store.nodes.get(where.id);
      if (!mine(rec)) throw new Error('node not found');
      store.nodes.delete(where.id);
      return rec ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.nodes.get(where.id);
      if (!mine(rec)) throw new Error('node not found');
      const merged = { ...rec, ...data };
      store.nodes.set(where.id, merged);
      return merged;
    },
  };
  const attach = (rec: Rec, include?: { nodes?: unknown; artifacts?: unknown }) => {
    const out: Rec = { ...rec };
    if (include?.nodes) out.nodes = store.nodesFor(rec.id);
    if (include?.artifacts) out.artifacts = [];
    return out;
  };
  const spStrategy = {
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('str');
      const rec = { ...data, id, createdAt: now, updatedAt: now };
      store.strategies.set(id, rec);
      return rec;
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) throw new Error('strategy not found');
      const merged = { ...rec, ...data, updatedAt: now };
      store.strategies.set(where.id, merged);
      return merged;
    },
    findFirst: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { nodes?: unknown };
    }) => {
      const rec = store.strategies.get(where.id);
      return mine(rec) ? attach(rec!, include) : null;
    },
    findFirstOrThrow: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { nodes?: unknown; artifacts?: unknown };
    }) => {
      const rec = store.strategies.get(where.id);
      if (!mine(rec)) throw new Error('strategy not found');
      return attach(rec!, include);
    },
  };
  // Cross-schema client-existence check runs as tx.$queryRaw inside withTenant.
  const $queryRaw = async () => store.clientRows;
  // A2/A6: the sibling dependency-edge strip on delete runs as tx.$executeRaw
  // (raw array_remove); the mock is a no-op returning 0 affected rows.
  const $executeRaw = async () => 0;
  // Stage C: VersioningService.logActivity unconditionally emits a
  // transactional-outbox row in the same tx — the fake tx must accept it.
  const spEventOutbox = { create: async () => undefined };
  // Stage E: the provenance fact-check's single id-set lookup.
  const spContextFact = {
    findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
      [...store.contextFacts.values()].filter((f) => where.id?.in.includes(f.id as string) ?? true),
  };
  // Phase 2: the durable conversation table. Models the two behaviours the
  // service actually depends on — the (tenant_id, client_message_id) UNIQUE
  // index (a real P2002, so the idempotent-retry branch is exercised rather
  // than assumed) and the ordered per-context read.
  const spStrategyChatMessage = {
    create: async ({ data }: { data: Rec }) => {
      const cmid = data.clientMessageId as string | null | undefined;
      if (cmid) {
        const clash = [...store.chatMessages.values()].some(
          (m) => m.tenantId === data.tenantId && m.clientMessageId === cmid,
        );
        if (clash) {
          throw new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
            code: 'P2002',
            clientVersion: 'test',
            meta: { target: ['tenant_id', 'client_message_id'] },
          });
        }
      }
      // createdAt must strictly increase: the service orders by (createdAt, id),
      // and a shared `now` would make the user message / reply order arbitrary.
      const seq = ++store.chatSeq;
      const id = `chat-${seq}`;
      const rec: Rec = {
        attachmentRefs: null,
        action: null,
        clientMessageId: null,
        createdByUserId: null,
        nodeId: null,
        ...data,
        id,
        createdAt: new Date(now.getTime() + seq),
      };
      store.chatMessages.set(id, rec);
      return rec;
    },
    findMany: async ({ where }: { where: { strategyId: string; nodeId: string | null } }) =>
      [...store.chatMessages.values()]
        .filter((m) => mine(m) && m.strategyId === where.strategyId && (m.nodeId ?? null) === where.nodeId)
        .sort((a, b) => {
          const d = (a.createdAt as Date).getTime() - (b.createdAt as Date).getTime();
          return d !== 0 ? d : String(a.id).localeCompare(String(b.id));
        }),
    findFirst: async ({
      where,
    }: {
      where: { id?: string; strategyId?: string; kind?: string; clientMessageId?: string };
    }) =>
      [...store.chatMessages.values()].find(
        (m) =>
          mine(m) &&
          (where.id === undefined || m.id === where.id) &&
          (where.strategyId === undefined || m.strategyId === where.strategyId) &&
          (where.kind === undefined || m.kind === where.kind) &&
          (where.clientMessageId === undefined || m.clientMessageId === where.clientMessageId),
      ) ?? null,
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.chatMessages.get(where.id);
      if (!mine(rec)) throw new Error('chat message not found');
      const merged = { ...rec, ...data };
      store.chatMessages.set(where.id, merged);
      return merged;
    },
  };
  return { spNode, spStrategy, $queryRaw, $executeRaw, spEventOutbox, spContextFact, spStrategyChatMessage } as unknown as import('../../generated/prisma-client/index.js').Prisma.TransactionClient;
}

function makePrisma(store: Store) {
  const snapshot = () => ({
    strategies: new Map(store.strategies),
    nodes: new Map(store.nodes),
    // Phase 2: chat rows are inside the same tx as the plan edit, so a rollback
    // must take Meri's reply with it — otherwise the thread would claim a change
    // the plan never got.
    chatMessages: new Map(store.chatMessages),
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.strategies = snap.strategies as Store['strategies'];
    store.nodes = snap.nodes as Store['nodes'];
    store.chatMessages = snap.chatMessages as Store['chatMessages'];
  };
  // withTenantUser models the $transaction: snapshot, run, roll back on throw.
  const withTenantUser = jest.fn(async (t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot();
    try {
      return await fn(makeTx(store, t));
    } catch (e) {
      restore(snap);
      throw e;
    }
  });
  const withTenant = jest.fn(async (t: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeTx(store, t)),
  );
  const $queryRaw = jest.fn(async () => [{ ok: 1 }]);
  return {
    prisma: { withTenantUser, withTenant, $queryRaw } as unknown as PrismaService,
    withTenantUser,
    $queryRaw,
  };
}

// Loose stub type: the canned responses use plain string literals, which TS
// won't narrow to the response unions — we validate the shapes via assertions
// instead, so accept any object here and cast to the client.
type OrchestratorStub = Record<string, unknown>;

function makeService(
  orchestrator: OrchestratorStub,
  store: Store,
  overrides: {
    firmPhases?: unknown[];
    reference?: Record<string, unknown[]>;
    attachmentDocs?: Array<{ filename: string; text: string }>;
    stewardFacts?: StewardFactLine[];
    stewardHealth?: StewardHealthReport;
  } = {},
) {
  const { prisma, withTenantUser, $queryRaw } = makePrisma(store);
  const versioning = {
    cutVersion: jest.fn(async () => ({ id: 'v-1' })),
    logActivity: jest.fn(async () => undefined),
  } as unknown as VersioningService;
  const resolver = { resolve: jest.fn(async () => provider) } as unknown as StrategyAiCredentialResolver;
  const firmPhases = {
    list: jest.fn(async () => overrides.firmPhases ?? []),
  } as unknown as FirmPhasesService;
  const reference = {
    getCalendars: jest.fn(async () =>
      overrides.reference ?? { congress: [], ppbeLanes: [], ppbeCurrentPhases: [] },
    ),
  } as unknown as ReferenceService;
  const attachmentsResolve = jest.fn(async () => overrides.attachmentDocs ?? []);
  const attachments = { resolve: attachmentsResolve } as unknown as StrategyAttachmentResolver;
  // Stage E steward pack stub (wire-contract 2 inputs).
  const stewardFactsFn = jest.fn(async () => overrides.stewardFacts ?? []);
  const stewardHealthFn = jest.fn(
    async () =>
      overrides.stewardHealth ?? {
        status: 'ok' as const,
        factCounts: { active: 0, superseded: 0, stale: 0, rejected: 0 },
        openConflicts: 0,
        openMaterialConflicts: [],
        staleDocs: [],
        missingRequired: [],
      },
  );
  const steward = {
    factsForOrchestrator: stewardFactsFn,
    health: stewardHealthFn,
  } as unknown as StewardService;
  // The REAL conversation service over the fake prisma — the idempotency,
  // context validation and normalization paths are the point of these tests, so
  // stubbing them would test nothing.
  const conversations = new StrategyConversationService(prisma);
  const svc = new MeriService(
    prisma,
    versioning,
    resolver,
    orchestrator as unknown as StrategyOrchestratorClient,
    firmPhases,
    reference,
    attachments,
    steward,
    conversations,
  );
  return {
    svc,
    conversations,
    versioning,
    withTenantUser,
    $queryRaw,
    attachmentsResolve,
    stewardFactsFn,
    stewardHealthFn,
  };
}

function seedStrategy(store: Store): { sid: string; n1: string; n2: string; n3: string } {
  const sid = 'S1';
  store.strategies.set(sid, {
    id: sid,
    tenantId: T,
    clientId: 'C1',
    title: 'Existing',
    type: 'appropriations',
    goal: null,
    meriContext: null,
    meriSummary: null,
    targetDate: null,
    ownerUserId: U,
  });
  const mk = (id: string, title: string, iso: string) => {
    store.nodes.set(id, {
      id,
      tenantId: T,
      strategyId: sid,
      kind: 'action',
      subject: 'deliverable',
      title,
      note: null,
      ownerUserId: null,
      status: 'active',
      startsOn: new Date(`${iso}T00:00:00.000Z`),
      endsOn: null,
      openEnded: false,
      meriAuthored: false,
      createdAt: new Date('2027-01-01T00:00:00.000Z'),
    });
  };
  mk('N1', 'Node one', '2027-02-01');
  mk('N2', 'Node two', '2027-03-01');
  mk('N3', 'Node three', '2027-04-01');
  return { sid, n1: 'N1', n2: 'N2', n3: 'N3' };
}

describe('MeriService.draft', () => {
  const draftDto = { clientId: 'C1', type: 'appropriations', goal: 'Win the plus-up' } as DraftStrategyDto;

  it('persists the strategy, meri-authored nodes and a meri v1', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: 'A tight FY27 push.',
        provenance: [],
        nodes: [
          { kind: 'milestone', subject: 'submission', title: 'HAC-D markup', startsOn: '2027-05-01' },
          {
            kind: 'action',
            subject: 'ask',
            title: 'Member ask',
            startsOn: '2027-05-15',
            endsOn: '2027-06-15',
          },
        ],
      })),
    };
    const { svc, versioning } = makeService(orchestrator, store);

    const detail = (await svc.draft(T, U, 'bearer', draftDto)) as unknown as {
      id: string;
      meriSummary: string;
      draftedByMeri: boolean;
      nodes: Array<{ title: string; meriAuthored: boolean }>;
    };

    expect(detail.meriSummary).toBe('A tight FY27 push.');
    expect(detail.draftedByMeri).toBe(true); // SHL-5 provenance flag
    expect(detail.nodes).toHaveLength(2);
    expect(detail.nodes.every((n) => n.meriAuthored)).toBe(true);
    expect(detail.nodes.map((n) => n.title)).toEqual(['HAC-D markup', 'Member ask']);
    // v1 is authored by Meri.
    const cut = (versioning.cutVersion as jest.Mock).mock.calls[0]![1] as { authorKind: string };
    expect(cut.authorKind).toBe('meri');
    expect(store.strategies.size).toBe(1);
    expect(store.nodes.size).toBe(2);
  });

  it('forwards a 3-FY window, firm phases and merged reference as grounding', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: null,
        nodes: [{ kind: 'action', subject: 'deliverable', title: 'Step', startsOn: '2027-05-01' }],
      })),
    };
    const { svc } = makeService(orchestrator, store, {
      firmPhases: [{ label: 'Build', startFy: 2027, startQ: 1, endFy: 2027, endQ: 3, position: 0, id: 'p1' }],
      reference: {
        congress: [
          {
            label: 'HAC-D markup',
            fy: null,
            startsOn: new Date('2027-05-01T00:00:00.000Z'),
            endsOn: new Date('2027-05-15T00:00:00.000Z'),
          },
        ],
        ppbeLanes: [],
        ppbeCurrentPhases: [],
      },
    });

    await svc.draft(T, U, 'bearer', draftDto);

    const body = (orchestrator.draft as jest.Mock).mock.calls[0]![0] as {
      fiscal: { fys: number[]; fyLabels: string[]; focalFy: string; today: string };
      firmPhases: Array<{ label: string; startFy: number }>;
      reference: { congress: Array<{ label: string; startsOn: string }> };
    };
    expect(body.fiscal.fys).toHaveLength(3);
    expect(body.fiscal.fys[1]).toBe(body.fiscal.fys[0]! + 1);
    expect(body.fiscal.fys[2]).toBe(body.fiscal.fys[0]! + 2);
    expect(body.fiscal.fyLabels).toHaveLength(3);
    expect(body.fiscal.focalFy).toBe(body.fiscal.fyLabels[1]);
    expect(body.fiscal.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.firmPhases).toEqual([
      { label: 'Build', startFy: 2027, startQ: 1, endFy: 2027, endQ: 3 },
    ]);
    // Reference dates are normalised to YYYY-MM-DD for the prompt.
    expect(body.reference.congress[0]!.startsOn).toBe('2027-05-01');
  });

  it('never creates a non-risk node as open-ended, even if Meri proposes it', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: null,
        nodes: [
          { kind: 'milestone', subject: 'submission', title: 'Markup', startsOn: '2027-05-01', openEnded: true },
          { kind: 'risk', subject: 'outcome', title: 'CR slip', startsOn: '2027-05-01', openEnded: true },
        ],
      })),
    };
    const { svc } = makeService(orchestrator, store);
    const detail = (await svc.draft(T, U, 'bearer', draftDto)) as unknown as {
      nodes: Array<{ kind: string; openEnded: boolean }>;
    };
    const milestone = detail.nodes.find((n) => n.kind === 'milestone')!;
    const risk = detail.nodes.find((n) => n.kind === 'risk')!;
    expect(milestone.openEnded).toBe(false); // risk-only concept — forced off
    expect(risk.openEnded).toBe(true); // risk keeps it
  });

  it('resolves + forwards uploaded attachment text as grounding and references it in the note', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: 's',
        provenance: [],
        nodes: [{ kind: 'action', subject: 'deliverable', title: 'Step', startsOn: '2027-05-01' }],
      })),
    };
    const { svc, versioning, attachmentsResolve } = makeService(orchestrator, store, {
      attachmentDocs: [{ filename: 'memo.pdf', text: 'FY27 shipbuilding memo' }],
    });

    await svc.draft(T, U, 'bearer-token', {
      clientId: 'C1',
      type: 'appropriations',
      goal: 'Win it',
      attachmentIds: ['a1'],
    } as DraftStrategyDto);

    // Resolved under the caller bearer + requested ids...
    expect(attachmentsResolve).toHaveBeenCalledWith('bearer-token', ['a1']);
    // ...text forwarded to the orchestrator as grounding...
    const body = (orchestrator.draft as jest.Mock).mock.calls[0]![0] as {
      attachments: Array<{ filename: string; text: string }>;
    };
    expect(body.attachments).toEqual([{ filename: 'memo.pdf', text: 'FY27 shipbuilding memo' }]);
    // ...and the version note references the document (MRI-7).
    const cut = (versioning.cutVersion as jest.Mock).mock.calls[0]![1] as { note: string };
    expect(cut.note).toMatch(/document/);
  });

  it('rejects an unknown client before any write', async () => {
    const store = makeStore();
    store.clientRows = []; // tenant-scoped client-existence check finds nothing
    const orchestrator = { draft: jest.fn() };
    const { svc, withTenantUser } = makeService(orchestrator, store);

    await expect(svc.draft(T, U, 'bearer', draftDto)).rejects.toThrow(/Unknown client/);
    expect(orchestrator.draft).not.toHaveBeenCalled();
    expect(withTenantUser).not.toHaveBeenCalled();
  });

  it('rolls back (throws before writing) when a proposed node is malformed', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: null,
        nodes: [{ kind: 'not-a-kind', subject: 'ask', title: 'Bad', startsOn: '2027-05-01' }],
      })),
    };
    const { svc, withTenantUser } = makeService(orchestrator, store);

    await expect(svc.draft(T, U, 'bearer', draftDto)).rejects.toThrow(/invalid node kind/);
    // Validation happens up front — the tx never opened.
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(store.strategies.size).toBe(0);
    expect(store.nodes.size).toBe(0);
  });

  it('remaps a dependsOn array INDEX to the real persisted uuid of its sibling (A3)', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: null,
        nodes: [
          // Orchestrator only knows siblings by 0-based array index: node 0
          // depends on node 1 ("B"), which hasn't been persisted yet.
          { kind: 'action', subject: 'deliverable', title: 'Depends on B', startsOn: '2027-06-01', dependsOn: [1] },
          { kind: 'action', subject: 'deliverable', title: 'B', startsOn: '2027-05-01' },
        ],
      })),
    };
    const { svc } = makeService(orchestrator, store);

    const detail = (await svc.draft(T, U, 'bearer', draftDto)) as unknown as {
      nodes: Array<{ id: string; title: string; dependsOnIds: string[] }>;
    };

    const a = detail.nodes.find((n) => n.title === 'Depends on B')!;
    const b = detail.nodes.find((n) => n.title === 'B')!;
    expect(a.dependsOnIds).toEqual([b.id]);
    expect(a.dependsOnIds[0]).not.toBe('1'); // never the raw index
    expect(a.dependsOnIds[0]).not.toBe(a.id); // never self
  });

  it('rejects a plan with hard verifier errors when STRATEGY_VERIFY_BLOCK=true (A6)', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: null,
        nodes: [
          // "A" depends on "B" (index 1) but is scheduled to start BEFORE B
          // starts — a hard dep-order verifier error.
          { kind: 'action', subject: 'deliverable', title: 'A', startsOn: '2027-05-01', dependsOn: [1] },
          { kind: 'action', subject: 'deliverable', title: 'B', startsOn: '2027-06-01' },
        ],
      })),
    };
    const { svc, withTenantUser } = makeService(orchestrator, store);

    const prevFlag = process.env.STRATEGY_VERIFY_BLOCK;
    process.env.STRATEGY_VERIFY_BLOCK = 'true';
    try {
      await expect(svc.draft(T, U, 'bearer', draftDto)).rejects.toThrow(/can't be saved yet/);
    } finally {
      if (prevFlag === undefined) delete process.env.STRATEGY_VERIFY_BLOCK;
      else process.env.STRATEGY_VERIFY_BLOCK = prevFlag;
    }
    // The gate runs before the tx opens — nothing persisted.
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(store.strategies.size).toBe(0);
    expect(store.nodes.size).toBe(0);
  });
});

describe('MeriService.assistant', () => {
  const dto = {
    scope: 'strategy',
    instruction: 'Rework the plan',
    clientMessageId: 'aaaaaaaa-0000-4000-8000-000000000001',
  } as AssistantDto;

  it('applies an add/update/remove/retime edit-set as one version', async () => {
    const store = makeStore();
    const { n1, n2, n3 } = seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'Done — reworked the plan.',
        summary: 'Now front-loaded.',
        provenance: [],
        edits: [
          { op: 'add', kind: 'risk', subject: 'outcome', title: 'CR risk', startsOn: '2027-01-10' },
          { op: 'update', nodeId: n1, title: 'Node one (revised)' },
          { op: 'remove', nodeId: n2 },
          { op: 'retime', nodeId: n3, startsOn: '2027-07-01' },
        ],
      })),
    };
    const { svc, versioning } = makeService(orchestrator, store);

    const out = (await svc.assistant(T, U, 'bearer', 'S1', dto)) as {
      reply: string;
      summary: string | null;
      strategy: { meriSummary: string; nodes: Array<{ id: string; title: string; startsOn: unknown }> };
    };

    expect(out.reply).toBe('Done — reworked the plan.');
    expect(out.strategy.meriSummary).toBe('Now front-loaded.');
    // N2 removed, one added → still 3 nodes.
    expect(out.strategy.nodes).toHaveLength(3);
    const byId = new Map(out.strategy.nodes.map((n) => [n.id, n]));
    expect(byId.has(n2)).toBe(false);
    expect(byId.get(n1)!.title).toBe('Node one (revised)');
    expect(store.nodes.size).toBe(3);
    const cut = (versioning.cutVersion as jest.Mock).mock.calls[0]![1] as { authorKind: string };
    expect(cut.authorKind).toBe('meri');
  });

  it('rolls back the whole edit-set when one edit is malformed', async () => {
    const store = makeStore();
    const { n1 } = seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'partial',
        summary: 'should not stick',
        edits: [
          { op: 'add', kind: 'action', subject: 'deliverable', title: 'Valid add', startsOn: '2027-02-10' },
          { op: 'update', nodeId: n1, status: 'not-a-status' },
        ],
      })),
    };
    const { svc, versioning } = makeService(orchestrator, store);

    await expect(svc.assistant(T, U, 'bearer', 'S1', dto)).rejects.toThrow(/invalid node status/);
    // Full rollback: the valid add is gone, count unchanged, summary untouched.
    expect(store.nodes.size).toBe(3);
    expect([...store.nodes.values()].some((n) => n.title === 'Valid add')).toBe(false);
    expect(store.strategies.get('S1')!.meriSummary).toBeNull();
    // No version committed for a failed apply (cutVersion runs after the loop).
    expect(versioning.cutVersion).not.toHaveBeenCalled();
  });

  it('does not cut a version or bump lastEdited on a no-op (empty edit-set) question', async () => {
    const store = makeStore();
    seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'The biggest risk is a CR slipping the markup.',
        summary: 'should NOT be persisted on a pure question',
        provenance: [],
        edits: [],
      })),
    };
    const { svc, versioning, withTenantUser } = makeService(orchestrator, store);

    const out = (await svc.assistant(T, U, 'bearer', 'S1', dto)) as {
      reply: string;
      summary: string | null;
      strategy: { nodes: unknown[] };
    };

    expect(out.reply).toContain('CR');
    // A question is not a mutation batch: no version, no activity row, and the
    // resp.summary is NOT persisted (existing meriSummary preserved).
    expect(versioning.cutVersion).not.toHaveBeenCalled();
    expect(versioning.logActivity).not.toHaveBeenCalled();
    expect(store.strategies.get('S1')!.meriSummary).toBeNull();
    expect(store.strategies.get('S1')!.lastEditedAt).toBeUndefined();
    expect(out.summary).toBeNull();
    // Current, unchanged state is returned.
    expect(out.strategy.nodes).toHaveLength(3);
    expect(store.nodes.size).toBe(3);
    // Phase 2 changed what "no write" means here: the ONE withTenantUser tx is
    // the durable chat write (the user's own message), which must happen even
    // for a pure question. It carries no plan mutation — asserted above.
    expect(withTenantUser).toHaveBeenCalledTimes(1);
    expect([...store.chatMessages.values()].map((m) => m.role)).toEqual(['user', 'meri']);
  });

  it('surfaces a degraded groundingHealth on a no-op (empty edit-set) question', async () => {
    const store = makeStore();
    seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'I could not confirm the client profile, so treat this with caution.',
        summary: null,
        provenance: [],
        edits: [],
        groundingHealth: { status: 'degraded', missingRequired: ['Client profile'] },
      })),
    };
    const { svc } = makeService(orchestrator, store);

    const out = (await svc.assistant(T, U, 'bearer', 'S1', dto)) as {
      strategy: { groundingHealth?: { status: string; missingRequired: string[] } };
    };

    // A pure question must not silently drop a degraded grounding signal — the
    // web banner relies on strategy.groundingHealth to warn on partial info.
    expect(out.strategy.groundingHealth).toEqual({
      status: 'degraded',
      missingRequired: ['Client profile'],
    });
  });

  it('resolves an edit-op dependsOn: dedupes, drops self-refs and unknown ids (resolveEditDeps)', async () => {
    const store = makeStore();
    const { n1, n3 } = seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'Linked the steps',
        summary: null,
        edits: [
          // n1 -> [n1 (self, duplicated), n3 (a real sibling), an id that
          // doesn't exist in this strategy at all.
          { op: 'update', nodeId: n1, dependsOn: [n1, n1, n3, 'does-not-exist'] },
        ],
      })),
    };
    const { svc } = makeService(orchestrator, store);

    await svc.assistant(T, U, 'bearer', 'S1', dto);

    // Self-reference + duplicate collapse, and the DB-existence check drops the
    // unknown id — only the real sibling n3 survives.
    expect(store.nodes.get(n1)!.dependsOnIds).toEqual([n3]);
  });

  it('rolls back an edit-set that leaves hard verifier errors when STRATEGY_VERIFY_BLOCK=true (A6)', async () => {
    const store = makeStore();
    const { n1, n3 } = seedStrategy(store); // n1 starts 2027-02-01, n3 starts 2027-04-01
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'Linked the steps',
        summary: 'should not stick',
        edits: [
          // n1 keeps its (earlier) start date but is now made to depend on the
          // later-starting n3 — a hard dep-order verifier error post-apply.
          { op: 'update', nodeId: n1, dependsOn: [n3] },
        ],
      })),
    };
    const { svc, versioning } = makeService(orchestrator, store);

    const prevFlag = process.env.STRATEGY_VERIFY_BLOCK;
    process.env.STRATEGY_VERIFY_BLOCK = 'true';
    try {
      await expect(svc.assistant(T, U, 'bearer', 'S1', dto)).rejects.toThrow(/would break the plan/);
    } finally {
      if (prevFlag === undefined) delete process.env.STRATEGY_VERIFY_BLOCK;
      else process.env.STRATEGY_VERIFY_BLOCK = prevFlag;
    }
    // Full rollback: the dependsOn edit never stuck and the summary wasn't persisted.
    expect(store.nodes.get(n1)!.dependsOnIds).toBeUndefined();
    expect(store.strategies.get('S1')!.meriSummary).toBeNull();
  });

  it('rejects node-scope assist with no nodeId', async () => {
    const store = makeStore();
    seedStrategy(store);
    const orchestrator = { assistant: jest.fn() };
    const { svc } = makeService(orchestrator, store);
    await expect(
      svc.assistant(T, U, 'bearer', 'S1', { scope: 'node', instruction: 'x' } as AssistantDto),
    ).rejects.toThrow(/nodeId is required/);
    expect(orchestrator.assistant).not.toHaveBeenCalled();
  });

  it('rejects an unknown edit op instead of treating it as an update', async () => {
    const store = makeStore();
    const { n1 } = seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'applied',
        summary: 'should not stick',
        // An op kind this build does not understand (typo'd / future
        // orchestrator vocabulary) carrying a valid nodeId + an updatable
        // field: it must throw, NOT fall through to the update|retime branch.
        edits: [{ op: 'duplicate', nodeId: n1, status: 'done' }],
      })),
    };
    const { svc, versioning } = makeService(orchestrator, store);

    await expect(svc.assistant(T, U, 'bearer', 'S1', dto)).rejects.toThrow(/invalid edit op/);
    // The node was not silently mutated, nothing stuck, no version cut.
    expect(store.nodes.get(n1)!.status).toBe('active');
    expect(store.strategies.get('S1')!.meriSummary).toBeNull();
    expect(versioning.cutVersion).not.toHaveBeenCalled();
  });
});

/*
 * Phase 2 — the durable contextual conversation.
 *
 * These run the REAL StrategyConversationService over the in-memory tx, which
 * models both things isolation and idempotency actually rest on: the query
 * hook's tenant scoping and the (tenant_id, client_message_id) UNIQUE index.
 */
describe('MeriService — Phase 2 durable Meri conversation', () => {
  const T2 = 'tenant-2';
  const CMID = 'bbbbbbbb-0000-4000-8000-000000000001';
  const nodeDto = (nodeId: string, clientMessageId = CMID) =>
    ({ scope: 'node', nodeId, instruction: 'Push this a month', clientMessageId }) as AssistantDto;
  const strategyDto = (clientMessageId = CMID, instruction = 'Add a coalition letter') =>
    ({ scope: 'strategy', instruction, clientMessageId }) as AssistantDto;
  const noEdits = (reply: string) => ({ assistant: jest.fn(async () => ({ reply, edits: [] })) });

  it('keeps the strategy thread and each step thread separate', async () => {
    const store = makeStore();
    const { n1 } = seedStrategy(store);
    const { svc, conversations } = makeService(noEdits('Noted.'), store);

    await svc.assistant(T, U, 'bearer', 'S1', strategyDto('bbbbbbbb-0000-4000-8000-00000000000a'));
    await svc.assistant(T, U, 'bearer', 'S1', nodeDto(n1, 'bbbbbbbb-0000-4000-8000-00000000000b'));

    const strategyThread = await conversations.list(T, 'S1', null);
    const nodeThread = await conversations.list(T, 'S1', n1);

    expect(strategyThread).toHaveLength(2); // user + Meri
    expect(nodeThread).toHaveLength(2);
    expect(strategyThread.every((m) => m.nodeId === null)).toBe(true);
    expect(nodeThread.every((m) => m.nodeId === n1)).toBe(true);
    expect(strategyThread[0]!.body).toBe('Add a coalition letter');
    expect(nodeThread[0]!.body).toBe('Push this a month');
  });

  it('reads and writes are tenant-isolated', async () => {
    const store = makeStore();
    seedStrategy(store);
    const { svc, conversations } = makeService(noEdits('Noted.'), store);
    await svc.assistant(T, U, 'bearer', 'S1', strategyDto());

    // Another tenant cannot read the thread, send into it, or dismiss from it —
    // the strategy itself is invisible to them.
    await expect(conversations.list(T2, 'S1', null)).rejects.toThrow(/Strategy not found/);
    await expect(
      svc.assistant(T2, 'user-2', 'bearer', 'S1', strategyDto('bbbbbbbb-0000-4000-8000-00000000000c')),
    ).rejects.toThrow(/Strategy not found/);
    await expect(
      conversations.dismissContextGap(T2, 'S1', 'chat-1'),
    ).rejects.toThrow(/Strategy not found/);
    // ...and the owning tenant still sees exactly its own two messages.
    expect(await conversations.list(T, 'S1', null)).toHaveLength(2);
  });

  it('a retried send reuses the stored user message instead of posting it twice', async () => {
    const store = makeStore();
    seedStrategy(store);
    const { svc, conversations } = makeService(noEdits('Noted.'), store);

    const first = (await svc.assistant(T, U, 'bearer', 'S1', strategyDto())) as {
      messages: Array<{ id: string; role: string }>;
    };
    const retry = (await svc.assistant(T, U, 'bearer', 'S1', strategyDto())) as {
      messages: Array<{ id: string; role: string }>;
    };

    // Same stored row returned both times...
    expect(retry.messages[0]!.id).toBe(first.messages[0]!.id);
    // ...and only ONE user bubble exists in the thread.
    const thread = await conversations.list(T, 'S1', null);
    expect(thread.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it("keeps the user's message and appends a plain error line when the model call fails", async () => {
    const store = makeStore();
    seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => {
        throw new Error('anthropic 529 overloaded: model claude-x');
      }),
    };
    const { svc, conversations, versioning } = makeService(orchestrator, store);

    await expect(svc.assistant(T, U, 'bearer', 'S1', strategyDto())).rejects.toThrow(/529/);

    const thread = await conversations.list(T, 'S1', null);
    expect(thread).toHaveLength(2);
    expect(thread[0]!.role).toBe('user');
    expect(thread[0]!.body).toBe('Add a coalition letter');
    expect(thread[1]!.kind).toBe('assistant_error');
    expect(thread[1]!.body).toBe("I couldn't complete that change. Your message is saved—try again.");
    // No provider name, status code or stack leaks into user-visible copy.
    expect(thread[1]!.body).not.toMatch(/anthropic|529|claude/i);
    // The plan was not touched.
    expect(versioning.cutVersion).not.toHaveBeenCalled();
    expect(store.nodes.size).toBe(3);
  });

  it("commits Meri's reply in the same transaction as the plan edit", async () => {
    const store = makeStore();
    const { n1 } = seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'Renamed it.',
        edits: [{ op: 'update', nodeId: n1, title: 'Node one (revised)' }],
      })),
    };
    const { svc, conversations } = makeService(orchestrator, store);

    await svc.assistant(T, U, 'bearer', 'S1', strategyDto());

    expect(store.nodes.get(n1)!.title).toBe('Node one (revised)');
    const thread = await conversations.list(T, 'S1', null);
    expect(thread.map((m) => m.role)).toEqual(['user', 'meri']);
    expect(thread[1]!.body).toBe('Renamed it.');
  });

  it('rolls the reply back with the plan when the edit transaction fails', async () => {
    const store = makeStore();
    const { n1 } = seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'All set — renamed and restatused.',
        edits: [
          { op: 'update', nodeId: n1, title: 'Renamed' },
          { op: 'update', nodeId: n1, status: 'not-a-status' },
        ],
      })),
    };
    const { svc, conversations } = makeService(orchestrator, store);

    await expect(svc.assistant(T, U, 'bearer', 'S1', strategyDto())).rejects.toThrow(/invalid node status/);

    // The plan is untouched AND the thread never claims otherwise: the user's
    // own message survives (its own committed tx), Meri's reply does not.
    expect(store.nodes.get(n1)!.title).toBe('Node one');
    const thread = await conversations.list(T, 'S1', null);
    expect(thread.map((m) => m.role)).toEqual(['user']);
  });

  it('attaches one open_node action when the edit-set created exactly one step', async () => {
    const store = makeStore();
    seedStrategy(store);
    const orchestrator = {
      assistant: jest.fn(async () => ({
        reply: 'Added the coalition letter.',
        edits: [
          { op: 'add', kind: 'action', subject: 'deliverable', title: 'Coalition sign-on letter', startsOn: '2027-05-01' },
        ],
      })),
    };
    const { svc, conversations } = makeService(orchestrator, store);

    await svc.assistant(T, U, 'bearer', 'S1', strategyDto());

    const thread = await conversations.list(T, 'S1', null);
    const reply = thread[1]!;
    expect(reply.action).toEqual({
      type: 'open_node',
      nodeId: expect.any(String),
      title: 'Coalition sign-on letter',
    });
    // The action points at a step that really exists in the returned plan.
    expect(store.nodes.get(reply.action!.nodeId)!.title).toBe('Coalition sign-on letter');
  });

  it('attaches no action when the edit-set created zero or several steps', async () => {
    const two = {
      assistant: jest.fn(async () => ({
        reply: 'Added both.',
        edits: [
          { op: 'add', kind: 'action', subject: 'deliverable', title: 'First', startsOn: '2027-05-01' },
          { op: 'add', kind: 'action', subject: 'deliverable', title: 'Second', startsOn: '2027-06-01' },
        ],
      })),
    };
    const storeTwo = makeStore();
    seedStrategy(storeTwo);
    const svcTwo = makeService(two, storeTwo);
    await svcTwo.svc.assistant(T, U, 'bearer', 'S1', strategyDto());
    const twoThread = await svcTwo.conversations.list(T, 'S1', null);
    expect(twoThread[1]!.action).toBeNull();

    // Zero created (a pure retime) — also no action.
    const storeNone = makeStore();
    const { n1 } = seedStrategy(storeNone);
    const none = {
      assistant: jest.fn(async () => ({
        reply: 'Pushed it.',
        edits: [{ op: 'retime', nodeId: n1, startsOn: '2027-08-01' }],
      })),
    };
    const svcNone = makeService(none, storeNone);
    await svcNone.svc.assistant(T, U, 'bearer', 'S1', strategyDto());
    const noneThread = await svcNone.conversations.list(T, 'S1', null);
    expect(noneThread[1]!.action).toBeNull();
  });

  it('records the attachment display snapshot on the user message', async () => {
    const store = makeStore();
    seedStrategy(store);
    const { svc, conversations } = makeService(noEdits('Read it.'), store);

    await svc.assistant(T, U, 'bearer', 'S1', {
      scope: 'strategy',
      instruction: 'Read this and add a step',
      clientMessageId: CMID,
      attachmentIds: ['cccccccc-0000-4000-8000-000000000001'],
      attachments: [
        {
          id: 'cccccccc-0000-4000-8000-000000000001',
          filename: 'FY27 markup memo.pdf',
          kind: 'pdf',
          status: 'ready',
        },
        // Not in attachmentIds — Meri never saw it, so the bubble must not claim it.
        { id: 'cccccccc-0000-4000-8000-00000000ffff', filename: 'unrelated.pdf', kind: 'pdf', status: 'ready' },
      ],
    } as AssistantDto);

    const [userMessage] = await conversations.list(T, 'S1', null);
    expect(userMessage!.attachments).toEqual([
      {
        id: 'cccccccc-0000-4000-8000-000000000001',
        filename: 'FY27 markup memo.pdf',
        kind: 'pdf',
        status: 'ready',
      },
    ]);
  });

  it('draft seeds the strategy thread with Meri’s summary', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: 'A tight FY27 push, front-loaded before markup.',
        nodes: [{ kind: 'action', subject: 'deliverable', title: 'Step', startsOn: '2027-05-01' }],
      })),
    };
    const { svc, conversations } = makeService(orchestrator, store);

    const detail = (await svc.draft(T, U, 'bearer', {
      clientId: 'C1',
      type: 'appropriations',
      goal: 'Win the plus-up',
    } as DraftStrategyDto)) as { id: string };

    const thread = await conversations.list(T, detail.id, null);
    expect(thread).toHaveLength(1);
    expect(thread[0]!.role).toBe('meri');
    expect(thread[0]!.kind).toBe('message');
    expect(thread[0]!.body).toBe('A tight FY27 push, front-loaded before markup.');
  });

  it('draft seeds ONE context_gap message in plain language on degraded grounding', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: 'Drafted.',
        nodes: [{ kind: 'action', subject: 'deliverable', title: 'Step', startsOn: '2027-05-01' }],
        groundingHealth: {
          status: 'degraded',
          missingRequired: ['strategy_brief', 'client_constraints'],
          omittedOptional: [],
        },
      })),
    };
    const { svc, conversations } = makeService(orchestrator, store);

    const detail = (await svc.draft(T, U, 'bearer', {
      clientId: 'C1',
      type: 'appropriations',
      goal: 'Win the plus-up',
    } as DraftStrategyDto)) as { id: string };

    const thread = await conversations.list(T, detail.id, null);
    const gaps = thread.filter((m) => m.kind === 'context_gap');
    // ONE message, not one per missing field.
    expect(gaps).toHaveLength(1);
    expect(gaps[0]!.state).toBe('active');
    expect(gaps[0]!.body).toContain('the strategy brief');
    expect(gaps[0]!.body).toContain("this client's constraints");
    // Internal template keys must never reach the user.
    expect(gaps[0]!.body).not.toMatch(/strategy_brief|client_constraints/);
  });

  it('draft seeds no context_gap when grounding is clean', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: 'Drafted.',
        nodes: [{ kind: 'action', subject: 'deliverable', title: 'Step', startsOn: '2027-05-01' }],
        groundingHealth: { status: 'ok', missingRequired: [], omittedOptional: [] },
      })),
    };
    const { svc, conversations } = makeService(orchestrator, store);
    const detail = (await svc.draft(T, U, 'bearer', {
      clientId: 'C1',
      type: 'appropriations',
      goal: 'Win the plus-up',
    } as DraftStrategyDto)) as { id: string };

    const thread = await conversations.list(T, detail.id, null);
    expect(thread.some((m) => m.kind === 'context_gap')).toBe(false);
  });

  it('every REQUIRED_TEMPLATE_KEYS entry has plain-language copy', () => {
    // Adding a required Steward doc without a label here would otherwise print
    // its internal key to the user in the seeded gap message.
    for (const key of REQUIRED_TEMPLATE_KEYS) {
      expect(CONTEXT_GAP_LABELS[key]).toBeTruthy();
    }
  });

  it('dismissing a context gap changes only that message', async () => {
    const store = makeStore();
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: 'Drafted.',
        nodes: [{ kind: 'action', subject: 'deliverable', title: 'Step', startsOn: '2027-05-01' }],
        groundingHealth: { status: 'degraded', missingRequired: ['strategy_brief'], omittedOptional: [] },
      })),
    };
    const { svc, conversations } = makeService(orchestrator, store);
    const detail = (await svc.draft(T, U, 'bearer', {
      clientId: 'C1',
      type: 'appropriations',
      goal: 'Win the plus-up',
    } as DraftStrategyDto)) as { id: string };

    const before = await conversations.list(T, detail.id, null);
    const gap = before.find((m) => m.kind === 'context_gap')!;
    const summary = before.find((m) => m.kind === 'message')!;

    const dismissed = await conversations.dismissContextGap(T, detail.id, gap.id);
    expect(dismissed.state).toBe('dismissed');

    const after = await conversations.list(T, detail.id, null);
    expect(after.find((m) => m.id === gap.id)!.state).toBe('dismissed');
    // The neighbouring summary message is untouched.
    expect(after.find((m) => m.id === summary.id)!.state).toBe('active');
    // An ordinary message id is not dismissible through this endpoint.
    await expect(conversations.dismissContextGap(T, detail.id, summary.id)).rejects.toThrow(
      /Context note not found/,
    );
  });

  it('a step thread stays readable after its step is archived', async () => {
    const store = makeStore();
    const { n1 } = seedStrategy(store);
    const { svc, conversations } = makeService(noEdits('Noted.'), store);
    await svc.assistant(T, U, 'bearer', 'S1', nodeDto(n1));

    // P0-1 soft delete: a version restore archives the step rather than
    // deleting it. Its conversation must survive that.
    store.nodes.get(n1)!.archivedAt = new Date();

    const thread = await conversations.list(T, 'S1', n1);
    expect(thread).toHaveLength(2);
    expect(thread[0]!.body).toBe('Push this a month');
  });

  it('rejects a node context that belongs to another strategy', async () => {
    const store = makeStore();
    seedStrategy(store);
    store.strategies.set('S2', { id: 'S2', tenantId: T, clientId: 'C1', title: 'Other', type: 'appropriations' });
    await expect(
      new StrategyConversationService(makePrisma(store).prisma).list(T, 'S2', 'N1'),
    ).rejects.toThrow(/Step not found on this strategy/);
  });
});

describe('MeriService — Stage E steward pack + provenance fact-check', () => {
  const draftDto = { clientId: 'C1', type: 'appropriations', goal: 'Win the plus-up' } as DraftStrategyDto;
  const oneNodeDraft = () => ({
    draft: jest.fn(async () => ({
      summary: null,
      nodes: [{ kind: 'action', subject: 'deliverable', title: 'Step', startsOn: '2027-05-01' }],
    })),
  });
  const packFact: StewardFactLine = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fact: 'The client cannot lobby DoD directly.',
    sourceRef: 'heading:Constraints',
    documentTitle: 'Client constraints',
    templateKey: '02_client_constraints',
    authority: 'client_approved',
    asOf: '2026-07-01',
  };
  const conflictedHealth: StewardHealthReport = {
    status: 'conflicted',
    factCounts: { active: 2, superseded: 0, stale: 0, rejected: 0 },
    openConflicts: 1,
    openMaterialConflicts: [
      {
        id: 'cf-1',
        factAId: 'fa-1',
        factBId: 'fb-1',
        factA: 'The ask is $12M.',
        factB: 'The ask is $8M.',
      },
    ],
    staleDocs: [],
    missingRequired: ['client_constraints'],
  };

  it('draft body carries stewardFacts + the SHAPED-DOWN stewardHealth (wire-contract 2)', async () => {
    const store = makeStore();
    const orchestrator = oneNodeDraft();
    const { svc, stewardFactsFn, stewardHealthFn } = makeService(orchestrator, store, {
      stewardFacts: [packFact],
      stewardHealth: conflictedHealth,
    });

    await svc.draft(T, U, 'bearer', draftDto);

    // Scoped to the DRAFT's client.
    expect(stewardFactsFn).toHaveBeenCalledWith(T, 'C1');
    expect(stewardHealthFn).toHaveBeenCalledWith(T, 'C1');
    const body = (orchestrator.draft as jest.Mock).mock.calls[0]![0] as {
      stewardFacts: unknown;
      stewardHealth: unknown;
    };
    expect(body.stewardFacts).toEqual([packFact]);
    // The health BLOCK is the wire shape exactly — internal report fields
    // (factCounts / openConflicts / staleDocs) must NOT leak into the body.
    expect(body.stewardHealth).toEqual({
      status: 'conflicted',
      missingRequired: ['client_constraints'],
      openMaterialConflicts: conflictedHealth.openMaterialConflicts,
    });
  });

  it('assistant body carries stewardFacts + stewardHealth scoped to the STRATEGY client', async () => {
    const store = makeStore();
    seedStrategy(store); // clientId C1
    const orchestrator = {
      assistant: jest.fn(async () => ({ reply: 'ok', summary: null, edits: [] })),
    };
    const { svc, stewardFactsFn } = makeService(orchestrator, store, {
      stewardFacts: [packFact],
    });

    await svc.assistant(T, U, 'bearer', 'S1', {
      scope: 'strategy',
      instruction: 'x',
    } as AssistantDto);

    expect(stewardFactsFn).toHaveBeenCalledWith(T, 'C1');
    const body = (orchestrator.assistant as jest.Mock).mock.calls[0]![0] as {
      stewardFacts: unknown;
      stewardHealth: { status: string };
    };
    expect(body.stewardFacts).toEqual([packFact]);
    expect(body.stewardHealth.status).toBe('ok');
  });

  it('degrades to an empty/degraded steward pack instead of failing the draft when the Steward is unavailable (fail-soft)', async () => {
    const store = makeStore();
    const orchestrator = oneNodeDraft();
    const { svc, stewardHealthFn } = makeService(orchestrator, store, {});
    stewardHealthFn.mockRejectedValueOnce(new Error('The table `public.sp_context_fact` does not exist'));

    // Must NOT throw / roll back the draft — this is read-only grounding, not
    // part of the mutation's audit trail (unlike the outbox write, which is
    // deliberately unconditional).
    const result = await svc.draft(T, U, 'bearer', draftDto);
    expect(result.id).toBeDefined();

    const body = (orchestrator.draft as jest.Mock).mock.calls[0]![0] as {
      stewardFacts: unknown;
      stewardHealth: unknown;
    };
    expect(body.stewardFacts).toEqual([]);
    expect(body.stewardHealth).toEqual({
      status: 'degraded',
      missingRequired: [],
      openMaterialConflicts: [],
    });
  });

  it('appends the three fact-check WARNING kinds (unknown / non-active / other-client) and logs them via plan.verified', async () => {
    const store = makeStore();
    const F_OK = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const F_STALE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const F_OTHER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const F_UNKNOWN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    store.contextFacts.set(F_OK, { id: F_OK, tenantId: T, clientId: 'C1', state: 'active', fact: 'ok' });
    store.contextFacts.set(F_STALE, { id: F_STALE, tenantId: T, clientId: 'C1', state: 'stale', fact: 'old' });
    store.contextFacts.set(F_OTHER, { id: F_OTHER, tenantId: T, clientId: 'C2', state: 'active', fact: 'foreign' });
    const orchestrator = {
      draft: jest.fn(async () => ({
        summary: null,
        nodes: [
          {
            kind: 'action', subject: 'deliverable', title: 'Grounded step', startsOn: '2027-05-01',
            // A healthy citation + a fabricated one on the SAME node.
            sources: [
              { section: 'Steward facts', ref: `fact:${F_OK}` },
              { section: 'Steward facts', ref: `fact:${F_UNKNOWN}` },
            ],
          },
          {
            kind: 'action', subject: 'deliverable', title: 'Stale step', startsOn: '2027-05-02',
            sources: [{ section: 'Steward facts', ref: `fact:${F_STALE}` }],
          },
          {
            kind: 'action', subject: 'deliverable', title: 'Cross-client step', startsOn: '2027-05-03',
            // The non-fact pack ref must be ignored by the fact-check.
            sources: [
              { section: 'Steward facts', ref: `fact:${F_OTHER}` },
              { section: 'Goal', ref: 'heading:Goal' },
            ],
          },
        ],
      })),
    };
    const { svc, versioning } = makeService(orchestrator, store);

    const detail = (await svc.draft(T, U, 'bearer', draftDto)) as unknown as {
      violations: Array<{ code: string; severity: string; message: string }>;
    };

    const factWarnings = detail.violations.filter((v) => v.code.startsWith('fact-'));
    expect(factWarnings).toHaveLength(3);
    expect(factWarnings.every((v) => v.severity === 'warning')).toBe(true);
    expect(factWarnings.map((v) => v.message).sort()).toEqual(
      [
        `'Grounded step' cites a fact that does not exist (fact:${F_UNKNOWN})`,
        `'Stale step' cites a stale fact (fact:${F_STALE})`,
        `'Cross-client step' cites another client's fact (fact:${F_OTHER})`,
      ].sort(),
    );
    // The healthy citation produced NO warning.
    expect(detail.violations.some((v) => v.message.includes(F_OK))).toBe(false);
    // The appended warnings ride the SAME plan.verified audit row.
    const logged = (versioning.logActivity as jest.Mock).mock.calls
      .map((c) => c[1] as { action: string; after?: { violations?: Array<{ code: string }> } })
      .find((a) => a.action === 'plan.verified');
    expect(logged).toBeDefined();
    expect(logged!.after!.violations!.some((v) => v.code === 'fact-unknown')).toBe(true);
  });

  it('a plan with NO fact citations appends nothing and never queries sp_context_fact', async () => {
    const store = makeStore();
    const orchestrator = oneNodeDraft();
    const { svc } = makeService(orchestrator, store);

    const detail = (await svc.draft(T, U, 'bearer', draftDto)) as unknown as {
      violations: Array<{ code: string }>;
    };

    expect(detail.violations.filter((v) => v.code.startsWith('fact-'))).toHaveLength(0);
  });
});

describe('MeriService.applyEditSet (Stage C change-set replay)', () => {
  it('rejects an unknown op arriving via a change-set before mutating the node', async () => {
    const store = makeStore();
    const { n1 } = seedStrategy(store);
    const { svc } = makeService({}, store);
    // Change-set ops are persisted as unvalidated JSON (CreateChangeSetDto
    // defers to this pipeline) — the op discriminator itself must be checked.
    const ops = [{ op: 'duplicate', nodeId: n1, status: 'done' }] as unknown as PlanEdit[];

    await expect(svc.applyEditSet(makeTx(store, T), T, 'S1', U, ops)).rejects.toThrow(
      /invalid edit op/,
    );
    expect(store.nodes.get(n1)!.status).toBe('active');
  });
});

describe('MeriService.verifyAppliedPlan (Stage C change-set A6 parity)', () => {
  it('422s on hard verifier errors when STRATEGY_VERIFY_BLOCK=true — unwinding the caller apply tx', async () => {
    const store = makeStore();
    const { n1, n3 } = seedStrategy(store);
    // The persisted plan a change-set just applied: n1 (starts 2027-02-01) now
    // depends on the LATER-starting n3 (2027-04-01) — the same hard dep-order
    // error state the assistant-path A6 test rolls back on.
    store.nodes.get(n1)!.dependsOnIds = [n3];
    const { svc } = makeService({}, store);
    const ground = await svc.grounding(T);

    const prevFlag = process.env.STRATEGY_VERIFY_BLOCK;
    process.env.STRATEGY_VERIFY_BLOCK = 'true';
    try {
      await expect(svc.verifyAppliedPlan(makeTx(store, T), T, U, 'S1', ground)).rejects.toThrow(
        /would break the plan/,
      );
    } finally {
      if (prevFlag === undefined) delete process.env.STRATEGY_VERIFY_BLOCK;
      else process.env.STRATEGY_VERIFY_BLOCK = prevFlag;
    }
  });

  it('annotates instead of blocking when the flag is dark, and ALWAYS logs plan.verified (agent-apply audit parity)', async () => {
    const store = makeStore();
    const { n1, n3 } = seedStrategy(store);
    store.nodes.get(n1)!.dependsOnIds = [n3]; // same hard error — flag dark
    const { svc, versioning } = makeService({}, store);
    const ground = await svc.grounding(T);

    const { detail, violations } = await svc.verifyAppliedPlan(makeTx(store, T), T, U, 'S1', ground);

    expect(detail.id).toBe('S1'); // callers reuse the loaded post-apply detail
    expect(violations.some((v) => v.severity === 'error')).toBe(true); // annotate-only
    const logged = (versioning.logActivity as jest.Mock).mock.calls
      .map((c) => c[1] as { action: string; entityId: string })
      .find((a) => a.action === 'plan.verified');
    expect(logged).toBeDefined();
    expect(logged!.entityId).toBe('S1');
  });
});

/*
 * Stage-G grounded content generation: MeriService.draftExecutionDocument is
 * the Execution Agent's hop into the orchestrator's strategy-document-draft
 * endpoint. It must (a) skip entirely for a client-less node (the pack is
 * client-anchored) WITHOUT calling the orchestrator, (b) call the resolver +
 * orchestrator with tenantId then bearer IN THAT ORDER (both are plain
 * strings — a swap is invisible to tsc and silently auth-fails), and
 * (c) fail SOFT to null on any error, mirroring stewardContext.
 */
describe('MeriService.draftExecutionDocument (Stage-G)', () => {
  const groundingFixture: Grounding = {
    fiscal: { today: '2027-11-01', fys: [2027, 2028, 2029], fyLabels: ['FY27', 'FY28', 'FY29'], focalFy: 'FY28' },
    firmPhases: [],
    reference: { congress: [], ppbeLanes: [], ppbeCurrentPhases: [] },
  };
  const baseInput = {
    kind: 'workspace_draft' as const,
    clientId: 'C1',
    strategyType: 'appropriations',
    goal: 'Win the plus-up',
    node: {
      id: 'n1',
      kind: 'action',
      subject: 'deliverable',
      title: 'Draft testimony',
      note: null,
      startsOn: '2027-11-15',
      endsOn: null,
    },
    grounding: groundingFixture,
    stewardFacts: [] as StewardFactLine[],
    stewardHealth: { status: 'ok' as const, missingRequired: [], openMaterialConflicts: [] },
  };
  const docResponse = {
    title: 'FY28 Testimony',
    summary: 'A grounded draft.',
    sections: [{ heading: 'Background', html: '<p>x</p>' }],
    model: 'claude-sonnet-5',
  };

  it('skips generation entirely (no orchestrator call) for a client-less node', async () => {
    const store = makeStore();
    const nodeDocumentDraft = jest.fn(async (_body: unknown, _bearer: string, _provider?: unknown) => docResponse);
    const { svc } = makeService({ nodeDocumentDraft }, store);

    const result = await svc.draftExecutionDocument(T, 'bearer-x', { ...baseInput, clientId: null });

    expect(result).toBeNull();
    expect(nodeDocumentDraft).not.toHaveBeenCalled();
  });

  it('calls the credential resolver with tenantId, and the orchestrator with (body, bearer, provider) — arg-order guard', async () => {
    const store = makeStore();
    const nodeDocumentDraft = jest.fn(async (_body: unknown, _bearer: string, _provider?: unknown) => docResponse);
    const { svc } = makeService({ nodeDocumentDraft }, store);

    // tenantId then bearer, exactly matching the method's own signature — a
    // swapped call site would still typecheck (both are `string`) but this
    // pins the CORRECT order so a regression fails a test, not just prod.
    const result = await svc.draftExecutionDocument(T, 'bearer-x', baseInput);

    expect(result).toEqual(docResponse);
    expect(nodeDocumentDraft).toHaveBeenCalledTimes(1);
    const [body, bearerArg] = nodeDocumentDraft.mock.calls[0]!;
    expect(bearerArg).toBe('bearer-x');
    expect((body as { clientId: string }).clientId).toBe('C1');
  });

  it('forwards goal, grounding, node, stewardFacts and stewardHealth in the request body', async () => {
    const store = makeStore();
    const nodeDocumentDraft = jest.fn(async (_body: unknown, _bearer: string, _provider?: unknown) => docResponse);
    const { svc } = makeService({ nodeDocumentDraft }, store);
    const stewardFacts: StewardFactLine[] = [
      {
        id: 'f1',
        fact: 'The client cannot lobby DoD directly.',
        sourceRef: 'heading:Constraints',
        documentTitle: 'Client constraints',
        templateKey: '02_client_constraints',
        authority: 'client_approved',
        asOf: '2026-07-01',
      },
    ];

    await svc.draftExecutionDocument(T, 'bearer-x', { ...baseInput, stewardFacts });

    const body = nodeDocumentDraft.mock.calls[0]![0] as Record<string, unknown>;
    expect(body.goal).toBe('Win the plus-up');
    expect(body.kind).toBe('workspace_draft');
    expect(body.node).toEqual(baseInput.node);
    expect(body.stewardFacts).toEqual(stewardFacts);
    expect(body.fiscal).toEqual(groundingFixture.fiscal);
  });

  it('fails soft to null (never throws) when the orchestrator hop rejects', async () => {
    const store = makeStore();
    const nodeDocumentDraft = jest.fn(async () => {
      throw new Error('orchestrator unavailable');
    });
    const { svc } = makeService({ nodeDocumentDraft }, store);

    const result = await svc.draftExecutionDocument(T, 'bearer-x', baseInput);

    expect(result).toBeNull();
  });
});
