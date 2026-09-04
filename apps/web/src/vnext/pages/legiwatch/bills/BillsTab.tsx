/**
 * Bills tab (§7.5) — recommendations + the tracked stage board, one page with
 * one client scope (§4.1 #11). Recommendations are NOT yet tracked by
 * definition; tracking one moves it onto the board and out of the strip in the
 * same mutation (server-authoritative, §6.3).
 *
 * Passage likelihood is null for terminal bills (§8.5): enacted/failed render
 * the terminal status, never `0%`. Authorization and appropriations are never
 * summed anywhere (§8.3). Clicking any bill opens Bill 360 — never an
 * unrelated Data Explorer route (§7.5).
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import type { Client } from '../../../../pages/clients/clientTypes.js';
import {
  intelTrackerPaths,
  adaptBoard,
  adaptRecs,
  type IntelBoard,
  type IntelRec,
} from '../../../../pages/clients/tracker/intel-tracker-api.js';
import {
  trackerKeys,
  type BoardBill,
  type BoardResponse,
  type RecommendationsResponse,
} from '../../../../pages/clients/tracker/tracker-api.js';
import { LwPill, LwSeg, LwButton } from '../lib/primitives.js';
import { LwStateLoading, LwStateUnavailable, LwStateAllClear, LwStateEmpty } from '../states/SystemStates.js';
import { Bill360Drawer } from './Bill360Drawer.js';

type ViewMode = 'cards' | 'table';
type SortKey = 'passage' | 'relevance';

export function BillsTab({ scope, clients }: { scope: string; clients: Client[] }) {
  const api = useApi();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [view, setView] = useState<ViewMode>('cards');
  const [sort, setSort] = useState<SortKey>('passage');
  const [highFit, setHighFit] = useState(false);
  const [changed7, setChanged7] = useState(false);
  const [activeOnly, setActiveOnly] = useState(false);
  const [openBill, setOpenBill] = useState<string | null>(null);

  // Bills board + recommendations are client-scoped surfaces. PR C / LW-QA-012:
  // "All clients" (empty scope) must NOT silently read the first client. The
  // board has a real tenant roll-up contract — the literal `_all` clientId
  // routes to TrackerBoardService.getTenantBoard (tenant-wide, (clientId,billId)
  // cursor dedupe, client names attached). Recommendations are compiled FROM a
  // client's approved watchlist, so there is no tenant-wide recommendation
  // contract: in `_all` the strip is hidden with an honest notice, and Bill 360
  // never receives `_all` as if it were a UUID client.
  const isAllScope = !scope;
  const clientId = isAllScope ? '_all' : scope;

  const boardFilters = useMemo(
    () => ({
      changedWithinDays: changed7 ? 7 : undefined,
      activeOnly: activeOnly || undefined,
    }),
    [changed7, activeOnly],
  );

  const board = useInfiniteQuery<BoardResponse>({
    queryKey: [...trackerKeys.board(clientId), boardFilters],
    queryFn: async ({ pageParam }) => {
      const raw = (
        await api.get<IntelBoard>(
          intelTrackerPaths.board(clientId, pageParam as string | undefined, boardFilters),
        )
      ).data;
      return adaptBoard(raw);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled: Boolean(clientId),
    retry: false,
    staleTime: 30_000,
  });

  const recs = useQuery<RecommendationsResponse>({
    queryKey: trackerKeys.recommendations(clientId),
    queryFn: async () =>
      adaptRecs((await api.get<IntelRec[]>(intelTrackerPaths.recommendations(clientId))).data),
    // PR C §15: recommendations compile from ONE client's approved watchlist —
    // there is no tenant-wide recommendation contract, so `_all` must not call
    // a per-client recommendations endpoint with the literal `_all`.
    enabled: Boolean(clientId) && !isAllScope,
    retry: false,
    staleTime: 30_000,
  });

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: trackerKeys.board(clientId) });
    void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) });
    void qc.invalidateQueries({ queryKey: trackerKeys.summary(clientId) });
  };

  const track = useMutation({
    mutationFn: async (billId: string) =>
      (await api.post(intelTrackerPaths.track(clientId), { billId, source: 'recommended' })).data,
    onMutate: (billId) => {
      // optimistic: move the card out of the rec strip (§7.5)
      qc.setQueryData<RecommendationsResponse>(trackerKeys.recommendations(clientId), (prev) =>
        prev
          ? { ...prev, recommendations: prev.recommendations.filter((r) => r.billId !== billId) }
          : prev,
      );
    },
    onSuccess: invalidateAll,
    onError: () => {
      void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) });
    },
  });

  const columns = board.data?.pages?.[0]?.columns ?? [];
  const total = board.data?.pages?.[0]?.total ?? 0;
  const fedCount = columns.reduce(
    (n, c) => n + c.bills.filter((b) => !b.jurisdiction || b.jurisdiction === 'US').length,
    0,
  );
  const stateCount = total - fedCount >= 0 ? columns.reduce((n, c) => n + c.bills.filter((b) => b.jurisdiction && b.jurisdiction !== 'US').length, 0) : 0;

  const topRecs = (recs.data?.recommendations ?? []).filter((r) => !r.belowFloor).slice(0, 3);

  const sortBills = (list: BoardBill[]): BoardBill[] =>
    [...list].sort((a, b) =>
      sort === 'passage'
        ? b.probability - a.probability
        : (b.matchedHighPriorityTopics?.length ?? 0) - (a.matchedHighPriorityTopics?.length ?? 0),
    );

  if (!clientId) {
    return (
      <div className="lw-body">
        <LwStateEmpty onReset={undefined} />
      </div>
    );
  }

  if (board.isLoading) {
    return (
      <div className="lw-body">
        <div className="lw-card" style={{ padding: 18 }}>
          <LwStateLoading rows={4} />
        </div>
      </div>
    );
  }

  if (board.isError) {
    return (
      <div className="lw-body">
        <LwStateUnavailable
          source="Bills board"
          reason="The tracked-bill service could not be loaded. Recommendations may still be available."
          onRetry={() => void board.refetch()}
        />
      </div>
    );
  }

  return (
    <div className="lw-body">
      {/* Recommended for your portfolio — up to three untracked matches.
          PR C §15: hidden in the All-clients scope (no tenant-wide
          recommendation contract) with an honest pointer to a client scope. */}
      {isAllScope ? (
        <div className="lw-card" style={{ padding: '10px 18px' }} aria-label="Recommendations unavailable in all-clients scope">
          <span style={{ fontSize: 13, color: 'var(--lw-meta)' }}>
            Recommendations are tailored per client. Select a client to see tailored recommendations.
          </span>
        </div>
      ) : topRecs.length > 0 ? (
        <section className="lw-card" aria-label="Recommended bills">
          <div className="lw-card__head">
            <h2 className="lw-card__title">Recommended for your portfolio</h2>
            <span className="lw-card__meta">{topRecs.length} untracked matches</span>
          </div>
          <div style={{ padding: '14px 18px' }}>
            <div className="lw-recs">
              {topRecs.map((r) => (
                <div key={r.billId} className="lw-reccard">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="lw-bcard__id">{r.displayNum}</span>
                    <LwPill tone="brand" size="22">FIT {Math.round(r.fit * 100)}</LwPill>
                  </div>
                  <div className="lw-bcard__title" style={{ marginTop: 6 }}>{r.title}</div>
                  <div className="lw-bcard__meta" style={{ marginTop: 6 }}>
                    <span className="lw-mono">{r.matchedTags.join(' · ')}</span>
                    <span className="lw-mono">{Math.round(r.probability > 1 ? r.probability : r.probability * 100)}%</span>
                  </div>
                  <div style={{ marginTop: 10 }}>
                    <LwButton
                      variant="primary"
                      onClick={() => track.mutate(r.billId)}
                      disabled={track.isPending}
                    >
                      Track
                    </LwButton>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      ) : null}

      {/* board toolbar */}
      <div className="lw-controls">
        <LwSeg
          ariaLabel="Board view"
          options={[
            { id: 'cards' as ViewMode, label: 'Cards' },
            { id: 'table' as ViewMode, label: 'Table' },
          ]}
          value={view}
          onChange={setView}
        />
        <button
          type="button"
          className={`lw-btn${highFit ? ' lw-btn--primary' : ''}`}
          onClick={() => setHighFit((v) => !v)}
          aria-pressed={highFit}
        >
          High fit
        </button>
        <button
          type="button"
          className={`lw-btn${changed7 ? ' lw-btn--primary' : ''}`}
          onClick={() => setChanged7((v) => !v)}
          aria-pressed={changed7}
        >
          Changed in 7 days
        </button>
        <button
          type="button"
          className={`lw-btn${activeOnly ? ' lw-btn--primary' : ''}`}
          onClick={() => setActiveOnly((v) => !v)}
          aria-pressed={activeOnly}
        >
          Active only
        </button>
        <select
          aria-label="Sort"
          className="lw-btn"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortKey)}
        >
          <option value="passage">Passage likelihood</option>
          <option value="relevance">Client relevance</option>
        </select>
        <span style={{ flex: 1 }} />
        <LwButton
          onClick={() => {
            const rows = columns.flatMap((c) => c.bills.map((b) => `${b.displayNum}\t${b.title}\t${c.label}\t${b.jurisdiction ?? 'US'}`));
            const blob = new Blob([`Bill\tTitle\tStage\tJurisdiction\n${rows.join('\n')}`], { type: 'text/tab-separated-values' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'legiwatch-bills.tsv';
            a.click();
            URL.revokeObjectURL(a.href);
          }}
        >
          Export
        </LwButton>
      </div>

      {/* stage board */}
      {view === 'cards' ? (
        <>
          <div className="lw-board">
            {columns.map((col) => {
              let bills = col.bills;
              if (highFit) bills = bills.filter((b) => (b.matchedHighPriorityTopics?.length ?? 0) > 0);
              bills = sortBills(bills);
              return (
                <div key={col.id} className="lw-bcol">
                  <div className="lw-bcol__head">
                    <span className="lw-bcol__label">{col.label}</span>
                    <span className="lw-rail__count">{col.count}</span>
                  </div>
                  {bills.length === 0 ? (
                    <div className="lw-recs__empty" style={{ padding: '6px 4px' }}>No bills</div>
                  ) : (
                    bills.map((b) => {
                      const terminal = b.canonicalStatus === 'enacted' || b.canonicalStatus === 'failed' || b.terminalRisk;
                      return (
                        <button key={`${b.clientId ?? 'own'}-${b.billId}`} type="button" className="lw-bcard" onClick={() => setOpenBill(b.billId)}>
                          <div className="lw-bcard__id">{b.displayNum}</div>
                          <div className="lw-bcard__title">{b.title}</div>
                          <div className="lw-bcard__meta">
                            <span>{b.jurisdiction && b.jurisdiction !== 'US' ? b.jurisdiction : 'Federal'}</span>
                            {isAllScope && b.clientName ? <span>{b.clientName}</span> : null}
                            {terminal ? (
                              <LwPill tone={b.canonicalStatus === 'enacted' ? 'success' : 'error'} size="22">
                                {(b.canonicalStatus ?? 'TERMINAL').toUpperCase()}
                              </LwPill>
                            ) : (
                              <span className="lw-mono">{Math.round(b.probability > 1 ? b.probability : b.probability * 100)}%</span>
                            )}
                          </div>
                        </button>
                      );
                    })
                  )}
                </div>
              );
            })}
          </div>
          <div className="lw-card__meta" style={{ padding: '4px 2px' }}>
            {total} tracked · {fedCount} federal · {stateCount} state · authoritative tracked status from the server
          </div>
        </>
      ) : (
        <section className="lw-card" aria-label="Bills table">
          {/* Five columns need ~720px; the module gets 358px on a phone. The
              table scrolls inside its own card rather than widening the page. */}
          <div className="capiro-scroll-x lw-tablewrap">
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left' }}>
                  {['Bill', 'Title', 'Stage', 'Client', 'Passage'].map((h) => (
                    <th key={h} style={{ padding: '12px 18px', fontFamily: 'var(--lw-mono)', fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'var(--lw-meta)', borderBottom: '1px solid var(--lw-line)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {columns.flatMap((col) =>
                  sortBills(col.bills).map((b) => {
                    const terminal = b.canonicalStatus === 'enacted' || b.canonicalStatus === 'failed' || b.terminalRisk;
                    return (
                      <tr key={`${b.clientId ?? 'own'}-${b.billId}`} style={{ borderBottom: '1px solid var(--lw-hover)', cursor: 'pointer' }} onClick={() => setOpenBill(b.billId)}>
                        <td style={{ padding: '12px 18px', fontFamily: 'var(--lw-mono)', fontSize: 12, fontWeight: 600 }}>{b.displayNum}</td>
                        <td style={{ padding: '12px 18px', fontSize: 13, fontWeight: 600 }}>{b.title}</td>
                        <td style={{ padding: '12px 18px' }}><LwPill tone="brand" size="22">{col.label}</LwPill></td>
                        <td style={{ padding: '12px 18px', fontSize: 13, color: 'var(--lw-body)' }}>{isAllScope && b.clientName ? b.clientName : b.jurisdiction ?? 'US'}</td>
                        <td style={{ padding: '12px 18px', fontFamily: 'var(--lw-mono)', fontSize: 12 }}>
                          {terminal ? (b.canonicalStatus ?? 'TERMINAL').toUpperCase() : `${Math.round(b.probability > 1 ? b.probability : b.probability * 100)}%`}
                        </td>
                      </tr>
                    );
                  }),
                )}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {openBill ? (
        <Bill360Drawer
          billId={openBill}
          // PR C §15: `_all` is NOT a client — the global Bill 360 dossier route
          // is the general view (clientId=null → /intel-api/bills/:id/dossier),
          // and the per-client hearings interlink stays off (it would silently
          // return zero rows). A specific client still gets the client overlay.
          clientId={isAllScope ? '' : clientId}
          onClose={() => setOpenBill(null)}
          onOpenFull={() => navigate(`/bills/${encodeURIComponent(openBill)}`)}
        />
      ) : null}
    </div>
  );
}
