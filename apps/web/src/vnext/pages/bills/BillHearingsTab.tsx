import { fmtDate } from '../../../components/dossier/dossier-format.js';
import type { BillHearingView } from '../../../pages/bills/bill-360.types.js';
import { CapiroEmptyState } from '../../components/feedback/index.js';
import { AudioIcon } from './dossier-primitives.js';

/**
 * Hearings tab — vNext re-skin of pages/bills/BillHearingsTab.tsx: hearing
 * cards with per-mention timestamp / speaker / quote.
 */
export function BillHearingsTab({ hearings }: { hearings: BillHearingView[] }) {
  if (!hearings.length) {
    return (
      <div className="b360-empty">
        <CapiroEmptyState title="No hearing mentions recorded for this bill." />
      </div>
    );
  }
  return (
    <div className="b360-hearing-list">
      {hearings.map((h) => (
        <div className="b360-hearing-card" key={h.id}>
          <div className="b360-hearing-head">
            <span className="b360-hearing-glyph">
              <AudioIcon />
            </span>
            <span className="b360-hearing-title">{h.title ?? 'Hearing'}</span>
            <span className="b360-hearing-date">{fmtDate(h.date)}</span>
          </div>
          {h.committee ? <div className="b360-hearing-committee">{h.committee}</div> : null}
          {h.mentions.map((m, i) => (
            <div className="b360-mention" key={i}>
              <div className="b360-mention-meta">
                <span className="b360-mention-ts">{m.ts ?? ''}</span>
                {m.speaker ? <span className="b360-mention-speaker">{m.speaker}</span> : null}
              </div>
              {m.quote ? <div className="b360-mention-quote">“{m.quote}”</div> : null}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
