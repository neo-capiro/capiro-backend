/**
 * Migrate legacy `clients.set_aside_certifications` values onto the durable
 * certification vocabulary.
 *
 *   tsx scripts/repair-set-aside-certifications.ts                  # dry run
 *   tsx scripts/repair-set-aside-certifications.ts --commit
 *   tsx scripts/repair-set-aside-certifications.ts --tenant <uuid> --commit
 *   tsx scripts/repair-set-aside-certifications.ts --client <uuid>  # dry run, one client
 *
 * ── What is being repaired ──────────────────────────────────────────────────
 *
 * The field used to accept SAM's `typeOfSetAside` vocabulary, which is the wrong
 * vocabulary for a company profile and let two kinds of non-certification in:
 *
 *   * 'SBA' / 'SBP' — general small-business RESTRICTIONS on a solicitation. No
 *     firm holds an "SBA certification". Recording one made the eligibility check
 *     read it back as evidence and report the client `eligible` for a set-aside it
 *     had shown nothing about.
 *   * '8AN' / 'SDVOSBS' / 'WOSBSS' / 'EDWOSBSS' / 'HZS' — SOLE-SOURCE notice
 *     codes. A competition method, not a status a company holds.
 *
 * `set-aside.ts` owns the mapping. The competed/sole-source pairs collapse onto
 * the same durable status ('SDVOSBC' and 'SDVOSBS' both mean the firm is an
 * SDVOSB), so those are a rename. 'SBA'/'SBP' map to NOTHING and are DROPPED —
 * the honest home for "we are a small business" is the `applicant_types`
 * self-report, and inventing a certification to preserve the row would recreate
 * the defect.
 *
 * ── Why dropping a value is safe here ───────────────────────────────────────
 *
 * Losing 'SBA' from this array costs nothing, because it never carried
 * information: `evaluateSetAsideEligibility` ignores non-durable values entirely,
 * so a client with only 'SBA' recorded gets the same answer before and after. What
 * changes is that the value can no longer be MISREAD by a future consumer.
 *
 * Every drop is written to the audit log with the before/after array, so the
 * original is recoverable.
 */
import { config as dotenvConfig } from 'dotenv';
import { Prisma, PrismaClient } from '@prisma/client';
import { emptyCounts, runWithSyncRun, type RunCounts } from '../src/ingestion/sync-run.helper.js';
import {
  LEGACY_SET_ASIDE_VALUE_MIGRATION,
  isDurableSetAsideCertification,
  normalizeSetAsideCode,
} from '../src/funding-opportunities/set-aside.js';

dotenvConfig();

const SOURCE = 'repair-set-aside-certifications';
/** Keyset page size. Bounded per query, unbounded in total. */
const PAGE_SIZE = 500;

export interface RepairSetAsideArgs {
  commit: boolean;
  tenantId: string | null;
  clientId: string | null;
}

function flag(argv: string[], name: string): boolean {
  return argv.includes(`--${name}`);
}
function value(argv: string[], name: string): string | null {
  const eq = argv.find((item) => item.startsWith(`--${name}=`));
  if (eq) return eq.slice(name.length + 3);
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && index + 1 < argv.length ? argv[index + 1]! : null;
}

export function parseRepairSetAsideArgs(argv: string[]): RepairSetAsideArgs {
  return {
    commit: flag(argv, 'commit'),
    tenantId: value(argv, 'tenant'),
    clientId: value(argv, 'client'),
  };
}

/**
 * The pure decision: what should this client's array become?
 *
 * Returns `null` when nothing changes, which is what makes the whole pass
 * IDEMPOTENT — a second run over repaired data produces no writes at all, rather
 * than rewriting identical arrays and churning `updated_at`.
 */
export function repairCertifications(current: readonly string[]): {
  next: string[];
  renamed: Array<{ from: string; to: string }>;
  dropped: string[];
  unrecognized: string[];
} | null {
  const renamed: Array<{ from: string; to: string }> = [];
  const dropped: string[] = [];
  const unrecognized: string[] = [];
  const next: string[] = [];

  for (const raw of current) {
    const code = normalizeSetAsideCode(raw);
    if (!code) {
      dropped.push(raw);
      continue;
    }
    if (isDurableSetAsideCertification(code)) {
      // Already durable. Push the NORMALIZED form so '8(a)' becomes '8A' — the
      // eligibility check normalizes too, so this is cosmetic, but leaving two
      // spellings of one certification in the column invites a future consumer to
      // compare them literally.
      if (code !== raw) renamed.push({ from: raw, to: code });
      next.push(code);
      continue;
    }
    if (code in LEGACY_SET_ASIDE_VALUE_MIGRATION) {
      const target = LEGACY_SET_ASIDE_VALUE_MIGRATION[code]!;
      if (target === null) {
        dropped.push(raw);
      } else {
        renamed.push({ from: raw, to: target });
        next.push(target);
      }
      continue;
    }
    // Not durable, and not a value the legacy table knows. Dropped rather than
    // kept: the eligibility path already ignores it, so keeping it preserves only
    // the risk that something else reads it as evidence.
    unrecognized.push(raw);
    dropped.push(raw);
  }

  // Dedupe, preserving first-seen order. 'SDVOSBC' + 'SDVOSBS' both collapse to
  // 'SDVOSB', and a duplicated certification is not a second certification.
  const deduped = [...new Set(next)];

  const unchanged =
    deduped.length === current.length && deduped.every((code, index) => code === current[index]);
  if (unchanged) return null;
  return { next: deduped, renamed, dropped, unrecognized };
}

async function withBypass<T>(prisma: PrismaClient, fn: (tx: PrismaClient) => Promise<T>): Promise<T> {
  return prisma.$transaction(async (rawTx) => {
    const tx = rawTx as unknown as PrismaClient;
    await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export interface RepairSetAsideResult extends RunCounts {
  evaluated: number;
  repaired: number;
  renamedValues: number;
  droppedValues: number;
  /** Values no vocabulary recognised. Reported so a real one is not silently binned. */
  unrecognizedValues: string[];
}

export async function repairSetAsideCertifications(
  prisma: PrismaClient,
  options: { tenantId: string | null; clientId: string | null; commit: boolean },
): Promise<RepairSetAsideResult> {
  const counts = emptyCounts();
  let evaluated = 0;
  let repaired = 0;
  let renamedValues = 0;
  let droppedValues = 0;
  const unrecognizedValues = new Set<string>();

  // Keyset over (id), scoped by tenant/client when asked. No cap: a capped repair
  // that silently stops is worse than no repair, because the operator believes the
  // data is clean.
  let cursor: string | null = null;
  for (;;) {
    const rows: Array<{ id: string; tenantId: string; setAsideCertifications: string[] }> =
      await withBypass(prisma, (tx) =>
        tx.client.findMany({
          where: {
            ...(options.tenantId ? { tenantId: options.tenantId } : {}),
            ...(options.clientId ? { id: options.clientId } : {}),
            ...(cursor ? { id: { gt: cursor } } : {}),
            // Only clients that actually record something — an empty array cannot
            // need repair, and skipping them in SQL keeps the walk short.
            NOT: { setAsideCertifications: { equals: [] } },
          },
          select: { id: true, tenantId: true, setAsideCertifications: true },
          orderBy: { id: 'asc' },
          take: PAGE_SIZE,
        }),
      );
    if (rows.length === 0) break;
    cursor = rows[rows.length - 1]!.id;

    for (const row of rows) {
      evaluated += 1;
      try {
        const decision = repairCertifications(row.setAsideCertifications);
        if (decision === null) {
          counts.skipped += 1;
          continue;
        }
        repaired += 1;
        renamedValues += decision.renamed.length;
        droppedValues += decision.dropped.length;
        for (const value of decision.unrecognized) unrecognizedValues.add(value);

        if (options.commit) {
          // Copied BEFORE the update. The audit's whole value is that it holds the
          // original array, and reading the row's field after writing it relies on
          // the row object being a detached snapshot — true of Prisma today, but a
          // silent way to lose the only copy of a dropped value if it ever is not.
          const original = [...row.setAsideCertifications];
          await withBypass(prisma, async (tx) => {
            await tx.client.update({
              where: { id: row.id },
              data: { setAsideCertifications: decision.next },
            });
            // Audited in the same transaction, with the ORIGINAL array, so every
            // dropped value is recoverable from the ledger.
            await tx.auditLog.create({
              data: {
                tenantId: row.tenantId,
                actorUserId: null,
                actorRole: 'system',
                action: 'client.set_aside_certifications.repaired',
                entityType: 'clients',
                entityId: row.id,
                before: { setAsideCertifications: original } as Prisma.InputJsonValue,
                after: {
                  setAsideCertifications: decision.next,
                  renamed: decision.renamed,
                  dropped: decision.dropped,
                  unrecognized: decision.unrecognized,
                } as Prisma.InputJsonValue,
                requestId: SOURCE,
              },
            });
          });
        }
        counts.updated += 1;
      } catch (error) {
        counts.errors += 1;
        console.warn(`[${SOURCE}] client ${row.id} failed: ${(error as Error).message}`);
      }
    }

    if (rows.length < PAGE_SIZE) break;
  }

  return {
    ...counts,
    evaluated,
    repaired,
    renamedValues,
    droppedValues,
    unrecognizedValues: [...unrecognizedValues],
  };
}

async function main(): Promise<void> {
  const args = parseRepairSetAsideArgs(process.argv);
  const prisma = new PrismaClient();
  try {
    const execute = async (): Promise<RunCounts> => {
      const result = await repairSetAsideCertifications(prisma, args);
      console.log(
        `[${SOURCE}] ${args.commit ? 'COMMITTED' : 'DRY RUN'} evaluated=${result.evaluated} ` +
          `repaired=${result.repaired} renamed=${result.renamedValues} dropped=${result.droppedValues} ` +
          `unchanged=${result.skipped} errors=${result.errors}`,
      );
      if (result.unrecognizedValues.length) {
        // Named, not counted: if a real certification vocabulary was in use that
        // set-aside.ts does not know about, this is the line that says so instead of
        // the values disappearing into a number.
        console.warn(
          `[${SOURCE}] ⚠️ ${result.unrecognizedValues.length} unrecognized value(s) dropped: ` +
            result.unrecognizedValues.join(', ') +
            '. Confirm none of these is a real certification before treating this run as complete.',
        );
      }
      return result;
    };
    // No SyncRun row in dry-run mode: the ledger records that a rail RAN, and a
    // dry run did not.
    if (args.commit) {
      await runWithSyncRun(prisma as never, SOURCE, execute, { skipIfRunning: false });
    } else {
      await execute();
    }
  } finally {
    await prisma.$disconnect();
  }
}

const direct = /repair-set-aside-certifications(\.[cm]?[tj]s)?$/.test(
  (process.argv[1] ?? '').replace(/\\/g, '/'),
);
if (direct) {
  void main().catch((error) => {
    console.error(`[${SOURCE}] FAILED`, error);
    process.exit(1);
  });
}

export { main };
