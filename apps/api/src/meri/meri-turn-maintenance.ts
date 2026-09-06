import type { TenantContext } from '@capiro/shared';

/** Both runtime implementations use the existing MeriService maintenance. */
export const MERI_TURN_MAINTENANCE = Symbol('MERI_TURN_MAINTENANCE');

export interface MeriTurnMaintenance {
  scheduleAfterTurnMaintenance(ctx: TenantContext, conversationId: string): void;
}

/** Defer maintenance until after the response, containing both sync and async failures. */
export function scheduleMeriTurnMaintenance(
  maintenance: () => Promise<void>,
  onError: (error: unknown) => void,
): void {
  setImmediate(() => {
    void Promise.resolve().then(maintenance).catch(onError);
  });
}
