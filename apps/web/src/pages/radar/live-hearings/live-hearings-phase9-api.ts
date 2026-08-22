import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';

type UnknownRecord = Record<string, unknown>;

export interface LegiWatchPhase9RolloutDecision {
  phase: 'SHADOW' | 'CANARY' | 'READY' | 'CUTOVER' | 'ROLLBACK' | 'UNKNOWN';
  productionDefault: boolean;
  killSwitchEngaged: boolean;
  canary: boolean;
  liveHearingsV2DefaultEnabled: boolean;
  schedulesEnabled: boolean;
  captureAllPublicEvents: boolean;
  forceLegacy: boolean;
  asOf?: string;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true' || value === 1 || value === '1';
}

function phaseValue(value: unknown): LegiWatchPhase9RolloutDecision['phase'] {
  const phase = typeof value === 'string' ? value.toUpperCase() : '';
  return ['SHADOW', 'CANARY', 'READY', 'CUTOVER', 'ROLLBACK'].includes(phase)
    ? (phase as LegiWatchPhase9RolloutDecision['phase'])
    : 'UNKNOWN';
}

export function normalizeLegiWatchPhase9Rollout(
  value: unknown,
): LegiWatchPhase9RolloutDecision {
  const row = record(value);
  const phase = phaseValue(row.phase);
  const productionDefault = booleanValue(row.productionDefault);
  const killSwitchEngaged = booleanValue(row.killSwitchEngaged);
  const serverDefault = booleanValue(row.liveHearingsV2DefaultEnabled);
  // Do not trust a single boolean from the wire. The complete server contract
  // must agree before the product becomes the default.
  const liveHearingsV2DefaultEnabled =
    phase === 'CUTOVER' && productionDefault && !killSwitchEngaged && serverDefault;
  return {
    phase,
    productionDefault,
    killSwitchEngaged,
    canary:
      (phase === 'CANARY' || phase === 'READY') && booleanValue(row.canary),
    liveHearingsV2DefaultEnabled,
    schedulesEnabled: booleanValue(row.schedulesEnabled),
    captureAllPublicEvents: booleanValue(row.captureAllPublicEvents),
    forceLegacy: phase === 'ROLLBACK',
    asOf: typeof row.asOf === 'string' ? row.asOf : undefined,
  };
}

export function useLegiWatchPhase9Rollout() {
  const api = useApi();
  return useQuery<LegiWatchPhase9RolloutDecision>({
    queryKey: ['legiwatch', 'live-hearings', 'phase9', 'rollout'],
    queryFn: async () =>
      normalizeLegiWatchPhase9Rollout(
        (await api.get<unknown>('/api/legiwatch/live-hearings/phase9/rollout')).data,
      ),
    retry: false,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}
