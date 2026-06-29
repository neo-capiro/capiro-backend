/**
 * Freshness disclosure for markup-status fields (P0-8).
 *
 * The single genuine data-staleness failure in the Perseus memo forensics was
 * SASC markup status: Capiro's `sascMark` was null, so Meri honestly said
 * "cannot confirm" while ChatGPT (from fresher knowledge) knew SASC had voted.
 * A null markup field is ambiguous — it can mean "not yet marked" OR "not yet
 * synced into Capiro." Rather than silently omit, surface an explicit freshness
 * note so the deliverable discloses the gap instead of reading as a confident
 * omission.
 *
 * Pure + dependency-free for `src/**.spec.ts`.
 */

export interface MarkupField {
  /** Label shown to the user, e.g. 'SASC mark' or 'HASC mark'. */
  label: string;
  /** The mark value; null/undefined means "not present in Capiro". */
  value: number | null | undefined;
}

export interface FreshnessNote {
  field: string;
  message: string;
}

/** ISO-ish staleness threshold: a sync older than this is "stale" (days). */
export const STALE_AFTER_DAYS = 14;

/**
 * Build freshness notes for any markup fields that are null/missing. Returns a
 * note per missing field disclosing that Capiro has no value as of the last
 * sync, so the reader does not mistake an omission for "no action taken".
 */
export function buildMarkupFreshnessNotes(
  peCode: string,
  fields: MarkupField[],
  lastSyncedAt: Date | string | null,
  now: Date = new Date(),
): FreshnessNote[] {
  const out: FreshnessNote[] = [];
  const synced = toDate(lastSyncedAt);
  const asOf = synced ? formatDate(synced) : 'an unknown date';
  const stale = synced ? daysBetween(synced, now) > STALE_AFTER_DAYS : true;

  for (const f of fields) {
    if (f.value == null) {
      out.push({
        field: f.label,
        message:
          `${f.label} for PE ${peCode} is not recorded in Capiro as of ${asOf}. ` +
          `This may mean the committee has not yet acted OR that the mark has not been ` +
          `synced. Verify the current markup status before relying on it for live strategy.` +
          (stale ? ' (Capiro markup data may be stale — confirm against the latest committee action.)' : ''),
      });
    }
  }
  return out;
}

function toDate(v: Date | string | null): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function daysBetween(a: Date, b: Date): number {
  return Math.abs(b.getTime() - a.getTime()) / 86_400_000;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
