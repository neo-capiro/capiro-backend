import type { TenantContext } from '@capiro/shared';
import JSZip from 'jszip';
import { HearingRecapService } from './hearing-recap.service.js';
const ctx = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  clerkUserId: 'owner-a',
  role: 'standard_user',
} as TenantContext;
const input = { eventId: 'event-a', briefId: 'brief-a', contentHash: 'a'.repeat(64) };
const approved = {
  ...input,
  schema: 'legiwatch.approved-record-brief-document.v1',
  tenantId: ctx.tenantId,
  clientId: 'client-a',
  seriesId: 'series-a',
  version: 2,
  sourceHash: 'b'.repeat(64),
  title: 'Published record brief',
  approvedAt: '2026-09-13T05:00:00Z',
  markdown:
    '## Published developments\nCapiro analysis — Brief based on published records\nThe published tally records 110 yeas.\nSource: vote-version-a / exact-hash / record\n\n## Next steps\nCapiro analysis: review implementation priorities.',
  accessLocks: {
    folders: [{ id: 'folder-a', version: 1, clientId: 'client-a' }],
    observation: null,
  },
};
describe('approved record brief export and Documents boundary', () => {
  const original = global.fetch;
  afterEach(() => {
    global.fetch = original;
  });
  function fixture() {
    const queries: string[] = [],
      writer = {
        createAttachmentFromBuffer: jest.fn(async () => ({
          id: 'attachment-a',
          fileName: 'brief.docx',
          reused: true,
        })),
        supersedeAttachment: jest.fn(),
      },
      tx = {
        client: { findFirst: async () => ({ id: 'client-a', name: 'Synthetic client' }) },
        $executeRaw: jest.fn(async (parts: TemplateStringsArray) => {
          queries.push(parts.join('?'));
          return 1;
        }),
        $queryRaw: jest.fn(async (parts: TemplateStringsArray) => {
          queries.push(parts.join('?'));
          return [];
        }),
      };
    return {
      writer,
      queries,
      service: new HearingRecapService(
        writer as never,
        { withTenant: async (_tenant: string, fn: (tx: unknown) => unknown) => fn(tx) } as never,
      ),
    };
  }
  it('saves the exact approved bytes with separate provenance and private owner scope', async () => {
    const { service, writer, queries } = fixture();
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => approved })) as never;
    const exported = await service.recordBriefDocument(
      ctx,
      'client-a',
      input,
      false,
      'Bearer synthetic',
    );
    const saved = await service.recordBriefDocument(
      ctx,
      'client-a',
      { ...input, markdown: 'Caller substitution' } as typeof input,
      true,
      'Bearer synthetic',
    );
    expect(saved).toMatchObject({
      briefId: input.briefId,
      sourceHash: approved.sourceHash,
      reused: true,
    });
    const call = (
      writer.createAttachmentFromBuffer.mock.calls[0] as unknown as [unknown, { buffer: Buffer }]
    )[1];
    expect(call).toMatchObject({
      source: 'published_record_brief',
      sourceEntityType: 'hearing_record_brief',
      privateToUploader: true,
      sourceEntityId: input.briefId,
      sourceContentHash: input.contentHash,
    });
    expect(call.buffer.equals((exported as { buffer: Buffer }).buffer)).toBe(true);
    const xml = await (await JSZip.loadAsync(call.buffer))
      .file('word/document.xml')!
      .async('string');
    expect(xml).toContain('110 yeas');
    expect(xml).not.toContain('Caller substitution');
    expect(queries.some((q) => q.includes('tenant_memberships') && q.includes('FOR SHARE'))).toBe(
      true,
    );
    expect(
      queries.some((q) => q.includes('intel_legiwatch_folder') && q.includes('FOR SHARE')),
    ).toBe(true);
    expect(queries.some((q) => q.includes('INSERT INTO legiwatch_record_document'))).toBe(true);
  });
  it.each(['client', 'hash', 'context'])('rejects a mismatched %s before saving', async (kind) => {
    const { service, writer } = fixture();
    const value = {
      ...approved,
      ...(kind === 'client'
        ? { clientId: 'other' }
        : kind === 'hash'
          ? { contentHash: 'c'.repeat(64) }
          : { accessLocks: null }),
    };
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => value })) as never;
    await expect(
      service.recordBriefDocument(ctx, 'client-a', input, true, 'Bearer synthetic'),
    ).rejects.toThrow('APPROVED_RECORD_BRIEF_CONTRACT_INVALID');
    expect(writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
  it('holds a write when permission is withdrawn after rendering', async () => {
    const { service, writer } = fixture();
    let calls = 0;
    global.fetch = jest.fn(async () => ({
      ok: ++calls === 1,
      json: async () => approved,
    })) as never;
    await expect(
      service.recordBriefDocument(ctx, 'client-a', input, true, 'Bearer synthetic'),
    ).rejects.toThrow('APPROVED_RECORD_BRIEF_UNAVAILABLE_OR_ACCESS_CHANGED');
    expect(writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
});
