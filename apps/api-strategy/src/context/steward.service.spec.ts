import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { validateSync } from 'class-validator';
import { REQUIRED_TEMPLATE_KEYS, StewardService } from './steward.service.js';
import { ResolveConflictDto } from './dto/steward.dto.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { StrategyAiCredentialResolver } from '../meri/strategy-ai-credential.resolver.js';
import type { StrategyOrchestratorClient } from '../meri/strategy-orchestrator.client.js';
import type { StewardExtractResponse } from '../meri/meri.types.js';

/*
 * StewardService tests: in-memory fake tx (change-sets.service.spec.ts pattern)
 * with the REAL VersioningService so every mutation writes its activity +
 * outbox rows through the prod choke point. The fake tx SIMULATES the
 * tenant-scope query hook (where.tenantId injected on every model op) so
 * foreign-tenant rows are invisible exactly as in prod, and withTenant(User)
 * snapshot+restore the store on throw (modelling $transaction rollback).
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const USER = { clerkUserId: 'user-1', role: 'org:member' };

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_DOC_ID = '22222222-2222-4222-8222-222222222222';
const CLIENT_ID = '0a1b2c3d-4444-4555-8666-777788889999';
const OTHER_CLIENT_ID = '99999999-9999-4999-8999-999999999999';
const EXISTING_FACT_ID = '33333333-3333-4333-8333-333333333333';
const FOREIGN_TENANT_FACT_ID = '44444444-4444-4444-8444-444444444444';
const OTHER_CLIENT_FACT_ID = '55555555-5555-4555-8555-555555555555';
const REJECTED_FACT_ID = '66666666-6666-4666-8666-666666666666';

const DOC_CONTENT = [
  '# Strategy brief',
  '',
  '## Goal',
  '',
  'Win the FY27 plus-up.',
  '',
  '## Success criteria',
  '',
  '| criterion_id | Criterion |',
  '|---|---|',
  '| SC-001 | Report language secured |',
].join('\n');

function makeStore() {
  const docs = new Map<string, Rec>();
  const facts = new Map<string, Rec>();
  const conflicts = new Map<string, Rec>();
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  return { docs, facts, conflicts, activity, outbox, nextId };
}
type Store = ReturnType<typeof makeStore>;

/** Prisma-ish where matcher: scalars, { not }, { in }, and top-level OR. */
function matches(rec: Rec, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'OR') {
      const branches = v as Array<Record<string, unknown>>;
      if (!branches.some((b) => matches(rec, b))) return false;
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const op = v as { not?: unknown; in?: unknown[] };
      if ('not' in op && rec[k] === op.not) return false;
      if ('in' in op && !op.in!.includes(rec[k])) return false;
      continue;
    }
    if (rec[k] !== v) return false;
  }
  return true;
}

function makeTx(store: Store) {
  const now = () => new Date();
  // Simulate the prod tenant-scope query hook: EVERY where gets tenantId.
  const scoped = (where: Record<string, unknown> | undefined) => ({
    ...(where ?? {}),
    tenantId: T,
  });
  const sortedDesc = (map: Map<string, Rec>) =>
    [...map.values()].sort((a, b) => {
      const dt = (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
      if (dt !== 0) return dt;
      return String(b.id).localeCompare(String(a.id));
    });
  const attachDocument = (rec: Rec) => ({
    ...rec,
    document: {
      title: (store.docs.get(rec.documentId as string)?.title as string) ?? '(unknown)',
      templateKey: (store.docs.get(rec.documentId as string)?.templateKey as string) ?? '(unknown)',
    },
  });

  const spContextDocument = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      sortedDesc(store.docs).find((r) => matches(r, scoped(where))) ?? null,
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
      sortedDesc(store.docs)
        .filter((r) => matches(r, scoped(where)))
        .slice(0, take ?? Infinity),
  };
  const spContextFact = {
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('fact');
      const rec: Rec = {
        clientId: null,
        authority: null,
        asOf: null,
        confidence: null,
        citation: null,
        ...data,
        id,
        createdAt: now(),
        updatedAt: now(),
      };
      store.facts.set(id, rec);
      return rec;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      sortedDesc(store.facts).find((r) => matches(r, scoped(where))) ?? null,
    findMany: async ({
      where,
      take,
      include,
    }: {
      where: Record<string, unknown>;
      take?: number;
      include?: { document?: unknown };
    }) => {
      const rows = sortedDesc(store.facts)
        .filter((r) => matches(r, scoped(where)))
        .slice(0, take ?? Infinity);
      return include?.document ? rows.map(attachDocument) : rows;
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.facts.get(where.id);
      if (!rec || !matches(rec, scoped({}))) throw new Error('fact not found');
      const merged = { ...rec, ...data, updatedAt: now() };
      store.facts.set(where.id, merged);
      return merged;
    },
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Rec }) => {
      let count = 0;
      for (const [id, rec] of store.facts) {
        if (!matches(rec, scoped(where))) continue;
        store.facts.set(id, { ...rec, ...data, updatedAt: now() });
        count++;
      }
      return { count };
    },
  };
  const spContextConflict = {
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('conflict');
      const rec: Rec = {
        resolutionNote: null,
        resolvedByUserId: null,
        resolvedAt: null,
        ...data,
        id,
        createdAt: now(),
        updatedAt: now(),
      };
      store.conflicts.set(id, rec);
      return rec;
    },
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      sortedDesc(store.conflicts).find((r) => matches(r, scoped(where))) ?? null,
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
      sortedDesc(store.conflicts)
        .filter((r) => matches(r, scoped(where)))
        .slice(0, take ?? Infinity),
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.conflicts.get(where.id);
      if (!rec) throw new Error('conflict not found');
      const merged = { ...rec, ...data, updatedAt: now() };
      store.conflicts.set(where.id, merged);
      return merged;
    },
  };
  const spActivityLog = {
    create: async ({ data }: { data: Rec }) => {
      store.activity.push({ ...data, id: store.nextId('activity') });
    },
  };
  const spEventOutbox = {
    create: async ({ data }: { data: Rec }) => {
      store.outbox.push({ ...data, id: store.nextId('outbox') });
    },
  };
  return {
    spContextDocument,
    spContextFact,
    spContextConflict,
    spActivityLog,
    spEventOutbox,
  } as unknown as Prisma.TransactionClient;
}

const provider = {
  provider: 'anthropic',
  apiKey: 'k',
  model: 'claude-sonnet-4-6',
  usedTenantKey: true,
  modelOverridden: false,
} as unknown as Awaited<ReturnType<StrategyAiCredentialResolver['resolve']>>;

const EMPTY_RESPONSE: StewardExtractResponse = { facts: [], conflicts: [], summary: '' };

function makeService(store: Store, response: StewardExtractResponse = EMPTY_RESPONSE) {
  const snapshot = () => ({
    docs: new Map(store.docs),
    facts: new Map(store.facts),
    conflicts: new Map(store.conflicts),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.docs = snap.docs;
    store.facts = snap.facts;
    store.conflicts = snap.conflicts;
    store.activity = snap.activity;
    store.outbox = snap.outbox;
  };
  const inTx = async (fn: (tx: unknown) => Promise<unknown>) => {
    const snap = snapshot();
    try {
      return await fn(makeTx(store));
    } catch (e) {
      restore(snap);
      throw e;
    }
  };
  const withTenantUser = jest.fn(
    async (_t: string, _u: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn),
  );
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) => inTx(fn));
  const prisma = { withTenantUser, withTenant } as unknown as PrismaService;
  const resolve = jest.fn(async () => provider);
  const stewardExtract = jest.fn(async () => response);
  const svc = new StewardService(
    prisma,
    new VersioningService(),
    { resolve } as unknown as StrategyAiCredentialResolver,
    { stewardExtract } as unknown as StrategyOrchestratorClient,
  );
  return { svc, stewardExtract, resolve, withTenant, withTenantUser };
}

function seedDoc(store: Store, over: Partial<Rec> = {}): Rec {
  const doc: Rec = {
    id: DOC_ID,
    tenantId: T,
    clientId: CLIENT_ID,
    scope: 'strategy',
    scopeRef: null,
    templateKey: '01_strategy_brief',
    title: 'Strategy brief',
    state: 'active',
    content: DOC_CONTENT,
    frontmatter: { authority: 'client_approved', as_of: '2026-07-01' },
    validUntil: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
  store.docs.set(doc.id as string, doc);
  return doc;
}

let factSeq = 0;
function seedFact(store: Store, over: Partial<Rec> & { id: string }): Rec {
  const fact: Rec = {
    tenantId: T,
    documentId: OTHER_DOC_ID,
    clientId: CLIENT_ID,
    fact: `Seeded fact ${over.id}`,
    sourceRef: 'heading:Goal',
    authority: 'client_approved',
    asOf: new Date('2026-06-01T00:00:00.000Z'),
    confidence: 0.9,
    state: 'active',
    citation: null,
    createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, ++factSeq)),
    updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    ...over,
  };
  store.facts.set(fact.id as string, fact);
  return fact;
}

type WireFact = StewardExtractResponse['facts'][number];
const goodFact = (over: Partial<WireFact> = {}): WireFact => ({
  fact: 'The goal is winning the FY27 plus-up.',
  sourceRef: 'heading:Goal',
  authority: null,
  asOf: '2026-07-01',
  confidence: 0.8,
  citation: 'Win the FY27 plus-up.',
  ...over,
});

describe('StewardService.extract — gating + wire contract', () => {
  it('404s an unknown document and 409s a non-active one — the orchestrator is never called', async () => {
    const store = makeStore();
    const { svc, stewardExtract } = makeService(store);

    await expect(svc.extract(T, USER, DOC_ID, 'bearer')).rejects.toThrow(NotFoundException);

    seedDoc(store, { state: 'superseded' });
    const err = await svc.extract(T, USER, DOC_ID, 'bearer').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/superseded/);
    expect(stewardExtract).not.toHaveBeenCalled();
    expect(store.facts.size).toBe(0);
  });

  it('wire-contract (1): body carries the refs inventory (kind + <=120-char previews) and existingFacts EXCLUDING this document', async () => {
    const store = makeStore();
    seedDoc(store);
    store.docs.set(OTHER_DOC_ID, {
      id: OTHER_DOC_ID,
      tenantId: T,
      clientId: CLIENT_ID,
      templateKey: '02_client_constraints',
      title: 'Client constraints',
      state: 'active',
      content: '# Client constraints',
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    // Eligible corpus row (other doc, active) ...
    seedFact(store, { id: EXISTING_FACT_ID });
    // ... and rows that must NOT ride along: this document's own fact, a
    // non-active fact, another client's fact.
    seedFact(store, { id: '77777777-7777-4777-8777-777777777777', documentId: DOC_ID });
    seedFact(store, { id: REJECTED_FACT_ID, state: 'rejected' });
    seedFact(store, { id: OTHER_CLIENT_FACT_ID, clientId: OTHER_CLIENT_ID });
    const { svc, stewardExtract, resolve } = makeService(store);

    await svc.extract(T, USER, DOC_ID, 'bearer-token');

    expect(resolve).toHaveBeenCalledWith(T);
    const [body, bearer, aiProvider] = (stewardExtract as jest.Mock).mock.calls[0] as [
      {
        clientId: string;
        documentId: string;
        templateKey: string;
        authority: string | null;
        asOf: string | null;
        content: string;
        refs: Array<{ ref: string; kind: string; preview: string }>;
        existingFacts: Array<{ id: string; fact: string; documentTitle: string; asOf: string | null }>;
      },
      string,
      unknown,
    ];
    expect(bearer).toBe('bearer-token');
    expect(aiProvider).toBe(provider);
    expect(body.clientId).toBe(CLIENT_ID);
    expect(body.documentId).toBe(DOC_ID);
    expect(body.templateKey).toBe('01_strategy_brief');
    // Frontmatter authority/asOf ride along for provenance defaults.
    expect(body.authority).toBe('client_approved');
    expect(body.asOf).toBe('2026-07-01');
    expect(body.content).toBe(DOC_CONTENT);
    // Refs: every heading + the table's data row, kind-tagged, previews bounded.
    expect(body.refs.map((r) => r.ref)).toEqual([
      'heading:Strategy brief',
      'heading:Goal',
      'heading:Success criteria',
      'row:Success criteria:1',
    ]);
    const goal = body.refs.find((r) => r.ref === 'heading:Goal')!;
    expect(goal.kind).toBe('heading');
    expect(goal.preview).toContain('## Goal');
    const row = body.refs.find((r) => r.ref === 'row:Success criteria:1')!;
    expect(row.kind).toBe('row');
    expect(row.preview).toContain('SC-001');
    expect(body.refs.every((r) => r.preview.length <= 120)).toBe(true);
    // existingFacts: ONLY the eligible corpus row, shaped per contract.
    expect(body.existingFacts).toEqual([
      {
        id: EXISTING_FACT_ID,
        fact: `Seeded fact ${EXISTING_FACT_ID}`,
        documentTitle: 'Client constraints',
        authority: 'client_approved',
        asOf: '2026-06-01',
      },
    ]);
  });
});

describe('StewardService.extract — persistence', () => {
  it('persists only facts whose sourceRef RESOLVES; a fabricated ref is dropped and counted', async () => {
    const store = makeStore();
    seedDoc(store);
    const { svc } = makeService(store, {
      facts: [
        goodFact(),
        goodFact({
          fact: 'Report language is the success criterion.',
          sourceRef: 'row:Success criteria:1',
          authority: 'external_authoritative',
          asOf: 'not-a-date',
          confidence: 1.7,
        }),
        goodFact({ fact: 'Fabricated.', sourceRef: 'heading:No such section' }),
      ],
      conflicts: [],
      summary: 'Extracted the brief.',
    });

    const result = await svc.extract(T, USER, DOC_ID, 'bearer');

    expect(result).toEqual({ inserted: 2, droppedRefs: 1, conflicts: 0, summary: 'Extracted the brief.' });
    const rows = [...store.facts.values()];
    expect(rows).toHaveLength(2);
    expect(rows.every((f) => f.state === 'active')).toBe(true);
    expect(rows.every((f) => f.documentId === DOC_ID)).toBe(true);
    expect(rows.every((f) => f.clientId === CLIENT_ID)).toBe(true);
    expect(rows.some((f) => f.fact === 'Fabricated.')).toBe(false);
    const byRef = new Map(rows.map((f) => [f.sourceRef, f]));
    // authority: fact's own when present, doc frontmatter authority otherwise.
    expect(byRef.get('heading:Goal')!.authority).toBe('client_approved');
    expect(byRef.get('row:Success criteria:1')!.authority).toBe('external_authoritative');
    // asOf: parseDbDate-style guard — a bogus date degrades to null, never throws.
    expect(byRef.get('heading:Goal')!.asOf).toEqual(new Date('2026-07-01T00:00:00.000Z'));
    expect(byRef.get('row:Success criteria:1')!.asOf).toBeNull();
    // confidence clamped into [0,1]; citation stored verbatim.
    expect(byRef.get('row:Success criteria:1')!.confidence).toBe(1);
    expect(byRef.get('heading:Goal')!.citation).toBe('Win the FY27 plus-up.');
    // Audit: steward.extracted with the exact counts + outbox mirror.
    const logged = store.activity.at(-1)!;
    expect(logged.action).toBe('steward.extracted');
    expect(logged.entityId).toBe(DOC_ID);
    expect(logged.after).toEqual({ documentId: DOC_ID, inserted: 2, droppedRefs: 1, conflicts: 0 });
    expect(store.outbox.at(-1)!.type).toBe('steward.extracted');
  });

  it("an OMITTED asOf (null on the wire) inherits the document's as_of; a fact's own date wins; no doc as_of stays undated", async () => {
    const store = makeStore();
    // Doc as_of deliberately differs from goodFact's default asOf.
    seedDoc(store, { frontmatter: { authority: 'client_approved', as_of: '2026-05-15' } });
    const { svc } = makeService(store, {
      facts: [
        // Doc-dated fact: the model omits asOf (sanitized to null on the wire).
        goodFact({ asOf: null }),
        // Row-dated fact: carries its own date — it wins over the doc's.
        goodFact({
          fact: 'Report language is the success criterion.',
          sourceRef: 'row:Success criteria:1',
          asOf: '2026-06-20',
        }),
      ],
      conflicts: [],
      summary: 's',
    });

    await svc.extract(T, USER, DOC_ID, 'bearer');

    const byRef = new Map([...store.facts.values()].map((f) => [f.sourceRef, f]));
    expect(byRef.get('heading:Goal')!.asOf).toEqual(new Date('2026-05-15T00:00:00.000Z'));
    expect(byRef.get('row:Success criteria:1')!.asOf).toEqual(new Date('2026-06-20T00:00:00.000Z'));

    // Re-seed the SAME doc with NO as_of: an omitted asOf now stays undated
    // (inherit nothing — never fabricate a date).
    seedDoc(store, { frontmatter: { authority: 'client_approved' } });
    await svc.extract(T, USER, DOC_ID, 'bearer');
    const active = [...store.facts.values()].filter((f) => f.state === 'active');
    expect(active).toHaveLength(2);
    expect(active.find((f) => f.sourceRef === 'heading:Goal')!.asOf).toBeNull();
  });

  it('fail-soft: an EMPTY extraction (orchestrator model failure) is a NO-OP — prior active facts survive, no write tx, no audit', async () => {
    const store = makeStore();
    seedDoc(store);
    const prior = seedFact(store, { id: '77777777-7777-4777-8777-777777777777', documentId: DOC_ID });
    const { svc, withTenantUser } = makeService(store, {
      facts: [],
      conflicts: [],
      summary: 'extraction failed: 529 overloaded',
    });

    const result = await svc.extract(T, USER, DOC_ID, 'bearer');

    // The diagnostic summary rides through so the caller can surface it.
    expect(result).toEqual({
      inserted: 0,
      droppedRefs: 0,
      conflicts: 0,
      summary: 'extraction failed: 529 overloaded',
    });
    // The document's grounding corpus is UNTOUCHED — the prior fact stays
    // active (a transient LLM error must never supersede it).
    expect(store.facts.get(prior.id as string)!.state).toBe('active');
    // A no-op opens no write tx and logs no steward.extracted activity.
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(store.activity).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('REPROCESS: the document\'s prior active facts are superseded (retained), replaced by the new set', async () => {
    const store = makeStore();
    seedDoc(store);
    const prior = seedFact(store, { id: '77777777-7777-4777-8777-777777777777', documentId: DOC_ID });
    const priorRejected = seedFact(store, {
      id: REJECTED_FACT_ID,
      documentId: DOC_ID,
      state: 'rejected',
    });
    const { svc } = makeService(store, { facts: [goodFact()], conflicts: [], summary: 's' });

    const result = await svc.extract(T, USER, DOC_ID, 'bearer');

    expect(result.inserted).toBe(1);
    // The prior ACTIVE fact is retired, not deleted; the reviewer's rejected
    // verdict is untouched (supersession targets active rows only).
    expect(store.facts.get(prior.id as string)!.state).toBe('superseded');
    expect(store.facts.get(priorRejected.id as string)!.state).toBe('rejected');
    const active = [...store.facts.values()].filter((f) => f.state === 'active');
    expect(active).toHaveLength(1);
    expect(active[0]!.fact).toBe('The goal is winning the FY27 plus-up.');
  });

  it('conflicts: newFactIndex remaps after drops — a conflict on a DROPPED fact is dropped; a valid one lands open', async () => {
    const store = makeStore();
    seedDoc(store);
    seedFact(store, { id: EXISTING_FACT_ID, fact: 'The ask is $8M.' });
    const { svc } = makeService(store, {
      facts: [
        goodFact({ fact: 'Fabricated.', sourceRef: 'heading:No such section' }), // index 0 -> dropped
        goodFact({ fact: 'The ask is $12M.' }), // index 1 -> survives
      ],
      conflicts: [
        // References the DROPPED fact -> dropped with it.
        { newFactIndex: 0, existingFactId: EXISTING_FACT_ID, material: true, rationale: 'r0' },
        // References the surviving fact -> lands as an OPEN conflict.
        { newFactIndex: 1, existingFactId: EXISTING_FACT_ID, material: true, rationale: 'r1' },
        // Out-of-range index -> dropped.
        { newFactIndex: 7, existingFactId: EXISTING_FACT_ID, material: false, rationale: 'r2' },
      ],
      summary: 's',
    });

    const result = await svc.extract(T, USER, DOC_ID, 'bearer');

    expect(result).toMatchObject({ inserted: 1, droppedRefs: 1, conflicts: 1 });
    const rows = [...store.conflicts.values()];
    expect(rows).toHaveLength(1);
    const inserted = [...store.facts.values()].find((f) => f.fact === 'The ask is $12M.')!;
    expect(rows[0]).toMatchObject({
      factAId: inserted.id,
      factBId: EXISTING_FACT_ID,
      material: true,
      state: 'open',
      tenantId: T,
    });
  });

  it('conflicts: an existingFactId of another tenant, another client, or a non-active fact is dropped', async () => {
    const store = makeStore();
    seedDoc(store);
    seedFact(store, { id: FOREIGN_TENANT_FACT_ID, tenantId: 'tenant-2' });
    seedFact(store, { id: OTHER_CLIENT_FACT_ID, clientId: OTHER_CLIENT_ID });
    seedFact(store, { id: REJECTED_FACT_ID, state: 'rejected' });
    const { svc } = makeService(store, {
      facts: [goodFact()],
      conflicts: [
        { newFactIndex: 0, existingFactId: FOREIGN_TENANT_FACT_ID, material: true, rationale: 'a' },
        { newFactIndex: 0, existingFactId: OTHER_CLIENT_FACT_ID, material: true, rationale: 'b' },
        { newFactIndex: 0, existingFactId: REJECTED_FACT_ID, material: true, rationale: 'c' },
        // Not even a UUID (LLM hallucination) — must not reach the id query.
        { newFactIndex: 0, existingFactId: 'fact_123', material: true, rationale: 'd' },
      ],
      summary: 's',
    });

    const result = await svc.extract(T, USER, DOC_ID, 'bearer');

    expect(result.conflicts).toBe(0);
    expect(store.conflicts.size).toBe(0);
    // The fact itself still landed — only the bogus conflicts were dropped.
    expect(result.inserted).toBe(1);
  });

  it('a firm-wide (client-null) existing fact IS an eligible conflict target for a client document', async () => {
    const store = makeStore();
    seedDoc(store);
    seedFact(store, { id: EXISTING_FACT_ID, clientId: null });
    const { svc } = makeService(store, {
      facts: [goodFact()],
      conflicts: [{ newFactIndex: 0, existingFactId: EXISTING_FACT_ID, material: true, rationale: 'r' }],
      summary: 's',
    });

    const result = await svc.extract(T, USER, DOC_ID, 'bearer');

    expect(result.conflicts).toBe(1);
    expect([...store.conflicts.values()][0]!.factBId).toBe(EXISTING_FACT_ID);
  });
});

describe('StewardService.rejectFact', () => {
  it('rejects an ACTIVE fact (with audit) and 409s any other state', async () => {
    const store = makeStore();
    const fact = seedFact(store, { id: EXISTING_FACT_ID });
    const { svc } = makeService(store);

    const updated = (await svc.rejectFact(T, USER, fact.id as string)) as Rec;
    expect(updated.state).toBe('rejected');
    expect(store.activity.at(-1)!.action).toBe('fact.rejected');
    expect(store.outbox.at(-1)!.type).toBe('fact.rejected');

    const err = await svc.rejectFact(T, USER, fact.id as string).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/rejected/);

    await expect(svc.rejectFact(T, USER, 'missing-id')).rejects.toThrow(NotFoundException);
  });

  it('409s a stale fact (reprocess signal is not a reviewer reject)', async () => {
    const store = makeStore();
    const fact = seedFact(store, { id: EXISTING_FACT_ID, state: 'stale' });
    const { svc } = makeService(store);

    const err = await svc.rejectFact(T, USER, fact.id as string).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(store.facts.get(fact.id as string)!.state).toBe('stale');
    expect(store.activity).toHaveLength(0);
  });
});

describe('StewardService conflicts — resolve / dismiss', () => {
  function seedConflict(store: Store, over: Partial<Rec> = {}): {
    conflict: Rec;
    factA: Rec;
    factB: Rec;
  } {
    const factA = seedFact(store, { id: EXISTING_FACT_ID, fact: 'The ask is $12M.' });
    const factB = seedFact(store, {
      id: OTHER_CLIENT_FACT_ID,
      clientId: CLIENT_ID,
      fact: 'The ask is $8M.',
    });
    const conflict: Rec = {
      id: 'conflict-1',
      tenantId: T,
      factAId: factA.id,
      factBId: factB.id,
      material: true,
      state: 'open',
      resolutionNote: null,
      resolvedByUserId: null,
      resolvedAt: null,
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
      ...over,
    };
    store.conflicts.set(conflict.id as string, conflict);
    return { conflict, factA, factB };
  }

  it('resolveConflict with controllingFactId REJECTS the losing fact and stamps note + resolver', async () => {
    const store = makeStore();
    const { conflict, factA, factB } = seedConflict(store);
    const { svc } = makeService(store);

    const updated = (await svc.resolveConflict(T, USER, conflict.id as string, {
      note: 'Client CFO confirmed $12M.',
      controllingFactId: factA.id as string,
    })) as Rec;

    expect(updated.state).toBe('resolved');
    expect(updated.resolutionNote).toBe('Client CFO confirmed $12M.');
    expect(updated.resolvedByUserId).toBe(USER.clerkUserId);
    expect(updated.resolvedAt).toBeInstanceOf(Date);
    // The controlling fact stands; the OTHER fact is rejected.
    expect(store.facts.get(factA.id as string)!.state).toBe('active');
    expect(store.facts.get(factB.id as string)!.state).toBe('rejected');
    const logged = store.activity.at(-1)!;
    expect(logged.action).toBe('conflict.resolved');
    expect(logged.after).toMatchObject({
      controllingFactId: factA.id,
      rejectedFactId: factB.id,
    });
  });

  it("resolveConflict NEVER rewrites a retired losing fact — 'rejected' is a verdict on a LIVE fact only", async () => {
    for (const retired of ['superseded', 'stale', 'rejected'] as const) {
      const store = makeStore();
      const { conflict, factA, factB } = seedConflict(store);
      // The loser was retired between the conflict opening and the reviewer's
      // verdict (reprocess supersede / document-supersede stale / facts-table
      // reject) — the row stays open in the review queue, so Resolve can
      // still land on it.
      store.facts.set(factB.id as string, { ...factB, state: retired });
      const { svc } = makeService(store);

      const updated = (await svc.resolveConflict(T, USER, conflict.id as string, {
        note: 'Client CFO confirmed $12M.',
        controllingFactId: factA.id as string,
      })) as Rec;

      // The conflict closes with the verdict, but the loser's state history
      // is preserved — a mechanical retirement must never read back as a
      // reviewer reject — and the audit trail records nothing was rejected.
      expect(updated.state).toBe('resolved');
      expect(store.facts.get(factA.id as string)!.state).toBe('active');
      expect(store.facts.get(factB.id as string)!.state).toBe(retired);
      const logged = store.activity.at(-1)!;
      expect(logged.action).toBe('conflict.resolved');
      expect(logged.after).toMatchObject({
        controllingFactId: factA.id,
        rejectedFactId: null,
      });
    }
  });

  it('a controllingFactId that is NEITHER fact is a 400 — full rollback, both facts untouched', async () => {
    const store = makeStore();
    const { conflict, factA, factB } = seedConflict(store);
    const { svc } = makeService(store);

    const err = await svc
      .resolveConflict(T, USER, conflict.id as string, {
        note: 'n',
        controllingFactId: '88888888-8888-4888-8888-888888888888',
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(store.conflicts.get(conflict.id as string)!.state).toBe('open');
    expect(store.facts.get(factA.id as string)!.state).toBe('active');
    expect(store.facts.get(factB.id as string)!.state).toBe('active');
    expect(store.activity).toHaveLength(0);
  });

  it('a blank note (empty or whitespace-only) is a 400 — the review-trail rationale is required server-side, not just in the web modal', async () => {
    const store = makeStore();
    const { conflict, factA, factB } = seedConflict(store);
    const { svc } = makeService(store);

    for (const note of ['', '   \n\t ']) {
      const err = await svc
        .resolveConflict(T, USER, conflict.id as string, {
          note,
          controllingFactId: factA.id as string,
        })
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(BadRequestException);
    }
    // Nothing resolved, no fact rejected, no audit rows.
    expect(store.conflicts.get(conflict.id as string)!.state).toBe('open');
    expect(store.facts.get(factA.id as string)!.state).toBe('active');
    expect(store.facts.get(factB.id as string)!.state).toBe('active');
    expect(store.activity).toHaveLength(0);
  });

  it('resolveConflict trims the note before stamping it on the conflict row and audit trail', async () => {
    const store = makeStore();
    const { conflict } = seedConflict(store);
    const { svc } = makeService(store);

    const updated = (await svc.resolveConflict(T, USER, conflict.id as string, {
      note: '  Client CFO confirmed $12M.  ',
    })) as Rec;
    expect(updated.resolutionNote).toBe('Client CFO confirmed $12M.');
    expect((store.activity.at(-1)!.after as Rec).note).toBe('Client CFO confirmed $12M.');
  });

  it('ResolveConflictDto rejects an empty/whitespace-only note at the validation edge', () => {
    for (const note of ['', '   ', ' \n\t ']) {
      const dto = Object.assign(new ResolveConflictDto(), { note });
      const errs = validateSync(dto);
      expect(errs.some((e) => e.property === 'note')).toBe(true);
    }
    const ok = Object.assign(new ResolveConflictDto(), { note: 'CFO confirmed the ask.' });
    expect(validateSync(ok)).toHaveLength(0);
  });

  it('resolveConflict without controllingFactId resolves in place (no fact rejected); non-open 409s', async () => {
    const store = makeStore();
    const { conflict, factA, factB } = seedConflict(store);
    const { svc } = makeService(store);

    const updated = (await svc.resolveConflict(T, USER, conflict.id as string, {
      note: 'Both true at different times.',
    })) as Rec;
    expect(updated.state).toBe('resolved');
    expect(store.facts.get(factA.id as string)!.state).toBe('active');
    expect(store.facts.get(factB.id as string)!.state).toBe('active');

    const err = await svc
      .resolveConflict(T, USER, conflict.id as string, { note: 'again' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
  });

  it('dismissConflict: open -> dismissed with audit; non-open 409s; unknown 404s', async () => {
    const store = makeStore();
    const { conflict } = seedConflict(store);
    const { svc } = makeService(store);

    const updated = (await svc.dismissConflict(T, USER, conflict.id as string)) as Rec;
    expect(updated.state).toBe('dismissed');
    expect(updated.resolvedByUserId).toBe(USER.clerkUserId);
    expect(store.activity.at(-1)!.action).toBe('conflict.dismissed');

    await expect(svc.dismissConflict(T, USER, conflict.id as string)).rejects.toThrow(
      ConflictException,
    );
    await expect(svc.dismissConflict(T, USER, 'missing')).rejects.toThrow(NotFoundException);
  });

  it('listConflicts embeds both facts WITH their provenance (document/authority/asOf) — the review UI decides on it', async () => {
    const store = makeStore();
    seedDoc(store, { id: OTHER_DOC_ID, title: 'Ask doc' });
    const { conflict, factA, factB } = seedConflict(store);
    const { svc } = makeService(store);

    const rows = (await svc.listConflicts(T, { state: 'open' })) as Array<Rec>;

    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(conflict.id);
    expect(rows[0]!.factA).toEqual({
      id: factA.id,
      fact: 'The ask is $12M.',
      documentTitle: 'Ask doc',
      authority: 'client_approved',
      asOf: '2026-06-01',
      clientId: CLIENT_ID,
    });
    expect(rows[0]!.factB).toMatchObject({ id: factB.id, fact: 'The ask is $8M.' });
    expect(rows[0]!.clientId).toBe(CLIENT_ID);

    await expect(svc.listConflicts(T, { state: 'bogus' })).rejects.toThrow(/Invalid state/);
  });
});

describe('StewardService.listFacts', () => {
  it('400s bogus state / non-UUID filters without opening a tx; filters by document', async () => {
    const store = makeStore();
    seedDoc(store);
    seedFact(store, { id: EXISTING_FACT_ID, documentId: DOC_ID });
    seedFact(store, { id: OTHER_CLIENT_FACT_ID });
    const { svc, withTenant } = makeService(store);

    await expect(svc.listFacts(T, { state: 'bogus' })).rejects.toThrow(/Invalid state/);
    await expect(svc.listFacts(T, { clientId: 'nope' })).rejects.toThrow(/Invalid clientId/);
    await expect(svc.listFacts(T, { documentId: 'nope' })).rejects.toThrow(/Invalid documentId/);
    expect(withTenant).not.toHaveBeenCalled();

    const rows = (await svc.listFacts(T, { documentId: DOC_ID })) as Array<Rec>;
    expect(rows.map((r) => r.id)).toEqual([EXISTING_FACT_ID]);
    // Joined with the owning document for the review UI.
    expect((rows[0]!.document as Rec).title).toBe('Strategy brief');
  });
});

describe('StewardService.health — fact-level grounding health (A8 upgrade)', () => {
  const REQUIRED_DOCS: Array<[string, string]> = [
    ['01_strategy_brief', 'r-doc-1'],
    ['02_client_constraints', 'r-doc-2'],
  ];
  function seedRequiredDocs(store: Store, opts: { staleConstraints?: boolean } = {}) {
    for (const [templateKey, id] of REQUIRED_DOCS) {
      store.docs.set(id, {
        id,
        tenantId: T,
        clientId: CLIENT_ID,
        templateKey,
        title: templateKey,
        state: 'active',
        content: '# x',
        validUntil:
          opts.staleConstraints && templateKey === '02_client_constraints'
            ? new Date(Date.now() - 2 * 86_400_000)
            : null,
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      });
    }
  }

  it("status 'ok' when both required templates have active docs, nothing stale, no open material conflicts", async () => {
    const store = makeStore();
    seedRequiredDocs(store);
    seedFact(store, { id: EXISTING_FACT_ID });
    seedFact(store, { id: REJECTED_FACT_ID, state: 'rejected' });
    const { svc } = makeService(store);

    const health = await svc.health(T, CLIENT_ID);

    expect(health.status).toBe('ok');
    expect(health.missingRequired).toEqual([]);
    expect(health.staleDocs).toEqual([]);
    expect(health.factCounts).toEqual({ active: 1, superseded: 0, stale: 0, rejected: 1 });
    expect(health.openConflicts).toBe(0);
    expect(health.openMaterialConflicts).toEqual([]);
  });

  it("status 'degraded' when a REQUIRED template has no active doc (missingRequired names it)", async () => {
    const store = makeStore();
    // Only the brief — client_constraints missing entirely.
    store.docs.set('r-doc-1', {
      id: 'r-doc-1',
      tenantId: T,
      clientId: CLIENT_ID,
      templateKey: '01_strategy_brief',
      title: 'brief',
      state: 'active',
      content: '# x',
      validUntil: null,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const { svc } = makeService(store);

    const health = await svc.health(T, CLIENT_ID);

    expect(health.status).toBe('degraded');
    expect(health.missingRequired).toEqual(['client_constraints']);
    // The exported required-keys contract is what the check runs on.
    expect(REQUIRED_TEMPLATE_KEYS).toEqual(['strategy_brief', 'client_constraints']);
  });

  it("status 'degraded' when an active doc has gone stale (validUntil < today)", async () => {
    const store = makeStore();
    seedRequiredDocs(store, { staleConstraints: true });
    const { svc } = makeService(store);

    const health = await svc.health(T, CLIENT_ID);

    expect(health.status).toBe('degraded');
    expect(health.missingRequired).toEqual([]); // the doc EXISTS — it is just stale
    expect(health.staleDocs).toHaveLength(1);
    expect(health.staleDocs[0]!.templateKey).toBe('02_client_constraints');
  });

  it("status 'conflicted' (beats degraded) on an open MATERIAL conflict — both fact texts carried verbatim", async () => {
    const store = makeStore();
    // Required docs deliberately MISSING too: conflicted must win.
    const a = seedFact(store, { id: EXISTING_FACT_ID, fact: 'The ask is $12M.' });
    const b = seedFact(store, {
      id: OTHER_CLIENT_FACT_ID,
      clientId: CLIENT_ID,
      fact: 'The ask is $8M.',
    });
    store.conflicts.set('c-1', {
      id: 'c-1',
      tenantId: T,
      factAId: a.id,
      factBId: b.id,
      material: true,
      state: 'open',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });
    const { svc } = makeService(store);

    const health = await svc.health(T, CLIENT_ID);

    expect(health.status).toBe('conflicted');
    expect(health.openConflicts).toBe(1);
    expect(health.openMaterialConflicts).toEqual([
      {
        id: 'c-1',
        factAId: a.id,
        factBId: b.id,
        factA: 'The ask is $12M.',
        factB: 'The ask is $8M.',
      },
    ]);
  });

  it('an open NON-material conflict does not flip the status (counted only)', async () => {
    const store = makeStore();
    seedRequiredDocs(store);
    const a = seedFact(store, { id: EXISTING_FACT_ID });
    const b = seedFact(store, { id: OTHER_CLIENT_FACT_ID, clientId: CLIENT_ID });
    store.conflicts.set('c-1', {
      id: 'c-1',
      tenantId: T,
      factAId: a.id,
      factBId: b.id,
      material: false,
      state: 'open',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });
    const { svc } = makeService(store);

    const health = await svc.health(T, CLIENT_ID);

    expect(health.status).toBe('ok');
    expect(health.openConflicts).toBe(1);
    expect(health.openMaterialConflicts).toEqual([]);
  });

  it("another client's conflicts and facts are OUT of scope; a bogus clientId 400s", async () => {
    const store = makeStore();
    seedRequiredDocs(store);
    const a = seedFact(store, { id: EXISTING_FACT_ID, clientId: OTHER_CLIENT_ID });
    const b = seedFact(store, { id: OTHER_CLIENT_FACT_ID, clientId: OTHER_CLIENT_ID });
    store.conflicts.set('c-1', {
      id: 'c-1',
      tenantId: T,
      factAId: a.id,
      factBId: b.id,
      material: true,
      state: 'open',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });
    const { svc } = makeService(store);

    const health = await svc.health(T, CLIENT_ID);
    expect(health.status).toBe('ok'); // the material conflict belongs to the OTHER client
    expect(health.factCounts.active).toBe(0);

    await expect(svc.health(T, 'not-a-uuid')).rejects.toThrow(/Invalid clientId/);
  });

  it('a material conflict is MOOT once one fact is rejected via the FACTS table — health stops reporting it (conflict row stays open)', async () => {
    const store = makeStore();
    seedRequiredDocs(store);
    const a = seedFact(store, { id: EXISTING_FACT_ID, fact: 'The ask is $12M.' });
    const b = seedFact(store, {
      id: OTHER_CLIENT_FACT_ID,
      clientId: CLIENT_ID,
      fact: 'The ask is $8M.',
    });
    store.conflicts.set('c-1', {
      id: 'c-1',
      tenantId: T,
      factAId: a.id,
      factBId: b.id,
      material: true,
      state: 'open',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });
    const { svc } = makeService(store);

    // Reviewer rejects fact A from the facts table (NOT the conflict Resolve
    // flow) — the dispute is settled: fact B stands, fact A no longer rides
    // in the stewardFacts pack.
    await svc.rejectFact(T, USER, a.id as string);

    const health = await svc.health(T, CLIENT_ID);
    expect(health.status).toBe('ok'); // NOT 'conflicted' over a rejected fact
    expect(health.openConflicts).toBe(0);
    expect(health.openMaterialConflicts).toEqual([]);
    // The conflict row itself is untouched — it stays in the review queue for
    // an explicit resolve/dismiss verdict.
    expect(store.conflicts.get('c-1')!.state).toBe('open');
  });

  it("a document-supersede flipping a fact to 'stale' also moots its open conflicts", async () => {
    const store = makeStore();
    seedRequiredDocs(store);
    const a = seedFact(store, { id: EXISTING_FACT_ID, fact: 'The ask is $12M.' });
    // The supersede path (context-documents.service) flips the OLD document's
    // active facts to `stale` without touching conflict rows.
    const b = seedFact(store, {
      id: OTHER_CLIENT_FACT_ID,
      clientId: CLIENT_ID,
      fact: 'The ask is $8M.',
      state: 'stale',
    });
    store.conflicts.set('c-1', {
      id: 'c-1',
      tenantId: T,
      factAId: a.id,
      factBId: b.id,
      material: true,
      state: 'open',
      createdAt: new Date('2026-07-02T00:00:00.000Z'),
    });
    const { svc } = makeService(store);

    const health = await svc.health(T, CLIENT_ID);

    expect(health.status).toBe('ok');
    expect(health.openConflicts).toBe(0);
    expect(health.openMaterialConflicts).toEqual([]);
  });
});

describe('StewardService.factsForOrchestrator (wire-contract 2 pack lines)', () => {
  it('returns ACTIVE facts in client scope (client + firm-null) shaped with documentTitle/templateKey', async () => {
    const store = makeStore();
    seedDoc(store);
    seedFact(store, { id: EXISTING_FACT_ID, documentId: DOC_ID, fact: 'Client fact.' });
    seedFact(store, {
      id: OTHER_CLIENT_FACT_ID,
      documentId: DOC_ID,
      clientId: null,
      fact: 'Firm-wide fact.',
    });
    seedFact(store, { id: REJECTED_FACT_ID, documentId: DOC_ID, state: 'rejected' });
    seedFact(store, {
      id: FOREIGN_TENANT_FACT_ID,
      documentId: DOC_ID,
      clientId: OTHER_CLIENT_ID,
      fact: 'Another client.',
    });
    const { svc } = makeService(store);

    const lines = await svc.factsForOrchestrator(T, CLIENT_ID);

    expect(lines.map((l) => l.fact).sort()).toEqual(['Client fact.', 'Firm-wide fact.']);
    const line = lines.find((l) => l.fact === 'Client fact.')!;
    expect(line).toEqual({
      id: EXISTING_FACT_ID,
      fact: 'Client fact.',
      sourceRef: 'heading:Goal',
      documentTitle: 'Strategy brief',
      templateKey: '01_strategy_brief',
      authority: 'client_approved',
      asOf: '2026-06-01',
    });
  });
});
