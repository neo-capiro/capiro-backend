// "Last contacted Nd ago" badge data (plan W5.2). The backend already computes the
// prior-outreach dedup for the generation prompt; this surfaces the SAME 90-day
// lookup to the Recipients step so the human — the real dedup layer — sees a
// recipient was recently emailed BEFORE generating. Absent = no prior contact
// (never fabricated). Pure helpers (candidateEmails/formatLastContacted) are
// unit-tested; usePriorContact wraps them with a react-query fetch.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { AxiosInstance } from 'axios';
import type { OutreachTarget } from './targets.js';

export interface PriorContact {
  sentAt: string;
  subject: string | null;
}

/** Every unique, lowercased email across all targets (individual + list + group
 *  members) — the same email pool the backend batches per generation. */
export function candidateEmails(targets: OutreachTarget[]): string[] {
  const set = new Set<string>();
  for (const t of targets) {
    for (const r of t.recipients) {
      const e = r.email?.trim().toLowerCase();
      if (e) set.add(e);
    }
  }
  return Array.from(set);
}

/** Hand-rolled relative "Xd ago" (no dayjs), matching the intelligence-v1 pattern.
 *  Same-day reads oddly as "0d ago", so special-case "today". */
export function formatLastContacted(sentAtIso: string, now: Date = new Date()): string {
  const days = Math.max(
    0,
    Math.floor((now.getTime() - new Date(sentAtIso).getTime()) / 86_400_000),
  );
  return days === 0 ? 'last contacted today' : `last contacted ${days}d ago`;
}

/** Fetch prior-contact for a set of candidate emails, keyed for O(1) row lookup.
 *  clientId scopes the lookup to the campaign's client when present. */
export function usePriorContact(
  api: AxiosInstance,
  emails: string[],
  clientId: string | null,
): { byEmail: Map<string, PriorContact>; isLoading: boolean } {
  const sortedKey = useMemo(() => [...emails].sort().join(','), [emails]);
  const query = useQuery<Array<{ email: string; sentAt: string; subject: string | null }>>({
    queryKey: ['outreach-prior-contact', clientId, sortedKey],
    queryFn: async () =>
      (
        await api.post('/api/engagement/outreach/prior-contact', {
          clientId: clientId ?? undefined,
          emails,
        })
      ).data,
    enabled: emails.length > 0,
    staleTime: 60_000,
  });
  const byEmail = useMemo(() => {
    const m = new Map<string, PriorContact>();
    for (const row of query.data ?? [])
      m.set(row.email, { sentAt: row.sentAt, subject: row.subject });
    return m;
  }, [query.data]);
  return { byEmail, isLoading: query.isLoading };
}
