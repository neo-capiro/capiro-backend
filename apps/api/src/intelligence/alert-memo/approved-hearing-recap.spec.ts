import type { TenantContext } from '@capiro/shared';
import JSZip from 'jszip';
import { HearingRecapService } from './hearing-recap.service.js';
import { renderApprovedHearingRecap } from './approved-hearing-recap-docx.js';

const ctx = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  clerkUserId: 'clerk-a',
  role: 'standard_user',
} as TenantContext;
const input = {
  sessionId: 'session-a',
  publicationId: 'publication-a',
  contentHash: 'a'.repeat(64),
};
const approved = {
  ...input,
  schema: 'legiwatch.approved-recap-document.v1',
  tenantId: ctx.tenantId,
  clientId: 'client-a',
  version: 2,
  title: 'Reviewed transportation testimony',
  markdown:
    '## Unofficial recap\nA witness discussed bridge maintenance.\nEvidence: segment-a (2–5 seconds)\nApproved version 2',
  approvedAt: '2026-09-12T18:30:00.000Z',
};
describe('approved hearing recap documents', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  function fixture() {
    const writer = {
      createAttachmentFromBuffer: jest.fn(async () => ({
        id: 'attachment-a',
        fileName: 'reviewed.docx',
        indexedAt: null,
        reused: false,
      })),
    };
    const tx = {
      client: {
        findFirst: jest.fn(async () => ({ id: 'client-a', name: 'Transportation client' })),
      },
      $queryRaw: jest.fn(async () => [{ id: input.sessionId }]),
    };
    const service = new HearingRecapService(
      writer as any,
      { withTenant: async (_tenant: string, run: (t: typeof tx) => unknown) => run(tx) } as any,
    );
    return { writer, service };
  }
  it('freezes document dates and body for repeat export, including the reviewed evidence', async () => {
    const first = await renderApprovedHearingRecap(approved, 'Transportation client');
    const second = await renderApprovedHearingRecap(approved, 'Transportation client');
    expect(first.equals(second)).toBe(true);
    const zip = await JSZip.loadAsync(first);
    expect(await zip.file('word/document.xml')!.async('string')).toContain('Evidence: segment-a');
    expect(await zip.file('docProps/core.xml')!.async('string')).toContain(approved.approvedAt);
  });
  it('writes only the approved bytes and provenance through the existing document writer', async () => {
    const { writer, service } = fixture();
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => approved })) as any;
    await service.saveApproved(
      ctx,
      'client-a',
      { ...input, markdown: 'Unreviewed caller text' } as any,
      'Bearer fixture',
    );
    expect(writer.createAttachmentFromBuffer).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-a',
        source: 'hearing_recap',
        sourceVersion: 2,
        sourceContentHash: input.contentHash,
        idempotencyKey: `approved-hearing-recap:${input.publicationId}:${input.contentHash}`,
      }),
    );
    const saved = (writer.createAttachmentFromBuffer.mock.calls[0] as any)[1];
    const xml = await (await JSZip.loadAsync(saved.buffer))
      .file('word/document.xml')!
      .async('string');
    expect(xml).toContain('A witness discussed bridge maintenance.');
    expect(xml).not.toContain('Unreviewed caller text');
  });
  it('rejects a mismatched client or changed authorization before any document write', async () => {
    const { writer, service } = fixture();
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ ...approved, clientId: 'client-b' }),
    })) as any;
    await expect(service.saveApproved(ctx, 'client-a', input, 'Bearer fixture')).rejects.toThrow(
      'CONTRACT',
    );
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => approved })
      .mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(service.saveApproved(ctx, 'client-a', input, 'Bearer fixture')).rejects.toThrow(
      'ACCESS_CHANGED',
    );
    expect(writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
});
