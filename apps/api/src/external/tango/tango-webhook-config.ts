import type { TangoWebhookAlert, TangoWebhookAlertInput } from './tango.types.js';

/**
 * Desired provider alert subscriptions, as reviewed code — Funding
 * Opportunities P47.
 *
 * ── The one rule that shapes everything here ─────────────────────────────────
 *
 * ONE ALERT PER DATASET, NEVER ONE PER CLIENT.
 *
 * The plan states it directly ("do not create one provider alert per Capiro
 * client; fan-out belongs in Capiro") and the reason is not tidiness. A
 * per-client subscription would:
 *
 *   - leak the client roster to the provider, one filter at a time;
 *   - put Capiro's tenant model inside someone else's system, where no RLS
 *     policy and no ethical wall can reach it;
 *   - multiply provider-side objects by tenant growth, against an account
 *     limit nobody controls;
 *   - and make onboarding a client a provider-API write, so a MakeGov outage
 *     would become a Capiro onboarding outage.
 *
 * So the subscriptions here are deliberately BROAD — "tell us when any
 * contract opportunity changes" — and every narrowing to a client happens in
 * P48, locally, where the tenant rules actually live.
 *
 * ── Why desired state is code, not database rows ─────────────────────────────
 *
 * "Managed as reviewed infrastructure rather than ad hoc dashboard state" is
 * P47's whole goal. A table would be editable at 2am by anything with a
 * connection; this list changes only through a reviewed diff, and the version
 * below is what a reconciler run reports so an operator can tell which
 * generation of intent a live account matches.
 *
 * ── This module performs NO I/O ──────────────────────────────────────────────
 *
 * Everything here is pure. The reconciler does the talking; this decides what
 * SHOULD be true and what differs. That split is what lets the dry run be
 * genuinely trustworthy — there is no code path from this file to a write.
 */

/**
 * Bump when the desired set changes MEANINGFULLY.
 *
 * Not a checksum: a reworded `name` is a new version because the name is the
 * provider-side identity this reconciler matches on, so changing one really
 * does mean "a different subscription is desired".
 */
export const TANGO_WEBHOOK_DESIRED_VERSION = 1;

/**
 * Prefix on every Capiro-managed alert name.
 *
 * THE SAFETY BOUNDARY FOR DELETION. An alert without this prefix was created by
 * a human in the MakeGov dashboard, or by another system, and this reconciler
 * will never propose removing it — see {@link diffWebhookAlerts}. Absence from
 * the desired list is not evidence that something is unwanted; it is only
 * evidence that THIS list does not manage it.
 */
export const TANGO_MANAGED_ALERT_PREFIX = 'capiro-managed/';

export interface DesiredWebhookAlert {
  /** Stable local key, used in diff output and logs. Never sent to the provider. */
  key: string;
  /** Provider-side name. Always prefixed; that prefix is what makes it ours. */
  name: string;
  /** Provider vocabulary, SINGULAR ("contract", not "contracts") per the SDK docs. */
  queryType: string;
  filters: Record<string, unknown>;
  /** Why this subscription exists, for the operator reading a diff. */
  rationale: string;
}

/**
 * The desired set.
 *
 * Filters are intentionally minimal. Every one of these says "something in this
 * dataset changed", and nothing says "…and it matters to client X" — that
 * judgement is P48's, made against local data with the client's own profile,
 * ethical walls, and workflow state in hand.
 */
export const DESIRED_WEBHOOK_ALERTS_V1: readonly DesiredWebhookAlert[] = Object.freeze([
  Object.freeze({
    key: 'contract_opportunities',
    name: `${TANGO_MANAGED_ALERT_PREFIX}contract-opportunities`,
    queryType: 'contract',
    filters: Object.freeze({}) as Record<string, unknown>,
    rationale:
      'Solicitation and amendment activity on contract opportunities. Feeds P48 notice-change classification; replaces polling latency, never the scheduled sync itself.',
  }),
  Object.freeze({
    key: 'forecasts',
    name: `${TANGO_MANAGED_ALERT_PREFIX}forecasts`,
    queryType: 'forecast',
    filters: Object.freeze({}) as Record<string, unknown>,
    rationale:
      'Agency forecast publication and revision. The earliest signal this program has; a forecast is provider-exclusive, so nothing else would tell us.',
  }),
]);

/** A desired alert in the shape the provider is asked to create. */
export function toAlertInput(
  desired: DesiredWebhookAlert,
  endpointId: string | undefined,
): TangoWebhookAlertInput {
  return {
    name: desired.name,
    queryType: desired.queryType,
    filters: desired.filters,
    ...(endpointId === undefined ? {} : { endpointId }),
  };
}

/** Thrown when the desired set itself is invalid. Never a provider problem. */
export class DuplicateDesiredAlertError extends Error {
  constructor(readonly duplicates: string[]) {
    super(`Duplicate desired webhook alerts: ${duplicates.join(', ')}`);
    this.name = 'DuplicateDesiredAlertError';
  }
}

/**
 * Reject a desired set that names the same subscription twice.
 *
 * Checked on BOTH `key` and `name`. A duplicate name is the dangerous one: the
 * reconciler matches provider-side state by name, so two desired entries
 * sharing a name would each see the other's alert as "already present", report
 * no work, and silently leave one subscription unmade forever.
 *
 * This runs before any network call — an invalid desired set is a programming
 * error, and discovering it after a partial create would be the "partial
 * configuration" P47's acceptance explicitly forbids.
 */
export function assertNoDuplicateDesiredAlerts(
  desired: readonly DesiredWebhookAlert[] = DESIRED_WEBHOOK_ALERTS_V1,
): void {
  const duplicates: string[] = [];
  for (const field of ['key', 'name'] as const) {
    const seen = new Set<string>();
    for (const alert of desired) {
      const value = alert[field];
      if (seen.has(value)) duplicates.push(`${field}=${value}`);
      seen.add(value);
    }
  }
  if (duplicates.length > 0) throw new DuplicateDesiredAlertError(duplicates);
}

export type WebhookAlertAction =
  | { kind: 'create'; desired: DesiredWebhookAlert }
  | { kind: 'unchanged'; desired: DesiredWebhookAlert; actual: TangoWebhookAlert }
  | { kind: 'paused'; desired: DesiredWebhookAlert; actual: TangoWebhookAlert }
  | { kind: 'delete'; actual: TangoWebhookAlert }
  | { kind: 'unmanaged'; actual: TangoWebhookAlert };

export interface WebhookAlertPlan {
  version: number;
  actions: WebhookAlertAction[];
  /** True when at least one action would write. Drives the dry-run summary. */
  hasWork: boolean;
}

/**
 * Diff desired against provider-actual.
 *
 * ── Deletion is opt-in, always ───────────────────────────────────────────────
 *
 * P47's acceptance: "deleting an alert is never implied by absence unless
 * `--allow-delete` is passed". Two separate guards enforce that here:
 *
 *   1. Without `allowDelete`, a managed-but-undesired alert is reported as
 *      `unmanaged` — visible in the diff, but not an action.
 *   2. Even WITH `allowDelete`, an alert lacking {@link TANGO_MANAGED_ALERT_PREFIX}
 *      is NEVER proposed for deletion. A human's dashboard alert is not this
 *      reconciler's to remove, and "I didn't know Capiro would delete that"
 *      is not a recoverable mistake.
 *
 * ── A paused alert is not a missing alert ────────────────────────────────────
 *
 * An existing-but-paused subscription is reported as `paused`, not `create`.
 * Proposing a create would attempt a duplicate name; proposing nothing would
 * hide that delivery is silently not happening. Naming it lets an operator
 * decide, which is the whole posture of this phase.
 */
export function diffWebhookAlerts(
  desired: readonly DesiredWebhookAlert[],
  actual: readonly TangoWebhookAlert[],
  options: { allowDelete?: boolean } = {},
): WebhookAlertPlan {
  const actualByName = new Map(actual.map((a) => [a.name, a]));
  const desiredNames = new Set(desired.map((d) => d.name));
  const actions: WebhookAlertAction[] = [];

  for (const want of desired) {
    const found = actualByName.get(want.name);
    if (!found) {
      actions.push({ kind: 'create', desired: want });
    } else if (found.status === 'paused') {
      actions.push({ kind: 'paused', desired: want, actual: found });
    } else {
      actions.push({ kind: 'unchanged', desired: want, actual: found });
    }
  }

  for (const have of actual) {
    if (desiredNames.has(have.name)) continue;
    const isManaged = have.name.startsWith(TANGO_MANAGED_ALERT_PREFIX);
    if (isManaged && options.allowDelete === true) {
      actions.push({ kind: 'delete', actual: have });
    } else {
      // Reported, never acted on. Includes every human-created alert.
      actions.push({ kind: 'unmanaged', actual: have });
    }
  }

  return {
    version: TANGO_WEBHOOK_DESIRED_VERSION,
    actions,
    hasWork: actions.some((a) => a.kind === 'create' || a.kind === 'delete'),
  };
}

/** One-line-per-action rendering for the CLI. Contains no secret and no payload. */
export function renderPlan(plan: WebhookAlertPlan): string[] {
  return plan.actions.map((action) => {
    switch (action.kind) {
      case 'create':
        return `CREATE    ${action.desired.name}  (query_type=${action.desired.queryType})`;
      case 'unchanged':
        return `UNCHANGED ${action.desired.name}`;
      case 'paused':
        return `PAUSED    ${action.desired.name}  — exists but is not delivering; resume it at the provider`;
      case 'delete':
        return `DELETE    ${action.actual.name}  (--allow-delete was passed)`;
      case 'unmanaged':
        return `IGNORED   ${action.actual.name}  — not Capiro-managed; absence from desired state is not a deletion signal`;
    }
  });
}
