import {
  facilityRepresentationBlock,
  RepresentationResolverService,
} from './representation-resolver.service.js';
import { servingBoundaryVersion } from '../external/census-geocoder/geographic-boundary.js';
const resolved = { status: 'resolved', requiresReview: false, version: servingBoundaryVersion() };
describe('official office term boundary', () => {
  it('blocks stale Congress, country and unreviewed interpolation before any directory query', async () => {
    const prisma = {
      congressMember: { findMany: jest.fn() },
      stateLegislator: { findMany: jest.fn() },
    };
    const service = new RepresentationResolverService(prisma as never);
    const facility = {
      state: 'FL',
      congressionalDistrict: '02',
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
      geocodeStatus: 'matched',
    };
    expect(
      await service.representativesForFacility({ ...facility, congressionalDistrictCongress: 120 }),
    ).toEqual({ unresolved: true, reason: 'stale_boundary' });
    expect(
      await service.representativesForFacility({
        ...facility,
        geographicResolution: { ...resolved, requiresReview: true },
      }),
    ).toEqual({ unresolved: true, reason: 'needs_review' });
    expect(facilityRepresentationBlock({ country: 'CA' })).toBe('not_applicable');
    expect(prisma.congressMember.findMany).not.toHaveBeenCalled();
  });
  it('queries federal office directory by Congress and labels state roles as term unverified', async () => {
    const prisma = {
      congressMember: { findMany: jest.fn().mockResolvedValue([]) },
      stateLegislator: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const service = new RepresentationResolverService(prisma as never);
    const result = await service.representativesForFacility({
      state: 'FL',
      congressionalDistrict: '02',
      stateHouseDistrict: '9',
      stateSenateDistrict: '3',
      geocodeStatus: 'matched',
      congressionalDistrictCongress: 119,
      geographicResolution: resolved,
    });
    expect(result).toMatchObject({
      unresolved: false,
      officeStatus: 'unresolved_office',
      federal: { house: null, senate: [] },
      state: { lower: null, upper: null },
    });
    for (const [args] of prisma.congressMember.findMany.mock.calls)
      expect(args.where.congresses).toEqual({ has: 119 });
    expect(result).toMatchObject({
      stateOfficeTermStatus: 'unverified',
      stateCurrentRole: { lower: null, upper: null },
    });
  });
});
