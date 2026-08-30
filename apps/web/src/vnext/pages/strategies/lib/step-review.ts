import type { NodeStatus } from '../../../../pages/strategy/types.js';

/**
 * A client-ready report contains only plan work that a person has moved out of
 * the proposal/review queue. Keep this small policy next to the inspector that
 * performs that review so its labels and actions cannot drift apart.
 */
export const CLIENT_EXPORT_READY_STATUSES = [
  'in_progress',
  'active',
] as const satisfies readonly NodeStatus[];

export type ClientExportReadyStatus =
  (typeof CLIENT_EXPORT_READY_STATUSES)[number];

export function isClientExportReadyStatus(
  status: NodeStatus,
): status is ClientExportReadyStatus {
  return CLIENT_EXPORT_READY_STATUSES.includes(
    status as ClientExportReadyStatus,
  );
}

export function clientExportStatusLabel(status: NodeStatus): string {
  return isClientExportReadyStatus(status) ? 'Included' : 'Not included';
}
