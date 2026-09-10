import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException } from '@nestjs/common';
import { ContextDocumentsService } from './context-documents.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma-client/index.js';

/*
 * F06 (2026-09-10 remediation plan §4): the New-strategy overlay must not
 * derive "available context" from the broad 200-capped inventory list. This is
 * the server-backed availability projection it consumes instead: eligible
 * document ids, eligible fact count, excluded-reason counts, and an explicit
 * truncation flag — computed with the SAME scope policy the draft operation
 * grounds on (a NEW strategy: client-scope + firm-scope active, non-stale
 * documents; strategy/node/once-scoped material can never apply to a strategy
 * that does not exist yet).
 *
 * Harness mirrors context-documents.service.spec.ts (in-memory fake tx).
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const CLIENT_ID = '0a1b2c3d-4444-4555-8666-777788889999';
const OTHER_CLIENT_ID = '99999999-9999-4999-8999-999999999999';
const STRATEGY_ID = '77777777-7777-4777-8777-777777777777';

function makeStore() {
  const docs = new Map<string, Rec>();
  const facts = new Map<string, Rec>();
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  return { docs, facts, nextId };
}
type Store = ReturnType<typeof makeStore>;

function matches(rec: Rec, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (k === 'AND') {
      if (!(v as Record<string, unknown>[]).every((branch) => matches(rec, branch))) return false;
      continue;
    }
    if (k === 'OR') {
      if (!(v as Record<string, unknown>[]).some((branch) => matches(rec, branch))) return false;
      continue;
    }
    if (k === 'document') {
      const document = rec.document as Rec | undefined;
      if (!document || !matches(document, (v as { is: Record<string, unknown> }).is)) return false;
      continue;
    }
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const op = v as { not?: unknown; in?: unknown[]; gte?: Date };
      if ('not' in op && rec[k] === op.not) return false;
      if ('in' in op && !op.in!.includes(rec[k])) return false;
      if ('gte' in op && (!(rec[k] instanceof Date) || (rec[k] as Date) < op.gte!)) return false;
      continue;
    }
    if (rec[k] !== v) return false;
  }
  return true;
}

function makeTx(store: Store) {
  const now = () => new Date();
  const attachDocument = (rec: Rec) => ({
    ...rec,
    document: store.docs.get(rec.documentId as string) ?? null,
  });
  const spContextDocument = {
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) => {
      const rows = [...store.docs.values()].filter((r) => matches(r, where));
      // Respect the take limit so the projection's uncounted-truncation path
      // is observable (a capped read must not produce an authoritative total).
      return rows.slice(0, take ?? Infinity);
    },
  };
  const spContextFact = {
    findMany: async ({ where }: { where: Record<string, unknown> }) =>
      [...store.facts.values()].filter((r) => matches(attachDocument(r), where)),
    count: async ({ where }: { where: Record<string, unknown> }) =>
      [...store.facts.values()].filter((r) => matches(attachDocument(r), where)).length,
  };
  return { spContextDocument, spContextFact } as unknown as Prisma.TransactionClient;
}

function makeService(store: Store) {
  const withTenant = jest.fn(async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn(makeTx(store)),
  );
  const prisma = { withTenant } as unknown as PrismaService;
  const svc = new ContextDocumentsService(prisma, new VersioningService());
  return { svc, withTenant };
}

function seedDoc(store: Store, over: Partial<Rec> & { id: string }): Rec {
  const doc: Rec = {
    tenantId: T,
    clientId: CLIENT_ID,
    scope: 'client',
    scopeRef: null,
    templateKey: '02_client_constraints',
    title: 'Doc',
    state: 'active',
    validUntil: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    ...over,
  };
  store.docs.set(doc.id, doc);
  return doc;
}

let factSeq = 0;
function seedFact(store: Store, over: Partial<Rec> & { id: string; documentId: string }): Rec {
  const fact: Rec = {
    tenantId: T,
    clientId: CLIENT_ID,
    state: 'active',
    createdAt: new Date(Date.UTC(2026, 5, 1, 0, 0, ++factSeq)),
    ...over,
  };
  store.facts.set(fact.id, fact);
  return fact;
}

describe('ContextDocumentsService.availability (F06 new-strategy scope)', () => {
  it('a client with only a brief linked to an ARCHIVED strategy reports zero applicable documents', async () => {
    const store = makeStore();
    seedDoc(store, {
      id: 'archived-strategy-brief',
      scope: 'strategy',
      scopeRef: STRATEGY_ID,
      title: 'Archived strategy brief',
    });
    const { svc } = makeService(store);

    const result = await svc.availability(T, CLIENT_ID);

    expect(result.eligibleDocumentIds).toEqual([]);
    expect(result.eligibleFactCount).toBe(0);
    expect(result.excluded.strategyScoped).toBe(1);
  });

  it('excludes a strategy-scoped document even when its strategy reference is missing', async () => {
    const store = makeStore();
    seedDoc(store, { id: 'orphaned-brief', scope: 'strategy', scopeRef: null });
    seedFact(store, { id: 'orphaned-fact', documentId: 'orphaned-brief', fact: 'Unbound strategy evidence.' });
    const { svc } = makeService(store);

    const result = await svc.availability(T, CLIENT_ID);

    expect(result.eligibleDocumentIds).toEqual([]);
    expect(result.eligibleFactCount).toBe(0);
    expect(result.excluded.strategyScoped).toBe(1);
  });

  it('counts one eligible client document and only facts whose PARENT document is eligible', async () => {
    const store = makeStore();
    seedDoc(store, { id: 'client-constraints', title: 'Client constraints' });
    seedDoc(store, {
      id: 'other-strategy-brief',
      scope: 'strategy',
      scopeRef: '88888888-8888-4888-8888-888888888888',
    });
    seedFact(store, { id: 'f-1', documentId: 'client-constraints', fact: 'Eligible fact.' });
    seedFact(store, {
      id: 'f-2',
      documentId: 'client-constraints',
      state: 'stale',
      fact: 'Stale fact.',
    });
    seedFact(store, {
      id: 'f-3',
      documentId: 'other-strategy-brief',
      fact: 'Excluded parent fact.',
    });
    const { svc } = makeService(store);

    const result = await svc.availability(T, CLIENT_ID);

    expect(result.eligibleDocumentIds).toEqual(['client-constraints']);
    expect(result.eligibleFactCount).toBe(1);
    expect(result.excluded.strategyScoped).toBe(1);
  });

  it('excludes stale, superseded and archived documents, and firm documents count for the client', async () => {
    const store = makeStore();
    const yesterday = new Date(Date.now() - 86_400_000);
    seedDoc(store, { id: 'stale-doc', validUntil: yesterday, title: 'Stale' });
    seedDoc(store, { id: 'superseded-doc', state: 'superseded', title: 'Old version' });
    seedDoc(store, { id: 'archived-doc', state: 'archived', title: 'Archived' });
    seedDoc(store, { id: 'firm-doc', clientId: null, scope: 'firm', title: 'Firm doc' });
    seedDoc(store, { id: 'other-client-doc', clientId: OTHER_CLIENT_ID, title: 'Other client' });
    const { svc } = makeService(store);

    const result = await svc.availability(T, CLIENT_ID);

    expect(result.eligibleDocumentIds).toEqual(['firm-doc']);
    expect(result.excluded.stale).toBe(1);
    expect(result.excluded.retired).toBe(2);
  });

  it('node- and once-scoped documents are excluded from a new strategy', async () => {
    const store = makeStore();
    seedDoc(store, { id: 'node-doc', scope: 'node', scopeRef: 'node-1' });
    seedDoc(store, { id: 'once-doc', scope: 'once' });
    const { svc } = makeService(store);

    const result = await svc.availability(T, CLIENT_ID);

    expect(result.eligibleDocumentIds).toEqual([]);
    expect(result.excluded.nodeScoped).toBe(2);
  });

  // Review fix (2026-09-10 audit): a scoped row with a MISSING scopeRef (the
  // unbound-context state the list tests exercise for 'once') must be excluded
  // by its scope KIND — previously it slipped through the scopeRef-guarded
  // branch and was counted as ELIGIBLE working context.
  it('an unbound scoped document (scopeRef null) is never eligible, whatever its kind', async () => {
    const store = makeStore();
    seedDoc(store, { id: 'unbound-once', scope: 'once', scopeRef: null });
    seedDoc(store, { id: 'unbound-strategy', scope: 'strategy', scopeRef: null });
    const { svc } = makeService(store);

    const result = await svc.availability(T, CLIENT_ID);

    expect(result.eligibleDocumentIds).toEqual([]);
    expect(result.excluded.nodeScoped).toBe(1);
    expect(result.excluded.strategyScoped).toBe(1);
  });

  it('400s a malformed clientId instead of a Prisma 500', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const err = await svc.availability(T, 'not-a-uuid').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
  });

  it('flags truncation instead of deriving an authoritative total from a capped read', async () => {
    const store = makeStore();
    // 3 eligible docs but the fake tx caps every findMany at take=2 — the
    // projection must report truncated:true, never a silently short total.
    seedDoc(store, { id: 'd-1' });
    seedDoc(store, { id: 'd-2' });
    seedDoc(store, { id: 'd-3' });
    const { svc } = makeService(store);

    const capped = await svc.availability(T, CLIENT_ID, { documentTakeLimit: 2 });

    expect(capped.truncated).toBe(true);
  });
});
