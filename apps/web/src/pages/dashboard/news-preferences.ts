import { useEffect, useState } from 'react';

/**
 * News-preferences model — types, option catalogs, defaults, and the
 * localStorage-backed `useNewsPreferences` hook, extracted out of the
 * antd-heavy `DashboardNewsAndNarrative.tsx` so runtime consumers on the
 * vNext surface (`vnext/adapters/legacy/useDashboardVNextModel.ts`) never
 * pull antd into their module graph. `DashboardNewsAndNarrative` re-exports
 * everything here, so canonical import paths are unchanged. UI-free by
 * contract: keep components and antd imports out of this module.
 */

export type NewsPolicyTopic =
  | 'legislation'
  | 'hearings'
  | 'regulation'
  | 'budget'
  | 'procurement'
  | 'grants'
  | 'state'
  | 'executive';
export type NewsSignalKind = 'capability' | 'issue' | 'program' | 'alias';
export type NewsLookback = '24h' | '48h' | '7d';

export interface NewsPreferences {
  clientIds: string[];
  policyTopics: NewsPolicyTopic[];
  signalKinds: NewsSignalKind[];
  customTopics: string[];
  articleTopics: string[];
  sources: string[];
  agencies: string[];
  lookback: NewsLookback;
}

export const TOPIC_OPTIONS: Array<{ label: string; value: NewsPolicyTopic }> = [
  { label: 'Legislation', value: 'legislation' },
  { label: 'Hearings & markups', value: 'hearings' },
  { label: 'Regulation', value: 'regulation' },
  { label: 'Budget & appropriations', value: 'budget' },
  { label: 'Procurement & contracts', value: 'procurement' },
  { label: 'Grants & funding', value: 'grants' },
  { label: 'State policy', value: 'state' },
  { label: 'Executive actions', value: 'executive' },
];

export const SIGNAL_OPTIONS: Array<{ label: string; value: NewsSignalKind }> = [
  { label: 'Client/company mentions', value: 'alias' },
  { label: 'Client capabilities', value: 'capability' },
  { label: 'Issues the client lobbies on', value: 'issue' },
  { label: 'Programs, PEs & appropriations', value: 'program' },
];

export const DEFAULT_NEWS_PREFERENCES: NewsPreferences = {
  clientIds: [],
  policyTopics: TOPIC_OPTIONS.map((option) => option.value),
  signalKinds: ['capability', 'issue', 'program', 'alias'],
  customTopics: [],
  articleTopics: [],
  sources: [],
  agencies: [],
  lookback: '48h',
};

export const LOOKBACK_LABELS: Record<NewsLookback, string> = {
  '24h': 'Last 24h',
  '48h': 'Last 48h',
  '7d': 'Last 7 days',
};

export function useNewsPreferences(
  key: string | null,
): [NewsPreferences, (next: NewsPreferences) => void] {
  const [preferences, setPreferencesState] = useState<NewsPreferences>(DEFAULT_NEWS_PREFERENCES);

  useEffect(() => {
    if (!key || typeof window === 'undefined') return;
    try {
      const raw = window.localStorage.getItem(key);
      if (!raw) {
        setPreferencesState(DEFAULT_NEWS_PREFERENCES);
        return;
      }
      const parsed = JSON.parse(raw) as Partial<NewsPreferences>;
      setPreferencesState({
        clientIds: Array.isArray(parsed.clientIds)
          ? parsed.clientIds.filter((value): value is string => typeof value === 'string')
          : [],
        policyTopics: validSubset(parsed.policyTopics, TOPIC_OPTIONS.map((option) => option.value)),
        signalKinds: validSubset(
          parsed.signalKinds,
          SIGNAL_OPTIONS.map((option) => option.value),
        ),
        customTopics: Array.isArray(parsed.customTopics)
          ? parsed.customTopics
              .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
              .slice(0, 20)
          : [],
        articleTopics: stringArray(parsed.articleTopics, 30),
        sources: stringArray(parsed.sources, 30),
        agencies: stringArray(parsed.agencies, 30),
        lookback:
          parsed.lookback === '24h' || parsed.lookback === '7d' || parsed.lookback === '48h'
            ? parsed.lookback
            : '48h',
      });
    } catch {
      setPreferencesState(DEFAULT_NEWS_PREFERENCES);
    }
  }, [key]);

  const persist = (next: NewsPreferences) => {
    setPreferencesState(next);
    if (!key || typeof window === 'undefined') return;
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Preference persistence is non-critical; the current-session state still works.
    }
  };

  return [preferences, persist];
}

function stringArray(value: unknown, max: number): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0).map((item) => item.trim()).slice(0, max))]
    : [];
}

export function validSubset<T extends string>(value: unknown, allowed: T[]): T[] {
  if (!Array.isArray(value)) return [...allowed];
  const allowedSet = new Set<string>(allowed);
  const next = value.filter((item): item is T => typeof item === 'string' && allowedSet.has(item));
  return next.length ? next : [...allowed];
}
