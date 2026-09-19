import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useApi } from '../../../../lib/use-api.js';
import { useIntelFeature } from '../../../../lib/intel-feature-flags.js';
import {
  trackerPaths,
  type BillSearchResult,
  type BillStage,
} from '../../../../pages/clients/tracker/tracker-api.js';
import { intelTrackerPaths } from '../../../../pages/clients/tracker/intel-tracker-api.js';
import { CapiroModal } from '../../../components/overlays/index.js';
import { Pill } from '../portfolio-primitives.js';

/**
 * Legislative "Track bill" — vNext port of the legacy app.capiro.ai bill-search
 * flow (`AddBillModal` in pages/clients/tracker/tracker-components.tsx).
 *
 * The header button on the Legislative domain was a static <PrimaryBtn> with no
 * onClick — it did nothing. This restores the SAME capability the live app has:
 * a bill-search dialog that queries the client's jurisdictions and tracks the
 * chosen bill onto the board, driven by the SAME `bill-search` + `track`
 * endpoints (legacy `/api/…` or intel-api `/intel-api/…` per the `tracker_v2`
 * flag, exactly like TrackerTab). The visual shell is rebuilt with UUI/portfolio
 * primitives (no antd, no `.trk-*` classes) so it matches the portfolio surface.
 *
 * The actual track write is owned by the caller (LegislativePanel's
 * `trackMutation`, which invalidates the board/recommendations cache), passed in
 * as `onTrack`. The modal returns a promise from `onTrack` so a row is only
 * marked "On board" once the write resolves — the legacy P2-06 contract.
 */

const STAGE_LABEL: Record<BillStage, string> = {
  introduced: 'Introduced',
  committee: 'Committee',
  passed: 'Passed',
  enacted: 'Enacted',
};

export function AddBillModal({
  open,
  clientId,
  boardBillIds,
  onTrack,
  onClose,
}: {
  open: boolean;
  clientId: string;
  /** Bill ids already on the board — shown as "On board", never re-trackable. */
  boardBillIds: Set<string>;
  /** Returns a promise so the row waits for the write before flipping to tracked. */
  onTrack: (billId: string) => Promise<unknown>;
  onClose: () => void;
}) {
  return (
    <CapiroModal open={open} title="Track a bill" onClose={onClose}>
      {open ? (
        <AddBillBody clientId={clientId} boardBillIds={boardBillIds} onTrack={onTrack} />
      ) : null}
    </CapiroModal>
  );
}

function AddBillBody({
  clientId,
  boardBillIds,
  onTrack,
}: {
  clientId: string;
  boardBillIds: Set<string>;
  onTrack: (billId: string) => Promise<unknown>;
}) {
  const api = useApi();
  const { enabled: trackerV2, ready: flagsReady } = useIntelFeature('tracker_v2');
  const [q, setQ] = useState('');
  const [added, setAdded] = useState<Set<string>>(() => new Set());
  const [pendingId, setPendingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // The jurisdictions this client actually tracks, so the search covers the
  // state legislatures they care about (intel-api path only — the legacy
  // bill-search is Congress-only and takes no jurisdiction facet).
  const prefs = useQuery<{ jurisdictions?: string[] }>({
    queryKey: ['tracker-modal-jurisdictions', clientId],
    queryFn: async () =>
      (await api.get<{ jurisdictions?: string[] }>(intelTrackerPaths.alertPrefs(clientId))).data,
    enabled: trackerV2 && flagsReady,
    staleTime: 5 * 60_000,
    retry: false,
  });

  // DD5 semantics: an EMPTY jurisdictions list means "everything the watchlist
  // produces", so it defaults to Congress only here rather than all states.
  const clientStates = useMemo(
    () => (prefs.data?.jurisdictions ?? []).filter((j) => j && j !== 'US'),
    [prefs.data],
  );
  // Jurisdiction chips derive from the ACTUALLY ingested corpus, not a static
  // list — a newly ingested state appears without a code change.
  const corpus = useQuery<{ jurisdictions: Array<{ key: string; count: number }> }>({
    queryKey: ['bill-corpus-metadata'],
    queryFn: async () =>
      (
        await api.get<{ jurisdictions: Array<{ key: string; count: number }> }>(
          '/intel-api/legiwatch/bills/corpus-metadata',
        )
      ).data,
    enabled: trackerV2 && flagsReady,
    staleTime: 5 * 60_000,
    retry: false,
  });
  const availableJuris = useMemo(
    () => (corpus.data?.jurisdictions ?? []).map((j) => j.key),
    [corpus.data],
  );
  const [selectedJuris, setSelectedJuris] = useState<string[] | null>(null);
  // Default: everything ingested (federal + all states) — any matching bill is
  // eligible. Untouched by client watchlist scope; the user can narrow.
  const jurisdictions = selectedJuris ?? availableJuris;

  const results = useQuery<BillSearchResult[]>({
    queryKey: ['tracker-bill-search', clientId, q, jurisdictions.join(',')],
    queryFn: async () =>
      (
        await api.get<BillSearchResult[]>(
          trackerV2 ? intelTrackerPaths.billSearch(clientId) : trackerPaths.billSearch(clientId),
          { params: trackerV2 ? { q, jurisdictions } : { q } },
        )
      ).data,
    enabled: q.trim().length >= 2 && flagsReady,
    staleTime: 30_000,
  });

  const isTracked = (billId: string) => boardBillIds.has(billId) || added.has(billId);
  // A failed track write must say so on the row itself — previously the
  // rejection was swallowed here (the caller's toast is easy to miss and the
  // row just snapped back to an untouched "Track" button, reading as "the
  // click did nothing"). The message clears on the next attempt or keystroke.
  const [trackError, setTrackError] = useState<{ billId: string; message: string } | null>(null);
  const handle = (b: BillSearchResult) => {
    setPendingId(b.billId);
    setTrackError(null);
    void Promise.resolve(onTrack(b.billId))
      .then(() => setAdded((s) => new Set(s).add(b.billId)))
      .catch((error: unknown) => {
        const message =
          error instanceof Error && error.message
            ? error.message
            : 'Could not track this bill. Try again.';
        setTrackError({ billId: b.billId, message });
      })
      .finally(() => setPendingId((cur) => (cur === b.billId ? null : cur)));
  };
  const rows = results.data ?? [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={{ margin: 0, fontSize: 14, color: '#475467', textWrap: 'pretty' }}>
        {trackerV2
          ? 'Search every ingested federal and state bill by number or title — any Congress or session.'
          : 'Search Congress by number or title.'}
      </p>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          height: 40,
          padding: '0 12px',
          borderRadius: 8,
          border: '1px solid #E0DCD4',
          background: '#ffffff',
          boxShadow: '0px 1px 2px rgba(16,24,40,.05)',
        }}
      >
        <span aria-hidden style={{ fontSize: 14, color: '#667085' }}>⌕</span>
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="e.g. “transmission”, “H.R. 4455”, “data center”…"
          aria-label="Search bills"
          style={{
            flex: 1,
            minWidth: 0,
            border: 'none',
            outline: 'none',
            background: 'transparent',
            fontSize: 14,
            color: '#101828',
          }}
        />
      </div>

      {trackerV2 && availableJuris.length > 0 ? (
        <div role="group" aria-label="Jurisdictions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {availableJuris.map((j) => {
            const on = jurisdictions.includes(j);
            return (
              <button
                key={j}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setSelectedJuris(on ? jurisdictions.filter((x) => x !== j) : [...jurisdictions, j])
                }
                style={{
                  height: 28,
                  padding: '0 12px',
                  borderRadius: 9999,
                  fontSize: 13,
                  fontWeight: 600,
                  border: on ? '1px solid #101828' : '1px solid #E0DCD4',
                  background: on ? '#101828' : '#ffffff',
                  color: on ? '#ffffff' : '#344054',
                }}
              >
                {j === 'US' ? 'Congress' : j}
              </button>
            );
          })}
        </div>
      ) : null}

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 6,
          maxHeight: 360,
          overflowY: 'auto',
          borderTop: '1px solid #E8E5DF',
          paddingTop: 10,
        }}
      >
        {rows.map((b) => {
          const tracked = isTracked(b.billId);
          const pending = pendingId === b.billId;
          return (
            <div
              key={b.billId}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '10px 12px',
                borderRadius: 8,
                border: '1px solid #E8E5DF',
                background: tracked ? '#FAF9F6' : '#ffffff',
              }}
            >
              <span style={{ flex: '0 0 auto', width: 88, fontSize: 13, fontWeight: 600, color: '#101828' }}>
                {b.displayNum}
              </span>
              {b.jurisdiction ? (
                <span style={{ flex: '0 0 auto', fontSize: 12, color: '#667085' }}>
                  {b.jurisdiction === 'US' ? 'Congress' : b.jurisdiction}
                </span>
              ) : null}
              <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: '#344054', textWrap: 'pretty' }}>{b.title}</span>
              <span style={{ flex: '0 0 auto' }}>
                <Pill tone="gray" dotless>{STAGE_LABEL[b.stage]}</Pill>
              </span>
              <button
                type="button"
                disabled={pending || tracked}
                onClick={() => handle(b)}
                style={{
                  flex: '0 0 auto',
                  height: 30,
                  padding: '0 12px',
                  borderRadius: 8,
                  fontSize: 13,
                  fontWeight: 600,
                  border: tracked ? '1px solid #E0DCD4' : '1px solid #101828',
                  background: tracked ? '#ffffff' : '#101828',
                  color: tracked ? '#475467' : '#ffffff',
                  opacity: pending ? 0.6 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                {tracked ? '✓ On board' : pending ? 'Adding…' : 'Track'}
              </button>
            </div>
          );
        })}
        {trackError ? (
          <div role="alert" style={{ padding: '8px 12px', fontSize: 13, color: '#B42318' }}>
            Couldn’t track {rows.find((b) => b.billId === trackError.billId)?.displayNum ?? 'this bill'}.{' '}
            {trackError.message}
          </div>
        ) : null}
        {results.isError ? (
          <div style={{ padding: '16px 12px', fontSize: 14, color: '#B42318' }}>
            Bill search is unavailable right now. Try again in a moment.
          </div>
        ) : q.trim().length >= 2 && !results.isFetching && rows.length === 0 ? (
          <div style={{ padding: '16px 12px', fontSize: 14, color: '#667085' }}>
            No bills match “{q}”. Try a bill number or keyword.
          </div>
        ) : null}
        {q.trim().length < 2 ? (
          <div style={{ padding: '16px 12px', fontSize: 14, color: '#667085' }}>
            Type at least 2 characters to search.
          </div>
        ) : null}
      </div>

      <p style={{ margin: 0, fontSize: 12, color: '#667085' }}>
        Tracked bills appear in their legislative-stage column on the board.
      </p>
    </div>
  );
}
