/**
 * System states overlay (§7.13) — the state vocabulary (§9) plus the work-state
 * vocabulary (§6.2), as an internal reference surface. Reachable from the
 * source-health chip in the sub-nav (§4.1 #8).
 */
import { LwModal } from './LwModal.js';
import { LwPill } from '../lib/primitives.js';
import { WORK_STATE_LABEL, WORK_STATE_TONE, type WorkState } from '../lib/types.js';

const SYSTEM_STATES: Array<[string, string, string]> = [
  ['LOADING', 'Query in flight', 'Skeleton preserving module geometry — never a spinner over an empty page.'],
  ['PARTIAL', 'Some sources resolved, others failed', 'The available packets plus the named unavailable source and a targeted retry.'],
  ['STALE', 'Last successful read is aging', 'The last packet, its age, and a targeted refresh; freshness-dependent actions disabled.'],
  ['UNAVAILABLE', 'The requested source cannot be loaded', 'The source name and the reason — never an empty result, never zero.'],
  ['EMPTY', 'Filters produced no rows', 'That filters, not ingestion, produced the result, with source health visible.'],
  ['ALL CLEAR', 'Genuinely nothing to action', 'A calm success state with source health and last scan time.'],
  ['PERMISSION', 'Client outside the user scope', 'The route preserved; the missing entitlement explained; no restricted data leaked.'],
  ['RECOVERABLE', 'Hearing capture lost its source', 'Session, transcript, exact reason and recovery options retained — never labelled completed.'],
];

export function SystemStatesOverlay({ onClose }: { onClose: () => void }) {
  return (
    <LwModal
      kind="states"
      eyebrow="Reference"
      title="System states"
      subtitle="One vocabulary, one component family, used by every module in LegiWatch. Panels retain their geometry in every state."
      note="Internal reference surface — the states every module implements."
      primaryLabel="Close"
      onPrimary={onClose}
      onClose={onClose}
    >
      <div className="lw-states-grid">
        {SYSTEM_STATES.map(([name, trigger, must]) => (
          <div key={name} className="lw-block">
            <LwPill tone={name === 'ALL CLEAR' ? 'success' : name === 'UNAVAILABLE' ? 'error' : name === 'STALE' || name === 'PARTIAL' || name === 'RECOVERABLE' ? 'warning' : 'gray'} size="22">
              {name}
            </LwPill>
            <div style={{ marginTop: 8, fontSize: 13, fontWeight: 600 }}>{trigger}</div>
            <div className="lw-block__body">{must}</div>
          </div>
        ))}
      </div>
      <div className="lw-rail__label" style={{ marginTop: 4 }}>Work states</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {(Object.keys(WORK_STATE_LABEL) as WorkState[]).map((s) => (
          <LwPill key={s} tone={WORK_STATE_TONE[s]}>{WORK_STATE_LABEL[s]}</LwPill>
        ))}
      </div>
      <p className="lw-state__body" style={{ maxWidth: 'none' }}>
        Evidence quality and workflow state are separate fields, never rendered in the same pill.
        The active queue is NEW + IN REVIEW + ASSIGNED; ACTIONED, SNOOZED and DISMISSED are resolved
        buckets excluded from every active count. Dismiss is never delete.
      </p>
    </LwModal>
  );
}
