/** Search the existing hearing archive, committee directory and retained bill research. */
import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router-dom';
import { useApiScope } from '../../../../lib/use-api-scope.js';
import { useIntelFeatureEnabled } from '../../../../lib/intel-feature-flags.js';
import { useApi } from '../../../../lib/use-api.js';
import { LwModal } from './LwModal.js';
import { LwSkeleton } from '../lib/primitives.js';
import { useArchiveSearch } from '../lib/wave1-api.js';
import type { FolderPage } from '../bills/folder-api.js';
import { useFolderTrackerFlag } from '../bills/folder-api.js';

interface CommitteeRow {
  systemCode: string;
  name: string;
  chamber: string;
  isSubcommittee: boolean;
}

interface BillSearchResult {
  items: Array<{
    id: string;
    billId: string;
    billIdentifier?: string;
    billTitle?: string;
    title?: string;
    excerpt?: { quote: string };
  }>;
  coverage?: { complete: boolean; reason: string };
  cursor?: string | null;
}

interface CorpusBill {
  id: string;
  number: string;
  title: string;
  jurisdiction: string;
  sessionKey: string;
}

export function LegiWatchSearchOverlay({
  onClose,
  onOpenHearing,
  onOpenCommittee,
}: {
  onClose: () => void;
  onOpenHearing: (id: string) => void;
  onOpenCommittee: (systemCode: string) => void;
}) {
  const api = useApi();
  const scope = useApiScope();
  const researchEnabled = useIntelFeatureEnabled('legiwatch_research_v1');
  const folderTracker = useFolderTrackerFlag();
  const [params] = useSearchParams();
  const billScope = {
    clientId: params.get('client') || null,
    folderId: params.get('folder') || null,
    jurisdiction: params.get('jurisdiction') || '',
    sessionKey: params.get('session') || '',
  };
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');
  const [billSearchMode, setBillSearchMode] = useState<'information' | 'documents'>('information');
  const [textJurisdiction, setTextJurisdiction] = useState(billScope.jurisdiction);
  const [textSession, setTextSession] = useState(billScope.sessionKey);

  useEffect(() => {
    const t = window.setTimeout(() => setQ(raw.trim()), 250);
    return () => window.clearTimeout(t);
  }, [raw]);

  const hearings = useArchiveSearch({ q, page: 1, pageSize: 6 }, q.length >= 2);

  const committees = useQuery<{ rows: CommitteeRow[] }>({
    queryKey: ['lw-vnext', 'search-committees', scope],
    queryFn: async () =>
      (await api.get<{ rows: CommitteeRow[] }>('/api/legiwatch/live-hearings/committees')).data,
    staleTime: 5 * 60_000,
  });
  const hasBillScope = Boolean(textJurisdiction && textSession);
  const billSearchAvailable = billSearchMode === 'information' || researchEnabled;
  const bills = useInfiniteQuery<BillSearchResult | FolderPage<CorpusBill>>({
    queryKey: ['lw-vnext', 'search-bills', scope, billScope, billSearchMode, q, textJurisdiction, textSession],
    enabled: billSearchAvailable && q.length >= 2 && (billSearchMode === 'information' || hasBillScope),
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      if (billSearchMode === 'information') {
        return (
          await api.get<FolderPage<CorpusBill>>('/intel-api/legiwatch/bills/search', {
            params: { q, limit: 6, ...(pageParam ? { cursor: pageParam } : {}) },
          })
        ).data;
      }
      return (
        await api.post<BillSearchResult>('/intel-api/legiwatch/research/search', {
          clientId: billScope.clientId,
          folderId: billScope.folderId,
          jurisdiction: textJurisdiction,
          sessionKey: textSession,
          query: q,
          kind: 'all',
          versionPolicy: 'current_extractions',
          cursor: pageParam,
        })
      ).data;
    },
    getNextPageParam: (page) => ('nextCursor' in page ? page.nextCursor ?? undefined : page.cursor ?? undefined),
    retry: false,
  });
  const billPages = billSearchAvailable ? (bills.data?.pages ?? []) : [];
  const hasMoreBillDocuments = billSearchAvailable && bills.hasNextPage;
  // One result per bill; the full research view retains the individual document hits.
  const billHits: BillSearchResult['items'] = billPages.flatMap((page) =>
    'rows' in page
      ? page.rows.map((row) => ({
          id: row.id,
          billId: row.id,
          billIdentifier: row.number,
          billTitle: row.title,
          title: row.title,
        }))
      : page.items,
  );
  const matchedBills = Array.from(
    new Map(billHits.map((row) => [row.billId, row])).values(),
  ).slice(0, 6);
  const researchLink = (billId?: string) => {
    if (billSearchMode === 'information' && billId) return `/bills/${encodeURIComponent(billId)}`;
    const next = new URLSearchParams(
      billSearchMode === 'information'
        ? folderTracker.enabled
          ? { tab: 'bills', folderSearch: '1', folderQ: q }
          : { tab: 'bills', corpusQ: q }
        : { tab: 'research', researchView: 'bills', researchQuery: q, versionPolicy: 'current_extractions', jurisdiction: textJurisdiction, session: textSession },
    );
    if (billSearchMode === 'documents' && billScope.clientId) next.set('client', billScope.clientId);
    if (billSearchMode === 'documents' && billScope.folderId) next.set('folder', billScope.folderId);
    if (billSearchMode === 'documents' && billId) next.set('researchBill', billId);
    return '/legiwatch?' + next;
  };
  const matchedCommittees = useMemo(() => {
    if (q.length < 2) return [];
    const needle = q.toLowerCase();
    return (committees.data?.rows ?? [])
      .filter(
        (c) => c.name.toLowerCase().includes(needle) || c.systemCode.toLowerCase().includes(needle),
      )
      .slice(0, 6);
  }, [committees.data, q]);

  // The 250ms debounce leaves `raw` ahead of `q`; without this the previous
  // query's hits stay on screen underneath the newly typed text.
  const isTyping = raw.trim() !== q;
  const isLoading =
    q.length >= 2 &&
    (isTyping ||
      hearings.isFetching ||
      committees.isFetching ||
      (bills.isFetching && !bills.isFetchingNextPage));
  const hasAnyResults =
    (hearings.data?.rows.length ?? 0) > 0 ||
    matchedCommittees.length > 0 ||
    matchedBills.length > 0;
  const hasErrors = hearings.isError || committees.isError || (billSearchAvailable && (billSearchMode === 'information' || hasBillScope) && bills.isError);

  return (
    <LwModal
      kind="search"
      eyebrow="LegiWatch"
      title="Search LegiWatch"
      subtitle="Bills, hearings, transcripts, witnesses, intelligence, and committees."
      note={
        billSearchMode === 'information'
          ? 'Bill information searches the full available corpus across all jurisdictions and sessions.'
          : researchEnabled
            ? `Bill-document text scope: ${textJurisdiction || 'not selected'} · ${textSession || 'not selected'}.`
            : 'Bill-document search is not enabled for this workspace.'
      }
      primaryLabel="Close"
      onPrimary={onClose}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="lw-sect__title">Search</legend>
          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
            <button type="button" aria-pressed={billSearchMode === 'information'} onClick={() => setBillSearchMode('information')}>Bill information</button>
            <button type="button" aria-pressed={billSearchMode === 'documents'} disabled={!researchEnabled} onClick={() => setBillSearchMode('documents')}>Bill-document text</button>
          </div>
          {researchEnabled && billSearchMode === 'documents' ? (
            <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
              <label>Jurisdiction <input aria-label="Bill text jurisdiction" value={textJurisdiction} onChange={(e) => setTextJurisdiction(e.target.value)} /></label>
              <label>Session <input aria-label="Bill text session" value={textSession} onChange={(e) => setTextSession(e.target.value)} /></label>
              <span role="status">Effective scope: {textJurisdiction || 'no jurisdiction'} · {textSession || 'no session'}</span>
            </div>
          ) : null}
        </fieldset>
        <div className="lw-search">
          <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>
            ⌕
          </span>
          <input
            autoFocus
            type="search"
            placeholder="Search bills, bill documents, hearings, witnesses, committees…"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            aria-label="Search LegiWatch"
          />
        </div>

        {researchEnabled && billSearchMode === 'documents' && q.length >= 2 && !hasBillScope ? (
          <p role="status">Choose a jurisdiction and session for bill-document text search.</p>
        ) : null}

        {q.length >= 2 && !isTyping && hasErrors ? (
          <p role="alert">
            Search is incomplete. {hearings.isError ? 'Hearing search could not load. ' : ''}
            {committees.isError ? 'Committee search could not load. ' : ''}
            {billSearchAvailable && bills.isError
              ? 'Bill search could not load. '
              : ''}
            <button
              type="button"
              onClick={() => {
                if (hearings.isError) void hearings.refetch();
                if (committees.isError) void committees.refetch();
                if (billSearchAvailable && bills.isError) {
                  if (bills.isFetchNextPageError) void bills.fetchNextPage();
                  else void bills.refetch();
                }
              }}
            >
              Retry search
            </button>
          </p>
        ) : null}
        {q.length < 2 ? (
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>
            Type at least 2 characters to search.
          </p>
        ) : isLoading ? (
          <LwSkeleton height={120} />
        ) : !hasAnyResults ? (
          <p className="lw-state__body" style={{ maxWidth: 'none' }}>
            {hasErrors ? (
              'No matches from the sources that loaded.'
            ) : hasMoreBillDocuments ? (
              'No matches in the sources and bill documents scanned so far.'
            ) : (
              <>No retained matches for &ldquo;{q}&rdquo;.</>
            )}
          </p>
        ) : (
          <>
            {matchedBills.length ? (
              <section>
                <h3 className="lw-sect__title">{billSearchMode === 'information' ? 'Bill information' : 'Bill-document text'}</h3>
                {billSearchMode === 'information' ? <p role="status">Scope: all available jurisdictions and sessions</p> : null}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {matchedBills.map((bill) => (
                    <Link
                      key={bill.billId}
                      className="lw-block"
                      to={researchLink(bill.billId)}
                      onClick={onClose}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>
                        {bill.billIdentifier ?? bill.billId} · {bill.billTitle ?? bill.title}
                      </div>
                      {'excerpt' in bill && bill.excerpt?.quote ? (
                        <p className="lw-state__body">{bill.excerpt.quote}</p>
                      ) : null}
                    </Link>
                  ))}
                </div>
              </section>
            ) : null}
            {matchedCommittees.length ? (
              <section>
                <h3 className="lw-sect__title">Committees</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {matchedCommittees.map((c) => (
                    <button
                      key={c.systemCode}
                      type="button"
                      className="lw-block"
                      style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
                      onClick={() => onOpenCommittee(c.systemCode)}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{c.name}</div>
                      <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                        {c.chamber.toUpperCase()} ·{' '}
                        {c.isSubcommittee ? 'SUBCOMMITTEE' : 'FULL COMMITTEE'}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}

            {hearings.data?.rows.length ? (
              <section>
                <h3 className="lw-sect__title">Hearings &amp; transcripts</h3>
                {hearings.data.matchMode === 'partial' ? (
                  <p
                    className="lw-mono"
                    style={{ fontSize: 11, color: 'var(--lw-meta)', margin: '0 0 6px' }}
                  >
                    No proceeding matched every word — showing partial matches.
                  </p>
                ) : null}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {hearings.data.rows.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      className="lw-block"
                      style={{ textAlign: 'left', width: '100%', cursor: 'pointer' }}
                      onClick={() => onOpenHearing(r.id)}
                    >
                      <div style={{ fontSize: 13, fontWeight: 600 }}>{r.title}</div>
                      <div className="lw-mono" style={{ fontSize: 11, color: 'var(--lw-meta)' }}>
                        {r.committeeName ?? r.chamber.toUpperCase()} ·{' '}
                        {r.calendarDate ?? 'date not announced'}
                      </div>
                    </button>
                  ))}
                </div>
              </section>
            ) : null}
          </>
        )}
        {billSearchAvailable && q.length >= 2 && !isTyping ? (
          <div>
            {billPages.some((page) => 'coverage' in page && page.coverage?.complete === false) ? (
              <p role="status">
                Bill search covers retained documents; source coverage is incomplete.
              </p>
            ) : null}
            {hasMoreBillDocuments ? (
              <div>
                <p role="status">More retained bill documents remain to be searched.</p>
                {matchedBills.length < 6 ? (
                  <button
                    type="button"
                    disabled={bills.isFetchingNextPage}
                    onClick={() => void bills.fetchNextPage()}
                  >
                    {bills.isFetchingNextPage
                      ? 'Searching more bill documents…'
                      : 'Search more bill documents'}
                  </button>
                ) : (
                  <p>Showing up to six bills. Open all bill research results to continue.</p>
                )}
              </div>
            ) : null}
            <Link to={researchLink()} onClick={onClose}>
              {billSearchMode === 'information' ? 'Open all bill information results' : 'Open all bill-document results'}
            </Link>
          </div>
        ) : null}
      </div>
    </LwModal>
  );
}
