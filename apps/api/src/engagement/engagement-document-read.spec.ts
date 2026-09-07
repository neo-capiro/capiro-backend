import { EngagementService } from './engagement.service.js';
import { AttachmentContentService } from './attachment-content.service.js';
import type { TenantContext } from '@capiro/shared';

// These injected generation/directory/mail services are outside the extraction
// path. Keep the real attachment reader, readiness rules and parsers below.
jest.mock('./generation/generation-gateway.service.js', () => ({
  GenerationGatewayService: jest.fn(),
}));
jest.mock('./generation/outreach-truth.service.js', () => ({ OutreachTruthService: jest.fn() }));
jest.mock('./generation/evidence-source.service.js', () => ({ EvidenceSourceService: jest.fn() }));
jest.mock('./engagement-ai.service.js', () => ({ EngagementAiService: jest.fn() }));
jest.mock('./outreach-draft.service.js', () => ({ OutreachDraftService: jest.fn() }));
jest.mock('../quality-telemetry/quality-telemetry-capture.service.js', () => ({
  QualityTelemetryCaptureService: jest.fn(),
}));
jest.mock('../directory/directory.service.js', () => ({ DirectoryService: jest.fn() }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({
  FederalSpendingService: jest.fn(),
}));
jest.mock('./client-association.service.js', () => ({ ClientAssociationService: jest.fn() }));
jest.mock('./mail-sender.service.js', () => ({ EngagementMailSender: jest.fn() }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('./generation/alert-packet-client.service.js', () => ({
  AlertPacketClientService: jest.fn(),
}));

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;

describe('canonical document extraction access', () => {
  function harness() {
    const findFirst = jest.fn();
    const service = Object.create(EngagementService.prototype) as EngagementService;
    const readAttachmentBytes = jest.fn().mockResolvedValue(Buffer.from('Evidence'));
    const validateAttachmentParents = jest.fn().mockResolvedValue(undefined);
    const updateMany = jest.fn().mockResolvedValue({ count: 1 });
    Object.assign(service, {
      bucket: 'assets',
      prisma: { withTenant: jest.fn(async (_tenant, fn) => fn({ engagementAttachment: { findFirst, updateMany } })) },
      attachmentContent: new AttachmentContentService(),
      scanner: { scanRequired: false },
      readAttachmentBytes,
      validateAttachmentParents,
    });
    return { service, findFirst, readAttachmentBytes, validateAttachmentParents, updateMany };
  }

  it('requires matching client, current file version and current viewer access in the byte-read lookup', async () => {
    const m = harness();
    m.findFirst.mockResolvedValue(null);
    await expect(
      m.service.extractAttachmentText(ctx, 'doc-1', { clientId: 'client-1', section: 1 }),
    ).rejects.toThrow('Attachment not found');
    expect(m.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'doc-1',
        tenantId: ctx.tenantId,
        clientId: 'client-1',
        supersededByAttachmentId: null,
        OR: [
          { viewerMode: 'all' },
          { viewerMode: 'restricted', viewerUserIds: { has: ctx.userId } },
          { uploadedByUserId: ctx.userId },
        ],
      },
    });
    expect(m.readAttachmentBytes).not.toHaveBeenCalled();
  });

  it('blocks known malware before extraction even when scanning is optional', async () => {
    const m = harness();
    m.findFirst.mockResolvedValue({
      id: 'doc-1',
      clientId: 'client-1',
      meetingId: null,
      fileName: 'Evidence.txt',
      contentType: 'text/plain',
      lifecycleStatus: 'active',
      scanStatus: 'threat',
      s3Key: 'file-key',
    });
    await expect(
      m.service.extractAttachmentText(ctx, 'doc-1', { clientId: 'client-1', section: 1 }),
    ).rejects.toThrow();
    expect(m.readAttachmentBytes).not.toHaveBeenCalled();
  });

  it('preserves scan disclosure and server byte hash in an authorized section result', async () => {
    const m = harness();
    m.findFirst.mockResolvedValue({
      id: 'doc-1',
      clientId: 'client-1',
      meetingId: null,
      fileName: 'Evidence.txt',
      contentType: 'text/plain',
      lifecycleStatus: 'active',
      scanStatus: null,
      s3Key: 'file-key',
    });
    const result = await m.service.extractAttachmentText(ctx, 'doc-1', {
      clientId: 'client-1',
      section: 1,
    });
    expect(result).toMatchObject({
      text: 'Evidence',
      section: 1,
      sectionCount: 1,
      truncated: false,
      disclosure: expect.any(String),
      contentHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(m.validateAttachmentParents).toHaveBeenCalledWith(ctx, {
      clientId: 'client-1',
      meetingId: undefined,
    });
    expect(m.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      extractionMetadata: expect.objectContaining({ lastSectionRead: expect.objectContaining({
        status: 'extracted', sectionRead: true, readability: expect.objectContaining({ status: 'text_readable', scope: 'section' }),
      }) }),
    }) }));
    expect(m.updateMany.mock.calls[0]![0].data.extractionStatus).toBeUndefined();
  });

  it('stops cancelled reads before file lookup and before starting extraction after byte download', async () => {
    const m = harness();
    const cancelled = new AbortController();
    cancelled.abort();
    await expect(
      m.service.extractAttachmentText(ctx, 'doc-1', { section: 1, signal: cancelled.signal }),
    ).rejects.toThrow();
    expect(m.findFirst).not.toHaveBeenCalled();

    const running = new AbortController();
    m.findFirst.mockResolvedValue({
      id: 'doc-1',
      clientId: 'client-1',
      meetingId: null,
      fileName: 'Evidence.txt',
      contentType: 'text/plain',
      lifecycleStatus: 'active',
      scanStatus: null,
      s3Key: 'file-key',
    });
    m.readAttachmentBytes.mockImplementation(async () => {
      running.abort();
      return Buffer.from('Evidence');
    });
    await expect(
      m.service.extractAttachmentText(ctx, 'doc-1', { section: 1, signal: running.signal }),
    ).rejects.toThrow();
    expect(m.readAttachmentBytes).toHaveBeenCalledWith('file-key', running.signal);
  });

  it('records a blank page separately without erasing the whole-file text index', async () => {
    const m = harness();
    m.findFirst.mockResolvedValue({
      id: 'doc-1', clientId: 'client-1', meetingId: null,
      fileName: 'Evidence.pdf', contentType: 'application/pdf', lifecycleStatus: 'active',
      scanStatus: null, s3Key: 'file-key', extractionStatus: 'extracted',
      extractionMetadata: { chars: 24000, indexedChunks: 6, contentScope: 'extractable_text_only' },
    });
    Object.assign(m.service, {
      attachmentContent: Object.assign(new AttachmentContentService(), {
        extractSection: jest.fn().mockResolvedValue({
          source: 'pdf', text: '', section: 22, sectionCount: 22, sectionKind: 'page', sectionLabel: 'Page 22',
        }),
      }),
      attachmentPdfVision: { read: jest.fn().mockResolvedValue({ text: '', readability: {
        status: 'no_readable_text', method: 'openai_pdf', scope: 'section', section: 22, sectionCount: 22, chars: 0,
      } }) },
    });
    const result = await m.service.extractAttachmentText(ctx, 'doc-1', { clientId: 'client-1', section: 22 });
    expect(result.text).toBe('');
    expect(m.updateMany).toHaveBeenLastCalledWith({ where: { id: 'doc-1', tenantId: ctx.tenantId }, data: {
      extractionMetadata: expect.objectContaining({
        chars: 24000, indexedChunks: 6, contentScope: 'extractable_text_only',
        lastSectionRead: expect.objectContaining({ status: 'empty', section: 22, emptySection: true }),
      }),
    } });
  });
});
