/**
 * Phase 8 Session 8 — crawl cursor algebra.
 * Phase 10 — in-progress collection checkpoint (`resumeAfterPackageId`).
 *
 * The Session 7 store already round-trips an opaque
 * `cursor: Record<string, unknown>` per adapter through `loadAdapterState` and
 * `releaseAdapterLease`. Session 8 gives that opaque bag a governed shape,
 * because a live crawl is only affordable if it is incremental, and only correct
 * if the increment cannot skip anything.
 *
 * Design constraints, each from a real observation:
 *
 *  * **Per-collection watermarks, not one global one.** The GovInfo sitemap index
 *    is per collection and its year files advance independently. A single global
 *    watermark would let a BILLS update suppress a CRPT one.
 *
 *  * **Watermarks only ever move forward.** A publisher that briefly serves a
 *    stale sitemap must not rewind the cursor and cause a full re-crawl.
 *
 *  * **A truncated run must be resumable and must say so.** The first crawl of
 *    `BILLS_2023` faces 13,354 packages against a bounded request budget. The
 *    cursor therefore records that a collection is mid-backfill, and the
 *    watermark is NOT advanced past work that was never examined — advancing it
 *    would silently skip the remainder forever.
 *
 * Phase 10 adds a second, narrower concept on top of the watermark, because the
 * watermark alone left a real backlog unable to make ANY forward progress: the
 * FY2024 PLAW collection needs more than one run's 250-request budget to walk,
 * so every bounded pass restarted the sitemap from the beginning and hit the
 * identical wall (`request budget exhausted while resolving PLAW-118publ246`)
 * every time — four passes, zero net progress.
 *
 *  * **`resumeAfterPackageId` is an in-progress checkpoint, not a watermark.**
 *    It names the last package whose discovery handling completed successfully
 *    *within the current, still-unexhausted collection walk* — never a raw
 *    request count, and never a position inside MODS resolution, metadata
 *    classification, or a partial fetch. A caller may only supply a NEW
 *    checkpoint for a package it fully finished handling this run.
 *
 *  * **The durable watermark still advances only on genuine exhaustion.** This
 *    is the existing Session 8 safety property, unchanged: `exhausted: true` is
 *    still the only way `watermark` moves. `resumeAfterPackageId` never
 *    substitutes for it.
 *
 *  * **A checkpoint only ever moves forward or holds — it is never regressed to
 *    null by a run that made no further progress.** Omitting
 *    `resumeAfterPackageId` (or passing `null`) on an unexhausted pass means
 *    "this pass didn't get far enough to name a new boundary," not "forget the
 *    old one." The prior checkpoint (if any) is preserved.
 *
 *  * **Exhaustion clears the checkpoint.** Once a collection is genuinely
 *    exhausted there is nothing left to resume, so the in-progress checkpoint is
 *    cleared at the same instant the durable watermark advances — even if a
 *    caller mistakenly still passes one on the exhausting call.
 */

export const DISCOVERY_CURSOR_SCHEMA = 'phase8_session8_discovery_cursor_v1';

export interface CollectionCursor {
  /** Highest `lastmod` fully processed for this collection. */
  readonly watermark: string | null;
  /** `true` when a bounded run stopped before exhausting this collection. */
  readonly backfillPending: boolean;
  /**
   * Package ids already emitted at the current watermark. Because the watermark
   * comparison is inclusive, this is what stops a boundary entry from being
   * re-emitted on every run without risking a skip.
   */
  readonly emittedAtWatermark: readonly string[];
  /**
   * Phase 10 in-progress checkpoint: the last package boundary whose discovery
   * handling completed successfully during an UNFINISHED collection walk.
   * `null` when the collection has never been bounded mid-walk, or once it is
   * genuinely exhausted (there is nothing left to resume). This is deliberately
   * NOT the durable collection watermark — see the file header.
   */
  readonly resumeAfterPackageId: string | null;
}

export interface DiscoveryCursor {
  readonly schema: typeof DISCOVERY_CURSOR_SCHEMA;
  readonly collections: Readonly<Record<string, CollectionCursor>>;
  readonly lastRunAt: string | null;
}

const EMPTY_COLLECTION: CollectionCursor = Object.freeze({
  watermark: null,
  backfillPending: false,
  emittedAtWatermark: Object.freeze([]),
  resumeAfterPackageId: null,
});

export function emptyDiscoveryCursor(): DiscoveryCursor {
  return Object.freeze({
    schema: DISCOVERY_CURSOR_SCHEMA,
    collections: Object.freeze({}),
    lastRunAt: null,
  });
}

/**
 * Read an opaque stored cursor.
 *
 * An unrecognised or malformed cursor is treated as empty rather than as an
 * error: a fresh full crawl is always safe, whereas throwing would wedge the
 * adapter permanently on one bad row.
 */
export function parseDiscoveryCursor(raw: Record<string, unknown> | null | undefined): DiscoveryCursor {
  if (!raw || raw.schema !== DISCOVERY_CURSOR_SCHEMA) return emptyDiscoveryCursor();

  const rawCollections = raw.collections;
  if (!rawCollections || typeof rawCollections !== 'object') return emptyDiscoveryCursor();

  const collections: Record<string, CollectionCursor> = {};
  for (const [key, value] of Object.entries(rawCollections as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as Record<string, unknown>;
    const watermark = typeof entry.watermark === 'string' ? entry.watermark : null;
    const emitted = Array.isArray(entry.emittedAtWatermark)
      ? entry.emittedAtWatermark.filter((item): item is string => typeof item === 'string')
      : [];
    collections[key] = Object.freeze({
      watermark: watermark !== null && !Number.isNaN(Date.parse(watermark)) ? watermark : null,
      backfillPending: entry.backfillPending === true,
      emittedAtWatermark: Object.freeze([...emitted].sort()),
      // Absent (legacy row) or malformed -> null, never trusted as given.
      resumeAfterPackageId:
        typeof entry.resumeAfterPackageId === 'string' ? entry.resumeAfterPackageId : null,
    });
  }

  return Object.freeze({
    schema: DISCOVERY_CURSOR_SCHEMA,
    collections: Object.freeze(collections),
    lastRunAt: typeof raw.lastRunAt === 'string' ? raw.lastRunAt : null,
  });
}

export function collectionCursor(cursor: DiscoveryCursor, collection: string): CollectionCursor {
  return cursor.collections[collection] ?? EMPTY_COLLECTION;
}

/**
 * Advance one collection's cursor.
 *
 * `exhausted: false` means the run was cut short by its request budget. The
 * durable watermark is then left where it was and `backfillPending` is set,
 * because moving it would permanently skip everything the run never looked at.
 *
 * `resumeAfterPackageId` is the Phase 10 in-progress checkpoint: the last
 * package boundary this run fully finished handling, so the NEXT bounded run
 * can start there instead of restarting the collection from the beginning.
 * Passing `undefined`/`null` on an unexhausted run means "no NEW checkpoint to
 * report" and preserves whatever checkpoint already existed — it never erases
 * one. Exhaustion (`exhausted: true`) always clears the checkpoint, because a
 * fully-walked collection has nothing left to resume.
 */
export function advanceCollectionCursor(input: {
  cursor: DiscoveryCursor;
  collection: string;
  /** Highest `lastmod` actually examined in this run. */
  observedWatermark: string | null;
  /** Package ids emitted whose `lastmod` equals `observedWatermark`. */
  emittedAtWatermark: readonly string[];
  exhausted: boolean;
  /**
   * The last package this run completed handling, when the run was bounded
   * (`exhausted: false`) and made at least some new progress. Omit or pass
   * `null` when this run advanced no further than the prior checkpoint — the
   * prior value is preserved, never cleared, in that case.
   */
  resumeAfterPackageId?: string | null;
  nowIso: string;
}): DiscoveryCursor {
  const previous = collectionCursor(input.cursor, input.collection);

  let watermark = previous.watermark;
  let emittedAtWatermark = previous.emittedAtWatermark;

  if (input.exhausted && input.observedWatermark !== null) {
    const next = Date.parse(input.observedWatermark);
    const current = previous.watermark === null ? Number.NEGATIVE_INFINITY : Date.parse(previous.watermark);
    if (!Number.isNaN(next) && next > current) {
      // Watermark moved: the boundary set starts fresh at the new instant.
      watermark = new Date(next).toISOString();
      emittedAtWatermark = Object.freeze([...input.emittedAtWatermark].sort());
    } else if (!Number.isNaN(next) && next === current) {
      // Same boundary instant: accumulate so an inclusive comparison does not
      // re-emit what we already emitted there.
      emittedAtWatermark = Object.freeze(
        [...new Set([...previous.emittedAtWatermark, ...input.emittedAtWatermark])].sort(),
      );
    }
  }

  // Exhaustion always clears the in-progress checkpoint: nothing is left to
  // resume. Otherwise, a newly-reported checkpoint advances the pointer; an
  // omitted/null one preserves whatever was already there — never regresses.
  const resumeAfterPackageId = input.exhausted
    ? null
    : (input.resumeAfterPackageId ?? previous.resumeAfterPackageId);

  const collections: Record<string, CollectionCursor> = { ...input.cursor.collections };
  collections[input.collection] = Object.freeze({
    watermark,
    backfillPending: !input.exhausted,
    emittedAtWatermark,
    resumeAfterPackageId,
  });

  return Object.freeze({
    schema: DISCOVERY_CURSOR_SCHEMA,
    collections: Object.freeze(collections),
    lastRunAt: input.nowIso,
  });
}

/**
 * `true` when this exact package was already emitted at the current watermark
 * instant, so an inclusive `lastmod` comparison must not emit it again.
 */
export function alreadyEmittedAtWatermark(input: {
  cursor: DiscoveryCursor;
  collection: string;
  packageId: string;
  entryLastmod: string | null;
}): boolean {
  const state = collectionCursor(input.cursor, input.collection);
  if (state.watermark === null || input.entryLastmod === null) return false;
  if (Date.parse(input.entryLastmod) !== Date.parse(state.watermark)) return false;
  return state.emittedAtWatermark.includes(input.packageId);
}

/** Serialise for the opaque store column. */
export function serialiseDiscoveryCursor(cursor: DiscoveryCursor): Record<string, unknown> {
  return {
    schema: cursor.schema,
    collections: Object.fromEntries(
      Object.entries(cursor.collections).map(([key, value]) => [
        key,
        {
          watermark: value.watermark,
          backfillPending: value.backfillPending,
          emittedAtWatermark: [...value.emittedAtWatermark],
          resumeAfterPackageId: value.resumeAfterPackageId,
        },
      ]),
    ),
    lastRunAt: cursor.lastRunAt,
  };
}

/** `true` when any collection still has un-examined backlog. */
export function hasPendingBackfill(cursor: DiscoveryCursor): boolean {
  return Object.values(cursor.collections).some((entry) => entry.backfillPending);
}
