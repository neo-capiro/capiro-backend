/**
 * Promote SAM.gov source fields out of `sam_opportunity.raw_jsonb` into their own
 * columns: `base_type`, `sub_agency`, `set_aside`, `set_aside_code`.
 *
 *   tsx scripts/backfill-sam-opportunity-fields.ts             # dry run
 *   tsx scripts/backfill-sam-opportunity-fields.ts --commit
 *   tsx scripts/backfill-sam-opportunity-fields.ts --commit --batch 2000
 *
 * DRY-RUN BY DEFAULT.
 *
 * ── Why this is not a second ingestion pipeline ─────────────────────────────
 *
 * Every field written here is already present, verbatim, in the `raw_jsonb` the
 * existing sync stores for each notice. The sync simply never selected these four
 * into columns. So this reads what we already hold rather than re-fetching from
 * SAM.gov: no API key, no network, no rate limit, no risk of a second writer
 * disagreeing with the first. `sync-sam-opportunities.ts` writes the same four
 * fields going forward (one shared extractor, `extractPromotedFields`, so the
 * backfill and the live sync cannot drift).
 *
 * ── Why base_type is the one that matters for correctness ───────────────────
 *
 * An amended notice carries `type: 'Solicitation'` with
 * `baseType: 'Presolicitation'`. Without `base_type` the UI cannot tell an
 * original solicitation from an amended presolicitation, and a sources-sought
 * notice reading as an open solicitation is a client told to bid on something
 * that has no RFP yet.
 *
 * Idempotent: re-running writes the same values. Only rows whose promoted values
 * would actually CHANGE are updated, so a second pass reports 0 updated rather
 * than touching every row again.
 *
 * `sam_opportunity` is a GLOBAL table (no tenant_id, no RLS), so there is no
 * bypass or tenant scoping here — same access pattern as the sync itself.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

const DEFAULT_BATCH = 1000;

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
  batch: number;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const b = flagValue(argv, 'batch');
  const parsed = b != null ? Number(b) : NaN;
  return {
    commit: hasFlag(argv, 'commit'),
    batch: Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 5000) : DEFAULT_BATCH,
  };
}

export interface PromotedFields {
  baseType: string | null;
  subAgency: string | null;
  setAside: string | null;
  setAsideCode: string | null;
}

function str(v: unknown, max?: number): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  if (!s.length) return null;
  return max != null ? s.slice(0, max) : s;
}

/**
 * The ONE extractor, shared by this backfill and the live sync.
 *
 * Field names are SAM.gov opportunities/v2's own: `baseType`, `subTier`,
 * `typeOfSetAsideDescription`, `typeOfSetAside`. Lengths are clipped to the
 * column widths declared in the migration (base_type VARCHAR(64),
 * set_aside_code VARCHAR(16)) — a vendor string longer than the column is a
 * write failure, and one long value must not fail a whole batch.
 */
export function extractPromotedFields(raw: unknown): PromotedFields {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { baseType: null, subAgency: null, setAside: null, setAsideCode: null };
  }
  const r = raw as Record<string, unknown>;
  return {
    baseType: str(r.baseType, 64),
    subAgency: str(r.subTier),
    setAside: str(r.typeOfSetAsideDescription),
    setAsideCode: str(r.typeOfSetAside, 16),
  };
}

/** True when the promoted values differ from what the row already holds. */
export function needsUpdate(
  current: PromotedFields,
  next: PromotedFields,
): boolean {
  return (
    current.baseType !== next.baseType ||
    current.subAgency !== next.subAgency ||
    current.setAside !== next.setAside ||
    current.setAsideCode !== next.setAsideCode
  );
}

export interface BackfillPrisma {
  samOpportunity: {
    findMany(args: unknown): Promise<
      Array<{
        id: string;
        baseType: string | null;
        subAgency: string | null;
        setAside: string | null;
        setAsideCode: string | null;
        raw: unknown;
      }>
    >;
    update(args: unknown): Promise<unknown>;
  };
}

export interface BackfillResult {
  scanned: number;
  updated: number;
  unchanged: number;
  /** Rows whose raw payload carried none of the four fields. */
  noSourceFields: number;
  errors: number;
}

/**
 * Keyset-paginate the whole table by id so memory stays bounded whatever the row
 * count. `skip: 1` + `cursor` rather than `skip: n` — an offset scan re-reads
 * every earlier row on each page.
 */
export async function backfill(
  prisma: BackfillPrisma,
  opts: { commit: boolean; batch: number },
): Promise<BackfillResult> {
  const out: BackfillResult = { scanned: 0, updated: 0, unchanged: 0, noSourceFields: 0, errors: 0 };
  let cursor: string | undefined;

  for (;;) {
    const rows = await prisma.samOpportunity.findMany({
      select: {
        id: true,
        baseType: true,
        subAgency: true,
        setAside: true,
        setAsideCode: true,
        raw: true,
      },
      orderBy: { id: 'asc' },
      take: opts.batch,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
    if (rows.length === 0) break;

    for (const row of rows) {
      out.scanned += 1;
      try {
        const next = extractPromotedFields(row.raw);
        if (next.baseType == null && next.subAgency == null && next.setAside == null && next.setAsideCode == null) {
          out.noSourceFields += 1;
          continue;
        }
        const current: PromotedFields = {
          baseType: row.baseType,
          subAgency: row.subAgency,
          setAside: row.setAside,
          setAsideCode: row.setAsideCode,
        };
        if (!needsUpdate(current, next)) {
          out.unchanged += 1;
          continue;
        }
        out.updated += 1;
        if (opts.commit) {
          await prisma.samOpportunity.update({ where: { id: row.id }, data: next });
        }
      } catch (err) {
        out.errors += 1;
        console.warn(`[sam-backfill] row ${row.id} failed: ${(err as Error).message}`);
      }
    }

    cursor = rows[rows.length - 1]!.id;
    if (rows.length < opts.batch) break;
  }

  return out;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const prisma = new PrismaClient();
  const t0 = Date.now();
  console.log(
    `[sam-backfill] promoting base_type / sub_agency / set_aside / set_aside_code from raw_jsonb ` +
      `(${args.commit ? 'COMMIT' : 'DRY-RUN'}) batch=${args.batch}`,
  );
  try {
    const r = await backfill(prisma as unknown as BackfillPrisma, args);
    console.log(
      `[sam-backfill] scanned=${r.scanned} updated=${r.updated} unchanged=${r.unchanged} ` +
        `noSourceFields=${r.noSourceFields} errors=${r.errors} in ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
        `(${args.commit ? 'COMMITTED' : 'DRY-RUN, nothing written'})`,
    );
    if (r.noSourceFields > 0) {
      // Honest reporting, not a warning to be ignored: a row whose raw payload
      // never carried these fields cannot be back-filled from what we hold, and
      // its set_aside stays null. A null set_aside therefore means EITHER "full
      // and open" OR "we never captured it" — which is exactly why
      // computeSamEligibility refuses to read a null set-aside as "no
      // restriction" and returns `unknown` instead.
      console.log(
        `[sam-backfill] ${r.noSourceFields} row(s) carried none of the four fields in raw_jsonb. ` +
          `Their set_aside stays NULL, which the eligibility engine treats as "not stated", never as "unrestricted".`,
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ?? '';
    return /backfill-sam-opportunity-fields(\.[cm]?[tj]s)?$/.test(invoked.replace(/\\/g, '/'));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  void main().catch((err) => {
    console.error('[sam-backfill] FAILED', err);
    process.exit(1);
  });
}

export { main };
