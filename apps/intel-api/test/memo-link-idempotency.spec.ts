import { ActionItemService, expectedMemoFileName } from '../src/feed/action-item.service.js';

/**
 * P1-14 (Gate C e-8 cases 5-7). The alert↔memo-document link must be idempotent — the
 * composer now RETRIES it when the first write fails, so a retry that inserted a second
 * row would trade one bug for another. And documents already stranded by the old
 * swallow-the-failure behavior need a way back: `reconcileOrphanMemoLinks`, dry-run by
 * default, which never guesses.
 */

type Row = {
  id: string;
  tenantId: string;
  clientId: string;
  alertId: string;
  kind: string;
  documentAttachmentId: string | null;
  title: string | null;
  createdBy: string;
};

/**
 * In-memory intel_action_item + a raw-SQL stand-in for engagement_attachments (which
 * lives in apps/api's Prisma schema — intel-api has no model for it).
 */
function makePrisma(opts: { attachments?: Array<{ id: string; client_id: string | null; file_name: string }>; alerts?: Array<{ id: string; clientId: string; title: string; evidence: unknown }> } = {}) {
  const rows: Row[] = [];
  let seq = 0;
  const tx = {
    intelActionItem: {
      findFirst: async ({ where }: any) =>
        rows.find(
          (r) =>
            r.tenantId === where.tenantId &&
            (where.alertId === undefined || r.alertId === where.alertId) &&
            (where.kind === undefined || r.kind === where.kind),
        ) ?? null,
      findMany: async ({ where }: any) =>
        rows.filter(
          (r) =>
            r.tenantId === where.tenantId &&
            (where.kind === undefined || r.kind === where.kind) &&
            (where.documentAttachmentId?.not === undefined || r.documentAttachmentId !== null),
        ),
      updateMany: async ({ where, data }: any) => {
        const hits = rows.filter(
          (r) => r.tenantId === where.tenantId && r.alertId === where.alertId && r.kind === where.kind,
        );
        for (const h of hits) Object.assign(h, data);
        return { count: hits.length };
      },
      create: async ({ data }: any) => {
        const row: Row = { id: `ai-${++seq}`, ...data };
        rows.push(row);
        return row;
      },
    },
    intelAlert: {
      findMany: async () => opts.alerts ?? [],
    },
    $queryRaw: async () => opts.attachments ?? [],
  };
  const prisma = {
    withTenant: async (_t: string, cb: (t: unknown) => unknown) => cb(tx),
  } as never;
  return { prisma, rows };
}

describe('ActionItemService.recordMemo — idempotency (P1-14)', () => {
  // Case 5
  it('writing the same (alertId, attachmentId) twice keeps ONE row and updates it', async () => {
    const { prisma, rows } = makePrisma();
    const svc = new ActionItemService(prisma);

    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', { documentAttachmentId: 'att-1', title: 'Memo' });
    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', { documentAttachmentId: 'att-1', title: 'Memo' });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.documentAttachmentId).toBe('att-1');
  });

  // Case 6
  it('writing a DIFFERENT attachmentId keeps one row, holding the latest id', async () => {
    const { prisma, rows } = makePrisma();
    const svc = new ActionItemService(prisma);

    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', { documentAttachmentId: 'att-1', title: 'First' });
    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', { documentAttachmentId: 'att-2', title: 'Regenerated' });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.documentAttachmentId).toBe('att-2');
    expect(rows[0]!.title).toBe('Regenerated');
  });

  it('keeps separate rows for separate alerts', async () => {
    const { prisma, rows } = makePrisma();
    const svc = new ActionItemService(prisma);

    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', { documentAttachmentId: 'att-1' });
    await svc.recordMemo('t1', 'c1', 'alert-2', 'u1', { documentAttachmentId: 'att-2' });

    expect(rows).toHaveLength(2);
  });

  // Gate H a-5: content is persisted into the existing `text` column so a
  // saved memo can be read back without regenerating (RB-04's read path).
  it('persists content into the row', async () => {
    const { prisma, rows } = makePrisma();
    const svc = new ActionItemService(prisma);

    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', {
      documentAttachmentId: 'att-1',
      title: 'Memo',
      content: '# Client memo\n\nBody text.',
    });

    expect((rows[0] as any).text).toBe('# Client memo\n\nBody text.');
  });

  // The reconcile-orphan-memo-links backfill (and any other caller that never
  // had content to send) must NOT wipe a real saved memo's text — this is
  // exactly why recordMemo spreads `content` conditionally rather than
  // defaulting to null like documentAttachmentId/title do.
  it('a call that omits content leaves previously-saved content untouched', async () => {
    const { prisma, rows } = makePrisma();
    const svc = new ActionItemService(prisma);

    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', {
      documentAttachmentId: 'att-1',
      title: 'Memo',
      content: 'original saved content',
    });
    // A metadata-only update (e.g. a regenerate that replaces the attachment
    // id but the caller forgot to resend content, or the orphan-link backfill).
    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', {
      documentAttachmentId: 'att-2',
      title: 'Regenerated',
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]!.documentAttachmentId).toBe('att-2');
    expect((rows[0] as any).text).toBe('original saved content');
  });

  // An explicit empty-string content (e.g. clearing a memo) IS honored — only
  // `undefined` (the key never sent) is treated as "don't touch".
  it('an explicit empty-string content DOES overwrite (only undefined is "leave alone")', async () => {
    const { prisma, rows } = makePrisma();
    const svc = new ActionItemService(prisma);

    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', { documentAttachmentId: 'att-1', content: 'first' });
    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', { documentAttachmentId: 'att-1', content: '' });

    expect((rows[0] as any).text).toBe('');
  });
});

describe('ActionItemService.getMemo — round-trips saved content (Gate H a-5)', () => {
  it('returns the content recordMemo persisted, with no server change needed to getMemo itself', async () => {
    const { prisma } = makePrisma();
    const svc = new ActionItemService(prisma);
    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', {
      documentAttachmentId: 'att-1',
      title: 'Client memo — H.R. 8800',
      content: 'The full saved markdown.',
    });

    const got = await svc.getMemo('t1', 'alert-1');
    expect(got).toMatchObject({
      documentAttachmentId: 'att-1',
      title: 'Client memo — H.R. 8800',
      text: 'The full saved markdown.',
    });
  });

  it('returns null when no memo exists for the alert', async () => {
    const { prisma } = makePrisma();
    const svc = new ActionItemService(prisma);
    expect(await svc.getMemo('t1', 'no-such-alert')).toBeNull();
  });
});

describe('expectedMemoFileName — mirrors apps/api title precedence', () => {
  it('prefers the PE code, then the bill display number, then the hearing title, then the headline', () => {
    expect(
      expectedMemoFileName({
        title: 'ignored',
        evidence: { programElement: { peCode: '0603286F', title: 'Hypersonics Prototyping' } },
      }),
    ).toBe('Client memo — 0603286F — Hypersonics Prototyping.docx');
    expect(expectedMemoFileName({ title: 'ignored', evidence: { bill: { displayNum: 'H.R. 8800' } } })).toBe(
      'Client memo — H.R. 8800.docx',
    );
    // The FLAT writer shape (pre-normalization rows in the table today).
    expect(expectedMemoFileName({ title: 'ignored', evidence: { displayNum: 'S. 4000' } })).toBe(
      'Client memo — S. 4000.docx',
    );
    expect(
      expectedMemoFileName({ title: 'ignored', evidence: { hearing: { title: 'FY27 posture' } } }),
    ).toBe('Client memo — FY27 posture.docx');
    expect(expectedMemoFileName({ title: 'A bare headline', evidence: {} })).toBe(
      'Client memo — A bare headline.docx',
    );
  });

  it('applies the same filename sanitization apps/api applies', () => {
    // `/` and `:` are both in alert-memo.service.ts's /[\\/:*?"<>|]+/g class.
    expect(expectedMemoFileName({ title: 'H.R. 1/2: rule?', evidence: {} })).toBe(
      'Client memo — H.R. 1-2- rule-.docx',
    );
  });
});

describe('ActionItemService.reconcileOrphanMemoLinks (P1-14)', () => {
  const alerts = [
    { id: 'alert-1', clientId: 'c1', title: 'H.R. 8800: Rule granted', evidence: { bill: { displayNum: 'H.R. 8800' } } },
    { id: 'alert-2', clientId: 'c1', title: 'S. 4000: Passed Senate', evidence: { bill: { displayNum: 'S. 4000' } } },
    // Two alerts that would produce the SAME memo filename → ambiguous, never guessed.
    { id: 'alert-3', clientId: 'c1', title: 'Dup', evidence: { bill: { displayNum: 'H.R. 9999' } } },
    { id: 'alert-4', clientId: 'c1', title: 'Dup', evidence: { bill: { displayNum: 'H.R. 9999' } } },
  ];
  const attachments = [
    { id: 'att-1', client_id: 'c1', file_name: 'Client memo — H.R. 8800.docx' },
    { id: 'att-2', client_id: 'c1', file_name: 'Client memo — H.R. 9999.docx' },
    { id: 'att-3', client_id: 'c1', file_name: 'Client memo — Something Unmatchable.docx' },
  ];
  const logs: string[] = [];
  const log = (m: string) => logs.push(m);
  beforeEach(() => (logs.length = 0));

  // Case 7
  it('DRY RUN reports candidates and links ZERO', async () => {
    const { prisma, rows } = makePrisma({ attachments, alerts });
    const r = await new ActionItemService(prisma).reconcileOrphanMemoLinks('t1', { apply: false }, log);

    expect(r.candidates).toBe(3);
    expect(r.linked).toBe(0); // dry run writes nothing
    expect(r.ambiguous).toBe(2); // the duplicate-filename one + the unmatchable one
    expect(rows).toHaveLength(0);
    expect(logs.some((l) => l.startsWith('MATCH '))).toBe(true);
    expect(logs.some((l) => l.startsWith('AMBIGUOUS '))).toBe(true);
  });

  it('APPLY links only the unambiguous one and reports the ambiguous count', async () => {
    const { prisma, rows } = makePrisma({ attachments, alerts });
    const r = await new ActionItemService(prisma).reconcileOrphanMemoLinks('t1', { apply: true }, log);

    expect(r.candidates).toBe(3);
    expect(r.linked).toBe(1);
    expect(r.ambiguous).toBe(2);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.alertId).toBe('alert-1');
    expect(rows[0]!.documentAttachmentId).toBe('att-1');
  });

  it('treats an already-linked attachment as not a candidate', async () => {
    const { prisma } = makePrisma({ attachments, alerts });
    const svc = new ActionItemService(prisma);
    await svc.recordMemo('t1', 'c1', 'alert-1', 'u1', { documentAttachmentId: 'att-1' });

    const r = await svc.reconcileOrphanMemoLinks('t1', { apply: true }, log);

    expect(r.candidates).toBe(2); // att-1 is already linked
    expect(r.linked).toBe(0); // the remaining two are both ambiguous
  });

  it('is a no-op when the tenant has no intel_memo attachments', async () => {
    const { prisma, rows } = makePrisma({ attachments: [], alerts });
    const r = await new ActionItemService(prisma).reconcileOrphanMemoLinks('t1', { apply: true }, log);

    expect(r).toEqual({ candidates: 0, linked: 0, ambiguous: 0 });
    expect(rows).toHaveLength(0);
  });
});
