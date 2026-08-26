import { MeriIcon } from './meri-icons.js';

/**
 * MeriGroundingWarning — amber banner beneath an answer when the grounding
 * auditor flags a specific reasoning failure. Pixel-parity port of the
 * prototype's `hasGrounding` block (screen P).
 *
 * Items come from the turn's own `groundingCaveat.findings`. INSPECT EVIDENCE
 * calls the host's `onInspectEvidence` (open the evidence tray on the
 * VERIFICATION tab).
 */

const MONO = "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)";

export type MeriGroundingKind =
  | 'REVERSED BUDGET DIRECTION'
  | 'AUTHORIZATION VS APPROPRIATION'
  | 'UNVERIFIED QUOTE'
  | 'PROCUREMENT LINE TREATED AS A PROGRAM ELEMENT'
  | (string & {});

export interface MeriGroundingItem {
  kind: MeriGroundingKind;
  text: string;
}

interface MeriGroundingWarningProps {
  /** Flagged findings for this turn, mapped from `groundingCaveat.findings`. */
  items: MeriGroundingItem[];
  /** Opens the evidence tray (VERIFICATION tab) in the host shell. */
  onInspectEvidence?: () => void;
}

export function MeriGroundingWarning({ items, onInspectEvidence }: MeriGroundingWarningProps) {
  if (items.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        margin: '0 18px 16px',
        padding: '14px 15px',
        borderRadius: 10,
        background: '#FFFAEB',
        border: '1px solid #FEDF89',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <MeriIcon name="AlertTriangle" size={15} color="#B54708" />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 13.5,
            lineHeight: '20px',
            fontWeight: 600,
            color: '#B54708',
          }}
        >
          Meri flagged a possible grounding issue — verify before relying on it.
        </span>
      </div>
      <div style={{ marginTop: 11, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {items.map((item, index) => (
          <div
            key={`${item.kind}-${index}`}
            style={{
              padding: '11px 12px',
              borderRadius: 8,
              background: '#ffffff',
              border: '1px solid #FEDF89',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: '#B54708',
                }}
              >
                {item.kind}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => onInspectEvidence?.()}
                style={{
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.08em',
                  color: '#101828',
                }}
              >
                INSPECT EVIDENCE
              </button>
            </div>
            <div style={{ marginTop: 7, fontSize: 13, lineHeight: '20px', color: '#344054' }}>
              {item.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
