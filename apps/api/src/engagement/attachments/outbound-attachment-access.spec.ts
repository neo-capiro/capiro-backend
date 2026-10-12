import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { EngagementAttachment } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { EngagementService, type SendSingleMailInput } from '../engagement.service.js';
import { AttachmentContentService } from '../attachment-content.service.js';
import { assertHearingRecordDocumentAccess } from '../hearing-record-document-access.js';
import { ownMeetingWhere, ownMailMessageWhere } from '../engagement-access.helpers.js';
import { attachmentViewerWhere } from './attachment-viewer-access.js';

// Preserve the real send resolver, canonical parent predicates, renderer and
// readiness policy. Unrelated generation/provider services are never exercised.
jest.mock('../generation/generation-gateway.service.js', () => ({
  GenerationGatewayService: jest.fn(),
}));
jest.mock('../generation/outreach-truth.service.js', () => ({ OutreachTruthService: jest.fn() }));
jest.mock('../generation/evidence-source.service.js', () => ({ EvidenceSourceService: jest.fn() }));
jest.mock('../engagement-ai.service.js', () => ({ EngagementAiService: jest.fn() }));
jest.mock('../outreach-draft.service.js', () => ({ OutreachDraftService: jest.fn() }));
jest.mock('../../quality-telemetry/quality-telemetry-capture.service.js', () => ({
  QualityTelemetryCaptureService: jest.fn(),
}));
jest.mock('../../directory/directory.service.js', () => ({ DirectoryService: jest.fn() }));
jest.mock('../../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../../federal-spending/federal-spending.service.js', () => ({
  FederalSpendingService: jest.fn(),
}));
jest.mock('../client-association.service.js', () => ({ ClientAssociationService: jest.fn() }));
jest.mock('../mail-sender.service.js', () => ({
  EngagementMailSender: jest.fn(),
  sendProviderSlug: () => 'gmail',
}));
jest.mock('../../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('../generation/alert-packet-client.service.js', () => ({
  AlertPacketClientService: jest.fn(),
}));
jest.mock('../hearing-record-document-access.js', () => ({
  assertHearingRecordDocumentAccess: jest.fn().mockResolvedValue(undefined),
}));

const ctx: TenantContext = {
  tenantId: 'tenant-1',
  tenantSlug: 'test',
  userId: 'actor-1',
  clerkUserId: 'clerk-1',
  role: 'standard_user',
};
const bytes = Buffer.from('Synthetic attachment bytes');
const input: SendSingleMailInput = {
  clientId: 'client-1',
  to: [{ email: 'recipient@example.test' }],
  subject: 'Synthetic attachment review',
  bodyHtml: '<p>Reviewed synthetic source</p>',
  attachmentIds: ['attachment-1'],
};
function row(overrides: Partial<EngagementAttachment> = {}) {
  return {
    id: 'attachment-1',
    tenantId: ctx.tenantId,
    clientId: 'client-1',
    meetingId: null,
    mailMessageId: null,
    viewerMode: 'all',
    viewerUserIds: [] as string[],
    uploadedByUserId: 'other-actor',
    sourceEntityType: null,
    sourceEntityId: null,
    supersededByAttachmentId: null,
    fileName: 'Synthetic.txt',
    contentType: 'text/plain',
    byteSize: bytes.length,
    lifecycleStatus: 'ready',
    scanStatus: 'clean',
    verifiedContentType: null,
    s3Key: 'synthetic-key',
    ...overrides,
  };
}
function harness(rows = [row()]) {
  const tx = {
    engagementAttachment: {
      findMany: jest.fn().mockResolvedValue(rows),
      updateMany: jest.fn().mockResolvedValue({ count: rows.length }),
    },
    client: { findFirst: jest.fn().mockResolvedValue({ id: 'client-1' }) },
    meeting: { findFirst: jest.fn().mockResolvedValue({ id: 'meeting-1', clientId: 'client-1' }) },
    mailMessage: {
      findFirst: jest.fn().mockResolvedValue({ id: 'mail-1' }),
      upsert: jest.fn().mockResolvedValue({ id: 'sent-1' }),
    },
    mailThread: { upsert: jest.fn().mockResolvedValue({ id: 'thread-1' }) },
  };
  const readAttachmentBytes = jest.fn().mockResolvedValue(bytes);
  const sendMail = jest.fn().mockResolvedValue({
    ok: true,
    provider: 'gmail',
    providerMessageId: 'provider-1',
    providerConversationId: 'conversation-1',
  });
  const service = Object.create(EngagementService.prototype) as EngagementService;
  Object.assign(service, {
    prisma: {
      withTenant: jest.fn(async (_tenant: string, fn: (transaction: typeof tx) => unknown) =>
        fn(tx),
      ),
    },
    attachmentContent: new AttachmentContentService(),
    scanner: { scanRequired: false },
    readAttachmentBytes,
    mailSender: { sendMail },
    findCampaignSendConnection: jest
      .fn()
      .mockResolvedValue({ id: 'connection-1', provider: 'google_workspace' }),
    resolveSenderSignatureHtml: jest.fn().mockResolvedValue({
      signatureHtml: '',
      senderEmail: 'actor@example.test',
      senderFirstName: 'Actor',
    }),
  });
  return { service, tx, readAttachmentBytes, sendMail };
}
const hearingAccess = jest.mocked(assertHearingRecordDocumentAccess);
beforeEach(() => hearingAccess.mockReset().mockResolvedValue(undefined));

describe('outbound attachment viewer and current-version boundary', () => {
  it('shares the exact ordinary viewer predicate without an administrator bypass', () => {
    expect(attachmentViewerWhere(ctx.userId)).toEqual([
      { viewerMode: 'all' },
      { viewerMode: 'restricted', viewerUserIds: { has: ctx.userId } },
      { uploadedByUserId: ctx.userId },
    ]);
  });
  it('filters tenant, current version and ordinary viewers, and refuses an unresolved ID before bytes or provider', async () => {
    // Prisma excludes these rows through tenant/current-version/viewer filters.
    const h = harness([]);
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'ATTACHMENT_MISSING' }),
    });
    expect(h.tx.engagementAttachment.findMany).toHaveBeenCalledWith({
      where: {
        tenantId: ctx.tenantId,
        id: { in: input.attachmentIds },
        supersededByAttachmentId: null,
        OR: [
          { viewerMode: 'all' },
          { viewerMode: 'restricted', viewerUserIds: { has: ctx.userId } },
          { uploadedByUserId: ctx.userId },
        ],
      },
    });
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('does not bypass restricted viewer lookup for a tenant administrator', async () => {
    const h = harness([]);
    await expect(h.service.sendSingleMail({ ...ctx, role: 'user_admin' }, input)).rejects.toThrow();
    expect(h.tx.engagementAttachment.findMany.mock.calls[0]![0].where.OR).toEqual(
      attachmentViewerWhere(ctx.userId),
    );
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  const viewerCases: Array<{ label: string; fields: Partial<EngagementAttachment> }> = [
    { label: 'all-mode', fields: {} },
    { label: 'explicit viewer', fields: { viewerMode: 'restricted', viewerUserIds: [ctx.userId] } },
    {
      label: 'uploader',
      fields: { viewerMode: 'restricted', viewerUserIds: [], uploadedByUserId: ctx.userId },
    },
  ];
  it.each(viewerCases)(
    'preserves $label file delivery with the exact selected bytes',
    async ({ fields }) => {
      const h = harness([row(fields)]);
      await expect(h.service.sendSingleMail(ctx, input)).resolves.toMatchObject({
        ok: true,
        messageId: 'sent-1',
      });
      expect(h.readAttachmentBytes).toHaveBeenCalledTimes(1);
      expect(h.sendMail).toHaveBeenCalledWith(
        ctx,
        expect.anything(),
        expect.objectContaining({
          attachments: [
            {
              name: 'Synthetic.txt',
              contentType: 'text/plain',
              contentBytes: bytes.toString('base64'),
            },
          ],
        }),
      );
    },
  );
});
describe('whole-selection scope and parent preflight', () => {
  it.each([
    ['another client', [row({ clientId: 'client-2' })], ['attachment-1']],
    [
      'mixed clients',
      [row(), row({ id: 'attachment-2', clientId: 'client-2' })],
      ['attachment-1', 'attachment-2'],
    ],
  ] as const)('rejects %s before reading an earlier valid file', async (_label, rows, ids) => {
    const h = harness([...rows]);
    await expect(
      h.service.sendSingleMail(ctx, { ...input, attachmentIds: [...ids] }),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ error: 'ATTACHMENT_CLIENT_MISMATCH' }),
    });
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('requires every requested ID, even when an earlier file is authorized', async () => {
    const h = harness([row()]);
    await expect(
      h.service.sendSingleMail(ctx, { ...input, attachmentIds: ['attachment-1', 'attachment-2'] }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('preserves clientless library files while refusing a client file without compose client context', async () => {
    const unlinked = harness([row({ clientId: null })]);
    await expect(
      unlinked.service.sendSingleMail(ctx, { ...input, clientId: undefined }),
    ).resolves.toMatchObject({ ok: true });
    const wrong = harness([row()]);
    await expect(
      wrong.service.sendSingleMail(ctx, { ...input, clientId: undefined }),
    ).rejects.toThrow('different client');
    expect(wrong.readAttachmentBytes).not.toHaveBeenCalled();
    expect(wrong.sendMail).not.toHaveBeenCalled();
  });
  it('reuses own meeting access and refuses another owner before reading any file', async () => {
    const h = harness([row(), row({ id: 'attachment-2', meetingId: 'meeting-1' })]);
    h.tx.meeting.findFirst.mockResolvedValue(null);
    await expect(
      h.service.sendSingleMail(ctx, { ...input, attachmentIds: ['attachment-1', 'attachment-2'] }),
    ).rejects.toThrow('Meeting not found');
    expect(h.tx.meeting.findFirst).toHaveBeenCalledWith({
      where: { id: 'meeting-1', tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
      select: { id: true, clientId: true },
    });
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('preserves authorized own-meeting attachments', async () => {
    const h = harness([row({ meetingId: 'meeting-1' })]);
    await expect(h.service.sendSingleMail(ctx, input)).resolves.toMatchObject({ ok: true });
    expect(h.sendMail).toHaveBeenCalledTimes(1);
  });
  it('refuses a removed client parent before reading bytes or calling the provider', async () => {
    const h = harness();
    h.tx.client.findFirst.mockResolvedValue(null);
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toThrow('Client not found');
    expect(h.tx.client.findFirst).toHaveBeenCalledWith({
      where: { id: 'client-1', tenantId: ctx.tenantId },
      select: { id: true },
    });
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('preserves a selection of unlinked and current-client files under their existing permissions', async () => {
    const h = harness([row(), row({ id: 'attachment-2', clientId: null })]);
    await expect(
      h.service.sendSingleMail(ctx, { ...input, attachmentIds: ['attachment-1', 'attachment-2'] }),
    ).resolves.toMatchObject({ ok: true });
    expect(h.readAttachmentBytes).toHaveBeenCalledTimes(2);
    expect(h.sendMail.mock.calls[0]![2].attachments).toHaveLength(2);
  });
  it('reuses own mail access and refuses a foreign mailbox parent before bytes or provider', async () => {
    const h = harness([row({ mailMessageId: 'mail-1' })]);
    h.tx.mailMessage.findFirst.mockResolvedValue(null);
    await expect(h.service.sendSingleMail(ctx, input)).rejects.toThrow('Mail message not found');
    expect(h.tx.mailMessage.findFirst).toHaveBeenCalledWith({
      where: { id: 'mail-1', tenantId: ctx.tenantId, ...ownMailMessageWhere(ctx.userId) },
      select: { id: true },
    });
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('preserves attachments belonging to the caller’s own mailbox', async () => {
    const h = harness([row({ mailMessageId: 'mail-1' })]);
    await expect(h.service.sendSingleMail(ctx, input)).resolves.toMatchObject({ ok: true });
    expect(h.readAttachmentBytes).toHaveBeenCalledTimes(1);
    expect(h.sendMail).toHaveBeenCalledTimes(1);
  });
  it('checks readiness of a later file before reading any earlier bytes', async () => {
    const h = harness([
      row(),
      row({ id: 'attachment-2', lifecycleStatus: 'blocked', scanStatus: 'threat' }),
    ]);
    await expect(
      h.service.sendSingleMail(ctx, { ...input, attachmentIds: ['attachment-1', 'attachment-2'] }),
    ).rejects.toThrow();
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('rechecks hearing distribution authority for the entire selection before reading bytes', async () => {
    const record = row({
      id: 'attachment-2',
      sourceEntityType: 'hearing_record_brief',
      sourceEntityId: 'brief-1',
    });
    const h = harness([row(), record]);
    hearingAccess.mockImplementation(async (_prisma, _ctx, attachment) => {
      if (attachment.id === record.id)
        throw new ForbiddenException('RECORD_BRIEF_DOCUMENT_ACCESS_OR_VERSION_CHANGED');
    });
    await expect(
      h.service.sendSingleMail(ctx, { ...input, attachmentIds: ['attachment-1', record.id] }),
    ).rejects.toThrow('ACCESS_OR_VERSION_CHANGED');
    expect(hearingAccess).toHaveBeenLastCalledWith(expect.anything(), ctx, record, 'distribute');
    expect(h.readAttachmentBytes).not.toHaveBeenCalled();
    expect(h.sendMail).not.toHaveBeenCalled();
  });
  it('retains permitted hearing distribution through the existing authority check', async () => {
    const record = row({ sourceEntityType: 'hearing_record_brief', sourceEntityId: 'brief-1' });
    const h = harness([record]);
    await expect(h.service.sendSingleMail(ctx, input)).resolves.toMatchObject({ ok: true });
    expect(hearingAccess).toHaveBeenCalledWith(expect.anything(), ctx, record, 'distribute');
    expect(h.sendMail).toHaveBeenCalledTimes(1);
  });
});
