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

  it.each([
    ['Rules & Ethics Committee', 'Rules and Ethics', '3301'],
    ['Health & Human Services Committee', 'Health and Human Services', '3294'],
    ['Education & Employment Committee', 'Education and Employment', '3290'],
    ['Ways & Means Committee', 'Ways and Means', '3306'],
    ['Security & Threat Assessment Committee', 'Security and Threat Assessment', '3307'],
  ])('resolves the official ampersand spelling for %s', async (noticeName, directoryName, code) => {
    const officialBody = {
      ...body,
      id: `official-${code}`,
      name: directoryName,
      officialSourceKey: `FL:2026:fl:house:committee:${code}`,
    };
    const { db, observation } = setup([officialBody]);
    db.stateCommittee.upsert.mockResolvedValue(officialBody);
    observation.bodyName = noticeName;

    await resolveFloridaAgenda(db as unknown as PrismaClient, observation);

    expect(observation.stateCommitteeId).toBe(officialBody.id);
    expect(observation.bodySourceKey).toBe(`fl:house:committee:${code}`);
    expect(db.stateCommittee.findMany).toHaveBeenCalledWith({
      where: {
        state: 'FL',
        legislativeSession: '2026',
        officialSourceKey: { startsWith: 'FL:2026:fl:house:' },
      },
    });
  });

  it('does not choose between directory identities that collide after ampersand normalization', async () => {
    const { db, observation } = setup([
      { ...body, name: 'Ways and Means', officialSourceKey: 'FL:2026:fl:house:committee:3306' },
      {
        ...body,
        id: 'different-body',
        name: 'Ways & Means',
        officialSourceKey: 'FL:2026:fl:house:committee:9999',
      },
    ]);
    observation.bodyName = 'Ways & Means Committee';

    await resolveFloridaAgenda(db as unknown as PrismaClient, observation);

    expect(observation.stateCommitteeId).toBeNull();
    expect(observation.bodySourceKey).toContain('unresolved-body');
    expect(db.stateCommittee.upsert).not.toHaveBeenCalled();
  });
});
