/**
 * Phase 8 Session 8 — crawl cursor algebra.
 * Phase 10 — in-progress collection checkpoint (`resumeAfterPackageId`),
 * hardened with a listing-fingerprint guard (`resumeListingFingerprint`).
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
 *
 * A package id alone is NOT a safe resume anchor, and a second review round
 * found the hole: GovInfo's collection walk spans several year sitemaps at
 * once (a fiscal year's window is FY-2 through FY+1), a year sitemap fetch can
 * fail while others in the same pass succeed, and the surviving listing can
 * still contain the checkpoint package while something changed BEFORE it
 * (an insertion, or an existing entry's `lastmod` moving). In every one of
 * those cases "does the checkpoint package id still exist in the current
 * listing" is not enough to prove nothing before it was missed.
 *
 *  * **`resumeListingFingerprint` binds the checkpoint to the EXACT universe
 *    that established it, not just to a package id.** It is a deterministic
 *    digest (`computeListingFingerprint`) of every relevant entry examined this
 *    pass, in a stable order — see that function for exactly what it covers.
 *    A checkpoint may only be trusted to resume strictly-after when the CURRENT
 *    pass's fingerprint, computed the same way over a COMPLETE relevant
 *    listing, matches the persisted one. Any mismatch — a missing anchor, an
 *    insertion, a reorder, or a changed `lastmod` anywhere in the fingerprinted
 *    range — means the universe moved and the safe action is a full replay of
 *    the collection, never a guess at a new position.
 *
 *  * **A partial listing must never mint a new global position.** If even one
 *    relevant year sitemap could not be fetched this pass, the pass saw an
 *    INCOMPLETE universe. It must not establish a new
 *    `resumeAfterPackageId`/`resumeListingFingerprint` pair against that
 *    partial view — doing so could let a package that lives only in the failed
 *    sitemap end up permanently before the checkpoint once that sitemap
 *    recovers. On a partial-listing pass, the prior checkpoint and fingerprint
 *    (if any) are preserved untouched, exactly like a pass that made no further
 *    progress.
 *
 *  * **The fingerprint travels WITH the package id, never independently.** They
 *    are set together, preserved together, and cleared together. There is no
 *    valid state with one present and the other absent (besides both null).
 */

import { sha256Hex } from '../cycle.js';

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
   * NOT the durable collection watermark — see the file header. Always set or
   * cleared together with `resumeListingFingerprint`.
   */
  readonly resumeAfterPackageId: string | null;
  /**
   * Phase 10 listing-fingerprint guard: a digest of the exact, complete
   * relevant listing (every fetched year sitemap's entries, in order) that was
   * in view when `resumeAfterPackageId` was established. A resume is only
   * trusted to skip past the checkpoint when a fresh fingerprint over the
   * current pass's complete listing matches this value exactly. `null`
   * whenever `resumeAfterPackageId` is `null`. See the file header for what a
   * mismatch means and why the fail-safe response is always a full replay.
   */
  readonly resumeListingFingerprint: string | null;
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
  resumeListingFingerprint: null,
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
    // Absent (legacy row) or malformed -> null, never trusted as given. The
    // fingerprint is only ever meaningful alongside a real package id, so a
    // malformed/absent package id also forces the fingerprint to null.
    const resumeAfterPackageId =
      typeof entry.resumeAfterPackageId === 'string' ? entry.resumeAfterPackageId : null;
    const resumeListingFingerprint =
      resumeAfterPackageId !== null && typeof entry.resumeListingFingerprint === 'string'
        ? entry.resumeListingFingerprint
        : null;
    collections[key] = Object.freeze({
      watermark: watermark !== null && !Number.isNaN(Date.parse(watermark)) ? watermark : null,
      backfillPending: entry.backfillPending === true,
      emittedAtWatermark: Object.freeze([...emitted].sort()),
      resumeAfterPackageId,
      resumeListingFingerprint,
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
 * `resumeListingFingerprint` MUST accompany it — the digest of the complete
 * relevant listing this run actually saw. Passing `undefined`/`null` for
 * EITHER on an unexhausted run means "no NEW checkpoint to report" and
 * preserves whatever checkpoint+fingerprint pair already existed — it never
 * erases one, and it never sets one field without the other. Exhaustion
 * (`exhausted: true`) always clears both, because a fully-walked collection
 * has nothing left to resume.
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
   * (`exhausted: false`), made at least some new progress, AND saw a complete
   * (not partially-failed) relevant listing this pass. Omit or pass `null`
   * when this run advanced no further than the prior checkpoint, or when the
   * listing it examined was incomplete — the prior value is preserved, never
   * cleared, in either case.
   */
  resumeAfterPackageId?: string | null;
  /**
   * The fingerprint of the complete relevant listing this run examined,
   * required whenever `resumeAfterPackageId` is a new non-null value. Must be
   * omitted/null exactly when `resumeAfterPackageId` is omitted/null.
   */
  resumeListingFingerprint?: string | null;
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

  // Exhaustion always clears the in-progress checkpoint pair: nothing is left
  // to resume. Otherwise, a newly-reported checkpoint (with its fingerprint)
  // advances the pointer; an omitted/null one preserves whatever pair was
  // already there — never regresses, and never sets one half without the
  // other.
  const resumeAfterPackageId = input.exhausted
    ? null
    : (input.resumeAfterPackageId ?? previous.resumeAfterPackageId);
  const resumeListingFingerprint = input.exhausted
    ? null
    : (input.resumeListingFingerprint ?? previous.resumeListingFingerprint);

  const collections: Record<string, CollectionCursor> = { ...input.cursor.collections };
  collections[input.collection] = Object.freeze({
    watermark,
    backfillPending: !input.exhausted,
    emittedAtWatermark,
    resumeAfterPackageId,
    resumeListingFingerprint,
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
          resumeListingFingerprint: value.resumeListingFingerprint,
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

/**
 * A single relevant entry contributing to a `resumeListingFingerprint`.
 *
 * `sitemap` is the year-sitemap URL/name the entry came from — the same
 * `(loc, lastmod)` pair from two different year files is not the same fact,
 * so the source file is part of the entry's identity, not an afterthought.
 */
export interface ListingFingerprintEntry {
  readonly sitemap: string;
  readonly loc: string;
  readonly lastmod: string | null;
}

/**
 * Deterministic digest of the exact, complete relevant listing a crawl pass
 * examined, in the exact order it examined it.
 *
 * This exists because a package id alone is not a safe resume anchor. GovInfo
 * serves a fiscal year's window across several year sitemaps at once, and any
 * of these can happen between two passes over what still "looks like" the
 * same collection:
 *
 *  * a year sitemap that failed on the checkpointing pass recovers on the next
 *    one, revealing entries that were always logically "before" packages the
 *    checkpoint already skipped past;
 *  * GovInfo inserts, removes, or updates a package that sorts before the
 *    checkpoint package but was not there (or had a different `lastmod`) when
 *    the checkpoint was set;
 *  * the same set of packages arrives in a different order.
 *
 * In every one of those cases the checkpoint package id can still exist in
 * the new listing while something before it changed — so "the anchor still
 * exists" is necessary but not sufficient. This fingerprint captures the
 * ordered `(sitemap, loc, lastmod)` triple for every entry, so any of the
 * above changes the digest and forces a safe replay instead of a silent skip.
 *
 * Order is caller-determined and part of the identity: the crawler must pass
 * entries in the SAME deterministic order it uses to walk them (year files in
 * sorted order, each file's entries in their parsed order), so a genuinely
 * unchanged listing always reproduces the same fingerprint.
 */
export function computeListingFingerprint(entries: readonly ListingFingerprintEntry[]): string {
  const material = entries
    .map((entry) => `${entry.sitemap}\u0000${entry.loc}\u0000${entry.lastmod ?? ''}`)
    .join('\u0001');
  return sha256Hex(`v1\u0002${material}`);
}
