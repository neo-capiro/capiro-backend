/**
 * Read-only Tango (MakeGov) API usage HEALTH report (Funding Opportunities P18).
 *
 *   tsx scripts/diag-tango-health.ts
 *   tsx scripts/diag-tango-health.ts --window=1440   # last 24 hours
 *
 * Reads the PERSISTED `tango_api_usage` log — written by every real call
 * `TangoResilienceService` (P18) makes — and reports counts by status and by
 * call family, a success rate, and the most recent call time.
 *
 * ── Why this is NOT the same thing as TangoResilienceService.getHealth() ─────
 *
 * That method answers "what is THIS process's live breaker/ceiling state
 * right now" — in-memory, and gone the moment the process exits. This script
 * answers "how has the integration behaved recently" from what earlier runs
 * already wrote to Postgres — the only "health" question answerable from a
 * shell that shares no memory with whatever sync task ran an hour ago. See
 * tango-resilience.service.ts's class doc ("Health: two different questions")
 * for the fuller reasoning.
 *
 * SAFE: SELECT-only. No writes, no Tango API call, and no `TANGO_API_KEY`
 * needed at all — this never talks to the provider, only to Capiro's own
 * database.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import { TangoStoreService } from '../src/external/tango/tango-store.service.js';

dotenvConfig();

const DEFAULT_WINDOW_MINUTES = 60;
/** 30 days. A larger window is almost always a mistake (scanning the whole table), not a real question. */
const MAX_WINDOW_MINUTES = 43_200;

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

export interface ParsedArgs {
  windowMinutes: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const raw = flagValue(argv, 'window');
  const parsed = raw != null ? Number(raw) : NaN;
  return {
    windowMinutes:
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, MAX_WINDOW_MINUTES) : DEFAULT_WINDOW_MINUTES,
  };
}

/**
 * Bare PrismaClient shaped like PrismaService for TangoStoreService.
 *
 * Safe here specifically because TangoStoreService never calls
 * `withTenant`/`withSystem` — every table it touches is global, no RLS (see
 * its own class doc) — so the extra tenant-scoping surface PrismaService adds
 * over PrismaClient is simply never reached. A cast, not a full shim, unlike
 * scripts that DO need `withSystem` (e.g. drain-pe-change-outbox.ts).
 */
function prismaServiceFromClient(client: PrismaClient): PrismaService {
  return client as unknown as PrismaService;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const client = new PrismaClient();
  await client.$connect();
  try {
    const store = new TangoStoreService(prismaServiceFromClient(client));
    const health = await store.getUsageHealth(args.windowMinutes);
    console.log(JSON.stringify(health, null, 2));

    if (health.totalCalls === 0) {
      console.error(`TANGO_HEALTH_NOTE No usage recorded in the last ${args.windowMinutes} minute(s).`);
    } else if (health.successRate != null && health.successRate < 0.9) {
      // A starting heuristic for a human glancing at stderr, not a plan-
      // mandated threshold or a pass/fail gate — the full byStatus/
      // byCallFamily breakdown on stdout is the actual evidence either way.
      console.error(
        `TANGO_HEALTH_WARN success rate ${(health.successRate * 100).toFixed(1)}% over the last ` +
          `${args.windowMinutes} minute(s) — below 90%. See byStatus/byCallFamily above for which call(s).`,
      );
    }
  } finally {
    await client.$disconnect();
  }
}

// Guards against running main() (a real DB connection) as a side effect of
// merely IMPORTING this module — the exact bug diag-tango-capabilities.ts
// had until decision-log D-28 caught it. Same isDirectRun pattern as every
// other executable script in this directory.
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /diag-tango-health(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('TANGO_HEALTH_ERR', err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

export { main };
