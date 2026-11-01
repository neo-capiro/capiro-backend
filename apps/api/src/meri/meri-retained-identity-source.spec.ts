jest.mock('../clients/client-capabilities.service.js', () => ({ ClientCapabilitiesService: jest.fn() }));
jest.mock('../clients/client-people.service.js', () => ({ ClientPeopleService: jest.fn() }));
jest.mock('../clients/client-facilities.service.js', () => ({ ClientFacilitiesService: jest.fn() }));
jest.mock('../engagement/mail-sender.service.js', () => ({ EngagementMailSender: jest.fn() }));
jest.mock('../regulatory-docket/regulatory-docket.service.js', () => ({ RegulatoryDocketService: jest.fn() }));
jest.mock('../lda-intel/lda-intel.service.js', () => ({ LdaIntelService: jest.fn() }));
jest.mock('../lobby-intel/lobby-intel.service.js', () => ({ LobbyIntelService: jest.fn() }));
jest.mock('../federal-spending/federal-spending.service.js', () => ({ FederalSpendingService: jest.fn() }));
jest.mock('../intelligence/actions/action-recommendation-read.service.js', () => ({ ActionRecommendationReadService: jest.fn() }));
jest.mock('../intelligence/intelligence.service.js', () => ({ IntelligenceService: jest.fn() }));
jest.mock('../clients/clients.service.js', () => ({ ClientsService: jest.fn() }));
jest.mock('../embeddings/client-kb.service.js', () => ({ ClientKbService: jest.fn() }));
jest.mock('../program-element/program-element-read.service.js', () => ({ ProgramElementReadService: jest.fn() }));
jest.mock('../acquisition-personnel/acquisition-personnel-read.service.js', () => ({ AcquisitionPersonnelReadService: jest.fn() }));
jest.mock('../memory/memory-candidate.service.js', () => ({ MemoryCandidateService: jest.fn() }));
jest.mock('../memory/memory-ingest.service.js', () => ({ MemoryIngestService: jest.fn() }));
jest.mock('../memory/memory-store.service.js', () => ({ MemoryStoreService: jest.fn() }));
jest.mock('../clients/representation-resolver.service.js', () => ({ RepresentationResolverService: jest.fn() }));
jest.mock('./meri-docgen.service.js', () => ({ MeriDocgenService: jest.fn() }));
jest.mock('./meri-context-plane.service.js', () => ({ MeriContextPlaneService: jest.fn() }));
jest.mock('../funding-opportunities/meri-opportunity-tools.adapter.js', () => ({ MeriOpportunityToolsAdapter: jest.fn() }));
jest.mock('../engagement/engagement.service.js', () => ({ EngagementService: jest.fn() }));
jest.mock('./meri-defense-budget-tool.helpers.js', () => ({}));
jest.mock('../memory/memory-wall.helpers.js', () => ({
  ...jest.requireActual('../memory/memory-wall.helpers.js'),
  clientMemoryAllowed: jest.fn(async () => true),
}));

import { MeriToolsService } from './meri-tools.service.js';
import { clientMemoryAllowed } from '../memory/memory-wall.helpers.js';

const CLIENT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const ACTOR = { tenantId: '33333333-3333-4333-8333-333333333333', userId: '44444444-4444-4444-8444-444444444444', role: 'standard_user' };
const member = {
  bioguideId: 'A000360', fullName: 'Ada Example', party: 'I', state: 'VA', district: 1,
  chamber: 'house', lisId: 'S390', isCurrent: true,
};

const serviceWith = (prisma: unknown) => Object.assign(Object.create(MeriToolsService.prototype), { prisma }) as MeriToolsService;

describe('trusted retained identity source', () => {
  it('uses the trusted defaultCongress for bill designation lookup', async () => {
    const findUnique = jest.fn(async () => ({
      id: '119-hr-1234', title: 'A bill', congress: 119, sponsorName: null,
      sponsorBioguideId: null, latestActionText: null, latestActionDate: null,
    }));
    const service = serviceWith({ congressBill: { findUnique } });
    const result = await service.resolveEntityForRetainedSource(
      { query: 'H.R. 1234', type: 'bill', limit: 5 }, { defaultCongress: 119 },
    );
    expect(findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: '119-hr-1234' } }));
    expect(result.matches).toMatchObject([{ canonicalId: '119-hr-1234', matchedBy: 'bill-id' }]);
  });

  it('keeps direct, crosswalk, and name phases exclusive and deduplicates retained crosswalk rows', async () => {
    const findUnique = jest.fn(async () => member);
    const crosswalk = jest.fn(async () => [
      { entityType: 'member', entityKey: 'A000360', idType: 'lis' },
      { entityType: 'member', entityKey: 'A000360', idType: 'govtrack' },
    ]);
    const findMany = jest.fn(async () => []);
    const service = serviceWith({
      congressMember: { findUnique, findMany }, entityCrosswalk: { findMany: crosswalk },
    });
    const direct = await service.resolveEntityForRetainedSource(
      { query: 'A000360', type: 'member', limit: 5 }, { defaultCongress: 119 },
    );
    expect(direct.matches).toMatchObject([{ canonicalId: 'A000360', matchedBy: 'bioguide-id' }]);
    expect(crosswalk).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();

    const crossed = await service.resolveEntityForRetainedSource(
      { query: 'S390', type: 'member', limit: 5 }, { defaultCongress: 119 },
    );
    expect(crossed.matchesFound).toBe(1);
    expect(crossed.matches).toMatchObject([{ canonicalId: 'A000360', matchedBy: 'lis-crosswalk' }]);
    expect(findMany).not.toHaveBeenCalled();
  });

  it('refuses untrusted Congress/input and keeps exact no-match disclosure', async () => {
    const findUnique = jest.fn(async () => null);
    const service = serviceWith({
      congressMember: { findUnique, findMany: async () => [] },
      entityCrosswalk: { findMany: async () => [] },
    });
    await expect(service.resolveEntityForRetainedSource({ query: 'x', type: 'member' }, { defaultCongress: 0 }))
      .rejects.toThrow('Invalid retained entity source selection');
    await expect(service.resolveEntityForRetainedSource({ query: 'x', defaultCongress: 119 }, { defaultCongress: 119 }))
      .rejects.toThrow('Invalid retained entity source selection');
    expect(findUnique).not.toHaveBeenCalled();
    const noMatch = await service.resolveEntityForRetainedSource(
      { query: 'Unknown Name', type: 'member', limit: 5 }, { defaultCongress: 119 },
    );
    expect(noMatch).toMatchObject({
      matchesFound: 0, matches: [],
      note: 'No canonical entity matched "Unknown Name". Say so explicitly — do NOT fabricate a member, committee, or bill identifier.',
    });
    expect(Number.isFinite(Date.parse(noMatch.generatedAt))).toBe(true);
  });
});

describe('selected-client retained contacts source', () => {
  beforeEach(() => jest.mocked(clientMemoryAllowed).mockReset().mockResolvedValue(true));

  function fixture(rows: Array<Record<string, unknown>>) {
    const findFirstClient = jest.fn(async () => ({ id: CLIENT, name: 'Selected Client', people: [{ email: 'ada@example.com', name: 'Ada Example' }] }));
    const contactsFindMany = jest.fn(async () => rows);
    const mailFindFirst = jest.fn(async (_query: { where: unknown }) => ({ receivedAt: new Date('2026-10-17T12:00:00.000Z') }));
    const mailCount = jest.fn(async (_query: { where: unknown }) => 2);
    const attendeeFindFirst = jest.fn(async (_query: { where: unknown }) => ({ meeting: { startsAt: new Date('2026-10-17T13:00:00.000Z') } }));
    const tx = {
      client: { findFirst: findFirstClient },
      engagementContact: { findMany: contactsFindMany },
      mailMessage: { findFirst: mailFindFirst, count: mailCount },
      meetingAttendee: { findFirst: attendeeFindFirst },
    };
    const prisma = {
      withTenantUser: jest.fn(async (_tenantId: string, _userId: string, read: (transaction: typeof tx) => Promise<unknown>) => read(tx)),
      withTenant: jest.fn(async (_tenantId: string, read: (transaction: typeof tx) => Promise<unknown>) => read(tx)),
    };
    return { service: serviceWith(prisma), findFirstClient, contactsFindMany, mailFindFirst, mailCount, attendeeFindFirst };
  }

  it('binds contact and history predicates to the selected client and returns bounded source data', async () => {
    const h = fixture([{
      fullName: 'Ada Example', email: 'ada@example.com', phone: null,
      title: null, organization: null, source: 'mail_sync',
    }]);
    const result = await h.service.findContactsForRetainedClient(
      ACTOR as never, { clientId: CLIENT, domain: 'example.com', query: 'Ada', limit: 5 }, CLIENT,
    );
    expect(h.contactsFindMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        tenantId: ACTOR.tenantId, clientId: CLIENT,
        email: { endsWith: '@example.com' },
        OR: [{ fullName: { contains: 'Ada', mode: 'insensitive' } }, { email: { contains: 'Ada', mode: 'insensitive' } }],
      }), take: 5,
    }));
    const mailWhere = h.mailFindFirst.mock.calls[0]?.[0]?.where;
    expect(mailWhere).toMatchObject({ thread: { is: { clientId: CLIENT } }, connection: { createdByUserId: ACTOR.userId } });
    expect(h.mailCount.mock.calls[0]?.[0]?.where).toMatchObject({ thread: { is: { clientId: CLIENT } } });
    expect(h.attendeeFindFirst.mock.calls[0]?.[0]?.where).toMatchObject({ meeting: { is: { clientId: CLIENT } } });
    expect(result).toMatchObject({
      tool: 'find_contacts', clientId: CLIENT, clientName: 'Selected Client',
      matchedOn: { domain: 'example.com', query: 'Ada', linkedClient: true },
      contacts: [{ name: 'Ada Example', messageCount: 2, onProfile: true, lastContact: '2026-10-17T13:00:00.000Z' }],
    });
    expect(result.note).toContain('calendar — cite them as such');
    expect(Number.isFinite(Date.parse(result.generatedAt))).toBe(true);
    expect(h.findFirstClient).toHaveBeenCalledTimes(2);
  });

  it('refuses a different or missing client before any source query', async () => {
    const h = fixture([]);
    await expect(h.service.findContactsForRetainedClient(ACTOR as never, { clientId: OTHER }, CLIENT))
      .rejects.toThrow('Invalid selected-client contacts source selection');
    await expect(h.service.findContactsForRetainedClient(ACTOR as never, { domain: 'example.com' }, CLIENT))
      .rejects.toThrow('Invalid selected-client contacts source selection');
    expect(h.findFirstClient).not.toHaveBeenCalled();
    expect(h.contactsFindMany).not.toHaveBeenCalled();
  });

  it('withholds a result when the client wall is revoked after the read', async () => {
    jest.mocked(clientMemoryAllowed).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const h = fixture([]);
    await expect(h.service.findContactsForRetainedClient(ACTOR as never, { clientId: CLIENT }, CLIENT))
      .rejects.toThrow('Client not found');
    expect(h.contactsFindMany).toHaveBeenCalledTimes(1);
  });
});
