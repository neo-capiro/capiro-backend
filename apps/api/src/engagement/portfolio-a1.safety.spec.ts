jest.mock('@aws-sdk/client-s3', () => ({ S3Client: class {}, DeleteObjectCommand: class {}, GetObjectCommand: class {}, HeadObjectCommand: class {}, PutObjectCommand: class {} }), {virtual: true});
jest.mock('@aws-sdk/s3-presigned-post', () => ({ createPresignedPost: jest.fn() }), {virtual: true});
jest.mock('@aws-sdk/s3-request-presigner', () => ({ getSignedUrl: jest.fn() }), {virtual: true});
jest.mock('mammoth', () => ({}), {virtual: true});
jest.mock('./xlsx-extract.js', () => ({}));
jest.mock('./pptx-extract.js', () => ({}));
jest.mock('./meeting-prep-pdf.js', () => ({}));
jest.mock('../common/sanitize-signature.js', () => ({ sanitizeSignatureHtml: jest.fn() }));
jest.mock('./outreach-email-renderer.js', () => ({}));
// Unused constructor dependencies are inert; admission, projection and mutation code below is real.
jest.mock('../ai-credentials/ai-credential-resolver.service.js', () => ({ AiCredentialResolverService: class {} }));
jest.mock('./attachment-pdf-vision.js', () => ({ AttachmentPdfVisionReader: class {} }));
jest.mock('./generation/generation-gateway.service.js', () => ({ GenerationGatewayService: class {} }));
jest.mock('./generation/outreach-truth.service.js', () => ({ OutreachTruthService: class {} }));
jest.mock('./generation/evidence-source.service.js', () => ({ EvidenceSourceService: class {} }));
jest.mock('./attachment-content.service.js', () => ({ AttachmentContentService: class {} }));
jest.mock('./attachment-scanner.service.js', () => ({ AttachmentScannerService: class {} }));
jest.mock('./outreach-draft.service.js', () => ({ OutreachDraftService: class {} }));
jest.mock('../quality-telemetry/quality-telemetry-capture.service.js', () => ({ QualityTelemetryCaptureService: class {} }));
jest.mock('../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../directory/directory.service.js', () => ({ DirectoryService: class {} }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: class {} }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({ FederalSpendingService: class {} }));
jest.mock('./client-association.service.js', () => ({ ClientAssociationService: class {} }));
jest.mock('./engagement-ai.service.js', () => ({ EngagementAiService: class {} }));
jest.mock('./meeting-notes-crypto.service.js', () => ({ MeetingNotesCryptoService: class {} }));
jest.mock('./mail-sender.service.js', () => ({ EngagementMailSender: class {} }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: class {} }));
jest.mock('./generation/alert-packet-client.service.js', () => ({ AlertPacketClientService: class {} }));
jest.mock('@capiro/meriv2-core', () => ({ runAuditor: jest.fn() }), { virtual: true });
jest.mock('@nestjs/throttler', () => ({ Throttle: () => () => {} }), { virtual: true });
jest.mock('./meeting-prep-job.service.js', () => ({ MeetingPrepJobService: class {} }));
jest.mock('./outreach-job.service.js', () => ({ OutreachJobService: class {} }));
jest.mock('./notetaker/notetaker.service.js', () => ({ NotetakerService: class {} }));
jest.mock('./outreach-send-intent.service.js', () => ({ OutreachSendIntentService: class {} }));
jest.mock('./runtime/engagement-runtime-policy.service.js', () => ({ EngagementRuntimePolicyService: class {} }));
import { Test } from '@nestjs/testing';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EngagementController } from './engagement.controller.js';
import { MeetingPrepJobService } from './meeting-prep-job.service.js';
import { OutreachJobService } from './outreach-job.service.js';
import { NotetakerService } from './notetaker/notetaker.service.js';
import { OutreachDraftService } from './outreach-draft.service.js';
import { OutreachSendIntentService } from './outreach-send-intent.service.js';
import { EngagementRuntimePolicyService } from './runtime/engagement-runtime-policy.service.js';
import { EngagementService } from './engagement.service.js';
import { ClientActivityService } from '../clients/client-activity.service.js';
import type { TenantContext } from '@capiro/shared';

const ctx: TenantContext = { tenantId: 'tenant-1', userId: 'user-1', clerkUserId: 'clerk-1', tenantSlug: 'test', role: 'standard_user' };
const now = new Date('2026-10-21T12:00:00.000Z');
function fixture() {
  const state = { member: true, client: true, wall: true, owner: true, associated: true, role: 'standard_user', clientId: 'c1' as string | null };
  const row = { id: 'm1', tenantId: ctx.tenantId, clientId: 'c1', createdByUserId: ctx.userId, subject: 'Meeting', updatedAt: now, isInternal: false, associationReason: 'Automatic match', associationScore: 0.8, associationSignals: { automatic: true }, notes: [], debriefs: [], preps: [], attachments: [], sharedByUserId: null };
  const tx: any = {
    tenantMembership: { findFirst: jest.fn(async () => state.member ? { role: state.role } : null) },
    client: { findFirst: jest.fn(async () => state.client ? { id: 'c1', primaryContactEmail: null } : null) },
    clientPerson: { findMany: jest.fn(async () => []) },
    tenant: { findFirst: jest.fn(async () => ({ settings: {} })) },
    $queryRawUnsafe: jest.fn(async () => [{ allowed: state.wall }]),
    $queryRaw: jest.fn(async () => []),
    $executeRawUnsafe: jest.fn(async () => 0),
    meeting: {
      findFirst: jest.fn(async ({where}: any) => !state.owner || (where.tenantId && where.tenantId !== row.tenantId) || (where.OR && !where.OR.some((part: any) => part.createdByUserId === row.createdByUserId)) || (where.AND && !state.associated) ? null : { ...row, clientId: state.clientId }),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(async ({data}: any) => ({ ...row, clientId: state.clientId, ...data })),
    },
    meetingNote: { findMany: jest.fn(async () => []) },
    meetingDebrief: { findMany: jest.fn(async () => []) },
    user: { findMany: jest.fn(async () => []) },
    meetingBotSession: { findMany: jest.fn(async () => []) },
  };
  const prisma: any = { withTenant: async (_: string, fn: any) => fn(tx), withTenantUser: async (_: string, _user: string, fn: any) => fn(tx) };
  const service: any = Object.create(EngagementService.prototype);
  service.prisma = prisma;
  service.notesCrypto = { decrypt: jest.fn(() => 'private body') };
  service.clientKb = { indexAttachmentFireAndForget: jest.fn() };
  return { ctx, state, tx, prisma, service, row };
}

describe('A1 Portfolio authoritative boundaries', () => {
  it('reads the persisted debrief context after creation without echoing it in receipts or lists', async () => {
    const f = fixture();
    const generatedFrom = { version: 'd2-debrief-context-v1', boundTokens: 8000, totalTokens: 123,
      sourceTruncated: false, sections: [{ name: 'source', tokens: 123, state: 'kept' }] };
    let stored: any;
    f.service.notesCrypto.encrypt = () => ({ bodyCiphertext: 'encrypted', iv: 'iv', authTag: 'tag', keyVersion: 'v1' });
    f.tx.meetingDebrief.create = jest.fn(async ({ data }: any) => {
      stored = { id: 'd1', status: 'draft', createdAt: now, updatedAt: now,
        sharedAt: null, approvedAt: null, ...JSON.parse(JSON.stringify(data)) };
      return stored;
    });
    f.tx.meetingDebrief.findFirst = jest.fn(async () => stored);
    f.tx.meetingDebrief.findMany.mockImplementation(async () => [stored]);
    const created = await f.service.createMeetingDebrief(ctx, 'm1', {
      body: 'Synthetic source', generatedFrom, confidential: false,
    });
    expect(created).not.toHaveProperty('generatedFrom');
    expect(created).not.toHaveProperty('generatedFromJsonb');
    const readback = await f.service.getMeetingDebriefContext(ctx, 'm1', 'd1');
    expect(readback).toEqual({ id: 'd1', meetingId: 'm1', clientId: 'c1',
      revision: now.toISOString(), generatedFrom });
    expect(f.service.notesCrypto.decrypt).not.toHaveBeenCalled();
    const listed = (await f.service.listMeetingDebriefs(ctx, 'm1'))[0];
    expect(listed).not.toHaveProperty('generatedFrom');
    expect(listed).not.toHaveProperty('generatedFromJsonb');
  });

  it('verifies omitted-page positions and uses keyset reads for repeatable continuation', async () => {
    const f = fixture();
    f.service.decorateMeetings = jest.fn(async (_tx: unknown, _ctx: unknown, rows: unknown[]) => rows);
    const boundary = { id: 'omitted-boundary', startsAt: now };
    const continuationSkip = { count: 2,
      boundarySha256: createHash('sha256').update(JSON.stringify([boundary.id, now.toISOString()])).digest('hex') };
    f.tx.meeting.findMany.mockImplementation(async ({ select }: any) => select
      ? [{ id: 'omitted-first', startsAt: new Date(now.getTime() - 1000) }, boundary] : []);
    for (let attempt = 0; attempt < 2; attempt++) await f.service.listMeetings(ctx, { clientId: 'c1', limit: 2, continuationSkip });
    expect(f.tx.meeting.findMany).toHaveBeenCalledTimes(4);
    for (const index of [0, 2]) expect(f.tx.meeting.findMany.mock.calls[index][0]).toMatchObject({
      select: { id: true, startsAt: true }, take: 2,
    });
    for (const index of [1, 3]) {
      const query = f.tx.meeting.findMany.mock.calls[index][0];
      expect(query).not.toHaveProperty('skip');
      expect(query.where.AND[1]).toEqual({ OR: [
        { startsAt: { gt: now } }, { startsAt: now, id: { gt: boundary.id } },
      ] });
    }
    // Deletion/revocation can shorten the prefix; insertion/reordering or a
    // newly visible row can change its boundary without changing its length.
    for (const prefix of [
      [{ id: 'later-authorized', startsAt: now }],
      [{ id: 'newly-visible', startsAt: now }, { id: 'changed-boundary', startsAt: now }],
    ]) {
      f.tx.meeting.findMany.mockClear();
      f.tx.meeting.findMany.mockResolvedValue(prefix);
      await expect(f.service.listMeetings(ctx, { clientId: 'c1', limit: 2, continuationSkip })).rejects.toThrow('page changed');
      expect(f.tx.meeting.findMany).toHaveBeenCalledTimes(1);
    }
    for (const denied of ['wall', 'member', 'client'] as const) {
      const revoked = fixture(); revoked.state[denied] = false;
      await expect(revoked.service.listMeetings(ctx, { clientId: 'c1', limit: 2, continuationSkip })).rejects.toThrow('Meeting not found');
      expect(revoked.tx.meeting.findMany).not.toHaveBeenCalled();
    }
    for (const count of [0, -1, 1.5, 1001]) expect(() => f.service.listMeetings(ctx,
      { clientId: 'c1', continuationSkip: { ...continuationSkip, count } })).toThrow('continuation is invalid');
  });

  it('does not offset past an authorized row after a preceding row disappears during continuation', async () => {
    const f = fixture();
    f.service.decorateMeetings = jest.fn(async (_tx: unknown, _ctx: unknown, rows: unknown[]) => rows);
    const boundary = { id: 'omitted-boundary', startsAt: now };
    const available = { id: 'later-authorized', startsAt: new Date(now.getTime() + 1000) };
    const continuationSkip = { count: 1,
      boundarySha256: createHash('sha256').update(JSON.stringify([boundary.id, now.toISOString()])).digest('hex') };
    f.tx.meeting.findMany.mockImplementation(async (query: any) => {
      if (query.select) return [boundary];
      // The omitted row has now disappeared. An offset would lose available.
      const remaining = [available];
      if (query.skip) return remaining.slice(query.skip);
      const after = query.where.AND[1]?.OR[0]?.startsAt?.gt;
      return after ? remaining.filter(row => row.startsAt > after) : [];
    });
    await expect(f.service.listMeetings(ctx, { clientId: 'c1', limit: 2, continuationSkip })).resolves.toEqual([available]);
  });

  it('PF-10 denies hidden/archived/revoked client and removed membership before notes/debrief reads', async () => {
    for (const action of ['getMeeting', 'listMeetingNotes', 'listMeetingDebriefs'] as const) {
      for (const deny of ['wall', 'client', 'member', 'owner'] as const) {
        const f = fixture(); f.state[deny] = false;
        await assert.rejects(f.service[action](ctx, 'm1'), /Meeting not found/);
        expect(f.tx.meetingNote.findMany).not.toHaveBeenCalled();
        expect(f.tx.meetingDebrief.findMany).not.toHaveBeenCalled();
        expect(f.service.notesCrypto.decrypt).not.toHaveBeenCalled();
      }
      for (const foreign of [{ ...ctx, tenantId: 'foreign-tenant' }, { ...ctx, userId: 'foreign-owner' }]) {
        const foreignFixture = fixture();
        await assert.rejects(foreignFixture.service[action](foreign, 'm1'), /Meeting not found/);
        expect(foreignFixture.service.notesCrypto.decrypt).not.toHaveBeenCalled();
      }
      const f = fixture(); f.state.associated = false;
      await expect(f.service[action](ctx, 'm1', 'c2')).rejects.toThrow('Meeting not found');
      f.state.associated = true; f.state.clientId = null;
      await expect(f.service[action](ctx, 'm1')).resolves.toBeDefined();
    }
    for (const deny of ['member', 'client', 'wall'] as const) {
      const f = fixture(); f.state[deny] = false;
      await expect(f.service.listMeetings(ctx, { clientId: 'c1' })).rejects.toThrow('Meeting not found');
      expect(f.tx.meeting.findMany).not.toHaveBeenCalled();
    }
    for (const method of ['listMeetingLibrary', 'listSharedMeetingsForClient']) {
      for (const deny of ['member', 'client', 'wall'] as const) {
        const g = fixture(); g.state[deny] = false;
        await expect(g.service[method](ctx, method === 'listMeetingLibrary' ? { clientId: 'c1' } : 'c1')).rejects.toThrow('Meeting not found');
        expect(g.tx.meeting.count).not.toHaveBeenCalled();
        expect(g.tx.meeting.findMany).not.toHaveBeenCalled();
      }
    }
    // Real controller/decorators/role guard and HTTP serialization; only the
    // upstream authenticated context and transactional DB are fixture boundaries.
    const h = fixture();
    const module = await Test.createTestingModule({
      controllers: [EngagementController],
      providers: [{ provide: EngagementService, useValue: h.service }, ...[
        MeetingPrepJobService, OutreachJobService, NotetakerService, OutreachDraftService,
        OutreachSendIntentService, EngagementRuntimePolicyService,
      ].map((provide) => ({ provide, useValue: {} }))],
    }).compile();
    const app = module.createNestApplication();
    app.use((req: any, _res: any, next: any) => { req.tenantContext = ctx; next(); });
    await app.listen(0, '127.0.0.1');
    try {
      const base = await app.getUrl();
      for (const route of ['meetings/m1', 'meetings/m1/notes', 'meetings/m1/debriefs', 'meetings/library?clientId=c1']) {
        h.state.wall = false;
        const response = await fetch(`${base}/engagement/${route}`);
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ message: 'Meeting not found' });
      }
      h.state.wall = true; h.state.associated = false;
      for (const route of ['meetings/m1', 'meetings/m1/notes', 'meetings/m1/debriefs']) {
        const response = await fetch(`${base}/engagement/${route}?clientId=c2`);
        expect(response.status).toBe(404);
      }
      h.state.associated = true; h.state.clientId = null;
      expect((await fetch(`${base}/engagement/meetings/m1`)).status).toBe(200);
      expect(h.service.notesCrypto.decrypt).not.toHaveBeenCalled();
      expect(h.tx.meetingNote.findMany).not.toHaveBeenCalled();
    } finally { await app.close(); }
    const f = fixture(); await f.service.listMeetings(ctx, {});
    expect(f.tx.tenantMembership.findFirst).toHaveBeenCalledWith({ where: { tenantId: ctx.tenantId, userId: ctx.userId, status: 'active', user: { clerkUserId: ctx.clerkUserId } }, select: { role: true } });
    expect(f.tx.meeting.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: ctx.tenantId, OR: [{createdByUserId: ctx.userId}, {connection: {createdByUserId: ctx.userId}}] });
    expect(f.tx.meeting.findMany.mock.calls[0][0].where.AND).toContainEqual({ OR: [
      { clientId: null }, { client: { is: { tenantId: ctx.tenantId, status: { not: 'archived' }, OR: [
        { memoryWall: false }, { memoryAccessGrants: { some: { tenantId: ctx.tenantId, userId: ctx.userId } } },
      ] } } },
    ] });
  });

  it('PF-11 unchanged assignment preserves provenance; real changes require a current revision and wall', async () => {
    for (const internal of [false, true]) {
      const f = fixture(); f.state.clientId = internal ? null : 'c1'; f.row.isInternal = internal;
      const receipt = await f.service.updateMeeting(ctx, 'm1', { subject: 'Changed', clientId: f.state.clientId });
      assert.equal(f.tx.meeting.update.mock.calls.length, 1, 'unchanged assignment writes only ordinary meeting fields');
      expect(f.tx.meeting.update.mock.calls[0][0].data).not.toHaveProperty('associationReason');
      expect(receipt.associationReason).toBe('Automatic match');
      expect(receipt.associationScore).toBe(0.8);
      expect(receipt.isInternal).toBe(internal);
    }
    const f = fixture();
    await expect(f.service.updateMeeting(ctx, 'm1', { clientId: 'c2' })).rejects.toThrow('expectedRevision');
    await expect(f.service.updateMeeting(ctx, 'm1', { clientId: 'c2', expectedRevision: '2026-10-20T12:00:00.000Z' })).rejects.toThrow();
    f.state.wall = false;
    await expect(f.service.updateMeeting(ctx, 'm1', { clientId: 'c2', expectedRevision: now.toISOString() })).rejects.toThrow('Meeting not found');
    expect(f.tx.meeting.update).not.toHaveBeenCalled();
    const override = fixture();
    override.tx.clientAssociationOverride = { create: jest.fn() };
    await override.service.overrideAssociation(ctx, { entityType: 'meeting', entityId: 'm1', clientId: 'c1' });
    expect(override.tx.meeting.update).not.toHaveBeenCalled();
    expect(override.tx.clientAssociationOverride.create).not.toHaveBeenCalled();
    await expect(override.service.overrideAssociation(ctx, { entityType: 'meeting', entityId: 'm1', clientId: 'c2' })).rejects.toThrow('expectedRevision');
    await expect(override.service.overrideAssociation(ctx, { entityType: 'meeting', entityId: 'm1', internal: true, expectedRevision: '2026-10-20T00:00:00.000Z' })).rejects.toThrow();
    expect(override.tx.meeting.update).not.toHaveBeenCalled();
    const g = fixture();
    for (const model of ['meetingPrep', 'meetingNote', 'meetingDebrief', 'engagementAttachment', 'engagementTask', 'meetingBotSession']) {
      g.tx[model] = { updateMany: jest.fn(async () => ({count: 0})), findMany: jest.fn(async () => []) };
    }
    g.tx.clientAssociationOverride = { create: jest.fn(async () => ({})) };
    await g.service.updateMeeting(ctx, 'm1', { clientId: 'c2', expectedRevision: now.toISOString() });
    expect(g.tx.meeting.update).toHaveBeenCalledTimes(2);
    expect(g.tx.meeting.update.mock.calls[0][0].data).toMatchObject({ clientId: 'c2', associationScore: 1, isInternal: false });
    expect(g.tx.clientAssociationOverride.create).toHaveBeenCalledTimes(1);
  });

  it('PF-12 returns debrief lifecycle metadata and withholds actors after a role downgrade', async () => {
    for (const [type, suffix, model, list, key] of [
      ['note', 'Note', 'meetingNote', 'listMeetingNotes', 'notes'],
      ['debrief', 'Debrief', 'meetingDebrief', 'listMeetingDebriefs', 'debriefs'],
    ] as const) {
      const life = fixture();
      let stored: any;
      life.service.notesCrypto.encrypt = () => ({ bodyCiphertext: 'encrypted', iv: 'iv', authTag: 'tag', keyVersion: 'v1' });
      life.tx[model] = {
        create: jest.fn(async ({data}: any) => stored = { id: 'artifact-1', status: 'draft', createdAt: now, updatedAt: now, approvedAt: null, approvedByUserId: null, sharedAt: null, sharedByUserId: null, ...data }),
        update: jest.fn(async ({data}: any) => stored = { ...stored, ...data, updatedAt: new Date(stored.updatedAt.valueOf() + 1) }),
        findFirst: jest.fn(async ({where}: any) => where.sharedAt && !stored?.sharedAt ? null : stored),
        findMany: jest.fn(async () => stored ? [stored] : []),
      };
      for (const empty of ['meetingPrep', 'engagementAttachment', type === 'note' ? 'meetingDebrief' : 'meetingNote']) {
        life.tx[empty] = { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) };
      }
      const parent: any = { ...life.row, visibility: 'private', sharedAt: null };
      life.tx.meeting.findFirst.mockImplementation(async () => ({ ...parent, [key]: stored ? [stored] : [] }));
      life.tx.meeting.findMany.mockImplementation(async () => parent.visibility === 'shared' ? [{ ...parent, [key]: [stored] }] : []);
      life.tx.meeting.update.mockImplementation(async ({data}: any) => Object.assign(parent, data));
      const created = await life.service[`createMeeting${suffix}`](ctx, 'm1', { body: 'Private content' });
      expect(created).toMatchObject({ metadataVersion: 1, approvalKnown: true, sharingKnown: true, sharedAt: null });
      const approved = await life.service[`approveMeeting${suffix}`](ctx, 'm1', 'artifact-1');
      expect(approved.approvedAt).toBeInstanceOf(Date);
      expect(approved.approvedByUserId).toBe(ctx.userId);
      const shared = await life.service.shareArtifacts(ctx, 'm1', [{type, id: 'artifact-1'}]);
      expect(shared[key][0]).toMatchObject({ metadataVersion: 1, sharedByUserId: ctx.userId, sharingKnown: true });
      expect((await life.service[list](ctx, 'm1'))[0].sharedAt).toBeInstanceOf(Date);
      const library = await life.service.listSharedMeetingsForClient(ctx, 'c1');
      expect(library[0][key][0]).toMatchObject({ metadataVersion: 1, sharedByUserId: ctx.userId });
      await life.service.unshareArtifacts(ctx, 'm1', [{type, id: 'artifact-1'}]);
      expect((await life.service[list](ctx, 'm1'))[0]).toMatchObject({ sharedAt: null, sharedByUserId: null, sharingKnown: true });
      expect(await life.service.listSharedMeetingsForClient(ctx, 'c1')).toEqual([]);
    }
    const f = fixture();
    const artifact = { id: 'd1', meetingId: 'm1', clientId: 'c1', bodyCiphertext: 'encrypted', iv: 'iv', authTag: 'tag', confidential: true, accessLevel: 'tenant_admins_and_author', status: 'approved', authorUserId: 'someone-else', author: { id: 'someone-else' }, approvedAt: now, approvedByUserId: 'approver', sharedAt: now, sharedByUserId: 'sharer', createdAt: now, updatedAt: now };
    f.tx.meetingDebrief.findMany.mockResolvedValue([artifact]);
    f.state.role = 'user_admin';
    const [visible] = await f.service.listMeetingDebriefs(ctx, 'm1');
    expect(visible).toMatchObject({ metadataVersion: 1, approvedAt: now, approvedByUserId: 'approver', sharedAt: now, sharedByUserId: 'sharer', sharingKnown: true, approvalKnown: true, revision: now.toISOString() });
    expect(visible.capabilities.unshare).toBe(true);
    expect(visible).not.toHaveProperty('bodyCiphertext');
    f.state.role = 'standard_user';
    const [restricted] = await f.service.listMeetingDebriefs({ ...ctx, role: 'user_admin' }, 'm1');
    expect(restricted).toMatchObject({ body: null, restricted: true, authorUserId: null, author: null, approvedByUserId: null, sharedByUserId: null, sharingKnown: false });
    expect(restricted.capabilities).toEqual({ edit: false, approve: false, share: false, unshare: false });
  });

  it('PF-22 settles and reopens dated or undated commitments/requests only, preserving metadata', async () => {
    for (const kind of ['commitment', 'request', 'note', 'email']) {
      for (const dueAt of [null, now]) {
        const f = fixture();
        const existing = { id: 'a1', tenantId: ctx.tenantId, clientId: 'c1', kind, title: 'Title', dueAt, metadata: { opaque: 'preserve' } };
        f.tx.clientActivity = { findFirst: jest.fn(async () => existing), update: jest.fn(async ({data}: any) => ({ ...existing, ...data })) };
        const service = new ClientActivityService(f.prisma, f.service);
        for (const settled of [true, false]) {
          if (kind === 'commitment' || kind === 'request') {
            const receipt: any = await service.update(ctx, 'c1', 'a1', { settled });
            expect(Boolean(receipt.settledAt)).toBe(settled);
            expect(f.tx.clientActivity.update.mock.calls.at(-1)[0].data).not.toHaveProperty('metadata');
          } else {
            await expect(service.update(ctx, 'c1', 'a1', { settled })).rejects.toThrow('Only a commitment or request');
            expect(f.tx.clientActivity.update).not.toHaveBeenCalled();
          }
        }
      }
    }
  });
});
