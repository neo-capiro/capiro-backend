import { useEffect, useState } from 'react';
import { Button, Drawer, Empty } from 'antd';
import { Link } from 'react-router-dom';
import { isStateBillKey } from '@capiro/shared';
import { BillDetailBody, DrillSection, formatDate } from '../explorer/bill-detail.js';
import { StateBillDetailBody } from '../explorer/state-bill-detail.js';
import { useBillHearings, type BillHearing } from '../clients/tracker/bill-hearings-api.js';
import { BILL_360_FEATURE, useIntelFeature } from '../../lib/intel-feature-flags.js';
import { BillDossierBody } from '../bills/BillDossierBody.js';
import { ChokepointSection } from './ChokepointSection.js';
import '../bills/bill-360.css';

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
            <div
              key={m.segmentId ?? i}
              style={{ display: 'flex', gap: 6, fontSize: 12, lineHeight: 1.4 }}
            >
              <span className="num" style={{ color: 'var(--ink-3)', minWidth: 38 }}>
                {fmtTs(m.timestampMs)}
              </span>
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

/** Narrow-viewport breakpoint: the drawer goes full-screen at/below this width. */
const NARROW_PX = 720;
/** Bill 360 desktop drawer width band (plan §2.3), clamped to the viewport. */
const B360_MIN_W = 960;
const B360_MAX_W = 1100;

/** Live viewport width, SSR/jsdom-safe. */
function useViewportWidth(): number {
  const read = () => (typeof window === 'undefined' ? B360_MAX_W : window.innerWidth);
  const [w, setW] = useState(read);
  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    const onResize = () => setW(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return w;
}

/**
 * Bill 360 drawer width (plan §2.3): 960–1,100px on desktop, clamped to the
 * viewport so it never overflows; full-screen at/below {@link NARROW_PX}.
 */
export function bill360DrawerWidth(viewportWidth: number): number | string {
  if (viewportWidth <= NARROW_PX) return '100%';
  return Math.max(Math.min(B360_MAX_W, viewportWidth - 48), Math.min(B360_MIN_W, viewportWidth));
}

/**
 * Bill 360 drawer (plan §2.3). Renders the shared `BillDossierBody` — the SAME
 * body the full page renders — with its own chrome, so the drawer, the full page,
 * and a copied URL are one experience. It keeps the drawer's existing contract:
 * opens in place (never navigates to Explorer), preserves Track/Untrack via the
 * caller's mutation, and adds "Open full page". A related-vehicle click swaps the
 * bill IN PLACE (prototype behavior) rather than leaving LegiWatch.
 */
function Bill360Drawer({
  open,
  billId,
  clientId,
  isTracked,
  onTrack,
  onClose,
}: {
  open: boolean;
  billId: string | null;
  clientId: string;
  isTracked?: boolean;
  onTrack?: (billId: string) => void;
  onClose: () => void;
}) {
  const width = bill360DrawerWidth(useViewportWidth());
  // In-place bill swap (related vehicles / like-for-like comparison). Resets to
  // the caller's bill whenever the drawer is re-opened on a different bill.
  const [shownBillId, setShownBillId] = useState<string | null>(billId);
  useEffect(() => setShownBillId(billId), [billId]);

  const current = shownBillId ?? billId;
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={width}
      destroyOnHidden
      closable={false}
      // The drawer renders in a portal (outside .lw-root), so opt its root into
      // the `.redesign` token scope; bill360-drawer zeroes the antd body padding.
      rootClassName="redesign"
      className="bill360-drawer"
      styles={{ header: { display: 'none' } }}
    >
      {current ? (
        <BillDossierBody
          billId={current}
          clientId={clientId}
          mode="drawer"
          isTracked={current === billId ? isTracked : undefined}
          onTrack={onTrack}
          onClose={onClose}
          onOpenBill={setShownBillId}
        />
      ) : (
        <Empty description="No bill selected." />
      )}
    </Drawer>
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
  // Bill 360 (R2 §2.3): when the flag is ON this drawer becomes the dossier. It
  // fails CLOSED — while the flag is unresolved, and whenever it is OFF, the
  // legacy drawer below renders EXACTLY as before (no behavior change at all).
  const { enabled: bill360, ready: flagReady } = useIntelFeature(BILL_360_FEATURE);
  if (flagReady && bill360) {
    return (
      <Bill360Drawer
        open={open}
        billId={billId}
        clientId={clientId}
        isTracked={isTracked}
        onTrack={onTrack}
        onClose={onClose}
      />
    );
  }

  // State Legislation Platform (S7.3) — jurisdiction switch: a state bill key
  // ("tx-2025-hb1234") renders the state-aware body; anything else keeps the
  // existing federal body untouched. Hearing links are federal-only (no state
  // bill<->hearing linker exists yet), so HearingLinkSection is federal-only;
  // ChokepointSection (M2.5) works on both rails and is passed via `extra` to
  // both bodies.
  const isState = billId != null && isStateBillKey(billId);
  return (
    <Drawer
      open={open}
      onClose={onClose}
      width={Math.min(640, typeof window !== 'undefined' ? window.innerWidth - 60 : 640)}
      destroyOnHidden
      // LegiWatch calm re-skin: the drawer renders in a portal (outside .lw-root),
      // so opt its root into the `.redesign` scope for the Hanken stack + tokens.
      rootClassName="redesign"
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
            {isState ? 'State bill' : 'Bill'}
          </span>
          {billId && isTracked === false && onTrack ? (
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
        isState ? (
          <StateBillDetailBody
            id={billId}
            extra={<ChokepointSection billId={billId} clientId={clientId} />}
          />
        ) : (
          <BillDetailBody
            id={billId}
            extra={
              <>
                <HearingLinkSection clientId={clientId} billId={billId} />
                <ChokepointSection billId={billId} clientId={clientId} />
              </>
            }
          />
        )
      ) : (
        <Empty description="No bill selected." />
      )}
    </Drawer>
  );
}

export default BillDrawer;
