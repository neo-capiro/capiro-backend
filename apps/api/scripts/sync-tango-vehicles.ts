/**
 * MakeGov/Tango relevant vehicles and past-performance sync (Funding
 * Opportunities P22).
 *
 *   tsx scripts/sync-tango-vehicles.ts               # dry run
 *   tsx scripts/sync-tango-vehicles.ts --commit
 *   tsx scripts/sync-tango-vehicles.ts --commit --limit=20
 *
 * DRY-RUN BY DEFAULT.
 *
 * Walks EVERY Tango vehicle and every awardee on it — there is no
 * awardee-UEI filter on the provider's list endpoints — but only PERSISTS
 * an awardee that matches a UEI Capiro already knows about (as the awardee
 * itself, or as the awardee's PARENT — see TangoVehicleAwardee's own doc for
 * why those stay distinguishable). The overwhelming majority of
 * vehicles/awardees are irrelevant to any Capiro client and are read,
 * checked, and discarded without ever being written anywhere.
 *
 * ── The 'parent' relationship is real code, currently unreachable ─────────
 *
 * A live-key run found that this endpoint's `recipient` expansion has no
 * parent/owner UEI field at all (decision-log D-41) — `TangoVehicleAwardee
 * .recipientParentUei` is therefore always null today, which means the
 * `relationship === 'parent'` branch below can never actually match live
 * data yet. It stays — tested, not deleted — because the LOGIC is correct
 * and the gap is the PROVIDER's current data model, not this sync's design;
 * deleting it would silently lose "you are on this vehicle" vs. "your
 * parent is" the moment the provider (or a future SDK version reaching
 * `getEntity`'s `immediate_owner`/`highest_owner`) adds the data back.
 *
 * A match writes THREE things: the vehicle's own snapshot and the specific
 * matching awardee's snapshot (both to the GLOBAL, versioned
 * `tango_resource_snapshot` — P15), and a row in the tenant-scoped,
 * MATERIALIZED `client_relevant_vehicle` summary (P22's own table) so a
 * later read never has to scan JSONB across every snapshot to answer
 * "which vehicles matter to this client".
 *
 * ── Resilience ─────────────────────────────────────────────────────────────
 *
 * Goes through TangoResilienceService (P18), constructed directly here —
 * same pattern as sync-tango-entities.ts. If the request ceiling is reached
 * partway through a vehicle's awardee pages, the WHOLE sync stops cleanly
 * (reported as `ceilingReached: true`) rather than looping through the
 * remaining vehicles only to hit the same refusal on each one's first call.
 *
 * ── Resumable, two-level pagination ────────────────────────────────────────
 *
 * The checkpoint (P15's tango_sync_checkpoint) tracks progress over the
 * OUTER vehicle list only — a single vehicle's awardees are always drained
 * fully before moving to the next vehicle, so there is nothing to resume
 * mid-vehicle. Idempotent: re-running never duplicates a snapshot (P15's
 * versioned-head policy) or a relevant-vehicle row (this table's own unique
 * index; the upsert is keyed on it).
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { TangoGatewayService } from '../src/external/tango/tango.client.js';
import { TangoResilienceService, TangoRequestCeilingExceededError } from '../src/external/tango/tango-resilience.service.js';
import { TangoStoreService, computeFilterFingerprint } from '../src/external/tango/tango-store.service.js';
import type { TangoGateway, TangoVehicle, TangoVehicleAwardee } from '../src/external/tango/tango.types.js';
import { redact, redactWithKnownSecret } from '../src/external/tango/tango.errors.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';

dotenvConfig();

const DEFAULT_LIMIT = 500;
const AWARDEE_PAGE_SIZE = 100;
const SYNC_VERB = 'sync-tango-vehicles';

// ── CLI ──────────────────────────────────────────────────────────────────────

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
  commit: boolean;
  limit: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const limitRaw = flagValue(argv, 'limit');
  const parsed = limitRaw != null ? Number(limitRaw) : NaN;
  return {
    commit: hasFlag(argv, 'commit'),
    limit: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5000) : DEFAULT_LIMIT,
  };
}

// ── Injectable dependencies (the testable surface) ──────────────────────────

export interface KnownClientRef {
  tenantId: string;
  clientId: string;
}

export interface RelevantMatch {
  tenantId: string;
  clientId: string;
  relationship: 'self' | 'parent';
  vehicle: TangoVehicle;
  awardee: TangoVehicleAwardee;
}

export interface VehicleSyncDeps {
  gateway: TangoGateway;
  store: TangoStoreService;
  /** UEI -> every (tenantId, clientId) pair whose OWN uei is that value. */
  loadKnownUeis: () => Promise<Map<string, KnownClientRef[]>>;
  upsertRelevantVehicle: (match: RelevantMatch) => Promise<void>;
}

export interface VehicleSyncOptions {
  commit: boolean;
  limit: number;
  vehicleBatchSize?: number;
}

export interface VehicleSyncSummary {
  vehiclesProcessed: number;
  vehiclesRelevant: number;
  relevantRowsWritten: number;
  errored: number;
  ceilingReached: boolean;
  completeness: 'complete' | 'in_progress';
}

/** Every awardee on one vehicle that matches a known UEI, self or parent. */
async function findMatchingAwardees(
  gateway: TangoGateway,
  vehicle: TangoVehicle,
  known: Map<string, KnownClientRef[]>,
): Promise<RelevantMatch[]> {
  const matches: RelevantMatch[] = [];
  let cursor: string | null = null;
  for (;;) {
    const page = await gateway.listVehicleAwardees(vehicle.vehicleId, { cursor, limit: AWARDEE_PAGE_SIZE });
    for (const awardee of page.items) {
      if (awardee.recipientUei) {
        for (const ref of known.get(awardee.recipientUei) ?? []) {
          matches.push({ ...ref, relationship: 'self', vehicle, awardee });
        }
      }
      // A recipient cannot be both itself and its own parent on the same
      // row — but two DIFFERENT known clients could each match (one as the
      // direct awardee, another as its parent), so both checks always run.
      if (awardee.recipientParentUei) {
        for (const ref of known.get(awardee.recipientParentUei) ?? []) {
          matches.push({ ...ref, relationship: 'parent', vehicle, awardee });
        }
      }
    }
    cursor = page.nextCursor;
    if (cursor == null) break;
  }
  return matches;
}

/**
 * The core walk. Pure with respect to its dependencies — every DB and
 * network effect is behind `deps`, so this runs against fakes in
 * sync-tango-vehicles.spec.ts with no real Postgres and no real Tango call.
 */
export async function runVehicleSync(deps: VehicleSyncDeps, options: VehicleSyncOptions): Promise<VehicleSyncSummary> {
  const filterFingerprint = computeFilterFingerprint({});
  const checkpoint = await deps.store.readCheckpoint(SYNC_VERB, 'vehicle', filterFingerprint);
  let cursor: string | null = checkpoint?.cursor ?? null;

  const known = await deps.loadKnownUeis();

  let vehiclesProcessed = 0;
  let vehiclesRelevant = 0;
  let relevantRowsWritten = 0;
  let errored = 0;
  let ceilingReached = false;

  outer: for (;;) {
    const remaining = options.limit - vehiclesProcessed;
    if (remaining <= 0) break;
    // Capped to `remaining`, not just `vehicleBatchSize` — otherwise a page
    // can come back longer than what's left on this run, forcing a mid-page
    // `break outer` below that would skip the `cursor = page.nextCursor`
    // update and the checkpoint write entirely. That was a real bug: a run
    // stopped by --limit (rather than by exhausting the provider) left
    // `cursor` at its pre-page value — `null` on a first-page stop — so the
    // final `completeness` wrongly reported `'complete'` and a resumed run
    // would restart from the beginning instead of continuing. Matches
    // sync-tango-entities.ts's identical discipline (P19).
    const page = await deps.gateway.listVehicles({
      cursor,
      limit: Math.min(options.vehicleBatchSize ?? 25, remaining),
    });

    for (const vehicle of page.items) {
      vehiclesProcessed += 1;

      try {
        const matches = await findMatchingAwardees(deps.gateway, vehicle, known);
        if (matches.length > 0) {
          vehiclesRelevant += 1;
          if (options.commit) {
            await deps.store.writeSnapshot({
              resourceType: 'vehicle',
              externalId: vehicle.vehicleId,
              sourceUpdatedAt: vehicle.provenance.providerUpdatedAt,
              normalized: vehicle as unknown as Record<string, unknown>,
            });
          }
          for (const match of matches) {
            relevantRowsWritten += 1;
            if (options.commit) {
              await deps.store.writeSnapshot({
                resourceType: 'vehicle_awardee',
                // Composite: an awardee id is only unique WITHIN a vehicle.
                externalId: `${vehicle.vehicleId}#${match.awardee.awardeeId}`,
                sourceUpdatedAt: match.awardee.provenance.providerUpdatedAt,
                normalized: match.awardee as unknown as Record<string, unknown>,
              });
              await deps.upsertRelevantVehicle(match);
            }
          }
        }
      } catch (error) {
        if (error instanceof TangoRequestCeilingExceededError) {
          // Stop the WHOLE sync, not just this vehicle — every remaining
          // vehicle would hit the identical refusal on its first call.
          ceilingReached = true;
          break outer;
        }
        errored += 1;
      }
    }

    cursor = page.nextCursor;
    const isDone = cursor == null;
    if (options.commit) {
      await deps.store.writeCheckpoint({
        syncVerb: SYNC_VERB,
        resourceType: 'vehicle',
        filterFingerprint,
        cursor,
        completeness: isDone ? 'complete' : 'in_progress',
        rowsProcessed: page.items.length,
      });
    }
    if (isDone) break;
  }

  return {
    vehiclesProcessed,
    vehiclesRelevant,
    relevantRowsWritten,
    errored,
    ceilingReached,
    completeness: ceilingReached || cursor != null ? 'in_progress' : 'complete',
  };
}

// ── Real wiring ──────────────────────────────────────────────────────────────

function prismaServiceFromClient(client: PrismaClient): PrismaService {
  return client as unknown as PrismaService;
}

async function loadKnownUeisReal(prisma: PrismaClient): Promise<Map<string, KnownClientRef[]>> {
  const rows = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
    return tx.client.findMany({ where: { uei: { not: null } }, select: { id: true, tenantId: true, uei: true } });
  });
  const map = new Map<string, KnownClientRef[]>();
  for (const row of rows) {
    const uei = row.uei!;
    const list = map.get(uei) ?? [];
    list.push({ tenantId: row.tenantId, clientId: row.id });
    map.set(uei, list);
  }
  return map;
}

function realUpsertRelevantVehicle(prisma: PrismaClient): VehicleSyncDeps['upsertRelevantVehicle'] {
  return async (match) => {
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
      await tx.clientRelevantVehicle.upsert({
        where: {
          tenantId_clientId_tangoVehicleId_relationship: {
            tenantId: match.tenantId,
            clientId: match.clientId,
            tangoVehicleId: match.vehicle.vehicleId,
            relationship: match.relationship,
          },
        },
        create: {
          tenantId: match.tenantId,
          clientId: match.clientId,
          tangoVehicleId: match.vehicle.vehicleId,
          vehicleName: match.vehicle.programAcronym ?? match.vehicle.solicitationTitle,
          vehicleType: match.vehicle.vehicleType,
          relationship: match.relationship,
          recipientUei: match.relationship === 'self' ? match.awardee.recipientUei! : match.awardee.recipientParentUei!,
          orderCount: match.awardee.orderCount,
          idvObligations: match.awardee.idvObligations,
          idvContractsValue: match.awardee.idvContractsValue,
        },
        update: {
          vehicleName: match.vehicle.programAcronym ?? match.vehicle.solicitationTitle,
          vehicleType: match.vehicle.vehicleType,
          orderCount: match.awardee.orderCount,
          idvObligations: match.awardee.idvObligations,
          idvContractsValue: match.awardee.idvContractsValue,
          lastSyncedAt: new Date(),
        },
      });
    });
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const apiKey = (process.env.TANGO_API_KEY ?? '').trim();
  if (!apiKey) {
    console.error('TANGO_VEHICLE_SYNC_ERR No TANGO_API_KEY configured.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
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

    const summary = await runVehicleSync(
      {
        gateway,
        store,
        loadKnownUeis: () => loadKnownUeisReal(prisma),
        upsertRelevantVehicle: realUpsertRelevantVehicle(prisma),
      },
      { commit: args.commit, limit: args.limit },
    );

    console.log(`TANGO_VEHICLE_SYNC_DONE ${JSON.stringify({ ...summary, commit: args.commit, health: gateway.getHealth() })}`);
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /sync-tango-vehicles(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error('TANGO_VEHICLE_SYNC_ERR', redactWithKnownSecret(redact(message), process.env.TANGO_API_KEY ?? null));
    process.exitCode = 1;
  });
}

export { main };
