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
  return (
    <div className={`bill-card${justLanded ? ' just-landed' : ''}`} onClick={() => onOpen(bill)}>
      <div className="bc-top">
        <span className="bc-num">{bill.displayNum}</span>
        {bill.unread && <span className="bc-unread" title="Unread alert" />}
        <button
          className="bc-star"
          title="Tracked — remove from board"
          onClick={(e) => {
            e.stopPropagation();
            onUntrack(bill.billId);
          }}
        >
          <StarIcon filled />
        </button>
      </div>
      <div className="bc-title">{bill.title}</div>
      <PassageBar prob={bill.probability} />
      {bill.tags && bill.tags.length > 0 && (
        <div className="trk-tags">
          {bill.tags.slice(0, 3).map((t) => (
            <span key={t} className={`trk-tag${issueSet.has(t) ? ' issue' : ''}`}>
              {t}
            </span>
          ))}
        </div>
      )}
      <ChangeChip change={bill.change} />
    </div>
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
  return (
    <div className={`rec-card${selected ? ' selected' : ''}`}>
      <div className="rc-row1">
        {selectMode && (
          <span
            className={`rc-check${selected ? ' on' : ''}`}
            onClick={() => onToggleSelect(bill.billId)}
            title="Select"
          >
            {selected && <Icon name="check" size={12} />}
          </span>
        )}
        <span className="rc-num" onClick={() => onOpen(bill)}>
          {bill.displayNum}
        </span>
        <span style={{ marginLeft: 'auto' }}>
          <FitPill fit={bill.fit} />
        </span>
      </div>
      <div className="rc-title" onClick={() => onOpen(bill)}>
        {bill.title}
      </div>
      <PassageBar prob={bill.probability} />
      {bill.matchedTags.length > 0 && (
        <div className="trk-tags" style={{ marginBottom: 2 }}>
          {bill.matchedTags.map((t) => (
            <span key={t} className={`trk-tag${issueSet.has(t) ? ' issue' : ''}`}>
              {t}
            </span>
          ))}
        </div>
      )}
      <div className="why-line">
        <span className="wk">{bill.whyKind}</span>
        <span className="wt">{bill.why}</span>
      </div>
      <div className="rc-latest">
        <span>Latest action</span>
        <span className="dotsep">·</span>
        <span>{bill.latestAction ?? '—'}</span>
        {bill.latestActionDate && (
          <>
            <span className="dotsep">·</span>
            <span className="num">{bill.latestActionDate}</span>
          </>
        )}
      </div>
      <div className="rc-actions">
        <button className="btn-track" onClick={() => onTrack(bill.billId)}>
          <StarIcon size={13} /> Track
        </button>
        <button
          className="btn-dismiss"
          onClick={() => onDismiss(bill.billId)}
          title="Dismiss — trains the feed"
        >
          Not relevant
        </button>
        <span className="rc-open" title="Open bill detail" onClick={() => onOpen(bill)}>
          <Icon name="arrow-up-right" size={14} />
        </span>
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
}: {
  panel: string;
  setPanel: (p: 'board' | 'recs' | 'config' | 'feed') => void;
  recCount: number;
  /** Show the unified Feed tab — gated by the `tracker_v2` intel feature flag. */
  showFeed?: boolean;
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
      <button className={panel === 'config' ? 'active' : ''} onClick={() => setPanel('config')}>
        <span className="seg-cog">
          <Icon name="settings" size={13} />
        </span>{' '}
        Configure
      </button>
    </div>
  );
}
