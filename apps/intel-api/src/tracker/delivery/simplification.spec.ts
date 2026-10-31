import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants.js';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { DraftAccessService } from './draft-access.service.js';
import { DeliveryController, MonitoringRuleController } from './delivery.controller.js';
import { ResearchController } from '../research/research.controller.js';
import { assertResearchReportAccess } from '../research/research-report-access.js';
import { assertEditorialAccess } from '../editorial/editorial-access.js';

jest.mock('../../auth/tenant.guard.js', () => ({ TenantGuard: class {} }));
jest.mock('../folders/folder-tracker.service.js', () => ({ FolderTrackerService: class {} }));
jest.mock('../folders/folder-tracker.controller.js', () => ({ FolderTrackerGuard: class {} }));
jest.mock('../../feature-flags/feature-flag.service.js', () => ({
  FeatureFlagService: class {},
  FOLDER_TRACKER_FEATURE: 'legiwatch_folder_tracker_v1',
}));
jest.mock('./delivery.service.js', () => ({ DeliveryService: class {} }));
jest.mock('./recipients.service.js', () => ({ RecipientsService: class {} }));
jest.mock('./record-rule.service.js', () => ({ RecordRuleService: class {} }));
jest.mock('../research/research.service.js', () => ({ ResearchService: class {} }));
jest.mock('../research/research-report.service.js', () => ({ ResearchReportService: class {} }));
jest.mock('../research/research-deadline.service.js', () => ({
  ResearchDeadlineService: class {},
}));
jest.mock('../research/statute-monitor.service.js', () => ({ StatuteMonitorService: class {} }));
jest.mock('../keywords/internal-workflow.controller.js', () => ({ WorkflowSourceGuard: class {} }));
jest.mock('../research/research-report-access.js', () => ({
  assertResearchReportAccess: jest.fn(),
}));
jest.mock('../editorial/editorial-access.js', () => ({ assertEditorialAccess: jest.fn() }));

const routes = (controller: { prototype: object }) =>
  Object.getOwnPropertyNames(controller.prototype)
    .filter((key) => key !== 'constructor')
    .map((key) =>
      Reflect.getMetadata(
        PATH_METADATA,
        (controller.prototype as Record<string, unknown>)[key] as object,
      ),
    );

describe('retained delivery and research routes', () => {
  it('mounts neutral owners without a report library or subscription route', () => {
    expect(Reflect.getMetadata(PATH_METADATA, DeliveryController)).toBe('legiwatch/deliveries');
    expect(Reflect.getMetadata(PATH_METADATA, MonitoringRuleController)).toBe(
      'legiwatch/monitoring',
    );
    expect(routes(DeliveryController)).toEqual(
      expect.arrayContaining([
        'runs/:id',
        'runs/:id/compose',
        'runs/:id/send',
        'recipients',
        'deliveries/:id/retry',
        'deliveries/:id/reconcile',
      ]),
    );
    expect(
      routes(DeliveryController).some((path) =>
        /subscriptions|promote|generate|duplicate|contacts|lists|record-bill-context|export/.test(
          path,
        ),
      ),
    ).toBe(false);
    expect(routes(ResearchController).some((path) => path.startsWith('imports'))).toBe(false);
    expect(routes(ResearchController)).toEqual(
      expect.arrayContaining(['search', 'drafts', 'reports/preview', 'monitors']),
    );
  });
});

describe('retained draft access', () => {
  const ctx = { tenantId: 'tenant-a', clerkUserId: 'owner-a', role: null };
  function setup(snapshot: unknown) {
    const tx = {
      legiWatchReportRun: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'draft-a',
          reportId: 'scope-a',
          snapshot,
          rendered: { html: '<p>Frozen draft</p>', text: 'Frozen draft' },
        }),
      },
      legiWatchReport: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ folderIds: ['folder-a'], ownerClerkId: ctx.clerkUserId }),
      },
    };
    const folders = {
      source: { activeMember: jest.fn().mockResolvedValue(true) },
      withActor: jest.fn(async (_ctx, fn) => fn(tx)),
      folder: jest.fn().mockResolvedValue({}),
    };
    const flags = { isEnabled: jest.fn().mockResolvedValue(true) };
    return {
      service: new DraftAccessService(folders as never, flags as never),
      folders,
      flags,
      tx,
    };
  }
  beforeEach(() => jest.clearAllMocks());
  it('keeps current membership and tenant-scoped lookup before reading a retained draft', async () => {
    const { service, folders, tx } = setup({ mode: 'editorial_brief', rows: [] });
    expect((await service.run(ctx, 'draft-a')).rendered.text).toBe('Frozen draft');
    expect(tx.legiWatchReportRun.findFirst).toHaveBeenCalledWith({
      where: { tenantId: ctx.tenantId, id: 'draft-a' },
    });
    expect(folders.folder).toHaveBeenCalledWith(tx, ctx, 'folder-a');
    expect(assertEditorialAccess).toHaveBeenCalled();
    expect(assertResearchReportAccess).toHaveBeenCalled();
  });
  it('does not expose old bill-report runs through the retained draft route', async () => {
    await expect(setup({ rows: [] }).service.run(ctx, 'old-report')).rejects.toThrow(
      NotFoundException,
    );
  });
  it('denies revoked membership before any draft lookup', async () => {
    const { service, folders, tx } = setup({
      researchReview: { selectionId: 'research-a' },
      rows: [],
    });
    folders.source.activeMember.mockResolvedValue(false);
    await expect(service.run(ctx, 'draft-a')).rejects.toThrow(ForbiddenException);
    expect(tx.legiWatchReportRun.findFirst).not.toHaveBeenCalled();
  });
});
