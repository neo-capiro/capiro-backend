/**
 * How it works overlay (§7.13) — the four cold-start moves.
 */
import { LwModal } from './LwModal.js';

const MOVES = [
  ['Set a watchlist for each client', 'Pick the client\u2019s issue areas and add terms, bills, people, or agencies to watch. Nothing works until this is set.'],
  ['LegiWatch finds matching movement', 'It scores federal and state legislation, regulations, hearings, and Program Element funding changes against the client\u2019s priorities.'],
  ['It transcribes the hearings you pick', 'Choose a hearing and LegiWatch transcribes it, marking the moments that hit the watchlist.'],
  ['Everything that changed shows up in the Feed', 'Bill moves, hearing moments, regulations, and funding changes land in one list — from there you save a recap, draft a memo, or start outreach.'],
] as const;

export function HowItWorksOverlay({ onClose }: { onClose: () => void }) {
  return (
    <LwModal
      kind="how"
      eyebrow="Intelligence · LegiWatch"
      title="What LegiWatch does"
      subtitle="It tracks legislation, hearings, regulations, and defense-budget changes for each client and shows you what changed."
      note="Reopen this anytime from How it works."
      primaryLabel="Got it"
      onPrimary={onClose}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {MOVES.map(([title, body], i) => (
          <div key={title} className="lw-block" style={{ display: 'flex', gap: 14 }}>
            <span className="lw-mono" style={{ fontSize: 12, fontWeight: 600, color: 'var(--lw-meta)' }}>
              {String(i + 1).padStart(2, '0')}
            </span>
            <div>
              <div style={{ fontSize: 14, fontWeight: 600 }}>{title}</div>
              <div className="lw-block__body">{body}</div>
            </div>
          </div>
        ))}
      </div>
    </LwModal>
  );
}
