/**
 * District Nexus — prune stale `assistance_recipient` review candidates.
 *
 * ── Why this exists ─────────────────────────────────────────────────────────
 *
 * The original assistance-recipient matcher scored name similarity as a
 * graduated signal. Against `federal_assistance_award`'s recipient pool —
 * universities, counties, foundations, energy companies — that produced
 * confident-looking nonsense. Measured live on 2026-07-27: of 183
 * `assistance_recipient` rows in `client_intel_mapping`, **173 (95%) had
 * trigram similarity below 0.6**, including:
 *
 *   Olivet University            -> DUKE UNIVERSITY               $4,212,491,964
 *   Olivet University            -> EMORY UNIVERSITY              $3,370,524,456
 *   National Wildlife Federation -> NATIONAL FISH AND WILDLIFE FOUNDATION
 *   SANTA ROSA COUNTY            -> COUNTY OF SANTA CLARA           $134,811,719
 *
 * Confirming a mapping asserts "this client IS this federal assistance
 * recipient", so bulk-confirming that queue would misattribute over $15B of
 * federal assistance across unrelated organisations. A reviewer working
 * top-down by confidence hits DUKE UNIVERSITY at 0.5 with $4.2B attached.
 *
 * `entity-resolution.service.ts` was since fixed: a non-fingerprint-exact
 * `assistance_recipient` name match is now capped at NON_DISTINCTIVE_MATCH_CAP
 * (0.35), strictly below MIN_WRITE_CONFIDENCE (0.4), so it is dropped rather
 * than written. That stops NEW junk. It does nothing about the rows already
 * sitting in the review queue — which is what this script removes.
 *
 * ── What counts as stale ────────────────────────────────────────────────────
 *
 * Exactly one rule: **would today's matcher still write this row?** A row is
 * KEPT if either verified-identifier path holds —
 *
 *   1. `externalId` is a UEI and equals the client's own `Client.uei`
 *      (ASSISTANCE_RECIPIENT_UEI_MATCH_CONFIDENCE = 0.97), or
 *   2. the client name and `externalName` are fingerprint-exact.
 *
 * — and pruned otherwise. The classifier calls `fingerprintName` and
 * `sharesDistinctiveToken` from the matcher itself rather than reimplementing
 * them, so the two cannot drift and start disagreeing about which rows are junk.
 *
 * ── Safety ──────────────────────────────────────────────────────────────────
 *
 *   - DRY RUN BY DEFAULT. `--commit` is required to delete anything.
 *   - `confirmed: true` rows are excluded by the query AND re-asserted per row
 *     before deletion. A human decision is never undone by this job.
 *   - Only `source = 'assistance_recipient'` is ever touched.
 *   - Deletions are per-id, never a bulk `deleteMany` on a filter, so a filter
 *     mistake cannot cascade.
 *   - Idempotent: re-running after a commit finds nothing, because the fixed
 *     matcher will not recreate these rows.
 *
 *   tsx scripts/prune-stale-assistance-recipient-candidates.ts                  # dry run
 *   tsx scripts/prune-stale-assistance-recipient-candidates.ts --tenant <uuid>  # dry run, one tenant
 *   tsx scripts/prune-stale-assistance-recipient-candidates.ts --commit         # deletes
 *
 * ── RLS ─────────────────────────────────────────────────────────────────────
 * `clients` and `client_intel_mapping` are FORCE-RLS. This script has no
 * NestJS PrismaService tenant-scope extension, so every statement runs inside
 * `withBypass` (sets `app.bypass_rls`) AND carries an explicit `tenantId`
 * filter. The bypass only satisfies the RLS predicate; the explicit tenantId is
 * what actually SCOPES the query. Omitting either half is a real cross-tenant
 * bug — same idiom as generate-grant-opportunity-candidates.ts.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import {
  fingerprintName,
  sharesDistinctiveToken,
} from '../src/intelligence/entity-resolution.service.js';

dotenvConfig();

const SOURCE = 'prune-stale-assistance-recipient-candidates';
const MAPPING_SOURCE = 'assistance_recipient';

// ── CLI ─────────────────────────────────────────────────────────────────────

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
  tenantId: string | null;
}

/** Unknown flags are ignored, matching the repo's dominant CLI convention. */
export function parseArgs(argv: string[]): ParsedArgs {
  return {
    commit: hasFlag(argv, 'commit'),
    tenantId: flagValue(argv, 'tenant') ?? null,
  };
}

// ── Classification (pure) ───────────────────────────────────────────────────

export type PruneVerdict =
  | 'keep_uei_match'
  | 'keep_fingerprint_exact'
  | 'keep_confirmed'
  | 'prune_no_distinctive_token'
  | 'prune_name_similarity_only';

export interface CandidateRow {
  id: string;
  tenantId: string;
  clientId: string;
  clientName: string;
  /** Client.uei — the verified identifier, when the client has one on file. */
  clientUei: string | null;
  externalId: string;
  externalName: string;
  confidence: number;
  confirmed: boolean;
}

/** UEIs are 12 alphanumerics; anything else is a name masquerading as an id. */
function isUeiShaped(value: string): boolean {
  return /^[A-Z0-9]{12}$/.test(value.trim().toUpperCase());
}

/**
 * Reproduce today's matcher verdict for one historical row.
 *
 * `keep_confirmed` short-circuits everything else. A confirmed row is a human
 * assertion; this job's opinion about the name heuristic is irrelevant to it,
 * and returning a prune verdict for one would be a latent footgun for any
 * future caller that forgot the query filter.
 */
export function classifyCandidate(row: CandidateRow): PruneVerdict {
  if (row.confirmed) return 'keep_confirmed';

  const clientUei = row.clientUei?.trim().toUpperCase();
  if (clientUei && isUeiShaped(row.externalId) && row.externalId.trim().toUpperCase() === clientUei) {
    return 'keep_uei_match';
  }

  const clientFp = fingerprintName(row.clientName);
  const externalFp = fingerprintName(row.externalName);
  if (clientFp.length > 0 && clientFp === externalFp) return 'keep_fingerprint_exact';

  return sharesDistinctiveToken(clientFp, externalFp)
    ? 'prune_name_similarity_only'
    : 'prune_no_distinctive_token';
}

export function isPruneVerdict(verdict: PruneVerdict): boolean {
  return verdict.startsWith('prune_');
}

// ── Prisma surface (narrow, so the spec can supply a fake) ──────────────────

export interface PrunePrisma {
  $transaction<T>(fn: (tx: PrunePrisma) => Promise<T>): Promise<T>;
  $executeRawUnsafe(sql: string): Promise<number>;
  $queryRaw<T = unknown>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]>;
  clientIntelMapping: {
    delete(args: { where: { id: string } }): Promise<unknown>;
  };
}

async function withBypass<T>(prisma: PrunePrisma, fn: (tx: PrunePrisma) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export interface PruneResult {
  scanned: number;
  pruned: number;
  kept: number;
  errors: number;
  /** Every verdict, so a dry run is a full audit artifact and not just a count. */
  byVerdict: Record<PruneVerdict, number>;
  /** Ids actually deleted (commit) or that WOULD be deleted (dry run). */
  prunedIds: string[];
  /** Human-readable lines for the operator, one per pruned row. */
  prunedDetail: string[];
}

function emptyByVerdict(): Record<PruneVerdict, number> {
  return {
    keep_uei_match: 0,
    keep_fingerprint_exact: 0,
    keep_confirmed: 0,
    prune_no_distinctive_token: 0,
    prune_name_similarity_only: 0,
  };
}

/**
 * Load the unconfirmed assistance_recipient candidates for one tenant, or for
 * every tenant when `tenantId` is null.
 *
 * `confirmed = false` is in the SQL rather than filtered in JS on purpose: a
 * confirmed row should never even be loaded by a job whose only write is a
 * DELETE.
 */
export async function loadCandidates(
  prisma: PrunePrisma,
  tenantId: string | null,
): Promise<CandidateRow[]> {
  return withBypass(prisma, async (tx) => {
    const rows = tenantId
      ? await tx.$queryRaw<CandidateRow>`
          SELECT m.id::text          AS "id",
                 m.tenant_id::text   AS "tenantId",
                 m.client_id::text   AS "clientId",
                 c.name              AS "clientName",
                 c.uei               AS "clientUei",
                 m.external_id       AS "externalId",
                 m.external_name     AS "externalName",
                 m.confidence        AS "confidence",
                 m.confirmed         AS "confirmed"
          FROM client_intel_mapping m
          JOIN clients c ON c.id = m.client_id
          WHERE m.source = ${MAPPING_SOURCE}
            AND m.confirmed = false
            AND m.tenant_id = ${tenantId}::uuid
          ORDER BY m.confidence DESC, m.id
        `
      : await tx.$queryRaw<CandidateRow>`
          SELECT m.id::text          AS "id",
                 m.tenant_id::text   AS "tenantId",
                 m.client_id::text   AS "clientId",
                 c.name              AS "clientName",
                 c.uei               AS "clientUei",
                 m.external_id       AS "externalId",
                 m.external_name     AS "externalName",
                 m.confidence        AS "confidence",
                 m.confirmed         AS "confirmed"
          FROM client_intel_mapping m
          JOIN clients c ON c.id = m.client_id
          WHERE m.source = ${MAPPING_SOURCE}
            AND m.confirmed = false
          ORDER BY m.confidence DESC, m.id
        `;
    return rows;
  });
}

export async function pruneStaleCandidates(
  prisma: PrunePrisma,
  options: { tenantId: string | null; commit: boolean },
): Promise<PruneResult> {
  const rows = await loadCandidates(prisma, options.tenantId);
  const result: PruneResult = {
    scanned: rows.length,
    pruned: 0,
    kept: 0,
    errors: 0,
    byVerdict: emptyByVerdict(),
    prunedIds: [],
    prunedDetail: [],
  };

  for (const row of rows) {
    const verdict = classifyCandidate(row);
    result.byVerdict[verdict] += 1;

    if (!isPruneVerdict(verdict)) {
      result.kept += 1;
      continue;
    }

    // Belt and braces: the query already excluded confirmed rows, but a DELETE
    // driven by a heuristic re-checks the one invariant that must never break.
    if (row.confirmed) {
      result.kept += 1;
      continue;
    }

    result.prunedIds.push(row.id);
    result.prunedDetail.push(
      `${row.id} tenant=${row.tenantId} client="${row.clientName}" -> "${row.externalName}" ` +
        `(externalId=${row.externalId}, confidence=${row.confidence.toFixed(2)}, ${verdict})`,
    );

    if (!options.commit) {
      result.pruned += 1;
      continue;
    }

    try {
      await withBypass(prisma, (tx) => tx.clientIntelMapping.delete({ where: { id: row.id } }));
      result.pruned += 1;
    } catch (error) {
      result.errors += 1;
      console.error(`[${SOURCE}] failed to delete ${row.id}: ${(error as Error).message}`);
    }
  }

  return result;
}

// ── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv);
  const prisma = new PrismaClient();
  try {
    const result = await pruneStaleCandidates(prisma as unknown as PrunePrisma, {
      tenantId: parsed.tenantId,
      commit: parsed.commit,
    });

    for (const line of result.prunedDetail) console.log(`[${SOURCE}] PRUNE ${line}`);

    console.log(
      `[${SOURCE}] scanned=${result.scanned} pruned=${result.pruned} kept=${result.kept} ` +
        `errors=${result.errors} verdicts=${JSON.stringify(result.byVerdict)}`,
    );

    if (!parsed.commit) {
      console.log(
        `[${SOURCE}] DRY RUN — no database writes. Would delete ${result.pruned} row(s). Pass --commit to apply.`,
      );
    } else {
      console.log(`[${SOURCE}] DONE — deleted ${result.pruned} row(s).`);
    }
    if (result.errors > 0) process.exitCode = 1;
  } finally {
    await (prisma as unknown as { $disconnect(): Promise<void> }).$disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, (error as Error).message);
    process.exit(1);
  });
}
