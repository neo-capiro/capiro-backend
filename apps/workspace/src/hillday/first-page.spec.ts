import { describe, expect, it, jest } from '@jest/globals';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { applyFirstPage, validateFirstPage } from './first-page.js';
import { HillDayDocumentService } from './hillday-document.service.js';
import type { FirstPageEdits, MeetingSection } from './hillday.types.js';

const ids = new Set(['meeting-1', 'meeting-2']);
const edited: FirstPageEdits = {
  title: 'October advocacy day', dateline: 'Arrival at 12:30 PM',
  facts: [{ key: 'Lead', value: 'Alex Chen' }],
  rows: [{ meetingId: 'meeting-1', time: '2:15 PM', room: 'Visitor center', staffLead: '' }],
  hiddenColumns: ['office', 'minutes', 'staffLead'],
};

describe('first-page presentation boundary', () => {
  it('preserves sparse overrides and deliberately empty values', () => {
    expect(validateFirstPage(edited, ids)).toEqual(edited);
    expect(validateFirstPage(null, ids)).toBeNull();
    const original = { sectionId: 'meeting-1', meetingId: 'meeting-1', time: '1:00 PM', member: 'Member', office: 'District', room: 'Original room', minutes: '30', staffLead: 'Original lead' };
    const result = applyFirstPage({ title: 'Default title', dateline: 'Default date', facts: [{ k: 'Lead', v: 'Original' }, { k: 'Date', v: 'Monday' }] }, [original], edited);
    expect(result.cover.facts).toEqual([{ k: 'Lead', v: 'Alex Chen' }, { k: 'Date', v: 'Monday' }]);
    expect(result.summary[0]).toMatchObject({ time: '2:15 PM', room: 'Visitor center', staffLead: '', member: 'Member' });
    expect(result.summaryColumns).toEqual(['time', 'member', 'room']);
    expect(original.room).toBe('Original room');
  });

  it.each([
    { hiddenColumns: ['room', 'room'] },
    { hiddenColumns: ['unknown'] },
    { hiddenColumns: ['time', 'member', 'office', 'room', 'minutes', 'staffLead'] },
    { rows: [{ meetingId: 'foreign-meeting', room: 'Elsewhere' }] },
    { rows: [{ meetingId: 'meeting-1' }, { meetingId: 'meeting-1' }] },
    { rows: [{ meetingId: 'meeting-1', sectionId: 'inject' }] },
    { rows: [{ meetingId: 'meeting-1', room: null }] },
    { facts: [{ key: 'Lead', value: 'A' }, { key: 'Lead', value: 'B' }] },
    { facts: [{ key: 'Unknown', value: 'A' }] },
    { facts: null },
    { title: 'x'.repeat(201) },
    { rows: [{ meetingId: 'meeting-1', minutes: 'x'.repeat(41) }] },
    { sections: [] },
  ])('rejects invalid or ambiguous replacement %#', (input) => {
    expect(() => validateFirstPage(input, ids)).toThrow(BadRequestException);
  });

  it('binds overrides to meeting identity after reorder and ignores removed meetings', () => {
    const row = (meetingId: string) => ({ sectionId: meetingId, meetingId, time: '1:00 PM', member: meetingId, office: '', room: 'Original', minutes: '30', staffLead: '' });
    const cover = { title: 'Default', dateline: '', facts: [] };
    expect(applyFirstPage(cover, [row('meeting-2'), row('meeting-1')], edited).summary.map((r) => r.room)).toEqual(['Original', 'Visitor center']);
    expect(applyFirstPage(cover, [row('meeting-2')], edited).summary).toHaveLength(1);
  });
});

function harness() {
  const updatedAt = new Date('2026-09-11T10:00:00Z');
  const doc = {
    id: 'doc', tenantId: 'tenant', ownerId: 'owner', clientId: 'client', clientName: 'Synthetic client',
    name: 'Schedule', timeZone: 'America/New_York', status: 'generated', lookbackDays: 90,
    weekStart: null, resolutionStatus: null, firstPage: null as FirstPageEdits | null,
    provenance: { model: 'test' }, generatedAt: updatedAt, updatedAt, createdAt: updatedAt,
  };
  const meetings = ['meeting-1', 'meeting-2'].map((id, ordinal) => ({
    id, eventId: `event-${id}`, tenantId: 'tenant', documentId: 'doc', ordinal, updatedAt,
    event: { subject: id, startsAt: '2026-10-05T17:00:00Z', endsAt: '2026-10-05T17:30:00Z', location: 'Original room', attendees: [] },
    resolution: null, context: null, sourceSet: null,
    section: { sectionId: id, status: 'done', focus: 'Original focus', background: 'Original background', reason: null, flags: [], generatedAt: updatedAt.toISOString(), model: 'test', edited: { focus: false, background: false, at: null } } as MeetingSection,
  }));
  const wsHillDayDocument = {
    findFirst: jest.fn(async ({ where }: { where: { id: string; tenantId: string } }) => where.id === doc.id && where.tenantId === doc.tenantId ? doc : null),
    update: jest.fn(async ({ data }: { data: Record<string, unknown> }) => Object.assign(doc, data)),
    updateMany: jest.fn(async ({ where, data }: { where: { updatedAt: Date }; data: Record<string, unknown> }) => {
      if (where.updatedAt.getTime() !== doc.updatedAt.getTime() || doc.status === 'generating') return { count: 0 };
      Object.assign(doc, data, data.firstPage === Prisma.DbNull ? { firstPage: null } : {});
      return { count: 1 };
    }),
  };
  const wsHillDayMeeting = {
    findMany: jest.fn(async () => meetings),
    findFirst: jest.fn(async ({ where }: { where: { id?: string; section?: unknown } }) => where.section ? meetings.find((m) => m.section.status === 'unavailable') ?? null : meetings.find((m) => m.id === where.id) ?? null),
    update: jest.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(meetings.find((m) => m.id === where.id)!, data)),
  };
  const tx = { wsHillDayDocument, wsHillDayMeeting };
  const prisma = { ...tx, wsHillDayJob: { findFirst: jest.fn(async () => null) }, $transaction: jest.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const savedDoc = { ...doc };
    const savedSections = meetings.map((m) => m.section);
    try { return await fn(tx); } catch (err) {
      Object.assign(doc, savedDoc); meetings.forEach((m, i) => { m.section = savedSections[i]!; }); throw err;
    }
  }) };
  const source = { tenantName: async () => 'Firm', userDisplays: async () => new Map([['owner', { name: 'Owner', initials: 'O' }]]), getClient: async () => ({ hasLogo: false }) };
  return { service: new HillDayDocumentService(prisma as never, source as never, {} as never, {} as never), doc, meetings, prisma };
}

describe('HillDayDocumentService first-page saves', () => {
  it('round-trips edits on reload, preserves source records, touches the revision and survives unrelated changes', async () => {
    const { service, doc, meetings } = harness();
    const sourceBefore = JSON.stringify(meetings);
    const before = doc.updatedAt.toISOString();
    const saved = await service.patch('tenant', 'owner', 'doc', { firstPage: edited, expectedUpdatedAt: before });
    expect(saved.firstPage).toEqual(edited);
    expect(saved.cover.title).toBe(edited.title);
    expect(saved.cover.facts.find((f) => f.k === 'Revision')?.v).toBe('2 · edited');
    expect(saved.summaryColumns).toEqual(['time', 'member', 'room']);
    expect(saved.updatedAt).not.toBe(before);
    expect(JSON.stringify(meetings)).toBe(sourceBefore);
    await service.patch('tenant', 'owner', 'doc', { name: 'Renamed' });
    // Generation replaces provenance, which must never contain the user edits.
    doc.provenance = { model: 'new model' };
    const reopened = await service.get('tenant', 'doc');
    expect(reopened.firstPage).toEqual(edited);
    expect(reopened.summary[0]?.room).toBe('Visitor center');
  });

  it('requires a fresh version and rolls back a combined section edit when stale', async () => {
    const { service, doc, meetings } = harness();
    await expect(service.patch('tenant', 'owner', 'doc', { firstPage: edited })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.patch('tenant', 'owner', 'doc', { firstPage: edited, expectedUpdatedAt: '2026-09-10T10:00:00Z', section: { sectionId: 'meeting-1', focus: 'Lost update' } })).rejects.toBeInstanceOf(ConflictException);
    expect(meetings[0]?.section.focus).toBe('Original focus');
    expect(doc.firstPage).toBeNull();
    doc.status = 'generating';
    await expect(service.patch('tenant', 'owner', 'doc', { firstPage: edited, expectedUpdatedAt: doc.updatedAt.toISOString() })).rejects.toBeInstanceOf(ConflictException);
  });

  it('enforces tenant/owner boundaries and rejects foreign meeting IDs', async () => {
    const { service, doc, prisma } = harness();
    await expect(service.patch('other-tenant', 'owner', 'doc', { firstPage: edited })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.patch('tenant', 'other-owner', 'doc', { firstPage: edited })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service.patch('tenant', 'owner', 'doc', { firstPage: { rows: [{ meetingId: 'foreign' }] }, expectedUpdatedAt: doc.updatedAt.toISOString() })).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.wsHillDayDocument.updateMany).not.toHaveBeenCalled();
  });

  it('resets to source defaults and reopens a delivered document after edits', async () => {
    const { service, doc } = harness();
    doc.status = 'delivered';
    const saved = await service.patch('tenant', 'owner', 'doc', { firstPage: edited, expectedUpdatedAt: doc.updatedAt.toISOString() });
    expect(saved.status).toBe('generated');
    const reset = await service.patch('tenant', 'owner', 'doc', { firstPage: null, expectedUpdatedAt: saved.updatedAt });
    expect(reset.firstPage).toBeNull();
    expect(reset.cover.title).toBe('Hill Day Schedule');
    expect(reset.summary[0]?.room).toBe('Original room');
    expect(reset.summaryColumns).toHaveLength(6);
  });

  it('touches the parent on a section edit so an older first-page save conflicts', async () => {
    const { service, doc } = harness();
    const before = doc.updatedAt.toISOString();
    await service.patch('tenant', 'owner', 'doc', { section: { sectionId: 'meeting-1', focus: 'Edited focus' } });
    expect(doc.updatedAt.toISOString()).not.toBe(before);
    await expect(service.patch('tenant', 'owner', 'doc', { firstPage: edited, expectedUpdatedAt: before })).rejects.toBeInstanceOf(ConflictException);
  });

  it('omits removed meeting overrides from GET so reopening can be saved again', async () => {
    const { service, doc, meetings } = harness();
    doc.firstPage = edited;
    meetings.splice(0, 1);
    const reopened = await service.get('tenant', 'doc');
    expect(reopened.firstPage?.rows).toEqual([]);
    await expect(service.patch('tenant', 'owner', 'doc', { firstPage: reopened.firstPage, expectedUpdatedAt: reopened.updatedAt })).resolves.toMatchObject({ cover: { title: edited.title } });
  });
});
