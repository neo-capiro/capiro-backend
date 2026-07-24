import { describe, expect, jest, test } from '@jest/globals';
import { DirectoryService } from './directory.service.js';

/**
 * WS-G, LegiStorm gaps/enrichment plan (optional temporal enrichment) —
 * getAllCommitteeMemberships. This method exists purely to give
 * emit-committee-changes.ts (a plain script, no NestJS DI) a way to reuse
 * DirectoryService's already-built committee index without re-implementing
 * its private buildContacts/buildCommitteeIndex logic standalone. Testing
 * it directly here (rather than only through the script) pins the
 * endedAt===null filter, since membershipsByCommitteeId is documented to
 * include FORMER memberships too ("current or former" — directory-
 * indexes.ts's own doc comment on committeesByPersonId).
 */
describe('DirectoryService.getAllCommitteeMemberships (WS-G)', () => {
  function makeService(membershipsByCommitteeId: Map<string, unknown[]>): DirectoryService {
    const config = { get: jest.fn().mockReturnValue('us-east-1') } as any;
    const prisma = {} as any;
    const representation = {} as any;
    const service = new DirectoryService(config, prisma, representation);
    // getDirectoryData() is private and S3-backed; stub it directly rather
    // than construct a full snapshot fixture, mirroring how this method's
    // ONLY job is to flatten+filter base.indexes.membershipsByCommitteeId.
    // jest.spyOn on a cast-to-any reference is this codebase's established
    // pattern for overriding a private method on a hand-built instance
    // (see intelligence.district-bills.spec.ts's identical technique).
    jest.spyOn(service as any, 'getDirectoryData').mockResolvedValue({
      indexes: { membershipsByCommitteeId },
    } as any);
    return service;
  }

  const activeMembership = (overrides: Record<string, unknown> = {}) => ({
    committeeId: 'committee-2053',
    person: { id: 'member-533', fullName: 'Roger Wicker' },
    membershipType: 'member',
    position: 'Co-Chair',
    party: 'Republican',
    rank: 1,
    status: null,
    startedAt: '2025-12-09',
    endedAt: null,
    sourceUpdatedAt: '2026-07-22T12:46:32',
    ...overrides,
  });

  test('flattens memberships across multiple committees into one list', async () => {
    const map = new Map<string, unknown[]>([
      ['committee-2053', [activeMembership()]],
      ['committee-100', [activeMembership({ committeeId: 'committee-100', person: { id: 'member-2', fullName: 'Other Member' } })]],
    ]);
    const service = makeService(map);

    const result = await service.getAllCommitteeMemberships();

    expect(result).toHaveLength(2);
    expect(result.map((m) => m.committeeId).sort()).toEqual(['committee-100', 'committee-2053']);
  });

  test('excludes a FORMER membership (endedAt set) — membershipsByCommitteeId includes both current and former', async () => {
    const map = new Map<string, unknown[]>([
      [
        'committee-2053',
        [
          activeMembership(), // current — endedAt: null
          activeMembership({
            person: { id: 'member-999', fullName: 'Former Member' },
            endedAt: '2024-01-01',
          }),
        ],
      ],
    ]);
    const service = makeService(map);

    const result = await service.getAllCommitteeMemberships();

    expect(result).toHaveLength(1);
    expect(result[0]!.person.id).toBe('member-533');
  });

  test('returns an empty array when there are no committees at all, never throws', async () => {
    const service = makeService(new Map());
    const result = await service.getAllCommitteeMemberships();
    expect(result).toEqual([]);
  });
});
