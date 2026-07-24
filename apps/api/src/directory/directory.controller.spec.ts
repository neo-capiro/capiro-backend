import { describe, expect, jest, test } from '@jest/globals';
import type { TenantContext } from '@capiro/shared';
import { DirectoryController } from './directory.controller.js';
import type { DirectoryService } from './directory.service.js';

/**
 * Controller-level test for the member FEC summary endpoint. The service method
 * itself is DB+S3-bound (covered by integration), so here we assert the route
 * delegates to the service with the tenant context + contactId.
 */
describe('DirectoryController — member FEC summary', () => {
  const ctx = { tenantId: 't1', userId: 'u1', role: 'standard_user' } as unknown as TenantContext;

  function make() {
    const service = {
      getMemberFecSummary: jest.fn(),
    } as unknown as DirectoryService & {
      getMemberFecSummary: jest.MockedFunction<DirectoryService['getMemberFecSummary']>;
    };
    const controller = new DirectoryController(service);
    return { controller, service };
  }

  test('delegates to service.getMemberFecSummary with ctx + contactId', async () => {
    const { controller, service } = make();
    const payload = {
      contactId: 'm-1',
      memberName: 'Jane Member',
      matchQuality: 'name_approximate' as const,
      clients: [],
      summary: { totalAmount: 0, contributionCount: 0, clientCount: 0 },
      disclaimer: 'disclaimer text',
    };
    service.getMemberFecSummary.mockResolvedValueOnce(payload);

    const result = await controller.contactFecSummary(ctx, 'm-1');

    expect(service.getMemberFecSummary).toHaveBeenCalledWith(ctx, 'm-1');
    expect(result).toBe(payload);
  });
});

describe('DirectoryController — committees', () => {
  test('committees() delegates to service.getCommittees with query', () => {
    const service = { getCommittees: jest.fn() } as unknown as DirectoryService & {
      getCommittees: jest.Mock;
    };
    const controller = new DirectoryController(service);

    controller.committees('armed', 'House', 'committee', '2', '50');

    expect(service.getCommittees).toHaveBeenCalledWith({
      q: 'armed',
      chamber: 'House',
      kind: 'committee',
      page: '2',
      pageSize: '50',
    });
  });

  test('detail + dictionary routes delegate to their service methods', () => {
    const service = {
      getPeople: jest.fn(),
      getMemberDetail: jest.fn(),
      getStaffDetail: jest.fn(),
      getCommitteeDetail: jest.fn(),
      getCommitteeContacts: jest.fn(),
    } as unknown as DirectoryService & Record<string, jest.Mock>;
    const controller = new DirectoryController(service);

    controller.people('grace', 'committee-100', 'staff', 'true', '1', '25');
    expect((service as any).getPeople).toHaveBeenCalledWith({
      q: 'grace',
      committeeId: 'committee-100',
      personType: 'staff',
      current: 'true',
      page: '1',
      pageSize: '25',
    });

    controller.memberDetail('member-500');
    expect((service as any).getMemberDetail).toHaveBeenCalledWith('member-500');

    controller.staffDetail('staff-800');
    expect((service as any).getStaffDetail).toHaveBeenCalledWith('staff-800');

    controller.committeeDetail('committee-100');
    expect((service as any).getCommitteeDetail).toHaveBeenCalledWith('committee-100');

    controller.committeeContacts('committee-100', 'member', 'true', 'smith', 'chair', '1', '50');
    expect((service as any).getCommitteeContacts).toHaveBeenCalledWith('committee-100', {
      personType: 'member',
      current: 'true',
      q: 'smith',
      role: 'chair',
      page: '1',
      pageSize: '50',
    });
  });

  test('committeeStaff() delegates to service.getCommitteeStaff with id + query', () => {
    const service = { getCommitteeStaff: jest.fn() } as unknown as DirectoryService & {
      getCommitteeStaff: jest.Mock;
    };
    const controller = new DirectoryController(service);

    controller.committeeStaff('committee-100', 'director', '1', undefined);

    expect(service.getCommitteeStaff).toHaveBeenCalledWith('committee-100', {
      q: 'director',
      page: '1',
      pageSize: undefined,
    });
  });
});

/**
 * WS-D, LegiStorm gaps/enrichment plan — controller-level tests for the new
 * district routes. The service methods themselves are DB+S3-bound (no unit
 * test path here, matching the FEC-summary precedent above); these assert
 * the route delegates correctly and — for the KML route — that the response
 * headers/body are wired the same way artifact.controller.ts's exportDocx
 * streams a buffer, and that nothing about the S3 key ever reaches the HTTP
 * response.
 */
describe('DirectoryController — districts (WS-D)', () => {
  function makeDetailService() {
    return { getDistrictDetail: jest.fn() } as unknown as DirectoryService & {
      getDistrictDetail: jest.Mock;
    };
  }

  test('districtDetail() defaults status to "C" when the query param is absent', () => {
    const service = makeDetailService();
    const controller = new DirectoryController(service);

    controller.districtDetail('WY', '00', undefined);

    expect(service.getDistrictDetail).toHaveBeenCalledWith('WY', '00', 'C');
  });

  test('districtDetail() passes through status="F" explicitly, never silently defaulting it away', () => {
    const service = makeDetailService();
    const controller = new DirectoryController(service);

    controller.districtDetail('TX', '25', 'F');

    expect(service.getDistrictDetail).toHaveBeenCalledWith('TX', '25', 'F');
  });

  test('districtDetail() treats any value other than the literal "F" as "C" (never a silent pass-through of garbage)', () => {
    const service = makeDetailService();
    const controller = new DirectoryController(service);

    controller.districtDetail('WY', '00', 'not-a-real-status');

    expect(service.getDistrictDetail).toHaveBeenCalledWith('WY', '00', 'C');
  });

  test('districtKml() sets the KML content-type + disposition and sends the buffer, nothing else', async () => {
    const service = {
      getDistrictKml: jest
        .fn<() => Promise<{ filename: string; buffer: Buffer }>>()
        .mockResolvedValueOnce({
          filename: '271-C.kml',
          buffer: Buffer.from('<kml/>'),
        }),
    } as unknown as DirectoryService & { getDistrictKml: jest.Mock };
    const controller = new DirectoryController(service);
    const res = { setHeader: jest.fn(), send: jest.fn() } as unknown as import('express').Response;

    await controller.districtKml('DC', '00', undefined, res);

    expect(service.getDistrictKml).toHaveBeenCalledWith('DC', '00', 'C');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/vnd.google-earth.kml+xml');
    expect(res.setHeader).toHaveBeenCalledWith('Content-Disposition', 'inline; filename="271-C.kml"');
    expect(res.send).toHaveBeenCalledWith(Buffer.from('<kml/>'));
    // The response must never carry anything resembling the vendor's
    // key-bearing KML source URL — only the content-type/disposition headers
    // and the raw boundary bytes ever reach res.
    const allSetHeaderCalls = (res.setHeader as jest.Mock).mock.calls.flat();
    for (const arg of allSetHeaderCalls) {
      expect(String(arg)).not.toMatch(/legistorm\.com|getKMLByHash/);
    }
  });
});
