import {
  createGovernedAlertMemoService,
  createGovernedDistrictBriefService,
} from './governed-alert-deliverables.factory.js';
import type { AlertMemoService } from './alert-memo.service.js';
import type { DistrictBriefService } from './district-brief.service.js';

const ctx = { tenantId: 'tenant-1', userId: 'user-1' } as never;
const alert = {
  alertId: 'alert-1',
  sourceType: 'bill',
  title: 'H.R. 1 changed status',
  sourceRef: 'hr1-119',
} as never;

function governedContext() {
  return {
    steering: '## Client Compass\nProtect the verified client priority.',
    supplementalContext:
      '<capiro_legiwatch_context_plane>\nSUPPLEMENTAL CLIENT/HISTORY CONTEXT:\n[outreach:o1] prior client outreach\n</capiro_legiwatch_context_plane>',
    memoryFilesUsed: ['client-compass'],
    contextExcluded: [],
  };
}

/**
 * Explicit `this` shape for the legacy loader seam. The fakes below are object
 * literals cast to the real service type, so `this` needs an annotation for the
 * retained-seam call to typecheck.
 */
interface LoadedSteering {
  steering: string;
  memoryFilesUsed: string[];
  contextExcluded: unknown[];
}

interface RawSteeringSeam {
  loadSteering: (...args: unknown[]) => Promise<LoadedSteering>;
}

describe('Phase 22 governed LegiWatch deliverable wrappers', () => {
  test('alert memo resolves one governed bundle and injects it before the model seam', async () => {
    const modelInputs: string[] = [];
    const raw = {
      loadSteering: async () => {
        throw new Error('legacy loader must be replaced');
      },
      generate: async function (this: RawSteeringSeam) {
        const loaded = await this.loadSteering(ctx, 'client-1', 'Acme Corp');
        modelInputs.push(loaded.steering);
        return { ok: true };
      },
    } as unknown as AlertMemoService;
    const contextPlane = {
      resolve: jest.fn().mockResolvedValue(governedContext()),
    };

    const service = createGovernedAlertMemoService(raw, contextPlane as never);
    await service.generate(ctx, 'client-1', alert, 'Acme Corp');

    expect(contextPlane.resolve).toHaveBeenCalledTimes(1);
    expect(contextPlane.resolve).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        alertId: 'alert-1',
        alertTitle: 'H.R. 1 changed status',
        sourceType: 'bill',
        sourceRef: 'hr1-119',
      }),
    );
    expect(modelInputs).toHaveLength(1);
    expect(modelInputs[0]).toContain('Protect the verified client priority');
    expect(modelInputs[0]).toContain('SUPPLEMENTAL CLIENT/HISTORY CONTEXT');
  });

  test('alert memo fails closed when Context Plane resolution fails', async () => {
    let modelReached = false;
    const raw = {
      loadSteering: async () => ({ steering: 'legacy', memoryFilesUsed: [], contextExcluded: [] }),
      generate: async function (this: RawSteeringSeam) {
        await this.loadSteering(ctx, 'client-1', 'Acme Corp');
        modelReached = true;
        return { ok: true };
      },
    } as unknown as AlertMemoService;
    const contextPlane = {
      resolve: jest.fn().mockRejectedValue(new Error('context_plane_unavailable')),
    };

    const service = createGovernedAlertMemoService(raw, contextPlane as never);
    await expect(service.generate(ctx, 'client-1', alert, 'Acme Corp')).rejects.toThrow(
      'context_plane_unavailable',
    );
    expect(modelReached).toBe(false);
  });

  test('district brief resolves the same Phase 22 operation once and carries facility focus', async () => {
    const modelInputs: string[] = [];
    const raw = {
      loadSteering: async () => {
        throw new Error('legacy loader must be replaced');
      },
      generate: async function (this: RawSteeringSeam) {
        const loaded = await this.loadSteering(ctx, 'client-1', 'Acme Corp');
        modelInputs.push(loaded.steering);
        return { ok: true };
      },
    } as unknown as DistrictBriefService;
    const contextPlane = {
      resolve: jest.fn().mockResolvedValue(governedContext()),
    };

    const service = createGovernedDistrictBriefService(raw, contextPlane as never);
    await service.generate(ctx, 'client-1', 'facility-9', alert);

    expect(contextPlane.resolve).toHaveBeenCalledTimes(1);
    expect(contextPlane.resolve).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({
        clientId: 'client-1',
        alertId: 'alert-1',
        sourceRef: 'hr1-119',
        facilityId: 'facility-9',
      }),
    );
    expect(modelInputs[0]).toContain('SUPPLEMENTAL CLIENT/HISTORY CONTEXT');
  });
});
