import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../lib/use-api.js';
import { useIntelFeature } from '../../../lib/intel-feature-flags.js';
import { Icon, StarIcon } from './tracker-icons.js';
import {
  probClass,
  trackerPaths,
  type BillSearchResult,
  type BoardBill,
  type RecommendationBill,
} from './tracker-api.js';
import { intelTrackerPaths } from './intel-tracker-api.js';

export function PassageBar({ prob }: { prob: number }) {
  const percent = Math.round(prob > 1 ? prob : prob * 100);
  return (
    <div className={`passage ${probClass(prob)}`} title={`Passage probability ${percent}%`}>
      <div className="bar">
        <span style={{ width: `${percent}%` }} />
      </div>
      <span className="pct">{percent}%</span>
    </div>
  );
}

export function FitPill({ fit }: { fit: number }) {
  return (
    <span className="fit-pill" title="Recommendation fit score (0–1)">
      <span className="fl">Fit</span>
      {fit.toFixed(2)}
    </span>
  );
}

export function ChangeChip({ change }: { change: BoardBill['change'] }) {
  if (!change) return null;
  return (
    <span className={`change-chip ${change.tone}`}>
      {change.dot && <span className="cd" />}
      {change.label}
    </span>
  );
}

export function BillCard({
  bill,
  issueSet,
  justLanded,
  onUntrack,
  onOpen,
}: {
  bill: BoardBill;
  issueSet: Set<string>;
  justLanded: boolean;
  onUntrack: (billId: string) => void;
  onOpen: (bill: BoardBill) => void;
}) {
  // LegiWatch v2 calm re-skin: `.bcard` — bill number + unread + change dot on top,
  // title, passage meter, then a foot row of issue/hearing chips. Click opens the
  // side-drawer; the small filled star untracks (kept off the prototype's chrome
  // but preserved so the board isn't read-only without the drawer).
  return (
    <div className={`bcard${justLanded ? ' just-landed' : ''}`} onClick={() => onOpen(bill)}>
      <div className="b-top">
        <span className="b-num">{bill.displayNum}</span>
        {bill.unread && <span className="b-unread" title="Unseen change" />}
        <span className="grow" />
        {bill.change && (
          <span
            className={`dot ${bill.change.tone}`}
            style={{ width: 7, height: 7 }}
            title={bill.change.label}
          />
        )}
        <button
          className="bc-untrack"
          title="Tracked — remove from board"
          style={{
            border: 'none',
            background: 'none',
            padding: 0,
            cursor: 'pointer',
            color: 'var(--ink-4)',
            display: 'inline-flex',
          }}
          onClick={(e) => {
            e.stopPropagation();
            onUntrack(bill.billId);
          }}
        >
          <StarIcon filled size={12} />
        </button>
      </div>
      <div className="b-title">{bill.title}</div>
      <PassageBar prob={bill.probability} />
      <div className="b-foot">
        {(bill.tags ?? []).slice(0, 2).map((t) => (
          <span key={t} className={`chip ${issueSet.has(t) ? 'issue' : 'muted'}`} style={{ fontSize: 10.5 }}>
            {t}
          </span>
        ))}
        <HearingChip bill={bill} onOpen={onOpen} />
      </div>
    </div>
  );
}

/**
 * P9.2 (Bill→Hearing interlink): "discussed in N hearings" chip on a board card.
 * Shown when the bill has hearing links (hearingCount>0, or a lastHearingSessionId
 * badge as a fallback). Opening it opens the same bill drawer — which shows the
 * "Discussed in hearings" section with the exact moments.
 */
export function HearingChip({
  bill,
  onOpen,
}: {
  bill: BoardBill;
  onOpen: (bill: BoardBill) => void;
}) {
  // Gate purely on the board's hearingCount (authoritative, excludes
  // dismissed/snoozed/suppressed). lastHearingSessionId is a linker watermark
  // that is never cleared, so keying off it left a stale "In hearings" chip
  // opening an empty drawer after a user dismissed every hearing alert for the
  // bill (P7/P9 review finding).
  const count = bill.hearingCount ?? 0;
  if (count <= 0) return null;
  return (
    <button
      className="chip"
      title="Discussed in hearings — open to see the moments"
      style={{
        cursor: 'pointer',
        border: 'none',
        background: 'var(--info-soft)',
        color: 'var(--info)',
        fontWeight: 600,
        fontSize: 10.5,
      }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(bill);
      }}
    >
      in {count} hearing{count > 1 ? 's' : ''}
    </button>
  );
}

export function RecCard({
  bill,
  issueSet,
  selectMode,
  selected,
  onToggleSelect,
  onTrack,
  onDismiss,
  onOpen,
}: {
  bill: RecommendationBill;
  issueSet: Set<string>;
  selectMode: boolean;
  selected: boolean;
  onToggleSelect: (billId: string) => void;
  onTrack: (billId: string) => void;
  onDismiss: (billId: string) => void;
  onOpen: (bill: RecommendationBill) => void;
}) {
  // LegiWatch v2 calm re-skin: `.rcard` — a violet-edged card with the big FIT
  // score on the left, the "why it matches" prose, sponsor, and a Track action.
  const fitPct = Math.round(bill.fit > 1 ? bill.fit : bill.fit * 100);
  const sponsor =
    bill.sponsorName != null
      ? `${bill.sponsorName}${bill.sponsorParty ? ` (${bill.sponsorParty})` : ''}`
      : bill.latestActionDate;
  return (
    <div className={`rcard${selected ? ' selected' : ''}`}>
      <div className="r-fit">
        <span className="fnum">{fitPct}</span>
        <span className="flab">Fit</span>
      </div>
      <div className="r-main">
        <div className="row" style={{ gap: 8 }}>
          {selectMode && (
            <span
              className={`rc-check${selected ? ' on' : ''}`}
              onClick={() => onToggleSelect(bill.billId)}
              title="Select"
            >
              {selected && <Icon name="check" size={12} />}
            </span>
          )}
          <span className="r-num" onClick={() => onOpen(bill)} style={{ cursor: 'pointer' }}>
            {bill.displayNum}
          </span>
        </div>
        <div className="r-title" onClick={() => onOpen(bill)} style={{ cursor: 'pointer' }}>
          {bill.title}
        </div>
        <div className="r-why">{bill.why}</div>
        <div className="r-foot">
          {bill.matchedTags.slice(0, 2).map((t) => (
            <span key={t} className={`chip ${issueSet.has(t) ? 'issue' : 'muted'}`} style={{ fontSize: 10.5 }}>
              {t}
            </span>
          ))}
          {sponsor && <span className="mini muted num">{sponsor}</span>}
        </div>
      </div>
      <div className="r-act" style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 6 }}>
        <button className="btn btn-accent sm" onClick={() => onTrack(bill.billId)}>
          <Icon name="plus" size={11} /> Track
        </button>
        <button
          className="btn btn-ghost sm"
          onClick={() => onDismiss(bill.billId)}
          title="Dismiss — trains the feed"
        >
          Not relevant
        </button>
      </div>
    </div>
  );
}

export function Modal({
  size = 'sm',
  children,
  onClose,
}: {
  size?: 'sm' | 'md';
  children: React.ReactNode;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="trk-overlay" onClick={onClose}>
      <div className={`trk-dialog ${size}`} onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}

export function AddBillModal({
  clientId,
  boardNums,
  onTrackManual,
  onClose,
}: {
  clientId: string;
  boardNums: Set<string>;
  onTrackManual: (bill: BillSearchResult) => void;
  onClose: () => void;
}) {
  const api = useApi();
  // P1.1: bill-search is served by intel-api (legacy-identical shape) when the
  // tenant is on tracker_v2 — same `trackerV2 ? intel : legacy` pattern as TrackerTab,
  // including the `flagsReady` gate (don't cache a legacy hit under the
  // flag-agnostic key before the flag resolves).
  const { enabled: trackerV2, ready: flagsReady } = useIntelFeature('tracker_v2');
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const results = useQuery<BillSearchResult[]>({
    queryKey: ['tracker-bill-search', clientId, q],
    queryFn: async () =>
      (
        await api.get<BillSearchResult[]>(
          trackerV2 ? intelTrackerPaths.billSearch(clientId) : trackerPaths.billSearch(clientId),
          { params: { q } },
        )
      ).data,
    enabled: q.trim().length >= 2 && flagsReady,
    staleTime: 30_000,
  });

  const isTracked = (billId: string) => boardNums.has(billId) || added.has(billId);
  const handle = (b: BillSearchResult) => {
    onTrackManual(b);
    setAdded((s) => new Set(s).add(b.billId));
  };
  const rows = results.data ?? [];

  return (
    <Modal size="md" onClose={onClose}>
      <div className="dlg-head">
        <h3>Add a bill to the board</h3>
        <span className="sub">Search the congressional record by number or title</span>
        <button className="dlg-x" onClick={onClose}>
          <Icon name="plus" size={15} style={{ transform: 'rotate(45deg)' }} />
        </button>
      </div>
      <div className="dlg-body">
        <div className="search-field">
          <Icon name="search" size={15} />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="e.g. “transmission”, “H.R. 4455”, “data center”…"
          />
        </div>
        <div className="search-results">
          {rows.map((b) => (
            <div key={b.billId} className={`sr-row${isTracked(b.billId) ? ' tracked' : ''}`}>
              <span className="sr-num">{b.displayNum}</span>
              <span className="sr-title">{b.title}</span>
              <span className="sr-stage">
                {b.stage === 'passed'
                  ? 'Passed'
                  : b.stage === 'committee'
                    ? 'Committee'
                    : b.stage === 'enacted'
                      ? 'Enacted'
                      : 'Introduced'}
              </span>
              <button className="sr-track" onClick={() => handle(b)}>
                {isTracked(b.billId) ? '✓ On board' : 'Track'}
              </button>
            </div>
          ))}
          {q.trim().length >= 2 && !results.isFetching && rows.length === 0 && (
            <div className="search-empty">No bills match “{q}”. Try a bill number or keyword.</div>
          )}
          {q.trim().length < 2 && (
            <div className="search-empty">Type at least 2 characters to search.</div>
          )}
        </div>
      </div>
      <div className="dlg-foot">
        <span style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
          Tracked bills appear instantly in their legislative-stage column.
        </span>
        <button className="btn" style={{ marginLeft: 'auto' }} onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}

export function VerifyOtpModal({
  masked,
  devCode,
  onConfirm,
  onResend,
  onClose,
  submitting,
}: {
  masked: string;
  devCode?: string;
  onConfirm: (code: string) => void;
  onResend: () => void;
  onClose: () => void;
  submitting?: boolean;
}) {
  const [digits, setDigits] = useState<string[]>(['', '', '', '', '', '']);
  const refs = useRef<Array<HTMLInputElement | null>>([]);
  useEffect(() => {
    refs.current[0]?.focus();
  }, []);

  const setD = (i: number, v: string) => {
    if (!/^\d?$/.test(v)) return;
    setDigits((d) => {
      const n = [...d];
      n[i] = v;
      return n;
    });
    if (v && i < 5) refs.current[i + 1]?.focus();
  };
  const onKey = (i: number, e: React.KeyboardEvent) => {
    if (e.key === 'Backspace' && !digits[i] && i > 0) refs.current[i - 1]?.focus();
  };
  const code = digits.join('');
  const full = code.length === 6;

  return (
    <Modal size="sm" onClose={onClose}>
      <div className="dlg-head">
        <h3>Verify your phone</h3>
        <button className="dlg-x" onClick={onClose}>
          <Icon name="plus" size={15} style={{ transform: 'rotate(45deg)' }} />
        </button>
      </div>
      <div className="dlg-body">
        <div className="otp-meta" style={{ marginBottom: 14 }}>
          We texted a 6-digit code to <span className="ph">{masked}</span>
        </div>
        <div className="otp-row">
          {digits.map((d, i) => (
            <input
              key={i}
              ref={(el) => (refs.current[i] = el)}
              className={`otp-box${d ? ' filled' : ''}`}
              inputMode="numeric"
              maxLength={1}
              value={d}
              onChange={(e) => setD(i, e.target.value.slice(-1))}
              onKeyDown={(e) => onKey(i, e)}
            />
          ))}
        </div>
        <button className="otp-resend" onClick={onResend}>
          Didn’t get it? Resend code
        </button>
        {devCode && (
          <div className="otp-dev">
            SMS delivery isn’t live yet — dev code: <strong>{devCode}</strong>
          </div>
        )}
      </div>
      <div className="dlg-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-accent"
          style={{
            marginLeft: 'auto',
            opacity: full && !submitting ? 1 : 0.5,
            pointerEvents: full && !submitting ? 'auto' : 'none',
          }}
          onClick={() => onConfirm(code)}
        >
          <Icon name="check" size={14} /> Confirm &amp; enable SMS
        </button>
      </div>
    </Modal>
  );
}

export interface ToastItem {
  id: string;
  kind?: 'track' | 'test' | 'text';
  num?: string;
  text?: string;
  channels?: string[];
}

export function TrackToasts({ toasts }: { toasts: ToastItem[] }) {
  return (
    <div className="trk-toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`trk-toast${t.kind === 'test' ? ' test' : ''}`}>
          <span className="ti">
            <Icon name="check" size={12} />
          </span>
          {t.kind === 'test' ? (
            <>
              <span>Sample alert sent</span>
              <span className="t-chips">
                {(t.channels ?? []).map((c) => (
                  <span key={c} className="t-chip">
                    {c}
                  </span>
                ))}
              </span>
            </>
          ) : t.num ? (
            <span>
              Added to board · <span className="tnum">{t.num}</span>
            </span>
          ) : (
            <span>{t.text}</span>
          )}
        </div>
      ))}
    </div>
  );
}

export interface DropOption {
  v: string;
  l: string;
}

export function TrkDropdown({
  open,
  onToggle,
  label,
  value,
  options,
  onSelect,
}: {
  open: boolean;
  onToggle: () => void;
  label: string;
  value: string;
  options: DropOption[];
  onSelect: (v: string) => void;
}) {
  return (
    <div className="trk-drop" onClick={(e) => e.stopPropagation()}>
      <button className="trk-drop-btn" onClick={onToggle}>
        <span className="lab">{label}</span>
        <span className="val">{(options.find((o) => o.v === value) || {}).l}</span>
        <Icon name="chev-r" size={13} style={{ transform: 'rotate(90deg)' }} />
      </button>
      {open && (
        <div className="trk-menu">
          {options.map((o) => (
            <div
              key={o.v}
              className={`opt${o.v === value ? ' sel' : ''}`}
              onClick={() => onSelect(o.v)}
            >
              {o.l}
              <span className={`ck${o.v === value ? '' : ' hidden'}`}>
                <Icon name="check" size={13} />
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SubNav({
  panel,
  setPanel,
  recCount,
  showFeed,
  showConfig = true,
}: {
  panel: string;
  setPanel: (p: 'board' | 'recs' | 'config' | 'feed') => void;
  recCount: number;
  /** Show the unified Feed tab — gated by the `tracker_v2` intel feature flag. */
  showFeed?: boolean;
  /** Hide Configure in the Radar Bills embedding (Watchlist is a sibling Radar tab). */
  showConfig?: boolean;
}) {
  return (
    <div className="trk-seg">
      <button className={panel === 'board' ? 'active' : ''} onClick={() => setPanel('board')}>
        Board
      </button>
      <button className={panel === 'recs' ? 'active' : ''} onClick={() => setPanel('recs')}>
        Recommendations {recCount > 0 && <span className="seg-badge">{recCount}</span>}
      </button>
      {showFeed && (
        <button className={panel === 'feed' ? 'active' : ''} onClick={() => setPanel('feed')}>
          Feed
        </button>
      )}
      {showConfig && (
        <button className={panel === 'config' ? 'active' : ''} onClick={() => setPanel('config')}>
          <span className="seg-cog">
            <Icon name="settings" size={13} />
          </span>{' '}
          Configure
        </button>
      )}
    </div>
  );
}
