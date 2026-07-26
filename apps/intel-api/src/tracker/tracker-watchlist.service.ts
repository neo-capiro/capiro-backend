import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { issueAreaForSector } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { isAcceptableTerm, termRejectionReason } from '../watchlist/term-validation.js';
import { compileWatchlist, type CompiledWatchlist } from '../watchlist/watchlist-compiler.js';
import { termSurfaceMap, weightForTerm, type TermRoute } from '../watchlist/term-routing.js';
import { normalizeE164 } from './sms/sms.service.js';

/**
 * Synthetic topic label for hearing-native FLAT terms (topicId NULL) folded into
 * the unified editor (P5). The old WatchlistsTab wrote flat terms straight onto a
 * watchlist row; the unified editor now owns them, so getWatchlist surfaces them
 * under this topic (rather than orphaning them) and putWatchlist re-persists them
 * from the same-named topic. Prefixed to avoid colliding with a real tag label.
 */
export const HEARING_TERMS_TOPIC_LABEL = 'Hearing terms';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read/write API for the UNIFIED tracker watchlist (Phase 2, plan §5.2).
 *
 * Operates on the deterministic-id watchlist `wl:<clientId>` + its topics/terms
 * and the per-user `intel_alert_preference`. intel-api has no RLS, so every
 * query filters by the TenantGuard-resolved `tenantId` (app-code isolation).
 * All routes are gated by `tracker_owner_intel` (TrackerOwnerGuard, 404 when
 * off), so during shadow only the internal tenant can write here — apps/api
 * stays source of truth (D6).
 */
export interface TrackerTermInput {
  termType: string;
  value: string;
}
export interface TrackerTopicInput {
  label: string;
  issueArea?: string | null;
  position?: string;
  priority?: string;
  terms?: TrackerTermInput[];
  /**
   * P0-03 item 5: the topic's PREVIOUS label, sent when the user renamed this tag.
   * The reconcile renames in place so the topic id — and therefore its terms and
   * any `WatchlistMatch.termId` reference to them — survives the rename. Absent
   * on a create or an unchanged topic.
   */
  renameFrom?: string;
}
export interface PutWatchlistInput {
  issueAreas?: string[];
  topics?: TrackerTopicInput[];
  /** State Legislation Platform (DD5) — empty = federal-only (unchanged default); non-empty also matches those states' bill corpus. */
  jurisdictions?: string[];
  /**
   * P1-02: optimistic-concurrency token — the `version` the client last read.
   * ABSENT is accepted (and logged): an un-updated browser bundle must not have
   * every save hard-broken the moment this deploys.
   */
  expectedVersion?: number;
}
export interface WatchlistView {
  clientId: string;
  issueAreas: string[];
  jurisdictions: string[];
  topics: Array<{
    label: string;
    issueArea: string | null;
    position: string;
    priority: string;
    terms: Array<{ termType: string; value: string; id?: string }>;
  }>;
  /**
   * P6 sector-default: the sector-derived issue area for a NEVER-configured client
   * (no `wl:` row), surfaced as a read-time SUGGESTION so a cold client isn't
   * blank. Never written on read, absent once a row exists (parity-safe — parity
   * compares persisted rows, not this hint).
   */
  suggestedIssueAreas?: string[];
  /** Same posture, for state jurisdictions (S5.1) — derived from client_facilities.state, shown only while the client's own jurisdictions are empty. */
  suggestedJurisdictions?: string[];
  /**
   * P0-03/P0-05: what the server refused to persist on the write that produced this
   * view, so the editor can show inline validation instead of the user believing a
   * blank tag or a 2-char fragment was saved. Absent on a pure GET.
   */
  rejected?: {
    topics: Array<{ index: number; label: string; reason: string }>;
    terms: Array<{ topicLabel: string; termType: string; value: string; reason: string }>;
  };
  /**
   * P1-02 optimistic concurrency. Targeting is SHARED firm-wide and the editor
   * autosaves the whole payload, so two analysts on one client used to silently
   * overwrite each other. The client echoes this back as `expectedVersion`; a
   * stale one gets a 409. `0` for a never-configured client, which is what makes
   * the first PUT's `expectedVersion: 0` correct against a row that does not exist.
   */
  version: number;
  /** Clerk user id of the last writer. NEVER rendered — resolve or show the time. */
  updatedBy: string | null;
  updatedAt: string | null;
}

/** One row of the shared-targeting change log (P1-02). */
export interface WatchlistRevisionView {
  version: number;
  changedBy: string | null;
  createdAt: string;
  summary: unknown;
}
/**
 * Default alert triggers seeded on a new subscriber pref (kept in sync with
 * apps/api tracker.types.DEFAULT_TRIGGERS). LegiWatch B deliberately turns
 * `fiscalNote` + `sponsorMomentum` default-ON now that emitters exist for them
 * (they were defined-but-dead before); `newMatch` and the text-changed→`amendment`
 * key were already default-on. `deadline` (Phase 1 M2.3) joins the same way —
 * the emitter now exists. Existing subscribers pick these up via the
 * idempotent `backfill-default-triggers` verb (they were never deliverable, so
 * appending them can't clobber a deliberate opt-out).
 */
export const DEFAULT_TRIGGERS: readonly string[] = [
  'newMatch',
  'amendment',
  'hearing',
  'committeeVote',
  'floorVote',
  'enactedFailed',
  'fiscalNote',
  'sponsorMomentum',
  'companion',
  'deadline',
];

export interface PutAlertPrefsInput {
  triggers?: string[];
  materiality?: string;
  emailEnabled?: boolean;
  emailAddress?: string | null;
  emailCadence?: string;
  smsEnabled?: boolean;
  smsPhone?: string | null;
  smsCadence?: string;
  quietHoursStart?: string | null;
  quietHoursEnd?: string | null;
  /** State Legislation Platform (DD5) — empty = ALL jurisdictions the client's watchlist produces. */
  jurisdictions?: string[];
}

@Injectable()
export class TrackerWatchlistService {
  private readonly logger = new Logger(TrackerWatchlistService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getWatchlist(tenantId: string, clientId: string): Promise<WatchlistView> {
    const wlId = `wl:${clientId}`;
    const wl = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlist.findFirst({
        where: { id: wlId, tenantId },
        select: {
          issueAreas: true,
          jurisdictions: true,
          // P1-02: the concurrency token + attribution the editor echoes back.
          version: true,
          updatedBy: true,
          updatedAt: true,
        },
      }),
    );
    // Never configured → surface the sector-derived issue area as a suggestion
    // so the cold client isn't blank (P6). No write on read; the editor opts in.
    if (!wl) {
      const suggested = await this.getSectorSuggestion(tenantId, clientId);
      const suggestedJ = await this.suggestedJurisdictions(tenantId, clientId);
      return {
        clientId,
        issueAreas: [],
        jurisdictions: [],
        topics: [],
        // A row that does not exist yet is version 0, so the first PUT's
        // `expectedVersion: 0` matches rather than 409-ing on a cold client.
        version: 0,
        updatedBy: null,
        updatedAt: null,
        ...(suggested.length ? { suggestedIssueAreas: suggested } : {}),
        ...(suggestedJ.length ? { suggestedJurisdictions: suggestedJ } : {}),
      };
    }
    const topics = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlistTopic.findMany({
        where: { watchlistId: wlId, tenantId },
        select: { id: true, label: true, issueArea: true, position: true, priority: true },
      }),
    );
    const topicIds = topics.map((t) => t.id);
    // Topic-scoped terms + any hearing-native FLAT terms on this SAME row
    // (topicId NULL). The old WatchlistsTab wrote flat terms; the unified editor
    // now owns them, so fold them into a synthetic topic rather than dropping
    // them (putWatchlist re-persists them as topic terms — see below).
    const terms = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlistTerm.findMany({
        where: {
          watchlistId: wlId,
          tenantId,
          OR: [...(topicIds.length ? [{ topicId: { in: topicIds } }] : []), { topicId: null }],
        },
        select: { id: true, topicId: true, termType: true, value: true },
      }),
    );
    const outTopics = topics.map((t) => ({
      label: t.label,
      issueArea: t.issueArea,
      position: t.position,
      priority: t.priority,
      terms: terms
        .filter((x) => x.topicId === t.id)
        .map((x) => ({ termType: x.termType, value: x.value, id: x.id })),
    }));
    const flatTerms = terms.filter((x) => x.topicId === null);
    if (flatTerms.length) {
      const flat = flatTerms.map((x) => ({ termType: x.termType, value: x.value, id: x.id }));
      // Gate B §4.3: `HEARING_TERMS_TOPIC_LABEL` is a REAL, saveable label — the
      // first putWatchlist of this view persists the folded flat terms under a
      // topic with exactly this name. So a client can legitimately have BOTH flat
      // terms and a real topic called "Hearing terms" (legacy WatchlistsTab writes
      // flat terms straight onto the row at any time). MERGE into the existing
      // topic rather than pushing a second one with the same label: a duplicate
      // label in the view would be rejected as a dupe by putWatchlist's reconcile
      // and the flat rows cleared, destroying them. Merging is loss-free and
      // idempotent. Do NOT instead "reserve" the label — rejecting it on write is
      // what loses the terms (boundary §2.4.1).
      const host = outTopics.find(
        (t) => t.label.toLowerCase() === HEARING_TERMS_TOPIC_LABEL.toLowerCase(),
      );
      if (host) host.terms.push(...flat);
      else
        outTopics.push({
          label: HEARING_TERMS_TOPIC_LABEL,
          issueArea: null,
          position: 'monitor',
          priority: 'med',
          terms: flat,
        });
    }
    const suggestedJ = wl.jurisdictions.length
      ? []
      : await this.suggestedJurisdictions(tenantId, clientId);
    return {
      clientId,
      issueAreas: wl.issueAreas,
      jurisdictions: wl.jurisdictions,
      topics: outTopics,
      version: wl.version ?? 0,
      updatedBy: wl.updatedBy ?? null,
      updatedAt: wl.updatedAt?.toISOString() ?? null,
      ...(suggestedJ.length ? { suggestedJurisdictions: suggestedJ } : {}),
    };
  }

  /**
   * The sector-derived issue area for a never-configured client (P6, legacy
   * carryover from apps/api getWatchlist which auto-selected
   * issueAreaForSector(client.sectorTag)). Tenant-scoped read (intel-api has no
   * RLS) via withSystem; returns [] on any miss. Read-only — never written.
   */
  private async getSectorSuggestion(tenantId: string, clientId: string): Promise<string[]> {
    if (!UUID_RE.test(clientId)) return [];
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ sectorTag: string | null }>>(
        'SELECT sector_tag AS "sectorTag" FROM clients WHERE id = $1::uuid AND tenant_id = $2::uuid',
        clientId,
        tenantId,
      ),
    );
    const area = issueAreaForSector(rows[0]?.sectorTag ?? null);
    return area ? [area] : [];
  }

  /**
   * Upsert the watchlist head + reconcile its topics/terms atomically, keyed on
   * LABEL (P0-03 item 5, P1-02).
   *
   * Replaces the original delete-all-then-recreate: it cascade-deleted every
   * topic and re-created each one with a FRESH cuid on every autosave, so no
   * topic id was ever stable across two saves, a rename was indistinguishable
   * from a delete+create, and every term row's `createdAt` reset 600ms after any
   * keystroke. `(watchlistId, label)` is now a real unique index (migration
   * 20260726120000), which is what makes a per-topic upsert possible.
   *
   * Order is load bearing: renames BEFORE creates/deletes (so an id survives a
   * rename), per-topic term replacement (so an untouched topic keeps its rows),
   * deletes computed from the POST-rename index (so a renamed topic is never
   * deleted, §4.6), and the flat-term clear LAST (§4.1 / boundary §2.4.1 — the
   * folded "Hearing terms" rows have only just been re-persisted as topic rows).
   *
   * Idempotent: two identical calls leave identical rows AND identical topic ids.
   */
  async putWatchlist(
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutWatchlistInput,
  ): Promise<WatchlistView> {
    // CROSS-TENANT GUARD (batch-A review, CRITICAL): wl:<clientId> is a globally
    // unique id and intel-api has no RLS, so an unscoped write could clobber
    // ANOTHER tenant's watchlist (cascade-deleting all their topics/terms).
    // Prove the client belongs to the caller — same guard the sibling writers
    // (putAlertPrefs/markPhoneVerified) carry; TrackerOwnerGuard only checks the
    // caller's flag, not client ownership.
    await this.assertClientInTenant(tenantId, clientId);
    const wlId = `wl:${clientId}`;
    const issueAreas = Array.isArray(input.issueAreas) ? input.issueAreas : [];
    const jurisdictions = Array.isArray(input.jurisdictions)
      ? input.jurisdictions.map((j) => j.toUpperCase())
      : [];
    const rawTopics = Array.isArray(input.topics) ? input.topics : [];
    // P0-03/P0-05: everything the server refuses, reported back to the editor
    // instead of vanishing silently.
    const rejectedTopics: Array<{ index: number; label: string; reason: string }> = [];
    const rejectedTerms: Array<{ topicLabel: string; termType: string; value: string; reason: string }> = [];

    // ── Normalize the payload into the desired state (step 3) ────────────────
    interface IncomingTopic {
      index: number;
      label: string;
      issueArea: string | null;
      position: string;
      priority: string;
      terms: Array<{ termType: string; value: string }>;
      renameFrom?: string;
      /** Set when a rename collided with a live label (§4.5): apply nothing. */
      skipped?: boolean;
    }
    const incoming: IncomingTopic[] = [];
    const seenLabels = new Set<string>();
    rawTopics.forEach((tp, index) => {
      const label = (tp?.label ?? '').trim();
      if (!label) {
        rejectedTopics.push({ index, label: tp?.label ?? '', reason: 'A tag needs a name.' });
        return;
      }
      const key = label.toLowerCase();
      if (seenLabels.has(key)) {
        rejectedTopics.push({ index, label, reason: 'Duplicate tag name.' });
        return;
      }
      seenLabels.add(key);
      // De-dupe terms within the topic on (termType, lower(value)). The payload
      // can legitimately carry the same term twice — e.g. §4.3's merge folds flat
      // hearing terms into a same-named real topic that may already hold one —
      // and without this the row count would grow by one on every save.
      const terms: Array<{ termType: string; value: string }> = [];
      const seenTerms = new Set<string>();
      for (const t of tp.terms ?? []) {
        if (!t?.value || !t.termType) continue;
        const value = t.value.trim();
        if (!isAcceptableTerm(value)) {
          rejectedTerms.push({
            topicLabel: label,
            termType: t.termType,
            value,
            reason: termRejectionReason(value) ?? 'Term rejected.',
          });
          continue;
        }
        const tk = JSON.stringify([t.termType, value.toLowerCase()]);
        if (seenTerms.has(tk)) continue;
        seenTerms.add(tk);
        terms.push({ termType: t.termType, value });
      }
      const from = (tp.renameFrom ?? '').trim();
      incoming.push({
        index,
        label,
        issueArea: tp.issueArea ?? null,
        position: tp.position ?? 'monitor',
        priority: tp.priority ?? 'med',
        terms,
        ...(from && from.toLowerCase() !== key ? { renameFrom: from } : {}),
      });
    });

    let goneLabels: string[] = [];
    // withTenant IS a $transaction (one atomic reconcile) + sets the tenant GUC.
    await this.prisma.withTenant(tenantId, async (tx) => {
      // P1-02: optimistic concurrency on SHARED targeting, checked INSIDE the
      // transaction so the compare and the bump cannot interleave with another
      // writer. An absent expectedVersion is accepted and logged — making it
      // required would 400 every save from an in-flight browser tab on deploy.
      const head = await tx.watchlist.findFirst({
        where: { id: wlId, tenantId },
        select: { version: true },
      });
      const current = head?.version ?? 0;
      if (input.expectedVersion !== undefined && input.expectedVersion !== current) {
        throw new ConflictException({
          code: 'WATCHLIST_VERSION_CONFLICT',
          message:
            'This client’s targeting was changed by someone else. Reload to see their changes before saving yours.',
          currentVersion: current,
        });
      }
      if (input.expectedVersion === undefined) {
        this.logger.warn(
          `putWatchlist without expectedVersion (unversioned client) client=${clientId} version=${current}`,
        );
      }

      // Step 4 — the head. Only ever the `wl:<clientId>` row; hearing flat terms
      // on OTHER watchlist rows (random cuid, old WatchlistsTab) live on a
      // different watchlistId and stay structurally untouched (proven by test).
      await tx.watchlist.upsert({
        where: { id: wlId },
        create: {
          id: wlId,
          tenantId,
          clientId,
          name: 'Watchlist',
          createdBy: userId,
          issueAreas,
          jurisdictions,
          version: 1,
          updatedBy: userId,
        },
        update: { issueAreas, jurisdictions, version: current + 1, updatedBy: userId },
      });

      // Step 5 — the live topics for this row, indexed by lower-cased label.
      const existing = await tx.watchlistTopic.findMany({
        where: { watchlistId: wlId, tenantId },
        select: { id: true, label: true },
      });
      const byLabel = new Map<string, { id: string; label: string }>();
      for (const t of existing) byLabel.set(t.label.toLowerCase(), { id: t.id, label: t.label });
      // The row's persisted terms, once, so step 8 can SKIP a topic whose term set
      // is unchanged. Without this the debounced autosave would delete+recreate
      // every term row of every topic 600ms after any keystroke — resetting each
      // row's id and createdAt, which is the same churn the delete-all rebuild had.
      const existingTerms = await tx.watchlistTerm.findMany({
        where: { watchlistId: wlId, tenantId, topicId: { not: null } },
        select: { topicId: true, termType: true, value: true, weight: true },
      });
      // `weight` is part of the key so flipping a topic’s PRIORITY rewrites its
            // terms’ weights (§4.9) rather than being skipped as an unchanged term set.
            const termKey = (t: { termType: string; value: string; weight: number }) =>
              JSON.stringify([t.termType, t.value, t.weight]);
      const termsByTopic = new Map<string, Set<string>>();
      for (const t of existingTerms) {
        const k = t.topicId as string;
        const set = termsByTopic.get(k) ?? new Set<string>();
        set.add(termKey(t));
        termsByTopic.set(k, set);
      }

      // Step 6 — RENAMES FIRST. Renaming in place is the whole point: it keeps
      // the topic id, and therefore its term rows and anything referencing them.
      /** Labels a rejected rename must protect from step 9's delete sweep. */
      const protectedLabels = new Set<string>();
      for (const tp of incoming) {
        if (!tp.renameFrom) continue;
        const fromKey = tp.renameFrom.toLowerCase();
        const src = byLabel.get(fromKey);
        // §4.4: the source label no longer exists (another analyst deleted it) →
        // ignore the rename and let step 7 create the topic. Never throw.
        if (!src) continue;
        const destKey = tp.label.toLowerCase();
        if (byLabel.has(destKey)) {
          // §4.5: renaming onto a live label would violate (watchlistId, label).
          // Reject THIS topic and leave BOTH intact — never let a P2002 escape
          // as a 500.
          rejectedTopics.push({ index: tp.index, label: tp.label, reason: 'Duplicate tag name.' });
          tp.skipped = true;
          // BOTH labels must survive step 9: the source (which the payload no
          // longer lists as its own entry, so it would otherwise be swept) and the
          // destination (which this rejected topic was the only entry naming).
          protectedLabels.add(fromKey);
          protectedLabels.add(destKey);
          continue;
        }
        await tx.watchlistTopic.update({ where: { id: src.id }, data: { label: tp.label } });
        byLabel.delete(fromKey);
        byLabel.set(destKey, { id: src.id, label: tp.label });
      }

      // Steps 7 + 8 — upsert each topic on (watchlistId, label), then replace
      // only THAT topic's terms. Per-topic (not global) replacement is what keeps
      // an untouched topic's rows — and their createdAt — stable.
      for (const tp of incoming) {
        if (tp.skipped) continue;
        const topic = await tx.watchlistTopic.upsert({
          where: { watchlistId_label: { watchlistId: wlId, label: tp.label } },
          create: {
            watchlistId: wlId,
            tenantId,
            label: tp.label,
            issueArea: tp.issueArea,
            position: tp.position,
            priority: tp.priority,
          },
          update: { issueArea: tp.issueArea, position: tp.position, priority: tp.priority },
        });
        byLabel.set(tp.label.toLowerCase(), { id: topic.id, label: tp.label });
        // Unchanged term set → no write at all, so the rows keep their ids and
        // createdAt. Exact (case-sensitive) compare: `AI` vs `ai` is a real
        // difference for short identifier-shaped terms (P0-05).
        const persisted = termsByTopic.get(topic.id) ?? new Set<string>();
        const wanted = new Set(
          tp.terms.map((t) => termKey({ ...t, weight: weightForTerm(t.termType, tp.priority) })),
        );
        const unchanged =
          persisted.size === wanted.size && [...wanted].every((k) => persisted.has(k));
        if (unchanged) continue;
        await tx.watchlistTerm.deleteMany({
          where: { topicId: topic.id, watchlistId: wlId, tenantId },
        });
        if (tp.terms.length) {
          await tx.watchlistTerm.createMany({
            data: tp.terms.map((t) => ({
              watchlistId: wlId,
              tenantId,
              topicId: topic.id,
              termType: t.termType,
              value: t.value,
              // §4.9: the column existed and defaulted to 1 for every row, so the
              // stored weight was a lie. Persist the real one — the hearing
              // matcher reads these rows directly, not just via getCompiled.
              weight: weightForTerm(t.termType, tp.priority),
            })),
          });
        }
      }

      // Step 9 — delete the topics the client removed, computed from the
      // POST-rename index so a renamed topic is never swept (§4.6). The cascade
      // removes their terms.
      const keep = new Set(incoming.filter((t) => !t.skipped).map((t) => t.label.toLowerCase()));
      for (const l of protectedLabels) keep.add(l);
      const gone = [...byLabel.entries()].filter(([k]) => !keep.has(k));
      goneLabels = gone.map(([, v]) => v.label);
      if (gone.length) {
        await tx.watchlistTopic.deleteMany({
          where: { id: { in: gone.map(([, v]) => v.id) }, watchlistId: wlId, tenantId },
        });
      }

      // Step 10 — clear this row's hearing FLAT terms (topicId NULL) LAST.
      // getWatchlist folded them into the "Hearing terms" topic, which step 8 has
      // just re-persisted as topic-scoped rows; running this BEFORE step 8 would
      // lose every flat term (boundary §2.4.1).
      await tx.watchlistTerm.deleteMany({ where: { watchlistId: wlId, tenantId, topicId: null } });

      // P1-02 — the change log, in the SAME transaction as the reconcile, so a
      // rolled-back save leaves no phantom revision and a rejected one (the 409
      // above) writes none at all. Labels and counts only; never term values.
      await tx.intelWatchlistRevision.create({
        data: {
          tenantId,
          clientId,
          watchlistId: wlId,
          version: current + 1,
          changedBy: userId,
          summary: {
            topics: incoming.filter((t) => !t.skipped).length,
            terms: incoming.reduce((n, t) => n + (t.skipped ? 0 : t.terms.length), 0),
            issueAreas: issueAreas.length,
            jurisdictions: jurisdictions.length,
            renamed: incoming
              .filter((t) => t.renameFrom && !t.skipped)
              .map((t) => ({ from: t.renameFrom, to: t.label })),
            deleted: goneLabels,
            rejected: rejectedTopics.length + rejectedTerms.length,
          },
        },
      });
    });
    const view = await this.getWatchlist(tenantId, clientId);
    return { ...view, rejected: { topics: rejectedTopics, terms: rejectedTerms } };
  }

  /**
   * The shared-targeting change log, newest first (P1-02). Capped at 20 — this is
   * a "who touched this recently" affordance in the Configure panel, not an audit
   * export. `assertClientInTenant` first: the table's rows carry tenant_id but the
   * route takes a client id from the URL.
   */
  async getRevisions(tenantId: string, clientId: string): Promise<WatchlistRevisionView[]> {
    await this.assertClientInTenant(tenantId, clientId);
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelWatchlistRevision.findMany({
        where: { tenantId, clientId },
        orderBy: { version: 'desc' },
        take: 20,
        select: { version: true, changedBy: true, createdAt: true, summary: true },
      }),
    );
    return rows.map((r) => ({
      version: r.version,
      changedBy: r.changedBy ?? null,
      createdAt: r.createdAt.toISOString(),
      summary: r.summary,
    }));
  }

  async getAlertPrefs(tenantId: string, clientId: string, userId: string) {
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.findUnique({
        where: { userId_clientId: { userId, clientId } },
      }),
    );
    if (row && row.tenantId === tenantId) return row;
    // P1-01: a NEW pref view returns the shipped defaults, not zero triggers. Returning
    // [] let a user save emailEnabled=true with every trigger off, so eligible()
    // (intel-alert.service.ts) matched nothing forever. markPhoneVerified already
    // seeded [...DEFAULT_TRIGGERS] on create — this makes all three paths agree.
    return {
      clientId,
      userId,
      triggers: [...DEFAULT_TRIGGERS],
      materiality: 'medium',
      emailEnabled: false,
      emailAddress: null,
      emailCadence: 'realtime',
      smsEnabled: false,
      smsPhone: null,
      smsPhoneVerified: false,
      smsCadence: 'realtime',
      quietHoursStart: null,
      quietHoursEnd: null,
      jurisdictions: [] as string[],
    };
  }

  /**
   * Legacy `assertClient` port: 404 unless `clientId` is a client of the
   * caller's tenant. intel-api has no RLS, and (userId, clientId) — the pref
   * unique key — carries no tenant, so every pref WRITE must first prove the
   * client belongs to the caller (cross-tenant review finding, PR-1).
   */
  async assertClientInTenant(tenantId: string, clientId: string): Promise<void> {
    if (!UUID_RE.test(clientId)) throw new NotFoundException('Client not found');
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ id: string }>>(
        'SELECT id::text AS id FROM clients WHERE id = $1::uuid AND tenant_id = $2::uuid',
        clientId,
        tenantId,
      ),
    );
    if (rows.length === 0) throw new NotFoundException('Client not found');
  }

  /**
   * The upsert's update-branch guard: the unique key is tenant-free, so a row
   * created under ANOTHER tenant (same user in two orgs) must read as absent —
   * mirrors getAlertPrefs's `row.tenantId === tenantId` read guard.
   */
  private async assertPrefRowTenant(
    tenantId: string,
    clientId: string,
    userId: string,
  ): Promise<void> {
    const existing = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.findUnique({
        where: { userId_clientId: { userId, clientId } },
        select: { tenantId: true },
      }),
    );
    if (existing && existing.tenantId !== tenantId) throw new NotFoundException('Client not found');
  }

  async putAlertPrefs(
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutAlertPrefsInput,
  ) {
    await this.assertClientInTenant(tenantId, clientId);
    await this.assertPrefRowTenant(tenantId, clientId, userId);
    const data = {
      // P1-01: `??` distinguishes an ABSENT field (undefined → default) from an
      // explicit `[]` (a deliberate clear → honor it). Do not use `||` — that
      // would silently override a user's deliberate clear-all.
      triggers: input.triggers ?? [...DEFAULT_TRIGGERS],
      materiality: input.materiality ?? 'medium',
      emailEnabled: input.emailEnabled ?? false,
      emailAddress: input.emailAddress ?? null,
      emailCadence: input.emailCadence ?? 'realtime',
      smsEnabled: input.smsEnabled ?? false,
      // Normalize like legacy putAlertPrefs — an un-normalized stored phone
      // would never match the verify flow's normalized compare.
      smsPhone: normalizeE164(input.smsPhone) ?? null,
      smsCadence: input.smsCadence ?? 'realtime',
      quietHoursStart: input.quietHoursStart ?? null,
      quietHoursEnd: input.quietHoursEnd ?? null,
      jurisdictions: Array.isArray(input.jurisdictions)
        ? input.jurisdictions.map((j) => j.toUpperCase())
        : [],
    };
    return this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.upsert({
        where: { userId_clientId: { userId, clientId } },
        create: { tenantId, clientId, userId, ...data },
        update: data,
      }),
    );
  }

  /**
   * Mark a verified phone on the user's pref (P1.1, called after OTP confirm —
   * ported from apps/api tracker.service.markPhoneVerified). The confirm flow
   * is the ONLY writer of `smsPhoneVerified` (putAlertPrefs never sets it),
   * preserving the legacy consent contract. Client-ownership + row-tenant
   * guards mirror legacy's assertClient (cross-tenant review finding, PR-1).
   */
  async markPhoneVerified(
    tenantId: string,
    clientId: string,
    userId: string,
    phone: string,
  ): Promise<void> {
    await this.assertClientInTenant(tenantId, clientId);
    await this.assertPrefRowTenant(tenantId, clientId, userId);
    await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlertPreference.upsert({
        where: { userId_clientId: { userId, clientId } },
        update: { smsPhone: phone, smsPhoneVerified: true, smsEnabled: true },
        create: {
          tenantId,
          clientId,
          userId,
          triggers: [...DEFAULT_TRIGGERS],
          smsPhone: phone,
          smsPhoneVerified: true,
          smsEnabled: true,
        },
      }),
    );
  }

  async getCompiled(
    tenantId: string,
    clientId: string,
  ): Promise<CompiledWatchlist & { jurisdictions: string[]; termSurfaces: Record<string, TermRoute['surfaces']> }> {
    const wl = await this.getWatchlist(tenantId, clientId);
    const compiled = compileWatchlist({
      issueAreas: wl.issueAreas,
      topics: wl.topics.map((t) => ({
        label: t.label,
        issueArea: t.issueArea,
        position: t.position,
        priority: t.priority,
      })),
      terms: wl.topics.flatMap((t) =>
        t.terms.map((x) => ({
          termType: x.termType,
          value: x.value,
          // §4.9: was hardcoded 1 for every term, which made the Deepgram cap a
          // lexical coin-flip once a client had more than 100 terms.
          weight: weightForTerm(x.termType, t.priority),
          topicLabel: t.label,
          topicPriority: t.priority,
          termId: x.id ?? null,
        })),
      ),
    });
    // State Legislation Platform (DD5) — jurisdictions ride alongside the pure
    // compiler output rather than threading through compileWatchlist itself
    // (which stays a pure function of issueAreas/topics/terms only).
    // P0-04: termSurfaces lets the Configure UI preview which surfaces each
    // term type affects (b-7) — static, not derived from this client's data.
    return { ...compiled, jurisdictions: wl.jurisdictions, termSurfaces: termSurfaceMap() };
  }

  /**
   * Facility-derived jurisdiction hint for a client (S5.1) — the exact
   * suggestedIssueAreas precedent (getSectorSuggestion above): read-only,
   * never written, absent once the client has explicitly configured
   * jurisdictions. withSystem because client_facilities is tenant-scoped and
   * intel-api has no RLS.
   */
  async suggestedJurisdictions(tenantId: string, clientId: string): Promise<string[]> {
    if (!UUID_RE.test(clientId)) return [];
    const rows = await this.prisma.withSystem((tx) =>
      tx.$queryRawUnsafe<Array<{ state: string | null }>>(
        'SELECT DISTINCT state FROM client_facilities WHERE tenant_id = $1::uuid AND client_id = $2::uuid AND state IS NOT NULL',
        tenantId,
        clientId,
      ),
    );
    return rows.map((r) => r.state).filter((s): s is string => !!s);
  }
}
