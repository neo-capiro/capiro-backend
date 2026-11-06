import { describe, test, expect, jest } from '@jest/globals';
import { createHash, randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from '../engagement.service.js';
import { AttachmentContentService } from '../attachment-content.service.js';

const ctx: TenantContext = {
  tenantId: randomUUID(),
  userId: randomUUID(),
  clerkUserId: 'fixture-owner',
  tenantSlug: 'fixture',
  role: 'standard_user',
};
const clientId = randomUUID(),
  otherClientId = randomUUID(),
  prospectId = randomUUID();
const bytes = Buffer.from('Source fixture: the company makes navigation sensors.');
const digest = createHash('sha256').update(bytes).digest('hex');
type Row = Record<string, any>;
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, value]) => {
    if (key === 'OR') return (value as Row[]).some((part) => matches(row, part));
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if ('in' in value) return value.in.includes(row[key]);
      if ('has' in value) return Array.isArray(row[key]) && row[key].includes(value.has);
      throw new Error(`Unhandled predicate ${key}`);
    }
    return row[key] === value;
  });
}
function fixture(empty = false) {
  const attachmentId = randomUUID();
  const row: Row = {
    id: attachmentId,
    tenantId: ctx.tenantId,
    uploadedByUserId: ctx.userId,
    clientId: null,
    prospectId: null,
    meetingId: null,
    mailMessageId: null,
    source: 'profile_identity',
    viewerMode: 'restricted',
    viewerUserIds: [ctx.userId],
    lifecycleStatus: 'ready',
    supersededByAttachmentId: null,
    bucket: 'fixture-bucket',
    s3Key: `tenants/${ctx.tenantId}/engagement/private/${attachmentId}/company.txt`,
    fileName: 'company.txt',
    contentType: 'text/plain',
    verifiedContentType: 'text/plain',
    calculatedSha256: digest,
    indexSourceGeneration: 0,
    metadataRevision: 0,
    scanStatus: 'clean',
    sourceEntityType: null,
    sourceEntityId: null,
    folder: null,
  };
  const state = {
    rows: empty ? [] : [row],
    active: true,
    clerkUserId: ctx.clerkUserId,
    onProspectRead: undefined as (() => void) | undefined,
    role: ctx.role,
    clientAvailable: true,
    wallAllowed: true,
    prospectAvailable: true,
    prospectEnabled: true,
    afterRead: undefined as (() => void) | undefined,
    content: bytes,
  };
  const raw = async (sql: string) => {
    if (sql.includes('client_file_deletions')) return [{ present: false }];
    if (sql.includes('tenant_memberships'))
      return state.active &&
        (!sql.includes('SELECT tm.role') || state.clerkUserId === ctx.clerkUserId)
        ? [{ role: state.role, userId: ctx.userId, clerkUserId: state.clerkUserId }]
        : [];
    if (sql.includes('business_development_prospects')) {
      state.onProspectRead?.();
      return state.prospectAvailable
        ? [{ linkedClientId: null, status: 'active', dismissedAt: null }]
        : [];
    }
    if (sql.includes('SELECT settings_jsonb'))
      return [
        {
          settings: { clioFeatureFlags: { 'businessDevelopment.enabled': state.prospectEnabled } },
        },
      ];
    if (sql.includes(' AS allowed'))
      return [{ allowed: state.wallAllowed && state.clientAvailable }];
    if (sql.includes('FROM clients'))
      return state.clientAvailable
        ? [{ version: 1, primary: null, status: 'active', memoryWall: !state.wallAllowed }]
        : [];
    if (sql.includes('client_memory_access'))
      return state.wallAllowed ? [{ user_id: ctx.userId }] : [];
    return [{ id: attachmentId }];
  };
  const tx = {
    tenantMembership: {
      findFirst: jest.fn(async ({ where }: Row) =>
        state.active &&
        where.tenantId === ctx.tenantId &&
        where.userId === ctx.userId &&
        where.user.clerkUserId === state.clerkUserId
          ? { role: state.role }
          : null,
      ),
    },
    $queryRaw: jest.fn(async (query: any, ..._values: any[]) =>
      raw(Array.isArray(query) ? query.join('') : query.sql),
    ),
    $queryRawUnsafe: jest.fn(async (sql: string, ..._values: unknown[]) => raw(sql)),
    $executeRaw: jest.fn(async () => 1),
    engagementAttachment: {
      findFirst: jest.fn(async ({ where }: Row) => {
        const found = state.rows.find((entry) => matches(entry, where));
        return found ? structuredClone(found) : null;
      }),
      create: jest.fn(async ({ data }: Row) => {
        const created = { ...row, ...data, id: attachmentId };
        state.rows.push(created);
        return structuredClone(created);
      }),
      update: jest.fn(async ({ where, data }: Row) => {
        const existing = state.rows.find((entry) => entry.id === where.id)!;
        Object.assign(existing, data);
        return structuredClone(existing);
      }),
    },
  };
  const withTenant = jest.fn(
    async (tenant: string, work: (transaction: typeof tx) => Promise<unknown>) => {
      expect(tenant).toBe(ctx.tenantId);
      const snapshot = structuredClone(state.rows);
      try {
        return await work(tx);
      } catch (error) {
        state.rows = snapshot;
        throw error;
      }
    },
  );
  const prisma = {
    withTenant,
    withTenantUser: jest.fn(
      async (tenant: string, user: string, work: (transaction: typeof tx) => Promise<unknown>) => {
        expect(user).toBe(ctx.userId);
        return withTenant(tenant, work);
      },
    ),
  };
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const index = jest.fn(),
    paid = jest.fn(),
    vision = jest.fn(),
    record = jest.fn();
  const read = jest.fn(async () => {
    state.afterRead?.();
    return state.content;
  });
  Object.assign(service, {
    prisma,
    bucket: 'fixture-bucket',
    clientKb: { indexAttachmentFireAndForget: index },
    attachmentContent: new AttachmentContentService(),
    scanner: {
      scanRequired: false,
      getStatus: jest.fn(async () => 'clean'),
      providerName: 'fixture',
    },
    s3: { send: jest.fn(async () => ({ ContentLength: state.content.length })) },
    readAttachmentBytes: read,
    transcribeAttachmentWithOpenAi: paid,
    attachmentPdfVision: { read: vision },
    recordExtractionOutcome: record,
    logger: { warn: jest.fn() },
  });
  const confirm = {
    s3Key: row.s3Key,
    fileName: row.fileName,
    contentType: row.contentType,
    source: 'profile_identity',
  };
  return {
    service,
    state,
    row,
    tx,
    prisma,
    read,
    index,
    paid,
    vision,
    record,
    confirm,
    attachmentId,
  };
}

describe('private document-first identity upload owner', () => {
  test('binds the scanner verdict to the exact bytes verified during confirmation', async () => {
    const h = fixture(true);
    const saved = await h.service.confirmAttachment(ctx, h.confirm);
    expect((h.service as any).scanner.getStatus).toHaveBeenCalledWith('fixture-bucket', h.confirm.s3Key, digest);
    expect(saved.calculatedSha256).toBe(digest);
    expect(saved.lifecycleStatus).toBe('ready');
  });
  test('confirmation fixes uploader-private ACL even when extra client fields claim sharing', async () => {
    const h = fixture(true);
    const saved = await h.service.confirmAttachment(ctx, {
      ...h.confirm,
      viewerMode: 'all',
      viewerUserIds: [randomUUID()],
      uploadedByUserId: randomUUID(),
    } as never);
    expect(saved).toMatchObject({
      id: h.attachmentId,
      source: 'profile_identity',
      clientId: null,
      prospectId: null,
      uploadedByUserId: ctx.userId,
      viewerMode: 'restricted',
      viewerUserIds: [ctx.userId],
      calculatedSha256: digest,
      lifecycleStatus: 'ready',
    });
    expect((await h.service.confirmAttachment(ctx, h.confirm)).id).toBe(saved.id);
    expect(h.state.rows).toHaveLength(1);
    expect(h.index).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.create).toHaveBeenCalledTimes(1);
  });
  test.each(['clientId', 'prospectId', 'meetingId', 'mailMessageId'])(
    'identity confirmation rejects a preselected %s parent',
    async (field) => {
      const h = fixture(true);
      await expect(
        h.service.confirmAttachment(ctx, { ...h.confirm, [field]: randomUUID() }),
      ).rejects.toMatchObject({ status: 400 });
      expect(h.read).not.toHaveBeenCalled();
      expect(h.tx.engagementAttachment.create).not.toHaveBeenCalled();
    },
  );
  test('actor revocation during upload verification prevents confirmation', async () => {
    const h = fixture(true);
    h.state.afterRead = () => {
      h.state.active = false;
    };
    await expect(h.service.confirmAttachment(ctx, h.confirm)).rejects.toMatchObject({
      status: 403,
    });
    expect(h.tx.engagementAttachment.create).not.toHaveBeenCalled();
    expect(h.index).not.toHaveBeenCalled();
  });
  test('only the trusted owner can read an unlinked file through the provider-free extraction path', async () => {
    const h = fixture();
    await expect(
      h.service.extractAttachmentText(ctx, h.attachmentId, {
        readOnly: true,
        allowPaidExtraction: false,
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.read).not.toHaveBeenCalled();
    const result = await h.service.extractIdentityUploadText(ctx, h.attachmentId);
    expect(result).toMatchObject({
      attachmentId: h.attachmentId,
      fileName: 'company.txt',
      text: bytes.toString(),
      contentHash: digest,
    });
    expect(h.read).toHaveBeenCalledTimes(1);
    expect(h.paid).not.toHaveBeenCalled();
    expect(h.vision).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
    expect(h.tx.engagementAttachment.update).not.toHaveBeenCalled();
    expect(h.index).not.toHaveBeenCalled();
  });
  test.each([
    { uploadedByUserId: randomUUID() },
    { tenantId: randomUUID() },
    { viewerMode: 'all' },
    { viewerUserIds: [ctx.userId, randomUUID()] },
    { clientId },
    { prospectId },
    { lifecycleStatus: 'quarantined' },
    { supersededByAttachmentId: randomUUID() },
    { source: 'manual' },
    { calculatedSha256: null },
  ])(
    'refuses an identity source outside the current private uploader boundary: %p',
    async (change) => {
      const h = fixture();
      Object.assign(h.row, change);
      await expect(h.service.extractIdentityUploadText(ctx, h.attachmentId)).rejects.toMatchObject({
        status: 404,
      });
      expect(h.read).not.toHaveBeenCalled();
      expect(h.paid).not.toHaveBeenCalled();
    },
  );
  test.each([
    'revoked_actor',
    'withdrawn_source',
    'shared_source',
    'linked_source',
    'changed_revision',
    'changed_bytes',
  ])('rechecks %s after reading without returning extracted content', async (change) => {
    const h = fixture();
    h.state.afterRead = () => {
      if (change === 'revoked_actor') h.state.active = false;
      if (change === 'withdrawn_source') h.state.rows = [];
      if (change === 'shared_source') h.row.viewerMode = 'all';
      if (change === 'linked_source') h.row.clientId = clientId;
      if (change === 'changed_revision') h.row.indexSourceGeneration++;
      if (change === 'changed_bytes')
        h.state.content = Buffer.from('Different bytes under the same unmodified object metadata');
    };
    await expect(h.service.extractIdentityUploadText(ctx, h.attachmentId)).rejects.toMatchObject({
      status:
        change === 'revoked_actor'
          ? 403
          : change === 'changed_revision' || change === 'changed_bytes'
            ? 409
            : 404,
    });
    expect(h.paid).not.toHaveBeenCalled();
    expect(h.vision).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
  test('audio cannot reach paid transcription through the trusted read-only owner', async () => {
    const h = fixture();
    Object.assign(h.row, {
      fileName: 'source.mp3',
      contentType: 'audio/mpeg',
      verifiedContentType: 'audio/mpeg',
    });
    await expect(h.service.extractIdentityUploadText(ctx, h.attachmentId)).rejects.toMatchObject({
      status: 503,
    });
    expect(h.paid).not.toHaveBeenCalled();
    expect(h.vision).not.toHaveBeenCalled();
    expect(h.record).not.toHaveBeenCalled();
  });
  test('linking keeps the same uploaded object private and accepts exact-target replay', async () => {
    const h = fixture();
    const originalKey = h.row.s3Key;
    const first = await h.service.linkProfileIdentityUpload(ctx, h.attachmentId, { clientId });
    const replay = await h.service.linkProfileIdentityUpload(ctx, h.attachmentId, {
      clientId,
      shareWithProfile: false,
    });
    expect(first.id).toBe(h.attachmentId);
    expect(replay).toMatchObject({
      id: h.attachmentId,
      s3Key: originalKey,
      clientId,
      viewerMode: 'restricted',
      viewerUserIds: [ctx.userId],
    });
    expect(h.state.rows).toHaveLength(1);
    expect(h.tx.engagementAttachment.create).not.toHaveBeenCalled();
    expect(h.index).not.toHaveBeenCalled();
    await expect(
      h.service.linkProfileIdentityUpload(ctx, h.attachmentId, { clientId: otherClientId }),
    ).rejects.toMatchObject({ status: 409 });
    expect(h.state.rows[0]!.clientId).toBe(clientId);
    await expect(h.service.extractIdentityUploadText(ctx, h.attachmentId)).rejects.toMatchObject({
      status: 404,
    });
  });
  test('only an explicit true command shares with the selected current client', async () => {
    const h = fixture();
    const first = await h.service.linkProfileIdentityUpload(ctx, h.attachmentId, {
      clientId,
      shareWithProfile: true,
    });
    expect(first).toMatchObject({ clientId, viewerMode: 'all', viewerUserIds: [] });
    expect(h.index).toHaveBeenCalledWith(ctx.tenantId, h.attachmentId);
    const replay = await h.service.linkProfileIdentityUpload(ctx, h.attachmentId, { clientId });
    expect(replay).toMatchObject({ id: h.attachmentId, viewerMode: 'all', viewerUserIds: [] });
  });
  test.each([{ viewerMode: 'all' }, { viewerUserIds: [ctx.userId, randomUUID()] }])(
    'an unlinked broadened ACL cannot silently carry sharing into the selected profile: %p',
    async (change) => {
      const h = fixture();
      Object.assign(h.row, change);
      await expect(
        h.service.linkProfileIdentityUpload(ctx, h.attachmentId, { clientId }),
      ).rejects.toMatchObject({ status: 409 });
      expect(h.tx.engagementAttachment.update).not.toHaveBeenCalled();
      expect(h.index).not.toHaveBeenCalled();
    },
  );
  test.each(['actor', 'client', 'wall', 'uploader', 'source'])(
    'link refuses unavailable %s authority before filing or indexing',
    async (kind) => {
      const h = fixture();
      if (kind === 'actor') h.state.active = false;
      if (kind === 'client') h.state.clientAvailable = false;
      if (kind === 'wall') h.state.wallAllowed = false;
      if (kind === 'uploader') h.row.uploadedByUserId = randomUUID();
      if (kind === 'source') h.row.lifecycleStatus = 'deleted';
      await expect(
        h.service.linkProfileIdentityUpload(ctx, h.attachmentId, {
          clientId,
          shareWithProfile: true,
        }),
      ).rejects.toMatchObject({ status: kind === 'actor' ? 403 : 404 });
      expect(h.tx.engagementAttachment.update).not.toHaveBeenCalled();
      expect(h.index).not.toHaveBeenCalled();
    },
  );
  test('prospect linking uses current prospect scope and retains the original private file', async () => {
    const h = fixture();
    const saved = await h.service.linkProfileIdentityUpload(ctx, h.attachmentId, { prospectId });
    expect(saved).toMatchObject({
      id: h.attachmentId,
      clientId: null,
      prospectId,
      viewerMode: 'restricted',
    });
    expect(h.index).not.toHaveBeenCalled();
    h.state.prospectEnabled = false;
    await expect(
      h.service.linkProfileIdentityUpload(ctx, h.attachmentId, {
        prospectId,
        shareWithProfile: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(h.state.rows[0]!.viewerMode).toBe('restricted');
  });
  test.each([
    {},
    { clientId, prospectId },
    { clientId: 'bad' },
    { clientId, shareWithProfile: 'yes' },
    { clientId, unexpected: true },
  ])('malformed filing commands cannot mutate the source: %p', async (command) => {
    const h = fixture();
    await expect(
      h.service.linkProfileIdentityUpload(ctx, h.attachmentId, command),
    ).rejects.toMatchObject({ status: 400 });
    expect(h.tx.engagementAttachment.update).not.toHaveBeenCalled();
  });
});

test('prospect filing rejects a Core identity replaced while acquiring target scope', async () => {
  const h = fixture();
  h.state.onProspectRead = () => {
    h.state.clerkUserId = 'replacement-core-identity';
  };
  await expect(
    h.service.linkProfileIdentityUpload(ctx, h.attachmentId, { prospectId }),
  ).rejects.toMatchObject({ status: 403 });
  expect(h.tx.engagementAttachment.update).not.toHaveBeenCalled();
  expect(h.index).not.toHaveBeenCalled();
});
