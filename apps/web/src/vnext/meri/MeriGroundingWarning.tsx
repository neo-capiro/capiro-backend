import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriGroundingWarning — amber banner beneath an answer when the grounding
 * auditor flags a specific reasoning failure. Pixel-parity port of the
 * prototype's `hasGrounding` block (screen P).
 *
 * BACKEND GAP: grounding findings exist on the legacy chat path
 * (`grounding_caveat` SSE event) but are not yet mapped onto vNext turns, so
 * the default items are the prototype's screen-P fixtures. INSPECT EVIDENCE
 * calls the host's `onInspectEvidence` (open the evidence tray on the
 * VERIFICATION tab).
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

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

/** Prototype fixture — screen P (four flagged findings). */
export const MERI_GROUNDING_FIXTURE: MeriGroundingItem[] = [
  {
    kind: 'REVERSED BUDGET DIRECTION',
    text: 'The premise "funding went up" holds for authorisation and fails for appropriation. Stating it without the distinction reverses the direction of the number that will actually be enacted.',
  },
  {
    kind: 'AUTHORIZATION VS APPROPRIATION',
    text: 'HASC authorised $182.2M; HAC-D appropriated $172.8M. These are different acts on different lines and are not comparable as a single trend.',
  },
  {
    kind: 'UNVERIFIED QUOTE',
    text: 'No roll-call or committee record supports "unanimously". Meri found no source stating the vote margin either way.',
  },
  {
    kind: 'PROCUREMENT LINE TREATED AS A PROGRAM ELEMENT',
    text: 'One retrieved source classifies this line as procurement. Capiro program-element data classifies it as PE 0605053A, RDT&E. Verify which classification your argument depends on.',
  },
];

interface MeriGroundingWarningProps {
  /** Reserved for wiring to live grounding caveats; fixture renders when absent. */
  controller?: MeriChatController;
  items?: MeriGroundingItem[];
  /** Opens the evidence tray (VERIFICATION tab) in the host shell. */
  onInspectEvidence?: () => void;
}

export function MeriGroundingWarning({
  items = MERI_GROUNDING_FIXTURE,
  onInspectEvidence,
}: MeriGroundingWarningProps) {
  if (items.length === 0) return null;

  return (
    <div
      role="alert"
      style={{
        margin: '0 18px 16px',
        padding: '14px 15px',
        borderRadius: 10,
        background: '#FFFAEB',
        boxShadow: 'inset 0 0 0 1px #FEDF89',
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
              boxShadow: 'inset 0 0 0 1px #FEDF89',
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
