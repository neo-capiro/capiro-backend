/**
 * Create watch overlay (§7.13) — a fast alert definition that can SUPPLEMENT,
 * never replace, the client's full watchlist (§6.5). Definition on the left;
 * the dark preview on the right shows what it WOULD have matched in the last
 * 30 days — a real backtest query, not an estimate.
 *
 * There is no watch-preset storage and no backtest endpoint (GAPS LW-G9), so
 * the preview cannot run a real query. The overlay renders the definition form
 * against the watchlist's real source families and triggers, and the preview
 * panel renders its honest unavailable state — never an estimated match count.
 * Saving routes to the client's canonical watchlist configuration (§7.9).
 */
import { useState } from 'react';
import { LwModal } from './LwModal.js';
import { LwPill, LwButton } from '../lib/primitives.js';
import { SOURCE_FAMILIES } from '../lib/types.js';

const TRIGGERS: string[] = [
  'Status or stage change',
  'Funding movement',
  'Hearing mention with client match',
  'Regulatory deadline',
  'Committee referral',
  'Vote / passage',
];

export function CreateWatchOverlay({
  onClose,
  onConfigure,
}: {
  onClose: () => void;
  onConfigure: () => void;
}) {
  const [name, setName] = useState('');
  const [families, setFamilies] = useState<Set<string>>(new Set(['bill', 'hearing']));
  const [triggers, setTriggers] = useState<Set<string>>(() => new Set([TRIGGERS[0] ?? '']));

  const toggle = (set: Set<string>, v: string, apply: (n: Set<string>) => void) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    apply(next);
  };

  return (
    <LwModal
      kind="watch"
      eyebrow="New LegiWatch preset"
      title="Create watch"
      subtitle="A fast alert definition that can supplement — not replace — the client's full watchlist."
      note="Presets are additive. Client watchlist targeting remains the canonical relevance source."
      primaryLabel="Create watch"
      primaryDisabled
      primaryTitle="Watch presets have no storage backend yet (GAPS LW-G9). Configure the client's canonical watchlist instead."
      onClose={onClose}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 320px', gap: 16 }}>
        {/* definition */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <div className="lw-block__label" style={{ marginBottom: 6 }}>Name</div>
            <input
              className="lw-search"
              style={{ width: '100%', height: 38, padding: '0 12px', borderRadius: 8, boxShadow: 'var(--lw-ring-control)', border: 0 }}
              placeholder="e.g. Autonomy funding movement"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div>
            <div className="lw-block__label" style={{ marginBottom: 6 }}>Source families</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {SOURCE_FAMILIES.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`lw-btn${families.has(f.id) ? ' lw-btn--primary' : ''}`}
                  aria-pressed={families.has(f.id)}
                  onClick={() => toggle(families, f.id, setFamilies)}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="lw-block__label" style={{ marginBottom: 6 }}>Triggers</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {TRIGGERS.map((t) => (
                <label key={t} style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={triggers.has(t)}
                    onChange={() => toggle(triggers, t, setTriggers)}
                  />
                  {t}
                </label>
              ))}
            </div>
          </div>
          <LwButton onClick={onConfigure}>Open the client's full watchlist →</LwButton>
        </div>

        {/* dark preview — a real backtest query, not an estimate */}
        <div style={{ background: 'var(--lw-ink)', borderRadius: 11, padding: 16, color: '#fff' }}>
          <div className="lw-eyebrow" style={{ color: 'var(--lw-faint)' }}>Preview · last 30 days</div>
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <LwPill tone="warning" size="22">UNAVAILABLE</LwPill>
            <p style={{ margin: 0, fontSize: 13, lineHeight: '20px', color: 'var(--lw-faint)' }}>
              A preset preview is a real backtest query against the last 30 days. There is no
              backtest endpoint (GAPS LW-G9), so no estimate is shown — the number here would be a
              guess, and a guessed match count is worse than none.
            </p>
          </div>
        </div>
      </div>
    </LwModal>
  );
}
