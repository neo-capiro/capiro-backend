import { describe, expect, jest, test } from '@jest/globals';
import { AttachmentContentService } from './attachment-content.service.js';
import { EngagementService } from './engagement.service.js';
import { EvidenceSourceService } from './generation/evidence-source.service.js';
import { OutreachContextReferenceService } from '../capabilities/context/outreach-context-reference.service.js';

const content = new AttachmentContentService();
const identity = {
  id: 'synthetic-identity',
  fileName: 'identity.txt',
  contentType: 'text/plain',
  source: 'profile_identity',
  lifecycleStatus: 'quarantined',
  scanStatus: 'scanner_not_required',
  verifiedContentType: 'text/plain',
};

describe('identity attachment readiness', () => {
  test.each([false, true])('quarantine remains unusable when scanRequired=%s', (scanRequired) => {
    expect(content.readiness(identity, scanRequired)).toMatchObject({
      usable: false,
      code: 'ATTACHMENT_QUARANTINED',
    });
    expect(content.readiness({ ...identity, scanStatus: 'clean' }, scanRequired).usable).toBe(false);
  });

  test.each(['ready', 'legacy_ready'])(
    '%s identity requires a genuine clean verdict even when scanning is optional',
    (lifecycleStatus) => {
      for (const scanStatus of [null, 'scanner_not_required', 'pending', 'failed', 'unsupported', 'access_denied']) {
        expect(content.readiness({ ...identity, lifecycleStatus, scanStatus }, false).usable).toBe(false);
      }
      expect(content.readiness({ ...identity, lifecycleStatus, scanStatus: 'clean' }, false)).toEqual({
        usable: true,
        code: null,
        disclosure: null,
      });
    },
  );

  test.each(['blocked', 'delete_pending', 'delete_failed', 'unknown'])(
    'identity lifecycle %s cannot be released by a clean verdict',
    (lifecycleStatus) => {
      expect(content.readiness({ ...identity, lifecycleStatus, scanStatus: 'clean' }, false).usable).toBe(false);
    },
  );

  test('a threat remains authoritative for identity uploads', () => {
    expect(content.readiness({ ...identity, scanStatus: 'threat' }, false)).toMatchObject({
      usable: false,
      code: 'ATTACHMENT_SCAN_THREAT',
    });
  });

  test('ordinary optional-scan compatibility and required-scan refusal remain unchanged', () => {
    const ordinary = { ...identity, source: 'upload' };
    expect(content.readiness(ordinary, false)).toEqual({
      usable: true,
      code: null,
      disclosure: 'This file was NOT virus-scanned (no scanner is configured in this environment).',
    });
    expect(content.readiness(ordinary, true)).toMatchObject({
      usable: false,
      code: 'ATTACHMENT_NEVER_SCANNED',
    });
  });
});

function listFixture(overrides: Partial<typeof identity> = {}) {
  const row = Object.freeze({
    ...identity, ...overrides,
    uploadedByUserId: 'synthetic-actor', viewerMode: 'restricted', viewerUserIds: ['synthetic-actor'],
    clientId: null, prospectId: null, meetingId: null, mailMessageId: null,
    sourceEntityType: null, supersededByAttachmentId: null,
    calculatedSha256: 'a'.repeat(64), bucket: 'synthetic', s3Key: 'synthetic/identity.txt',
  });
  const tx = {
    engagementAttachment: { findMany: jest.fn(async () => [row]) },
    user: { findMany: jest.fn(async () => []) },
  };
  const links = jest.fn(async () => ({
    downloadUrl: 'https://synthetic.invalid/download',
    previewUrl: 'https://synthetic.invalid/preview',
  }));
  const service = Object.create(EngagementService.prototype) as any;
  Object.assign(service, {
    prisma: { withTenant: async (_tenantId: string, callback: (value: typeof tx) => unknown) => callback(tx) },
    validateAttachmentParents: async () => {},
    attachmentContent: content, scanner: { scanRequired: false }, createAttachmentLinks: links,
  });
  const list = () => service.listAttachments({ tenantId: 'synthetic-tenant', userId: 'synthetic-actor' }, { unlinked: true });
  return { row, links, list };
}

describe('attachment list uses identity readiness before signing', () => {
  test('the historical state is retained but stays unusable without links', async () => {
    const fixture = listFixture();
    const [listed] = await fixture.list();
    expect(listed).toMatchObject({
      id: fixture.row.id, source: 'profile_identity', lifecycleStatus: 'quarantined',
      scanStatus: 'scanner_not_required', usable: false,
      downloadUrl: null, previewUrl: null, blockedReason: 'ATTACHMENT_QUARANTINED',
    });
    expect(fixture.links).not.toHaveBeenCalled();
    expect(fixture.row.lifecycleStatus).toBe('quarantined');
    expect(fixture.row.scanStatus).toBe('scanner_not_required');
  });

  test.each(['ready', 'legacy_ready'])('%s unscanned identity is not signed', async (lifecycleStatus) => {
    const fixture = listFixture({ lifecycleStatus });
    expect(await fixture.list()).toEqual([expect.objectContaining({
      usable: false, downloadUrl: null, previewUrl: null, blockedReason: 'ATTACHMENT_NEVER_SCANNED',
    })]);
    expect(fixture.links).not.toHaveBeenCalled();
  });

  test('genuine-clean identity reaches the existing version-verifying signer with the full row', async () => {
    const fixture = listFixture({ lifecycleStatus: 'ready', scanStatus: 'clean' });
    expect(await fixture.list()).toEqual([expect.objectContaining({
      usable: true, downloadUrl: 'https://synthetic.invalid/download', previewUrl: 'https://synthetic.invalid/preview',
    })]);
    expect(fixture.links).toHaveBeenCalledWith(fixture.row);
    expect(fixture.links).toHaveBeenCalledTimes(1);
  });

  test('ordinary optional-scan attachments keep their existing signed-link path', async () => {
    const fixture = listFixture({ source: 'upload' });
    expect(await fixture.list()).toEqual([expect.objectContaining({ usable: true })]);
    expect(fixture.links).toHaveBeenCalledWith(fixture.row);
  });
});

describe('projected readiness callers retain the attachment source', () => {
  const row = {
    ...identity, id: '11111111-1111-4111-8111-111111111111', clientId: null,
    prospectId: null, meetingId: null, sourceEntityType: null, createdAt: new Date('2026-01-01'),
  };
  const ctx = { tenantId: 'synthetic-tenant', userId: 'synthetic-actor' };

  test('generation excludes quarantined identity before extraction eligibility', async () => {
    const attachments = Object.create(content);
    attachments.isExtractableDocument = jest.fn(() => false);
    const tx = { engagementAttachment: { findFirst: async () => row } };
    const service = Object.create(EvidenceSourceService.prototype) as any;
    Object.assign(service, {
      attachments,
      prisma: { withTenant: async (_tenant: string, callback: (value: typeof tx) => unknown) => callback(tx) },
    });
    expect(await service.resolveDocument(ctx, { id: `doc-${row.id}` }, { scanRequired: false }))
      .toMatchObject({ failures: [{ code: 'ATTACHMENT_QUARANTINED' }] });
    expect(attachments.isExtractableDocument).not.toHaveBeenCalled();
  });

  test('outreach context refuses quarantined identity instead of offering it as evidence', async () => {
    const tx = { engagementAttachment: { findFirst: async () => row } };
    const service = Object.create(OutreachContextReferenceService.prototype) as any;
    Object.assign(service, { attachmentContent: content, attachmentScanner: { scanRequired: false } });
    await expect(service.resolveDocument(tx, ctx, { id: row.id, clientId: null }))
      .rejects.toMatchObject({ code: 'CAPABILITY_NOT_FOUND' });
  });
});
