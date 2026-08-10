import { useEffect, useMemo, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Empty, Modal, Select, Skeleton, Tag } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';
import type { Client } from '../clients/clientTypes.js';

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
  lookback: NewsLookback;
}

interface NewsDashboardItem {
  id: string;
  title: string;
  source: string;
  url: string;
  imageUrl: string | null;
  publishedAt: string;
  clientMatches: Array<{ id: string; name: string }>;
  topics: string[];
  relevanceReason: string;
  duplicateCount: number | null;
}

interface NewsDashboardResponse {
  available: boolean;
  provider: 'newscatcher';
  items: NewsDashboardItem[];
  generatedAt: string;
  cached: boolean;
  stale?: boolean;
  reason?: 'not_configured' | 'no_clients' | 'provider_unavailable';
  monitoredClientCount: number;
  activeClientCount: number;
  coverageLimited: boolean;
}

const TOPIC_OPTIONS: Array<{ label: string; value: NewsPolicyTopic }> = [
  { label: 'Legislation', value: 'legislation' },
  { label: 'Hearings & markups', value: 'hearings' },
  { label: 'Regulation', value: 'regulation' },
  { label: 'Budget & appropriations', value: 'budget' },
  { label: 'Procurement & contracts', value: 'procurement' },
  { label: 'Grants & funding', value: 'grants' },
  { label: 'State policy', value: 'state' },
  { label: 'Executive actions', value: 'executive' },
];

const SIGNAL_OPTIONS: Array<{ label: string; value: NewsSignalKind }> = [
  { label: 'Client/company mentions', value: 'alias' },
  { label: 'Client capabilities', value: 'capability' },
  { label: 'Issues the client lobbies on', value: 'issue' },
  { label: 'Programs, PEs & appropriations', value: 'program' },
];

const DEFAULT_NEWS_PREFERENCES: NewsPreferences = {
  clientIds: [],
  policyTopics: TOPIC_OPTIONS.map((option) => option.value),
  signalKinds: ['capability', 'issue', 'program', 'alias'],
  customTopics: [],
  lookback: '48h',
};

const LOOKBACK_LABELS: Record<NewsLookback, string> = {
  '24h': 'Last 24h',
  '48h': 'Last 48h',
  '7d': 'Last 7 days',
};

/**
 * Customizable client-relevant news. Preferences are isolated by tenant + Clerk
 * user in localStorage, while the selected filters are sent to the API so they
 * alter provider retrieval and Capiro matching instead of merely hiding cards.
 */
export function DashboardNewsAndNarrative() {
  const api = useApi();
  const { user } = useUser();
  const me = useMe();
  const preferenceKey = useMemo(() => {
    if (!user?.id || !me.data?.tenant.id) return null;
    return `capiro:dashboard-news:${me.data.tenant.id}:${user.id}`;
  }, [me.data?.tenant.id, user?.id]);
  const [preferences, setPreferences] = useNewsPreferences(preferenceKey);

  const clients = useQuery<Client[]>({
    queryKey: ['clients'],
    queryFn: async () => (await api.get<Client[]>('/api/clients')).data,
    staleTime: 60_000,
  });

  const queryParams = useMemo(
    () => ({
      ...(preferences.clientIds.length ? { clients: preferences.clientIds.join(',') } : {}),
      topics: preferences.policyTopics.join(','),
      signals: preferences.signalKinds.join(','),
      ...(preferences.customTopics.length ? { custom: preferences.customTopics.join(',') } : {}),
      lookback: preferences.lookback,
    }),
    [preferences],
  );

  const news = useQuery<NewsDashboardResponse>({
    queryKey: ['dashboard-news-custom', queryParams],
    queryFn: async () =>
      (
        await api.get<NewsDashboardResponse>('/api/intelligence/news/dashboard', {
          params: queryParams,
        })
      ).data,
    staleTime: 15 * 60 * 1000,
    retry: false,
  });

  return (
    <NewsPanel
      data={news.data}
      loading={news.isLoading}
      isError={news.isError}
      clients={clients.data ?? []}
      preferences={preferences}
      onPreferencesChange={setPreferences}
    />
  );
}

function NewsPanel({
  data,
  loading,
  isError,
  clients,
  preferences,
  onPreferencesChange,
}: {
  data: NewsDashboardResponse | undefined;
  loading: boolean;
  isError: boolean;
  clients: Client[];
  preferences: NewsPreferences;
  onPreferencesChange: (next: NewsPreferences) => void;
}) {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draft, setDraft] = useState<NewsPreferences>(preferences);

  useEffect(() => {
    if (customizeOpen) setDraft(preferences);
  }, [customizeOpen, preferences]);

  const saveEnabled = draft.policyTopics.length > 0 && draft.signalKinds.length > 0;
  const clientSummary = preferences.clientIds.length
    ? `${preferences.clientIds.length} client${preferences.clientIds.length === 1 ? '' : 's'}`
    : 'All clients';
  const topicSummary =
    preferences.policyTopics.length === TOPIC_OPTIONS.length
      ? 'All policy'
      : `${preferences.policyTopics.length} topic${preferences.policyTopics.length === 1 ? '' : 's'}`;

  return (
    <div className="home-panel home-news-panel">
      <header className="home-panel-head">
        <span className="home-panel-title">News &amp; Narrative</span>
        <span className="open" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tag>{clientSummary}</Tag>
          <Tag>{topicSummary}</Tag>
          <Tag>{LOOKBACK_LABELS[preferences.lookback]}</Tag>
          <Button size="small" onClick={() => setCustomizeOpen(true)}>
            Customize
          </Button>
        </span>
      </header>

      {loading ? (
        <div className="home-panel-list">
          {[0, 1, 2, 3].map((i) => (
            <div className="home-panel-row" key={i}>
              <Skeleton active paragraph={{ rows: 1 }} title={false} />
            </div>
          ))}
        </div>
      ) : isError ? (
        <div className="home-news-status">News intelligence could not load right now.</div>
      ) : !data?.available ? (
        <div className="home-news-status">{newsUnavailableMessage(data?.reason)}</div>
      ) : data.items.length === 0 ? (
        <div className="home-panel-empty">
          <Empty
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description={`No matching client-relevant policy coverage found in ${LOOKBACK_LABELS[preferences.lookback].toLowerCase()}.`}
          />
        </div>
      ) : (
        <div className="home-panel-list home-news-list">
          {data.items.map((item) => (
            <a
              key={item.id}
              className="home-news-row"
              href={item.url}
              target="_blank"
              rel="noreferrer"
            >
              <span className="home-news-thumb" aria-hidden>
                <span className="home-news-thumb-fallback">{sourceInitials(item.source)}</span>
                {item.imageUrl ? (
                  <img
                    src={item.imageUrl}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    onError={(event) => {
                      event.currentTarget.style.display = 'none';
                    }}
                  />
                ) : null}
              </span>
              <div className="home-news-main">
                <span className="home-news-title">{item.title}</span>
                <span className="home-news-meta">
                  {item.source} · {relativeTime(item.publishedAt)}
                  {item.duplicateCount && item.duplicateCount > 1
                    ? ` · ${item.duplicateCount} similar placements`
                    : ''}
                </span>
                <span className="home-news-relevance">{item.relevanceReason}</span>
              </div>
              {item.topics[0] ? <Tag className="home-panel-tag">{item.topics[0]}</Tag> : null}
            </a>
          ))}
        </div>
      )}

      {data?.available ? (
        <div className="home-news-footnote">
          <span>
            NewsCatcher · {data.monitoredClientCount} client
            {data.monitoredClientCount === 1 ? '' : 's'} monitored
            {data.stale ? ' · cached fallback' : ''}
          </span>
          {data.coverageLimited ? (
            <span className="coverage-warning">· selected portfolio exceeds query envelope</span>
          ) : null}
        </div>
      ) : null}

      <Modal
        title="Customize News & Narrative"
        open={customizeOpen}
        onCancel={() => setCustomizeOpen(false)}
        onOk={() => {
          if (!saveEnabled) return;
          onPreferencesChange(draft);
          setCustomizeOpen(false);
        }}
        okText="Save feed"
        okButtonProps={{ disabled: !saveEnabled }}
        width={680}
      >
        <div style={{ display: 'grid', gap: 22, paddingTop: 8 }}>
          <PreferenceSection
            title="Clients"
            description="Leave this empty to monitor the full active portfolio."
          >
            <Select
              mode="multiple"
              allowClear
              showSearch
              optionFilterProp="label"
              style={{ width: '100%' }}
              placeholder="All clients"
              value={draft.clientIds}
              options={clients.map((client) => ({ label: client.name, value: client.id }))}
              onChange={(clientIds: string[]) => setDraft((current) => ({ ...current, clientIds }))}
            />
          </PreferenceSection>

          <PreferenceSection
            title="Policy coverage"
            description="Choose the government-affairs subjects that are allowed into the provider query."
          >
            <Checkbox.Group
              value={draft.policyTopics}
              onChange={(values) =>
                setDraft((current) => ({
                  ...current,
                  policyTopics: values as NewsPolicyTopic[],
                }))
              }
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px 16px' }}
            >
              {TOPIC_OPTIONS.map((option) => (
                <Checkbox key={option.value} value={option.value}>
                  {option.label}
                </Checkbox>
              ))}
            </Checkbox.Group>
          </PreferenceSection>

          <PreferenceSection
            title="Match news using"
            description="These controls decide which client intelligence signals qualify and retrieve stories."
          >
            <Checkbox.Group
              value={draft.signalKinds}
              onChange={(values) =>
                setDraft((current) => ({
                  ...current,
                  signalKinds: values as NewsSignalKind[],
                }))
              }
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '9px 16px' }}
            >
              {SIGNAL_OPTIONS.map((option) => (
                <Checkbox key={option.value} value={option.value}>
                  {option.label}
                </Checkbox>
              ))}
            </Checkbox.Group>
          </PreferenceSection>

          <PreferenceSection
            title="Custom topics"
            description="Add specific priorities such as Golden Dome, Counter-UAS, AI export controls, or shipbuilding."
          >
            <Select
              mode="tags"
              tokenSeparators={[',']}
              style={{ width: '100%' }}
              placeholder="Type a topic and press Enter"
              value={draft.customTopics}
              onChange={(customTopics: string[]) =>
                setDraft((current) => ({
                  ...current,
                  customTopics: customTopics.map((topic) => topic.trim()).filter(Boolean).slice(0, 20),
                }))
              }
              options={[]}
            />
          </PreferenceSection>

          <PreferenceSection title="Time window" description="Control how far back NewsCatcher searches.">
            <Select
              style={{ width: 180 }}
              value={draft.lookback}
              options={Object.entries(LOOKBACK_LABELS).map(([value, label]) => ({ value, label }))}
              onChange={(lookback: NewsLookback) => setDraft((current) => ({ ...current, lookback }))}
            />
          </PreferenceSection>

          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              paddingTop: 4,
              borderTop: '1px solid var(--border-1)',
            }}
          >
            <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>
              Preferences are saved for this user and tenant in this browser.
            </span>
            <Button onClick={() => setDraft(DEFAULT_NEWS_PREFERENCES)}>Reset defaults</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function PreferenceSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div style={{ fontSize: 13, fontWeight: 650, color: 'var(--ink-1)', marginBottom: 3 }}>
        {title}
      </div>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--ink-3)', marginBottom: 10 }}>
        {description}
      </div>
      {children}
    </section>
  );
}

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

function validSubset<T extends string>(value: unknown, allowed: T[]): T[] {
  if (!Array.isArray(value)) return [...allowed];
  const allowedSet = new Set<string>(allowed);
  const next = value.filter((item): item is T => typeof item === 'string' && allowedSet.has(item));
  return next.length ? next : [...allowed];
}

function sourceInitials(source: string): string {
  const parts = source
    .replace(/\.[a-z]{2,}$/i, '')
    .split(/[\s._-]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  const initials = parts
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase();
  return initials || 'N';
}

function newsUnavailableMessage(reason: NewsDashboardResponse['reason']): string {
  switch (reason) {
    case 'not_configured':
      return 'News intelligence is ready to activate once NEWSCATCHER_API_KEY is configured.';
    case 'no_clients':
      return 'No selected clients have enough news-matching signal yet. Adjust the feed or client profile.';
    case 'provider_unavailable':
      return 'NewsCatcher is unavailable right now. The rest of your dashboard is unaffected.';
    default:
      return 'News intelligence is not available right now.';
  }
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
