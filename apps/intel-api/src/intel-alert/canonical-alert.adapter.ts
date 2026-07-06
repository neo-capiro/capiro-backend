import { buildAlert, type AlertBuildResult, type SourceType } from '@capiro/shared';
import type { IntelAlertEvent } from './intel-alert.types.js';

/**
 * Tracker → canonical Alert adapter (MeriV2 Phase-1, SC1.1/SC1.2). Maps the
 * tracker's IntelAlertEvent onto the ONE seven-field Alert via buildAlert,
 * which FLAGS missing required fields instead of dropping the alert.
 *
 * Deliberate field decisions (do not "fix" by fabricating):
 * - issueId ← the first matched watchlist tag (the nearest issue analog the
 *   tracker has today); absent → '' and the alert is flagged incomplete.
 * - whoActs has NO source on tracker alerts (owners live on the board, not the
 *   alert) → always '' and flagged. Fabricating an owner to pass completeness
 *   is the exact anti-pattern SC1.2 forbids.
 * - deadline ← actionDate (already an ISO string or null).
 *
 * Pure and additive: callers use the result for LOGGING/BADGES only — never to
 * change the suppress/send branch of the shadow-first delivery path.
 */
export function toCanonicalAlert(ev: IntelAlertEvent): AlertBuildResult {
  const sourceType: SourceType = ev.triggerKey === 'hearing' ? 'hearing' : 'bill';
  return buildAlert({
    whatChanged: ev.detail || ev.label,
    whyItMatters: ev.why ?? '',
    clientId: ev.clientId,
    issueId: ev.matchedTags?.[0] ?? '',
    whoActs: '',
    deadline: ev.actionDate,
    sourceType,
  });
}
