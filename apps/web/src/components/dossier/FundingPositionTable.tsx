import { deltaColor, fmtAmt, fmtDelta } from './dossier-format.js';

export interface PeImpactRow {
  pe: string;
  name: string | null;
  requestMillions: number | null;
  houseMillions: number | null;
  senateMillions: number | null;
  conferenceMillions?: number | null;
  enactedMillions?: number | null;
  vehicleTrack?: string | null;
  houseLabel?: string;
  senateLabel?: string;
  conferenceLabel?: string;
  deltaVsRequestMillions: number | null;
  basis: 'explicit' | 'inferred';
  source?: string | null;
}

/**
 * The Program-Element impacts table (5-column CSS grid), reused verbatim by both
 * the Funding and Impact tabs. Columns: Program element | Request | House |
 * Senate | Δ vs req. House and Δ are emphasized; Request/Senate are muted;
 * missing chamber amounts render "—" (never $0). Each PE row deep-links via
 * onOpenPe.
 */
export function FundingPositionTable({
  title,
  count,
  rows,
  onOpenPe,
}: {
  title: string;
  count?: number;
  rows: PeImpactRow[];
  onOpenPe?: (pe: string) => void;
}) {
  const first = rows[0];
  const authorization = first?.vehicleTrack === 'authorization';
  const houseLabel =
    first?.houseLabel ??
    (authorization
      ? 'House authorization'
      : first?.vehicleTrack === 'appropriation'
        ? 'House appropriation'
        : 'House amount (track not verified)');
  const senateLabel =
    first?.senateLabel ??
    (authorization
      ? 'Senate authorization'
      : first?.vehicleTrack === 'appropriation'
        ? 'Senate appropriation'
        : 'Senate amount (track not verified)');
  const conferenceLabel =
    first?.conferenceLabel ??
    (authorization
      ? 'NDAA conference authorization'
      : first?.vehicleTrack === 'appropriation'
        ? 'Appropriations conference'
        : 'Conference amount (track not verified)');
  const hasConference = rows.some((row) => row.conferenceMillions != null);
  const hasEnacted = rows.some((row) => row.enactedMillions != null);
  const numericColumns = 4 + Number(hasConference) + Number(hasEnacted);
  const gridTemplateColumns = `minmax(210px, 2.4fr) repeat(${numericColumns}, minmax(88px, 1fr))`;
  return (
    <div className="dsr-petable">
      <div className="dsr-petable-title">
        <span>{title}</span>
        {count != null ? <span className="dsr-petable-count">{count} lines</span> : null}
      </div>
      <div className="dsr-petable-cols" style={{ gridTemplateColumns }}>
        <span>Program element</span>
        <span style={{ textAlign: 'right' }}>Request</span>
        <span style={{ textAlign: 'right' }}>{houseLabel}</span>
        <span style={{ textAlign: 'right' }}>{senateLabel}</span>
        {hasConference ? <span style={{ textAlign: 'right' }}>{conferenceLabel}</span> : null}
        {hasEnacted ? <span style={{ textAlign: 'right' }}>Enacted appropriation</span> : null}
        <span style={{ textAlign: 'right' }}>Δ vs req</span>
      </div>
      {rows.map((r) => (
        <div className="dsr-petable-row" style={{ gridTemplateColumns }} key={r.pe}>
          <div className="dsr-pe-cell">
            <button
              type="button"
              className="dsr-pe-btn"
              onClick={() => onOpenPe?.(r.pe)}
              title={r.name ?? r.pe}
            >
              <span className="dsr-pe-code">{r.pe}</span>
              <span className="dsr-pe-name">{r.name ?? ''}</span>
            </button>
            <span className={`dsr-basis ${r.basis}`}>
              {r.basis === 'explicit' ? 'Explicit PE match' : 'Inferred match'}
            </span>
            {r.source ? (
              <span
                title={r.source}
                style={{ display: 'block', marginTop: 3, fontSize: 10, color: 'var(--ink-3)' }}
              >
                {r.source}
              </span>
            ) : null}
          </div>
          <span className="dsr-num-cell muted">{fmtAmt(r.requestMillions)}</span>
          <span className="dsr-num-cell strong">{fmtAmt(r.houseMillions)}</span>
          <span className="dsr-num-cell muted">{fmtAmt(r.senateMillions)}</span>
          {hasConference ? (
            <span className="dsr-num-cell muted">{fmtAmt(r.conferenceMillions ?? null)}</span>
          ) : null}
          {hasEnacted ? (
            <span className="dsr-num-cell strong">{fmtAmt(r.enactedMillions ?? null)}</span>
          ) : null}
          <span
            className="dsr-num-cell strong"
            style={{ color: deltaColor(r.deltaVsRequestMillions) }}
          >
            {fmtDelta(r.deltaVsRequestMillions)}
          </span>
        </div>
      ))}
    </div>
  );
}
