import { Pill, type PillSev } from './EvidenceBadge.js';
import { SEV_COLOR } from './DossierKpiStrip.js';
import { fmtDate } from './dossier-format.js';

export type TimelineMilestoneState = 'done' | 'current' | 'failed' | 'upcoming';

export interface TimelineMilestone {
  date: string | null;
  label: string;
  detail: string | null;
  state: TimelineMilestoneState;
  sev?: PillSev;
}

function sevForState(m: TimelineMilestone): PillSev {
  if (m.state === 'failed') return 'critical';
  if (m.state === 'current') return m.sev ?? 'info';
  if (m.state === 'done') return 'success';
  return 'neutral';
}

/**
 * Vertical legislative-path timeline. Dot color follows milestone state; the dot
 * is filled for any non-upcoming state and hollow (canvas fill) for upcoming; the
 * connector line is transparent on the last item. Failed → "Failed" pill,
 * Current → "Current" pill.
 */
export function EventTimeline({ milestones }: { milestones: TimelineMilestone[] }) {
  return (
    <>
      {milestones.map((m, i) => {
        const sev = sevForState(m);
        const color = SEV_COLOR[sev];
        const filled = m.state !== 'upcoming';
        const last = i === milestones.length - 1;
        return (
          <div className="dsr-timeline-row" key={`${m.label}-${i}`}>
            <div className="dsr-rail">
              <span
                className="dsr-dot"
                style={{ borderColor: color, background: filled ? color : 'var(--bg-canvas)' }}
              />
              <span
                className="dsr-line"
                style={{ background: last ? 'transparent' : 'var(--border-2, #d8d2c4)' }}
              />
            </div>
            <div className="dsr-ms-body">
              <div className="dsr-ms-head">
                <span
                  className="dsr-ms-label"
                  style={{ color: m.state === 'upcoming' ? 'var(--ink-3)' : 'var(--ink-1)' }}
                >
                  {m.label}
                </span>
                {m.state === 'failed' ? <Pill sev="critical">Failed</Pill> : null}
                {m.state === 'current' ? <Pill sev={sev}>Current</Pill> : null}
                <span className="dsr-ms-date">{fmtDate(m.date) || '—'}</span>
              </div>
              {m.detail ? <div className="dsr-ms-detail">{m.detail}</div> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}
