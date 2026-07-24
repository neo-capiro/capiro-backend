import { describe, expect, it, jest } from '@jest/globals';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ContextDocumentsService } from './context-documents.service.js';
import { VersioningService } from '../strategy/versioning.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { FieldError } from './frontmatter.js';

/*
 * ContextDocumentsService tests: in-memory fake tx (change-sets.service.spec.ts
 * makeStore/makeTx pattern) with the REAL VersioningService, so every upload /
 * supersession / archive writes its activity + outbox rows through the exact
 * prod choke point. withTenantUser/withTenant snapshot+restore the store on
 * throw (modelling $transaction rollback).
 */

interface Rec {
  [k: string]: unknown;
  id: string;
}

const T = 'tenant-1';
const ADMIN = { clerkUserId: 'user-admin', role: 'org:admin' };
const MEMBER = { clerkUserId: 'user-member', role: 'org:member' };

const STRATEGY_ID = 'f6b7c1de-1111-4222-8333-444455556666';
const CLIENT_ID = '0a1b2c3d-4444-4555-8666-777788889999';

function makeStore() {
  const docs = new Map<string, Rec>();
  // Stage E: sp_context_fact rows — document supersession flips the OLD doc's
  // active facts to `stale` in the same tx.
  const facts = new Map<string, Rec>();
  const activity: Rec[] = [];
  const outbox: Rec[] = [];
  let seq = 0;
  const nextId = (p: string) => `${p}-${++seq}`;
  return { docs, facts, activity, outbox, nextId };
}
type Store = ReturnType<typeof makeStore>;

/**
 * Prisma-ish where matcher: scalar equality, the `{ not: x }` operator, and
 * the JSON `{ path: [...], equals: x }` filter (frontmatter document_id lookup).
 */
function matches(rec: Rec, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      const op = v as { not?: unknown; path?: unknown; equals?: unknown };
      if ('not' in op && rec[k] === op.not) return false;
      if (Array.isArray(op.path)) {
        let cur: unknown = rec[k];
        for (const seg of op.path as string[]) {
          cur =
            cur !== null && typeof cur === 'object'
              ? (cur as Record<string, unknown>)[seg]
              : undefined;
        }
        if (cur !== op.equals) return false;
      }
    } else if (rec[k] !== v) {
      return false;
    }
  }
  return true;
}

function makeTx(store: Store) {
  const now = () => new Date();
  const sortedDesc = () =>
    [...store.docs.values()].sort((a, b) => {
      const dt = (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime();
      if (dt !== 0) return dt;
      return String(b.id).localeCompare(String(a.id));
    });
  const spContextDocument = {
    findFirst: async ({ where }: { where: Record<string, unknown> }) =>
      sortedDesc().find((r) => matches(r, where)) ?? null,
    findMany: async ({ where, take }: { where: Record<string, unknown>; take?: number }) =>
      sortedDesc()
        .filter((r) => matches(r, where))
        .slice(0, take ?? Infinity),
    create: async ({ data }: { data: Rec }) => {
      const id = store.nextId('doc');
      const rec: Rec = {
        clientId: null,
        scopeRef: null,
        supersedesId: null,
        validUntil: null,
        updatedByUserId: null,
        ...data,
        id,
        createdAt: now(),
        updatedAt: now(),
      };
      store.docs.set(id, rec);
      return rec;
    },
    update: async ({ where, data }: { where: { id: string }; data: Rec }) => {
      const rec = store.docs.get(where.id);
      if (!rec) throw new Error('doc not found');
      const merged = { ...rec, ...data, updatedAt: now() };
      store.docs.set(where.id, merged);
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
  const spContextFact = {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Rec }) => {
      let count = 0;
      for (const [id, rec] of store.facts) {
        if (!matches(rec, where)) continue;
        store.facts.set(id, { ...rec, ...data, updatedAt: now() });
        count++;
      }
      return { count };
    },
  };
  return {
    spContextDocument,
    spActivityLog,
    spEventOutbox,
    spContextFact,
  } as unknown as Prisma.TransactionClient;
}

function makeService(store: Store) {
  const snapshot = () => ({
    docs: new Map(store.docs),
    facts: new Map(store.facts),
    activity: [...store.activity],
    outbox: [...store.outbox],
  });
  const restore = (snap: ReturnType<typeof snapshot>) => {
    store.docs = snap.docs;
    store.facts = snap.facts;
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
  const svc = new ContextDocumentsService(prisma, new VersioningService());
  return { svc, withTenant, withTenantUser };
}

/** Render a context document (raw frontmatter values + markdown body). */
function makeContent(fmOverrides: Record<string, string> = {}, body?: string): string {
  const fm: Record<string, string> = {
    document_type: 'strategy_brief',
    document_id: '"ctx_strategy_brief_001"',
    schema_version: '"1.0"',
    state: 'active',
    scope: 'strategy',
    client_id: 'null',
    strategy_id: `"${STRATEGY_ID}"`,
    node_id: 'null',
    meeting_id: 'null',
    as_of: '"2026-07-01"',
    valid_until: 'null',
    owner: '"user_2NNEqL2nrIRdJ194ndJqAHwEfxC"', // Clerk-style, NOT the 'user_123' placeholder
    authority: 'client_approved',
    source_of_truth: 'true',
    supersedes: 'null',
    confidentiality: 'client_confidential',
    ...fmOverrides,
  };
  const fmLines = Object.entries(fm).map(([k, v]) => `${k}: ${v}`);
  const defaultBody = [
    '# Strategy brief',
    '',
    '## Goal',
    '',
    'Win the plus-up.',
    '',
    '## Success criteria',
    '',
    '| criterion_id | Criterion |',
    '|---|---|',
    '| SC-001 | Report language secured |',
  ].join('\n');
  return ['---', ...fmLines, '---', '', body ?? defaultBody].join('\n');
}

function fieldErrorsOf(err: unknown): FieldError[] {
  const body = (err as BadRequestException).getResponse() as { errors?: FieldError[] };
  return body.errors ?? [];
}

describe('ContextDocumentsService.upload — validation', () => {
  it('invalid frontmatter -> BadRequest with the FIELD-LEVEL error array in the body, no tx opened', async () => {
    const store = makeStore();
    const { svc, withTenantUser } = makeService(store);

    const err = await svc
      .upload(T, ADMIN, { content: makeContent({ as_of: '"YYYY-MM-DD"', state: 'live' }) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    const errors = fieldErrorsOf(err);
    expect(errors).toContainEqual({
      field: 'as_of',
      message: expect.stringMatching(/placeholder date/),
    });
    expect(errors).toContainEqual({
      field: 'state',
      message: expect.stringContaining('draft, active, superseded, archived'),
    });
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(store.docs.size).toBe(0);
    expect(store.activity).toHaveLength(0);
  });

  it('the shipped placeholder ids (strategy_456 / user_123) are rejected — nothing persisted', async () => {
    const store = makeStore();
    const { svc, withTenantUser } = makeService(store);

    // A user fills in the dates but leaves the template's placeholder ids
    // untouched — the exact silent-fabrication path the validator must close.
    const err = await svc
      .upload(T, ADMIN, {
        content: makeContent({ strategy_id: '"strategy_456"', owner: '"user_123"' }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    const errors = fieldErrorsOf(err);
    expect(errors).toContainEqual({
      field: 'strategy_id',
      message: expect.stringMatching(/placeholder id 'strategy_456'/),
    });
    expect(errors).toContainEqual({
      field: 'owner',
      message: expect.stringMatching(/placeholder id 'user_123'/),
    });
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(store.docs.size).toBe(0);
  });

  it('a structurally broken document (no fences) -> BadRequest with a _structure field error', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const err = await svc.upload(T, ADMIN, { content: '# Just a body' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(fieldErrorsOf(err)).toEqual([
      { field: '_structure', message: expect.stringMatching(/opening '---'/) },
    ]);
  });

  it("the deferred meeting scope surfaces its SPECIFIC field error", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const err = await svc
      .upload(T, ADMIN, {
        content: makeContent({
          document_type: 'meeting_intelligence',
          scope: 'meeting',
          authority: 'meeting_intelligence',
        }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(fieldErrorsOf(err)).toContainEqual({
      field: 'scope',
      message:
        'meeting scope is deferred (meetings association is a later phase) — re-scope to strategy',
    });
  });
});

describe('ContextDocumentsService.upload — scope-gated pinning', () => {
  const clientScoped = () =>
    makeContent({
      document_type: 'client_constraints',
      scope: 'client',
      client_id: `"${CLIENT_ID}"`,
      strategy_id: 'null',
    });

  it('an org:member uploading a CLIENT-scope doc is Forbidden (nothing persisted)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const err = await svc
      .upload(T, MEMBER, { content: clientScoped(), clientId: CLIENT_ID })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toBe('client/firm-scope pinning requires an org admin');
    expect(store.docs.size).toBe(0);
  });

  it('an org:member uploading a FIRM-scope doc is Forbidden', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const err = await svc
      .upload(T, MEMBER, {
        content: makeContent({
          document_type: 'execution_playbook',
          scope: 'firm',
          strategy_id: 'null',
          authority: 'firm_approved',
          confidentiality: 'firm_internal',
        }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
  });

  it('the same org:member CAN upload a strategy-scope doc', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const doc = (await svc.upload(T, MEMBER, {
      content: makeContent(),
      scopeRef: STRATEGY_ID,
    })) as Rec;

    expect(doc.state).toBe('active');
    expect(doc.templateKey).toBe('01_strategy_brief');
    expect(doc.createdByUserId).toBe(MEMBER.clerkUserId);
  });

  it("a custom role merely CONTAINING 'admin' (org:admin_readonly) is Forbidden — exact match only", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    for (const role of ['org:admin_readonly', 'org:non_admin']) {
      const err = await svc
        .upload(T, { clerkUserId: 'u-custom', role }, {
          content: clientScoped(),
          clientId: CLIENT_ID,
        })
        .catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
    }
    expect(store.docs.size).toBe(0);
  });

  it('an org:admin CAN pin a client-scope doc (role segment matched case-insensitively)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const doc = (await svc.upload(T, { clerkUserId: 'u', role: 'org:Admin' }, {
      content: clientScoped(),
      clientId: CLIENT_ID,
    })) as Rec;

    expect(doc.scope).toBe('client');
    expect(doc.clientId).toBe(CLIENT_ID);
  });
});

describe('ContextDocumentsService.upload — idempotency + supersession', () => {
  it('identical re-upload returns the SAME row: no second row, no second activity/outbox', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const content = makeContent();

    const first = (await svc.upload(T, ADMIN, { content, scopeRef: STRATEGY_ID })) as Rec;
    const activityAfterFirst = store.activity.length;
    const second = (await svc.upload(T, ADMIN, { content, scopeRef: STRATEGY_ID })) as Rec;

    expect(second.id).toBe(first.id);
    expect(store.docs.size).toBe(1);
    expect(store.activity).toHaveLength(activityAfterFirst); // exactly the first upload's row
    expect(store.outbox).toHaveLength(activityAfterFirst);
    expect(store.activity[0]!.action).toBe('context_doc.uploaded');
  });

  it('re-uploading identical content AFTER archiving creates a NEW active row (archived rows never satisfy idempotency)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const content = makeContent();

    const first = (await svc.upload(T, ADMIN, { content, scopeRef: STRATEGY_ID })) as Rec;
    await svc.archive(T, ADMIN, first.id);
    const activityAfterArchive = store.activity.length;

    const revived = (await svc.upload(T, ADMIN, { content, scopeRef: STRATEGY_ID })) as Rec;

    // A new ACTIVE row — not the archived one echoed back.
    expect(revived.id).not.toBe(first.id);
    expect(revived.state).toBe('active');
    // No supersession: the archived row was not active, so nothing to replace.
    expect(revived.supersedesId).toBeNull();
    // The archived row is retained untouched.
    expect(store.docs.size).toBe(2);
    expect(store.docs.get(first.id)!.state).toBe('archived');
    // The re-upload is audited (uploaded activity + mirrored outbox row).
    expect(store.activity).toHaveLength(activityAfterArchive + 1);
    expect(store.activity.at(-1)!.action).toBe('context_doc.uploaded');
    expect(store.outbox.at(-1)!.type).toBe('context_doc.uploaded');
  });

  it('a changed re-upload SUPERSEDES: old row retained as superseded, new row points back, both retrievable', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const v1 = (await svc.upload(T, ADMIN, {
      content: makeContent({}, '# Strategy brief\n\nVersion one.'),
      scopeRef: STRATEGY_ID,
    })) as Rec;
    const v2 = (await svc.upload(T, ADMIN, {
      content: makeContent({ as_of: '"2026-07-20"' }, '# Strategy brief\n\nVersion two.'),
      scopeRef: STRATEGY_ID,
    })) as Rec;

    expect(v2.id).not.toBe(v1.id);
    expect(v2.supersedesId).toBe(v1.id);
    expect(v2.state).toBe('active');
    // The old row is RETAINED (never deleted) with state=superseded.
    expect(store.docs.size).toBe(2);
    expect(store.docs.get(v1.id)!.state).toBe('superseded');
    // Both retrievable.
    const gotOld = await svc.get(T, v1.id);
    const gotNew = await svc.get(T, v2.id);
    expect(gotOld.state).toBe('superseded');
    expect(gotNew.state).toBe('active');
    // Audit trail: superseded + uploaded logged in the SAME tx (outbox mirrors).
    const actions = store.activity.map((a) => a.action);
    expect(actions).toEqual([
      'context_doc.uploaded',
      'context_doc.superseded',
      'context_doc.uploaded',
    ]);
    expect(store.outbox.map((o) => o.type)).toEqual(actions);
  });

  it("supersession marks the OLD document's ACTIVE facts stale (Stage E reprocess signal) — other facts untouched", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const v1 = (await svc.upload(T, ADMIN, {
      content: makeContent({}, '# Strategy brief\n\nVersion one.'),
      scopeRef: STRATEGY_ID,
    })) as Rec;
    // The Steward extracted facts from v1 (one active, one already rejected)
    // and an unrelated doc's fact that must not be touched.
    store.facts.set('fact-1', { id: 'fact-1', documentId: v1.id, state: 'active' });
    store.facts.set('fact-2', { id: 'fact-2', documentId: v1.id, state: 'rejected' });
    store.facts.set('fact-3', { id: 'fact-3', documentId: 'doc-other', state: 'active' });

    await svc.upload(T, ADMIN, {
      content: makeContent({ as_of: '"2026-07-20"' }, '# Strategy brief\n\nVersion two.'),
      scopeRef: STRATEGY_ID,
    });

    // v1's ACTIVE fact goes stale in the SAME tx as the supersession; the
    // reviewer verdict (rejected) and the unrelated doc's fact are preserved.
    expect(store.facts.get('fact-1')!.state).toBe('stale');
    expect(store.facts.get('fact-2')!.state).toBe('rejected');
    expect(store.facts.get('fact-3')!.state).toBe('active');
  });

  it("frontmatter `state: draft` is HONORED: staged as draft, the active tuple-holder is NOT superseded", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const approved = (await svc.upload(T, ADMIN, {
      content: makeContent({}, '# Strategy brief\n\nApproved version.'),
      scopeRef: STRATEGY_ID,
    })) as Rec;
    const draft = (await svc.upload(T, ADMIN, {
      content: makeContent({ state: 'draft', authority: 'working_draft' }, '# Strategy brief\n\nWork in progress.'),
      scopeRef: STRATEGY_ID,
    })) as Rec;

    // The row state matches the validated frontmatter — no contradiction
    // between the state chip (frontmatter) and the persisted row.
    expect(draft.state).toBe('draft');
    expect((draft.frontmatter as Record<string, unknown>).state).toBe('draft');
    // The WIP draft does NOT displace the source of truth.
    expect(draft.supersedesId).toBeNull();
    expect(store.docs.get(approved.id)!.state).toBe('active');
    expect(store.activity.map((a) => a.action)).toEqual([
      'context_doc.uploaded',
      'context_doc.uploaded',
    ]);
    // Draft idempotency is state-exact: re-uploading the SAME draft returns it.
    const again = (await svc.upload(T, ADMIN, {
      content: makeContent({ state: 'draft', authority: 'working_draft' }, '# Strategy brief\n\nWork in progress.'),
      scopeRef: STRATEGY_ID,
    })) as Rec;
    expect(again.id).toBe(draft.id);
    expect(store.docs.size).toBe(2);
  });

  it("an org:member's once-scope upload CANNOT supersede an admin-pinned FIRM doc (scope is part of the supersession tuple)", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    // Admin pins the firm-wide playbook: templateKey=12_execution_playbook,
    // clientId=null, scopeRef=null — the tuple a scope-less lookup would match.
    const firmDoc = (await svc.upload(T, ADMIN, {
      content: makeContent({
        document_type: 'execution_playbook',
        scope: 'firm',
        strategy_id: 'null',
        authority: 'firm_approved',
        confidentiality: 'firm_internal',
      }),
    })) as Rec;

    // Member uploads the SAME document_type as un-gated `once` scope, omitting
    // clientId/scopeRef — assertCanPinScope('once') passes without a role check.
    const memberDoc = (await svc.upload(T, MEMBER, {
      content: makeContent(
        {
          document_type: 'execution_playbook',
          scope: 'once',
          strategy_id: 'null',
          authority: 'working_draft',
          confidentiality: 'firm_internal',
        },
        '# Execution playbook\n\nMember rewrite.',
      ),
    })) as Rec;

    // The admin's firm-wide source of truth stays ACTIVE and un-superseded.
    expect(store.docs.get(firmDoc.id)!.state).toBe('active');
    expect(memberDoc.supersedesId).toBeNull();
    expect(store.activity.map((a) => a.action)).not.toContain('context_doc.superseded');
  });

  it('an explicit frontmatter `supersedes` replaces the NAMED document, not the tuple match', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const STRATEGY_B = 'ab12cd34-2222-4333-8444-555566667777';

    // The intended target: Strategy A's brief (document_id ..._000).
    const target = (await svc.upload(T, ADMIN, {
      content: makeContent(
        { document_id: '"ctx_strategy_brief_000"' },
        '# Strategy brief\n\nStrategy A original.',
      ),
    })) as Rec;
    // A DIFFERENT active brief already holding the tuple the new upload lands
    // in (Strategy B) — the row the old tuple-only lookup would have picked.
    const bystander = (await svc.upload(T, ADMIN, {
      content: makeContent(
        { document_id: '"ctx_strategy_brief_777"', strategy_id: `"${STRATEGY_B}"` },
        '# Strategy brief\n\nStrategy B.',
      ),
    })) as Rec;

    // Re-binding Strategy A's brief onto Strategy B with the pack README's
    // rule 5: the explicit pointer must beat the tuple.
    const replacement = (await svc.upload(T, ADMIN, {
      content: makeContent(
        {
          document_id: '"ctx_strategy_brief_001"',
          strategy_id: `"${STRATEGY_B}"`,
          supersedes: '"ctx_strategy_brief_000"',
        },
        '# Strategy brief\n\nStrategy A rebound onto B.',
      ),
    })) as Rec;

    expect(replacement.supersedesId).toBe(target.id);
    expect(store.docs.get(target.id)!.state).toBe('superseded');
    // The tuple-matching bystander is untouched — the explicit target was not.
    expect(store.docs.get(bystander.id)!.state).toBe('active');
    const superseded = store.activity.filter((a) => a.action === 'context_doc.superseded');
    expect(superseded).toHaveLength(1);
    expect(superseded[0]!.entityId).toBe(target.id);
  });

  it('an explicit `supersedes` naming no ACTIVE document is a field-level 400 — never silently ignored', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const err = await svc
      .upload(T, ADMIN, {
        content: makeContent({ supersedes: '"ctx_strategy_brief_999"' }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(fieldErrorsOf(err)).toEqual([
      {
        field: 'supersedes',
        message:
          "no active '01_strategy_brief' document has document_id 'ctx_strategy_brief_999'",
      },
    ]);
    // Rolled back: no row, no activity/outbox.
    expect(store.docs.size).toBe(0);
    expect(store.activity).toHaveLength(0);
    expect(store.outbox).toHaveLength(0);
  });

  it('an org:member CANNOT retire an admin-pinned FIRM doc via an explicit `supersedes` pointer (Forbidden)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const playbook = {
      document_type: 'execution_playbook',
      scope: 'firm',
      strategy_id: 'null',
      authority: 'firm_approved',
      confidentiality: 'firm_internal',
    };

    const pinned = (await svc.upload(T, ADMIN, {
      content: makeContent(
        { ...playbook, document_id: '"ctx_execution_playbook_001"' },
        '# Execution playbook\n\nFirm approved.',
      ),
    })) as Rec;

    // The un-gated `once` scope passes assertCanPinScope for the NEW doc —
    // the TARGET's firm scope must still be re-checked.
    const err = await svc
      .upload(T, MEMBER, {
        content: makeContent(
          {
            ...playbook,
            scope: 'once',
            authority: 'working_draft',
            document_id: '"ctx_execution_playbook_002"',
            supersedes: '"ctx_execution_playbook_001"',
          },
          '# Execution playbook\n\nMember rewrite.',
        ),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toBe('client/firm-scope supersession requires an org admin');
    // Rolled back: the pinned doc stays active, nothing persisted.
    expect(store.docs.get(pinned.id)!.state).toBe('active');
    expect(store.docs.size).toBe(1);
  });

  it('a `state: draft` upload records its `supersedes` pointer WITHOUT acting on it', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const approved = (await svc.upload(T, ADMIN, {
      content: makeContent({ document_id: '"ctx_strategy_brief_000"' }),
    })) as Rec;
    const draft = (await svc.upload(T, ADMIN, {
      content: makeContent(
        {
          state: 'draft',
          authority: 'working_draft',
          supersedes: '"ctx_strategy_brief_000"',
        },
        '# Strategy brief\n\nDraft revision.',
      ),
    })) as Rec;

    // Recorded lineage only — the pointer is acted on when an ACTIVE revision
    // lands, never by a staged draft.
    expect(draft.state).toBe('draft');
    expect(draft.supersedesId).toBeNull();
    expect((draft.frontmatter as Record<string, unknown>).supersedes).toBe(
      'ctx_strategy_brief_000',
    );
    expect(store.docs.get(approved.id)!.state).toBe('active');
    expect(store.activity.map((a) => a.action)).not.toContain('context_doc.superseded');
  });
});

describe('ContextDocumentsService.upload — scopeRef derived from frontmatter (the UI upload path)', () => {
  // The library modal sends only { content, clientId } — the binding id must
  // come from the document's own validated frontmatter (strategy_id/node_id).
  const STRATEGY_B = 'ab12cd34-2222-4333-8444-555566667777';

  it('a strategy-scope upload WITHOUT dto.scopeRef binds scopeRef from frontmatter.strategy_id', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const doc = (await svc.upload(T, MEMBER, { content: makeContent() })) as Rec;

    expect(doc.scope).toBe('strategy');
    expect(doc.scopeRef).toBe(STRATEGY_ID);
  });

  it("briefs for TWO strategies (same client, no dto.scopeRef) do NOT collide — B must not supersede A", async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const a = (await svc.upload(T, MEMBER, {
      content: makeContent({}, '# Strategy brief\n\nStrategy A.'),
      clientId: CLIENT_ID,
    })) as Rec;
    const b = (await svc.upload(T, MEMBER, {
      content: makeContent(
        { strategy_id: `"${STRATEGY_B}"` },
        '# Strategy brief\n\nStrategy B.',
      ),
      clientId: CLIENT_ID,
    })) as Rec;

    // Distinct scopeRefs -> distinct supersession tuples -> both stay active.
    expect(a.scopeRef).toBe(STRATEGY_ID);
    expect(b.scopeRef).toBe(STRATEGY_B);
    expect(b.supersedesId).toBeNull();
    expect(store.docs.get(a.id)!.state).toBe('active');
    expect(store.docs.get(b.id)!.state).toBe('active');
    expect(store.activity.map((x) => x.action)).not.toContain('context_doc.superseded');
  });

  it('a dto.scopeRef CONTRADICTING frontmatter.strategy_id is a field-level 400 — nothing persisted, no tx', async () => {
    const store = makeStore();
    const { svc, withTenantUser } = makeService(store);
    const other = '99999999-9999-4999-8999-999999999999';

    const err = await svc
      .upload(T, MEMBER, { content: makeContent(), scopeRef: other })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(fieldErrorsOf(err)).toContainEqual({
      field: 'strategy_id',
      message: expect.stringMatching(/contradicts the request's scopeRef/),
    });
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(store.docs.size).toBe(0);
  });

  it('a non-UUID frontmatter binding id is a field-level 400, not a DB 500 (the literal template placeholder is caught even earlier by the placeholder check)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    // Not the shipped 'strategy_456' placeholder (validateFrontmatter already
    // 400s that with its own message) — an arbitrary non-UUID id must still be
    // stopped HERE, before it 500s at the uuid-typed scopeRef column.
    const err = await svc
      .upload(T, MEMBER, { content: makeContent({ strategy_id: '"strategy-fy27-brief"' }) })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(fieldErrorsOf(err)).toContainEqual({
      field: 'strategy_id',
      message: expect.stringMatching(/not a UUID/),
    });
    expect(store.docs.size).toBe(0);
  });

  it('node scope derives from frontmatter.node_id; firm scope stays unbound (scopeRef=null)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const NODE_ID = 'cc00dd11-3333-4444-8555-666677778888';

    const nodeDoc = (await svc.upload(T, MEMBER, {
      content: makeContent({
        document_type: 'current_plan',
        scope: 'node',
        strategy_id: 'null',
        node_id: `"${NODE_ID}"`,
      }),
    })) as Rec;
    const firmDoc = (await svc.upload(T, ADMIN, {
      content: makeContent({
        document_type: 'execution_playbook',
        scope: 'firm',
        strategy_id: 'null',
        authority: 'firm_approved',
        confidentiality: 'firm_internal',
      }),
    })) as Rec;

    expect(nodeDoc.scopeRef).toBe(NODE_ID);
    expect(firmDoc.scopeRef).toBeNull();
  });
});

describe('ContextDocumentsService.upload — clientId bound from frontmatter.client_id', () => {
  const clientScoped = () =>
    makeContent({
      document_type: 'client_constraints',
      scope: 'client',
      client_id: `"${CLIENT_ID}"`,
      strategy_id: 'null',
    });

  it('a client-scope upload WITHOUT dto.clientId binds clientId from frontmatter — NOT firm-wide (clientId=null)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const doc = (await svc.upload(T, ADMIN, { content: clientScoped() })) as Rec;

    expect(doc.scope).toBe('client');
    expect(doc.clientId).toBe(CLIENT_ID);
    // The library's firm-wide filter (clientId === null) must NOT match it.
    expect((await svc.list(T, { clientId: CLIENT_ID })).map((r) => r.id)).toEqual([doc.id]);
  });

  it('a dto.clientId CONTRADICTING frontmatter.client_id is a field-level 400 — nothing persisted, no tx', async () => {
    const store = makeStore();
    const { svc, withTenantUser } = makeService(store);
    const otherClient = '99999999-9999-4999-8999-999999999999';

    const err = await svc
      .upload(T, ADMIN, { content: clientScoped(), clientId: otherClient })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(fieldErrorsOf(err)).toContainEqual({
      field: 'client_id',
      message: expect.stringMatching(/contradicts the request's clientId/),
    });
    expect(withTenantUser).not.toHaveBeenCalled();
    expect(store.docs.size).toBe(0);
  });

  it('a non-UUID frontmatter client_id is a field-level 400, not a DB 500 (the literal template placeholder is caught even earlier by the placeholder check)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    // Not the shipped 'client_123' placeholder (validateFrontmatter already
    // 400s that with its own message) — an arbitrary non-UUID id must still be
    // stopped HERE, before it 500s at the uuid-typed clientId column.
    const err = await svc
      .upload(T, ADMIN, {
        content: makeContent({
          document_type: 'client_constraints',
          scope: 'client',
          client_id: '"client-acme-defense"',
          strategy_id: 'null',
        }),
      })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect(fieldErrorsOf(err)).toContainEqual({
      field: 'client_id',
      message: expect.stringMatching(/not a UUID/),
    });
    expect(store.docs.size).toBe(0);
  });

  it('a strategy-scope doc DECLARING its client in frontmatter binds clientId even when the dto omits it', async () => {
    const store = makeStore();
    const { svc } = makeService(store);

    const doc = (await svc.upload(T, MEMBER, {
      content: makeContent({ client_id: `"${CLIENT_ID}"` }),
    })) as Rec;

    expect(doc.clientId).toBe(CLIENT_ID);
    expect(doc.scopeRef).toBe(STRATEGY_ID);
  });
});

describe('ContextDocumentsService staleness (derived, never stored)', () => {
  const isoDaysFromNow = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  async function uploadWithValidUntil(
    svc: ContextDocumentsService,
    validUntil: string,
    strategyId: string,
  ): Promise<Rec> {
    // The binding id rides in the frontmatter (the contract) — a dto.scopeRef
    // contradicting it would 400, and omitting it binds from strategy_id.
    return (await svc.upload(T, ADMIN, {
      content: makeContent({ valid_until: validUntil, strategy_id: `"${strategyId}"` }),
    })) as Rec;
  }

  it('validUntil yesterday => stale:true, tomorrow => false, null => false', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    // Distinct frontmatter strategy_id per doc -> distinct key tuples (no supersession).
    const yesterday = await uploadWithValidUntil(
      svc,
      `"${isoDaysFromNow(-1)}"`,
      '11111111-1111-4111-8111-111111111111',
    );
    const tomorrow = await uploadWithValidUntil(
      svc,
      `"${isoDaysFromNow(1)}"`,
      '22222222-2222-4222-8222-222222222222',
    );
    const open = await uploadWithValidUntil(svc, 'null', '33333333-3333-4333-8333-333333333333');

    expect((await svc.get(T, yesterday.id)).stale).toBe(true);
    expect((await svc.get(T, tomorrow.id)).stale).toBe(false);
    expect((await svc.get(T, open.id)).stale).toBe(false);
    // Nothing stored: the rows carry no stale column.
    expect('stale' in store.docs.get(yesterday.id)!).toBe(false);
  });

  it('list EXCLUDES stale rows by default and includes them (flagged) with includeStale', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const stale = await uploadWithValidUntil(
      svc,
      `"${isoDaysFromNow(-1)}"`,
      '11111111-1111-4111-8111-111111111111',
    );
    const fresh = await uploadWithValidUntil(
      svc,
      `"${isoDaysFromNow(1)}"`,
      '22222222-2222-4222-8222-222222222222',
    );

    const defaults = await svc.list(T, {});
    expect(defaults.map((r) => r.id)).toEqual([fresh.id]);

    const all = await svc.list(T, { includeStale: true });
    expect(all.map((r) => r.id).sort()).toEqual([stale.id, fresh.id].sort());
    expect(all.find((r) => r.id === stale.id)!.stale).toBe(true);
    expect(all.find((r) => r.id === fresh.id)!.stale).toBe(false);
  });

  it('list 400s an invalid state filter without opening a tx', async () => {
    const store = makeStore();
    const { svc, withTenant } = makeService(store);

    const err = await svc.list(T, { state: 'bogus' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/Invalid state 'bogus'/);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('list 400s a non-UUID clientId filter without opening a tx (uuid column -> P2023 500 otherwise)', async () => {
    const store = makeStore();
    const { svc, withTenant } = makeService(store);

    const err = await svc.list(T, { clientId: 'not-a-uuid' }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as Error).message).toMatch(/Invalid clientId 'not-a-uuid'/);
    expect(withTenant).not.toHaveBeenCalled();
  });

  it('list accepts a well-formed clientId and filters by it', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const doc = (await svc.upload(T, ADMIN, {
      content: makeContent(),
      scopeRef: STRATEGY_ID,
      clientId: CLIENT_ID,
    })) as Rec;

    const hits = await svc.list(T, { clientId: CLIENT_ID });
    expect(hits.map((r) => r.id)).toEqual([doc.id]);
    const misses = await svc.list(T, { clientId: '99999999-9999-4999-8999-999999999999' });
    expect(misses).toEqual([]);
  });
});

describe('ContextDocumentsService.locate / sections (LLM-free provenance)', () => {
  it('locate returns the EXACT row content + line numbers straight from the stored markdown', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const content = makeContent();
    const doc = (await svc.upload(T, ADMIN, { content, scopeRef: STRATEGY_ID })) as Rec;

    const hit = await svc.locate(T, doc.id, 'row:Success criteria:1');

    const lines = content.split('\n');
    const rowLine = '| SC-001 | Report language secured |';
    const headerLine = '| criterion_id | Criterion |';
    expect(hit.kind).toBe('row');
    expect(hit.content).toBe(`${rowLine}\n${headerLine}`);
    expect(hit.startLine).toBe(lines.indexOf(rowLine) + 1);
    expect(hit.endLine).toBe(hit.startLine);
  });

  it('sections enumerates headings + tables with stable refs; heading locate round-trips', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const content = makeContent();
    const doc = (await svc.upload(T, ADMIN, { content, scopeRef: STRATEGY_ID })) as Rec;

    const { sections, tables } = await svc.sections(T, doc.id);
    expect(sections.map((s) => s.ref)).toEqual([
      'heading:Strategy brief',
      'heading:Goal',
      'heading:Success criteria',
    ]);
    expect(tables).toHaveLength(1);
    expect(tables[0]!.sectionRef).toBe('heading:Success criteria');
    expect(tables[0]!.headerCells).toEqual(['criterion_id', 'Criterion']);
    expect(tables[0]!.rowCount).toBe(1);

    const goal = await svc.locate(T, doc.id, 'heading:Goal');
    expect(goal.kind).toBe('heading');
    expect(goal.content).toContain('## Goal');
    expect(goal.content).toContain('Win the plus-up.');
  });

  it('an unknown ref 404s', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const doc = (await svc.upload(T, ADMIN, {
      content: makeContent(),
      scopeRef: STRATEGY_ID,
    })) as Rec;

    const err = await svc.locate(T, doc.id, 'heading:No such section').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotFoundException);
  });
});

describe('ContextDocumentsService.archive', () => {
  it('archives an active doc (state + audit row) and 409s a second archive', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const doc = (await svc.upload(T, ADMIN, {
      content: makeContent(),
      scopeRef: STRATEGY_ID,
    })) as Rec;

    const archived = (await svc.archive(T, ADMIN, doc.id)) as Rec;
    expect(archived.state).toBe('archived');
    expect(store.activity.map((a) => a.action)).toContain('context_doc.archived');

    const err = await svc.archive(T, ADMIN, doc.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
  });

  it('an org:member CANNOT archive an admin-pinned CLIENT-scope doc (Forbidden — symmetry with the pinning gate)', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const pinned = (await svc.upload(T, ADMIN, {
      content: makeContent({
        document_type: 'client_constraints',
        scope: 'client',
        client_id: `"${CLIENT_ID}"`,
        strategy_id: 'null',
      }),
      clientId: CLIENT_ID,
    })) as Rec;

    const err = await svc.archive(T, MEMBER, pinned.id).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as Error).message).toBe('client/firm-scope archival requires an org admin');
    // The pinned doc is untouched: still active, no archive audit row.
    expect(store.docs.get(pinned.id)!.state).toBe('active');
    expect(store.activity.map((a) => a.action)).not.toContain('context_doc.archived');
  });

  it('the gate is SCOPE-specific: an org:member archives a strategy-scope doc; an org:admin archives a client-scope doc', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const strategyDoc = (await svc.upload(T, MEMBER, {
      content: makeContent(),
      scopeRef: STRATEGY_ID,
    })) as Rec;
    const clientDoc = (await svc.upload(T, ADMIN, {
      content: makeContent({
        document_type: 'client_constraints',
        scope: 'client',
        client_id: `"${CLIENT_ID}"`,
        strategy_id: 'null',
      }),
      clientId: CLIENT_ID,
    })) as Rec;

    expect(((await svc.archive(T, MEMBER, strategyDoc.id)) as Rec).state).toBe('archived');
    expect(((await svc.archive(T, ADMIN, clientDoc.id)) as Rec).state).toBe('archived');
  });

  it("archival marks the document's ACTIVE facts stale in the same tx (symmetry with supersession) — other facts untouched", async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const doc = (await svc.upload(T, ADMIN, {
      content: makeContent(),
      scopeRef: STRATEGY_ID,
    })) as Rec;
    // The Steward extracted facts from this doc (one active, one already
    // rejected) plus an unrelated doc's fact that must not be touched.
    store.facts.set('fact-1', { id: 'fact-1', documentId: doc.id, state: 'active' });
    store.facts.set('fact-2', { id: 'fact-2', documentId: doc.id, state: 'rejected' });
    store.facts.set('fact-3', { id: 'fact-3', documentId: 'doc-other', state: 'active' });

    await svc.archive(T, ADMIN, doc.id);

    // An archived doc cannot be re-extracted (extract 409s on non-active), so
    // its facts MUST leave 'active' here or they ground drafts forever.
    expect(store.facts.get('fact-1')!.state).toBe('stale');
    expect(store.facts.get('fact-2')!.state).toBe('rejected');
    expect(store.facts.get('fact-3')!.state).toBe('active');
  });

  it('a superseded doc is retained history — archive 409s and points at the active doc', async () => {
    const store = makeStore();
    const { svc } = makeService(store);
    const v1 = (await svc.upload(T, ADMIN, {
      content: makeContent({}, '# Strategy brief\n\nV1.'),
      scopeRef: STRATEGY_ID,
    })) as Rec;
    await svc.upload(T, ADMIN, {
      content: makeContent({}, '# Strategy brief\n\nV2.'),
      scopeRef: STRATEGY_ID,
    });

    const err = await svc.archive(T, ADMIN, v1.id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/retained history/);
    expect(store.docs.get(v1.id)!.state).toBe('superseded');
  });
});
