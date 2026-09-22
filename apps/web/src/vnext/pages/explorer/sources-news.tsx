/**
 * Data Explorer vNext — News Feed (intel articles): the editorial list layout,
 * outlet logos (duckduckgo favicon with monogram fallback), relative
 * timestamps and the lead-article treatment. Verbatim behavioral port of the
 * canonical ArticlesExplorer/NewsFeed/NewsItem/SourceLogo.
 */
import { useEffect, useState, type CSSProperties } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import type {
  ExplorerIntelArticleRow,
  ExplorerResponse,
  IntelArticleFacets,
} from '../../../pages/explorer/explorerTypes.js';
import { XpFilterBar, XpMultiSelect } from './explorer-controls.js';
import { MonoTag, PlainTag, XpEmpty, XpPagination, XpSkeletonRows } from './explorer-table.js';
import { PAGE_SIZE, relativeTime, sourceBrand, type SourceBrand } from './explorer-format.js';
import { SaveToLegiWatchFolder } from './SaveToLegiWatchFolder.js';

export function ArticlesExplorer({ onRowClick }: { onRowClick: (id: string, row: ExplorerIntelArticleRow) => void }) {
  const api = useApi();
  const [q, setQ] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [sources, setSources] = useState<string[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [agencies, setAgencies] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [q, sources, topics, agencies]);

  const facets = useQuery<IntelArticleFacets>({
    queryKey: ['explorer-article-facets'],
    queryFn: async () => (await api.get<IntelArticleFacets>('/api/explorer/intel-article-facets')).data,
    staleTime: 10 * 60 * 1000,
  });
  const rowsQuery = useQuery<ExplorerResponse<ExplorerIntelArticleRow>>({
    queryKey: ['explorer-articles', q, sources, topics, agencies, page],
    queryFn: async () => (await api.get<ExplorerResponse<ExplorerIntelArticleRow>>('/api/explorer/intel-articles', {
      params: { q: q || undefined, sources: sources.length ? sources.join(',') : undefined, topics: topics.length ? topics.join(',') : undefined, agencies: agencies.length ? agencies.join(',') : undefined, page, pageSize: PAGE_SIZE },
    })).data,
    placeholderData: (p) => p,
  });

  return (
    <>
      <XpFilterBar
        searchPlaceholder="Search article title or summary…"
        searchInput={searchInput}
        onSearchInput={setSearchInput}
        onSearchSubmit={() => setQ(searchInput.trim())}
        onClearSearch={() => { setSearchInput(''); setQ(''); }}
        controls={
          <>
            <XpMultiSelect label="Source" placeholder="Any" options={(facets.data?.sources ?? []).map((s) => ({ value: s, label: s }))} values={sources} onChange={setSources} loading={facets.isLoading} />
            <XpMultiSelect label="Topic" placeholder="Any topic" options={(facets.data?.topics ?? []).map((t) => ({ value: t, label: t }))} values={topics} onChange={setTopics} loading={facets.isLoading} />
            <XpMultiSelect label="Agency" placeholder="Any agency" options={(facets.data?.agencies ?? []).map((a) => ({ value: a, label: a }))} values={agencies} onChange={setAgencies} loading={facets.isLoading} />
          </>
        }
      />
      <NewsFeed
        loading={rowsQuery.isLoading}
        rows={rowsQuery.data?.rows ?? []}
        total={rowsQuery.data?.total ?? 0}
        page={page}
        onPageChange={setPage}
        onArticleClick={onRowClick}
      />
    </>
  );
}

/* ── News feed (editorial layout for the Intel articles source) ─────────── */

function NewsFeed({
  loading,
  rows,
  total,
  page,
  onPageChange,
  onArticleClick,
}: {
  loading: boolean;
  rows: ExplorerIntelArticleRow[];
  total: number;
  page: number;
  onPageChange: (page: number) => void;
  onArticleClick: (id: string, row: ExplorerIntelArticleRow) => void;
}) {
  if (loading && rows.length === 0) {
    return (
      <div className="xp-news-feed">
        <div className="xp-news-feed__body">
          <XpSkeletonRows rows={8} />
        </div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="xp-news-feed xp-news-feed--empty">
        <XpEmpty description="No articles match these filters." />
      </div>
    );
  }

  return (
    <div className={`xp-news-feed${loading ? ' xp-news-feed--loading' : ''}`}>
      <div className="xp-table-meta">
        <span className="xp-table-count">
          <b>{total.toLocaleString()}</b> article{total === 1 ? '' : 's'} · showing{' '}
          {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)}
        </span>
      </div>
      <div className="xp-news-list">
        {rows.map((row, i) => (
          <NewsItem
            key={row.id}
            row={row}
            lead={page === 1 && i === 0}
            onClick={() => onArticleClick(row.id, row)}
          />
        ))}
      </div>
      {total > PAGE_SIZE ? (
        <div className="xp-pagination-row">
          <XpPagination page={page} total={total} onPageChange={onPageChange} />
        </div>
      ) : null}
    </div>
  );
}

function NewsItem({
  row,
  lead,
  onClick,
}: {
  row: ExplorerIntelArticleRow;
  lead: boolean;
  onClick: () => void;
}) {
  const brand = sourceBrand(row.source, row.url);
  const tags = [...new Set([...row.topics, ...row.agencies])];
  const maxTags = lead ? 6 : 4;
  return (
    <article
      className={`xp-news-item${lead ? ' xp-news-item--lead' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
    >
      <SourceLogo brand={brand} />
      <div className="xp-news-body">
        <div className="xp-news-meta">
          <span className="xp-news-source" style={{ color: brand.color }}>
            {brand.label}
          </span>
          <span className="xp-news-dot" aria-hidden>
            ·
          </span>
          <span className="xp-news-time xp-num">{relativeTime(row.publishedAt)}</span>
          {row.author ? (
            <>
              <span className="xp-news-dot" aria-hidden>
                ·
              </span>
              <span className="xp-news-author">{row.author}</span>
            </>
          ) : null}
        </div>
        <h3 className="xp-news-headline">{row.title}</h3>
        {row.summary ? <p className="xp-news-summary">{row.summary}</p> : null}
        {tags.length ? (
          <div className="xp-news-topics">
            {tags.slice(0, maxTags).map((t) => (
              <MonoTag key={t}>{t}</MonoTag>
            ))}
            {tags.length > maxTags ? <PlainTag>+{tags.length - maxTags}</PlainTag> : null}
          </div>
        ) : null}
      </div>
      <div className="xp-news-actions">
        <a
          className="xp-news-read"
          href={row.url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
        >
          Read <GlobeGlyph />
        </a>
        <SaveToLegiWatchFolder articleId={row.id} />
      </div>
    </article>
  );
}

function SourceLogo({ brand }: { brand: SourceBrand }) {
  const [imgOk, setImgOk] = useState(Boolean(brand.host));
  return (
    <span className="xp-news-logo" style={{ '--xp-brand': brand.color } as CSSProperties}>
      {brand.host && imgOk ? (
        <img
          src={`https://icons.duckduckgo.com/ip3/${brand.host}.ico`}
          alt=""
          loading="lazy"
          onError={() => setImgOk(false)}
        />
      ) : (
        <span className="xp-news-logo-mono">{brand.mono}</span>
      )}
    </span>
  );
}

/** Small globe mark on the "Read" external link (canonical: GlobalOutlined). */
function GlobeGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, verticalAlign: '-0.125em' }}
    >
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 3.75 5.6 3.75 9S14.5 18.4 12 21c-2.5-2.6-3.75-5.6-3.75-9S9.5 5.6 12 3Z" />
    </svg>
  );
}
