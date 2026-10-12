import { createHash } from 'node:crypto';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { EngagementService } from '../engagement.service.js';
import type { TenantContext } from '@capiro/shared';
jest.mock('@aws-sdk/s3-presigned-post', () => ({
  createPresignedPost: jest.fn(async () => ({ url: 'https://synthetic.invalid', fields: {} })),
}));
const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  role: 'standard_user',
} as TenantContext;
const prospectId = '33333333-3333-4333-8333-333333333333',
  requestId = '44444444-4444-4444-8444-444444444444';
const bytes = Buffer.from('Synthetic document');
const input = {
  prospectId,
  requestId,
  fileName: 'memo.txt',
  contentType: 'text/plain',
  contentLength: bytes.length,
  checksumSha256: createHash('sha256').update(bytes).digest('hex'),
};
function harness() {
  const intents: any[] = [];
  const rows: any[] = [];
  const state = {
    member: true,
    linkedClientId: null as string | null,
    wall: false,
    grant: false,
    failDelete: false,
  };
  function match(row: any, w: any): boolean {
    return Object.entries(w).every(([k, v]: [string, any]) => {
      if (k === 'OR')
        return (
          row.viewerMode === 'all' ||
          row.uploadedByUserId === ctx.userId ||
          (row.viewerMode === 'restricted' && row.viewerUserIds.includes(ctx.userId))
        );
      if (v && typeof v === 'object') {
        if (v.in) return v.in.includes(row[k]);
        if (v.notIn) return !v.notIn.includes(row[k]);
      }
      return (row[k] ?? null) === v;
    });
  }
  const tx = {
    $queryRawUnsafe: jest.fn(async (sql: string) => {
      if (sql.includes('FROM business_development_prospects'))
        return [{ linkedClientId: state.linkedClientId, status: 'active', dismissedAt: null }];
      if (sql.includes('FROM tenants'))
        return [{ settings: { clioFeatureFlags: { 'businessDevelopment.enabled': true } } }];
      if (sql.includes('FROM tenant_memberships'))
        return state.member ? [{ userId: ctx.userId, clerkUserId: 'user_actor' }] : [];
      if (sql.includes('set_config')) return [];
      if (sql.includes('SELECT status,memory_wall'))
        return [{ status: 'active', memoryWall: state.wall }];
      if (sql.includes('SELECT id FROM client_memory_access'))
        return state.grant ? [{ id: 'grant' }] : [];
      if (sql.includes('AS allowed')) return [{ allowed: !state.wall || state.grant }];
      throw Error(sql);
    }),
    $executeRaw: jest.fn(async () => 1),
    $queryRaw: jest.fn(async () => []),
    prospectAttachmentUploadIntent: {
      findFirst: jest.fn(async ({ where }: any) => intents.find((r) => match(r, where)) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const r = { ...data, confirmedAttachmentId: null };
        intents.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) =>
        Object.assign(
          intents.find((r) => r.id === where.id),
          data,
        ),
      ),
    },
    engagementAttachment: {
      findFirst: jest.fn(async ({ where }: any) => rows.find((r) => match(r, where)) ?? null),
      findMany: jest.fn(async ({ where }: any) => rows.filter((r) => match(r, where))),
      create: jest.fn(async ({ data }: any) => {
        const r = {
          ...data,
          id: '55555555-5555-4555-8555-555555555555',
          viewerMode: 'all',
          viewerUserIds: [],
          supersededByAttachmentId: null,
        };
        rows.push(r);
        return r;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const selected = rows.filter((r) => match(r, where));
        selected.forEach((r) => Object.assign(r, data));
        return { count: selected.length };
      }),
      delete: jest.fn(async ({ where }: any) => {
        const i = rows.findIndex((r) => r.id === where.id);
        return rows.splice(i, 1)[0];
      }),
    },
    user: { findMany: jest.fn(async () => []) },
  };
  const prisma = {
    withTenant: jest.fn(async (_t: any, fn: any) => fn(tx)),
    withTenantUser: jest.fn(async (_t: any, _u: any, fn: any) => fn(tx)),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, {
    prisma,
    bucket: 'synthetic-bucket',
    s3: {
      send: jest.fn(async (command: any) => {
        if (command.constructor.name === 'DeleteObjectCommand' && state.failDelete)
          throw Error('synthetic delete unavailable');
        return { ContentLength: bytes.length };
      }),
    },
    readAttachmentBytes: jest.fn(async () => bytes),
    attachmentContent: {
      sha256: (b: Buffer) => createHash('sha256').update(b).digest('hex'),
      detectContentType: () => 'text/plain',
      contentTypeConflicts: () => false,
      readiness: () => ({ usable: true }),
    },
    scanner: {
      getStatus: jest.fn(async () => 'clean'),
      scanRequired: true,
      providerName: 'synthetic',
    },
    clientKb: { indexAttachmentFireAndForget: jest.fn(), purgeFireAndForget: jest.fn() },
    logger: { warn: jest.fn(), error: jest.fn() },
    createAttachmentDownloadUrl: jest.fn(async () => 'synthetic-download'),
    createAttachmentPreviewUrl: jest.fn(async () => 'synthetic-preview'),
  });
  const upload = () => service.createAttachmentUploadUrl(ctx, input);
  const confirm = (key: string, patch: any = {}) =>
    service.confirmAttachment(ctx, { ...input, s3Key: key, ...patch });
  return { service, tx, state, intents, rows, upload, confirm, prisma };
}

describe('prospect attachment lifecycle (synthetic only)', () => {
  beforeEach(() => jest.clearAllMocks());
  it('commits an actor/origin-bound intent before signing exact checksum and length', async () => {
    const h = harness();
    const result = await h.upload();
    expect(h.intents).toHaveLength(1);
    expect(result.s3Key).toContain('/engagement/prospect-uploads/');
    expect(h.tx.prospectAttachmentUploadIntent.create.mock.invocationCallOrder[0]).toBeLessThan(
      (createPresignedPost as jest.Mock).mock.invocationCallOrder[0]!,
    );
    expect((createPresignedPost as jest.Mock).mock.calls[0][1]).toMatchObject({
      Fields: {
        'x-amz-checksum-algorithm': 'SHA256',
        'x-amz-checksum-sha256': Buffer.from(input.checksumSha256, 'hex').toString('base64'),
      },
      Conditions: expect.arrayContaining([['content-length-range', bytes.length, bytes.length]]),
    });
    expect((await h.upload()).s3Key).toBe(result.s3Key);
    expect(h.intents).toHaveLength(1);
  });
  it('treats UUID letter case as the same durable request and prospect', async () => {
    const h = harness();
    const canonical = {
      ...input,
      requestId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      prospectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const first = await h.service.createAttachmentUploadUrl(ctx, canonical);
    const replay = await h.service.createAttachmentUploadUrl(ctx, {
      ...canonical,
      requestId: canonical.requestId.toUpperCase(),
      prospectId: canonical.prospectId.toUpperCase(),
    });
    expect(replay.s3Key).toBe(first.s3Key);
    expect(h.intents).toHaveLength(1);
  });
  it.each([
    { fileName: 'other.txt' },
    { prospectId: '66666666-6666-4666-8666-666666666666' },
    { contentLength: 3 },
    { checksumSha256: 'a'.repeat(64) },
  ])('refuses changed presign request %p', async (patch) => {
    const h = harness();
    await h.upload();
    await expect(
      h.service.createAttachmentUploadUrl(ctx, { ...input, ...patch }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.intents).toHaveLength(1);
  });
  it.each([
    { requestId: undefined },
    { checksumSha256: undefined },
    { clientId: '77777777-7777-4777-8777-777777777777' },
  ])('rejects invalid canonical upload %p', async (patch) => {
    const h = harness();
    await expect(
      h.service.createAttachmentUploadUrl(ctx, { ...input, ...patch }),
    ).rejects.toMatchObject({ status: 400 });
    expect(createPresignedPost).not.toHaveBeenCalled();
  });
  it.each([
    { prospectId: undefined },
    { prospectId: '66666666-6666-4666-8666-666666666666' },
    { fileName: 'other.txt' },
    { checksumSha256: 'a'.repeat(64) },
    { source: 'email-compose' },
  ])('rejects relabelled confirmation before S3 %p', async (patch) => {
    const h = harness();
    const u = await h.upload();
    await expect(h.confirm(u.s3Key, patch)).rejects.toBeDefined();
    expect((h.service as any).s3.send).not.toHaveBeenCalled();
    expect(h.rows).toHaveLength(0);
  });
  it('confirms once, replays lost acknowledgement, and retains a deletion tombstone', async () => {
    const h = harness();
    const u = await h.upload();
    const first = await h.confirm(u.s3Key);
    const reads = (h.service as any).s3.send.mock.calls.length;
    expect(await h.confirm(u.s3Key)).toBe(first);
    expect((h.service as any).s3.send).toHaveBeenCalledTimes(reads);
    expect(h.rows).toHaveLength(1);
    expect(first).toMatchObject({
      prospectId,
      clientId: null,
      meetingId: null,
      mailMessageId: null,
      uploadedByUserId: ctx.userId,
      source: 'manual',
      scanStatus: 'clean',
    });
    await h.service.deleteAttachment(ctx, first.id);
    expect(h.rows).toHaveLength(0);
    expect(h.intents[0].confirmedAttachmentId).toBe(first.id);
    await expect(h.confirm(u.s3Key)).rejects.toMatchObject({
      response: { code: 'prospect_upload_consumed' },
    });
    expect(h.tx.engagementAttachment.create).toHaveBeenCalledTimes(1);
  });
  it('denies another actor using a known reserved key before S3', async () => {
    const h = harness();
    const u = await h.upload();
    await expect(
      h.service.confirmAttachment(
        { ...ctx, userId: '66666666-6666-4666-8666-666666666666' },
        { ...input, s3Key: u.s3Key },
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect((h.service as any).s3.send).not.toHaveBeenCalled();
  });
  it('rechecks conversion and client-wall revocation after scan before recording an attachment', async () => {
    const h = harness();
    const u = await h.upload();
    (h.service as any).scanner.getStatus.mockImplementation(async () => {
      h.state.linkedClientId = '77777777-7777-4777-8777-777777777777';
      h.state.wall = true;
      return 'clean';
    });
    await expect(h.confirm(u.s3Key)).rejects.toMatchObject({ status: 404 });
    expect(h.rows).toHaveLength(0);
    expect(h.intents[0].confirmedAttachmentId).toBeNull();
  });
  it('does not confirm changed bytes or an expired pending upload', async () => {
    const h = harness();
    const u = await h.upload();
    (h.service as any).readAttachmentBytes.mockResolvedValue(Buffer.from('changed'));
    await expect(h.confirm(u.s3Key)).rejects.toMatchObject({
      response: { code: 'prospect_upload_integrity_mismatch' },
    });
    expect(h.rows).toHaveLength(0);
    h.intents[0].expiresAt = new Date(0);
    await expect(h.confirm(u.s3Key)).rejects.toMatchObject({
      response: { code: 'prospect_upload_expired' },
    });
  });
  it('keeps prospect files out of generic libraries and all unsupported outbound bytes', async () => {
    const h = harness();
    const u = await h.upload();
    const row = await h.confirm(u.s3Key);
    (h.service as any).readAttachmentBytes.mockClear();
    expect(await h.service.listAttachments(ctx, { unlinked: true })).toEqual([]);
    await expect(
      (h.service as any).loadGraphAttachments(ctx, [row.id], null),
    ).rejects.toMatchObject({ response: { error: 'ATTACHMENT_MISSING' } });
    expect((h.service as any).readAttachmentBytes).not.toHaveBeenCalled();
  });
  it('selects only the canonical prospect and excludes legacy and other-prospect rows', async () => {
    const h = harness();
    const u = await h.upload();
    const row = await h.confirm(u.s3Key);
    h.rows.push({ ...row, id: 'other', prospectId: '66666666-6666-4666-8666-666666666666' });
    h.rows.push({ ...row, id: 'legacy', prospectId: null });
    expect((await h.service.listAttachments(ctx, { prospectId })).map((r: any) => r.id)).toEqual([
      row.id,
    ]);
    expect(
      (await h.service.listAttachments(ctx, { unlinked: true })).map((r: any) => r.id),
    ).toEqual(['legacy']);
  });
  it('checks the live viewer ACL and rechecks the wall after URL signing', async () => {
    const h = harness();
    const u = await h.upload();
    const row = await h.confirm(u.s3Key);
    row.viewerMode = 'restricted';
    row.uploadedByUserId = null;
    expect(await h.service.listAttachments(ctx, { prospectId })).toEqual([]);
    row.viewerUserIds = [ctx.userId];
    (h.service as any).createAttachmentPreviewUrl.mockImplementation(async () => {
      h.state.member = false;
      return 'not-returned';
    });
    await expect(h.service.listAttachments(ctx, { prospectId })).rejects.toMatchObject({
      status: 404,
    });
  });
  it('refuses mismatched supersession, including legacy-to-prospect rebinding', async () => {
    const h = harness();
    const u = await h.upload();
    const row = await h.confirm(u.s3Key);
    h.rows.push({ ...row, id: '66666666-6666-4666-8666-666666666666', prospectId: null });
    await expect(h.service.supersedeAttachment(ctx, row.id, h.rows[1].id)).rejects.toMatchObject({
      response: { code: 'PROSPECT_ATTACHMENT_ORIGIN_MISMATCH' },
    });
    await expect(h.service.supersedeAttachment(ctx, h.rows[1].id, row.id)).rejects.toMatchObject({
      status: 400,
    });
    expect(row.supersededByAttachmentId).toBeNull();
  });
  it('retains failed deletion state and blocks both downloads and confirm resurrection', async () => {
    const h = harness();
    const u = await h.upload();
    const row = await h.confirm(u.s3Key);
    h.state.failDelete = true;
    await expect(h.service.deleteAttachment(ctx, row.id)).rejects.toMatchObject({ status: 503 });
    expect(row.lifecycleStatus).toBe('delete_failed');
    await expect(h.confirm(u.s3Key)).rejects.toMatchObject({
      response: { code: 'prospect_upload_consumed' },
    });
    h.state.member = false;
    (h.service as any).s3.send.mockClear();
    await expect(h.service.deleteAttachment(ctx, row.id)).rejects.toMatchObject({ status: 404 });
    expect((h.service as any).s3.send).not.toHaveBeenCalled();
  });
});
