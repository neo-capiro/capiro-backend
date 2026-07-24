import { AudioOutlined } from '@ant-design/icons';
import { fmtDate } from '../../components/dossier/dossier-format.js';
import type { BillHearingView } from './bill-360.types.js';

/** Hearings tab — hearing cards with per-mention timestamp / speaker / quote. */
export function BillHearingsTab({ hearings }: { hearings: BillHearingView[] }) {
  if (!hearings.length) {
    return <div className="dsr-empty">No hearing mentions recorded for this bill.</div>;
  }
  return (
    <div className="dsr-hearing-list">
      {hearings.map((h) => (
        <div className="dsr-hearing-card" key={h.id}>
          <div className="dsr-hearing-head">
            <span style={{ display: 'inline-flex', color: 'var(--ink-3)' }}>
              <AudioOutlined />
            </span>
            <span className="dsr-hearing-title">{h.title ?? 'Hearing'}</span>
            <span className="dsr-hearing-date">{fmtDate(h.date)}</span>
          </div>
          {h.committee ? <div className="dsr-hearing-committee">{h.committee}</div> : null}
          {h.mentions.map((m, i) => (
            <div className="dsr-mention" key={i}>
              <div className="dsr-mention-meta">
                <span className="dsr-mention-ts">{m.ts ?? ''}</span>
                {m.speaker ? <span className="dsr-mention-speaker">{m.speaker}</span> : null}
              </div>
              {m.quote ? <div className="dsr-mention-quote">“{m.quote}”</div> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
