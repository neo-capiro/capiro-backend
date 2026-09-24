/**
 * Official-source adapter registry.
 *
 * An adapter describes WHERE to look and under what constraints. Nothing here is
 * authoritative about funding; adapters only produce candidate URLs plus
 * metadata, which the classifier then has to accept or send to review.
 *
 * Hard rule: third-party and media material may be a discovery hint but can
 * never become authoritative funding evidence. That is enforced structurally —
 * every adapter declares `authoritative`, and a non-authoritative host cannot
 * satisfy an expected source (see `assertAuthoritativeHost`).
 */

import { Injectable } from '@nestjs/common';

export type AdapterDiscoveryMode = 'api' | 'feed' | 'index_page' | 'conditional_http';

export interface OfficialSourceAdapter {
  readonly adapterId: string;
  /** Accountable business role and runtime that owns this publisher integration. */
  readonly ownerRole: string;
  readonly runtimeOwner: string;
  readonly publisher: string;
  /** Hosts whose bytes may become authoritative funding evidence. */
  readonly officialHosts: readonly string[];
  /**
   * When a publisher has migrated its live delivery host (e.g.
   * comptroller.defense.gov -> comptroller.war.gov), this names which
   * `officialHosts` entry NEW catalog-driven retrieval should prefer. It is
   * threaded straight through to `resolveExpectedSourceDocument`'s existing
   * `preferredCatalogHost` option — this field does not gate anything by
   * itself; `officialHosts` remains the single source of truth for which
   * hosts may ever become authoritative evidence, including historical ones
   * that are no longer preferred. Omit to keep the resolver's default
   * (`officialHosts[0]`).
   */
  readonly preferredRetrievalHost?: string;
  readonly discoveryMode: AdapterDiscoveryMode;
  /**
   * `false` marks a discovery-hint-only adapter. Session 7 registers none, but
   * the flag exists so adding one later cannot silently promote a media source
   * into authoritative evidence.
   */
  readonly authoritative: boolean;
  /** Minimum spacing between requests, respecting publisher rate limits. */
  readonly minRequestIntervalMs: number;
  readonly cadence: {
    readonly inSeasonMinutes: number;
    readonly shoulderMinutes: number;
    readonly offSeasonMinutes: number;
  };
  /** Source discovery is CPU/network work; this is asserted, never configured true. */
  readonly requiresGpu: false;
  readonly notes: string;
}

type AdapterDefinition = Omit<OfficialSourceAdapter, 'ownerRole' | 'runtimeOwner'>;

const OWNER_METADATA: Readonly<Record<string, { readonly ownerRole: string; readonly runtimeOwner: string }>> = Object.freeze({
  'dod-comptroller': { ownerRole: 'DoD budget source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'army-budget': { ownerRole: 'Army budget source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'navy-budget': { ownerRole: 'Navy budget source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'saf-fm-budget': { ownerRole: 'Air Force budget source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'govinfo-committee-reports': { ownerRole: 'Legislative publication source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'govinfo-bills': { ownerRole: 'Legislative publication source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'govinfo-public-laws': { ownerRole: 'Legislative publication source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'congress-gov': { ownerRole: 'Legislative status source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  hasc: { ownerRole: 'House Armed Services source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  sasc: { ownerRole: 'Senate Armed Services source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'house-appropriations': { ownerRole: 'House appropriations source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'senate-appropriations': { ownerRole: 'Senate appropriations source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'dod-comptroller-reprogramming': { ownerRole: 'DoD budget source steward', runtimeOwner: 'budget-lifecycle-watcher' },
  'dod-contract-announcements': { ownerRole: 'DoD award signal source steward', runtimeOwner: 'budget-lifecycle-watcher' },
});

const ADAPTERS: readonly AdapterDefinition[] = Object.freeze([
  {
    adapterId: 'dod-comptroller',
    publisher: 'Office of the Under Secretary of Defense (Comptroller)',
    // Phase 10B-6A: the publisher migrated its live delivery host from
    // comptroller.defense.gov to comptroller.war.gov (confirmed live
    // 2026-08-28 — the .defense.gov host now answers every path, including
    // the bare root, with an Akamai 403; .war.gov serves the identical
    // FY2024 R-1 exhibit as a real application/pdf response). BOTH hosts
    // are listed as first-party OUSD(C) publisher hosts: .defense.gov stays
    // first so it remains valid provenance for any historical
    // observation/candidate already anchored to it, and the resolver's
    // `preferredCatalogHost` mechanism (not a second adapter, not a
    // rewrite of this array's order-as-default) is what actually steers
    // NEW catalog retrieval onto .war.gov. Do not remove .defense.gov from
    // this list merely because it is currently unreachable — a publisher
    // host coming back online later must not become an unknown host to
    // historical provenance.
    officialHosts: ['comptroller.defense.gov', 'comptroller.war.gov'],
    preferredRetrievalHost: 'comptroller.war.gov',
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 2_000,
    cadence: { inSeasonMinutes: 180, shoulderMinutes: 720, offSeasonMinutes: 2_880 },
    requiresGpu: false,
    notes: "President's Budget materials, DoD-wide exhibits, spend-plan releases.",
  },
  {
    adapterId: 'army-budget',
    publisher: 'Assistant Secretary of the Army (Financial Management & Comptroller)',
    officialHosts: ['asafm.army.mil'],
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 2_000,
    cadence: { inSeasonMinutes: 240, shoulderMinutes: 1_440, offSeasonMinutes: 4_320 },
    requiresGpu: false,
    notes: 'Army R/P/O and MILCON budget exhibits.',
  },
  {
    adapterId: 'navy-budget',
    publisher: 'Office of Budget, Department of the Navy',
    officialHosts: ['secnav.navy.mil', 'www.secnav.navy.mil'],
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 2_000,
    cadence: { inSeasonMinutes: 240, shoulderMinutes: 1_440, offSeasonMinutes: 4_320 },
    requiresGpu: false,
    notes: 'Navy and Marine Corps budget exhibits.',
  },
  {
    adapterId: 'saf-fm-budget',
    publisher: 'Secretary of the Air Force (Financial Management & Comptroller)',
    officialHosts: ['saffm.hq.af.mil', 'www.saffm.hq.af.mil'],
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 2_000,
    cadence: { inSeasonMinutes: 240, shoulderMinutes: 1_440, offSeasonMinutes: 4_320 },
    requiresGpu: false,
    notes: 'Air Force and Space Force budget exhibits.',
  },
  {
    adapterId: 'govinfo-committee-reports',
    publisher: 'U.S. Government Publishing Office (GovInfo)',
    officialHosts: ['www.govinfo.gov', 'govinfo.gov', 'api.govinfo.gov'],
    discoveryMode: 'api',
    authoritative: true,
    minRequestIntervalMs: 1_000,
    cadence: { inSeasonMinutes: 120, shoulderMinutes: 480, offSeasonMinutes: 1_440 },
    requiresGpu: false,
    notes:
      'CRPT packages: HASC/SASC/HAC-D/SAC-D reports plus conference reports and joint ' +
      'explanatory statements.',
  },
  {
    adapterId: 'govinfo-bills',
    publisher: 'U.S. Government Publishing Office (GovInfo)',
    officialHosts: ['www.govinfo.gov', 'govinfo.gov', 'api.govinfo.gov'],
    discoveryMode: 'api',
    authoritative: true,
    minRequestIntervalMs: 1_000,
    cadence: { inSeasonMinutes: 120, shoulderMinutes: 480, offSeasonMinutes: 1_440 },
    requiresGpu: false,
    notes:
      'BILLS packages. Version suffixes (rh/rs reported, eh/es passed, enr enrolled) are ' +
      'how chamber action is versioned by the publisher itself.',
  },
  {
    adapterId: 'govinfo-public-laws',
    publisher: 'U.S. Government Publishing Office (GovInfo)',
    officialHosts: ['www.govinfo.gov', 'govinfo.gov', 'api.govinfo.gov'],
    discoveryMode: 'api',
    authoritative: true,
    minRequestIntervalMs: 1_000,
    cadence: { inSeasonMinutes: 180, shoulderMinutes: 720, offSeasonMinutes: 2_880 },
    requiresGpu: false,
    notes: 'PLAW packages: enacted authorization, appropriations, supplemental, reconciliation.',
  },
  {
    adapterId: 'congress-gov',
    publisher: 'Library of Congress (Congress.gov)',
    officialHosts: ['www.congress.gov', 'congress.gov', 'api.congress.gov'],
    discoveryMode: 'api',
    authoritative: true,
    minRequestIntervalMs: 1_000,
    cadence: { inSeasonMinutes: 120, shoulderMinutes: 480, offSeasonMinutes: 1_440 },
    requiresGpu: false,
    notes: 'Legislative status, committee action and public-law text.',
  },
  {
    adapterId: 'hasc',
    publisher: 'House Committee on Armed Services',
    officialHosts: ['armedservices.house.gov'],
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 3_000,
    cadence: { inSeasonMinutes: 120, shoulderMinutes: 720, offSeasonMinutes: 4_320 },
    requiresGpu: false,
    notes: 'Chairman marks and markup documents released before the GovInfo report package.',
  },
  {
    adapterId: 'sasc',
    publisher: 'Senate Committee on Armed Services',
    officialHosts: ['www.armed-services.senate.gov', 'armed-services.senate.gov'],
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 3_000,
    cadence: { inSeasonMinutes: 120, shoulderMinutes: 720, offSeasonMinutes: 4_320 },
    requiresGpu: false,
    notes: 'Chairman marks and markup summaries.',
  },
  {
    adapterId: 'house-appropriations',
    publisher: 'House Committee on Appropriations (Defense Subcommittee)',
    officialHosts: ['appropriations.house.gov', 'docs.house.gov'],
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 3_000,
    cadence: { inSeasonMinutes: 120, shoulderMinutes: 720, offSeasonMinutes: 4_320 },
    requiresGpu: false,
    notes: 'HAC-D subcommittee marks and released bill text.',
  },
  {
    adapterId: 'senate-appropriations',
    publisher: 'Senate Committee on Appropriations (Defense Subcommittee)',
    officialHosts: ['www.appropriations.senate.gov', 'appropriations.senate.gov'],
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 3_000,
    cadence: { inSeasonMinutes: 120, shoulderMinutes: 720, offSeasonMinutes: 4_320 },
    requiresGpu: false,
    notes: 'SAC-D subcommittee marks and released bill text.',
  },
  {
    adapterId: 'dod-comptroller-reprogramming',
    publisher: 'Office of the Under Secretary of Defense (Comptroller)',
    // Same publisher, same host migration as the `dod-comptroller` entry
    // above — see that entry's comment for the full rationale.
    officialHosts: ['comptroller.defense.gov', 'comptroller.war.gov'],
    discoveryMode: 'index_page',
    authoritative: true,
    minRequestIntervalMs: 2_000,
    cadence: { inSeasonMinutes: 360, shoulderMinutes: 1_440, offSeasonMinutes: 4_320 },
    requiresGpu: false,
    notes: 'DD-1415 reprogramming and transfer actions where published.',
  },
  {
    adapterId: 'dod-contract-announcements',
    publisher: 'U.S. Department of Defense',
    officialHosts: ['www.defense.gov', 'defense.gov'],
    discoveryMode: 'feed',
    authoritative: true,
    minRequestIntervalMs: 2_000,
    cadence: { inSeasonMinutes: 720, shoulderMinutes: 1_440, offSeasonMinutes: 2_880 },
    requiresGpu: false,
    notes: 'Award signals/references only. Award detail is not a funding assertion.',
  },
]);

export class UnknownSourceAdapterError extends Error {
  constructor(readonly adapterId: string) {
    super(`Unknown official source adapter: ${adapterId}`);
    this.name = 'UnknownSourceAdapterError';
  }
}

export class NonOfficialSourceHostError extends Error {
  constructor(readonly adapterId: string, readonly url: string) {
    super(
      `Adapter ${adapterId} refused a non-official source URL: ${url}. ` +
        'Third-party or media material may hint at discovery but can never become ' +
        'authoritative funding evidence.',
    );
    this.name = 'NonOfficialSourceHostError';
  }
}

@Injectable()
export class SourceAdapterRegistry {
  private readonly byId = new Map(ADAPTERS.map((adapter) => [adapter.adapterId, {
    ...adapter,
    ...(OWNER_METADATA[adapter.adapterId] ?? (() => { throw new Error(`Missing owner metadata for ${adapter.adapterId}`); })()),
  }]));

  list(): readonly OfficialSourceAdapter[] {
    return [...this.byId.values()];
  }

  get(adapterId: string): OfficialSourceAdapter {
    const adapter = this.byId.get(adapterId);
    if (!adapter) throw new UnknownSourceAdapterError(adapterId);
    return adapter;
  }

  has(adapterId: string): boolean {
    return this.byId.has(adapterId);
  }

  /**
   * Fail-closed host check. HTTPS plus a registered official host for the exact
   * adapter that claims the discovery — an official host belonging to a
   * different adapter does not count.
   */
  assertAuthoritativeHost(adapterId: string, url: string): URL {
    const adapter = this.get(adapterId);
    if (!adapter.authoritative) throw new NonOfficialSourceHostError(adapterId, url);
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new NonOfficialSourceHostError(adapterId, url);
    }
    if (parsed.protocol !== 'https:') throw new NonOfficialSourceHostError(adapterId, url);
    if (!adapter.officialHosts.includes(parsed.hostname)) {
      throw new NonOfficialSourceHostError(adapterId, url);
    }
    return parsed;
  }

  cadenceFor(adapterId: string): {
    adapterId: string;
    inSeasonMinutes: number;
    shoulderMinutes: number;
    offSeasonMinutes: number;
  } {
    const adapter = this.get(adapterId);
    return { adapterId, ...adapter.cadence };
  }
}
