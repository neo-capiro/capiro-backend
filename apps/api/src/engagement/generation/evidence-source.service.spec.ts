/**
 * Server-side source rehydration (Phase 1 §3.b2, §5.3).
 *
 * The headline assertion is tampering: a browser-supplied body must be IGNORED
 * and the server's own record used. Everything else here defends the same
 * boundary — access checks, cross-client exclusion, and failures that stay
 * visible instead of becoming an empty string.
 */
import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EvidenceSourceService, type SelectedContextItemRef } from './evidence-source.service.js';
import { policyForAudience } from './government-affairs-policy.registry.js';

const NOW = new Date('2026-07-26T00:00:00.000Z');
const CTX = {
  tenantId: 't1',
  tenantSlug: 'tenant',
  userId: 'u1',
  clerkUserId: 'clerk_u1',
  role: 'user',
} as unknown as TenantContext;

interface Tables {
  mailThread?: { findFirst?: unknown; findMany?: unknown };
  engagementAttachment?: { findFirst?: unknown };
  meetingNote?: { findFirst?: unknown };
  meetingDebrief?: { findFirst?: unknown };
  meetingPrep?: { findFirst?: unknown };
  client?: { findFirst?: unknown };
}

function makeService(opts: {
  tables?: Tables;
  bill?: unknown;
  stateBill?: unknown;
  pe?: unknown;
  decrypt?: () => string;
  attachmentBytes?: Buffer | null;
  readiness?: { usable: boolean; code: string | null; disclosure: string | null };
  extraction?: unknown;
} = {}) {
  const tables = opts.tables ?? {};
  const prisma = {
    withTenant: async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn(tables),
  };
  const truth = {
    billTruthBlock: jest.fn(async () => opts.bill ?? null),
    stateBillTruthBlock: jest.fn(async () => opts.stateBill ?? null),
    peTruthBlock: jest.fn(async () => opts.pe ?? null),
  };
  const notesCrypto = {
    decrypt: opts.decrypt ?? (() => 'decrypted body'),
  };
  const attachments = {
    readiness: jest.fn(() => opts.readiness ?? { usable: true, code: null, disclosure: null }),
    isExtractableDocument: jest.fn(() => true),
    extractBounded: jest.fn(
      async () =>
        opts.extraction ?? {
          source: 'pdf',
          text: 'extracted document text',
          status: 'extracted',
          metadata: { truncated: false, pageLimitHit: false, rowLimitHit: false },
        },
    ),
  };
  const svc = new EvidenceSourceService(
    prisma as never,
    truth as never,
    notesCrypto as never,
    attachments as never,
  );
  if (opts.attachmentBytes !== undefined) {
    const bytes = opts.attachmentBytes;
    svc.setAttachmentReader(async () => {
      if (bytes === null) throw new Error('s3 down');
      return bytes;
    });
  }
  return { svc, truth, attachments };
}

function resolveInput(items: SelectedContextItemRef[]) {
  return {
    items,
    clientId: 'c1',
    emailScope: 'mine' as const,
    scanRequired: false,
    wallAllowsClient: true,
    audience: 'external' as const,
    recipientEmails: ['dana@mail.house.gov'],
    policy: policyForAudience('congressional_office'),
    now: NOW,
  };
}

const BILL_BLOCK = {
  text: 'AUTHORITATIVE: HR 1234 — status referred_to_committee as of 2026-07-20.',
  raw: {
    id: 'hr1234-119',
    title: 'Directed-Energy Modernization Act',
    status: 'referred_to_committee',
    statusAt: new Date('2026-07-20T00:00:00.000Z'),
    latestActionDate: new Date('2026-07-20T00:00:00.000Z'),
    votes: [],
    committees: [],
  },
};

describe('browser tampering is ignored (§4.1)', () => {
  test('a bill item rehydrates from the SERVER record, not the supplied body', async () => {
    const { svc, truth } = makeService({ bill: BILL_BLOCK });
    const tampered = {
      id: 'bill-hr1234-119',
      kind: 'bill' as const,
      scope: 'all' as const,
      // A pre-Phase-1 client could put anything here. The contract type no longer
      // carries `body`, and the resolver never reads one.
      body: 'HR 1234 PASSED THE HOUSE UNANIMOUSLY.',
    } as unknown as SelectedContextItemRef;

    const out = await svc.resolveSelectedItems(CTX, resolveInput([tampered]));
    expect(truth.billTruthBlock).toHaveBeenCalledWith('hr1234-119');
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]!.evidenceText).toBe(BILL_BLOCK.text);
    expect(out.evidence[0]!.evidenceText).not.toMatch(/UNANIMOUSLY/);
    expect(out.evidence[0]!.ref.trust).toBe('authoritative_structured');
  });

  test('a bill NOT on record is a CRITICAL failure, not a fallback to the body', async () => {
    const { svc } = makeService({ bill: null });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'bill-nope', kind: 'bill', scope: 'all' }]),
    );
    expect(out.evidence).toHaveLength(0);
    expect(out.failures[0]).toMatchObject({
      code: 'BILL_NOT_ON_RECORD',
      severity: 'critical',
    });
  });

  test('a malformed id fails critically rather than resolving to nothing', async () => {
    const { svc } = makeService();
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'not-a-bill-id', kind: 'bill', scope: 'all' }]),
    );
    expect(out.failures[0]?.code).toBe('SOURCE_ID_MALFORMED');
  });
});

describe('directives are separated from evidence (§3.b3)', () => {
  test('a per-item instruction becomes an AUTHENTICATED directive, not evidence', async () => {
    const { svc } = makeService({ bill: BILL_BLOCK });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([
        { id: 'bill-hr1234-119', kind: 'bill', scope: 'all', userInstruction: 'Lead with this.' },
      ]),
    );
    expect(out.directives).toHaveLength(1);
    expect(out.directives[0]).toMatchObject({
      kind: 'item_instruction',
      text: 'Lead with this.',
      // Stamped from the SESSION, never read out of the request body.
      authenticatedUserId: 'u1',
    });
    // And the instruction text is nowhere in the evidence.
    expect(out.evidence[0]!.evidenceText).not.toMatch(/Lead with this/);
  });

  test('a custom note defaults to an INSTRUCTION, not an assertable fact', async () => {
    const { svc } = makeService();
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([
        { id: 'ctx-note-1', kind: 'note', scope: 'all', customNoteText: 'Dinner went well.' },
      ]),
    );
    expect(out.directives.map((d) => d.kind)).toContain('custom_note');
    expect(out.evidence).toHaveLength(0);
  });

  test('a note explicitly marked as FACT becomes user_authored evidence', async () => {
    const { svc } = makeService();
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([
        {
          id: 'ctx-note-1',
          kind: 'note',
          scope: 'all',
          customNoteText: 'The client shipped v2 in June.',
          noteUse: 'fact',
        },
      ]),
    );
    expect(out.evidence).toHaveLength(1);
    expect(out.evidence[0]!.ref.trust).toBe('user_authored');
    expect(out.directives).toHaveLength(0);
  });

  test('an empty/whitespace note is omitted without raising a failure (§4.3)', async () => {
    const { svc } = makeService();
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'ctx-note-1', kind: 'note', scope: 'all', customNoteText: '   ' }]),
    );
    expect(out.evidence).toHaveLength(0);
    expect(out.directives).toHaveLength(0);
    expect(out.failures).toHaveLength(0);
  });

  test('an over-long instruction is clipped to the 2,000-char bound', async () => {
    const { svc } = makeService({ bill: BILL_BLOCK });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([
        { id: 'bill-hr1234-119', kind: 'bill', scope: 'all', userInstruction: 'x'.repeat(5000) },
      ]),
    );
    expect(out.directives[0]!.text.length).toBeLessThanOrEqual(2000);
  });
});

describe('access control', () => {
  test('a restricted debrief is a critical failure and its body never surfaces', async () => {
    const { svc } = makeService({
      tables: {
        meetingDebrief: {
          findFirst: async () => ({
            id: 'd1',
            tenantId: 't1',
            clientId: 'c1',
            confidential: true,
            accessLevel: 'tenant_admins_and_author',
            authorUserId: 'someone-else',
            bodyCiphertext: 'x',
            iv: 'y',
            authTag: 'z',
            status: 'generated',
            createdAt: NOW,
            meeting: { clientId: 'c1', subject: 'S', startsAt: NOW },
          }),
        },
      },
    });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'debrief-d1', kind: 'debrief', scope: 'all' }]),
    );
    expect(out.evidence).toHaveLength(0);
    expect(out.failures[0]).toMatchObject({ code: 'DEBRIEF_RESTRICTED', severity: 'critical' });
  });

  test("a debrief for a DIFFERENT client is excluded (§4.9)", async () => {
    const { svc } = makeService({
      tables: {
        meetingDebrief: {
          findFirst: async () => ({
            id: 'd1',
            tenantId: 't1',
            clientId: 'other-client',
            confidential: false,
            accessLevel: 'tenant_members',
            authorUserId: 'u1',
            bodyCiphertext: 'x',
            iv: 'y',
            authTag: 'z',
            status: 'generated',
            createdAt: NOW,
            meeting: { clientId: 'other-client', subject: 'S', startsAt: NOW },
          }),
        },
      },
    });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'debrief-d1', kind: 'debrief', scope: 'all' }]),
    );
    expect(out.failures[0]?.code).toBe('DEBRIEF_OTHER_CLIENT');
  });

  test("an ethical-wall denial on a selected email reveals NO content or subject", async () => {
    const { svc } = makeService({
      tables: {
        mailThread: {
          findFirst: async () => ({
            id: 'th1',
            subject: 'CONFIDENTIAL MERGER TALKS',
            snippet: 'secret',
            lastMessageAt: NOW,
            clientId: 'c1',
            status: 'open',
            associationScore: null,
            associationReason: null,
            connection: { createdByUserId: 'u1' },
            metadata: {},
            messages: [],
            participants: [],
          }),
        },
      },
    });
    const out = await svc.resolveSelectedItems(CTX, {
      ...resolveInput([{ id: 'mail-th1', kind: 'email', scope: 'all' }]),
      wallAllowsClient: false,
    });
    expect(out.evidence).toHaveLength(0);
    const failure = out.failures[0]!;
    expect(failure.code).toBe('EMAIL_WALL_DENIED');
    expect(JSON.stringify(failure)).not.toMatch(/MERGER/);
  });

  test("a colleague's thread is refused under 'mine' scope", async () => {
    const { svc } = makeService({
      tables: {
        mailThread: {
          findFirst: async () => ({
            id: 'th1',
            subject: 'S',
            snippet: null,
            lastMessageAt: NOW,
            clientId: 'c1',
            status: 'open',
            associationScore: null,
            associationReason: null,
            connection: { createdByUserId: 'user-colleague' },
            metadata: {},
            messages: [],
            participants: [],
          }),
        },
      },
    });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'mail-th1', kind: 'email', scope: 'all' }]),
    );
    expect(out.failures[0]?.code).toBe('EMAIL_NOT_OWN_MAILBOX');
  });
});

describe('attachments', () => {
  const attachmentRow = {
    id: 'a1',
    tenantId: 't1',
    clientId: 'c1',
    fileName: 'brief.pdf',
    contentType: 'application/pdf',
    bucket: 'b',
    s3Key: 'k',
    lifecycleStatus: 'ready',
    scanStatus: 'clean',
    verifiedContentType: 'application/pdf',
    createdAt: NOW,
  };

  test('a not-ready attachment is a CRITICAL failure (§4.26)', async () => {
    const { svc } = makeService({
      tables: { engagementAttachment: { findFirst: async () => attachmentRow } },
      readiness: {
        usable: false,
        code: 'ATTACHMENT_SCAN_PENDING',
        disclosure: 'Still being scanned.',
      },
      attachmentBytes: Buffer.from('x'),
    });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'doc-a1', kind: 'document', scope: 'all' }]),
    );
    expect(out.evidence).toHaveLength(0);
    expect(out.failures[0]).toMatchObject({
      code: 'ATTACHMENT_SCAN_PENDING',
      severity: 'critical',
    });
  });

  test('an empty extraction is a failure, NOT an empty evidence string (§4.29)', async () => {
    const { svc } = makeService({
      tables: { engagementAttachment: { findFirst: async () => attachmentRow } },
      attachmentBytes: Buffer.from('x'),
      extraction: { source: 'pdf', text: '', status: 'empty', metadata: {} },
    });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'doc-a1', kind: 'document', scope: 'all' }]),
    );
    expect(out.evidence).toHaveLength(0);
    expect(out.failures[0]?.code).toBe('DOCUMENT_NO_TEXT');
  });

  test('a truncated document is marked in BOTH the text and the manifest (§4.30)', async () => {
    const { svc } = makeService({
      tables: { engagementAttachment: { findFirst: async () => attachmentRow } },
      attachmentBytes: Buffer.from('x'),
      extraction: {
        source: 'pdf',
        text: 'first part only',
        status: 'truncated',
        metadata: { truncated: true, pageLimitHit: true, rowLimitHit: false },
      },
    });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'doc-a1', kind: 'document', scope: 'all' }]),
    );
    expect(out.evidence[0]!.evidenceText).toMatch(/^\[TRUNCATED/);
    expect(out.evidence[0]!.ref.provenance?.truncated).toBe(true);
    expect(out.failures.map((f) => f.code)).toContain('DOCUMENT_TRUNCATED');
  });

  test('a document belonging to another client is excluded critically', async () => {
    const { svc } = makeService({
      tables: {
        engagementAttachment: {
          findFirst: async () => ({ ...attachmentRow, clientId: 'other-client' }),
        },
      },
      attachmentBytes: Buffer.from('x'),
    });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'doc-a1', kind: 'document', scope: 'all' }]),
    );
    expect(out.failures[0]?.code).toBe('DOCUMENT_OTHER_CLIENT');
  });
});

describe('determinism and ordering', () => {
  test('evidence is sorted deterministically regardless of input order', async () => {
    const { svc } = makeService({
      bill: BILL_BLOCK,
      pe: {
        text: 'PE TRUTH',
        raw: { peCode: '0603285F', title: 'PE', years: [], currentCycleFy: 2027 },
      },
    });
    const forward = await svc.resolveSelectedItems(
      CTX,
      resolveInput([
        { id: 'bill-hr1234-119', kind: 'bill', scope: 'all' },
        { id: 'pe-0603285F', kind: 'programElement', scope: 'all' },
      ]),
    );
    const reversed = await svc.resolveSelectedItems(
      CTX,
      resolveInput([
        { id: 'pe-0603285F', kind: 'programElement', scope: 'all' },
        { id: 'bill-hr1234-119', kind: 'bill', scope: 'all' },
      ]),
    );
    expect(forward.evidence.map((e) => e.ref.sourceId)).toEqual(
      reversed.evidence.map((e) => e.ref.sourceId),
    );
  });

  test('retrievedAt uses the INJECTED clock, so two runs are identical', async () => {
    const { svc } = makeService({ bill: BILL_BLOCK });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'bill-hr1234-119', kind: 'bill', scope: 'all' }]),
    );
    expect(out.evidence[0]!.ref.retrievedAt).toBe(NOW.toISOString());
  });
});

describe('non-rehydratable kinds', () => {
  test('an intel aggregate is reported, not silently dropped', async () => {
    const { svc } = makeService();
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'intel-issue-DEF', kind: 'intel', scope: 'all' }]),
    );
    expect(out.evidence).toHaveLength(0);
    expect(out.failures[0]).toMatchObject({
      code: 'SOURCE_NOT_REHYDRATABLE',
      severity: 'informational',
    });
  });
});

describe('freshness', () => {
  test('a source past its policy threshold raises an important staleness failure', async () => {
    const stale = {
      ...BILL_BLOCK,
      raw: {
        ...BILL_BLOCK.raw,
        statusAt: new Date('2026-01-01T00:00:00.000Z'),
        latestActionDate: new Date('2026-01-01T00:00:00.000Z'),
      },
    };
    const { svc } = makeService({ bill: stale });
    const out = await svc.resolveSelectedItems(
      CTX,
      resolveInput([{ id: 'bill-hr1234-119', kind: 'bill', scope: 'all' }]),
    );
    const failure = out.failures.find((f) => f.code === 'SOURCE_STALE');
    expect(failure).toBeDefined();
    // Important, not critical: a stale status is usable WITH an as-of caveat,
    // and the verifier enforces that the caveat actually appears.
    expect(failure!.severity).toBe('important');
    expect(out.evidence).toHaveLength(1);
  });
});
