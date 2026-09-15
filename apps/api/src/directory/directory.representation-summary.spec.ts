import { describe, expect, jest, test } from '@jest/globals';
import { DirectoryService } from './directory.service.js';
import type { RepresentationResolverService } from '../clients/representation-resolver.service.js';

/**
 * Regression for the Client Profile → District Nexus → Representative
 * drilldown defect: getMemberRepresentationSummary built its House inverse-join
 * key with Number(contact.district), but `contact.district` is the DISPLAY
 * string from `formatDistrict` ('FL-8' for a real House seat, not a bare
 * number). Number('FL-8') is NaN, so the member's district collapsed to null,
 * the House join matched only at-large facilities, and a real FL-08 House
 * member returned { clients: [] } despite a real linked facility. Senators were
 * unaffected (their join ignores district), which is exactly the reported
 * symptom. Pin: the directory's own display district must be normalized back
 * to the bare number before the House inverse join — at-large and invalid
 * forms still map to null, never guessed.
 */
describe('DirectoryService.getMemberRepresentationSummary — House district normalization', () => {
  const ctx = { tenantId: 't1', userId: 'u1', role: 'standard_user' } as any;

  function makeService(contact: Record<string, unknown>) {
    const config = { get: jest.fn().mockReturnValue('us-east-1') } as any;
    const prisma = {} as any;
    const representation = {
      clientsRepresentedByMember: jest
        .fn<RepresentationResolverService['clientsRepresentedByMember']>()
        .mockResolvedValue([]),
    };
    const service = new DirectoryService(
      config,
      prisma,
      representation as unknown as RepresentationResolverService,
    );
    jest.spyOn(service as any, 'getDirectoryData').mockResolvedValue({
      contacts: [contact],
    } as any);
    return { service, representation };
  }

  const houseContact = (district: string) => ({
    id: 'member-920200',
    chamber: 'House',
    state: 'FL',
    district,
    bioguideId: 'QAFL008',
  });

  test('a real House member with display district "FL-8" resolves to district number 8', async () => {
    const { service, representation } = makeService(houseContact('FL-8'));
    await service.getMemberRepresentationSummary(ctx, 'member-920200');
    expect(representation.clientsRepresentedByMember).toHaveBeenCalledWith('t1', {
      bioguideId: 'QAFL008',
      chamber: 'house',
      state: 'FL',
      district: 8,
    });
  });

  test('a House member with an already-bare district string still resolves', async () => {
    const { service, representation } = makeService(houseContact('8'));
    await service.getMemberRepresentationSummary(ctx, 'member-920200');
    expect(representation.clientsRepresentedByMember).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ district: 8 }),
    );
  });

  test('a single-seat at-large House member (display "WY") maps to district null, matching at-large facilities', async () => {
    const { service, representation } = makeService({
      id: 'member-1',
      chamber: 'House',
      state: 'WY',
      district: 'WY',
      bioguideId: 'QAWY00',
    });
    await service.getMemberRepresentationSummary(ctx, 'member-1');
    expect(representation.clientsRepresentedByMember).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ chamber: 'house', state: 'WY', district: null }),
    );
  });

  test('a Senator ignores district entirely (unregressed)', async () => {
    const { service, representation } = makeService({
      id: 'member-920201',
      chamber: 'Senate',
      state: 'FL',
      district: 'FL',
      bioguideId: 'QAFLS01',
    });
    await service.getMemberRepresentationSummary(ctx, 'member-920201');
    expect(representation.clientsRepresentedByMember).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ chamber: 'senate', state: 'FL' }),
    );
  });

  test.each([
    ['FL-108', 'a 3-digit district is not a House seat'],
    ['TX-8', 'a state prefix that does not match the contact state'],
    ['garbage8', 'junk text with trailing digits'],
    ['XX-8', 'an unknown state prefix'],
    ['FL-98', 'a non-voting-delegate sentinel code'],
    ['', 'an empty district'],
  ])('an invalid or mismatched House district %s (%s) stays null — never guessed', async (district) => {
    const { service, representation } = makeService(houseContact(district));
    await service.getMemberRepresentationSummary(ctx, 'member-920200');
    expect(representation.clientsRepresentedByMember).toHaveBeenCalledWith(
      't1',
      expect.objectContaining({ chamber: 'house', state: 'FL', district: null }),
    );
  });
});
