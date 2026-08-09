/**
 * Read-only Tango (MakeGov) CAPABILITY AND TIER PROBE (Funding Opportunities P17).
 *
 *   tsx scripts/diag-tango-capabilities.ts
 *   tsx scripts/diag-tango-capabilities.ts --uei=ZZTESTUEI001 --vehicle-uuid=<uuid>
 *   tsx scripts/diag-tango-capabilities.ts --request-ceiling=10
 *
 * SAFE: every call this makes is a GET or the smallest possible LIST/limit=1
 * call — see tango-capability-probe.service.ts's class doc for the full "what
 * this must never do" list (no create/update/delete, no webhook subscription,
 * no alert, ever). Not a normal DIAGNOSTIC in the DB sense — it makes ZERO
 * database connections; its entire job is a handful of live HTTP calls
 * against the real Tango account, redacted before anything reaches stdout.
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 *
 * P19–P47 each assume Tango exposes a specific dataset at a specific tier.
 * Several of those assumptions are demonstrably wrong for @makegov/tango-node
 * 1.1.0 (no DIBBS method, no SBIR/STTR method, no dedicated exclusions
 * endpoint — see tango-capability-probe.service.ts). This script is how that
 * gets checked against the REAL account BEFORE a phase is built on a false
 * assumption, rather than discovered mid-implementation.
 *
 * ── The key ──────────────────────────────────────────────────────────────
 *
 * Reads TANGO_API_KEY from the environment (the same variable
 * config.schema.ts validates and compute-stack.ts injects into the ephemeral
 * sync-job task from Secrets Manager). `--api-key=` is accepted ONLY for a
 * one-off local run where exporting the env var first is inconvenient — it
 * is never logged, never printed, and the key never appears in this script's
 * own stdout: every string that could carry it is redacted through
 * `redactWithKnownSecret` before printing (tango.errors.ts, same redaction
 * the product gateway uses). If no key reaches this script at all, it exits
 * immediately with a clear message rather than issuing a guaranteed-401
 * "smallest possible call" that would tell nobody anything new.
 *
 * ── The request ceiling ──────────────────────────────────────────────────
 *
 * Defaults to 25 -- the account's MEASURED per-window rate limit, observed
 * 2026-08-08: `x-ratelimit-limit: 25`, resetting in ~31s. The previous default
 * of 30 sat ABOVE that, so the self-imposed cap could never bind: the provider
 * always ran out first. That run started with only 12 of 25 remaining and died
 * on `budget_accounts_flows` with a rate-limit error that looked, in the
 * report, exactly like a broken capability.
 *
 * A full pass needs ~17 HTTP calls (several probes are `not_attempted` and
 * issue none), so 25 fits comfortably -- ON A FRESH WINDOW. If a run reports
 * `rate_limited` probes, the window was already partly spent; wait ~31s and
 * re-run rather than raising this.
 *
 * (There are ~24 probes total; this leaves headroom without
 * being anywhere near TANGO_REQUEST_CEILING_PER_RUN's default of 5,000).
 * That larger number is P18's SYNC-RUN ceiling — a different, much bigger
 * concern (draining real pagination) — and is deliberately NOT reused here as
 * a default: a one-off operator diagnostic should never be capable of
 * silently issuing thousands of calls because it inherited an unrelated
 * production ceiling.
 *
 * ── uei / vehicle-uuid ─────────────────────────────────────────────────────
 *
 * Optional. Left unset, the `entities` / `vehicle_awardees` / `vehicle_orders`
 * / `budget_flows_by_entity` probes report `not_attempted` with an explicit
 * reason rather than being run against an invented identifier — a made-up
 * UEI or vehicle uuid would only ever prove the 404 path, not real access.
 * Pass a real one (e.g. the operator's own firm's UEI) to actually exercise
 * those probes.
 */
import { config as dotenvConfig } from 'dotenv';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';
import {
  TangoCapabilityProbeService,
  createProbeClient,
  type CapabilityReport,
} from '../src/external/tango/tango-capability-probe.service.js';
import { TangoDibbsClient } from '../src/external/tango/tango-dibbs.client.js';
import { TangoSbirClient } from '../src/external/tango/tango-sbir.client.js';

dotenvConfig();

/** The account's measured per-window limit (2026-08-08). See the header. */
const DEFAULT_REQUEST_CEILING = 25;

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  apiKey: string | undefined;
  baseUrl: string | undefined;
  timeoutMs: number | undefined;
  uei: string | undefined;
  vehicleUuid: string | undefined;
  requestCeiling: number;
}

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv): ParsedArgs {
  const ceilingRaw = flagValue(argv, 'request-ceiling');
  const ceilingParsed = ceilingRaw != null ? Number(ceilingRaw) : NaN;
  const timeoutRaw = flagValue(argv, 'timeout-ms') ?? env.TANGO_TIMEOUT_MS;
  const timeoutParsed = timeoutRaw != null ? Number(timeoutRaw) : NaN;

  const apiKey = (flagValue(argv, 'api-key') ?? env.TANGO_API_KEY ?? '').trim();

  return {
    apiKey: apiKey.length > 0 ? apiKey : undefined,
    baseUrl: flagValue(argv, 'base-url') ?? env.TANGO_API_BASE_URL,
    timeoutMs: Number.isFinite(timeoutParsed) && timeoutParsed > 0 ? timeoutParsed : undefined,
    uei: flagValue(argv, 'uei'),
    vehicleUuid: flagValue(argv, 'vehicle-uuid'),
    requestCeiling:
      Number.isFinite(ceilingParsed) && ceilingParsed > 0 ? Math.min(ceilingParsed, 200) : DEFAULT_REQUEST_CEILING,
  };
}

/** A compact table, easiest to eyeball for "what changed since the last run". */
export function formatSummary(report: CapabilityReport): string {
  const lines = [
    `generatedAt=${report.generatedAt} requestsIssued=${report.requestsIssued}/${report.requestCeiling}` +
      ` authenticationFailed=${report.authenticationFailed}`,
    '',
  ];
  const width = report.probes.length > 0 ? Math.max(...report.probes.map((p) => p.key.length)) : 0;
  for (const p of report.probes) {
    const phases = p.usedByPhases.length > 0 ? ` [${p.usedByPhases.join(',')}]` : '';
    lines.push(`  ${p.key.padEnd(width)}  ${p.status.padEnd(13)}  ${p.durationMs}ms${phases}`);
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2), process.env);

  if (!args.apiKey) {
    console.error(
      'TANGO_PROBE_ERR No API key available. Set TANGO_API_KEY in the environment ' +
        '(the same variable Secrets Manager injects into the sync-job task) or pass --api-key=... ' +
        'for a one-off local run. Refusing to issue a guaranteed-401 call against an empty credential ' +
        '— that would prove nothing this report does not already know how to report.',
    );
    process.exitCode = 1;
    return;
  }

  const client = await createProbeClient({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    timeoutMs: args.timeoutMs,
  });

  // The DIBBS REST surface the SDK does not wrap. Constructed here rather than
  // inside the probe service so this file stays the only place that decides
  // what a diagnostic run is allowed to talk to. Read-only: the probe issues
  // one `listRfqs({ limit: 1 })`. See decision-log D-62 for why this probe used
  // to report `unsupported` and no longer does.
  const dibbs = new TangoDibbsClient({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    timeoutMs: args.timeoutMs,
  });

  // The SBIR/STTR REST surface, same reasoning one phase later (P42 part 1).
  // Until this existed the probe could only ever report `no_rest_client_wired`
  // — a fact about Capiro's code — while P42's own gate asks for an entitlement
  // answer. Read-only: the probe issues one `listTopics({ limit: 1 })`.
  const sbir = new TangoSbirClient({
    apiKey: args.apiKey,
    baseUrl: args.baseUrl,
    timeoutMs: args.timeoutMs,
  });

  const service = new TangoCapabilityProbeService();
  const report = await service.run(client, args.apiKey, {
    uei: args.uei,
    vehicleUuid: args.vehicleUuid,
    requestCeiling: args.requestCeiling,
    dibbs,
    sbir,
  });

  console.error(formatSummary(report));
  // The full structured report on stdout, separate from the human summary on
  // stderr, so `tsx scripts/diag-tango-capabilities.ts > report.json` captures
  // exactly the machine-readable artifact and nothing else.
  console.log(JSON.stringify(report, null, 2));

  if (report.authenticationFailed) {
    console.error(
      'TANGO_PROBE_WARN authentication failed on the version preflight — every other probe was ' +
        'reported not_attempted rather than run. Verify the key value in Secrets Manager (arn tango) ' +
        'is current before treating any "not_attempted" result below as a capability finding.',
    );
  }
}

// Guards against running `main()` as a side effect of merely IMPORTING this
// module — which is exactly what diag-tango-capabilities.spec.ts does to
// reach `parseArgs`/`formatSummary`. Without this guard, every test run (and
// any future script that reuses these exports) would silently fire a real
// network call at the live Tango API on import. Same pattern as
// backfill-sam-opportunity-fields.ts's `isDirectRun`.
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /diag-tango-capabilities(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Defense in depth: nothing above should ever throw with the raw key in the
    // message (every SDK-facing call already redacts), but a top-level catch is
    // cheap insurance against a future code path that forgets to.
    const argsForRedaction = parseArgs(process.argv.slice(2), process.env);
    console.error('TANGO_PROBE_ERR', redactWithKnownSecret(redact(message), argsForRedaction.apiKey ?? null));
    process.exitCode = 1;
  });
}

export { main };
