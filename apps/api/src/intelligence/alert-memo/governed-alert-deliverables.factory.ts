import { AsyncLocalStorage } from 'node:async_hooks';
import type { TenantContext } from '@capiro/shared';
import { AlertMemoService } from './alert-memo.service.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';
import { DistrictBriefService } from './district-brief.service.js';
import { LegiWatchContextPlaneService } from './legiwatch-context-plane.service.js';

export const RAW_ALERT_MEMO_SERVICE = Symbol('RAW_ALERT_MEMO_SERVICE');
export const RAW_DISTRICT_BRIEF_SERVICE = Symbol('RAW_DISTRICT_BRIEF_SERVICE');

/**
 * Raw constructors still accept the historical ContextCompilerService parameter.
 * Phase 22 passes this fail-closed stub so an accidental unpatched loader can
 * never silently recreate the pre-Context-Plane path.
 */
export const PHASE22_BLOCKED_LEGACY_CONTEXT_COMPILER = {
  async compile(): Promise<never> {
    throw new Error('phase22_legacy_context_compiler_disabled');
  },
};

interface ActiveLegiWatchRun {
  alertId: string;
  alertTitle: string;
  sourceType: string;
  sourceRef?: string | null;
  facilityId?: string | null;
}

const activeRun = new AsyncLocalStorage<ActiveLegiWatchRun>();

interface AlertMemoInternals {
  loadSteering: (
    ctx: TenantContext,
    clientId: string,
    clientName: string,
  ) => Promise<{
    steering: string;
    memoryFilesUsed: string[];
    contextExcluded: Array<{ title: string; reason: string }>;
  }>;
}

interface DistrictBriefInternals {
  loadSteering: (
    ctx: TenantContext,
    clientId: string,
    clientName: string,
  ) => Promise<{ steering: string; memoryFilesUsed: string[] }>;
}

/**
 * Phase 22 alert-memo adoption.
 *
 * The model still receives the existing closed legislative FACT SHEET, sourced
 * from the authoritative alert/bill/hearing/PE/regulation rails. The shared
 * Context Plane contributes only client steering/history context and its
 * explicit coverage truth. Context Plane failure is fail-closed before the model
 * call; there is no neutral legacy compiler fallback after adoption.
 */
export function createGovernedAlertMemoService(
  service: AlertMemoService,
  contextPlane: LegiWatchContextPlaneService,
): AlertMemoService {
  const internal = service as unknown as AlertMemoInternals & {
    generate: AlertMemoService['generate'];
  };
  const originalGenerate = service.generate.bind(service);

  internal.generate = ((
    ctx: TenantContext,
    clientId: string,
    alert: AlertMemoAlertInput,
    clientName: string,
    replaceAttachmentId?: string,
  ) =>
    activeRun.run(
      {
        alertId: alert.alertId,
        alertTitle: alert.title,
        sourceType: alert.sourceType,
        sourceRef: alert.sourceRef ?? null,
      },
      () => originalGenerate(ctx, clientId, alert, clientName, replaceAttachmentId),
    )) as AlertMemoService['generate'];

  internal.loadSteering = async (ctx, clientId, clientName) => {
    const run = activeRun.getStore();
    if (!run) throw new Error('phase22_legiwatch_runtime_context_missing');
    const governed = await contextPlane.resolve(ctx, {
      clientId,
      clientName,
      alertId: run.alertId,
      alertTitle: run.alertTitle,
      sourceType: run.sourceType,
      sourceRef: run.sourceRef ?? null,
    });
    return {
      steering: [governed.steering, governed.supplementalContext].join('\n\n'),
      memoryFilesUsed: governed.memoryFilesUsed,
      contextExcluded: governed.contextExcluded,
    };
  };

  return service;
}

/**
 * District-brief twin. Facility/representation/committee facts remain the
 * deterministic district fact sheet; shared context may only shape strategy,
 * prioritization and follow-up.
 */
export function createGovernedDistrictBriefService(
  service: DistrictBriefService,
  contextPlane: LegiWatchContextPlaneService,
): DistrictBriefService {
  const internal = service as unknown as DistrictBriefInternals & {
    generate: DistrictBriefService['generate'];
  };
  const originalGenerate = service.generate.bind(service);

  internal.generate = ((
    ctx: TenantContext,
    clientId: string,
    facilityId: string,
    alert: AlertMemoAlertInput,
    replaceAttachmentId?: string,
  ) =>
    activeRun.run(
      {
        alertId: alert.alertId,
        alertTitle: alert.title,
        sourceType: alert.sourceType,
        sourceRef: alert.sourceRef ?? null,
        facilityId,
      },
      () => originalGenerate(ctx, clientId, facilityId, alert, replaceAttachmentId),
    )) as DistrictBriefService['generate'];

  internal.loadSteering = async (ctx, clientId, clientName) => {
    const run = activeRun.getStore();
    if (!run) throw new Error('phase22_legiwatch_runtime_context_missing');
    const governed = await contextPlane.resolve(ctx, {
      clientId,
      clientName,
      alertId: run.alertId,
      alertTitle: run.alertTitle,
      sourceType: run.sourceType,
      sourceRef: run.sourceRef ?? null,
      facilityId: run.facilityId ?? null,
    });
    return {
      steering: [governed.steering, governed.supplementalContext].join('\n\n'),
      memoryFilesUsed: governed.memoryFilesUsed,
    };
  };

  return service;
}
