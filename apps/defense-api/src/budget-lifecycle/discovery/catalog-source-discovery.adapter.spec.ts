/**
 * Phase 10B-5 — catalog-backed discovery adapter spec.
 *
 * Proves the adapter resolves exactly the FY24 request-track expected
 * sources it is given, using the pure resolver, and never touches an
 * observation/outbox row itself (that stays the watcher's job downstream).
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { expectedSourceDedupKey } from '@capiro/defense-domain';

import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import { CatalogSourceDiscoveryAdapter } from './catalog-source-discovery.adapter.js';
import type { CatalogExpectedSource, ExpectedSourceCatalogPort } from './expected-source-catalog.port.js';

class InMemoryCatalog implements ExpectedSourceCatalogPort {
  constructor(private readonly rows: readonly CatalogExpectedSource[]) {}

  async listExpectedSourcesForAdapter(input: {
    adapterId: string;
    fiscalYears: readonly number[];
  }): Promise<readonly CatalogExpectedSource[]> {
    return this.rows.filter(
      (row) => row.adapterId === input.adapterId && input.fiscalYears.includes(row.fiscalYear),
    );
  }
}

function dwExpected(sourceFamily: CatalogExpectedSource['sourceFamily']): CatalogExpectedSource {
  const fiscalYear = 2024;
  const authorityTrack = 'request' as const;
  const stage = 'president_budget_request' as const;
  return {
    expectedSourceId: `expected-${sourceFamily}`,
    dedupKey: expectedSourceDedupKey({
      fiscalYear,
      authorityTrack,
      sourceFamily,
      stage,
      chamber: null,
      committee: null,
      component: 'DW',
    }),
    fiscalYear,
    authorityTrack,
    sourceFamily,
    stage,
    chamber: null,
    committee: null,
    component: 'DW',
    adapterId: 'dod-comptroller',
  };
}

describe('CatalogSourceDiscoveryAdapter', () => {
  it('resolves the FY24 pb_r1 DW expected source into exactly one candidate, on the current preferred (successor) host', async () => {
    const registry = new SourceAdapterRegistry();
    const catalog = new InMemoryCatalog([dwExpected('pb_r1')]);
    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, { fiscalYears: [2024] });

    const result = await adapter.discover({
      adapterId: 'dod-comptroller',
      cursor: {},
      nowIso: '2024-06-15T00:00:00.000Z',
    });

    assert.equal(result.candidates.length, 1);
    // Phase 10B-6A: dod-comptroller's registry entry now declares
    // preferredRetrievalHost: 'comptroller.war.gov' (the publisher's live
    // successor host — comptroller.defense.gov now answers every path with
    // an Akamai 403). New catalog-driven discovery resolves onto the
    // preferred host; comptroller.defense.gov remains a valid, accepted
    // officialHosts entry for historical provenance only (see the
    // dedicated source-adapter-comptroller-host-migration.spec.ts for the
    // full accept/reject matrix on both hosts).
    assert.equal(
      result.candidates[0]?.url,
      'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
    );
    assert.equal(result.cursor.seen, 1);
    assert.equal(adapter.lastOutcomes.length, 1);
    assert.equal(adapter.lastOutcomes[0]?.resolution.outcome, 'resolved');
  });

  it('resolves procurement and O&M DW expected sources independently', async () => {
    const registry = new SourceAdapterRegistry();
    const catalog = new InMemoryCatalog([dwExpected('pb_p1'), dwExpected('pb_o1')]);
    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, { fiscalYears: [2024] });

    const result = await adapter.discover({
      adapterId: 'dod-comptroller',
      cursor: {},
      nowIso: '2024-06-15T00:00:00.000Z',
    });

    assert.equal(result.candidates.length, 2);
    const urls = result.candidates.map((c) => c.url).sort();
    assert.ok(urls[0]?.endsWith('FY2024_o1.pdf'));
    assert.ok(urls[1]?.endsWith('FY2024_p1.pdf'));
  });

  it('does not emit a candidate for a non-DW expected source with no listing', async () => {
    const registry = new SourceAdapterRegistry();
    const armyR1: CatalogExpectedSource = {
      ...dwExpected('pb_r1'),
      expectedSourceId: 'expected-army-r1',
      dedupKey: expectedSourceDedupKey({
        fiscalYear: 2024,
        authorityTrack: 'request',
        sourceFamily: 'pb_r1',
        stage: 'president_budget_request',
        chamber: null,
        committee: null,
        component: 'ARMY',
      }),
      component: 'ARMY',
      adapterId: 'army-budget',
    };
    const catalog = new InMemoryCatalog([armyR1]);
    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, { fiscalYears: [2024] });

    const result = await adapter.discover({
      adapterId: 'army-budget',
      cursor: {},
      nowIso: '2024-06-15T00:00:00.000Z',
    });

    assert.equal(result.candidates.length, 0, 'no candidate = explicit no-match, not fake success');
    assert.equal(adapter.lastOutcomes[0]?.resolution.outcome, 'no_match');
  });

  it('never emits for an authorization/committee expected source', async () => {
    const registry = new SourceAdapterRegistry();
    const committee: CatalogExpectedSource = {
      expectedSourceId: 'expected-hasc-mark',
      dedupKey: expectedSourceDedupKey({
        fiscalYear: 2024,
        authorityTrack: 'authorization',
        sourceFamily: 'auth_committee_mark',
        stage: 'hasc_mark',
        chamber: 'house',
        committee: 'HASC',
        component: null,
      }),
      fiscalYear: 2024,
      authorityTrack: 'authorization',
      sourceFamily: 'auth_committee_mark',
      stage: 'hasc_mark',
      chamber: 'house',
      committee: 'HASC',
      component: null,
      adapterId: 'hasc',
    };
    const catalog = new InMemoryCatalog([committee]);
    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, { fiscalYears: [2024] });

    const result = await adapter.discover({ adapterId: 'hasc', cursor: {}, nowIso: '2024-06-15T00:00:00.000Z' });
    assert.equal(result.candidates.length, 0);
  });

  it('one expected-source selector cannot affect another source', async () => {
    const registry = new SourceAdapterRegistry();
    const catalog = new InMemoryCatalog([dwExpected('pb_r1'), dwExpected('pb_p1')]);
    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, { fiscalYears: [2024] });

    const result = await adapter.discover({ adapterId: 'dod-comptroller', cursor: {}, nowIso: '2024-06-15T00:00:00.000Z' });
    const r1 = result.candidates.find((c) => c.url.endsWith('FY2024_r1.pdf'));
    const p1 = result.candidates.find((c) => c.url.endsWith('FY2024_p1.pdf'));
    assert.ok(r1);
    assert.ok(p1);
    assert.notEqual(r1?.expectedSourceDedupKey, p1?.expectedSourceDedupKey);
  });

  it('replay with the same catalog is idempotent (same candidates, same dedup keys)', async () => {
    const registry = new SourceAdapterRegistry();
    const catalog = new InMemoryCatalog([dwExpected('pb_r1')]);
    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, { fiscalYears: [2024] });

    const first = await adapter.discover({ adapterId: 'dod-comptroller', cursor: {}, nowIso: '2024-06-15T00:00:00.000Z' });
    const second = await adapter.discover({ adapterId: 'dod-comptroller', cursor: first.cursor, nowIso: '2024-06-16T00:00:00.000Z' });

    assert.deepEqual(
      first.candidates.map((c) => c.url),
      second.candidates.map((c) => c.url),
    );
    assert.deepEqual(
      first.candidates.map((c) => c.expectedSourceDedupKey),
      second.candidates.map((c) => c.expectedSourceDedupKey),
    );
  });

  it('Phase 10B-6: without a selector, --adapter + --catalog-fiscal-years resolves ALL 5 DW families at once (the boundedness gap)', async () => {
    const registry = new SourceAdapterRegistry();
    const families: CatalogExpectedSource['sourceFamily'][] = [
      'pb_overview',
      'pb_r1',
      'pb_p1',
      'pb_o1',
      'pb_milcon_c1',
    ];
    const catalog = new InMemoryCatalog(families.map((f) => dwExpected(f)));
    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, { fiscalYears: [2024] });

    const result = await adapter.discover({
      adapterId: 'dod-comptroller',
      cursor: {},
      nowIso: '2024-06-15T00:00:00.000Z',
    });

    assert.equal(result.candidates.length, 5, 'no selector => all 5 FY24 DW families resolve at once');
  });

  it('Phase 10B-6: expectedSourceId selector narrows the same 5-family catalog to EXACTLY the matching one, not all five', async () => {
    const registry = new SourceAdapterRegistry();
    const families: CatalogExpectedSource['sourceFamily'][] = [
      'pb_overview',
      'pb_r1',
      'pb_p1',
      'pb_o1',
      'pb_milcon_c1',
    ];
    const rows = families.map((f) => dwExpected(f));
    const targetRow = rows.find((r) => r.sourceFamily === 'pb_r1')!;
    const catalog = new InMemoryCatalog(rows);

    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, {
      fiscalYears: [2024],
      expectedSourceId: targetRow.expectedSourceId,
    });

    const result = await adapter.discover({
      adapterId: 'dod-comptroller',
      cursor: {},
      nowIso: '2024-06-15T00:00:00.000Z',
    });

    assert.equal(result.candidates.length, 1, 'selector narrows 5 catalog rows to exactly 1 candidate');
    assert.equal(
      result.candidates[0]?.url,
      'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf',
    );
    assert.equal(result.candidates[0]?.expectedSourceDedupKey, targetRow.dedupKey);
    assert.equal(adapter.lastOutcomes.length, 1, 'only the selected row was even resolved, not just filtered post-hoc');
    assert.equal(adapter.lastOutcomes[0]?.expectedSourceId, targetRow.expectedSourceId);
  });

  it('Phase 10B-6: an expectedSourceId selector matching nothing fails closed to zero candidates, never falls back to "all rows"', async () => {
    const registry = new SourceAdapterRegistry();
    const catalog = new InMemoryCatalog([dwExpected('pb_r1'), dwExpected('pb_p1')]);
    const adapter = new CatalogSourceDiscoveryAdapter(registry, catalog, {
      fiscalYears: [2024],
      expectedSourceId: 'does-not-exist-in-catalog',
    });

    const result = await adapter.discover({
      adapterId: 'dod-comptroller',
      cursor: {},
      nowIso: '2024-06-15T00:00:00.000Z',
    });

    assert.equal(result.candidates.length, 0, 'non-matching selector yields zero candidates, not a silent widen');
    assert.equal(result.cursor.seen, 0);
  });
});
