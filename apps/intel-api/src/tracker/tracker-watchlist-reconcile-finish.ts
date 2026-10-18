import type { Prisma } from '../../generated/prisma-client/index.js';
import type {
  WatchlistReconcileContext,
  WatchlistTopicIndex,
} from './tracker-watchlist.contracts.js';
export async function finishWatchlistReconcile(
  tx: Prisma.TransactionClient,
  context: WatchlistReconcileContext,
  current: number,
  byLabel: WatchlistTopicIndex,
  protectedLabels: Set<string>,
): Promise<string[]> {
  const {
    tenantId,
    clientId,
    userId,
    wlId,
    input,
    issueAreas,
    jurisdictions,
    incoming,
    rejectedTopics,
    rejectedTerms,
  } = context;
  // Step 9 — delete the topics the client removed, computed from the
  // POST-rename index so a renamed topic is never swept (§4.6). The cascade
  // removes their terms.
  const keep = new Set(incoming.filter((t) => !t.skipped).map((t) => t.label.toLowerCase()));
  for (const l of protectedLabels) keep.add(l);
  const gone = [...byLabel.entries()].filter(([k]) => !keep.has(k));
  const goneLabels = gone.map(([, v]) => v.label);
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
  return goneLabels;
}
