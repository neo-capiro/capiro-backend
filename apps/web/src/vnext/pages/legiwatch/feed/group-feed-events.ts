import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';

/** Collapse the same bill observation across clients, retaining every alert. */
export function groupFeedEvents(items: FeedItem[]): FeedItem[][] {
  const groups = new Map<string, FeedItem[]>();
  for (const item of items) {
    const bill = item.evidence?.bill;
    const extra = item.evidence?.extra;
    const key = bill?.billId && ['bill', 'state_bill'].includes(item.sourceType)
      ? JSON.stringify([item.sourceType, bill.billId, item.kind, bill.actionText,
          bill.actionDate || item.createdAt.slice(0, 10), extra?.contentHash,
          extra?.textHash, extra?.textDate, extra?.version])
      : item.id;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return [...groups.values()];
}
