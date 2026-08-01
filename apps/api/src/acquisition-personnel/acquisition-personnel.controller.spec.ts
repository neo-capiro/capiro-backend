import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { AcquisitionPersonnelController } from './acquisition-personnel.controller.js';

type Role = TenantContext['role'];

const standardCtx: TenantContext = {
  tenantId: '00000000-0000-0000-0000-000000000001',
  tenantSlug: 'capiro',
  userId: '00000000-0000-0000-0000-000000000002',
  clerkUserId: 'user_test',
  role: 'standard_user',
};

const adminCtx: TenantContext = {
  ...standardCtx,
  role: 'capiro_admin',
};

describe('AcquisitionPersonnelController', () => {
  test('lists personnel with filters and paging', async () => {
    const { controller, readService } = makeController();
    readService.listPersonnel.mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 50 });

    const result = await controller.list(standardCtx, {
      service: 'ARMY',
      pe_code: '0603270A',
      q: 'john',
      page: 1,
      limit: 50,
    });

    expect(readService.listPersonnel).toHaveBeenCalledWith(
      { service: 'ARMY', pe_code: '0603270A', q: 'john', page: 1, limit: 50 },
      standardCtx,
    );
    expect(result).toEqual({ data: [], total: 0, page: 1, limit: 50 });
  });

  test('gets person detail', async () => {
    const { controller, readService } = makeController();
    readService.getPersonDetail.mockResolvedValueOnce({ id: 'p1', sources: [] });

    const result = await controller.detail(standardCtx, 'p1');

    expect(readService.getPersonDetail).toHaveBeenCalledWith('p1', standardCtx);
    expect(result).toEqual({ id: 'p1', sources: [] });
  });

  test('lists top personnel for a program element', async () => {
    const { controller, readService } = makeController();
    readService.getProgramElementPersonnel.mockResolvedValueOnce([{ id: 'p1', confidence: 0.97 }]);

    const result = await controller.listForProgramElement(standardCtx, '0603270a');

    expect(readService.getProgramElementPersonnel).toHaveBeenCalledWith('0603270A', standardCtx);
    expect(result).toHaveLength(1);
  });

  test('links CRM contact for tenant-scoped engagement contact', async () => {
    const { controller, readService } = makeController();
    readService.linkCrmContact.mockResolvedValueOnce({ linked: true });

    const result = await controller.linkCrmContact(standardCtx, 'person-1', {
      engagementContactId: 'contact-1',
      peCode: '0603270A',
    });

    expect(readService.linkCrmContact).toHaveBeenCalledWith(
      'person-1',
      'contact-1',
      '0603270A',
      standardCtx,
    );
    expect(result).toEqual({ linked: true });
  });

  test('admin merge queue endpoints require capiro_admin role', async () => {
    const { controller, readService } = makeController();
    readService.listMergeQueue.mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 50 });
    readService.resolveMergeQueue.mockResolvedValueOnce({ resolved: true });

    await expect(runAdminOnly('standard_user', () => controller.mergeQueue(standardCtx, { status: 'open' }))).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(
      runAdminOnly('standard_user', () =>
        controller.resolveMergeQueue(standardCtx, 'candidate-1', { decision: 'keep_separate', notes: 'manual' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const listResult = await runAdminOnly('capiro_admin', () => controller.mergeQueue(adminCtx, { status: 'open' }));
    const resolveResult = await runAdminOnly('capiro_admin', () =>
      controller.resolveMergeQueue(adminCtx, 'candidate-1', { decision: 'merge', notes: 'ok' }),
    );

    expect(readService.listMergeQueue).toHaveBeenCalledWith('open', undefined, undefined, adminCtx);
    expect(readService.resolveMergeQueue).toHaveBeenCalled();
    expect(listResult).toEqual({ data: [], total: 0, page: 1, limit: 50 });
    expect(resolveResult).toEqual({ resolved: true });
  });

  test('person-candidate queue is admin-only and resolves confirm/reject', async () => {
    const { controller, readService } = makeController();
    readService.listPersonCandidates.mockResolvedValueOnce({ data: [], total: 0, page: 1, limit: 50 });
    readService.resolvePersonCandidate.mockResolvedValueOnce({ resolved: true, linked: true });

    await expect(
      runAdminOnly('standard_user', () =>
        controller.resolvePersonCandidate(standardCtx, 'cand-1', { decision: 'confirm' }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);

    const listResult = await runAdminOnly('capiro_admin', () =>
      controller.personCandidates(adminCtx, { status: 'open' }),
    );
    const resolveResult = await runAdminOnly('capiro_admin', () =>
      controller.resolvePersonCandidate(adminCtx, 'cand-1', { decision: 'confirm', notes: 'looks right' }),
    );

    expect(readService.listPersonCandidates).toHaveBeenCalledWith('open', undefined, undefined, adminCtx);
    expect(readService.resolvePersonCandidate).toHaveBeenCalledWith('cand-1', 'confirm', 'looks right', adminCtx);
    expect(listResult).toEqual({ data: [], total: 0, page: 1, limit: 50 });
    expect(resolveResult).toEqual({ resolved: true, linked: true });
  });

  test('user_admin can suggest a person for a PE (uppercases peCode)', async () => {
    const { controller, readService } = makeController();
    readService.suggestPersonForProgramElement.mockResolvedValueOnce({ suggested: true, candidateId: 'cand-9' });

    const result = await controller.suggestPerson(adminCtx, '0602785a', {
      fullName: 'Jane Smith',
      roleTitle: 'Project Manager',
      notes: 'met at AUSA',
    });

    expect(readService.suggestPersonForProgramElement).toHaveBeenCalledWith(
      '0602785A',
      { fullName: 'Jane Smith', roleTitle: 'Project Manager', organization: undefined, notes: 'met at AUSA' },
      adminCtx,
    );
    expect(result).toEqual({ suggested: true, candidateId: 'cand-9' });
  });
});

function makeController() {
  const readService = {
    listPersonnel: jest.fn(),
    getPersonDetail: jest.fn(),
    getProgramElementPersonnel: jest.fn(),
    linkCrmContact: jest.fn(),
    listMergeQueue: jest.fn(),
    resolveMergeQueue: jest.fn(),
    listPersonCandidates: jest.fn(),
    resolvePersonCandidate: jest.fn(),
    suggestPersonForProgramElement: jest.fn(),
  };

  const writerService = {
    mergePersons: jest.fn(),
  };

  const controller = new AcquisitionPersonnelController(readService as never, writerService as never);
  return { controller, readService, writerService };
}

async function runAdminOnly<T>(role: Role, action: () => Promise<T>): Promise<T> {
  if (role !== 'capiro_admin') {
    throw new ForbiddenException('Requires capiro_admin role');
  }
  return action();
}
