import type { BillRegulationLinksResult, TrackedBillsResult } from './intelligence-bill-discovery.shared.js';

/**
 * A small per-process TTL cache for derived per-client intelligence reads
 * (tracked bills and their regulation links). Both are rebuilt from the same
 * inputs on every profile-v1 load, every hearing-alert pass and every
 * portfolio roll-up, and each rebuild costs an embedding call plus several
 * seconds of database time under load. A few minutes of reuse removes most of
 * that repeated work; `invalidate` drops a client's entries the moment one of
 * its inputs is written through Core.
 *
 * Only fulfilled values are stored. A pending build is shared with concurrent
 * callers so one slow query is not multiplied by a fan-out, and a rejected
 * build is never remembered.
 */
export class ClientReadCache<T> {
  private readonly entries = new Map<string, { expiresAt: number; value: T }>();
  private readonly inflight = new Map<string, Promise<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 500,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new RangeError('ClientReadCache ttlMs must be positive');
    if (!Number.isSafeInteger(maxEntries) || maxEntries < 1) throw new RangeError('ClientReadCache maxEntries must be >= 1');
  }

  static key(tenantId: string, clientId: string): string {
    return `${tenantId}:${clientId}`;
  }

  get(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value;
  }

  set(key: string, value: T): void {
    // Re-insert so the map keeps insertion order as a cheap LRU-by-write.
    this.entries.delete(key);
    this.entries.set(key, { expiresAt: this.now() + this.ttlMs, value });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /** The cached value, or the shared in-flight build, or a fresh build. */
  async remember(key: string, build: () => Promise<T>): Promise<T> {
    const cached = this.get(key);
    if (cached !== undefined) return cached;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const work = (async () => {
      try {
        const value = await build();
        this.set(key, value);
        return value;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, work);
    return work;
  }

  /** Drop a client's entry. A build already in flight is not reused after this. */
  invalidate(key: string): void {
    this.entries.delete(key);
    this.inflight.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Reuse window for derived per-client intelligence reads. */
export const CLIENT_INTELLIGENCE_READ_TTL_MS = 5 * 60 * 1000;

/**
 * The derived per-client reads one `IntelligenceService` instance shares
 * between its source owners (tracked-bill discovery, bill enrichment) and the
 * writers that change their inputs (manual bill tracking, mapping review, the
 * Tracker). Keyed by the facade instance so test harnesses that build several
 * services never share state, and so the facade itself stays a pure delegate.
 */
export interface ClientIntelligenceReads {
  readonly trackedBills: ClientReadCache<TrackedBillsResult>;
  readonly regulationLinks: ClientReadCache<BillRegulationLinksResult>;
  /** Drop every cached derived read for one client; the next read rebuilds it. */
  invalidate(tenantId: string, clientId: string): void;
}

const registry = new WeakMap<object, ClientIntelligenceReads>();

export function clientIntelligenceReads(host: object): ClientIntelligenceReads {
  const existing = registry.get(host);
  if (existing) return existing;
  const trackedBills = new ClientReadCache<TrackedBillsResult>(CLIENT_INTELLIGENCE_READ_TTL_MS);
  const regulationLinks = new ClientReadCache<BillRegulationLinksResult>(CLIENT_INTELLIGENCE_READ_TTL_MS);
  const created: ClientIntelligenceReads = {
    trackedBills,
    regulationLinks,
    invalidate(tenantId, clientId) {
      const key = ClientReadCache.key(tenantId, clientId);
      trackedBills.invalidate(key);
      regulationLinks.invalidate(key);
    },
  };
  registry.set(host, created);
  return created;
}
