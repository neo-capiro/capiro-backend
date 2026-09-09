import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  useBillHearings,
  type BillHearing,
} from '../../../../pages/clients/tracker/bill-hearings-api.js';
import { CapiroDrawer } from '../../../components/overlays/index.js';
import { Pill } from '../portfolio-primitives.js';
import type { PillTone } from '../portfolio-primitives.js';
import type { BoardBill } from '../../../../pages/clients/tracker/tracker-api.js';

/**
 * Legislative — tracked-bill "latest updates" drawer.
 *
 * Clicking a bill on the Tracked-bills board (or table) opens this right-side
 * panel showing the latest updates for THIS client's tracked copy of the bill:
 * its current canonical status, the most recent official action + date, the
 * change chip the board computed, the analyst note, and — on tracker_v2 tenants
 * — the hearings where the bill was discussed (the same Bill→Hearing interlink
 * the legacy Radar `BillDrawer` surfaced), each with the exact moments
 * (timestamp / speaker / quote).
 *
 * Everything rendered here is data the board response ALREADY carried
 * (`latestActionText`, `latestActionDate`, `canonicalStatus`, `change`, `note`,
 * `probability`, `tags`) plus the lazily-fetched per-bill hearings — nothing is
 * invented. The panel is read-only; it never fabricates an update that no
 * source produced.
 */

const CHANGE_TONE: Record<string, PillTone> = {
  critical: 'error',
  notable: 'warning',
  info: 'blue',
  success: 'success',
};

function passagePct(probability: number): number {
  return Math.round(probability > 1 ? probability : probability * 100);
}

function fmtDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function fmtTs(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 12,
        fontWeight: 600,
        letterSpacing: '.04em',
        textTransform: 'uppercase',
        color: '#667085',
      }}
    >
      {children}
    </div>
  );
}

export function BillUpdatesDrawer({
  open,
  clientId,
  bill,
  onClose,
}: {
  open: boolean;
  clientId: string;
  /** The clicked board bill, or null when nothing is selected. */
  bill: BoardBill | null;
  onClose: () => void;
}) {
  return (
    <CapiroDrawer open={open && Boolean(bill)} title={bill?.displayNum ?? 'Bill'} onClose={onClose}>
      {bill ? <BillUpdatesBody clientId={clientId} bill={bill} /> : null}
    </CapiroDrawer>
  );
}

function BillUpdatesBody({ clientId, bill }: { clientId: string; bill: BoardBill }) {
  const navigate = useNavigate();
  // Q07 (evidence #58/#65): this drawer's own "Open full board" button used to
  // navigate('/legiwatch') bare — no tab, no client — landing on the Hearings
  // tab with the client filter dropped (the exact reported symptom: wrong
  // section, all-clients context lost). The board footer's sibling button
  // (IntelligenceTab's LegislativePanel) already targets the real Bills tab
  // scoped to this client; this drawer needs the identical destination.
  const openFullBoardHref = `/legiwatch?tab=bills&client=${encodeURIComponent(clientId)}`;
  // Lazy: only fetched while the drawer is open (this body mounts with the drawer).
  const hearingsQ = useBillHearings(clientId, bill.billId, true);
  const hearings = useMemo(() => hearingsQ.data?.hearings ?? [], [hearingsQ.data]);
  const latestActionDate = fmtDate(bill.latestActionDate);
  const trackedAt = fmtDate(bill.trackedAt);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Title + headline chips */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ fontSize: 16, fontWeight: 600, color: '#101828', textWrap: 'pretty' }}>{bill.title}</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <Pill tone="gray" dotless>{passagePct(bill.probability)}% pass</Pill>
          {bill.change ? (
            <Pill tone={CHANGE_TONE[bill.change.tone] ?? 'gray'} dotless={!bill.change.dot}>
              {bill.change.label}
            </Pill>
          ) : null}
          {bill.terminalRisk ? <Pill tone="error">Terminal risk</Pill> : null}
          {bill.jurisdiction && bill.jurisdiction !== 'US' ? (
            <Pill tone="blue" dotless>{bill.jurisdiction}</Pill>
          ) : null}
        </div>
      </div>

      {/* Latest update */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionLabel>Latest update</SectionLabel>
        {bill.canonicalStatus ? (
          <div style={{ fontSize: 14, fontWeight: 600, color: '#101828' }}>{bill.canonicalStatus}</div>
        ) : null}
        {bill.latestActionText ? (
          <div style={{ fontSize: 14, color: '#344054', textWrap: 'pretty' }}>{bill.latestActionText}</div>
        ) : null}
        {latestActionDate ? (
          <div style={{ fontSize: 13, color: '#667085' }}>{latestActionDate}</div>
        ) : null}
        {!bill.canonicalStatus && !bill.latestActionText ? (
          <div style={{ fontSize: 14, color: '#667085' }}>No official action recorded yet.</div>
        ) : null}
      </div>

      {/* Analyst note (the tracked row's own note) */}
      {bill.note ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>Note</SectionLabel>
          <div style={{ fontSize: 14, color: '#344054', textWrap: 'pretty' }}>{bill.note}</div>
        </div>
      ) : null}

      {/* Watchlist topics that matched for this client */}
      {bill.tags.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <SectionLabel>Matched topics</SectionLabel>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {bill.tags.map((tag) => (
              <Pill key={tag} tone="gray" size="sm" dotless>{tag}</Pill>
            ))}
          </div>
        </div>
      ) : null}

      {/* Discussed in hearings (Bill→Hearing interlink; tracker_v2 tenants). */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionLabel>Discussed in hearings</SectionLabel>
        {hearingsQ.isPending ? (
          <div style={{ fontSize: 14, color: '#667085' }} aria-busy="true">Loading hearings…</div>
        ) : hearings.length === 0 ? (
          <div style={{ fontSize: 14, color: '#667085' }}>
            No hearings have discussed this bill yet.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {hearings.map((h) => (
              <HearingRow key={h.sessionId} hearing={h} onOpen={(id) => navigate(`/intelligence/hearing-watch/${encodeURIComponent(id)}`)} />
            ))}
          </div>
        )}
      </div>

      {/* Provenance / open full board */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 8, borderTop: '1px solid #E8E5DF' }}>
        {trackedAt ? <div style={{ fontSize: 13, color: '#667085' }}>Tracked {trackedAt}</div> : null}
        <button
          type="button"
          onClick={() => navigate(openFullBoardHref)}
          style={{ alignSelf: 'flex-start', fontSize: 14, fontWeight: 600, color: '#101828', cursor: 'pointer' }}
        >
          Open full board →
        </button>
      </div>
    </div>
  );
}

function HearingRow({ hearing, onOpen }: { hearing: BillHearing; onOpen: (sessionId: string) => void }) {
  const mentions = hearing.mentions ?? [];
  const occurredAt = fmtDate(hearing.occurredAt);
  return (
    <div style={{ border: '1px solid #E8E5DF', borderRadius: 8, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          onClick={() => onOpen(hearing.sessionId)}
          style={{ fontWeight: 600, fontSize: 13, color: '#101828', cursor: 'pointer', textAlign: 'left' }}
        >
          {hearing.title ?? 'Hearing'} →
        </button>
        {occurredAt ? <span style={{ fontSize: 12, color: '#667085' }}>{occurredAt}</span> : null}
      </div>
      {mentions.slice(0, 3).map((m, i) => (
        <div key={m.segmentId ?? i} style={{ fontSize: 13, color: '#344054', textWrap: 'pretty' }}>
          {m.timestampMs != null ? (
            <span style={{ color: '#667085', marginRight: 6 }}>{fmtTs(m.timestampMs)}</span>
          ) : null}
          {m.speakerName ? <strong style={{ fontWeight: 600 }}>{m.speakerName}: </strong> : null}
          {m.quote ? <span>“{m.quote}”</span> : null}
        </div>
      ))}
    </div>
  );
}
