import { deltaColor, fmtAmt, fmtDelta } from './dossier-format.js';

export interface PeImpactRow {
  pe: string;
  name: string | null;
  requestMillions: number | null;
  houseMillions: number | null;
  senateMillions: number | null;
  deltaVsRequestMillions: number | null;
  basis: 'explicit' | 'inferred';
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
  return (
    <div className="dsr-petable">
      <div className="dsr-petable-title">
        <span>{title}</span>
        {count != null ? <span className="dsr-petable-count">{count} lines</span> : null}
      </div>
      <div className="dsr-petable-cols">
        <span>Program element</span>
        <span style={{ textAlign: 'right' }}>Request</span>
        <span style={{ textAlign: 'right' }}>House</span>
        <span style={{ textAlign: 'right' }}>Senate</span>
        <span style={{ textAlign: 'right' }}>Δ vs req</span>
      </div>
      {rows.map((r) => (
        <div className="dsr-petable-row" key={r.pe}>
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
          </div>
          <span className="dsr-num-cell muted">{fmtAmt(r.requestMillions)}</span>
          <span className="dsr-num-cell strong">{fmtAmt(r.houseMillions)}</span>
          <span className="dsr-num-cell muted">{fmtAmt(r.senateMillions)}</span>
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
