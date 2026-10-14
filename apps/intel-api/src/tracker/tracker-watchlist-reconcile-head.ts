import { ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma-client/index.js';
import type { TrackerWatchlistService } from './tracker-watchlist.service.js';
import type {
  WatchlistReconcilePolicy,
  WatchlistReconcileContext,
} from './tracker-watchlist.contracts.js';
export function validateWatchlistVersion(
  host: TrackerWatchlistService,
  policy: WatchlistReconcilePolicy,
  context: WatchlistReconcileContext,
  head: { version: number } | null,
): number {
  const { input, clientId } = context;
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
    if (new Date() >= policy.requiredFrom) {
      throw new HttpException(
        {
          code: 'WATCHLIST_VERSION_REQUIRED',
          message:
            'Your app is out of date. Please reload the page before saving targeting changes.',
          currentVersion: current,
        },
        HttpStatus.PRECONDITION_REQUIRED,
      );
    }
    host['logger'].warn(
      `putWatchlist without expectedVersion (unversioned client, grace window until ` +
        `${policy.requiredFrom.toISOString()}) client=${clientId} version=${current}`,
    );
  }
  return current;
}
export function upsertWatchlistHead(
  tx: Prisma.TransactionClient,
  context: WatchlistReconcileContext,
  current: number,
) {
  const { wlId, tenantId, clientId, userId, issueAreas, jurisdictions } = context;
  // Step 4 — the head. Only ever the `wl:<clientId>` row; hearing flat terms
  // on OTHER watchlist rows (random cuid, old WatchlistsTab) live on a
  // different watchlistId and stay structurally untouched (proven by test).
  return tx.watchlist.upsert({
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
}
export function indexWatchlistTopics(existing: Array<{ id: string; label: string }>) {
  const byLabel = new Map<
    string,
    {
      id: string;
      label: string;
    }
  >();
  for (const t of existing) byLabel.set(t.label.toLowerCase(), { id: t.id, label: t.label });
  return byLabel;
}
export function indexWatchlistTerms(
  existingTerms: Array<{ topicId: string | null; termType: string; value: string; weight: number }>,
) {
  // `weight` is part of the key so flipping a topic's PRIORITY rewrites its
  // terms' weights (§4.9) rather than being skipped as an unchanged term set.
  const termKey = (t: { termType: string; value: string; weight: number }) =>
    JSON.stringify([t.termType, t.value, t.weight]);
  const termsByTopic = new Map<string, Set<string>>();
  let flatTermCount = 0;
  for (const t of existingTerms) {
    if (t.topicId === null) {
      flatTermCount += 1;
      continue;
    }
    const set = termsByTopic.get(t.topicId) ?? new Set<string>();
    set.add(termKey(t));
    termsByTopic.set(t.topicId, set);
  }
  return { termKey, termsByTopic, flatTermCount };
}
