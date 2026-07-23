import { describe, expect, it, jest } from '@jest/globals';
import { MeriService } from './meri.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { VersioningService } from '../strategy/versioning.service.js';
import type { StrategyAiCredentialResolver } from './strategy-ai-credential.resolver.js';
import type { StrategyAttachmentResolver } from './strategy-attachment.resolver.js';
import type { StrategyOrchestratorClient } from './strategy-orchestrator.client.js';
import type { FirmPhasesService } from '../firm-phases/firm-phases.service.js';
import type { ReferenceService } from '../reference/reference.service.js';
import type { DraftStrategyDto, AssistantDto } from './dto/meri.dto.js';

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
  return { strategies, nodes, nextId, nodesFor };
}
type Store = ReturnType<typeof makeStore>;

function makeTx(store: Store) {
  const now = new Date();
  const spNode = {
    createMany: async ({ data }: { data: Rec[] }) => {
      for (const d of data) {
        const id = store.nextId('node');
        store.nodes.set(id, { ...d, id, createdAt: now });
      }
      return { count: data.length };
    },
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('node');
      const rec = { ...data, id, createdAt: now };
      store.nodes.set(id, rec);
      return rec;
    },
    findFirst: async ({ where }: { where: { id: string; strategyId?: string } }) => {
      const rec = store.nodes.get(where.id);
      if (!rec) return null;
      if (where.strategyId && rec.strategyId !== where.strategyId) return null;
      return rec;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      const rec = store.nodes.get(where.id);
      store.nodes.delete(where.id);
      return rec ?? null;
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.nodes.get(where.id);
      if (!rec) throw new Error('node not found');
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
      return rec ? attach(rec, include) : null;
    },
    findFirstOrThrow: async ({
      where,
      include,
    }: {
      where: { id: string };
      include?: { nodes?: unknown; artifacts?: unknown };
    }) => {
      const rec = store.strategies.get(where.id);
      if (!rec) throw new Error('strategy not found');
      return attach(rec, include);
    },
  };
  return { spNode, spStrategy } as unknown as import('../../generated/prisma-client/index.js').Prisma.TransactionClient;
}

function makePrisma(store: Store) {
  const snapshot = () => ({
    strategies: new Map(store.strategies),
    nodes: new Map(store.nodes),
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.strategies = snap.strategies as Store['strategies'];
    store.nodes = snap.nodes as Store['nodes'];
  };
  // withTenantUser models the $transaction: snapshot, run, roll back on throw.
  const withTenantUser = jest.fn(async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot();
    try {
      return await fn(makeTx(store));
    } catch (e) {
      restore(snap);
      throw e;
    }
  });
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeTx(store)),
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
  const svc = new MeriService(
    prisma,
    versioning,
    resolver,
    orchestrator as unknown as StrategyOrchestratorClient,
    firmPhases,
    reference,
    attachments,
  );
  return { svc, versioning, withTenantUser, $queryRaw, attachmentsResolve };
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
    const orchestrator = { draft: jest.fn(async () => ({ summary: null, nodes: [] })) };
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
    const orchestrator = { draft: jest.fn(async () => ({ summary: 's', provenance: [], nodes: [] })) };
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
    const orchestrator = { draft: jest.fn() };
    const { svc, withTenantUser, $queryRaw } = makeService(orchestrator, store);
    $queryRaw.mockResolvedValueOnce([]);

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
});

describe('MeriService.assistant', () => {
  const dto = { scope: 'strategy', instruction: 'Rework the plan' } as AssistantDto;

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
    // A question is not a mutation batch: no version, no write tx, and the
    // resp.summary is NOT persisted (existing meriSummary preserved).
    expect(versioning.cutVersion).not.toHaveBeenCalled();
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(store.strategies.get('S1')!.meriSummary).toBeNull();
    expect(out.summary).toBeNull();
    // Current, unchanged state is returned.
    expect(out.strategy.nodes).toHaveLength(3);
    expect(store.nodes.size).toBe(3);
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
});
