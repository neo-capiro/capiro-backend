import { ForbiddenException } from '@nestjs/common';
import { AgendaRuleService } from './agenda-rule.service.js';
import { FolderImportService } from '../folders/folder-import.service.js';
import { AGENDA_ALERTS_FEATURE } from '../../feature-flags/feature-flag.service.js';

jest.mock('../../prisma/prisma.service.js', () => ({ PrismaService: class {} }));
jest.mock('../../sourcedata/source-data.repository.js', () => ({ SourceDataRepository: class {} }));
jest.mock('../reports/report.service.js', () => ({ ReportService: class {} }));

const context = (role: string | null) => ({ tenantId: 'tenant-a', clerkUserId: 'user-a', role });
function setup() {
  const findMany = jest.fn().mockResolvedValue([]);
  const folders = {
    withActor: jest.fn(async (_ctx, fn) => fn({ legiWatchStagedConfiguration: { findMany } })),
  };
  const reports = { authorize: jest.fn().mockResolvedValue(undefined), folders };
  return {
    service: new AgendaRuleService(reports as never),
    imports: new FolderImportService(folders as never),
    reports,
    folders,
    findMany,
  };
}

describe('import and agenda administration', () => {
  it.each(['user_admin', 'capiro_admin', 'org:admin'])(
    'accepts the exact verified administrator role %s',
    async (role) => {
      const { service, imports, reports, findMany } = setup();
      expect(() => imports.assertAdmin(context(role))).not.toThrow();
      expect(await service.capabilities(context(role))).toEqual({ canPromote: true });
      expect(reports.authorize).toHaveBeenCalledWith(context(role), AGENDA_ALERTS_FEATURE);
      await service.staged(context(role));
      expect(findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { tenantId: 'tenant-a', kind: 'alert', state: { not: 'excluded' } },
        }),
      );
    },
  );

  it.each(['standard_user', 'org:member', 'org:admin_readonly', 'org:billing-admin', null])(
    'keeps staging and import writes denied to role %s',
    async (role) => {
      const { service, imports, folders } = setup();
      expect(await service.capabilities(context(role))).toEqual({ canPromote: false });
      expect(() => imports.assertAdmin(context(role))).toThrow(ForbiddenException);
      await expect(service.staged(context(role))).rejects.toThrow(ForbiddenException);
      await expect(service.promote(context(role), 'capture-a', {})).rejects.toThrow(
        ForbiddenException,
      );
      expect(folders.withActor).not.toHaveBeenCalled();
    },
  );

  it('does not expose capabilities when the feature authorization fails', async () => {
    const { service, reports } = setup();
    reports.authorize.mockRejectedValue(new ForbiddenException());
    await expect(service.capabilities(context('user_admin'))).rejects.toThrow(ForbiddenException);
  });
});
