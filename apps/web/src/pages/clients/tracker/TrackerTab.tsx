import { useEffect, useMemo, useRef, useState } from 'react';
import { App as AntApp } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import './tracker.css';
// The calm LegiWatch component classes (.bcard/.rcard/.board/.tagrow/.pick-chip …)
// used by this surface live here; import so they load wherever TrackerTab renders
// (Radar Bills/Configure AND the client-profile LegiWatch tab), not just on /legiwatch.
import '../../radar/legiwatch.css';
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
import { TrackerFeedPanel } from './TrackerFeedPanel.js';
import { BillDrawer } from '../../radar/BillDrawer.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { useMe } from '../../../lib/me.js';
import { isTenantAdmin } from '@capiro/shared';
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
import {
  intelTrackerPaths,
  adaptBoard,
  adaptRecs,
  adaptWatchlist,
  adaptPrefs,
  watchlistToIntel,
  prefsToIntel,
  type IntelBoard,
  type IntelRec,
  type IntelWatchlist,
  type IntelAlertPrefs,
  type IntelCompiled,
} from './intel-tracker-api.js';

type Panel = 'board' | 'recs' | 'config' | 'feed';
const PANEL_KEY = 'capiro:tracker:panel';
/** Radar Bills tab keeps its own Board|Recs selection so it never fights the profile tab's. */
const BILLS_PANEL_KEY = 'capiro:radar:bills-panel';

function loadPanel(): Panel {
  try {
    const v = window.sessionStorage.getItem(PANEL_KEY);
    if (v === 'board' || v === 'recs' || v === 'config' || v === 'feed') return v;
  } catch {
    /* ignore */
  }
  return 'board';
}

function loadBillsPanel(): Panel {
  try {
    const v = window.sessionStorage.getItem(BILLS_PANEL_KEY);
    if (v === 'board' || v === 'recs') return v;
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

export interface TrackerSurfaceProps {
  clientId: string;
  clientName: string;
  /**
   * Which slice of the tracker this instance renders:
   * - 'profile'   — the client-profile Tracker tab (Board/Recs/Feed/Configure sub-nav). Default.
   * - 'bills'     — Radar Bills tab: Board/Recs only (Feed + Watchlist are sibling Radar tabs).
   * - 'watchlist' — Radar Watchlist tab: the Configure panel only (no sub-nav).
   * All variants share the same queries/mutations (and react-query cache keys),
   * so the Radar tabs and the profile tab stay in sync for a given client.
   */
  variant?: 'profile' | 'bills' | 'watchlist';
  /** 'bills' variant: where the recs empty-state "Open Watchlist →" CTA goes (the Radar Watchlist tab). */
  onOpenConfigure?: () => void;
}

export function TrackerSurface({
  clientId,
  clientName,
  variant = 'profile',
  onOpenConfigure,
}: TrackerSurfaceProps) {
  const api = useApi();
  const qc = useQueryClient();
  const { message } = AntApp.useApp();

  const [panel, setPanelState] = useState<Panel>(
    variant === 'watchlist' ? 'config' : variant === 'bills' ? loadBillsPanel : loadPanel,
  );
  const setPanel = (p: Panel) => {
    setPanelState(p);
    try {
      if (variant === 'bills') window.sessionStorage.setItem(BILLS_PANEL_KEY, p);
      else if (variant === 'profile') window.sessionStorage.setItem(PANEL_KEY, p);
    } catch {
      /* ignore */
    }
  };
  // The unified Feed is gated by `tracker_v2` (off for all real tenants during
  // shadow). If a stale sessionStorage value selects 'feed' without the flag,
  // fall back to Board so the panel is never orphaned.
  // `flagsReady` gates every query below: the queryFns branch on trackerV2 but
  // cache under flag-agnostic trackerKeys, so a fetch fired while the flags
  // query is still loading would cache the LEGACY response and never refetch
  // when the flag resolves true.
  const { enabled: trackerV2, ready: flagsReady } = useIntelFeature('tracker_v2');
  // P1-02: firm-wide targeting is admin-only server-side. Mirror that here so a
  // non-admin sees a read-only card instead of typing edits that will 403. While
  // /me is still loading `role` is undefined — assume editable so an admin never
  // sees a flash of read-only; the server is the authority regardless.
  // An ABSENT role (still loading, a failed /me, or an older cached shape) means
  // "cannot determine" — treat it as editable rather than locking an admin out of
  // their own targeting over a transient read. The server still enforces the rule.
  const meQuery = useMe();
  const myRole = meQuery.data?.role;
  const canEditTargeting = myRole ? isTenantAdmin(myRole) : true;
  const activePanel: Panel = panel === 'feed' && !trackerV2 ? 'board' : panel;

  // Board controls
  const [sort, setSort] = useState<'prob' | 'num' | 'changed'>('prob');
  const [filter, setFilter] = useState<'all' | 'highfit' | 'highprob'>('all');
  const [menu, setMenu] = useState<string | null>(null);
  const [justLanded, setJustLanded] = useState<string | null>(null);

  // Recs controls
  const [recSort, setRecSort] = useState<'relevance' | 'probability' | 'newest'>('relevance');
  const [recTag, setRecTag] = useState('all');
  const [showAll, setShowAll] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // P1-02: targeting is SHARED firm-wide and autosaved, so the save must be
  // legible — "Saving…/Saved at HH:MM/failed + Retry/someone else changed this" —
  // rather than a silent debounce with one generic error toast.
  type SaveState =
    | { kind: 'idle' }
    | { kind: 'saving' }
    | { kind: 'saved'; at: string }
    | { kind: 'error'; message: string }
    | { kind: 'conflict'; message: string };
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  /** The in-flight payload, so Retry has something to send. */
  const lastPayloadRef = useRef<WatchlistPayload | null>(null);
  /** Server truth BEFORE the in-flight save; promoted to `undoRef` on success. */
  const preSaveRef = useRef<WatchlistPayload | null>(null);
  /** One level of undo — deliberately not a stack (Gate B e-9). */
  const undoRef = useRef<WatchlistPayload | null>(null);

  // Modals + toasts
  const [modal, setModal] = useState<'addBill' | 'otp' | null>(null);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  // P7: opening a bill shows it in a right-side drawer (spec D9 — NEVER routes to
  // Data Explorer). Shared across Board/Recs/Feed and the profile + Radar Bills tabs.
  const [drawerBillId, setDrawerBillId] = useState<string | null>(null);
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
    queryFn: async () =>
      trackerV2
        ? adaptBoard((await api.get<IntelBoard>(intelTrackerPaths.board(clientId))).data)
        : (await api.get<BoardResponse>(trackerPaths.board(clientId))).data,
    enabled: flagsReady,
  });
  const recsQuery = useQuery<RecommendationsResponse>({
    queryKey: trackerKeys.recommendations(clientId),
    queryFn: async () =>
      trackerV2
        ? adaptRecs((await api.get<IntelRec[]>(intelTrackerPaths.recommendations(clientId))).data)
        : (await api.get<RecommendationsResponse>(trackerPaths.recommendations(clientId))).data,
    staleTime: 60_000,
    enabled: flagsReady,
  });
  const issueAreasQuery = useQuery<{ issueAreas: string[] }>({
    queryKey: trackerKeys.issueAreas(),
    queryFn: async () =>
      trackerV2
        ? (await api.get<{ issueAreas: string[] }>(intelTrackerPaths.issueAreas())).data
        : (await api.get<{ issueAreas: string[] }>(trackerPaths.issueAreas())).data,
    staleTime: 60 * 60_000,
    enabled: flagsReady,
  });
  const watchlistQuery = useQuery<WatchlistPayload>({
    queryKey: trackerKeys.watchlist(clientId),
    queryFn: async () =>
      trackerV2
        ? adaptWatchlist((await api.get<IntelWatchlist>(intelTrackerPaths.watchlist(clientId))).data)
        : (await api.get<WatchlistPayload>(trackerPaths.watchlist(clientId))).data,
    enabled: activePanel === 'config' && flagsReady,
  });
  const prefsQuery = useQuery<AlertPrefsPayload>({
    queryKey: trackerKeys.alertPrefs(clientId),
    queryFn: async () =>
      trackerV2
        ? adaptPrefs((await api.get<IntelAlertPrefs>(intelTrackerPaths.alertPrefs(clientId))).data)
        : (await api.get<AlertPrefsPayload>(trackerPaths.alertPrefs(clientId))).data,
    enabled: activePanel === 'config' && flagsReady,
  });
  // P0-04 b-7/c-8: which surfaces each typed-term type feeds — a static preview
  // the Configure editor shows next to the type picker. intel-api only (the
  // legacy tracker has no equivalent), and only needed while Configure is open.
  const compiledQuery = useQuery<IntelCompiled>({
    queryKey: trackerKeys.compiled(clientId),
    queryFn: async () =>
      (await api.get<IntelCompiled>(intelTrackerPaths.compiled(clientId))).data,
    enabled: activePanel === 'config' && flagsReady && trackerV2,
    staleTime: 60 * 60_000,
  });
  // Suggestions to seed the watchlist from the client profile (capability tags +
  // sector → issue area). Excludes anything already configured.
  const seedQuery = useQuery<SeedSuggestions>({
    queryKey: trackerKeys.seed(clientId),
    queryFn: async () =>
      trackerV2
        ? (await api.get<SeedSuggestions>(intelTrackerPaths.seedSuggestions(clientId))).data
        : (await api.get<SeedSuggestions>(trackerPaths.seedSuggestions(clientId))).data,
    enabled: activePanel === 'config' && flagsReady,
    staleTime: 5 * 60_000,
  });

  const allIssueAreas = issueAreasQuery.data?.issueAreas ?? [];
  const issueSet = useMemo(() => new Set(allIssueAreas), [allIssueAreas]);
  // P0-06 FALLBACK ONLY. This derives the high-priority tag set from the watchlist
  // query, which is `enabled` only while Configure is open — so on the Radar Bills
  // surface (where Configure is a sibling tab, a different TrackerSurface instance)
  // it is always empty. The intel board now sends `matchedHighPriorityTopics` and
  // the filter prefers that; this remains the only thing that makes High-fit work on
  // the LEGACY (tracker_v2 off) board, so do not delete it as dead code.
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
    }) =>
      trackerV2
        ? (await api.post(intelTrackerPaths.track(clientId), { billId, source })).data
        : (await api.post(trackerPaths.track(clientId), { billId, source })).data,
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
      trackerV2
        ? (await api.post(intelTrackerPaths.untrack(clientId), { billId })).data
        : (await api.delete(trackerPaths.untrack(clientId, billId))).data,
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
      trackerV2
        ? (await api.post(intelTrackerPaths.feedback(clientId), { targetRef: billId, signal: 'marked_irrelevant' })).data
        : (await api.post(trackerPaths.feedback(clientId), { billId, signal: 'marked_irrelevant' })).data,
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
      trackerV2
        ? (await api.post(intelTrackerPaths.feedback(clientId), { targetRef: billId, signal: 'opened' })).data
        : (await api.post(trackerPaths.feedback(clientId), { billId, signal: 'opened' })).data,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: trackerKeys.board(clientId) });
      void qc.invalidateQueries({ queryKey: trackerKeys.summary(clientId) });
    },
  });

  const saveWatchlistMutation = useMutation({
    mutationFn: async (w: WatchlistPayload) =>
      trackerV2
        ? adaptWatchlist(
            (await api.put<IntelWatchlist>(intelTrackerPaths.watchlist(clientId), watchlistToIntel(w))).data,
          )
        : // State Legislation Platform (DD5) is intel-api-only — the legacy
          // WatchlistDto has no `jurisdictions` field and the API's global
          // ValidationPipe runs forbidNonWhitelisted:true, so forwarding it
          // here would 400 the save. Strip before hitting the legacy endpoint.
          (
            await api.put<WatchlistPayload>(trackerPaths.watchlist(clientId), {
              issueAreas: w.issueAreas,
              tags: w.tags,
            })
          ).data,
    onMutate: (w) => {
      lastPayloadRef.current = w;
      preSaveRef.current =
        qc.getQueryData<WatchlistPayload>(trackerKeys.watchlist(clientId)) ?? null;
      setSaveState({ kind: 'saving' });
    },
    onSuccess: (data) => {
      // The state that was persisted BEFORE this save is what Undo restores.
      undoRef.current = preSaveRef.current;
      setSaveState({
        kind: 'saved',
        at: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      });
      // Seed the cache with the server-normalized value so the Configure form
      // (and recs) reflect what was actually persisted.
      qc.setQueryData(trackerKeys.watchlist(clientId), data);
      void qc.invalidateQueries({ queryKey: trackerKeys.recommendations(clientId) });
      // Refresh seed suggestions only AFTER the save persists — otherwise the
      // refetch races the debounced PUT and returns stale (still-importable) rows.
      void qc.invalidateQueries({ queryKey: trackerKeys.seed(clientId) });
    },
    onError: (e: unknown) => {
      const res = (
        e as { response?: { status?: number; data?: { code?: string; message?: string } } }
      ).response;
      if (res?.status === 409 && res.data?.code === 'WATCHLIST_VERSION_CONFLICT') {
        // P1-02: another analyst saved first. Do NOT auto-merge — refetch their
        // version and say so. The Configure resync adopts it once isPending clears,
        // so this user's unsaved edits are replaced, which is the honest outcome.
        setSaveState({
          kind: 'conflict',
          message: res.data.message ?? 'Someone else changed this client’s targeting.',
        });
        void qc.invalidateQueries({ queryKey: trackerKeys.watchlist(clientId) });
        return;
      }
      if (res?.status === 403 && res.data?.code === 'TARGETING_EDIT_FORBIDDEN') {
        // P1-02: not an admin. Surface the server's own wording rather than a
        // generic failure, and do not offer Retry — retrying cannot succeed.
        setSaveState({
          kind: 'conflict',
          message: res.data.message ?? 'Only an admin can change firm-wide targeting.',
        });
        return;
      }
      setSaveState({ kind: 'error', message: 'Could not save targeting.' });
    },
  });
  /** Retry the failed save against the CURRENT server version, not the stale one. */
  const retrySaveWatchlist = () => {
    const p = lastPayloadRef.current;
    if (!p) return;
    const version = qc.getQueryData<WatchlistPayload>(trackerKeys.watchlist(clientId))?.version;
    saveWatchlistMutation.mutate({ ...p, version: version ?? p.version });
  };
  /**
   * Restore the previously persisted targeting through the same versioned PUT, at
   * the CURRENT version — so an undo still 409s if someone else has saved since
   * (which is the point), but does not 409 merely because it is an undo.
   */
  const undoSaveWatchlist = () => {
    const p = undoRef.current;
    if (!p) return;
    undoRef.current = null;
    const version = qc.getQueryData<WatchlistPayload>(trackerKeys.watchlist(clientId))?.version;
    saveWatchlistMutation.mutate({ ...p, version: version ?? p.version });
  };
  const savePrefsMutation = useMutation({
    mutationFn: async (p: AlertPrefsPayload) =>
      trackerV2
        ? adaptPrefs((await api.put<IntelAlertPrefs>(intelTrackerPaths.alertPrefs(clientId), prefsToIntel(p))).data)
        : // Same DD5 rationale as saveWatchlistMutation — the legacy AlertPrefsDto
          // has no `jurisdictions` field and would 400 under forbidNonWhitelisted.
          (
            await api.put<AlertPrefsPayload>(trackerPaths.alertPrefs(clientId), {
              triggers: p.triggers,
              materiality: p.materiality,
              emailEnabled: p.emailEnabled,
              emailAddress: p.emailAddress,
              emailCadence: p.emailCadence,
              smsEnabled: p.smsEnabled,
              smsPhone: p.smsPhone,
              smsPhoneVerified: p.smsPhoneVerified,
              smsCadence: p.smsCadence,
              quietHoursStart: p.quietHoursStart,
              quietHoursEnd: p.quietHoursEnd,
            })
          ).data,
    onSuccess: (data) => qc.setQueryData(trackerKeys.alertPrefs(clientId), data),
    onError: () => message.error('Could not save alert preferences'),
  });

  const smsStartMutation = useMutation({
    mutationFn: async (phone: string) =>
      (
        await api.post(
          trackerV2 ? intelTrackerPaths.smsStart(clientId) : trackerPaths.smsStart(clientId),
          { phone },
        )
      ).data as {
        dormant: boolean;
        masked: string;
        devCode?: string;
      },
  });
  const smsConfirmMutation = useMutation({
    mutationFn: async ({ phone, code }: { phone: string; code: string }) =>
      (
        await api.post(
          trackerV2 ? intelTrackerPaths.smsConfirm(clientId) : trackerPaths.smsConfirm(clientId),
          { phone, code },
        )
      ).data,
  });
  const testAlertMutation = useMutation({
    mutationFn: async (channels: ('email' | 'sms' | 'in_app')[]) =>
      (
        await api.post(
          trackerV2 ? intelTrackerPaths.testAlert(clientId) : trackerPaths.testAlert(clientId),
          { channels },
        )
      ).data as {
        channel: string;
        status: string;
        detail?: string;
      }[],
  });

  // ── Handlers ────────────────────────────────────────────────────────────
  // P7: open the bill in the side-drawer instead of navigating to Data Explorer.
  const drillTo = (billId: string) => setDrawerBillId(billId);
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
        // P1-05: report EVERY requested channel's real outcome. The old code kept only
        // sent|suppressed and fell back to ['In-app'], so an email failure or skip
        // produced a success toast naming only In-app.
        pushToast({
          kind: 'test',
          results: res.map((r) => ({ channel: label[r.channel] ?? r.channel, status: r.status, detail: r.detail })),
        });
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
          ? // P0-06: prefer the SERVER's high-priority topic list. The old
            // `b.tags.some(t => highPrio.has(t))` read a watchlist query that is
            // enabled only when activePanel === 'config', which never happens on
            // the Bills surface — so High-fit deterministically matched nothing
            // there. `!== undefined` (not truthiness) so an empty array from the
            // server correctly means "no high-priority match", while an ABSENT
            // field means "legacy board, fall back".
            b.matchedHighPriorityTopics !== undefined
            ? b.matchedHighPriorityTopics.length > 0
            : b.tags.some((t) => highPrio.has(t))
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

  // LegiWatch v2 (L2): the Bills tab shows Recommendations ABOVE the board (both
  // always visible), not a Board|Recs toggle. Extract the two control groups so
  // they render either in the profile sub-nav header OR in each stacked section.
  const billsStacked = variant === 'bills';

  const boardControls = (
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
  );

  const recsControls = (
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
  );

  return (
    <div className="trk">
      {/* header: sub-nav + contextual controls (the watchlist variant renders
          the Configure panel bare — Radar owns its tab strip) */}
      {/* Profile variant keeps the Board|Recs|Feed|Configure sub-nav toggle. The
          Radar/LegiWatch Bills tab (billsStacked) renders Recs-above-Board instead
          (each section carries its own controls — see below). */}
      {variant === 'profile' && (
        <div className="trk-head">
          <SubNav
            panel={activePanel}
            setPanel={setPanel}
            recCount={aboveFloorCount}
            showFeed={trackerV2}
            showConfig
          />
          <div className="trk-spacer" />
          {activePanel === 'board' && boardControls}
          {activePanel === 'recs' && recsControls}
        </div>
      )}

      {/* LegiWatch v2 (L2): Bills tab — "Recommended by Meri" section header, always
          above the board. Calm re-skin: Meri orb + title/subtext + controls. */}
      {billsStacked && (
        <div className="sec-head">
          <span className="orb">
            <Icon name="sparkle" size={14} style={{ color: '#fff' }} />
          </span>
          <div className="st">
            <b>Recommended by Meri</b>
            <p>Bills scored against {clientName}’s watchlist — add the ones worth following to your board.</p>
          </div>
          <span className="grow" />
          {recsControls}
        </div>
      )}

      {/* ===================== RECOMMENDATIONS ===================== */}
      {/* LegiWatch v2 (L2): on the Bills tab (billsStacked) this renders ABOVE the
          board and is ALWAYS visible; the profile variant still toggles it. */}
      {(billsStacked || activePanel === 'recs') &&
        (recsQuery.isPending ? (
          <div className="trk-col-empty">Finding bills to recommend…</div>
        ) : recAll.length === 0 ? (
          <div className="guide">
            <div className="gico">
              <Icon name="sparkle" size={20} />
            </div>
            <h4>No new recommendations</h4>
            <p>Add tags or confirm issue areas to widen the matcher.</p>
            <div className="row">
              <button
                className="btn btn-accent"
                onClick={() => (variant === 'bills' ? onOpenConfigure?.() : setPanel('config'))}
              >
                Open Configure →
              </button>
            </div>
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

            <div className="recs">
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

      {/* Board section header for the stacked Bills tab (L2). Calm re-skin. */}
      {billsStacked && (
        <div className="sec-head" style={{ marginTop: 22 }}>
          <span className="orb" style={{ background: 'var(--bg-dark)' }}>
            <StarIcon size={13} />
          </span>
          <div className="st">
            <b>Your board</b>
            <p>Bills you track, grouped by live legislative status — updates automatically.</p>
          </div>
          <span className="grow" />
          {boardControls}
          <span className="chip muted">{boardCount} tracked</span>
        </div>
      )}

      {/* ===================== BOARD ===================== */}
      {/* isPending (not isLoading) so the flag-gated window renders as loading,
          not as a flash of the zero-bill empty state. */}
      {(billsStacked || activePanel === 'board') &&
        (boardQuery.isPending ? (
          <div className="trk-col-empty">Loading tracked bills…</div>
        ) : boardCount === 0 ? (
          <div className="guide">
            <div className="gico">
              <StarIcon size={20} />
            </div>
            <h4>Your board is empty</h4>
            <p>
              The board fills in as you track bills. Start from the {aboveFloorCount} recommendations
              Capiro scored against {clientName}’s watchlist.
            </p>
            {!billsStacked && (
              <div className="row">
                <button className="btn btn-accent" onClick={() => setPanel('recs')}>
                  Review {aboveFloorCount} recommended bills →
                </button>
              </div>
            )}
          </div>
        ) : (
          <div className="board">
            {/* P0-06: a filter that legitimately matches nothing used to render as
                four "Nothing here" columns — indistinguishable from an empty board,
                which is exactly why the broken High-fit filter went unnoticed. Say
                which filter is hiding the cards and offer the way out. */}
            {filter !== 'all' && boardCount > 0 && boardColumns.every((c) => c.bills.length === 0) ? (
              <div className="trk-col-empty" style={{ gridColumn: '1 / -1' }}>
                No tracked bills match the “
                {filter === 'highfit' ? 'High-fit (priority tag)' : 'High-probability (≥70%)'}”
                filter.{' '}
                <button className="btn-link" onClick={() => setFilter('all')}>
                  Show all {boardCount}
                </button>
              </div>
            ) : (
              boardColumns.map((col) => (
                <div key={col.id} className="bcol" data-stage={col.id}>
                  <div className="bcol-head">
                    <span className="sq" />
                    <span className="ttl">{col.label}</span>
                    <span className="ct num">{col.bills.length}</span>
                  </div>
                  {col.bills.length === 0 ? (
                    <div className="bcol-empty">Nothing here</div>
                  ) : (
                    col.bills.map((b) => (
                      <BillCard
                        key={b.billId}
                        bill={b}
                        issueSet={issueSet}
                        justLanded={justLanded === b.billId}
                        onUntrack={(id) => untrackMutation.mutate(id)}
                        onOpen={(bb) => openBoardBill(bb.billId, bb.unread)}
                      />
                    ))
                  )}
                </div>
              ))
            )}
          </div>
        ))}

      {/* ===================== CONFIGURE ===================== */}
      {activePanel === 'config' &&
        (!prefsQuery.data || watchlistQuery.isLoading || issueAreasQuery.isLoading ? (
          <div className="trk-col-empty">Loading configuration…</div>
        ) : (
          <TrackerConfigPanel
            allIssueAreas={allIssueAreas}
            clientName={clientName}
            watchlist={watchlistQuery.data ?? { issueAreas: [], tags: [] }}
            prefs={prefsQuery.data}
            seed={seedQuery.data}
            onSaveWatchlist={(w) => saveWatchlistMutation.mutate(w)}
            onSavePrefs={(p) => savePrefsMutation.mutate(p)}
            onRequestVerify={requestVerify}
            onTestAlert={fireTest}
            // P0-05 c-9: while a save is in flight, the resync effect must not
            // clobber in-progress edits with the (about to be stale) server value.
            saving={saveWatchlistMutation.isPending}
            // P1-02 e-7/e-9: legible save state + Retry + one level of Undo.
            saveState={saveState}
            onRetrySave={retrySaveWatchlist}
            onUndoSave={undoSaveWatchlist}
            canUndo={undoRef.current !== null}
            canEditTargeting={canEditTargeting}
            // P0-04 c-8: surfaces each typed-term type affects, for the editor preview.
            termSurfaces={compiledQuery.data?.termSurfaces}
            typedTermsEnabled={trackerV2}
            // State Legislation Platform (DD4/DD5) is intel-api-only — the
            // legacy (pre-tracker_v2) watchlist/prefs can't persist
            // jurisdictions at all, so the selectors are hidden rather than
            // rendering a control that silently no-ops on save.
            jurisdictionsEnabled={trackerV2}
          />
        ))}

      {/* ===================== FEED (unified bill|hearing|combined) ===================== */}
      {activePanel === 'feed' && trackerV2 && (
        <TrackerFeedPanel clientId={clientId} clientName={clientName} onOpenBill={drillTo} />
      )}

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

      {/* ===================== BILL SIDE-DRAWER (P7 + P9) ===================== */}
      {/* Same detail as Data Explorer (shared BillDetailBody), no navigation.
          P9.1: shows "Track for <client>" when the bill isn't on the board (reuses
          trackMutation). P9.2: shows the "Discussed in hearings" section inside. */}
      <BillDrawer
        open={drawerBillId !== null}
        billId={drawerBillId}
        clientId={clientId}
        clientName={clientName}
        isTracked={drawerBillId ? boardNums.has(drawerBillId) : false}
        onTrack={(billId) => {
          trackMutation.mutate({ billId, source: 'manual_search' });
          pushToast({ text: `Tracking for ${clientName}` });
        }}
        onClose={() => setDrawerBillId(null)}
      />
    </div>
  );
}

/**
 * The client-profile Tracker tab — the original surface, unchanged. Kept as a
 * thin wrapper over TrackerSurface so ClientProfilePage (and existing deep
 * links) behave exactly as before the Radar (P4) extraction.
 */
export function TrackerTab({ clientId, clientName }: { clientId: string; clientName: string }) {
  return <TrackerSurface clientId={clientId} clientName={clientName} variant="profile" />;
}

export default TrackerTab;
