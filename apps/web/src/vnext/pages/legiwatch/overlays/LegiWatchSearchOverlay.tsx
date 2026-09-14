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
  const [params] = useSearchParams();
  const billScope = {
    clientId: params.get('client') || null,
    folderId: params.get('folder') || null,
    jurisdiction: params.get('jurisdiction') || 'FL',
    sessionKey: params.get('session') || String(new Date().getFullYear()),
  };
  const [raw, setRaw] = useState('');
  const [q, setQ] = useState('');

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
  const bills = useInfiniteQuery({
    queryKey: ['lw-vnext', 'search-bills', scope, billScope, q],
    enabled: researchEnabled && q.length >= 2,
    initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) =>
      (
        await api.post<BillSearchResult>('/intel-api/legiwatch/research/search', {
          ...billScope,
          query: q,
          kind: 'all',
          versionPolicy: 'current_extractions',
          cursor: pageParam,
        })
      ).data,
    getNextPageParam: (page) => page.cursor ?? undefined,
    retry: false,
  });
  const billPages = researchEnabled ? (bills.data?.pages ?? []) : [];
  const hasMoreBillDocuments = researchEnabled && bills.hasNextPage;
  // One result per bill; the full research view retains the individual document hits.
  const matchedBills = Array.from(
    new Map(billPages.flatMap((page) => page.items).map((row) => [row.billId, row])).values(),
  ).slice(0, 6);
  const researchLink = (billId?: string) => {
    const next = new URLSearchParams({
      tab: 'research',
      researchView: 'bills',
      researchQuery: q,
      versionPolicy: 'current_extractions',
      jurisdiction: billScope.jurisdiction,
      session: billScope.sessionKey,
    });
    if (billScope.clientId) next.set('client', billScope.clientId);
    if (billScope.folderId) next.set('folder', billScope.folderId);
    if (billId) next.set('researchBill', billId);
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
  const hasErrors = hearings.isError || committees.isError || (researchEnabled && bills.isError);

  return (
    <LwModal
      kind="search"
      eyebrow="LegiWatch"
      title="Search LegiWatch"
      subtitle="Bills, hearings, transcripts, witnesses, intelligence, and committees."
      note={
        researchEnabled
          ? `Bill documents: ${billScope.jurisdiction} · ${billScope.sessionKey}, using the selected client and folder. Hearing archive and committee results cover the public federal sources.`
          : 'Bill research is not enabled for this workspace. Hearing and committee search remains available.'
      }
      primaryLabel="Close"
      onPrimary={onClose}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="lw-search">
          <span aria-hidden="true" style={{ color: 'var(--lw-meta)' }}>
            ⌕
          </span>
          <input
            autoFocus
            type="search"
            placeholder="Search bill text, hearings, witnesses, committees…"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            aria-label="Search LegiWatch"
          />
        </div>

        {q.length >= 2 && !isTyping && hasErrors ? (
          <p role="alert">
            Search is incomplete. {hearings.isError ? 'Hearing search could not load. ' : ''}
            {committees.isError ? 'Committee search could not load. ' : ''}
            {researchEnabled && bills.isError
              ? 'Bill research could not load for the selected scope. '
              : ''}
            <button
              type="button"
              onClick={() => {
                if (hearings.isError) void hearings.refetch();
                if (committees.isError) void committees.refetch();
                if (researchEnabled && bills.isError) {
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
            {researchEnabled && matchedBills.length ? (
              <section>
                <h3 className="lw-sect__title">Bills &amp; retained documents</h3>
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
                      {bill.excerpt?.quote ? (
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
        {researchEnabled && q.length >= 2 && !isTyping ? (
          <div>
            {billPages.some((page) => page.coverage?.complete === false) ? (
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
              Open all bill research results
            </Link>
          </div>
        ) : null}
      </div>
    </LwModal>
  );
}
