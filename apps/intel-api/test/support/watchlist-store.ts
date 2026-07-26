/**
 * A stateful in-memory PrismaService double for the unified tracker watchlist
 * (`intel_watchlist` + `_topic` + `_term` + `_revision`).
 *
 * Why this exists: Gate B's watchlist work is almost entirely about what survives
 * BETWEEN saves — stable topic ids across an autosave, a rename that keeps its
 * terms, an optimistic-concurrency version, a flat-term round-trip. Static
 * per-call mocks (the older doubles in tracker-watchlist.spec.ts) cannot express
 * any of that, because nothing persists from one call to the next.
 *
 * It is deliberately strict: `matchWhere` THROWS on a `where` filter shape it does
 * not model, so a scoping assertion can never pass because the double matched
 * everything. Not a Prisma emulator — only the operations these services issue.
 */

export interface TopicRow {
  id: string;
  watchlistId: string;
  tenantId: string;
  label: string;
  issueArea: string | null;
  position: string;
  priority: string;
  createdAt: string;
}
export interface TermRow {
  id: string;
  watchlistId: string;
  tenantId: string;
  topicId: string | null;
  termType: string;
  value: string;
  weight?: number;
  createdAt: string;
}
export interface HeadRow {
  id: string;
  tenantId: string;
  clientId: string;
  issueAreas: string[];
  jurisdictions: string[];
  version: number;
  updatedBy: string | null;
  updatedAt: Date;
}

/**
 * Exact scalars/null plus Prisma's `{ in: [...] }` and `{ not: x }`. Throws on
 * anything else so an unmodelled filter is a loud test failure, not a silent
 * match-everything.
 */
export function matchWhere(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  for (const [k, v] of Object.entries(where)) {
    if (v !== null && typeof v === 'object' && !(v instanceof Date)) {
      const op = v as Record<string, unknown>;
      if ('in' in op) {
        if (!(op['in'] as unknown[]).includes(row[k])) return false;
      } else if ('not' in op) {
        if (row[k] === op['not']) return false;
      } else {
        throw new Error(`watchlist-store: unmodelled where filter on ${k}: ${JSON.stringify(v)}`);
      }
    } else if (row[k] !== v) return false;
  }
  return true;
}

export interface WatchlistStore {
  /** Pass to `new TrackerWatchlistService(store.prisma)`. */
  prisma: unknown;
  /** Every write op the service issued, in order. */
  ops: string[];
  revisions: Array<Record<string, unknown>>;
  /** Seed a legacy flat (topicId: null) term — putWatchlist can never write one. */
  seedFlatTerm: (row: { termType: string; value: string }) => void;
  /** Seed the `wl:<clientId>` head row without going through putWatchlist. */
  seedWatchlistRow: (patch?: Partial<HeadRow>) => void;
  /** Seed a SECOND watchlist row for the same client (random cuid, old WatchlistsTab). */
  seedForeignRow: (rowId: string) => void;
  snapshot: () => { topics: TopicRow[]; terms: TermRow[]; head: HeadRow | null };
}

export function makeWatchlistStore(opts: {
  tenantId: string;
  clientId: string;
  /** Overrides assertClientInTenant's lookup — pass [] to simulate a foreign tenant. */
  clientRows?: Array<{ id: string }>;
  /**
   * Capiro role returned for the `tenant_memberships` probe (P1-02 admin gate).
   * `null` simulates a caller with NO membership row (the fail-open path).
   * Defaults to `capiro_admin` so existing tests are unaffected by the gate.
   */
  membershipRole?: string | null;
  /** first/last name for the `users` attribution lookup; null = no name on file. */
  userName?: { firstName: string | null; lastName: string | null } | null;
}): WatchlistStore {
  const { tenantId, clientId } = opts;
  const wlId = `wl:${clientId}`;
  let head: HeadRow | null = null;
  let topics: TopicRow[] = [];
  let terms: TermRow[] = [];
  const revisions: Array<Record<string, unknown>> = [];
  const ops: string[] = [];
  let nextId = 1;

  const tx = {
    watchlist: {
      upsert: async ({ where, create, update }: any) => {
        ops.push('watchlist.upsert');
        if (!head) {
          head = {
            id: where.id,
            tenantId: create.tenantId,
            clientId: create.clientId,
            issueAreas: create.issueAreas ?? [],
            jurisdictions: create.jurisdictions ?? [],
            version: create.version ?? 0,
            updatedBy: create.updatedBy ?? null,
            updatedAt: new Date(0),
          };
        } else {
          Object.assign(head, update);
        }
        return { ...head };
      },
      findFirst: async ({ where }: any) =>
        head && matchWhere(head as unknown as Record<string, unknown>, where) ? { ...head } : null,
    },
    watchlistTopic: {
      deleteMany: async ({ where }: any) => {
        ops.push('topic.deleteMany');
        const doomed = topics.filter((t) => matchWhere(t as unknown as Record<string, unknown>, where));
        const doomedIds = new Set(doomed.map((t) => t.id));
        topics = topics.filter((t) => !doomedIds.has(t.id));
        // `onDelete: Cascade` on WatchlistTerm.topic (schema.prisma).
        terms = terms.filter((x) => x.topicId === null || !doomedIds.has(x.topicId));
        return { count: doomed.length };
      },
      upsert: async ({ where, create, update }: any) => {
        ops.push('topic.upsert');
        const key = where.watchlistId_label;
        const found = topics.find((t) => t.watchlistId === key.watchlistId && t.label === key.label);
        if (found) {
          Object.assign(found, update);
          return { id: found.id };
        }
        const id = `topic-${nextId++}`;
        topics.push({ id, createdAt: `topic-created-${id}`, ...create });
        return { id };
      },
      update: async ({ where, data }: any) => {
        ops.push('topic.update');
        const found = topics.find((t) => t.id === where.id);
        if (!found) throw new Error(`watchlist-store: topic ${where.id} not found`);
        Object.assign(found, data);
        return { id: found.id };
      },
      findMany: async ({ where }: any) =>
        topics
          .filter((t) => matchWhere(t as unknown as Record<string, unknown>, where))
          .map((t) => ({
            id: t.id,
            label: t.label,
            issueArea: t.issueArea,
            position: t.position,
            priority: t.priority,
          })),
    },
    watchlistTerm: {
      deleteMany: async ({ where }: any) => {
        ops.push('term.deleteMany');
        const before = terms.length;
        terms = terms.filter((x) => !matchWhere(x as unknown as Record<string, unknown>, where));
        return { count: before - terms.length };
      },
      createMany: async ({ data }: any) => {
        ops.push('term.createMany');
        for (const row of data) {
          const id = `term-${nextId++}`;
          terms.push({ id, createdAt: `term-created-${id}`, ...row });
        }
        return { count: data.length };
      },
      findMany: async ({ where }: any) => {
        const scopedTopicIds = topics
          .filter((t) => t.watchlistId === where.watchlistId && t.tenantId === where.tenantId)
          .map((t) => t.id);
        return terms
          .filter((x) => x.watchlistId === where.watchlistId && x.tenantId === where.tenantId)
          .filter((x) => (where.topicId === undefined ? true : matchWhere(x as unknown as Record<string, unknown>, { topicId: where.topicId })))
          .filter((x) => x.topicId === null || scopedTopicIds.includes(x.topicId))
          .map((x) => ({
            id: x.id,
            topicId: x.topicId,
            termType: x.termType,
            value: x.value,
            weight: x.weight,
          }));
      },
    },
    intelWatchlistRevision: {
      create: async ({ data }: any) => {
        ops.push('revision.create');
        const row = { id: `rev-${nextId++}`, createdAt: new Date(0), ...data };
        revisions.push(row);
        return row;
      },
      findMany: async ({ where, take }: any) =>
        revisions
          .filter((r) => matchWhere(r, where))
          .sort((a, b) => (b['version'] as number) - (a['version'] as number))
          .slice(0, take ?? revisions.length),
    },
  };

  const prisma = {
    withTenant: async (_tid: string, fn: (t: unknown) => unknown) => fn(tx),
    // Routes by SQL rather than by call order: the service issues three different
    // raw probes (client ownership, membership role, display name) and a positional
    // double silently mis-answers them the moment call order changes.
    withSystem: async (fn: (t: unknown) => unknown) =>
      fn({
        $queryRawUnsafe: async (sql: string) => {
          if (/tenant_memberships/i.test(sql)) {
            const role = opts.membershipRole === undefined ? 'capiro_admin' : opts.membershipRole;
            return role === null ? [] : [{ role }];
          }
          if (/first_name/i.test(sql)) {
            return opts.userName === undefined
              ? [{ firstName: 'Ada', lastName: 'Lovelace' }]
              : opts.userName === null
                ? []
                : [opts.userName];
          }
          if (/FROM client_facilities/i.test(sql)) return [];
          return opts.clientRows ?? [{ id: clientId }];
        },
      }),
  };

  return {
    prisma,
    ops,
    revisions,
    seedFlatTerm: (row) => {
      const id = `term-${nextId++}`;
      terms.push({
        id,
        watchlistId: wlId,
        tenantId,
        topicId: null,
        createdAt: `term-created-${id}`,
        ...row,
      });
    },
    seedWatchlistRow: (patch) => {
      head = {
        id: wlId,
        tenantId,
        clientId,
        issueAreas: [],
        jurisdictions: [],
        version: 0,
        updatedBy: null,
        updatedAt: new Date(0),
        ...patch,
      };
    },
    seedForeignRow: (rowId) => {
      const tid = `topic-foreign-${nextId++}`;
      topics.push({
        id: tid,
        watchlistId: rowId,
        tenantId,
        label: 'foreign topic',
        issueArea: null,
        position: 'monitor',
        priority: 'med',
        createdAt: 'foreign',
      });
      terms.push({
        id: `term-foreign-${nextId++}`,
        watchlistId: rowId,
        tenantId,
        topicId: tid,
        termType: 'topic',
        value: 'foreign term',
        createdAt: 'foreign',
      });
      terms.push({
        id: `term-foreign-flat-${nextId++}`,
        watchlistId: rowId,
        tenantId,
        topicId: null,
        termType: 'agency',
        value: 'foreign flat',
        createdAt: 'foreign',
      });
    },
    snapshot: () => ({
      topics: topics.map((t) => ({ ...t })),
      terms: terms.map((x) => ({ ...x })),
      head: head ? { ...head } : null,
    }),
  };
}
