/**
 * Author tests for the bounded engagement-attachment version history
 * (MM-11 / WS-24 native file history, Core attachment slice).
 *
 * Synthetic rows only, no database and no provider: the real EngagementService
 * history path (chain reconstruction, canonical per-version authorization, cursor
 * binding and projection) runs against a mocked Prisma client, so every refusal
 * below is produced by production code.
 */
import { HttpException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement.service.js';
import {
  CLIENT_FILE_HISTORY_MAX_PAGE_SIZE,
  CLIENT_FILE_HISTORY_MAX_VERSIONS,
} from './client-file-history.js';

jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn(async () => ({ url: 'https://synthetic.invalid', fields: {} })),
}));

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ctx = { tenantId: id(1), userId: id(2), role: 'standard_user' } as TenantContext;
const otherTenant = id(3);
const otherUser = id(4);
const clientId = id(7);
const prospectId = id(9);
const mailMessageId = id(50);
const hash = (n: number) => String(n % 10).repeat(64);

type Row = {
  id: string;
  tenantId: string;
  clientId: string | null;
  prospectId: string | null;
  meetingId: string | null;
  mailMessageId: string | null;
  folder: string | null;
  fileName: string;
  contentType: string;
  byteSize: number;
  bucket: string;
  s3Key: string;
  source: string;
  sourceEntityType: string | null;
  sourceEntityId: string | null;
  sourceVersion: number | null;
  calculatedSha256: string | null;
  lifecycleStatus: string;
  scanStatus: string | null;
  uploadedByUserId: string | null;
  viewerMode: string;
  viewerUserIds: string[];
  supersededByAttachmentId: string | null;
  createdAt: Date;
};

function version(n: number, patch: Partial<Row> = {}): Row {
  return {
    id: id(100 + n),
    tenantId: ctx.tenantId,
    clientId,
    prospectId: null,
    meetingId: null,
    mailMessageId: null,
    folder: 'alert-memos',
    fileName: `memo-v${n}.docx`,
    contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    byteSize: 100 * n,
    bucket: 'synthetic-bucket',
    s3Key: `tenants/${ctx.tenantId}/engagement/client-files/memo-v${n}.docx`,
    source: 'generated',
    sourceEntityType: 'alert_memo',
    sourceEntityId: id(300 + n),
    sourceVersion: n,
    calculatedSha256: hash(n),
    lifecycleStatus: 'ready',
    scanStatus: 'clean',
    uploadedByUserId: ctx.userId,
    viewerMode: 'all',
    viewerUserIds: [],
    supersededByAttachmentId: null,
    createdAt: new Date(Date.UTC(2026, 0, n + 1)),
    ...patch,
  };
}

/** A real canonical chain: version 1 is the original, the last one is current. */
function chain(count: number, patch: (n: number) => Partial<Row> = () => ({})): Row[] {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return version(
      n,
      n === count ? patch(n) : { ...patch(n), supersededByAttachmentId: id(100 + n + 1) },
    );
  });
}

function match(row: Row, where: any): boolean {
  return Object.entries(where).every(([key, value]: [string, any]) => {
    if (key === 'OR') return (value as any[]).some((clause) => match(row, clause));
    if (value && typeof value === 'object' && 'has' in value)
      return Array.isArray(row[key as keyof Row]) && (row[key as keyof Row] as string[]).includes(value.has);
    return ((row[key as keyof Row] ?? null) as unknown) === value;
  });
}

function harness(rows: Row[]) {
  const state = {
    member: true,
    wallAllowed: true,
    mailVisible: true,
    mailThreadClientId: null as string | null,
    prospectScope: 'allowed' as 'allowed' | 'denied',
    /** Simulates a revocation that lands between the chain read and the release. */
    revokeAfterVisibilityChecks: null as number | null,
    visibilityChecks: 0,
  };
  const readiness = jest.fn((row: Row) =>
    row.lifecycleStatus === 'ready'
      ? { usable: true, disclosure: null }
      : { usable: false, code: 'ATTACHMENT_NOT_READY', disclosure: null },
  );
  const tx: any = {
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => []),
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('FROM business_development_prospects'))
        return state.prospectScope === 'allowed'
          ? [{ linkedClientId: null, status: 'active', dismissedAt: null }]
          : [];
      if (sql.includes('FROM tenants'))
        return [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true } } }];
      if (sql.includes('FROM tenant_memberships'))
        return [{ userId: ctx.userId, clerkUserId: 'synthetic-actor' }];
      if (sql.includes('set_config')) return [];
      if (sql.includes('AS allowed')) return [{ allowed: state.wallAllowed }];
      throw new Error(`unexpected SQL: ${sql}`);
    }),
    engagementAttachment: {
      findFirst: jest.fn(async (args: any) => {
        // The per-version current-access re-read is the only single-column select.
        if (args.select && Object.keys(args.select).length === 1 && args.select.id) {
          state.visibilityChecks += 1;
          if (
            state.revokeAfterVisibilityChecks !== null &&
            state.visibilityChecks > state.revokeAfterVisibilityChecks
          )
            return null;
        }
        return rows.find((row) => match(row, args.where)) ?? null;
      }),
      findMany: jest.fn(async (args: any) =>
        rows.filter((row) => match(row, args.where)).slice(0, args.take ?? rows.length),
      ),
      create: jest.fn(async () => {
        throw new Error('history must not create rows');
      }),
      update: jest.fn(async () => {
        throw new Error('history must not update rows');
      }),
      updateMany: jest.fn(async () => {
        throw new Error('history must not update rows');
      }),
      delete: jest.fn(async () => {
        throw new Error('history must not delete rows');
      }),
    },
    user: {
      findMany: jest.fn(async () => [
        { id: ctx.userId, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.test' },
      ]),
    },
    client: { findFirst: jest.fn(async () => ({ id: clientId })) },
    mailMessage: {
      findFirst: jest.fn(async () =>
        state.mailVisible
          ? { id: mailMessageId, thread: { clientId: state.mailThreadClientId } }
          : null,
      ),
    },
    tenantMembership: { findFirst: jest.fn(async () => (state.member ? { id: id(60) } : null)) },
  };
  const prisma = {
    withTenant: jest.fn(async (_tenantId: string, run: any) => run(tx)),
    withTenantUser: jest.fn(async (_tenantId: string, _userId: string, run: any) => run(tx)),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, {
    prisma,
    bucket: 'synthetic-bucket',
    s3: { send: jest.fn(async () => ({})) },
    readAttachmentBytes: jest.fn(async () => Buffer.from('synthetic bytes')),
    attachmentContent: {
      sha256: () => hash(1),
      readiness,
      detectContentType: () => null,
      contentTypeConflicts: () => false,
    },
    scanner: { getStatus: jest.fn(async () => 'clean'), scanRequired: true, providerName: 'synthetic' },
    clientKb: { indexAttachmentFireAndForget: jest.fn(), purgeFireAndForget: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn(), log: jest.fn() },
    createAttachmentDownloadUrl: jest.fn(async () => 'synthetic-download'),
    createAttachmentPreviewUrl: jest.fn(async () => 'synthetic-preview'),
  });
  return { service, tx, prisma, state, rows, readiness };
}

async function refusal(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpException)
      return { status: error.getStatus(), body: error.getResponse() as Record<string, unknown> };
    throw error;
  }
  throw new Error('expected the request to be refused');
}

const cursorPayload = (cursor: string) =>
  JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Record<string, unknown>;
const reencode = (payload: Record<string, unknown>) =>
  Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');

describe('engagement attachment version history (synthetic, read-only)', () => {
  it('reconstructs more than ten real chain rows across pages from an old anchor', async () => {
    const rows = chain(12);
    const h = harness(rows);
    // Anchored on an OLD version, not the head: the whole chain is still reconstructed.
    const anchor = rows[3].id;
    const first = await h.service.listAttachmentHistory(ctx, { attachmentId: anchor, pageSize: 5 });
    expect(first.versionCount).toBe(12);
    expect(first.offset).toBe(0);
    expect(first.hasMore).toBe(true);
    expect(first.originalId).toBe(rows[0].id);
    expect(first.headId).toBe(rows[11].id);
    expect(first.versions.map((v) => v.attachmentId)).toEqual(rows.slice(0, 5).map((r) => r.id));
    expect(first.versions[0]).toMatchObject({ versionIndex: 1, isOriginal: true, isCurrent: false });
    expect(first.versions[0].supersededByAttachmentId).toBe(rows[1].id);

    const second = await h.service.listAttachmentHistory(ctx, {
      attachmentId: anchor,
      cursor: first.nextCursor!,
      pageSize: 5,
    });
    const third = await h.service.listAttachmentHistory(ctx, {
      attachmentId: anchor,
      cursor: second.nextCursor!,
      pageSize: 5,
    });
    expect(second.offset).toBe(5);
    expect(second.hasMore).toBe(true);
    expect(third.offset).toBe(10);
    expect(third.hasMore).toBe(false);
    expect(third.nextCursor).toBeNull();
    expect([
      ...first.versions,
      ...second.versions,
      ...third.versions,
    ].map((v) => v.attachmentId)).toEqual(rows.map((r) => r.id));
    expect(third.versions[third.versions.length - 1]).toMatchObject({
      versionIndex: 12,
      isCurrent: true,
      supersededByAttachmentId: null,
      uploadedByName: 'Ada Lovelace',
    });

    // No process-local state: a fresh owner over the same durable rows rebuilds the
    // identical chain (the Core equivalent of surviving an owner restart), and an
    // anchor on the head reaches the same original.
    const restarted = await harness(rows).service.listAttachmentHistory(ctx, {
      attachmentId: rows[11].id,
      pageSize: 5,
    });
    expect(restarted.versions).toEqual(first.versions);
    expect(restarted.originalId).toBe(rows[0].id);
  });

  it('releases metadata only: no bytes, no signed read, no budget or model work, and no write', async () => {
    const rows = chain(3);
    const h = harness(rows);
    const page = await h.service.listAttachmentHistory(ctx, { attachmentId: rows[2].id });
    expect(page.versions.map((v) => v.attachmentId)).toEqual(rows.map((r) => r.id));
    expect(JSON.stringify(page)).not.toMatch(/s3Key|downloadUrl|previewUrl|bucket/);
    expect((h.service as any).readAttachmentBytes).not.toHaveBeenCalled();
    expect((h.service as any).createAttachmentDownloadUrl).not.toHaveBeenCalled();
    expect((h.service as any).createAttachmentPreviewUrl).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.create).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.update).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.updateMany).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.delete).not.toHaveBeenCalled();
    expect(h.prisma.withTenant.mock.calls.some((call: any[]) => call[2]?.readOnly === true)).toBe(
      true,
    );
  });

  it('preserves each superseded version exact id, digest and stored object identity', async () => {
    const rows = chain(4);
    const before = JSON.parse(JSON.stringify(rows));
    const h = harness(rows);
    const page = await h.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id });
    expect(page.versions.map((v) => [v.attachmentId, v.contentHash, v.byteSize, v.fileName])).toEqual(
      rows.map((r) => [r.id, r.calculatedSha256, r.byteSize, r.fileName]),
    );
    expect(page.versions.map((v) => v.isOriginal)).toEqual([true, false, false, false]);
    // The stored rows are untouched: same rows, same keys, same forward links.
    expect(JSON.parse(JSON.stringify(rows))).toEqual(before);
  });

  it('checks current access for every version before any metadata is assembled', async () => {
    // The middle version is hidden from this actor: no list, no partial chain, no metadata.
    const rows = chain(3);
    rows[1].viewerMode = 'restricted';
    rows[1].viewerUserIds = [otherUser];
    // Restricted means restricted for this actor too — the uploader keeps access by the
    // canonical predicate, so the hidden member must be somebody else's version.
    rows[1].uploadedByUserId = id(5);
    const h = harness(rows);
    const denied = await refusal(() =>
      h.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id }),
    );
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });
    expect(h.readiness).not.toHaveBeenCalled();
    expect(h.tx.user.findMany).not.toHaveBeenCalled();
  });

  it('refuses a version that belongs to another tenant', async () => {
    const rows = chain(2);
    rows[1].tenantId = otherTenant;
    const h = harness(rows);
    const denied = await refusal(() =>
      h.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id }),
    );
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });
    // An anchor outside the tenant is indistinguishable from an unknown id.
    const unknown = await refusal(() =>
      h.service.listAttachmentHistory(ctx, { attachmentId: id(999) }),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body).toMatchObject({ statusCode: 404, message: 'Attachment not found' });
  });

  it('withholds a chain whose mail version is no longer owned by the actor', async () => {
    const rows = chain(3, (n) =>
      n === 2
        ? { source: 'incoming_mail', mailMessageId, sourceEntityType: 'incoming_mail_file' }
        : {},
    );
    const deniedHarness = harness(rows);
    deniedHarness.state.mailVisible = false;
    const denied = await refusal(() =>
      deniedHarness.service.listAttachmentHistory(ctx, { attachmentId: rows[2].id }),
    );
    expect(denied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });

    const allowedHarness = harness(rows);
    const page = await allowedHarness.service.listAttachmentHistory(ctx, {
      attachmentId: rows[2].id,
    });
    // Each version keeps its own source; nothing is rewritten to the head's scope.
    expect(page.versions.map((v) => v.source)).toEqual([
      'generated',
      'incoming_mail',
      'generated',
    ]);
  });

  it('withholds a chain when the mail parent client is under a wall the actor cannot cross', async () => {
    const rows = chain(2, (n) =>
      n === 2
        ? { source: 'incoming_mail', mailMessageId, sourceEntityType: 'incoming_mail_file' }
        : {},
    );
    const h = harness(rows);
    h.state.mailThreadClientId = id(8);
    h.state.wallAllowed = false;
    const denied = await refusal(() =>
      h.service.listAttachmentHistory(ctx, { attachmentId: rows[1].id }),
    );
    expect(denied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });
  });

  it('releases a prospect chain through the canonical prospect scope owner', async () => {
    const rows = chain(3, () => ({ prospectId, clientId: null, source: 'manual' }));
    const allowed = harness(rows);
    const page = await allowed.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id });
    expect(page.versionCount).toBe(3);
    expect(page.versions.every((v) => v.source === 'manual')).toBe(true);

    const deniedHarness = harness(rows);
    deniedHarness.state.prospectScope = 'denied';
    const denied = await refusal(() =>
      deniedHarness.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id }),
    );
    expect(denied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });
  });

  it('refuses a revocation that lands between the chain read and the release', async () => {
    const rows = chain(3);
    const h = harness(rows);
    // Three members are authorized before the page is built; the release recheck then fails.
    h.state.revokeAfterVisibilityChecks = 3;
    const denied = await refusal(() =>
      h.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id, pageSize: 3 }),
    );
    expect(denied.status).toBe(404);
    expect(denied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });
    expect(h.readiness).not.toHaveBeenCalled();
  });

  it('refuses missing, cyclic and branched chains as honestly unavailable', async () => {
    const missing = chain(3);
    missing[1].supersededByAttachmentId = id(500); // successor row does not exist
    const missingDenied = await refusal(() =>
      harness(missing).service.listAttachmentHistory(ctx, { attachmentId: missing[0].id }),
    );
    expect(missingDenied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });

    const cyclic = chain(3);
    cyclic[2].supersededByAttachmentId = cyclic[1].id; // v3 -> v2 -> v3
    const cyclicDenied = await refusal(() =>
      harness(cyclic).service.listAttachmentHistory(ctx, { attachmentId: cyclic[0].id }),
    );
    expect(cyclicDenied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });

    // Two versions claim the same successor: a fork, refused from either end.
    const branched = [...chain(2), version(3, { supersededByAttachmentId: id(102) })];
    for (const anchor of [branched[0].id, branched[1].id]) {
      const branchedDenied = await refusal(() =>
        harness(branched).service.listAttachmentHistory(ctx, { attachmentId: anchor }),
      );
      expect(branchedDenied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });
    }
  });

  it('bounds the walk instead of scanning an unbounded history', async () => {
    const oversized = chain(CLIENT_FILE_HISTORY_MAX_VERSIONS + 5);
    const denied = await refusal(() =>
      harness(oversized).service.listAttachmentHistory(ctx, {
        attachmentId: oversized[oversized.length - 1].id,
      }),
    );
    expect(denied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_UNAVAILABLE' });
  });

  it('refuses stale, forged and re-scoped cursors and refuses before any read', async () => {
    const rows = chain(4);
    const h = harness(rows);
    const first = await h.service.listAttachmentHistory(ctx, {
      attachmentId: rows[0].id,
      pageSize: 2,
    });
    const good = first.nextCursor!;

    const garbage = await refusal(() =>
      h.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id, cursor: 'not-a-cursor', pageSize: 2 }),
    );
    expect(garbage.status).toBe(400);
    expect(garbage.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_CURSOR_INVALID' });

    const extraKey = cursorPayload(good);
    extraKey.scope = 'widened';
    const widened = await refusal(() =>
      h.service.listAttachmentHistory(ctx, {
        attachmentId: rows[0].id,
        cursor: reencode(extraKey),
        pageSize: 2,
      }),
    );
    expect(widened.status).toBe(400);
    expect(widened.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_CURSOR_INVALID' });

    const forged = cursorPayload(good);
    forged.digest = hash(9);
    const forgedDenied = await refusal(() =>
      h.service.listAttachmentHistory(ctx, {
        attachmentId: rows[0].id,
        cursor: reencode(forged),
        pageSize: 2,
      }),
    );
    expect(forgedDenied.status).toBe(409);
    expect(forgedDenied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_CURSOR_STALE' });

    const reanchoredDenied = await refusal(() =>
      h.service.listAttachmentHistory(ctx, { attachmentId: rows[1].id, cursor: good, pageSize: 2 }),
    );
    expect(reanchoredDenied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_CURSOR_STALE' });

    const resizedDenied = await refusal(() =>
      h.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id, cursor: good, pageSize: 3 }),
    );
    expect(resizedDenied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_CURSOR_STALE' });

    // The chain changed under the cursor: its head is no longer the one it was minted for.
    const minted = await h.service.listAttachmentHistory(ctx, {
      attachmentId: rows[0].id,
      pageSize: 2,
    });
    expect(minted.hasMore).toBe(true);
    rows[3].supersededByAttachmentId = id(700);
    rows.push(version(5, { id: id(700) }));
    const changed = await refusal(() =>
      h.service.listAttachmentHistory(ctx, {
        attachmentId: rows[0].id,
        cursor: minted.nextCursor!,
        pageSize: 2,
      }),
    );
    expect(changed.status).toBe(409);
    expect(changed.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_CURSOR_STALE' });
  });

  it('refuses an out-of-range page size before touching the store', async () => {
    const rows = chain(3);
    const h = harness(rows);
    for (const pageSize of [0, -1, 2.5, CLIENT_FILE_HISTORY_MAX_PAGE_SIZE + 1, Number('abc')]) {
      const denied = await refusal(() =>
        h.service.listAttachmentHistory(ctx, { attachmentId: rows[0].id, pageSize }),
      );
      expect(denied.status).toBe(400);
      expect(denied.body).toMatchObject({ error: 'CLIENT_FILE_HISTORY_PAGE_SIZE_INVALID' });
    }
    expect(h.tx.engagementAttachment.findFirst).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.findMany).not.toHaveBeenCalled();
  });

  it('reports readiness per version without turning history into a read grant', async () => {
    const rows = chain(2);
    rows[0].lifecycleStatus = 'quarantined';
    rows[0].scanStatus = 'pending';
    const h = harness(rows);
    const page = await h.service.listAttachmentHistory(ctx, { attachmentId: rows[1].id });
    expect(page.versions[0]).toMatchObject({ usable: false, blockedReason: 'ATTACHMENT_NOT_READY' });
    expect(page.versions[1]).toMatchObject({ usable: true });
    expect(page.versions[1].blockedReason).toBeUndefined();
  });
});
