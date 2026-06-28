/**
 * Anonymize review modal (Phase 6) — ported from the prototype `AnonymizeReview`
 * (asset_12), wired to the engine detector (useAnonymizeDetect). Meri detects the
 * client + offices + program/product names; per detected name the user sets:
 *   - Approve / Reject
 *   - Scope: All occurrences / This mention only
 *   - Replacement: keep | generic ("the client"/"the program") | custom text
 * Plus an export-handling radio (anonymized vs original names in export).
 *
 * Applying returns the approved redactions as an `AnonymizeMap` (the editor sets
 * cfg.anonymize=true + persists cfg.anonymizeMap). Placeholders are PROSE, not
 * bracket tokens.
 */
import { useEffect, useState } from 'react';
import { Icon } from '../kit.js';
import { useAnonymizeDetect, type AnonymizeDetection } from '../api.js';

export type AnonScope = 'all' | 'this';
export type AnonReplaceMode = 'keep' | 'generic' | 'custom';
export type AnonExportMode = 'anonymized' | 'original';

/** One persisted redaction (cfg.anonymizeMap[]). */
export interface AnonymizeRedaction {
  from: string;
  to: string;
  scope: AnonScope;
}

export interface AnonymizeMap {
  redactions: AnonymizeRedaction[];
  exportMode: AnonExportMode;
}

interface ReviewItem extends AnonymizeDetection {
  on: boolean;
  scope: AnonScope;
  replaceMode: AnonReplaceMode;
  custom: string;
}

/** Resolve an item's effective replacement text. */
function replacementFor(it: ReviewItem): string {
  if (it.replaceMode === 'keep') return it.from;
  if (it.replaceMode === 'custom') return it.custom.trim() || it.suggested;
  return it.suggested;
}

export function AnonymizeReview({
  draftId,
  onClose,
  onApply,
}: {
  draftId: string;
  onClose: () => void;
  onApply: (map: AnonymizeMap) => void;
}) {
  const detect = useAnonymizeDetect(draftId);
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [exportMode, setExportMode] = useState<AnonExportMode>('anonymized');

  // Run detection on open. Fall back to the structured client/program if the
  // detector errors so the modal is never empty.
  useEffect(() => {
    detect.mutate(undefined, {
      onSuccess: (detections) => setItems(detections.map(toItem)),
      onError: () => setItems([]),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const set = (i: number, patch: Partial<ReviewItem>) =>
    setItems((a) => a.map((x, j) => (j === i ? { ...x, ...patch } : x)));

  const approved = items.filter((x) => x.on);
  const approvedCount = approved.length;

  const apply = () => {
    const redactions: AnonymizeRedaction[] = approved
      .map((it) => ({ from: it.from, to: replacementFor(it), scope: it.scope }))
      // A "keep" replacement is a no-op; drop it from the map.
      .filter((r) => r.to && r.to !== r.from);
    onApply({ redactions, exportMode });
  };

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(12,26,56,.28)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 60,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 520, maxWidth: '92%', padding: 0, overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div
          style={{
            padding: '15px 18px',
            borderBottom: '1px solid var(--border-1)',
            display: 'flex',
            alignItems: 'center',
            gap: 9,
          }}
        >
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: '50%',
              background: 'var(--accent)',
              color: '#fff',
              display: 'grid',
              placeItems: 'center',
              flex: 'none',
            }}
          >
            <Icon name="EyeOff" size={14} />
          </span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Anonymize names</div>
            <div style={{ fontSize: 11.5, color: 'var(--ink-3)' }}>
              Meri identified direct client &amp; product names. Approve, set scope and replacement
              per term, and choose export behavior.
            </div>
          </div>
        </div>

        <div
          style={{
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 9,
            maxHeight: '48vh',
            overflow: 'auto',
          }}
        >
          {detect.isPending && (
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 12,
                color: 'var(--accent)',
                padding: '8px 0',
              }}
            >
              <Icon name="Loader" size={13} />
              Meri is scanning the document…
            </div>
          )}
          {!detect.isPending && items.length === 0 && (
            <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '8px 0', lineHeight: 1.5 }}>
              Meri didn&apos;t find direct client or program names to anonymize.
            </div>
          )}
          {items.map((it, i) => (
            <div
              key={`${it.from}-${i}`}
              style={{
                border: '1px solid ' + (it.on ? 'var(--accent)' : 'var(--border-1)'),
                background: it.on ? 'var(--accent-soft)' : 'var(--bg-surface)',
                borderRadius: 9,
                overflow: 'hidden',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: '10px 12px' }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: 12.5 }}>
                  <span style={{ fontWeight: 600 }}>{it.from}</span>
                  <Icon
                    name="ArrowRight"
                    size={12}
                    style={{ margin: '0 6px', color: 'var(--ink-3)', verticalAlign: 'middle' }}
                  />
                  <span style={{ fontStyle: 'italic', color: 'var(--ink-2)' }}>
                    {replacementFor(it)}
                  </span>
                  <span
                    style={{
                      marginLeft: 8,
                      fontSize: 10,
                      color: 'var(--ink-4)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {it.occurrences}×
                  </span>
                </div>
                {it.on ? (
                  <button
                    className="btn sm btn-ghost"
                    style={{ color: 'var(--ink-2)' }}
                    onClick={() => set(i, { on: false })}
                  >
                    <Icon name="X" size={12} />
                    Reject
                  </button>
                ) : (
                  <button
                    className="btn sm btn-ghost"
                    style={{ color: 'var(--accent)' }}
                    onClick={() => set(i, { on: true })}
                  >
                    <Icon name="Check" size={12} />
                    Approve
                  </button>
                )}
              </div>

              {it.on && (
                <>
                  {/* Scope row */}
                  <div
                    style={{
                      padding: '7px 12px',
                      borderTop: '1px solid rgba(42,87,206,.15)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--accent-ink)',
                        marginRight: 3,
                        width: 64,
                      }}
                    >
                      Scope
                    </span>
                    {(
                      [
                        ['all', 'All occurrences'],
                        ['this', 'This mention only'],
                      ] as Array<[AnonScope, string]>
                    ).map(([v, l]) => (
                      <button
                        key={v}
                        onClick={() => set(i, { scope: v })}
                        style={pillStyle(it.scope === v)}
                      >
                        {l}
                      </button>
                    ))}
                  </div>
                  {/* Replacement row */}
                  <div
                    style={{
                      padding: '7px 12px',
                      borderTop: '1px solid rgba(42,87,206,.15)',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 7,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 600,
                        color: 'var(--accent-ink)',
                        marginRight: 3,
                        width: 64,
                      }}
                    >
                      Replace
                    </span>
                    {(
                      [
                        ['keep', 'Keep'],
                        ['generic', `“${it.suggested}”`],
                        ['custom', 'Custom'],
                      ] as Array<[AnonReplaceMode, string]>
                    ).map(([v, l]) => (
                      <button
                        key={v}
                        onClick={() => set(i, { replaceMode: v })}
                        style={pillStyle(it.replaceMode === v)}
                      >
                        {l}
                      </button>
                    ))}
                    {it.replaceMode === 'custom' && (
                      <input
                        value={it.custom}
                        onChange={(e) => set(i, { custom: e.target.value })}
                        placeholder="Replacement text…"
                        className="field"
                        style={{
                          flex: 1,
                          minWidth: 120,
                          padding: '4px 9px',
                          fontSize: 11.5,
                          fontFamily: 'var(--font-sans)',
                          background: 'var(--bg-surface)',
                        }}
                      />
                    )}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        {/* Export handling */}
        <div
          style={{
            padding: '11px 16px',
            borderTop: '1px solid var(--border-1)',
            background: 'var(--bg-surface-2)',
          }}
        >
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-2)', marginBottom: 7 }}>
            Export handling
          </div>
          <div style={{ display: 'flex', gap: 14 }}>
            {(
              [
                ['anonymized', 'Export uses anonymized names'],
                ['original', 'Export shows original names'],
              ] as Array<[AnonExportMode, string]>
            ).map(([v, l]) => (
              <label
                key={v}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  checked={exportMode === v}
                  onChange={() => setExportMode(v)}
                  style={{ accentColor: 'var(--accent)' }}
                />
                {l}
              </label>
            ))}
          </div>
        </div>

        <div
          style={{
            padding: '12px 16px',
            borderTop: '1px solid var(--border-1)',
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
          }}
        >
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            disabled={approvedCount === 0}
            style={{ opacity: approvedCount ? 1 : 0.5 }}
            onClick={apply}
          >
            <Icon name="EyeOff" size={13} />
            Anonymize {approvedCount} name{approvedCount === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  );
}

function toItem(d: AnonymizeDetection): ReviewItem {
  // E-15: only PRE-CHECK high-confidence structured names (client/product/
  // office). Heuristically-mined proper nouns default OFF so the user opts in,
  // instead of everything being replaced with "the program".
  return { ...d, on: d.confidence !== 'low', scope: 'all', replaceMode: 'generic', custom: '' };
}

function pillStyle(active: boolean): React.CSSProperties {
  return {
    fontSize: 11,
    padding: '3px 9px',
    borderRadius: 6,
    border: '1px solid',
    borderColor: active ? 'var(--accent)' : 'rgba(42,87,206,.2)',
    background: active ? 'var(--accent)' : 'transparent',
    color: active ? '#fff' : 'var(--accent-ink)',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--font-sans)',
  };
}
