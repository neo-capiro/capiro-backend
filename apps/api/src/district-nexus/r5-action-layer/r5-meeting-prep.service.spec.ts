import { ConflictException, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { R5MeetingPrepService } from './r5-meeting-prep.service.js';
import type { R5DistrictContext } from './r5-types.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { R5DistrictContextService } from './r5-district-context.service.js';

const ctx = { tenantId: 'tenant-one', userId: 'user-one' } as TenantContext;
const input = { clientId: 'client-one', meetingId: 'meeting-one', state: 'TX', district: '08' };
const fact: R5DistrictContext['facts'][number] = {
  id: 'footprint:facility:one', section: 'footprint', label: 'Site', value: null, unit: 'people',
  amountStage: null, basis: 'verified_client_nexus', source: { type: 'facility', label: 'Facility', recordId: 'one', url: null },
  asOf: { date: null, fiscalYear: null, sourceYear: null },
  geography: { state: 'TX', district: '08', scope: 'district', basis: null, boundaryCongress: null },
  freshness: { lastSyncedAt: null, stale: false, unavailable: true }, coverage: 'partial', caveats: [],
};
const district: R5DistrictContext = { clientId: 'client-one', clientName: 'Client', state: 'TX', district: '08',
  facts: [fact], gaps: [{ section: 'opportunities', reason: 'No feed', source: 'feed' }], sourceHealth: [], generatedAt: '2026-01-01T00:00:00Z' };

function setup(meetingClient: string | null = 'client-one', visible = true) {
  const preps: Record<string, unknown>[] = [{ id: 'classic', generatedFrom: { kind: 'classic' } }];
  const notes = [{ id: 'note' }]; const debriefs = [{ id: 'debrief' }];
  const meeting = { id: input.meetingId, clientId: meetingClient, attendees: [{ name: 'Attendee', email: null }] };
  const tx = {
    client: { findFirst: jest.fn(async ({ where }) => where.tenantId === ctx.tenantId ? { id: input.clientId } : null) },
    meeting: { findFirst: jest.fn(async ({ where }) => where.tenantId === ctx.tenantId && visible && where.OR ? meeting : null),
      findMany: jest.fn(async () => [{ ...meeting, subject: 'Planning', startsAt: new Date('2030-01-01'), attendees: meeting.attendees }]) },
    meetingPrep: {
      findFirst: jest.fn(async ({ where }) => preps.find((p) => p.id === where.id ||
        (p.meetingId === where.meetingId && p.promptHash === where.promptHash &&
          (p.generatedFrom as Record<string, unknown>).kind === 'district_nexus_r5')) ?? null),
      create: jest.fn(async ({ data }) => { const row = { ...data, id: 'district-prep', updatedAt: new Date() }; preps.push(row); return row; }),
      updateMany: jest.fn(async ({ where, data }) => { const row = preps.find((p) => p.id === where.id);
        if (!row || (row.generatedFrom as Record<string, unknown>).kind !== 'district_nexus_r5') return { count: 0 };
        Object.assign(row, data); return { count: 1 }; }),
      findFirstOrThrow: jest.fn(async () => preps.find((p) => p.id === 'district-prep')),
    },
    $executeRaw: jest.fn(async () => 1),
  };
  const prisma = { withTenant: jest.fn(async (_tenantId, fn) => fn(tx)) };
  const context = { getContext: jest.fn(async () => district) };
  const service = new R5MeetingPrepService(prisma as unknown as PrismaService, context as unknown as R5DistrictContextService);
  return { service, tx, preps, notes, debriefs, context };
}

describe('R5 meeting prep', () => {
  it('returns 404 for another tenant or an invisible private meeting', async () => {
    const { service, tx } = setup();
    tx.meeting.findFirst.mockResolvedValueOnce(null);
    await expect(service.generate(ctx, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.meetingPrep.create).not.toHaveBeenCalled();
    const hidden = setup('client-one', false);
    await expect(hidden.service.generate(ctx, input)).rejects.toBeInstanceOf(NotFoundException);
    expect(hidden.tx.meeting.findFirst.mock.calls[0]?.[0].where.OR).toEqual([
      { createdByUserId: ctx.userId }, { connection: { createdByUserId: ctx.userId } },
    ]);
  });
  it('rejects a different or unlinked client with 409', async () => {
    for (const client of ['another-client', null]) {
      const { service, tx } = setup(client);
      await expect(service.generate(ctx, input)).rejects.toBeInstanceOf(ConflictException);
      expect(tx.meetingPrep.create).not.toHaveBeenCalled();
    }
  });
  it('creates one deterministic prep, repeats idempotently, and leaves other artifacts untouched', async () => {
    const { service, tx, preps, notes, debriefs } = setup();
    const first = await service.generate(ctx, input);
    const second = await service.generate(ctx, input);
    expect(second.id).toBe(first.id);
    expect(tx.meetingPrep.create).toHaveBeenCalledTimes(1);
    expect(preps).toHaveLength(2);
    expect(notes).toEqual([{ id: 'note' }]); expect(debriefs).toEqual([{ id: 'debrief' }]);
    expect(first.generatedFrom).toMatchObject({ factIds: [fact.id], evidence: [fact] });
    expect(first.agenda).toContainEqual({ text: expect.stringContaining('Site'), factIds: [fact.id] });
    expect(first.provider).toBeNull(); expect(first.model).toBeNull();
  });
  it('edits only district preps, retains fact refs, and marks reviewed', async () => {
    const { service, preps } = setup();
    await expect(service.edit(ctx, 'classic', { reviewed: true })).rejects.toBeInstanceOf(NotFoundException);
    const created = await service.generate(ctx, input);
    const result = await service.edit(ctx, created.id, { agenda: [{ text: 'Edited', factIds: [fact.id] }], reviewed: true });
    expect(result.status).toBe('reviewed'); expect(result.editedByUserId).toBe(ctx.userId);
    expect(result.generatedFrom).toMatchObject({ factIds: [fact.id] });
    expect(preps[0]).toEqual({ id: 'classic', generatedFrom: { kind: 'classic' } });
  });
});
