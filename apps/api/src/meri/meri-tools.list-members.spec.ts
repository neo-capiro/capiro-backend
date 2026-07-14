import { MeriToolsService } from './meri-tools.service.js';

/**
 * Unit tests for the list_members tool (the by-state/chamber federal member
 * roster lookup that resolve_entity — a name matcher — could not express).
 * The heavy dep is just prisma.congressMember.findMany, so an uninitialized
 * prototype instance with a stubbed prisma is enough to exercise the handler:
 * state normalization (2-letter → full name), fail-closed on no filter / bad
 * state, and the query shape (isCurrent + chamber + case-insensitive state).
 */
type ListMembers = (input: Record<string, unknown>) => Promise<{
  matchesFound: number;
  members: Array<{ name: string; district: number | null; chamber: string }>;
  filter?: { state: string | null; chamber: string | null };
  note: string;
}>;

function makeService(rows: unknown[] = []) {
  const findMany = jest.fn().mockResolvedValue(rows);
  const service = Object.create(MeriToolsService.prototype) as MeriToolsService;
  (service as unknown as { prisma: unknown }).prisma = { congressMember: { findMany } };
  const listMembers = (service as unknown as { listMembers: ListMembers }).listMembers.bind(service);
  return { listMembers, findMany };
}

describe('list_members tool', () => {
  it('fails closed with a note when neither state nor chamber is given (no full-roster dump)', async () => {
    const { listMembers, findMany } = makeService();
    const out = await listMembers({});
    expect(out.matchesFound).toBe(0);
    expect(out.members).toEqual([]);
    expect(out.note).toMatch(/at least one filter/i);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('fails closed on an unrecognized state rather than querying', async () => {
    const { listMembers, findMany } = makeService();
    const out = await listMembers({ state: 'Freedonia' });
    expect(out.matchesFound).toBe(0);
    expect(out.note).toMatch(/not a recognized US state/i);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('translates a 2-letter code to the full state name the column stores', async () => {
    const { listMembers, findMany } = makeService([
      { bioguideId: 'W000805', fullName: 'Mark R. Warner', party: 'D', state: 'Virginia', district: null, chamber: 'senate' },
      { bioguideId: 'K000384', fullName: 'Tim Kaine', party: 'D', state: 'Virginia', district: null, chamber: 'senate' },
    ]);
    const out = await listMembers({ state: 'VA', chamber: 'senate' });
    const where = findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ isCurrent: true, chamber: 'senate' });
    expect(where.state).toEqual({ equals: 'Virginia', mode: 'insensitive' });
    expect(out.filter).toEqual({ state: 'Virginia', chamber: 'senate' });
    expect(out.matchesFound).toBe(2);
    expect(out.members.map((m) => m.name)).toEqual(['Mark R. Warner', 'Tim Kaine']);
    // senators carry no district
    expect(out.members.every((m) => m.district === null)).toBe(true);
  });

  it('accepts a full state name in any case and reports districts for House members', async () => {
    const { listMembers, findMany } = makeService([
      { bioguideId: 'X', fullName: 'Rep A', party: 'R', state: 'Florida', district: 1, chamber: 'house' },
    ]);
    const out = await listMembers({ state: 'florida', chamber: 'house' });
    const where = findMany.mock.calls[0][0].where;
    expect(where.state).toEqual({ equals: 'Florida', mode: 'insensitive' });
    expect(out.members[0]!.district).toBe(1);
  });

  it('allows a chamber-only query (no state filter)', async () => {
    const { listMembers, findMany } = makeService([]);
    await listMembers({ chamber: 'senate' });
    const where = findMany.mock.calls[0][0].where;
    expect(where.chamber).toBe('senate');
    expect('state' in where).toBe(false);
  });

  it('ignores an invalid chamber value', async () => {
    const { listMembers, findMany } = makeService([]);
    await listMembers({ state: 'Texas', chamber: 'both' });
    const where = findMany.mock.calls[0][0].where;
    expect('chamber' in where).toBe(false);
    expect(where.state).toEqual({ equals: 'Texas', mode: 'insensitive' });
  });
});
