import { buildAlert, SOURCE_TYPES, type AlertBuildResult, type SourceType } from '@capiro/shared';

/**
 * Intelligence portfolio-alert → canonical Alert adapter (MeriV2 Phase-1,
 * SC1.1/SC1.2). Maps the "Top alerts" AlertRow shape onto the ONE seven-field
 * Alert via buildAlert, which FLAGS missing required fields instead of
 * dropping the alert. Pure and additive — the result rides as a sidecar on the
 * existing payload (canonicalComplete / canonicalMissingFields), never
 * replacing or filtering rows.
 *
 * Deliberate field decisions (do not "fix" by fabricating):
 * - `when` is the EVENT timestamp, not a deadline — it maps to `deadline` only
 *   when countdownDays is present (a real countdown), else null.
 * - issueId/whoActs have NO source on this surface today → '' and flagged.
 *   Aliasing the alert CATEGORY (row.type) into issueId would fake
 *   completeness — the category rides as sourceType instead.
 */
export function toCanonicalAlert(row: Record<string, unknown>, clientId: string): AlertBuildResult {
  const type = String(row.type ?? '');
  const sourceType = (SOURCE_TYPES as readonly string[]).includes(type)
    ? (type as SourceType)
    : undefined;
  const hasCountdown = typeof row.countdownDays === 'number';
  return buildAlert({
    whatChanged: typeof row.title === 'string' ? row.title : '',
    whyItMatters: typeof row.subtitle === 'string' ? row.subtitle : '',
    clientId,
    issueId: '',
    whoActs: '',
    deadline: hasCountdown && typeof row.when === 'string' ? row.when : null,
    ...(sourceType ? { sourceType } : {}),
  });
}
