/**
 * Phase 10 — in-progress collection checkpoint (fine-grained resumability).
 *
 * Pure domain-algebra tests for `advanceCollectionCursor` / `parseDiscoveryCursor`
 * / `serialiseDiscoveryCursor`. These prove the cursor SHAPE and its safety
 * invariants independent of the crawler that drives it:
 *
 *  * a completed collection watermark advances ONLY on genuine exhaustion
 *    (unchanged Session 8 behavior — this PR must not weaken it);
 *  * an in-progress checkpoint (`resumeAfterPackageId`) is set when a run is
 *    cut short by budget, and is preserved (never regressed to null) across a
 *    run that made no further progress;
 *  * the checkpoint is cleared the moment the collection is genuinely
 *    exhausted, because there is nothing left to resume;
 *  * a persisted row shaped exactly like the CURRENT production cursor
 *    (`{watermark: null, backfillPending: true}`, no `resumeAfterPackageId`
 *    key at all) parses safely with the new field defaulting to `null` —
 *    proving backward compatibility with the existing schema version.
 */

import assert from 'node:assert/strict';
import test, { describe } from 'node:test';

import {
  advanceCollectionCursor,
  collectionCursor,
  computeListingFingerprint,
  emptyDiscoveryCursor,
  parseDiscoveryCursor,
  serialiseDiscoveryCursor,
  hasPendingBackfill,
} from '@capiro/defense-domain';

const NOW = '2026-08-23T00:00:00.000Z';

describe('advanceCollectionCursor — Phase 10 in-progress checkpoint', () => {
  test('a fresh cursor has no resume checkpoint', () => {
    const cursor = emptyDiscoveryCursor();
    assert.equal(collectionCursor(cursor, 'PLAW').resumeAfterPackageId, null);
  });

  test('a budget-bounded run sets the checkpoint and leaves backfillPending true', () => {
    const cursor = advanceCollectionCursor({
      cursor: emptyDiscoveryCursor(),
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: 'PLAW-118publ245',
      resumeListingFingerprint: 'fp-v1-abc123',
      nowIso: NOW,
    });

    const state = collectionCursor(cursor, 'PLAW');
    assert.equal(state.backfillPending, true);
    assert.equal(state.watermark, null, 'an unfinished collection must not advance its watermark');
    assert.equal(state.resumeAfterPackageId, 'PLAW-118publ245');
    assert.equal(
      state.resumeListingFingerprint,
      'fp-v1-abc123',
      'the checkpoint must be tied to the exact listing state that established its position',
    );
    assert.equal(hasPendingBackfill(cursor), true);
  });

  test('a second bounded pass advances the checkpoint and fingerprint together, never backward', () => {
    const afterPass1 = advanceCollectionCursor({
      cursor: emptyDiscoveryCursor(),
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: 'PLAW-118publ245',
      resumeListingFingerprint: 'fp-pass1',
      nowIso: NOW,
    });

    const afterPass2 = advanceCollectionCursor({
      cursor: afterPass1,
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: 'PLAW-118publ260',
      resumeListingFingerprint: 'fp-pass2',
      nowIso: NOW,
    });

    const state = collectionCursor(afterPass2, 'PLAW');
    assert.equal(state.resumeAfterPackageId, 'PLAW-118publ260');
    assert.equal(state.resumeListingFingerprint, 'fp-pass2');
  });

  test('a pass that makes no further progress preserves the prior checkpoint AND fingerprint rather than clearing them', () => {
    const afterPass1 = advanceCollectionCursor({
      cursor: emptyDiscoveryCursor(),
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: 'PLAW-118publ245',
      resumeListingFingerprint: 'fp-pass1',
      nowIso: NOW,
    });

    // A run that could not even confirm one new completed package (e.g. it
    // exhausted its budget on the sitemap index/year fetches themselves, or
    // one relevant year sitemap failed to fetch and the listing is therefore
    // incomplete) reports no new checkpoint. This must NOT regress the
    // cursor to null, and must NOT silently swap in a fingerprint computed
    // from a partial universe.
    const afterPass2 = advanceCollectionCursor({
      cursor: afterPass1,
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: null,
      resumeListingFingerprint: null,
      nowIso: NOW,
    });

    const state = collectionCursor(afterPass2, 'PLAW');
    assert.equal(
      state.resumeAfterPackageId,
      'PLAW-118publ245',
      'omitting a new checkpoint must preserve the existing one, never regress it',
    );
    assert.equal(
      state.resumeListingFingerprint,
      'fp-pass1',
      'omitting a new fingerprint must preserve the existing one — it travels WITH the package id, never independently',
    );

    // Omitting both fields entirely (undefined) must behave identically.
    const afterPass2Omitted = advanceCollectionCursor({
      cursor: afterPass1,
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      nowIso: NOW,
    });
    const stateOmitted = collectionCursor(afterPass2Omitted, 'PLAW');
    assert.equal(stateOmitted.resumeAfterPackageId, 'PLAW-118publ245');
    assert.equal(stateOmitted.resumeListingFingerprint, 'fp-pass1');
  });

  test('genuine exhaustion clears both the in-progress checkpoint and its fingerprint', () => {
    const afterPass1 = advanceCollectionCursor({
      cursor: emptyDiscoveryCursor(),
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: 'PLAW-118publ245',
      resumeListingFingerprint: 'fp-pass1',
      nowIso: NOW,
    });

    const afterExhaustion = advanceCollectionCursor({
      cursor: afterPass1,
      collection: 'PLAW',
      observedWatermark: '2024-11-01T00:00:00.000Z',
      emittedAtWatermark: ['PLAW-118publ260'],
      exhausted: true,
      // Even if a caller mistakenly still passes a checkpoint/fingerprint on
      // the exhausting run, exhaustion must win: nothing is left to resume.
      resumeAfterPackageId: 'PLAW-118publ260',
      resumeListingFingerprint: 'fp-final',
      nowIso: NOW,
    });

    const state = collectionCursor(afterExhaustion, 'PLAW');
    assert.equal(state.backfillPending, false);
    assert.equal(state.watermark, '2024-11-01T00:00:00.000Z');
    assert.equal(
      state.resumeAfterPackageId,
      null,
      'exhaustion must clear the in-progress checkpoint — there is nothing left to resume',
    );
    assert.equal(
      state.resumeListingFingerprint,
      null,
      'exhaustion must clear the fingerprint alongside the checkpoint',
    );
    assert.equal(hasPendingBackfill(afterExhaustion), false);
  });

  test('a second, independent collection tracks its own checkpoint (PLAW does not leak into CRPT)', () => {
    let cursor = advanceCollectionCursor({
      cursor: emptyDiscoveryCursor(),
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: 'PLAW-118publ245',
      nowIso: NOW,
    });
    cursor = advanceCollectionCursor({
      cursor,
      collection: 'CRPT',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: 'CRPT-118hrpt400',
      nowIso: NOW,
    });

    assert.equal(collectionCursor(cursor, 'PLAW').resumeAfterPackageId, 'PLAW-118publ245');
    assert.equal(collectionCursor(cursor, 'CRPT').resumeAfterPackageId, 'CRPT-118hrpt400');
  });
});

describe('parseDiscoveryCursor — backward compatibility with the existing production row', () => {
  test('a persisted row with no resumeAfterPackageId key at all (the exact current production shape) parses safely', () => {
    // This is production's ACTUAL persisted cursor today: schema v1, a PLAW
    // collection entry with watermark null / backfillPending true / an empty
    // emittedAtWatermark array, and critically NO resumeAfterPackageId key —
    // that field did not exist before this PR.
    const raw = {
      schema: 'phase8_session8_discovery_cursor_v1',
      collections: {
        PLAW: {
          watermark: null,
          backfillPending: true,
          emittedAtWatermark: [],
        },
      },
      lastRunAt: '2026-08-23T02:02:13.000Z',
    };

    const cursor = parseDiscoveryCursor(raw);
    const state = collectionCursor(cursor, 'PLAW');
    assert.equal(state.watermark, null);
    assert.equal(state.backfillPending, true);
    assert.equal(
      state.resumeAfterPackageId,
      null,
      'a legacy row missing the new field must default to no checkpoint, not throw or corrupt state',
    );
    assert.equal(
      state.resumeListingFingerprint,
      null,
      'a legacy row missing the fingerprint field must default to null, not throw or corrupt state',
    );
  });

  test('a persisted resumeAfterPackageId AND resumeListingFingerprint round-trip through serialise/parse unchanged', () => {
    const cursor = advanceCollectionCursor({
      cursor: emptyDiscoveryCursor(),
      collection: 'PLAW',
      observedWatermark: null,
      emittedAtWatermark: [],
      exhausted: false,
      resumeAfterPackageId: 'PLAW-118publ245',
      resumeListingFingerprint: 'fp-abc123',
      nowIso: NOW,
    });

    const serialised = serialiseDiscoveryCursor(cursor);
    const roundTripped = parseDiscoveryCursor(serialised);
    const state = collectionCursor(roundTripped, 'PLAW');
    assert.equal(state.resumeAfterPackageId, 'PLAW-118publ245');
    assert.equal(state.resumeListingFingerprint, 'fp-abc123');
  });

  test('a malformed resumeAfterPackageId (non-string) is dropped rather than trusted', () => {
    const raw = {
      schema: 'phase8_session8_discovery_cursor_v1',
      collections: {
        PLAW: {
          watermark: null,
          backfillPending: true,
          emittedAtWatermark: [],
          resumeAfterPackageId: 12345,
        },
      },
      lastRunAt: null,
    };
    const cursor = parseDiscoveryCursor(raw);
    assert.equal(collectionCursor(cursor, 'PLAW').resumeAfterPackageId, null);
  });

  test('a malformed resumeListingFingerprint (non-string) is dropped rather than trusted', () => {
    const raw = {
      schema: 'phase8_session8_discovery_cursor_v1',
      collections: {
        PLAW: {
          watermark: null,
          backfillPending: true,
          emittedAtWatermark: [],
          resumeAfterPackageId: 'PLAW-118publ245',
          resumeListingFingerprint: { not: 'a string' },
        },
      },
      lastRunAt: null,
    };
    const cursor = parseDiscoveryCursor(raw);
    assert.equal(collectionCursor(cursor, 'PLAW').resumeListingFingerprint, null);
  });
});

describe('computeListingFingerprint — the exact-universe guard behind resumeListingFingerprint', () => {
  test('the same ordered (sitemap, packageId/loc, lastmod) sequence always produces the same fingerprint', () => {
    const entries = [
      { sitemap: 'PLAW_2023_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ100', lastmod: '2023-11-01T00:00:00.000Z' },
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ101', lastmod: '2024-11-02T00:00:00.000Z' },
    ];
    assert.equal(computeListingFingerprint(entries), computeListingFingerprint(entries));
  });

  test('an insertion before the tail changes the fingerprint even though the tail entry is unchanged', () => {
    const before = [
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ101', lastmod: '2024-11-02T00:00:00.000Z' },
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ102', lastmod: '2024-11-03T00:00:00.000Z' },
    ];
    const afterInsertion = [
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ099', lastmod: '2024-10-15T00:00:00.000Z' },
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ101', lastmod: '2024-11-02T00:00:00.000Z' },
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ102', lastmod: '2024-11-03T00:00:00.000Z' },
    ];
    assert.notEqual(computeListingFingerprint(before), computeListingFingerprint(afterInsertion));
  });

  test('a lastmod change on any entry changes the fingerprint, even on an entry before the anchor', () => {
    const before = [
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ100', lastmod: '2024-11-01T00:00:00.000Z' },
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ102', lastmod: '2024-11-03T00:00:00.000Z' },
    ];
    const afterEdit = [
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ100', lastmod: '2024-11-05T00:00:00.000Z' },
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ102', lastmod: '2024-11-03T00:00:00.000Z' },
    ];
    assert.notEqual(computeListingFingerprint(before), computeListingFingerprint(afterEdit));
  });

  test('reordering the same entries changes the fingerprint — order is part of the identity', () => {
    const a = [
      { sitemap: 'PLAW_2023_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ100', lastmod: '2023-11-01T00:00:00.000Z' },
      { sitemap: 'PLAW_2024_sitemap.xml', loc: 'https://www.govinfo.gov/app/details/PLAW-118publ101', lastmod: '2024-11-02T00:00:00.000Z' },
    ];
    const b = [a[1]!, a[0]!];
    assert.notEqual(computeListingFingerprint(a), computeListingFingerprint(b));
  });

  test('a genuinely empty listing has a well-defined, stable fingerprint', () => {
    assert.equal(computeListingFingerprint([]), computeListingFingerprint([]));
  });
});
