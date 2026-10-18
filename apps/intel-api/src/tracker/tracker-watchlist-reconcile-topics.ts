import { weightForTerm } from '../watchlist/term-routing.js';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type {
  WatchlistReconcilePolicy,
  WatchlistReconcileContext,
  WatchlistTopicIndex,
  WatchlistTermIndex,
  WatchlistTermKey,
} from './tracker-watchlist.contracts.js';
export function rejectReservedTopics(
  policy: WatchlistReconcilePolicy,
  context: WatchlistReconcileContext,
  flatTermCount: number,
  byLabel: WatchlistTopicIndex,
): void {
  const { incoming, rejectedTopics } = context;
  // §4.3 / criterion 3 — the reserved label. Acceptable ONLY as the fold-back of
  // this row's flat terms, or as a topic that already carries it; otherwise it is
  // a user typing the synthetic name, which would shadow the fold on the next
  // read. Decided HERE rather than during payload normalization because it
  // depends on persisted state (the flat-term count) that is only known inside
  // the transaction.
  const reservedIsLegitimate =
    flatTermCount > 0 || [...byLabel.keys()].some((k) => policy.reservedLabel(k));
  if (!reservedIsLegitimate) {
    for (const tp of incoming) {
      if (!policy.reservedLabel(tp.label)) continue;
      rejectedTopics.push({
        index: tp.index,
        label: tp.label,
        reason: `"${policy.hearingLabel()}" is a reserved name.`,
      });
      tp.skipped = true;
    }
  }
}
export async function renameWatchlistTopics(
  tx: Prisma.TransactionClient,
  context: WatchlistReconcileContext,
  byLabel: WatchlistTopicIndex,
) {
  const { incoming, rejectedTopics } = context;
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
  return protectedLabels;
}
export async function upsertWatchlistTopics(
  tx: Prisma.TransactionClient,
  context: WatchlistReconcileContext,
  byLabel: WatchlistTopicIndex,
  termsByTopic: WatchlistTermIndex,
  termKey: WatchlistTermKey,
): Promise<void> {
  const { incoming, wlId, tenantId } = context;
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
    const unchanged = persisted.size === wanted.size && [...wanted].every((k) => persisted.has(k));
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
}
