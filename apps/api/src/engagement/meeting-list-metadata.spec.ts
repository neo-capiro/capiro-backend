import { describe, expect, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { EngagementService } from './engagement.service.js';

const ctx = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  clerkUserId: 'clerk-synthetic',
  role: 'standard_user',
} as TenantContext;

/** A prep with the body text that used to travel in every calendar list row. */
function prep(id: string, meetingId: string) {
  return {
    id,
    meetingId,
    clientId: null,
    status: 'approved',
    summary: `PREP-SUMMARY-${id} `.repeat(40),
    agenda: Array.from({ length: 6 }, (_, index) => `AGENDA-${id}-${index} `.repeat(6)),
    talkingPoints: Array.from({ length: 6 }, (_, index) => `TALKING-${id}-${index} `.repeat(6)),
    risks: Array.from({ length: 4 }, (_, index) => `RISK-${id}-${index} `.repeat(6)),
    followUps: Array.from({ length: 4 }, (_, index) => `FOLLOW-${id}-${index} `.repeat(6)),
    emailEvidence: [`EMAIL-EVIDENCE-${id} `.repeat(10)],
    generatedFrom: {
      schemaVersion: 'grounded-v1',
      grounding: { sources: Array.from({ length: 8 }, () => ({ title: 'SOURCE-TITLE '.repeat(8) })) },
    },
    provider: 'anthropic',
    model: 'synthetic-model',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    sharedAt: null,
    sharedByUserId: null,
  };
}

/** Notes and debriefs are already metadata-projected by decorateMeetings; bodies live here. */
function note(id: string, meetingId: string) {
  return {
    id,
    meetingId,
    clientId: null,
    status: 'approved',
    confidential: false,
    accessLevel: 'private',
    authorUserId: null,
    keyVersion: 'v1',
    createdAt: new Date('2026-10-01T00:00:00.000Z'),
    updatedAt: new Date('2026-10-02T00:00:00.000Z'),
    sharedAt: null,
    sharedByUserId: null,
    // what a metadata projection must NOT carry:
    body: `NOTE-BODY-${id} `.repeat(30),
  };
}

function meetingRow(id: string) {
  return {
    id,
    clientId: null,
    client: null,
    subject: `Meeting ${id}`,
    startsAt: new Date('2026-10-12T13:00:00.000Z'),
    endsAt: new Date('2026-10-12T14:00:00.000Z'),
    createdByUserId: null,
    sharedByUserId: null,
    notes: [note(`n-${id}`, id)],
    debriefs: [note(`d-${id}`, id)],
    preps: [prep(`p-${id}`, id)],
  };
}

/**
 * The projection under test sits at the LIST return boundary. `decorateMeetings` is
 * stubbed with today's real output shape (metadata notes/debriefs, full preps) so the
 * assertion is about the boundary, not about re-proving the artifact projection.
 */
function harness() {
  const rows = [meetingRow('m1'), meetingRow('m2')];
  const service = Object.create(EngagementService.prototype) as EngagementService;
  const s = service as unknown as Record<string, unknown>;
  const tx = {
    tenantMembership: { findFirst: async () => ({ role: 'standard_user' }) },
    meeting: { findMany: async () => rows, findFirst: async () => rows[0] },
    client: { findFirst: async () => null },
  };
  s.prisma = { withTenantUser: async (_t: string, _u: string, fn: (tx: unknown) => unknown) => fn(tx) };
  // decorateMeetings adds meri/contributors and projects notes/debriefs to metadata.
  s.decorateMeetings = async (_tx: unknown, _ctx: unknown, input: Array<Record<string, unknown>>) =>
    input.map((row) => ({
      ...row,
      notes: (row.notes as Array<Record<string, unknown>>).map(({ body: _body, ...meta }) => meta),
      debriefs: (row.debriefs as Array<Record<string, unknown>>).map(({ body: _body, ...meta }) => meta),
      notesApproved: true,
      meri: null,
      meriError: null,
      contributors: [],
      sharedBy: null,
    }));
  return { service, rows };
}

describe('D5 — calendar list rows carry artifact metadata only', () => {
  test('no prep body text or ciphertext field survives the list boundary', async () => {
    const { service } = harness();

    const listed = await service.listMeetings(ctx, {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
    const serialized = JSON.stringify(listed);

    expect(listed).toHaveLength(2);
    for (const marker of [
      'PREP-SUMMARY',
      'AGENDA-',
      'TALKING-',
      'RISK-',
      'FOLLOW-',
      'EMAIL-EVIDENCE',
      'SOURCE-TITLE',
      'generatedFrom',
      'bodyCiphertext',
      'NOTE-BODY',
    ])
      expect(serialized).not.toContain(marker);

    // The list keeps what list consumers read: identity + lifecycle status.
    const first = listed[0] as unknown as { preps: Array<Record<string, unknown>> };
    expect(first.preps[0]).toMatchObject({ status: 'approved', provider: 'anthropic' });
    expect(Object.keys(first.preps[0]!).sort()).toEqual(
      ['clientId', 'createdAt', 'id', 'meetingId', 'model', 'provider', 'sharedAt', 'sharedByUserId', 'status', 'updatedAt'],
    );
  });

  test('the detail read for the same meeting still returns the prep body', async () => {
    const { service } = harness();

    const detail = await service.getMeeting(ctx, 'm1');
    const serialized = JSON.stringify(detail);

    expect(serialized).toContain('PREP-SUMMARY');
    expect(serialized).toContain('AGENDA-');
    // ...and the note body is still not in the meeting payload: notes/debriefs were
    // already metadata-projected before this change, at every meeting read.
    expect(serialized).not.toContain('NOTE-BODY');
  });

  test('records the payload delta for a two-meeting fixture', async () => {
    const { service } = harness();

    const listed = await service.listMeetings(ctx, {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
    });
    const detail = await service.getMeeting(ctx, 'm1');
    const listBytes = Buffer.byteLength(JSON.stringify(listed), 'utf8');
    const detailRowBytes = Buffer.byteLength(JSON.stringify(detail), 'utf8');
    const withBodiesBytes = Buffer.byteLength(
      JSON.stringify([detail, detail].map((row, index) => ({ ...row, id: `m${index + 1}` }))),
      'utf8',
    );

    // eslint-disable-next-line no-console
    process.stderr.write(
      `D5 SIZES listTwo=${listBytes} detailOne=${detailRowBytes} listWithBodies≈${withBodiesBytes}\n`,
    );
    expect(listBytes).toBeLessThan(withBodiesBytes);
  });
});
