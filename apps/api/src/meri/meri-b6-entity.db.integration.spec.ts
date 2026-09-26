import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriToolsService } from './meri-tools.service.js';

/**
 * Opt-in B6 acceptance against a fully migrated, disposable local Postgres.
 * The exact loopback URL guard prevents accidental writes to a shared DB.
 * MERI_B6_ENTITY_TEST_DATABASE_URL=postgresql://...@127.0.0.1:55447/b6_entity_accept?schema=public
 */
const databaseUrl = process.env.MERI_B6_ENTITY_TEST_DATABASE_URL;
const parsed = databaseUrl ? new URL(databaseUrl) : null;
const isolated = Boolean(
  parsed?.protocol === 'postgresql:' &&
  parsed.hostname === '127.0.0.1' &&
  parsed.port === '55447' &&
  parsed.pathname === '/b6_entity_accept' &&
  parsed.searchParams.get('schema') === 'public' &&
  parsed.username === 'b6_entity_test' &&
  parsed.password.length > 0,
);
const describeDb = isolated ? describe : describe.skip;

type ToolMethod =
  | 'resolveEntity'
  | 'getBillStatus'
  | 'searchFloorVotes'
  | 'getStateBillStatus'
  | 'searchStateFloorVotes';
type ToolResult = Record<string, unknown> & {
  matches?: Array<Record<string, unknown> & { sourceRef?: Record<string, unknown> }>;
};

describeDb('Meri B6 entity provenance on migrated disposable PostgreSQL', () => {
  const namespace = `meri-b6-entity-${randomUUID()}`;
  const tenantId = randomUUID();
  const userId = randomUUID();
  const clientId = randomUUID();
  const crosswalkId = randomUUID();
  const memberId = 'B006441';
  const committeeId = 'hsbq44';
  const federalBillId = '119-hr-8800';
  const stateBill2025 = 'tx-2025-hb8123';
  const stateBill2027 = 'tx-2027-hb8123';
  const statePersonId = 'ocd-person/b6case441';
  const federalVoteId = 'house-119-1-6441';
  const stateVoteId = 'tx-rc-6441';
  const memberUpdatedAt = new Date('2026-05-21T12:00:00.000Z');
  const memberSyncedAt = new Date('2026-05-22T09:00:00.000Z');
  const billEventDate = new Date('2026-06-03T00:00:00.000Z');
  const billUpdatedAt = new Date('2026-06-03T18:00:00.000Z');
  const billSyncedAt = new Date('2026-06-04T08:00:00.000Z');
  const stateEventDate = new Date('2025-03-15T00:00:00.000Z');
  const stateCheckedAt = new Date('2025-03-16T10:00:00.000Z');
  const stateSyncedAt = new Date('2025-03-17T10:00:00.000Z');
  const federalBillUrl = 'https://www.congress.gov/bill/119th-congress/house-bill/8800';
  const committeeUrl = 'https://www.congress.gov/committee/house-b6-committee/hsbq44';
  const stateBillUrl = 'https://capitol.texas.gov/BillLookup/History.aspx?LegSess=89R&Bill=HB8123';

  let db: PrismaService;
  let service: MeriToolsService;

  const call = (method: ToolMethod, input: Record<string, unknown>): Promise<ToolResult> => {
    const fn = (
      service as unknown as Record<
        ToolMethod,
        (arg: Record<string, unknown>) => Promise<ToolResult>
      >
    )[method];
    return fn.call(service, input);
  };

  beforeAll(async () => {
    db = new PrismaService({ datasources: { db: { url: databaseUrl } } });
    await db.$connect();
    await db.tenant.create({
      data: { id: tenantId, slug: namespace, name: namespace, status: 'active' },
    });
    await db.user.create({
      data: {
        id: userId,
        clerkUserId: `${namespace}-user`,
        email: `${namespace}@example.invalid`,
      },
    });
    await db.client.create({
      data: {
        id: clientId,
        tenantId,
        name: `${namespace} client`,
        status: 'active',
        memoryWall: false,
      },
    });

    await db.congressMember.createMany({
      data: [
        {
          bioguideId: memberId,
          firstName: 'B6',
          lastName: 'Quill',
          fullName: 'B6 Quill',
          chamber: 'house',
          state: 'Texas',
          party: 'Independent',
          isCurrent: true,
          updateDate: memberUpdatedAt,
          lastSyncedAt: memberSyncedAt,
        },
        {
          bioguideId: 'B006442',
          firstName: 'B6',
          lastName: 'Quill',
          fullName: 'B6 Quill',
          chamber: 'house',
          state: 'Ohio',
          party: 'Independent',
          isCurrent: true,
        },
      ],
    });
    await db.congressCommittee.create({
      data: {
        systemCode: committeeId,
        thomasId: 'B644',
        name: 'House B6 Fixture Committee',
        chamber: 'house',
        url: committeeUrl,
        urlSource: 'congress_gov',
        urlVerifiedAt: new Date('2026-05-23T10:00:00.000Z'),
        lastSyncedAt: new Date('2026-05-24T10:00:00.000Z'),
      },
    });
    await db.congressBill.create({
      data: {
        id: federalBillId,
        congress: 119,
        billType: 'hr',
        billNumber: '8800',
        title: 'B6 synthetic federal bill',
        status: 'committee',
        latestActionText: 'Referred to committee',
        latestActionDate: billEventDate,
        url: federalBillUrl,
        updateDate: billUpdatedAt,
        lastSyncedAt: billSyncedAt,
      },
    });
    await db.entityCrosswalk.create({
      data: {
        id: crosswalkId,
        idType: 'lis',
        idValue: 'LIS-B6-441',
        entityType: 'member',
        entityKey: memberId,
        source: 'b6-synthetic-member-sync',
        confidence: 0.98,
        lastSyncedAt: new Date('2026-05-23T08:00:00.000Z'),
      },
    });

    await db.stateBill.createMany({
      data: [
        {
          id: stateBill2025,
          state: 'TX',
          session: '89th Regular',
          sessionKey: '2025',
          identifier: 'HB 8123',
          billNumber: 'hb8123',
          title: 'B6 synthetic 2025 state bill',
          status: 'introduced',
          latestActionText: 'Filed',
          latestActionDate: stateEventDate,
          stateUrl: stateBillUrl,
          sourceCheckedAt: stateCheckedAt,
          syncedAt: stateSyncedAt,
        },
        {
          id: stateBill2027,
          state: 'TX',
          session: '90th Regular',
          sessionKey: '2027',
          identifier: 'HB 8123',
          billNumber: 'hb8123',
          title: 'B6 synthetic 2027 state bill',
          status: 'introduced',
          syncedAt: new Date('2027-03-17T10:00:00.000Z'),
        },
      ],
    });
    await db.stateLegislator.create({
      data: {
        id: statePersonId,
        name: 'B6 State Person',
        state: 'TX',
        chamber: 'lower',
        district: '44',
        party: 'I',
        url: null,
        syncedAt: new Date('2025-04-01T08:00:00.000Z'),
      },
    });
    await db.rollCallVote.create({
      data: {
        id: federalVoteId,
        chamber: 'house',
        congress: 119,
        session: 1,
        rollNumber: 6441,
        billId: federalBillId,
        question: 'B6 fixture question',
        result: 'Passed',
        voteDate: new Date('2026-06-04T17:00:00.000Z'),
        yeas: 210,
        nays: 200,
        source: 'b6-synthetic',
      },
    });
    await db.stateRollCallVote.create({
      data: {
        id: stateVoteId,
        legiscanRollCallId: 996441,
        billKey: stateBill2025,
        chamber: 'lower',
        date: new Date('2025-03-18T00:00:00.000Z'),
        motion: 'B6 fixture third reading',
        yeas: 90,
        nays: 50,
        passed: true,
      },
    });

    service = Object.create(MeriToolsService.prototype) as MeriToolsService;
    (service as unknown as { prisma: PrismaService }).prisma = db;
  }, 120_000);

  afterAll(async () => {
    if (db) await db.$disconnect();
  }, 120_000);

  test('federal IDs and crosswalk expose exact persisted provenance, not invented URLs', async () => {
    const rawMember = await db.congressMember.findUniqueOrThrow({
      where: { bioguideId: memberId },
    });
    const member = await call('resolveEntity', { query: memberId, type: 'member' });
    expect(member).toMatchObject({ resolution: 'resolved', matchesFound: 1 });
    expect(member.matches?.[0]).toMatchObject({
      canonicalId: memberId,
      matchedBy: 'bioguide-id',
      sourceRef: {
        namespace: 'congress_member',
        recordId: rawMember.bioguideId,
        sourceUrl: null,
        eventDate: null,
        sourceUpdatedAt: memberUpdatedAt,
        sourceCheckedAt: null,
        syncedAt: memberSyncedAt,
      },
    });

    const crosswalk = await call('resolveEntity', { query: 'LIS-B6-441', type: 'member' });
    expect(crosswalk.matches?.[0]).toMatchObject({
      canonicalId: memberId,
      matchedBy: 'lis-crosswalk',
      sourceRef: {
        crosswalk: {
          namespace: 'entity_crosswalk',
          recordId: crosswalkId,
          idType: 'lis',
          idValue: 'LIS-B6-441',
          source: 'b6-synthetic-member-sync',
          confidence: 0.98,
          syncedAt: new Date('2026-05-23T08:00:00.000Z'),
        },
      },
    });

    const committee = await call('resolveEntity', {
      query: committeeId.toUpperCase(),
      type: 'committee',
    });
    expect(committee.matches?.[0]).toMatchObject({
      canonicalId: committeeId,
      sourceRef: {
        namespace: 'congress_committee',
        recordId: committeeId,
        sourceUrl: committeeUrl,
        eventDate: null,
        sourceUpdatedAt: null,
        sourceCheckedAt: new Date('2026-05-23T10:00:00.000Z'),
        syncedAt: new Date('2026-05-24T10:00:00.000Z'),
        urlAuthority: 'congress_gov',
      },
    });
  });

  test('qualified federal designation passes its exact canonical ID to status and votes', async () => {
    const rawBill = await db.congressBill.findUniqueOrThrow({ where: { id: federalBillId } });
    const resolved = await call('resolveEntity', {
      query: 'H.R. 8800',
      type: 'bill',
      congress: 119,
    });
    expect(resolved.matches?.[0]).toMatchObject({
      canonicalId: rawBill.id,
      congress: 119,
      sourceRef: {
        namespace: 'congress_bill',
        recordId: rawBill.id,
        sourceUrl: federalBillUrl,
        eventDate: billEventDate,
        sourceUpdatedAt: billUpdatedAt,
        sourceCheckedAt: null,
        syncedAt: billSyncedAt,
      },
    });
    expect(await call('getBillStatus', { billId: 'H.R. 8800', congress: 119 })).toMatchObject({
      found: true,
      billId: federalBillId,
      status: rawBill.status,
    });
    expect(await call('searchFloorVotes', { billId: federalBillId })).toMatchObject({
      votesFound: 1,
      votes: [{ id: federalVoteId, billId: federalBillId }],
    });

    expect(await call('resolveEntity', { query: 'H.R. 8800', type: 'bill' })).toMatchObject({
      resolution: 'needs_context',
      matchesFound: 0,
    });
    expect(await call('getBillStatus', { billId: 'H.R. 8800' })).toMatchObject({ found: false });
    expect(await call('searchFloorVotes', { billId: 'H.R. 8800' })).toMatchObject({
      resolution: 'needs_context',
      votesFound: 0,
      votes: [],
    });
    expect(
      await call('resolveEntity', { query: federalBillId, type: 'bill', congress: 118 }),
    ).toMatchObject({ resolution: 'invalid_context', matchesFound: 0 });
  });

  test('two state sessions stay ambiguous until selected, then readers use only that key', async () => {
    const ambiguous = await call('resolveEntity', { query: 'TX HB 8123', type: 'state_bill' });
    expect(ambiguous).toMatchObject({
      resolution: 'ambiguous',
      matchesFound: 0,
      candidateIds: [stateBill2027, stateBill2025],
    });
    expect(await call('getStateBillStatus', { billId: 'TX HB 8123' })).toMatchObject({
      found: false,
      resolution: 'ambiguous',
      candidateIds: [stateBill2027, stateBill2025],
    });
    expect(await call('searchStateFloorVotes', { billId: 'TX HB 8123' })).toMatchObject({
      votesFound: 0,
      votes: [],
      resolution: 'ambiguous',
    });

    const rawBill = await db.stateBill.findUniqueOrThrow({ where: { id: stateBill2025 } });
    const selected = await call('resolveEntity', {
      query: 'TX HB 8123',
      type: 'state_bill',
      state: 'TX',
      sessionKey: '2025',
    });
    expect(selected.matches?.[0]).toMatchObject({
      canonicalId: rawBill.id,
      state: 'TX',
      session: '2025',
      sourceRef: {
        namespace: 'state_bill',
        recordId: rawBill.id,
        sourceUrl: stateBillUrl,
        eventDate: stateEventDate,
        sourceUpdatedAt: null,
        sourceCheckedAt: stateCheckedAt,
        syncedAt: stateSyncedAt,
      },
    });
    expect(
      await call('getStateBillStatus', { billId: 'TX HB 8123', sessionKey: '2025' }),
    ).toMatchObject({ found: true, billId: stateBill2025, status: rawBill.status });
    expect(
      await call('searchStateFloorVotes', { billId: 'TX HB 8123', sessionKey: '2025' }),
    ).toMatchObject({ votesFound: 1, votes: [{ id: stateVoteId, billKey: stateBill2025 }] });
    expect(
      await call('resolveEntity', { query: stateBill2025, type: 'state_bill', state: 'CA' }),
    ).toMatchObject({ resolution: 'invalid_context', matchesFound: 0 });
    expect(
      await call('resolveEntity', { query: stateBill2025, type: 'state_bill', sessionKey: '2027' }),
    ).toMatchObject({ resolution: 'invalid_context', matchesFound: 0 });
    expect(await call('searchStateFloorVotes', { billId: 'TX HB 9999' })).toMatchObject({
      votesFound: 0,
      votes: [],
    });
  });

  test('missing source fields remain null; ambiguous and absent people never become identities', async () => {
    const person = await call('resolveEntity', {
      query: statePersonId,
      type: 'state_legislator',
      state: 'TX',
    });
    expect(person.matches?.[0]).toMatchObject({
      canonicalId: statePersonId,
      sourceRef: {
        namespace: 'state_legislator',
        recordId: statePersonId,
        sourceUrl: null,
        eventDate: null,
        sourceUpdatedAt: null,
        sourceCheckedAt: null,
        syncedAt: new Date('2025-04-01T08:00:00.000Z'),
      },
    });
    expect(await call('resolveEntity', { query: 'Quill', type: 'member', limit: 1 })).toMatchObject(
      { resolution: 'ambiguous', matchesFound: 1, candidateCountAtLeast: 2 },
    );
    expect(
      await call('resolveEntity', { query: 'B6 Nobody Unloaded', type: 'member' }),
    ).toMatchObject({ resolution: 'not_found', matchesFound: 0, matches: [] });
  });
});
