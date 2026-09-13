import { randomUUID } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { HearingRecapService } from './hearing-recap.service.js';

if (
  process.env.LEGIWATCH_RECORDING_TEST_DATABASE !== 'disposable' ||
  !['localhost', '127.0.0.1'].includes(new URL(process.env.DATABASE_URL ?? '').hostname)
)
  throw Error('Local disposable PostgreSQL required');

describe('recap document policy on the actual API database boundary', () => {
  const p = new PrismaService({ transactionOptions: { maxWait: 10000, timeout: 10000 } });
  const tenantId = randomUUID(),
    clientId = randomUUID(),
    actor = 'recap-' + randomUUID();
  const ctx = {
    tenantId,
    userId: randomUUID(),
    clerkUserId: actor,
    role: 'standard_user',
  } as TenantContext;
  const writer = {
    createAttachmentFromBuffer: jest.fn(async () => ({
      id: randomUUID(),
      fileName: 'Owned recap.docx',
    })),
  };
  const service = new HearingRecapService(writer as any, p);
  const originalFetch = global.fetch;
  beforeAll(async () => {
    await p.$executeRaw`INSERT INTO tenants(id,slug,name) VALUES(${tenantId}::uuid,${'recap-' + tenantId},'Owned recap fixture')`;
    await p.$executeRaw`INSERT INTO clients(id,tenant_id,name,status) VALUES(${clientId}::uuid,${tenantId}::uuid,'Owned recap client','active')`;
  });
  afterEach(() => {
    jest.clearAllMocks();
    global.fetch = originalFetch;
  });
  afterAll(() => p.$disconnect());
  async function session(policy = 'transcript_only', canonical = false) {
    const id = 'recap-' + randomUUID(),
      hearingId = 'recap-' + randomUUID(),
      captureId = canonical ? randomUUID() : null;
    if (canonical) {
      await p.$executeRaw`INSERT INTO committee_hearing(id,committee_name,chamber,title,date,event_status,visibility)
        VALUES(${hearingId},'Owned committee','Senate','Owned recap fixture',now(),'completed','public')`;
      await p.$executeRaw`INSERT INTO public_hearing_capture(id,hearing_id,status,domain_status)
        VALUES(${captureId},${hearingId},'ended','COMPLETE')`;
    }
    await p.$executeRaw`INSERT INTO intel_live_hearing_session(id,tenant_id,created_by,title,source_type,audio_source,recording_policy,status,consent_status,issue_ids,bill_ids,program_element_ids,agency_ids,updated_at,hearing_id,public_capture_id)
      VALUES(${id},${tenantId},${actor},'Owned recap fixture','hearing','browser_mic',${policy}::"intel_recording_policy",'ended','not_required',ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],ARRAY[]::text[],now(),${canonical ? hearingId : null},${captureId})`;
    return id;
  }
  const input = (sessionId: string) => ({
    sessionId,
    title: 'Owned recap',
    markdown: 'Unofficial synthetic testimony.',
  });
  it('rejects no-storage saves before rendering or writing a document', async () => {
    await expect(service.save(ctx, clientId, input(await session('no_storage')))).rejects.toThrow(
      'not found',
    );
    expect(writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
  it('requires approval for retained audio and canonical review contexts', async () => {
    for (const id of [
      await session('audio_and_transcript'),
      await session('transcript_only', true),
    ])
      await expect(service.save(ctx, clientId, input(id))).rejects.toThrow(
        'APPROVED_HEARING_RECAP_REQUIRED',
      );
    expect(writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
  it('keeps a canonical review context private even though its source is a public hearing', async () => {
    const id = await session('transcript_only', true),
      other = { ...ctx, clerkUserId: 'different-actor' };
    global.fetch = jest.fn() as any;
    await expect(service.save(other, clientId, input(id))).rejects.toThrow('not found');
    await expect(
      service.saveApproved(
        other,
        clientId,
        { sessionId: id, publicationId: randomUUID(), contentHash: 'a'.repeat(64) },
        'Bearer fixture',
      ),
    ).rejects.toThrow('not found');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(writer.createAttachmentFromBuffer).not.toHaveBeenCalled();
  });
  it('preserves legacy transcript-only saves until the tenant enables reviewed recaps', async () => {
    const id = await session();
    await expect(service.save(ctx, clientId, input(id))).resolves.toMatchObject({ reused: false });
    expect(writer.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
    await p.$executeRaw`INSERT INTO intel_feature_flag(id,tenant_id,feature,enabled,created_at) VALUES(${randomUUID()},${tenantId},'legiwatch_hearing_recaps_v1',true,now())`;
    await expect(service.save(ctx, clientId, input(id))).rejects.toThrow(
      'APPROVED_HEARING_RECAP_REQUIRED',
    );
    expect(writer.createAttachmentFromBuffer).toHaveBeenCalledTimes(1);
  });
  it('allows the canonical context owner to save the exact approved document', async () => {
    const id = await session('transcript_only', true);
    const approved = {
      schema: 'legiwatch.approved-recap-document.v1',
      tenantId,
      clientId,
      sessionId: id,
      publicationId: randomUUID(),
      contentHash: 'b'.repeat(64),
      version: 1,
      title: 'Owned reviewed recap',
      markdown: 'Unofficial recap. Evidence: owned-final (1–5 seconds).',
      approvedAt: '2026-09-12T18:00:00.000Z',
    };
    global.fetch = jest.fn(async () => ({ ok: true, json: async () => approved })) as any;
    await expect(
      service.saveApproved(ctx, clientId, approved, 'Bearer fixture'),
    ).resolves.toMatchObject({ version: 1, contentHash: approved.contentHash });
    expect(writer.createAttachmentFromBuffer).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        sourceVersion: 1,
        sourceContentHash: approved.contentHash,
        sourceEntityId: id,
      }),
    );
  });
});
