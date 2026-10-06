import type { FeedItem } from '../../../../pages/clients/tracker/intel-feed-api.js';

export function feedStatusText(item: FeedItem): string | null {
  if (item.currentBillStatus) return `Current status: ${item.currentBillStatus.label}`;
  const stage = item.evidence?.bill?.stage;
  if (!stage) return null;
  const day = /^\d{4}-\d{2}-\d{2}/.exec(item.createdAt)?.[0];
  return `Recorded with alert${day ? ` on ${day}` : ''}: ${stage.replaceAll('_', ' ')}`;
}

export function feedExplanation(item: FeedItem): string | null {
  const bill = item.evidence?.bill;
  // This exact legacy linker template embeds a cached bill stage in its explanation.
  // Present the reference event without reasserting that stage as a current fact.
  if (item.sourceType === 'combined' && bill && item.whyItMatters) {
    const prefix = `${bill.displayNum} (${bill.stage}) — a bill you track — was referenced in `;
    if (item.whyItMatters.startsWith(prefix))
      return `${bill.displayNum} — a bill you track — was referenced in ${item.whyItMatters.slice(prefix.length)}`;
  }
  return item.whyItMatters;
}

export function feedSourceCount(counts: Partial<Record<string, number>>, source: string) {
  if (source === 'hearing') return (counts.hearing ?? 0) + (counts.combined ?? 0);
  return counts[source] ?? null;
}
