import type { TrackerWatchlistService } from './tracker-watchlist.service.js';
import type {
  PutWatchlistInput,
  WatchlistView,
  WatchlistReconcilePolicy,
  WatchlistReconcileContext,
} from './tracker-watchlist.contracts.js';
import { normalizeWatchlistInput } from './tracker-watchlist-input.js';
import {
  validateWatchlistVersion,
  upsertWatchlistHead,
  indexWatchlistTopics,
  indexWatchlistTerms,
} from './tracker-watchlist-reconcile-head.js';
import {
  rejectReservedTopics,
  renameWatchlistTopics,
  upsertWatchlistTopics,
} from './tracker-watchlist-reconcile-topics.js';
import { finishWatchlistReconcile } from './tracker-watchlist-reconcile-finish.js';
export class TrackerWatchlistWrite {
  constructor(private readonly policy: WatchlistReconcilePolicy) {}
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
    host: TrackerWatchlistService,
    tenantId: string,
    clientId: string,
    userId: string,
    input: PutWatchlistInput,
  ): Promise<WatchlistView> {
    // CROSS-TENANT GUARD (batch-A review, CRITICAL): wl:<clientId> is a globally
    // unique id, and while intel_watchlist carries FORCE RLS scoped to
    // tenant_id, defense-in-depth still requires proving CLIENT ownership
    // before an unscoped write can clobber ANOTHER tenant's watchlist
    // (cascade-deleting all their topics/terms). Prove the client belongs to
    // the caller — same guard the sibling writers
    // (putAlertPrefs/markPhoneVerified) carry; TrackerOwnerGuard only checks the
    // caller's flag, not client ownership.
    await host['assertClientInTenant'](tenantId, clientId);
    // P1-02: firm-wide targeting is admin-only. After the tenant/client ownership
    // check, before any write — same fail-closed ordering as the guard above.
    await host['assertCanEditTargeting'](tenantId, userId);
    const context = normalizeWatchlistInput(tenantId, clientId, userId, input);
    const { wlId, incoming, rejectedTopics, rejectedTerms } = context;
    let goneLabels: string[] = [];
    await host['prisma'].withTenant(tenantId, async (tx) => {
      // P1-02: optimistic concurrency on SHARED targeting, checked INSIDE the
      // transaction so the compare and the bump cannot interleave with another
      // writer. An absent expectedVersion was originally accepted-and-logged
      // unconditionally — making it required immediately would have 400ed
      // every save from an in-flight browser tab on deploy. Gate J (MP-02,
      // Neo-confirmed 2026-07-27) adds a dated cutover below: the shipped web
      // client already always sends it, so this only ever catches a stale
      // cached bundle or a hand-rolled request.
      const head = await tx.watchlist.findFirst({
        where: { id: wlId, tenantId },
        select: { version: true },
      });
      const current = validateWatchlistVersion(host, this.policy, context, head);
      await upsertWatchlistHead(tx, context, current);
      // Step 5 — the live topics for this row, indexed by lower-cased label.
      const existing = await tx.watchlistTopic.findMany({
        where: { watchlistId: wlId, tenantId },
        select: { id: true, label: true },
      });
      const byLabel = indexWatchlistTopics(existing);
      // The row's persisted terms, once, so step 8 can SKIP a topic whose term set
      // is unchanged. Without this the debounced autosave would delete+recreate
      // every term row of every topic 600ms after any keystroke — resetting each
      // row's id and createdAt, which is the same churn the delete-all rebuild had.
      const existingTerms = await tx.watchlistTerm.findMany({
        where: { watchlistId: wlId, tenantId },
        select: { topicId: true, termType: true, value: true, weight: true },
      });
      const { termKey, termsByTopic, flatTermCount } = indexWatchlistTerms(existingTerms);
      rejectReservedTopics(this.policy, context, flatTermCount, byLabel);
      const protectedLabels = await renameWatchlistTopics(tx, context, byLabel);
      await upsertWatchlistTopics(tx, context, byLabel, termsByTopic, termKey);
      goneLabels = await finishWatchlistReconcile(tx, context, current, byLabel, protectedLabels);
    });
    // The PUT response feeds the editor directly, so it carries attribution too.
    const view = await host['getWatchlist'](tenantId, clientId, { withUserNames: true });
    return { ...view, rejected: { topics: rejectedTopics, terms: rejectedTerms } };
  }
}
