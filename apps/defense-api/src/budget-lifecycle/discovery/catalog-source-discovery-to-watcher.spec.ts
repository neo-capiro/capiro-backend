/**
 * Phase 10B-5 — cross-layer lifecycle proof for CatalogSourceDiscoveryAdapter.
 *
 * Review 5051801761 on PR #1331 flagged that the adapter spec
 * (`catalog-source-discovery.adapter.spec.ts`) proves candidate emission but
 * stops there — it never proves the REAL downstream handoff:
 *
 *   CatalogSourceDiscoveryAdapter -> DefenseBudgetLifecycleWatcher -> InMemoryLifecycleStore
 *
 * This file closes that gap using the EXISTING Session 7 watcher harness
 * (same `AnnualDefenseBudgetCycleController` + `InMemoryLifecycleStore` the
 * rest of `lifecycle-watcher.spec.ts` already uses) with ONE port swapped:
 * discovery is `CatalogSourceDiscoveryAdapter` instead of the fixture
 * discovery port. Fetch stays a small fixture double bound to the exact
 * catalog-resolved URL, mirroring `FixtureFetchPort`'s shape.
 *
 * No parallel observation/outbox path is invented: every assertion below
 * reads the SAME `InMemoryLifecycleStore` inspection helpers
 * (`observationsFor`, `outboxEntries`, `expectedState`, `allObservations`)
 * that every other Session 7 watcher spec uses.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHash } from 'node:crypto';

import { expectedSourceDedupKey } from '@capiro/defense-domain';

import { AnnualDefenseBudgetCycleController } from '../annual-cycle-controller.service.js';
import { DefenseBudgetLifecycleWatcher } from '../lifecycle-watcher.service.js';
import { SourceAdapterRegistry } from '../source-adapter.registry.js';
import { InMemoryLifecycleStore } from '../testing/in-memory-lifecycle.store.js';
import { CatalogSourceDiscoveryAdapter } from './catalog-source-discovery.adapter.js';
import type {
  CatalogExpectedSource,
  ExpectedSourceCatalogPort,
} from './expected-source-catalog.port.js';
import type { FetchedSource, SourceFetchPort } from '../lifecycle-ports.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const NOW = '2024-06-15T12:00:00.000Z';

const PB_R1_DEDUP_KEY = expectedSourceDedupKey({
  fiscalYear: 2024,
  authorityTrack: 'request',
  sourceFamily: 'pb_r1',
  stage: 'president_budget_request',
  chamber: null,
  committee: null,
  component: 'DW',
});

/** Exactly the catalog row the review demanded: FY24 DW pb_r1, dod-comptroller. */
class SingleRowCatalog implements ExpectedSourceCatalogPort {
  async listExpectedSourcesForAdapter(input: {
    adapterId: string;
    fiscalYears: readonly number[];
  }): Promise<readonly CatalogExpectedSource[]> {
    if (input.adapterId !== 'dod-comptroller' || !input.fiscalYears.includes(2024)) return [];
    return [
      {
        expectedSourceId: 'catalog-row-pb-r1-2024',
        dedupKey: PB_R1_DEDUP_KEY,
        fiscalYear: 2024,
        authorityTrack: 'request',
        sourceFamily: 'pb_r1',
        stage: 'president_budget_request',
        chamber: null,
        committee: null,
        component: 'DW',
        adapterId: 'dod-comptroller',
      },
    ];
  }
}

/** A fetch port bound to exact bytes for exact URLs, nothing invented. */
class SingleUrlFetchPort implements SourceFetchPort {
  private readonly byUrl = new Map<string, string>();
  readonly requestedUrls: string[] = [];

  setBytes(url: string, bytes: string): void {
    this.byUrl.set(url, bytes);
  }

  async fetch(input: { url: string }): Promise<FetchedSource> {
    this.requestedUrls.push(input.url);
    const bytes = this.byUrl.get(input.url);
    if (bytes === undefined) {
      return {
        notModified: false,
        contentSha256: null,
        byteSize: null,
        httpEtag: null,
        httpLastModified: null,
        contentExcerpt: null,
        contentExcerptAvailable: false,
        blocked: true,
        blockedReason: `no fixture bytes for ${input.url}`,
      };
    }
    return {
      notModified: false,
      contentSha256: createHash('sha256').update(bytes).digest('hex'),
      byteSize: Buffer.byteLength(bytes, 'utf8'),
      httpEtag: null,
      httpLastModified: null,
      // Comptroller R-1 releases are PDF-only, same as FY2024_PB in the
      // existing fixture corpus: no text rendition to corroborate against.
      contentExcerpt: null,
      contentExcerptAvailable: false,
    };
  }
}

function harness() {
  const store = new InMemoryLifecycleStore();
  const registry = new SourceAdapterRegistry();
  const catalog = new SingleRowCatalog();
  const discovery = new CatalogSourceDiscoveryAdapter(registry, catalog, { fiscalYears: [2024] });
  const fetcher = new SingleUrlFetchPort();
  const controller = new AnnualDefenseBudgetCycleController(store);
  const watcher = new DefenseBudgetLifecycleWatcher(registry, controller, store, discovery, fetcher);
  return { store, discovery, fetcher, watcher, controller };
}

const PB_R1_URL = 'https://comptroller.defense.gov/Portals/45/Documents/defbudget/FY2024/FY2024_r1.pdf';

describe('Phase 10B-5 — CatalogSourceDiscoveryAdapter through the real watcher + InMemoryLifecycleStore', () => {
  it('first discovery: resolves FY24 pb_r1 into one changed observation and one outbox row', async () => {
    const h = harness();
    await h.controller.ensureFiscalYear({ fiscalYear: 2024 });
    h.fetcher.setBytes(PB_R1_URL, 'fy2024-r1-rdte-programs-v1');

    const result = await h.watcher.runAdapter({
      adapterId: 'dod-comptroller',
      nowIso: NOW,
      leaseOwner: 'worker-a',
      runKey: 'catalog-run-1',
      commit: true,
    });

    assert.equal(result.status, 'succeeded');
    assert.equal(result.discovered, 1);
    assert.equal(result.changed, 1);
    assert.equal(result.queued, 1);

    assert.equal(h.store.expectedState(PB_R1_DEDUP_KEY), 'published');

    const observations = h.store.observationsFor(PB_R1_DEDUP_KEY);
    assert.equal(observations.length, 1, 'exactly one observation exists');
    const [observation] = observations;
    assert.equal(observation!.observationState, 'changed');
    assert.equal(observation!.dedupKey.length > 0, true);

    const [outcome] = result.outcomes;
    assert.equal(outcome!.expectedSourceDedupKey, PB_R1_DEDUP_KEY);
    assert.equal(outcome!.classifiedFiscalYear, 2024);
    assert.equal(outcome!.classifiedAuthorityTrack, 'request');
    assert.equal(outcome!.classifiedStage, 'president_budget_request');
    assert.equal(outcome!.classifiedSourceFamily, 'pb_r1');

    const outboxEntries = h.store.outboxEntries();
    assert.equal(outboxEntries.length, 1, 'exactly one governed_source_ingestion outbox row');
    assert.equal(outboxEntries[0]!.jobKind, 'governed_source_ingestion');
    assert.equal(outboxEntries[0]!.observationId, observation!.id);
  });

  it('replay: the same expected source, same URL, same bytes produces no new work', async () => {
    const h = harness();
    await h.controller.ensureFiscalYear({ fiscalYear: 2024 });
    h.fetcher.setBytes(PB_R1_URL, 'fy2024-r1-rdte-programs-v1');

    await h.watcher.runAdapter({
      adapterId: 'dod-comptroller',
      nowIso: NOW,
      leaseOwner: 'worker-a',
      runKey: 'catalog-run-1',
      commit: true,
    });
    const observationsAfterFirst = h.store.observationsFor(PB_R1_DEDUP_KEY).length;
    const outboxAfterFirst = h.store.outboxSize();

    const replay = await h.watcher.runAdapter({
      adapterId: 'dod-comptroller',
      nowIso: '2024-06-16T12:00:00.000Z',
      leaseOwner: 'worker-a',
      runKey: 'catalog-run-2',
      commit: true,
    });

    assert.equal(replay.status, 'succeeded');
    assert.equal(replay.changed, 0);
    assert.equal(replay.queued, 0);
    assert.equal(
      h.store.observationsFor(PB_R1_DEDUP_KEY).length,
      observationsAfterFirst,
      'observation count unchanged on replay',
    );
    assert.equal(h.store.outboxSize(), outboxAfterFirst, 'outbox count unchanged on replay');
  });

  it('changed bytes: supersedes the prior observation without deleting it, queues exactly one more row', async () => {
    const h = harness();
    await h.controller.ensureFiscalYear({ fiscalYear: 2024 });
    h.fetcher.setBytes(PB_R1_URL, 'fy2024-r1-rdte-programs-v1');

    await h.watcher.runAdapter({
      adapterId: 'dod-comptroller',
      nowIso: NOW,
      leaseOwner: 'worker-a',
      runKey: 'catalog-run-1',
      commit: true,
    });
    const [firstObservation] = h.store.observationsFor(PB_R1_DEDUP_KEY);
    const firstId = firstObservation!.id;
    const firstSha = firstObservation!.contentSha256;
    const outboxAfterFirst = h.store.outboxSize();

    // Same expected source, same official URL, DIFFERENT bytes.
    h.fetcher.setBytes(PB_R1_URL, 'fy2024-r1-rdte-programs-v2-corrected');

    const second = await h.watcher.runAdapter({
      adapterId: 'dod-comptroller',
      nowIso: '2024-06-20T12:00:00.000Z',
      leaseOwner: 'worker-a',
      runKey: 'catalog-run-2',
      commit: true,
    });

    assert.equal(second.status, 'succeeded');
    assert.equal(second.changed, 1, 'one new changed observation');
    assert.equal(second.queued, 1);

    const observations = h.store.observationsFor(PB_R1_DEDUP_KEY);
    assert.equal(observations.length, 2, 'both versions exist; nothing deleted');

    const previous = observations.find((o) => o.id === firstId)!;
    assert.equal(previous.observationState, 'superseded', 'prior observation becomes superseded');
    assert.equal(previous.contentSha256, firstSha, 'prior content SHA/evidence remains unchanged');

    const next = observations.find((o) => o.id !== firstId)!;
    assert.equal(next.observationState, 'changed');
    assert.notEqual(next.contentSha256, firstSha);

    assert.equal(
      h.store.outboxSize(),
      outboxAfterFirst + 1,
      'exactly one additional governed_source_ingestion outbox row',
    );
    const outboxEntries = h.store.outboxEntries();
    assert.ok(
      outboxEntries.some((entry) => entry.observationId === next.id),
      'the new observation itself was queued',
    );
  });

  it('sanity: budget-lifecycle.module.ts does not reference CatalogSourceDiscoveryAdapter', () => {
    // The module's real SOURCE_DISCOVERY_PORT provider must still be
    // Manifest/Live discovery only. This adapter is additive; wiring it as
    // the default is explicitly out of scope for this PR.
    const modulePath = fileURLToPath(
      new URL('../budget-lifecycle.module.ts', import.meta.url),
    );
    const source = readFileSync(modulePath, 'utf8');
    assert.doesNotMatch(
      source,
      /CatalogSourceDiscoveryAdapter/,
      'budget-lifecycle.module.ts must not reference CatalogSourceDiscoveryAdapter yet',
    );
  });
});
