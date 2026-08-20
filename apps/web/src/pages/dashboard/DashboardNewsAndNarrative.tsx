import { useEffect, useMemo, useState } from 'react';
import { useUser } from '@clerk/clerk-react';
import { useQuery } from '@tanstack/react-query';
import { Button, Checkbox, Empty, Modal, Select, Skeleton, Tag } from 'antd';
import { useApi } from '../../lib/use-api.js';
import { useMe } from '../../lib/me.js';

import {
  DEFAULT_NEWS_PREFERENCES,
  LOOKBACK_LABELS,
  useNewsPreferences,
  type NewsLookback,
  type NewsPreferences,
} from './news-preferences.js';

// The preferences model (types, option catalogs, defaults, and the
// localStorage-backed useNewsPreferences hook) moved to the UI-free
// `news-preferences.ts`, shared with the vNext dashboard adapter. Re-exported
// here so this module's public surface is unchanged.
export {
  useNewsPreferences,
  DEFAULT_NEWS_PREFERENCES,
  LOOKBACK_LABELS,
  type NewsLookback,
  type NewsPreferences,
} from './news-preferences.js';

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
  provider?: 'newscatcher' | 'intel-article';
  items: NewsDashboardItem[];
  generatedAt: string;
  cached: boolean;
  stale?: boolean;
  reason?: 'not_configured' | 'no_clients' | 'provider_unavailable' | 'no_articles';
  monitoredClientCount?: number;
  activeClientCount?: number;
  coverageLimited?: boolean;
}

interface NewsFacets {
  sources: string[];
  topics: string[];
  agencies: string[];
}

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

  const facets = useQuery<NewsFacets>({
    queryKey: ['explorer-article-facets'],
    queryFn: async () => (await api.get<NewsFacets>('/api/explorer/intel-article-facets')).data,
    staleTime: 10 * 60 * 1000,
  });

  const queryParams = useMemo(
    () => ({
      corpus: 'explorer',
      q: preferences.customTopics.join(','),
      sources: preferences.sources.join(','),
      topics: preferences.articleTopics.join(','),
      agencies: preferences.agencies.join(','),
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
      facets={facets.data ?? { sources: [], topics: [], agencies: [] }}
      preferences={preferences}
      onPreferencesChange={setPreferences}
    />
  );
}

function NewsPanel({
  data,
  loading,
  isError,
  facets,
  preferences,
  onPreferencesChange,
}: {
  data: NewsDashboardResponse | undefined;
  loading: boolean;
  isError: boolean;
  facets: NewsFacets;
  preferences: NewsPreferences;
  onPreferencesChange: (next: NewsPreferences) => void;
}) {
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [draft, setDraft] = useState<NewsPreferences>(preferences);

  useEffect(() => {
    if (customizeOpen) setDraft(preferences);
  }, [customizeOpen, preferences]);

  const saveEnabled = true;
  const topicSummary = preferences.articleTopics.length
    ? `${preferences.articleTopics.length} article topic${preferences.articleTopics.length === 1 ? '' : 's'}`
    : 'All article topics';

  return (
    <div className="home-panel home-news-panel">
      <header className="home-panel-head">
        <span className="home-panel-title">News &amp; Narrative</span>
        <span className="open" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <Tag>Data Explorer corpus</Tag>
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
            {data.provider === 'intel-article' ? 'Data Explorer news' : 'NewsCatcher'} · {data.provider === 'intel-article' ? 'shared corpus' : `${data.monitoredClientCount ?? 0} clients monitored`}
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
            title="News sources"
            description="Use the same source facets as Data Explorer. Publication names are interpreted semantically."
          >
            <Select mode="multiple" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="All sources" value={draft.sources} options={facets.sources.map((source) => ({ label: source, value: source }))} onChange={(sources: string[]) => setDraft((current) => ({ ...current, sources }))} />
          </PreferenceSection>

          <PreferenceSection
            title="Article topics"
            description="Use the same Data Explorer topic facets; related wording is included rather than exact tags only."
          >
            <Select mode="multiple" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="All article topics" value={draft.articleTopics} options={facets.topics.map((topic) => ({ label: topic, value: topic }))} onChange={(articleTopics: string[]) => setDraft((current) => ({ ...current, articleTopics }))} />
          </PreferenceSection>

          <PreferenceSection
            title="Agencies"
            description="Use the same agency facets as Data Explorer; synonyms and casing are normalized."
          >
            <Select mode="multiple" allowClear showSearch optionFilterProp="label" style={{ width: '100%' }} placeholder="All agencies" value={draft.agencies} options={facets.agencies.map((agency) => ({ label: agency, value: agency }))} onChange={(agencies: string[]) => setDraft((current) => ({ ...current, agencies }))} />
          </PreferenceSection>

          <PreferenceSection
            title="Keywords"
            description="Add concepts such as counter-UAS, AI export controls, or shipbuilding. Related wording is included automatically."
          >
            <Select mode="tags" tokenSeparators={[',']} style={{ width: '100%' }} placeholder="Type a keyword and press Enter" value={draft.customTopics} onChange={(customTopics: string[]) => setDraft((current) => ({ ...current, customTopics: customTopics.map((topic) => topic.trim()).filter(Boolean).slice(0, 20) }))} options={[]} />
          </PreferenceSection>

          <PreferenceSection title="Time window" description="Control how far back the shared Data Explorer news corpus is searched.">
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
    case 'no_articles':
      return 'No existing Data Explorer articles match the current semantic filters.';
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
