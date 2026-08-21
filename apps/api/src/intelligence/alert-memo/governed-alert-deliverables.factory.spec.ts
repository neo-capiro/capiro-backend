import type { TenantContext } from '@capiro/shared';
import {
  createGovernedAlertMemoService,
  createGovernedDistrictBriefService,
  PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER,
} from './governed-alert-deliverables.factory.js';
import type { AlertMemoService } from './alert-memo.service.js';
import type { DistrictBriefService } from './district-brief.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as TenantContext;
const alert = {
  alertId: 'alert-1',
  sourceType: 'bill',
  title: 'H.R. 8800 floor update',
} as never;

const governed = {
  steering: '## Client Soul\nClient identity.\n\n## Firm Playbook\nFirm instructions.',
  supplementalContext:
    '<capiro_legiwatch_context_plane>\nSUPPLEMENTAL CLIENT/HISTORY CONTEXT:\n[contacts:c1] relationship history\n</capiro_legiwatch_context_plane>',
  memoryFilesUsed: ['client-soul', 'firm-playbook'],
  contextExcluded: [
    { title: 'firm-playbook', reason: 'superseded' },
    { title: 'Restricted item', reason: 'unauthorized' },
  ],
};

/**
 * Explicit `this` shape for the legacy loader seam. The fakes below are object
 * literals cast to the real service type, so `this` needs an annotation for the
 * retained-seam call to typecheck.
 */
interface RawSteeringSeam {
  loadSteering: (...args: unknown[]) => Promise<unknown>;
}

describe('governed alert deliverable context loaders — Phase 22', () => {
  test('the raw legacy compiler is structurally disabled after adoption', async () => {
    await expect(PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER.compile()).rejects.toThrow(
      'phase22_legacy_context_compiler_disabled',
    );
  });

  test('memo wrapper receives canonical steering/exclusions from the shared LegiWatch Context Plane', async () => {
    let loaded: unknown;
    const raw = {
      loadSteering: async () => {
        throw new Error('legacy loader should not execute');
      },
      generate: async function (this: RawSteeringSeam) {
        loaded = await this.loadSteering(ctx, 'client-1', 'Acme');
        return { ok: true };
      },
    } as unknown as AlertMemoService;
    const contextPlane = { resolve: jest.fn().mockResolvedValue(governed) };
    const service = createGovernedAlertMemoService(raw, contextPlane as never);

    await service.generate(ctx, 'client-1', alert, 'Acme');

    expect(loaded).toEqual({
      steering: `${governed.steering}\n\n${governed.supplementalContext}`,
      memoryFilesUsed: governed.memoryFilesUsed,
      contextExcluded: governed.contextExcluded,
    });
    expect(contextPlane.resolve).toHaveBeenCalledTimes(1);
  });

  test('district-brief wrapper uses the same operation while carrying facility focus', async () => {
    let loaded: unknown;
    const raw = {
      loadSteering: async () => {
        throw new Error('legacy loader should not execute');
      },
      generate: async function (this: RawSteeringSeam) {
        loaded = await this.loadSteering(ctx, 'client-1', 'Acme');
        return { ok: true };
      },
    } as unknown as DistrictBriefService;
    const contextPlane = { resolve: jest.fn().mockResolvedValue(governed) };
    const service = createGovernedDistrictBriefService(raw, contextPlane as never);

    await service.generate(ctx, 'client-1', 'facility-1', alert);

    expect(loaded).toEqual({
      steering: `${governed.steering}\n\n${governed.supplementalContext}`,
      memoryFilesUsed: governed.memoryFilesUsed,
    });
    expect(contextPlane.resolve).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        alertId: 'alert-1',
        facilityId: 'facility-1',
      }),
    );
  });
});
