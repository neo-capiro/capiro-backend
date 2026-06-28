import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { App as AntApp } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import './tracker.css';
import { Icon, StarIcon } from './tracker-icons.js';
import {
  AddBillModal,
  BillCard,
  RecCard,
  SubNav,
  TrackToasts,
  TrkDropdown,
  VerifyOtpModal,
  type ToastItem,
} from './tracker-components.js';
import { TrackerConfigPanel } from './TrackerConfigPanel.js';
import {
  trackerKeys,
  trackerPaths,
  type AlertPrefsPayload,
  type BillSearchResult,
  type BoardResponse,
  type RecommendationBill,
  type RecommendationsResponse,
  type SeedSuggestions,
  type WatchlistPayload,
} from './tracker-api.js';

type Panel = 'board' | 'recs' | 'config';
const PANEL_KEY = 'capiro:tracker:panel';

function loadPanel(): Panel {
  try {
    const v = window.sessionStorage.getItem(PANEL_KEY);
    if (v === 'board' || v === 'recs' || v === 'config') return v;
  } catch {
    /* ignore */
  }
  return 'board';
}

const MONTHS: Record<string, number> = {
  '01': 0,
  '02': 1,
  '03': 2,
  '04': 3,
  '05': 4,
  '06': 5,
  '07': 6,
  '08': 7,
  '09': 8,
  '10': 9,
  '11': 10,
  '12': 11,
};
function dateVal(s: string | null): number {
  if (!s) return 0;
  const parts = s.split('-');
  const m = parts[1] ?? '';
  const d = parts[2] ?? '0';
  return (MONTHS[m] ?? 0) * 31 + parseInt(d, 10);
}

export function TrackerTab({ clientId, clientName }: { clientId: string; clientName: string }) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();
  const navigate = useNavigate();

  const [panel, setPanelState] = useState<Panel>(loadPanel);
  const setPanel = (p: Panel) => {
    setPanelState(p);
    try {
      window.sessionStorage.setItem(PANEL_KEY, p);
    } catch {
      /* ignore */
    }
  };

  // Board controls
  const [sort, setSort] = useState<'prob' | 'num' | 'changed'>('prob');
  const [filter, setFilter] = useState<'all' | 'highfit' | 'highprob'>('all');
  const [menu, setMenu] = useState<string | null>(null);
  const [expandedCols, setExpandedCols] = useState<Set<string>>(() => new Set());
  const [justLanded, setJustLanded] = useState<string | null>(null);

  // Recs controls
  const [recSort, setRecSort] = useState<'relevance' | 'probability' | 'newest'>('relevance');
  const [recTag, setRecTag] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Modals + toasts
  const [modal, setModal] = useState<'addBill' | 'otp' | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const otpState = useRef<{
    masked: string;
    devCode?: string;
    phone: string;
    onVerified: () => void;
  } | null>(null);

  useEffect(() => {
    if (!menu) return;
    const h = () => setMenu(null);
    window.addEventListener('click', h);
    return () => window.removeEventListener('click', h);
  }, [menu]);

  const pushToast = (t: Omit<ToastItem, 'id'>) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((arr) => [...arr, { ...t, id }]);
    window.setTimeout(() => setToasts((arr) => arr.filter((x) => x.id !== id)), 2800);
  };

  // ── Queries ──────────────────────────────────────────────────────────────
  const boardQuery = useQuery<BoardResponse>({
    queryKey: trackerKeys.board(clientId),
    queryFn: async () => (await api.get<BoardResponse>(trackerPaths.board(clientId))).data,
  });
  const recsQuery = useQuery<RecommendationsResponse>({
    queryKey: trackerKeys.recommendations(clientId),
    queryFn: async () =>
      (await api.get<RecommendationsResponse>(trackerPaths.recommendations(clientId))).data,
    staleTime: 60_000,
  });
  const issueAreasQuery = useQuery<{ issueAreas: string[] }>({
    queryKey: trackerKeys.issueAreas(),
    queryFn: async () => (await api.get<{ issueAreas: string[] }>(trackerPaths.issueAreas())).data,
    staleTime: 60 * 60_000,
  });
  const watchlistQuery = useQuery<WatchlistPayload>({
    queryKey: trackerKeys.watchlist(clientId),
    queryFn: async () => (await api.get<WatchlistPayload>(trackerPaths.watchlist(clientId))).data,
    enabled: panel === 'config',
  });
  const prefsQuery = useQuery<AlertPrefsPayload>({
    queryKey: trackerKeys.alertPrefs(clientId),
    queryFn: async () => (await api.get<AlertPrefsPayload>(trackerPaths.alertPrefs(clientId))).data,
    enabled: panel === 'config',
  });
  // Suggestions to seed the watchlist from the client profile (capability tags +
  // sector → issue area). Excludes anything already configured.
  const seedQuery = useQuery<SeedSuggestions>({
    queryKey: trackerKeys.seed(clientId),
    queryFn: async () =>
      (await api.get<SeedSuggestions>(trackerPaths.seedSuggestions(clientId))).data,
    enabled: panel === 'config',
    staleTime: 5 * 60_000,
  });

  const allIssueAreas = issueAreasQuery.data?.issueAreas ?? [];
  const issueSet = useMemo(() => new Set(allIssueAreas), [allIssueAreas]);
  // High-priority tags drive the "High fit" board filter.
  const highPrio = useMemo(
    () =>
      new Set(
        (watchlistQuery.data?.tags ?? []).filter((t) => t.priority === 'high').map((t) => t.tag),
      ),
    [watchlistQuery.data],
  );

  const board = boardQuery.data;
  const recs = recsQuery.data;
  const boardCount = board?.total ?? 0;
  const aboveFloorCount = recs?.aboveFloorCount ?? 0;
  const boardNums = useMemo(
    () => new Set((board?.columns ?? []).flatMap((c) => c.bills.map((b) => b.billId))),
    [board],
  );

  // ── Mutations ──────────────────────────────────────────────────────────────
  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: trackerKeys.board(clientId) });
    void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) });
    void qc.invalidateQueries({ queryKey: trackerKeys.summary(clientId) });
  };

  const trackMutation = useMutation({
    mutationFn: async ({
      billId,
      source,
    }: {
      billId: string;
      source: 'recommended' | 'manual_search';
    }) => (await api.post(trackerPaths.track(clientId), { billId, source })).data,
    onMutate: ({ billId }) => {
      qc.setQueryData<RecommendationsResponse>(trackerKeys.recommendations(clientId), (prev) =>
        prev
          ? { ...prev, recommendations: prev.recommendations.filter((r) => r.billId !== billId) }
          : prev,
      );
    },
    onSuccess: (_d, { billId }) => {
      setJustLanded(billId);
      window.setTimeout(() => setJustLanded((cur) => (cur === billId ? null : cur)), 950);
      invalidateAll();
    },
    onError: () => {
      message.error('Could not track bill');
      void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) });
    },
  });

  const untrackMutation = useMutation({
    mutationFn: async (billId: string) =>
      (await api.delete(trackerPaths.untrack(clientId, billId))).data,
    onMutate: (billId) => {
      qc.setQueryData<BoardResponse>(trackerKeys.board(clientId), (prev) =>
        prev
          ? {
              total: Math.max(0, prev.total - 1),
              columns: prev.columns.map((c) => ({
                ...c,
                bills: c.bills.filter((b) => b.billId !== billId),
                count: c.bills.filter((b) => b.billId !== billId).length,
              })),
            }
          : prev,
      );
    },
    onSuccess: () => invalidateAll(),
    onError: () => {
      message.error('Could not untrack bill');
      void qc.invalidateQueries({ queryKey: trackerKeys.board(clientId) });
    },
  });

  const dismissMutation = useMutation({
    mutationFn: async (billId: string) =>
      (await api.post(trackerPaths.feedback(clientId), { billId, signal: 'marked_irrelevant' }))
        .data,
    onMutate: (billId) => {
      qc.setQueryData<RecommendationsResponse>(trackerKeys.recommendations(clientId), (prev) =>
        prev
          ? {
              ...prev,
              recommendations: prev.recommendations.filter((r) => r.billId !== billId),
              // Keep the badge / "N bills match" / empty-CTA count in sync during
              // the optimistic window (only decrement for an above-floor bill).
              aboveFloorCount: Math.max(
                0,
                prev.aboveFloorCount -
                  (prev.recommendations.find((r) => r.billId === billId && !r.belowFloor) ? 1 : 0),
              ),
            }
          : prev,
      );
    },
    onSuccess: () => void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) }),
    onError: () => void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) }),
  });

  const markReadMutation = useMutation({
    mutationFn: async (billId: string) =>
      (await api.post(trackerPaths.feedback(clientId), { billId, signal: 'opened' })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: trackerKeys.board(clientId) });
      void qc.invalidateQueries({ queryKey: trackerKeys.summary(clientId) });
    },
  });

  const saveWatchlistMutation = useMutation({
    mutationFn: async (w: WatchlistPayload) =>
      (await api.put<WatchlistPayload>(trackerPaths.watchlist(clientId), w)).data,
    onSuccess: (data) => {
      // Seed the cache with the server-normalized value so the Configure form
      // (and recs) reflect what was actually persisted.
      qc.setQueryData(trackerKeys.watchlist(clientId), data);
      void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) });
      // Refresh seed suggestions only AFTER the save persists — otherwise the
      // refetch races the debounced PUT and returns stale (still-importable) rows.
      void qc.invalidateQueries({ queryKey: trackerKeys.seed(clientId) });
    },
    onError: () => message.error('Could not save targeting'),
  });
  const savePrefsMutation = useMutation({
    mutationFn: async (p: AlertPrefsPayload) =>
      (await api.put<AlertPrefsPayload>(trackerPaths.alertPrefs(clientId), p)).data,
    onSuccess: (data) => qc.setQueryData(trackerKeys.alertPrefs(clientId), data),
    onError: () => message.error('Could not save alert preferences'),
  });

  const smsStartMutation = useMutation({
    mutationFn: async (phone: string) =>
      (await api.post(trackerPaths.smsStart(clientId), { phone })).data as {
        dormant: boolean;
        masked: string;
        devCode?: string;
      },
  });
  const smsConfirmMutation = useMutation({
    mutationFn: async ({ phone, code }: { phone: string; code: string }) =>
      (await api.post(trackerPaths.smsConfirm(clientId), { phone, code })).data,
  });
  const testAlertMutation = useMutation({
    mutationFn: async (channels: ('email' | 'sms' | 'in_app')[]) =>
      (await api.post(trackerPaths.testAlert(clientId), { channels })).data as {
        channel: string;
        status: string;
      }[],
  });

  // ── Handlers ────────────────────────────────────────────────────────────
  const drillTo = (billId: string) => navigate(`/explorer?bill=${encodeURIComponent(billId)}`);
  const openBoardBill = (billId: string, unread: boolean) => {
    if (unread) markReadMutation.mutate(billId);
    drillTo(billId);
  };
  const trackRec = (billId: string) => {
    const b = recs?.recommendations.find((r) => r.billId === billId);
    trackMutation.mutate({ billId, source: 'recommended' });
    pushToast({ num: b?.displayNum ?? '' });
  };
  const trackManual = (bill: BillSearchResult) => {
    trackMutation.mutate({ billId: bill.billId, source: 'manual_search' });
    pushToast({ num: bill.displayNum });
  };
  const requestVerify = (phone: string, onVerified: () => void) => {
    smsStartMutation.mutate(phone, {
      onSuccess: (res) => {
        otpState.current = { masked: res.masked, devCode: res.devCode, phone, onVerified };
        setModal('otp');
      },
      onError: () => message.error('Could not start phone verification'),
    });
  };
  const confirmOtp = (code: string) => {
    const st = otpState.current;
    if (!st) return;
    smsConfirmMutation.mutate(
      { phone: st.phone, code },
      {
        onSuccess: () => {
          st.onVerified();
          setModal(null);
          pushToast({ text: 'Phone verified ✓' });
          void qc.invalidateQueries({ queryKey: trackerKeys.alertPrefs(clientId) });
        },
        onError: (e) =>
          message.error(
            (e as { response?: { data?: { message?: string } } })?.response?.data?.message ??
              'Incorrect code',
          ),
      },
    );
  };
  const fireTest = (channels: ('email' | 'sms' | 'in_app')[]) => {
    testAlertMutation.mutate(channels, {
      onSuccess: (res) => {
        const label: Record<string, string> = { in_app: 'In-app', email: 'Email', sms: 'SMS' };
        const sent = res
          .filter((r) => r.status === 'sent' || r.status === 'suppressed')
          .map((r) => label[r.channel] ?? r.channel);
        pushToast({ kind: 'test', channels: sent.length ? sent : ['In-app'] });
      },
      onError: () => message.error('Could not send test alert'),
    });
  };

  // ── Board derivation (client-side filter/sort over server columns) ────────
  const boardColumns = useMemo(() => {
    if (!board) return [];
    const matchFilter = (b: BoardResponse['columns'][number]['bills'][number]) =>
      filter === 'highprob'
        ? b.probability >= 0.7
        : filter === 'highfit'
          ? b.tags.some((t) => highPrio.has(t))
          : true;
    const sortBills = (arr: BoardResponse['columns'][number]['bills']) => {
      const c = [...arr];
      if (sort === 'prob') c.sort((a, b) => b.probability - a.probability);
      else if (sort === 'num')
        c.sort((a, b) => a.displayNum.localeCompare(b.displayNum, undefined, { numeric: true }));
      else if (sort === 'changed')
        c.sort((a, b) => (b.change ? 1 : 0) - (a.change ? 1 : 0) || b.probability - a.probability);
      return c;
    };
    return board.columns.map((col) => {
      const bills = sortBills(col.bills.filter(matchFilter));
      return { ...col, bills, count: bills.length };
    });
  }, [board, filter, sort, highPrio]);

  // ── Recs derivation ──────────────────────────────────────────────────────
  const recAll = recs?.recommendations ?? [];
  const aboveFloor = recAll.filter((r) => !r.belowFloor);
  const recTagOptions = useMemo(
    () => ['all', ...Array.from(new Set(recAll.flatMap((r) => r.matchedTags)))],
    [recAll],
  );
  const recList = useMemo(() => {
    const base = showAll ? recAll : aboveFloor;
    const byTag = recTag === 'all' ? base : base.filter((b) => b.matchedTags.includes(recTag));
    return [...byTag].sort((a, b) =>
      recSort === 'probability'
        ? b.probability - a.probability
        : recSort === 'newest'
          ? dateVal(b.latestActionDate) - dateVal(a.latestActionDate)
          : b.fit - a.fit,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recAll, showAll, recTag, recSort]);

  const toggleSel = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const trackSelected = () => {
    const ids = [...selected];
    ids.forEach((id) => trackMutation.mutate({ billId: id, source: 'recommended' }));
    pushToast({ text: `${ids.length} bill${ids.length > 1 ? 's' : ''} added to board` });
    setSelected(new Set());
    setSelectMode(false);
  };

  return (
    <div className="trk">
      {/* header: sub-nav + contextual controls */}
      <div className="trk-head">
        <SubNav panel={panel} setPanel={setPanel} recCount={aboveFloorCount} />
        <div className="trk-spacer" />

        {panel === 'board' && (
          <div className="trk-controls">
            <TrkDropdown
              open={menu === 'b-filter'}
              onToggle={() => setMenu(menu === 'b-filter' ? null : 'b-filter')}
              label="Filter"
              value={filter}
              onSelect={(v) => {
                setFilter(v as typeof filter);
                setMenu(null);
              }}
              options={[
                { v: 'all', l: 'All bills' },
                { v: 'highfit', l: 'High-fit (priority tag)' },
                { v: 'highprob', l: 'High-probability (≥70%)' },
              ]}
            />
            <TrkDropdown
              open={menu === 'b-sort'}
              onToggle={() => setMenu(menu === 'b-sort' ? null : 'b-sort')}
              label="Sort"
              value={sort}
              onSelect={(v) => {
                setSort(v as typeof sort);
                setMenu(null);
              }}
              options={[
                { v: 'prob', l: 'Probability' },
                { v: 'num', l: 'Bill number' },
                { v: 'changed', l: 'Recently changed' },
              ]}
            />
            <button className="btn btn-primary" onClick={() => setModal('addBill')}>
              <Icon name="plus" size={13} /> Add bill
            </button>
          </div>
        )}

        {panel === 'recs' && (
          <div className="trk-controls">
            <TrkDropdown
              open={menu === 'r-tag'}
              onToggle={() => setMenu(menu === 'r-tag' ? null : 'r-tag')}
              label="Tag"
              value={recTag}
              onSelect={(v) => {
                setRecTag(v);
                setMenu(null);
              }}
              options={recTagOptions.map((t) => ({ v: t, l: t === 'all' ? 'All tags' : t }))}
            />
            <TrkDropdown
              open={menu === 'r-sort'}
              onToggle={() => setMenu(menu === 'r-sort' ? null : 'r-sort')}
              label="Sort"
              value={recSort}
              onSelect={(v) => {
                setRecSort(v as typeof recSort);
                setMenu(null);
              }}
              options={[
                { v: 'relevance', l: 'Relevance' },
                { v: 'probability', l: 'Probability' },
                { v: 'newest', l: 'Newest action' },
              ]}
            />
            <button
              className={`btn${selectMode ? ' btn-accent' : ''}`}
              onClick={() => {
                setSelectMode(!selectMode);
                setSelected(new Set());
              }}
            >
              {selectMode ? 'Done' : 'Select'}
            </button>
          </div>
        )}
      </div>

      {/* ===================== BOARD ===================== */}
      {panel === 'board' &&
        (boardQuery.isLoading ? (
          <div className="trk-col-empty">Loading tracked bills…</div>
        ) : boardCount === 0 ? (
          <div className="trk-empty">
            <div className="ico">
              <StarIcon size={22} />
            </div>
            <h4>No bills on the board yet</h4>
            <p>
              Capiro has surfaced {aboveFloorCount} bills it thinks {clientName} should track.
            </p>
            <button className="btn btn-accent" onClick={() => setPanel('recs')}>
              Review {aboveFloorCount} recommended bills →
            </button>
          </div>
        ) : (
          <>
            <div className="trk-legend">
              <span className="item">
                <span className="sw" style={{ background: 'var(--info)' }} /> Columns = official
                legislative <b>stage</b>
              </span>
              <span className="sep">·</span>
              <span className="item">
                <span style={{ display: 'inline-flex', gap: 2 }}>
                  <span className="sw" style={{ background: 'var(--info)', width: 6 }} />
                  <span className="sw" style={{ background: 'var(--notable)', width: 6 }} />
                  <span className="sw" style={{ background: 'var(--success)', width: 6 }} />
                </span>{' '}
                meter = <b>passage probability</b>
              </span>
              <span className="sep">·</span>
              <span className="item">
                <span className="star">
                  <StarIcon filled size={12} />
                </span>{' '}
                click to <b>untrack</b>
              </span>
            </div>

            <div className="trk-board">
              {boardColumns.map((col) => {
                const isOpen = expandedCols.has(col.id);
                const shown = isOpen ? col.bills : col.bills.slice(0, 5);
                const overflow = col.bills.length - shown.length;
                return (
                  <div key={col.id} className="trk-col" data-stage={col.id}>
                    <div className="trk-col-head">
                      <span className="seg" />
                      <span className="ttl">{col.label}</span>
                      <span className="ct num">{col.bills.length}</span>
                    </div>
                    {shown.map((b) => (
                      <BillCard
                        key={b.billId}
                        bill={b}
                        issueSet={issueSet}
                        justLanded={justLanded === b.billId}
                        onUntrack={(id) => untrackMutation.mutate(id)}
                        onOpen={(bb) => openBoardBill(bb.billId, bb.unread)}
                      />
                    ))}
                    {col.bills.length === 0 && <div className="trk-col-empty">No bills</div>}
                    {overflow > 0 && (
                      <button
                        className="trk-more"
                        onClick={() => setExpandedCols((s) => new Set(s).add(col.id))}
                      >
                        +{overflow} more
                      </button>
                    )}
                    {isOpen && col.bills.length > 5 && (
                      <button
                        className="trk-more"
                        onClick={() =>
                          setExpandedCols((s) => {
                            const n = new Set(s);
                            n.delete(col.id);
                            return n;
                          })
                        }
                      >
                        Show less
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        ))}

      {/* ===================== RECOMMENDATIONS ===================== */}
      {panel === 'recs' &&
        (recsQuery.isLoading ? (
          <div className="trk-col-empty">Finding bills to recommend…</div>
        ) : recAll.length === 0 ? (
          <div className="trk-empty">
            <div className="ico">
              <Icon name="sparkle" size={22} />
            </div>
            <h4>No new recommendations</h4>
            <p>Add tags or confirm issue areas to widen the matcher.</p>
            <button className="btn btn-accent" onClick={() => setPanel('config')}>
              Open Configure →
            </button>
          </div>
        ) : (
          <>
            <div className="rec-toolbar">
              <div className="rec-note">
                <Icon name="sparkle" size={14} style={{ color: 'var(--accent)' }} />
                <span>
                  <b>{aboveFloorCount}</b> bills match this client’s watchlist.
                </span>
                <span className="arrow">Track →</span>
                <span>
                  moves a bill onto your <b>Board</b>.
                </span>
              </div>
            </div>

            {selectMode && selected.size > 0 && (
              <div className="bulk-bar">
                <span className="ct">{selected.size} selected</span>
                <span className="spacer" />
                <button className="b-cancel" onClick={() => setSelected(new Set())}>
                  Clear
                </button>
                <button className="b-track" onClick={trackSelected}>
                  Track selected
                </button>
              </div>
            )}

            <div className="rec-grid">
              {recList.map((b: RecommendationBill) => (
                <RecCard
                  key={b.billId}
                  bill={b}
                  issueSet={issueSet}
                  selectMode={selectMode}
                  selected={selected.has(b.billId)}
                  onToggleSelect={toggleSel}
                  onTrack={trackRec}
                  onDismiss={(id) => dismissMutation.mutate(id)}
                  onOpen={(bb) => drillTo(bb.billId)}
                />
              ))}
            </div>

            {!showAll && recAll.length > aboveFloor.length && (
              <button
                className="trk-more"
                style={{ maxWidth: 320, margin: '2px auto 0' }}
                onClick={() => setShowAll(true)}
              >
                Show all ({recAll.length}) — {recAll.length - aboveFloor.length} below relevance
                floor
              </button>
            )}
            {showAll && (
              <button
                className="trk-more"
                style={{ maxWidth: 200, margin: '2px auto 0' }}
                onClick={() => setShowAll(false)}
              >
                Show fewer
              </button>
            )}
          </>
        ))}

      {/* ===================== CONFIGURE ===================== */}
      {panel === 'config' &&
        (!prefsQuery.data || watchlistQuery.isLoading || issueAreasQuery.isLoading ? (
          <div className="trk-col-empty">Loading configuration…</div>
        ) : (
          <TrackerConfigPanel
            allIssueAreas={allIssueAreas}
            watchlist={watchlistQuery.data ?? { issueAreas: [], tags: [] }}
            prefs={prefsQuery.data}
            seed={seedQuery.data}
            onSaveWatchlist={(w) => saveWatchlistMutation.mutate(w)}
            onSavePrefs={(p) => savePrefsMutation.mutate(p)}
            onRequestVerify={requestVerify}
            onTestAlert={fireTest}
          />
        ))}

      {/* ===================== MODALS + TOASTS ===================== */}
      {modal === 'addBill' && (
        <AddBillModal
          clientId={clientId}
          boardNums={boardNums}
          onTrackManual={trackManual}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'otp' && otpState.current && (
        <VerifyOtpModal
          masked={otpState.current.masked}
          devCode={otpState.current.devCode}
          submitting={smsConfirmMutation.isPending}
          onConfirm={confirmOtp}
          onResend={() =>
            otpState.current && requestVerify(otpState.current.phone, otpState.current.onVerified)
          }
          onClose={() => setModal(null)}
        />
      )}
      <TrackToasts toasts={toasts} />
    </div>
  );
}

export default TrackerTab;
