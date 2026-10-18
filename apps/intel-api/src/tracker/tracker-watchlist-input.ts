import { isAcceptableTerm, termRejectionReason } from '../watchlist/term-validation.js';
import type {
  TrackerTopicInput,
  IncomingTopic,
  RejectedTopics,
  RejectedTerms,
  PutWatchlistInput,
  WatchlistReconcileContext,
} from './tracker-watchlist.contracts.js';
export function normalizeIncomingTopics(
  rawTopics: TrackerTopicInput[],
  rejectedTopics: RejectedTopics,
  rejectedTerms: RejectedTerms,
): IncomingTopic[] {
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
    const terms: Array<{
      termType: string;
      value: string;
    }> = [];
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
  return incoming;
}
export function normalizeWatchlistInput(
  tenantId: string,
  clientId: string,
  userId: string,
  input: PutWatchlistInput,
): WatchlistReconcileContext {
  const wlId = `wl:${clientId}`;
  const issueAreas = Array.isArray(input.issueAreas) ? input.issueAreas : [];
  const jurisdictions = Array.isArray(input.jurisdictions)
    ? input.jurisdictions.map((j) => j.toUpperCase())
    : [];
  const rawTopics = Array.isArray(input.topics) ? input.topics : [];
  // P0-03/P0-05: everything the server refuses, reported back to the editor
  // instead of vanishing silently.
  const rejectedTopics: Array<{
    index: number;
    label: string;
    reason: string;
  }> = [];
  const rejectedTerms: Array<{
    topicLabel: string;
    termType: string;
    value: string;
    reason: string;
  }> = [];
  const incoming = normalizeIncomingTopics(rawTopics, rejectedTopics, rejectedTerms);
  return {
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
  };
}
