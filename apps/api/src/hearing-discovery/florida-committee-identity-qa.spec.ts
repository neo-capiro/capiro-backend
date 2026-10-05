import type { PrismaClient } from '@prisma/client';
import { resolveFloridaAgenda } from './florida-calendar-discovery.js';
import type { LegislativeObservation } from './legislative-calendar.js';

describe('House notices without CommitteeId', () => {
  const body = {
    id: 'FL-lower-commerce',
    name: 'Commerce',
    officialSourceKey: 'FL:2026:fl:house:committee:3285',
    sourceEvidence: { directory: { active: true } },
  };
  function setup(rows: unknown[]) {
    const db = {
      stateCommittee: {
        findMany: jest.fn().mockResolvedValue(rows),
        upsert: jest.fn().mockResolvedValue(body),
      },
    };
    const observation = {
      jurisdiction: 'FL',
      session: '2026',
      chamber: 'house',
      bodyName: 'Commerce Committee',
      eventType: 'committee',
      bodySourceKey: 'fl:house:unresolved-body:15112',
      stateCommitteeId: null,
      fields: { agenda: [] },
    } as unknown as LegislativeObservation;
    return { db, observation };
  }
  it('qualifies an exact unique official directory name within the notice session and chamber', async () => {
    const { db, observation } = setup([body]);
    await resolveFloridaAgenda(db as unknown as PrismaClient, observation);
    expect(db.stateCommittee.findMany).toHaveBeenCalledWith({
      where: {
        state: 'FL',
        legislativeSession: '2026',
        officialSourceKey: { startsWith: 'FL:2026:fl:house:' },
      },
    });
    expect(observation.stateCommitteeId).toBe(body.id);
    expect(observation.bodySourceKey).toBe('fl:house:committee:3285');
  });
  it.each([
    [body, { ...body, id: 'ambiguous' }],
    [{ ...body, name: 'Commerce and Tourism' }],
    [{ ...body, sourceEvidence: { directory: { active: false } } }],
  ])('retains unresolved identity for ambiguous, different or retired bodies', async (...rows) => {
    const { db, observation } = setup(rows);
    await resolveFloridaAgenda(db as unknown as PrismaClient, observation);
    expect(observation.stateCommitteeId).toBeNull();
    expect(db.stateCommittee.upsert).not.toHaveBeenCalled();
  });
});
