/**
 * Manifest-driven discovery adapter.
 *
 * Reads candidates from a governed, version-pinned manifest of official sources.
 * This is the discovery implementation Session 7 ships, and it is what the
 * historical lifecycle replay runs against.
 *
 * Deliberate scope boundary, stated plainly: live crawling of each publisher's
 * index page / API is infrastructure work for the dark-deployment session, not
 * control-plane logic. What Session 7 proves is the part that can go wrong
 * silently — fingerprinting, revision detection, classification, supersession,
 * idempotency and queueing. Swapping this adapter for a live crawler changes
 * where candidates come from and nothing about those decisions.
 *
 * The adapter still enforces the same rule a live crawler must: it emits only
 * URLs on the requesting adapter's own official hosts.
 */

import { Injectable } from '@nestjs/common';

import { SourceAdapterRegistry } from './source-adapter.registry.js';
import type { DiscoveredCandidate, SourceDiscoveryPort } from './lifecycle-ports.js';

export interface DiscoveryManifestEntry {
  readonly adapterId: string;
  readonly expectedSourceDedupKey: string;
  readonly url: string;
  readonly packageId?: string | null;
  readonly title?: string | null;
  readonly declaredFiscalYear?: number | null;
  readonly divisionEvidence?: string | null;
  readonly versionRank?: number | null;
  readonly withdrawn?: boolean;
  /** ISO instant at which the publisher made this source available. */
  readonly availableFrom?: string | null;
}

export interface DiscoveryManifest {
  readonly schemaVersion: 'phase8_session7_discovery_manifest_v1';
  readonly entries: readonly DiscoveryManifestEntry[];
}

@Injectable()
export class ManifestSourceDiscoveryAdapter implements SourceDiscoveryPort {
  constructor(
    private readonly registry: SourceAdapterRegistry,
    private manifest: DiscoveryManifest = {
      schemaVersion: 'phase8_session7_discovery_manifest_v1',
      entries: [],
    },
  ) {}

  load(manifest: DiscoveryManifest): void {
    if (manifest.schemaVersion !== 'phase8_session7_discovery_manifest_v1') {
      throw new Error(`Unsupported discovery manifest schema: ${manifest.schemaVersion}`);
    }
    this.manifest = manifest;
  }

  async discover(input: {
    adapterId: string;
    cursor: Record<string, unknown>;
    nowIso: string;
  }): Promise<{ candidates: readonly DiscoveredCandidate[]; cursor: Record<string, unknown> }> {
    const now = new Date(input.nowIso).getTime();
    if (Number.isNaN(now)) throw new RangeError(`Invalid instant: ${input.nowIso}`);

    const candidates: DiscoveredCandidate[] = [];
    for (const entry of this.manifest.entries) {
      if (entry.adapterId !== input.adapterId) continue;
      // A source cannot be discovered before the publisher released it. This is
      // what lets a replay walk a real lifecycle forward in time.
      if (entry.availableFrom && new Date(entry.availableFrom).getTime() > now) continue;

      // Same rule a live crawler must obey: official host for THIS adapter.
      this.registry.assertAuthoritativeHost(entry.adapterId, entry.url);

      candidates.push({
        adapterId: entry.adapterId,
        expectedSourceDedupKey: entry.expectedSourceDedupKey,
        url: entry.url,
        packageId: entry.packageId ?? null,
        title: entry.title ?? null,
        declaredFiscalYear: entry.declaredFiscalYear ?? null,
        divisionEvidence: entry.divisionEvidence ?? null,
        versionRank: entry.versionRank ?? null,
        ...(entry.withdrawn === undefined ? {} : { withdrawn: entry.withdrawn }),
      });
    }

    return {
      candidates: Object.freeze(candidates),
      cursor: { ...input.cursor, lastDiscoveryAt: input.nowIso, seen: candidates.length },
    };
  }
}
