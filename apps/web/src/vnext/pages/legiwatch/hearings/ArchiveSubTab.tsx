/**
 * LegiWatch V2 Wave 1 (W1-3) — the Archive.
 *
 * `/legiwatch?tab=hearings&sub=archive`. Searches the durable historical
 * corpus: hearing identity (title, committee, location, witness names), the
 * canonical machine transcript, the official published transcript, and public
 * intelligence findings.
 *
 * The corpus is NOT loaded into the browser and filtered locally — matching,
 * faceting, ordering and paging all happen in Postgres. The input is debounced
 * so typing does not fire a query per keystroke, and react-query keys each
 * request by its params so a slow response for an older query cannot overwrite
 * a newer one.
 *
 * Every result navigates to the ONE canonical destination,
 * `/legiwatch/hearings/:id`; a transcript hit carries its segment and timecode
 * so the detail route can jump straight to it.
 */
import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { LwButton, LwPill, LwSkeleton } from '../lib/primitives.js';
import { LwStateUnavailable } from '../states/SystemStates.js';
import { useArchiveSearch, w1Error, type ArchiveResult } from '../lib/wave1-api.js';

const PAGE_SIZE = 20;

const INTELLIGENCE_TYPES = [
  'QUESTION',
  'COMMITMENT',
  'DEADLINE',
  'FUNDING_AMOUNT',
  'BILL_REFERENCE',
  'PROGRAM_ELEMENT_REFERENCE',
  'AGENCY_REFERENCE',
  'POLICY_POSITION',
  'KEY_QUOTE',
];

/** Whether any filter beyond the free-text query is set. */
function hasActiveFilters(f: Record<string, string | undefined>): boolean {
  return Object.entries(f).some(([key, value]) => key !== 'q' && Boolean(value));
}

export function ArchiveSubTab({ clientId }: { clientId: string }) {
  const navigate = useNavigate();
  const [rawQuery, setRawQuery] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [filters, setFilters] = useState<{
    chamber?: string;
    committee?: string;
    from?: string;
    to?: string;
    eventStatus?: string;
    hasTranscript?: string;
    intelligenceType?: string;
    relevanceBand?: string;
  }>({});

  // Debounce the text input. Without this, every keystroke is a full-text query
  // over the whole corpus.
  useEffect(() => {
    const t = window.setTimeout(() => {
      setQuery(rawQuery.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [rawQuery]);

  const params = useMemo(
    () => ({
      q: query || undefined,
      chamber: filters.chamber,
      committee: filters.committee,
      from: filters.from,
      to: filters.to,
      eventStatus: filters.eventStatus,
      hasTranscript:
        filters.hasTranscript === undefined ? undefined : filters.hasTranscript === 'true',
      intelligenceType: filters.intelligenceType,
      clientId: clientId || undefined,
      relevanceBand: clientId ? filters.relevanceBand : undefined,
      page,
      pageSize: PAGE_SIZE,
    }),
    [query, filters, clientId, page],
  );

  const search = useArchiveSearch(params);
  const setFilter = (key: keyof typeof filters, value: string) => {
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
    setPage(1);
  };

  const rows = search.data?.rows ?? [];
  const filtersActive = hasActiveFilters({ ...filters, q: query });

  return (
    <div className="lw-archive">
      <div className="lw-search" style={{ marginBottom: 12 }}>
        <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>
          ⌕
        </span>
        <input
          type="search"
          aria-label="Search the hearing archive"
          placeholder="Search titles, committees, witnesses, transcripts and findings"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.target.value)}
        />
      </div>

      <div
        role="group"
        aria-label="Archive filters"
        style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 14 }}
      >
        <label>
          <span className="lw-eyebrow">Chamber</span>
          <select
            aria-label="Chamber"
            value={filters.chamber ?? ''}
            onChange={(e) => setFilter('chamber', e.target.value)}
          >
            <option value="">All</option>
            <option value="House">House</option>
            <option value="Senate">Senate</option>
            <option value="Joint">Joint</option>
          </select>
        </label>
        <label>
          <span className="lw-eyebrow">Committee</span>
          <select
            aria-label="Committee"
            value={filters.committee ?? ''}
            onChange={(e) => setFilter('committee', e.target.value)}
          >
            <option value="">All</option>
            {(search.data?.facets.committee ?? []).map((f) => (
              <option key={f.value} value={f.value}>
                {f.label} ({f.count})
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="lw-eyebrow">From</span>
          <input
            type="date"
            aria-label="From date"
            value={filters.from ?? ''}
            onChange={(e) => setFilter('from', e.target.value)}
          />
        </label>
        <label>
          <span className="lw-eyebrow">To</span>
          <input
            type="date"
            aria-label="To date"
            value={filters.to ?? ''}
            onChange={(e) => setFilter('to', e.target.value)}
          />
        </label>
        <label>
          <span className="lw-eyebrow">Status</span>
          <select
            aria-label="Hearing status"
            value={filters.eventStatus ?? ''}
            onChange={(e) => setFilter('eventStatus', e.target.value)}
          >
            <option value="">All</option>
            <option value="completed">Completed</option>
            <option value="canceled">Canceled</option>
          </select>
        </label>
        <label>
          <span className="lw-eyebrow">Transcript</span>
          <select
            aria-label="Transcript availability"
            value={filters.hasTranscript ?? ''}
            onChange={(e) => setFilter('hasTranscript', e.target.value)}
          >
            <option value="">Any</option>
            <option value="true">Available</option>
            <option value="false">Not available</option>
          </select>
        </label>
        <label>
          <span className="lw-eyebrow">Intelligence</span>
          <select
            aria-label="Intelligence type"
            value={filters.intelligenceType ?? ''}
            onChange={(e) => setFilter('intelligenceType', e.target.value)}
          >
            <option value="">Any</option>
            {INTELLIGENCE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t.replace(/_/g, ' ').toLowerCase()}
              </option>
            ))}
          </select>
        </label>
        {clientId ? (
          <label>
            <span className="lw-eyebrow">Client relevance</span>
            <select
              aria-label="Client relevance band"
              value={filters.relevanceBand ?? ''}
              onChange={(e) => setFilter('relevanceBand', e.target.value)}
            >
              <option value="">Any</option>
              <option value="HIGH">High</option>
              <option value="MEDIUM">Medium and above</option>
              <option value="LOW">Low and above</option>
            </select>
          </label>
        ) : null}
      </div>

      {search.isLoading ? (
        <>
          <LwSkeleton height={72} />
          <div style={{ height: 10 }} />
          <LwSkeleton height={72} delay={2} />
          <div style={{ height: 10 }} />
          <LwSkeleton height={72} delay={3} />
        </>
      ) : search.isError ? (
        <LwStateUnavailable
          source="Hearing archive"
          reason={`Archive search is unavailable. ${w1Error(search.error)}`}
          onRetry={() => void search.refetch()}
        />
      ) : rows.length === 0 ? (
        // Two distinct empty states: nothing in the corpus, versus nothing
        // matching the current filters.
        <div className="lw-card" style={{ padding: 18 }}>
          {filtersActive ? (
            <>
              <p style={{ margin: 0, fontSize: 14 }}>
                No archived proceedings match these filters.
              </p>
              <div style={{ marginTop: 10 }}>
                <LwButton
                  onClick={() => {
                    setFilters({});
                    setRawQuery('');
                    setPage(1);
                  }}
                >
                  Clear filters
                </LwButton>
              </div>
            </>
          ) : (
            <p style={{ margin: 0, fontSize: 14 }}>
              The archive has no completed proceedings yet. Hearings appear here once they have
              taken place.
            </p>
          )}
        </div>
      ) : (
        <>
          <p className="lw-card__meta" style={{ marginTop: 0 }}>
            {search.data!.total} archived proceeding
            {search.data!.total === 1 ? '' : 's'}
            {/* Nothing matched every word, so these are any-term hits. Saying so
                is the difference between a search result and a misleading one. */}
            {search.data!.matchMode === 'partial' ? ' · partial matches only' : ''}
            {search.isFetching ? ' · updating…' : ''}
          </p>
          <ol
            style={{
              listStyle: 'none',
              margin: 0,
              padding: 0,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
            }}
          >
            {rows.map((row) => (
              <li key={row.id}>
                <ArchiveResultCard
                  row={row}
                  onOpen={(hash) => navigate(`${row.detailPath}${hash}`)}
                />
              </li>
            ))}
          </ol>

          <nav
            aria-label="Archive pagination"
            style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 14 }}
          >
            <LwButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
              ← Previous
            </LwButton>
            <span className="lw-card__meta">
              Page {page} of {Math.max(1, Math.ceil(search.data!.total / PAGE_SIZE))}
            </span>
            <LwButton
              onClick={() => setPage((p) => p + 1)}
              disabled={!search.data!.hasMore}
            >
              Next →
            </LwButton>
          </nav>
        </>
      )}
    </div>
  );
}

function ArchiveResultCard({
  row,
  onOpen,
}: {
  row: ArchiveResult;
  onOpen: (hash: string) => void;
}) {
  // A transcript hit deep-links to the supporting segment so the detail route
  // can scroll to and highlight it.
  const hash = row.transcriptHit ? `#seg-${row.transcriptHit.segmentId}` : '';

  return (
    <article className="lw-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <LwPill tone="gray" size="22">
          {row.chamber}
        </LwPill>
        <LwPill tone="gray" size="22">
          {row.eventStatus.toUpperCase()}
        </LwPill>
        {row.transcript.available ? (
          <LwPill tone="brand" size="22">
            Transcript
          </LwPill>
        ) : null}
        {row.intelligenceCount > 0 ? (
          <LwPill tone="brand" size="22">
            {row.intelligenceCount} findings
          </LwPill>
        ) : null}
      </div>

      <h3 style={{ margin: '8px 0 2px', fontSize: 15, lineHeight: 1.3 }}>
        <button
          type="button"
          className="lw-backlink"
          style={{ padding: 0, textAlign: 'left', font: 'inherit' }}
          onClick={() => onOpen(hash)}
        >
          {row.title}
        </button>
      </h3>

      <div className="lw-card__meta" style={{ fontSize: 12 }}>
        {row.committeeName ?? '—'}
        {row.calendarDate ? ` · ${row.calendarDate}` : ''}
        {/* An unknown time stays unknown; no fabricated clock. */}
        {row.scheduledStart ? '' : ' · time not announced'}
      </div>

      {row.transcriptHit ? (
        <button
          type="button"
          className="lw-backlink"
          style={{ display: 'block', textAlign: 'left', padding: 0, marginTop: 8 }}
          onClick={() => onOpen(hash)}
          aria-label="Open this hearing at the matching transcript moment"
        >
          <span
            className="lw-mono"
            style={{ fontSize: 11 }}
            // The snippet is server-generated ts_headline markup whose only tag
            // is <mark>; rendering it as text would show the tags literally.
            dangerouslySetInnerHTML={{ __html: sanitizeHeadline(row.transcriptHit.snippet) }}
          />
        </button>
      ) : null}

      {row.intelligenceHit ? (
        <p className="lw-card__meta" style={{ margin: '6px 0 0', fontSize: 12 }}>
          Finding: {row.intelligenceHit.title} ({row.intelligenceHit.insightType})
        </p>
      ) : null}

      {!row.transcript.available ? (
        <p className="lw-card__meta" style={{ margin: '6px 0 0', fontSize: 12 }}>
          No transcript is available for this proceeding.
        </p>
      ) : null}
    </article>
  );
}

/**
 * Allow ONLY the `<mark>` tags ts_headline emits and escape everything else.
 *
 * The snippet is transcript text, which is public-record content Capiro did not
 * author, so it is never trusted as markup. Escaping first and re-introducing
 * only the two known tags is what makes this safe.
 */
export function sanitizeHeadline(snippet: string): string {
  const escaped = snippet
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
  return escaped.replace(/&lt;mark&gt;/g, '<mark>').replace(/&lt;\/mark&gt;/g, '</mark>');
}
