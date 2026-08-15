/**
 * Reconcile MakeGov/Tango webhook alert subscriptions — Funding Opportunities P47.
 *
 *   tsx scripts/reconcile-tango-webhook-alerts.ts
 *   tsx scripts/reconcile-tango-webhook-alerts.ts --endpoint-id=<uuid>
 *   tsx scripts/reconcile-tango-webhook-alerts.ts --commit \
 *        --endpoint-id=<uuid> --confirm-callback=https://api.dev.capiro.ai/webhooks/tango
 *   tsx scripts/reconcile-tango-webhook-alerts.ts --commit --allow-delete ...
 *
 * ── DRY RUN IS THE DEFAULT, and the default performs no write ────────────────
 *
 * Without `--commit` this issues READ calls only (list endpoints, list alerts)
 * and prints the diff between desired state and provider actual. There is no
 * code path from a dry run to a write: the commit branch is guarded once here
 * and the desired-state module that computes the diff performs no I/O at all.
 *
 * ── Why --commit demands so much ceremony ────────────────────────────────────
 *
 * `--commit` additionally requires `--endpoint-id` AND `--confirm-callback`,
 * and refuses to proceed unless the confirmed URL matches the endpoint's ACTUAL
 * callback_url as the provider reports it. That is not bureaucracy. A webhook
 * alert points deliveries at a URL; attaching Capiro's subscriptions to the
 * wrong endpoint would quietly send federal procurement events to whatever is
 * on the other end of it. The operator must state which endpoint and which URL,
 * and the provider must agree, before anything is created.
 *
 * ── This never creates an endpoint ───────────────────────────────────────────
 *
 * It creates ALERTS against an endpoint that already exists. Endpoint creation
 * is deliberately out of scope:
 *
 *   - P17 recorded `webhook_write_apis` as `not_attempted`, so whether this
 *     account's tier permits endpoint creation at all is genuinely UNKNOWN —
 *     the plan's "all tiers vs Large/Enterprise" discrepancy is unresolved;
 *   - endpoint creation is the one call that returns a SIGNING SECRET, and a
 *     secret arriving in a CLI's memory is a secret that wants to be printed,
 *     logged, or shell-history'd;
 *   - MakeGov onboarding may well create it out-of-band anyway, which the plan
 *     explicitly requires supporting ("attach to its id without recreating").
 *
 * So the endpoint — and its secret — are provisioned by a human through the
 * provider console, the secret goes straight into Secrets Manager as
 * `capiro/<env>/tango-webhook-secret`, and this command attaches to its id.
 * See docs/runbooks/funding-opportunities-rollout.md.
 *
 * ── Exit codes are the operator contract ─────────────────────────────────────
 *
 *   0  desired state already matches, or --commit completed
 *   1  unexpected failure
 *   2  bad arguments
 *   3  TIER OR PERMISSION DENIED — actionable, and NOT a partial configuration
 *   4  endpoint ambiguous or not found; nothing attempted
 *   5  drift exists and this was a dry run (so CI can gate on it)
 */
import { config as dotenvConfig } from 'dotenv';
import {
  DESIRED_WEBHOOK_ALERTS_V1,
  TANGO_WEBHOOK_DESIRED_VERSION,
  assertNoDuplicateDesiredAlerts,
  diffWebhookAlerts,
  renderPlan,
  toAlertInput,
} from '../src/external/tango/tango-webhook-config.js';
import type { TangoGateway, TangoWebhookEndpoint } from '../src/external/tango/tango.types.js';

dotenvConfig();

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_BAD_ARGS = 2;
export const EXIT_TIER_DENIED = 3;
export const EXIT_ENDPOINT_UNRESOLVED = 4;
export const EXIT_DRIFT = 5;

export interface ParsedArgs {
  commit: boolean;
  allowDelete: boolean;
  endpointId: string | null;
  confirmCallback: string | null;
  json: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const get = (name: string): string | null => {
    const hit = argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : null;
  };
  return {
    commit: argv.includes('--commit'),
    allowDelete: argv.includes('--allow-delete'),
    endpointId: get('endpoint-id'),
    confirmCallback: get('confirm-callback'),
    json: argv.includes('--json'),
  };
}

/** Argument validation, separated from I/O so the spec can exercise every branch. */
export function validateArgs(args: ParsedArgs): { ok: true } | { ok: false; message: string } {
  if (!args.commit) {
    // --allow-delete without --commit is harmless (it only widens the printed
    // diff) and is in fact the RECOMMENDED way to preview a deletion.
    return { ok: true };
  }
  if (!args.endpointId) {
    return {
      ok: false,
      message:
        '--commit requires --endpoint-id=<uuid>. Run without --commit first to list endpoints.',
    };
  }
  if (!args.confirmCallback) {
    return {
      ok: false,
      message:
        "--commit requires --confirm-callback=<url> matching that endpoint's callback_url. This is the guard against pointing federal procurement events at the wrong URL.",
    };
  }
  return { ok: true };
}

/**
 * Is this failure a tier/permission refusal rather than a transient problem?
 *
 * Classified so the operator gets exit 3 and an actionable message instead of a
 * generic failure — and so nothing retries a call that will never be allowed.
 */
export function isTierDenied(err: unknown): boolean {
  const kind = (err as { kind?: unknown } | null)?.kind;
  if (kind === 'tier' || kind === 'auth' || kind === 'forbidden') return true;
  const status = (err as { status?: unknown } | null)?.status;
  if (status === 402 || status === 403) return true;
  const message = err instanceof Error ? err.message.toLowerCase() : '';
  return /\btier\b|\bplan\b|not permitted|forbidden|upgrade/.test(message);
}

/** Choose the endpoint to attach to. Never guesses when the answer is ambiguous. */
export function resolveEndpoint(
  endpoints: readonly TangoWebhookEndpoint[],
  requestedId: string | null,
): { ok: true; endpoint: TangoWebhookEndpoint | null } | { ok: false; message: string } {
  if (requestedId) {
    const found = endpoints.find((e) => e.id === requestedId);
    if (!found) {
      return {
        ok: false,
        message: `Endpoint ${requestedId} not found on this account. Known ids: ${
          endpoints.map((e) => e.id).join(', ') || '(none)'
        }`,
      };
    }
    return { ok: true, endpoint: found };
  }
  if (endpoints.length === 0) return { ok: true, endpoint: null };
  if (endpoints.length === 1) return { ok: true, endpoint: endpoints[0] ?? null };
  return {
    ok: false,
    message: `Account has ${endpoints.length} endpoints; pass --endpoint-id=<uuid> to choose. Ids: ${endpoints
      .map((e) => e.id)
      .join(', ')}`,
  };
}

export interface ReconcileOutcome {
  exitCode: number;
  lines: string[];
}

/**
 * The whole command, with the gateway injected so the spec drives it against a
 * fake and no test ever reaches the network.
 */
export async function reconcile(
  gateway: TangoGateway,
  args: ParsedArgs,
  desired = DESIRED_WEBHOOK_ALERTS_V1,
): Promise<ReconcileOutcome> {
  const lines: string[] = [];

  // An invalid desired set is a programming error. Caught BEFORE any call, so
  // it can never leave a partial configuration behind.
  assertNoDuplicateDesiredAlerts(desired);

  if (!gateway.configured) {
    return {
      exitCode: EXIT_BAD_ARGS,
      lines: ['TANGO_API_KEY is not configured. Nothing attempted.'],
    };
  }

  let endpoints: readonly TangoWebhookEndpoint[];
  let actualAlerts;
  try {
    endpoints = await gateway.listWebhookEndpoints();
    actualAlerts = await gateway.listWebhookAlerts();
  } catch (err) {
    if (isTierDenied(err)) {
      return {
        exitCode: EXIT_TIER_DENIED,
        lines: [
          'Provider refused the webhook READ APIs on this account tier.',
          'P17 recorded webhook_event_types and webhook_endpoints_list as supported, so this is a change in entitlement, not an expected state.',
          'Nothing was created. Resolve the plan tier with MakeGov before re-running.',
        ],
      };
    }
    throw err;
  }

  const resolved = resolveEndpoint(endpoints, args.endpointId);
  if (!resolved.ok) return { exitCode: EXIT_ENDPOINT_UNRESOLVED, lines: [resolved.message] };

  const endpoint = resolved.endpoint;
  lines.push(`desired-state version: ${TANGO_WEBHOOK_DESIRED_VERSION}`);
  lines.push(
    endpoint
      ? `endpoint: ${endpoint.id}  active=${endpoint.isActive}  callback=${endpoint.callbackUrl}`
      : 'endpoint: (none on this account — create one in the MakeGov console first; see the runbook)',
  );
  if (endpoint && !endpoint.isActive) {
    lines.push('WARNING: that endpoint is INACTIVE. Alerts attached to it will not deliver.');
  }

  const plan = diffWebhookAlerts(desired, actualAlerts, { allowDelete: args.allowDelete });
  lines.push(...renderPlan(plan));

  if (!args.commit) {
    lines.push('');
    lines.push(
      plan.hasWork
        ? 'DRY RUN — nothing was written. Re-run with --commit --endpoint-id=<uuid> --confirm-callback=<url> to apply.'
        : 'DRY RUN — desired state already matches. No work.',
    );
    return { exitCode: plan.hasWork ? EXIT_DRIFT : EXIT_OK, lines };
  }

  // ── Commit path ────────────────────────────────────────────────────────────

  if (!endpoint) {
    return {
      exitCode: EXIT_ENDPOINT_UNRESOLVED,
      lines: [...lines, 'Refusing to commit: no endpoint exists to attach alerts to.'],
    };
  }
  // The confirmation must match what the PROVIDER says the URL is, not what the
  // operator believes it is. Those differing is precisely the mistake worth
  // catching before deliveries start flowing somewhere unintended.
  if (args.confirmCallback !== endpoint.callbackUrl) {
    return {
      exitCode: EXIT_BAD_ARGS,
      lines: [
        ...lines,
        `Refusing to commit: --confirm-callback does not match the endpoint's actual callback_url.`,
        `  you passed: ${args.confirmCallback}`,
        `  provider:   ${endpoint.callbackUrl}`,
      ],
    };
  }

  for (const action of plan.actions) {
    try {
      if (action.kind === 'create') {
        await gateway.createWebhookAlert(toAlertInput(action.desired, endpoint.id));
        lines.push(`created  ${action.desired.name}`);
      } else if (action.kind === 'delete') {
        await gateway.deleteWebhookAlert(action.actual.alertId);
        lines.push(`deleted  ${action.actual.name}`);
      }
    } catch (err) {
      if (isTierDenied(err)) {
        return {
          exitCode: EXIT_TIER_DENIED,
          lines: [
            ...lines,
            `Provider refused a webhook WRITE on this account tier (while handling: ${
              action.kind === 'create' ? action.desired.name : action.actual.name
            }).`,
            'This is the documentation discrepancy P17 could not resolve — "all tiers" filter subscriptions vs. SDK docs describing webhook writes as Large/Enterprise. It is now resolved: this tier does NOT permit it.',
            'Stopping rather than continuing, so the account is not left half-configured. Anything reported as created above IS created; re-run the dry run to see current state.',
          ],
        };
      }
      throw err;
    }
  }

  lines.push('');
  lines.push('Commit complete. Re-run without --commit; it must report no work.');
  return { exitCode: EXIT_OK, lines };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  const valid = validateArgs(args);
  if (!valid.ok) {
    console.error(valid.message);
    process.exitCode = EXIT_BAD_ARGS;
    return;
  }

  // Imported lazily so `--help`-shaped misuse and arg errors never construct a
  // provider client or read a key.
  const { TangoGatewayService } = await import('../src/external/tango/tango.client.js');
  const gateway = new TangoGatewayService() as unknown as TangoGateway;

  const outcome = await reconcile(gateway, args);
  for (const line of outcome.lines) console.log(line);
  process.exitCode = outcome.exitCode;
}

// Only run when invoked directly, never when imported by the spec.
const invoked = process.argv[1] ?? '';
if (invoked.includes('reconcile-tango-webhook-alerts')) {
  main().catch((err: unknown) => {
    // The message is printed, never the error object: a provider error can
    // carry request context, and this command runs in an operator's shell.
    console.error(err instanceof Error ? err.message : 'Unknown failure');
    process.exitCode = EXIT_FAILED;
  });
}
