import { Button, Drawer, Empty } from 'antd';
import { Link } from 'react-router-dom';
import { BillDetailBody, DrillSection, formatDate } from '../explorer/bill-detail.js';
import { useBillHearings, type BillHearing } from '../clients/tracker/bill-hearings-api.js';

/**
 * Radar bill side-drawer (P7, spec D9: opening a bill NEVER routes to Data
 * Explorer). A right-side antd Drawer that renders the SAME single-bill detail as
 * the Explorer drill-in (shared `BillDetailBody` / `useBillDetail` — one fetch
 * hook, no duplication), with no navigation.
 *
 * P9 interlink surfaces both directions on the bill side:
 *  - P9.1 (Hearing→Bill): when the bill isn't tracked for this client, a
 *    "Track for <client>" button (reuses the caller's existing track mutation).
 *  - P9.2 (Bill→Hearing): a "Discussed in hearings" section listing each session
 *    + the exact moments (timestamp/speaker/quote), each session linking to the
 *    live hearing room (`/intelligence/hearing-watch/<sessionId>` — the hearing
 *    route is allowed; only bill→Explorer navigation is forbidden).
 */

function fmtTs(ms: number | null): string {
  if (ms == null) return '';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function HearingLinkSection({ clientId, billId }: { clientId: string; billId: string }) {
  // Lazy: only fetched while the drawer is open (the drawer mounts this).
  const query = useBillHearings(clientId, billId, true);
  const hearings = query.data?.hearings ?? [];
  if (!hearings.length) return null;
  return (
    <DrillSection title={`Discussed in hearings (${hearings.length})`}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {hearings.map((h) => (
          <HearingRow key={h.sessionId} hearing={h} />
        ))}
      </div>
    </DrillSection>
  );
}

function HearingRow({ hearing }: { hearing: BillHearing }) {
  const mentions = hearing.mentions ?? [];
  return (
    <div
      style={{
        border: '1px solid var(--border, #e4e4ea)',
        borderRadius: 6,
        padding: '8px 10px',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <Link
          to={`/intelligence/hearing-watch/${encodeURIComponent(hearing.sessionId)}`}
          style={{ fontWeight: 600, fontSize: 13 }}
        >
          {hearing.title ?? 'Hearing'} →
        </Link>
        {hearing.occurredAt ? (
          <span className="num" style={{ fontSize: 11, color: 'var(--ink-3)' }}>
            {formatDate(hearing.occurredAt)}
          </span>
        ) : null}
      </div>
      {mentions.length ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {mentions.slice(0, 5).map((m, i) => (
            <div key={m.segmentId ?? i} style={{ display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.4 }}>
              <span className="num" style={{ color: 'var(--ink-3)', minWidth: 38 }}>{fmtTs(m.timestampMs)}</span>
              <span>
                {m.speakerName ? <b>{m.speakerName}: </b> : null}
                {m.quote ? (
                  `“${m.quote}”`
                ) : (
                  <i style={{ color: 'var(--ink-3)' }}>[encrypted — open hearing to view]</i>
                )}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function BillDrawer({
  open,
  billId,
  clientId,
  clientName,
  isTracked,
  onTrack,
  onClose,
}: {
  open: boolean;
  billId: string | null;
  clientId: string;
  clientName: string;
  /** Whether the bill is already on this client's board (hides the Track button). */
  isTracked?: boolean;
  /** Track this bill for the client — reuses the caller's existing track mutation. */
  onTrack?: (billId: string) => void;
  onClose: () => void;
}) {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={Math.min(640, typeof window !== 'undefined' ? window.innerWidth - 60 : 640)}
      destroyOnClose
      title={
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontSize: 11,
              color: 'var(--ink-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
            }}
          >
            Bill
          </span>
          {billId && !isTracked && onTrack ? (
            <>
              <span style={{ flex: 1 }} />
              <Button
                type="primary"
                size="small"
                onClick={() => onTrack(billId)}
                title={`Add to ${clientName}'s board`}
              >
                Track for {clientName}
              </Button>
            </>
          ) : null}
        </span>
      }
      className="explorer-drill-drawer"
    >
      {billId ? (
        <BillDetailBody id={billId} extra={<HearingLinkSection clientId={clientId} billId={billId} />} />
      ) : (
        <Empty description="No bill selected." />
      )}
    </Drawer>
  );
}

export default BillDrawer;
