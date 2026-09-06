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
    Object.assign(service, {
      bucket: 'assets',
      prisma: { withTenant: jest.fn((_tenant, fn) => fn({ engagementAttachment: { findFirst } })) },
      attachmentContent: new AttachmentContentService(),
      scanner: { scanRequired: false },
      readAttachmentBytes,
      validateAttachmentParents,
    });
    return { service, findFirst, readAttachmentBytes, validateAttachmentParents };
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
});
