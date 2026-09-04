/**
 * MakeGov/Tango REVIEWED-UEI entity shadow sync (Funding Opportunities P19).
 *
 *   tsx scripts/sync-tango-entities.ts               # dry run
 *   tsx scripts/sync-tango-entities.ts --commit
 *   tsx scripts/sync-tango-entities.ts --commit --limit=50
 *   tsx scripts/sync-tango-entities.ts --tenant=capiro-internal --limit=50
 *   tsx scripts/sync-tango-entities.ts --client=<uuid> --limit=50
 *
 * DRY-RUN BY DEFAULT.
 *
 * For every client with a UEI — across ALL tenants unless `--tenant` or
 * `--client` narrows the selection — fetches the Tango
 * Entity and writes it to the GLOBAL `tango_resource_snapshot` table (P15),
 * keyed by that same UEI. Stamps the client's own
 * `tango_entity_last_synced_at` / `_last_attempt_at` / `_last_error` (P19's
 * migration). See that migration's own header for why this needs no
 * `TangoResourceLink` row and no new join table: a UEI is already a global,
 * exact, 1:1 key shared by both sides.
 *
 * ── "Reviewed-UEI": a name-only client NEVER triggers an entity fetch ───────
 *
 * This phase's own acceptance bar. The read is `WHERE uei IS NOT NULL`, full
 * stop — there is no fallback that tries a legal-business-name search when a
 * UEI is absent. Same invariant this program already enforces for award-
 * history identity (P02): UEI-first, never fuzzy name matching. A client
 * this sync has nothing to fetch for is skipped silently, because "no UEI
 * yet" is a normal state, not a failure.
 *
 * ── Resilience ───────────────────────────────────────────────────────────
 *
 * Goes through TangoResilienceService (P18), constructed directly here —
 * this is a script, not a NestJS request, so there is no DI container to
 * inject TANGO_RESILIENT_GATEWAY from. Same pattern
 * tango-capability-probe.service.ts's createProbeClient uses for the raw
 * SDK. Retry, the circuit breaker, the request ceiling, and usage recording
 * all apply exactly as they would inside the API process.
 *
 * ── Idempotent and resumable ───────────────────────────────────────────────
 *
 * Uses TangoStoreService's checkpoint (P15's tango_sync_checkpoint — its
 * FIRST real consumer) to resume a keyset walk over clients ordered by id,
 * so a run interrupted partway through continues rather than restarting.
 * writeSnapshot is itself a true no-op when the entity's content has not
 * changed since the last observation (P15).
 *
 * ── Tenant bypass ──────────────────────────────────────────────────────────
 *
 * `clients` is tenant-scoped with RLS ENABLED + FORCED. This sync walks
 * every tenant by default (a UEI is a fact about the client's OWN legal
 * identity, not a per-tenant concern), so every read and write goes through
 * a short-lived `set_config('app.bypass_rls', 'on', true)` transaction — the
 * same idiom `diag-tenant-config.ts` uses. Each is scoped to ONE database
 * operation, never wrapped around a slow Tango network call: holding a
 * transaction open across dozens of HTTP round trips would risk exactly the
 * lock contention and connection-pool exhaustion this idiom exists to avoid.
 *
 * ── Scoping the walk (P49 canary) ──────────────────────────────────────────
 *
 * `--tenant=<slug-or-uuid>` and `--client=<uuid>` narrow WHICH clients the
 * walk selects. They constrain the live `where` clause only — `runEntitySync`
 * itself stays scope-agnostic, because it has never known anything about the
 * rows beyond what `readClientBatch` hands it.
 *
 * `--limit` is still separately required to bound a canary run: scoping says
 * which clients may be written, not how many provider requests this run is
 * allowed to spend. The two controls are independent and the runbook asks for
 * both.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { TangoGatewayService } from '../src/external/tango/tango.client.js';
import { TangoResilienceService } from '../src/external/tango/tango-resilience.service.js';
import { TangoStoreService, computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import type { TangoGateway } from '../src/external/tango/tango.types.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

const DEFAULT_LIMIT = 500;
const DEFAULT_BATCH_SIZE = 25;
const SYNC_VERB = 'sync-tango-entities';
/** Bad arguments; nothing attempted. Same code the P47 reconciler uses. */
const EXIT_BAD_ARGS = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── CLI ──────────────────────────────────────────────────────────────────────

const BOOLEAN_FLAGS = new Set(['commit']);
const VALUE_FLAGS = new Set(['limit', 'tenant', 'client']);

export const USAGE = [
  'usage: sync-tango-entities [--commit] [--limit=<n>] [--tenant=<slug-or-uuid>] [--client=<uuid>]',
  '',
  'DRY RUN by default. --tenant/--client narrow WHICH clients are walked;',
  '--limit is separate and still bounds how many are fetched on this run.',
].join('\n');

/**
 * A flag this script does not implement.
 *
 * Until P49's canary review, both this script and sync-tango-vehicles.ts
 * silently DISCARDED an unrecognized flag. The canary runbook told the
 * operator to run `sync-tango-entities --client=<id>` for one reviewed
 * client; no such flag existed, it was dropped without a word, and the run
 * walked every client in every tenant while printing a normal-looking
 * summary. A CLI that ignores what it does not understand cannot be used to
 * contain a blast radius, so an unknown flag is now a hard stop (exit 2)
 * rather than a silent full-catalog run.
 */
export class SyncUsageError extends Error {}

function hasFlag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

function flagValue(argv: string[], name: string): string | undefined {
  const withEq = argv.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(`--${name}=`.length);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
}

/**
 * Rejects anything dash-prefixed this script does not implement, any value
 * flag left without a value, and a boolean flag handed a value. Bare
 * positional words are tolerated:
 * they are how the space form (`--limit 50`) supplies its value, and a
 * stray one cannot be mistaken for a control the operator believed in.
 */
function assertKnownFlags(argv: string[]): void {
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (!token.startsWith('-')) continue;
    const name = token.startsWith('--') ? token.slice(2).split('=')[0]! : '';
    if (BOOLEAN_FLAGS.has(name)) {
      // `--commit=true` would pass as "known" and then be ignored by hasFlag,
      // which reads only the bare form — a silent dry run when a commit was
      // meant. Same rule as an unknown flag: say so and stop.
      if (token.includes('=')) throw new SyncUsageError(`--${name} takes no value`);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      if (token.includes('=')) {
        if (token.slice(token.indexOf('=') + 1) === '') {
          throw new SyncUsageError(`missing value for --${name}`);
        }
        continue;
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('-')) {
        throw new SyncUsageError(`missing value for --${name}`);
      }
      i += 1;
      continue;
    }
    throw new SyncUsageError(`unknown flag: ${token}`);
  }
}

export interface ParsedArgs {
  commit: boolean;
  limit: number;
  /** Tenant slug OR uuid, exactly as typed. Resolved to an id in main(). */
  tenant: string | null;
  /** Client uuid. Null means every client the tenant filter leaves. */
  client: string | null;
}

export function parseArgs(argv: string[]): ParsedArgs {
  assertKnownFlags(argv);
  const limitRaw = flagValue(argv, 'limit');
  const parsed = limitRaw != null ? Number(limitRaw) : NaN;
  return {
    commit: hasFlag(argv, 'commit'),
    limit: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5000) : DEFAULT_LIMIT,
    tenant: flagValue(argv, 'tenant') ?? null,
    client: flagValue(argv, 'client') ?? null,
  };
}

/**
 * Which clients this run is allowed to touch. Both null is the historical
 * behaviour: every UEI-having client in every tenant.
 */
export interface ClientScope {
  tenantId: string | null;
  clientId: string | null;
}

// ── Injectable dependencies (the testable surface) ──────────────────────────

export interface UeiClientRow {
  id: string;
  uei: string;
}

export interface ClientStatusPatch {
  /** Set only on a DEFINITIVE provider answer (found or not_found). */
  lastSyncedAt?: Date;
  lastAttemptAt: Date;
  /** Redacted. Null clears a previously-recorded error. */
  lastError: string | null;
}

export interface SyncDeps {
  gateway: TangoGateway;
  store: TangoStoreService;
  readClientBatch: (cursor: string | null, take: number) => Promise<UeiClientRow[]>;
  updateClientStatus: (clientId: string, patch: ClientStatusPatch) => Promise<void>;
  now?: () => Date;
}

export interface SyncOptions {
  commit: boolean;
  limit: number;
  batchSize?: number;
}

export interface SyncSummary {
  processed: number;
  synced: number;
  notFound: number;
  errored: number;
  completeness: 'complete' | 'in_progress';
  cursor: string | null;
}

/**
 * The core walk. Pure with respect to its dependencies — every DB and
 * network effect is behind `deps`, so this runs against fakes in
 * sync-tango-entities.spec.ts with no real Postgres and no real Tango call.
 */
export async function runEntitySync(deps: SyncDeps, options: SyncOptions): Promise<SyncSummary> {
  const now = deps.now ?? (() => new Date());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  // No filter dimension exists for this sync (it is "every UEI-having
  // client," full stop) — an empty object's fingerprint, computed the same
  // way every other Tango checkpoint computes one, so a real filter added
  // later would get a genuinely different (non-colliding) checkpoint row
  // rather than silently sharing this one's cursor.
  const filterFingerprint = computeFilterFingerprint({});

  const checkpoint = await deps.store.readCheckpoint(SYNC_VERB, 'entity', filterFingerprint);
  let cursor: string | null = checkpoint?.cursor ?? null;

  let processed = 0;
  let synced = 0;
  let notFound = 0;
  let errored = 0;

  for (;;) {
    const remaining = options.limit - processed;
    if (remaining <= 0) break;

    const batch = await deps.readClientBatch(cursor, Math.min(batchSize, remaining));
    if (batch.length === 0) {
      if (options.commit) {
        await deps.store.writeCheckpoint({
          syncVerb: SYNC_VERB,
          resourceType: 'entity',
          filterFingerprint,
          cursor,
          completeness: 'complete',
          rowsProcessed: 0,
        });
      }
      return { processed, synced, notFound, errored, completeness: 'complete', cursor };
    }

    for (const client of batch) {
      processed += 1;
      const attemptAt = now();

      try {
        // The acceptance bar in code, not just in the query: this loop only
        // ever receives rows `readClientBatch` already filtered to
        // `uei IS NOT NULL`. There is no branch anywhere in this function
        // that could call `getEntity` with anything else.
        const entity = await deps.gateway.getEntity(client.uei);
        if (entity) synced += 1;
        else notFound += 1;

        if (options.commit) {
          await deps.updateClientStatus(client.id, {
            lastSyncedAt: attemptAt,
            lastAttemptAt: attemptAt,
            lastError: null,
          });
          if (entity) {
            await deps.store.writeSnapshot({
              resourceType: 'entity',
              externalId: client.uei,
              sourceUpdatedAt: entity.provenance.providerUpdatedAt,
              normalized: entity as unknown as Record<string, unknown>,
            });
          }
        }
      } catch (error) {
        errored += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (options.commit) {
          await deps.updateClientStatus(client.id, {
            lastAttemptAt: attemptAt,
            lastError: redact(message).slice(0, 500),
          });
        }
      }
    }

    cursor = batch[batch.length - 1]!.id;
    const isLastBatch = batch.length < batchSize || processed >= options.limit;
    if (options.commit) {
      await deps.store.writeCheckpoint({
        syncVerb: SYNC_VERB,
        resourceType: 'entity',
        filterFingerprint,
        cursor,
        completeness: isLastBatch ? 'complete' : 'in_progress',
        rowsProcessed: batch.length,
      });
    }
    if (isLastBatch) {
      return { processed, synced, notFound, errored, completeness: 'complete', cursor };
    }
  }

  return { processed, synced, notFound, errored, completeness: 'in_progress', cursor };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

function prismaServiceFromClient(client: PrismaClient): PrismaService {
  return client as unknown as PrismaService;
}

async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return fn(tx as unknown as PrismaClient);
  });
}

/**
 * Resolves `--tenant` to a tenant id, accepting either spelling the runbook
 * might use: a uuid, or the slug an operator actually knows
 * (`capiro-internal`). A tenant that does not exist is a usage error, not an
 * empty walk — "0 clients processed" and "you typed the slug wrong" must not
 * look the same in the summary.
 */
export async function resolveTenantId(prisma: PrismaClient, tenant: string): Promise<string> {
  const row = await withBypass(prisma, (tx) =>
    tx.tenant.findFirst({
      where: UUID_RE.test(tenant) ? { id: tenant } : { slug: tenant },
      select: { id: true },
    }),
  );
  if (!row) throw new SyncUsageError(`tenant not found: ${tenant}`);
  return row.id;
}

/**
 * Exported for the scoping test: the `where` clause is the whole behaviour,
 * and a fake Prisma proves it without a database.
 */
export function realReadClientBatch(prisma: PrismaClient, scope: ClientScope): SyncDeps['readClientBatch'] {
  return async (cursor, take) =>
    withBypass(prisma, (tx) =>
      tx.client.findMany({
        where: {
          uei: { not: null },
          // The canary's containment, in the query rather than in a runbook
          // sentence. Absent both, this is byte-for-byte the historical
          // all-tenant read.
          ...(scope.tenantId ? { tenantId: scope.tenantId } : {}),
          ...(scope.clientId ? { id: scope.clientId } : {}),
        },
        orderBy: { id: 'asc' },
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        take,
        select: { id: true, uei: true },
      }),
    ) as unknown as Promise<UeiClientRow[]>;
}

function realUpdateClientStatus(prisma: PrismaClient): SyncDeps['updateClientStatus'] {
  return async (clientId, patch) => {
    await withBypass(prisma, (tx) =>
      tx.client.update({
        where: { id: clientId },
        data: {
          ...(patch.lastSyncedAt !== undefined ? { tangoEntityLastSyncedAt: patch.lastSyncedAt } : {}),
          tangoEntityLastAttemptAt: patch.lastAttemptAt,
          tangoEntityLastError: patch.lastError,
        },
      }),
    );
  };
}

async function main(): Promise<void> {
  let args: ParsedArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    if (error instanceof SyncUsageError) {
      console.error(`TANGO_SYNC_ERR ${error.message}\n${USAGE}`);
      process.exitCode = EXIT_BAD_ARGS;
      return;
    }
    throw error;
  }

  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error(
      'TANGO_SYNC_ERR No TANGO_API_KEY configured. This sync makes real Tango calls and refuses ' +
        'to run without a real key, the same posture as the product gateway (TangoNotConfiguredError).',
    );
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    let scope: ClientScope;
    try {
      scope = {
        tenantId: args.tenant ? await resolveTenantId(prisma, args.tenant) : null,
        clientId: args.client,
      };
    } catch (error) {
      if (error instanceof SyncUsageError) {
        console.error(`TANGO_SYNC_ERR ${error.message}\n${USAGE}`);
        process.exitCode = EXIT_BAD_ARGS;
        return;
      }
      throw error;
    }

    const rawGateway = new TangoGatewayService({
      apiKey,
      baseUrl: process.env.TANGO_API_BASE_URL,
      timeoutMs: process.env.TANGO_TIMEOUT_MS ? Number(process.env.TANGO_TIMEOUT_MS) : undefined,
    });
    const store = new TangoStoreService(prismaServiceFromClient(prisma));
    const gateway = new TangoResilienceService(rawGateway, store, {
      requestCeiling: process.env.TANGO_REQUEST_CEILING_PER_RUN
        ? Number(process.env.TANGO_REQUEST_CEILING_PER_RUN)
        : undefined,
      breakerThreshold: process.env.TANGO_CIRCUIT_BREAKER_THRESHOLD
        ? Number(process.env.TANGO_CIRCUIT_BREAKER_THRESHOLD)
        : undefined,
      breakerCooldownMs: process.env.TANGO_CIRCUIT_BREAKER_COOLDOWN_MS
        ? Number(process.env.TANGO_CIRCUIT_BREAKER_COOLDOWN_MS)
        : undefined,
    });

    const summary = await runEntitySync(
      {
        gateway,
        store,
        readClientBatch: realReadClientBatch(prisma, scope),
        updateClientStatus: realUpdateClientStatus(prisma),
      },
      { commit: args.commit, limit: args.limit },
    );

    // `scope` is echoed deliberately: the defect this closes was an operator
    // believing a run was contained when it was not, and a summary that says
    // nothing about scope cannot correct that belief.
    console.log(
      `TANGO_SYNC_DONE ${JSON.stringify({ ...summary, commit: args.commit, scope, health: gateway.getHealth() })}`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-entities(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('TANGO_SYNC_ERR', redactWithKnownSecret(redact(message), process.env.TANGO_API_KEY ?? null));
    process.exitCode = 1;
  });
}

export { main };
