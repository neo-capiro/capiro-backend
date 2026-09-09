import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MeriSourceService, type MeriSourceRequest } from './meri-source.service.js';

// Only the injected implementation graph is replaced; reads exercise the real
// source service and delegation/continuation logic below.
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: class {} }));
jest.mock('../clients/clients.service.js', () => ({ ClientsService: class {} }));
jest.mock('../clients/client-capabilities.service.js', () => ({ ClientCapabilitiesService: class {} }));
jest.mock('../clients/client-people.service.js', () => ({ ClientPeopleService: class {} }));
jest.mock('../clients/client-facilities.service.js', () => ({ ClientFacilitiesService: class {} }));
jest.mock('../clients/client-advocacy-matter.service.js', () => ({ ClientAdvocacyMatterService: class {} }));
jest.mock('../memory/memory-authorization.service.js', () => ({ MemoryAuthorizationService: class {} }));
jest.mock('./meri-tools.service.js', () => ({ MeriToolsService: class {} }));

const ids = {
  tenant: '10000000-0000-4000-8000-000000000001', user: '20000000-0000-4000-8000-000000000001',
  client: '30000000-0000-4000-8000-000000000001', thread: '40000000-0000-4000-8000-000000000001',
  first: '50000000-0000-4000-8000-000000000001', second: '50000000-0000-4000-8000-000000000002',
};
const ctx = { tenantId: ids.tenant, userId: ids.user } as TenantContext;
function harness() {
  const thread = { id: ids.thread, subject: 'TAG advocacy request', clientId: ids.client, connectionEmail: 'neo@example.test', messages: [
    { id: ids.first, subject: 'FortressHUMS', fromEmail: 'tom@example.test', fromName: 'Tom', toRecipients: ['neo@example.test'], ccRecipients: [],
      sentAt: new Date('2026-09-02T12:00:00Z'), receivedAt: new Date('2026-09-02T12:01:00Z'),
      bodyText: `${'A'.repeat(6400)}EXACT END CHECKSUM: UH-72 LUT / $7.5M / REQUEST ONLY`, metadata: { bodyCompleteness: 'full' } },
    { id: ids.second, subject: 'Re: FortressHUMS', fromEmail: 'dan@example.test', fromName: 'Dan', toRecipients: ['tom@example.test'], ccRecipients: [],
      sentAt: new Date('2026-09-02T12:05:00Z'), receivedAt: new Date('2026-09-02T12:06:00Z'), bodyText: 'Second message exact body.', metadata: { bodyCompleteness: 'preview' } },
  ] };
  const tx = { $queryRawUnsafe: jest.fn(async () => [] as { id: string }[]), mailMessage: { findFirst: jest.fn(async () => ({ threadId: ids.thread })) } };
  const prisma = { withTenant: jest.fn(async (_: string, cb: any) => cb(tx)), withTenantUser: jest.fn(async (_: string, __: string, cb: any) => cb(tx)) };
  const engagement = { getMailThread: jest.fn(async () => thread), extractAttachmentText: jest.fn(async () => ({
    attachmentId: ids.first, fileName: 'fixture.txt', text: 'A'.repeat(6500) + 'DOCUMENT END', contentHash: 'content-v1', section: 1, sectionCount: 1,
  })) };
  const clients = { get: jest.fn(async () => ({ id: ids.client, name: 'Sightline', updatedAt: new Date('2026-09-02T12:00:00Z') })) };
  const capabilities = { listCapabilities: jest.fn(async () => [{ id: ids.first, name: 'Sensors', updatedAt: new Date('2026-09-03T00:00:00Z') }]), listClientHistory: jest.fn(async () => []) };
  const people = { listPeople: jest.fn(async () => []) }, facilities = { listFacilities: jest.fn(async () => []) }, advocacy = { getMatter: jest.fn() };
  const memory = { readGovernedMemorySource: jest.fn(async () => ({ records: [{ recordId: ids.first,
    payload: { value: 'Approved full factual content', title: 'Capabilities', governance: { status: 'active' }, content: { offset: 0, totalCharacters: 29, hash: 'memoryhash', nextRead: { contentCursor: 'next-memory-page' } } },
    provenance: { sourceVersion: 'memory-v1' },
  }] })) };
  const memoryAuthorization = { requireItem: jest.fn(async () => ({ clientId: ids.client })) };
  const service = new MeriSourceService(prisma as any, engagement as any, clients as any, capabilities as any, people as any, facilities as any, advocacy as any, memory as any, memoryAuthorization as any);
  return { service, tx, prisma, engagement, clients, capabilities, memory, thread, memoryAuthorization };
}
const mail: MeriSourceRequest = { kind: 'email', recordId: ids.first, threadId: ids.thread };

describe('Meri authorized source viewer', () => {
  it('reads beyond 6000 characters and every message with exact identity, dates and stored completeness', async () => {
    const h = harness();
    const first = await h.service.read(ctx, mail);
    expect(first.message.bodyText).toHaveLength(6000);
    const second = await h.service.read(ctx, { ...mail, cursor: first.nextCursor });
    const third = await h.service.read(ctx, { ...mail, cursor: second.nextCursor });
    expect(first.message.bodyText + second.message.bodyText).toBe(h.thread.messages[0]!.bodyText);
    expect(second.message.bodyText).toContain('EXACT END CHECKSUM: UH-72 LUT / $7.5M / REQUEST ONLY');
    expect(third).toMatchObject({ totalMessages: 2, nextCursor: null, message: { id: ids.second, threadId: ids.thread, bodyText: 'Second message exact body.', bodyCompleteness: 'preview', messageNumber: 2 } });
    expect(first.message.sentAt).toEqual(new Date('2026-09-02T12:00:00Z'));
    expect(first.message.receivedAt).toEqual(new Date('2026-09-02T12:01:00Z'));
    expect(h.engagement.getMailThread).toHaveBeenCalledTimes(3);
    expect(h.engagement.getMailThread).toHaveBeenCalledWith(ctx, ids.thread);
  });
  it('resolves old message-only citations through tenant, owner and active-message filters', async () => {
    const h = harness();
    await h.service.read(ctx, { kind: 'email', recordId: ids.first });
    expect(h.tx.mailMessage.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: ids.first, tenantId: ids.tenant, connection: { createdByUserId: ids.user } }) }));
  });
  it('preserves explicit denied and deleted responses from the canonical owner', async () => {
    const h = harness();
    h.engagement.getMailThread.mockRejectedValueOnce(new ForbiddenException('Denied'));
    await expect(h.service.read(ctx, mail)).rejects.toBeInstanceOf(ForbiddenException);
    h.engagement.getMailThread.mockRejectedValueOnce(new NotFoundException('Missing'));
    await expect(h.service.read(ctx, mail)).rejects.toBeInstanceOf(NotFoundException);
  });
  it('denies a missing cited message even when its parent thread remains visible', async () => {
    const h = harness();
    await expect(h.service.read(ctx, { ...mail, recordId: ids.client })).rejects.toBeInstanceOf(NotFoundException);
  });
  it('checks client walls after canonical mail ownership, including legacy citations without a client', async () => {
    const h = harness(); h.tx.$queryRawUnsafe.mockResolvedValue([{ id: ids.client }]);
    await expect(h.service.read(ctx, mail)).rejects.toBeInstanceOf(NotFoundException);
    expect(h.tx.$queryRawUnsafe).toHaveBeenCalledWith(expect.any(String), ids.tenant, ids.user);
  });
  it('rejects continuing a changed source rather than mixing versions', async () => {
    const h = harness(); const first = await h.service.read(ctx, mail);
    h.thread.messages[0]!.bodyText = 'Changed body';
    await expect(h.service.read(ctx, { ...mail, cursor: first.nextCursor })).rejects.toThrow('changed');
  });
  it('binds continuation to actor and source, without granting access from the cursor', async () => {
    const h = harness(); const first = await h.service.read(ctx, mail);
    await expect(h.service.read({ ...ctx, userId: ids.second }, { ...mail, cursor: first.nextCursor })).rejects.toThrow('scope changed');
    expect(h.engagement.getMailThread).toHaveBeenLastCalledWith({ ...ctx, userId: ids.second }, ids.thread);
  });
  it('labels current, matching and changed versions distinctly', async () => {
    const h = harness(); const first = await h.service.read(ctx, mail);
    expect(first.versionStatus).toBe('current_version_only');
    expect((await h.service.read(ctx, { ...mail, version: first.currentVersion })).versionStatus).toBe('matches_cited_version');
    expect((await h.service.read(ctx, { ...mail, version: 'old' })).versionStatus).toBe('changed_since_citation');
  });
  it('resolves profile child records through canonical client ownership and returns the existing full profile route', async () => {
    const h = harness();
    const result = await h.service.read(ctx, { kind: 'client', clientId: ids.client, recordId: ids.first, section: 'capabilities', version: '2026-09-03T00:00:00.000Z' });
    expect(result).toMatchObject({ status: 'record_navigation', title: 'Sensors', recordId: ids.first, clientId: ids.client, location: `/clients?clientId=${ids.client}`, versionStatus: 'matches_cited_version' });
    expect(h.capabilities.listCapabilities).toHaveBeenCalledWith(ctx, ids.client);
  });
  it('returns missing for a deleted profile child and checks parent walls before reading children', async () => {
    const h = harness();
    await expect(h.service.read(ctx, { kind: 'client', clientId: ids.client, recordId: ids.second, section: 'capabilities' })).rejects.toBeInstanceOf(NotFoundException);
    h.tx.$queryRawUnsafe.mockResolvedValue([{ id: ids.client }]); h.capabilities.listCapabilities.mockClear();
    await expect(h.service.read(ctx, { kind: 'client', clientId: ids.client, recordId: ids.first, section: 'capabilities' })).rejects.toBeInstanceOf(NotFoundException);
    expect(h.capabilities.listCapabilities).not.toHaveBeenCalled();
  });
  it('delegates exact governed memory reads with the original client and continuation', async () => {
    const h = harness(); const result = await h.service.read(ctx, { kind: 'memory', recordId: ids.first, clientId: ids.client, cursor: 'memory-cursor' });
    expect(h.memory.readGovernedMemorySource).toHaveBeenCalledWith(ctx, { memoryItemId: ids.first, clientId: ids.client, contentCursor: 'memory-cursor' });
    expect(result).toMatchObject({ text: 'Approved full factual content', nextCursor: 'next-memory-page', sourceVersion: 'memory-v1' });
  });
  it('derives a legacy memory citation scope from the exact authorized item, never the picker', async () => {
    const h = harness();
    await h.service.read(ctx, { kind: 'memory', recordId: ids.first });
    expect(h.memoryAuthorization.requireItem).toHaveBeenCalledWith(ctx, ids.first, 'read');
    expect(h.memory.readGovernedMemorySource).toHaveBeenCalledWith(ctx, { memoryItemId: ids.first, clientId: ids.client, contentCursor: undefined });
    h.memoryAuthorization.requireItem.mockRejectedValueOnce(new ForbiddenException());
    h.memory.readGovernedMemorySource.mockClear();
    await expect(h.service.read(ctx, { kind: 'memory', recordId: ids.first })).rejects.toBeInstanceOf(ForbiddenException);
    expect(h.memory.readGovernedMemorySource).not.toHaveBeenCalled();
  });
  it('does not claim a cited memory body matches solely because original evidence version is unchanged', async () => {
    const h = harness();
    const result = await h.service.read(ctx, { kind: 'memory', recordId: ids.first, version: 'content:old-body' });
    expect(result).toMatchObject({ sourceVersion: 'memory-v1', currentVersion: 'content:memoryhash', versionStatus: 'changed_since_citation' });
  });
  it('makes revoked, deleted or otherwise ineligible memory explicit without falling back to old content', async () => {
    const h = harness(); h.memory.readGovernedMemorySource.mockResolvedValue({ records: [] });
    expect(await h.service.read(ctx, { kind: 'memory', recordId: ids.first })).toMatchObject({ status: 'unavailable' });
  });
  it('reads complete document sections through the readiness-gated canonical reader', async () => {
    const h = harness(); const input: MeriSourceRequest = { kind: 'document', recordId: ids.first, clientId: ids.client, version: 'content-v1' };
    const first = await h.service.read(ctx, input); const last = await h.service.read(ctx, { ...input, cursor: first.nextCursor });
    expect(first.text + last.text).toBe('A'.repeat(6500) + 'DOCUMENT END');
    expect(last.nextCursor).toBeNull(); expect(first.versionStatus).toBe('matches_cited_version');
    expect(h.engagement.extractAttachmentText).toHaveBeenCalledWith(ctx, ids.first, { clientId: ids.client, section: 1 });
  });
  it('preserves readiness failures and rejects changed document continuations', async () => {
    const h = harness(); const input: MeriSourceRequest = { kind: 'document', recordId: ids.first, clientId: ids.client };
    h.engagement.extractAttachmentText.mockRejectedValueOnce(new BadRequestException({ error: 'ATTACHMENT_NOT_READY' }));
    await expect(h.service.read(ctx, input)).rejects.toBeInstanceOf(BadRequestException);
    const first = await h.service.read(ctx, input);
    h.engagement.extractAttachmentText.mockResolvedValueOnce({ attachmentId: ids.first, fileName: 'new.txt', text: 'new', contentHash: 'changed', section: 1, sectionCount: 1 });
    await expect(h.service.read(ctx, { ...input, cursor: first.nextCursor })).rejects.toThrow('changed');
  });
  it('rejects changed OCR text continuation even when original document bytes are unchanged', async () => {
    const h = harness(); const input: MeriSourceRequest = { kind: 'document', recordId: ids.first, clientId: ids.client };
    const first = await h.service.read(ctx, input);
    h.engagement.extractAttachmentText.mockResolvedValueOnce({ attachmentId: ids.first, fileName: 'same.pdf', text: 'B'.repeat(6600), contentHash: 'content-v1', section: 1, sectionCount: 1 });
    await expect(h.service.read(ctx, { ...input, cursor: first.nextCursor })).rejects.toThrow('Extracted source text changed');
  });
  it('rejects unsupported actions and noncanonical IDs before any reader is called', async () => {
    const h = harness();
    await expect(h.service.read(ctx, { kind: 'send_email', recordId: ids.first } as any)).rejects.toBeInstanceOf(BadRequestException);
    await expect(h.service.read(ctx, { kind: 'email', recordId: 'Tom advocacy letter' })).rejects.toBeInstanceOf(BadRequestException);
    expect(h.engagement.getMailThread).not.toHaveBeenCalled();
  });
});
