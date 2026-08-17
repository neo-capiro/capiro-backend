import { useState } from 'react';
import type { MeriChatController } from '../../components/chat/useMeriChatController.js';
import { useCapiroToast } from '../components/feedback/toast.js';
import { MeriIcon } from './meri-icons.js';
import { MERI_EVIDENCE_SOURCES, type MeriEvidenceSource } from './MeriEvidenceTray.js';

/**
 * MeriSourceDetail — the SOURCE DETAIL right-panel content: prev/next source
 * navigation, why-it-matters, evidence in this conversation, provenance, and
 * the include-in-active-context switch. Pixel-parity port of the prototype's
 * `panelIsSource` block.
 *
 * BACKEND GAP: there is no per-source detail endpoint on vNext; the panel
 * pages through the evidence sources it is handed (prototype fixtures by
 * default). Tracked in GAPS.md (Meri vNext — source detail).
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

const WHY_IT_MATTERS =
  'This is the committee document that sets the authorised figure your position depends on. It is the only source in this thread that states the $14.7M increase and the Army validation rationale together.';

interface MeriSourceDetailProps {
  /** Reserved for wiring to live source data; fixtures render when absent. */
  controller?: MeriChatController;
  sources?: MeriEvidenceSource[];
  initialIndex?: number;
  onOpenExternal?: (source: MeriEvidenceSource) => void;
  onToggleContext?: (source: MeriEvidenceSource, included: boolean) => void;
}

export function MeriSourceDetail({
  sources = MERI_EVIDENCE_SOURCES,
  initialIndex = 0,
  onOpenExternal,
  onToggleContext,
}: MeriSourceDetailProps) {
  const toast = useCapiroToast();
  const [index, setIndex] = useState(initialIndex);
  const [inContext, setInContext] = useState(true);

  const count = sources.length;
  const clamped = count > 0 ? ((index % count) + count) % count : 0;
  const source = sources[clamped];

  if (!source) return null;

  const toggleContext = () => {
    const next = !inContext;
    setInContext(next);
    onToggleContext?.(source, next);
  };

  return (
    <div style={{ animation: 'vnext-meri-rise .2s cubic-bezier(.2,0,0,1)' }}>
      <div style={{ padding: '16px 20px 14px', borderBottom: '1px solid #EAECF0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            title="Previous source"
            aria-label="Previous source"
            onClick={() => setIndex((i) => i - 1)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              boxShadow: 'inset 0 0 0 1px #EAECF0',
              color: '#667085',
            }}
          >
            <MeriIcon name="ChevronLeft" size={14} />
          </button>
          <button
            type="button"
            title="Next source"
            aria-label="Next source"
            onClick={() => setIndex((i) => i + 1)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              boxShadow: 'inset 0 0 0 1px #EAECF0',
              color: '#667085',
            }}
          >
            <MeriIcon name="ChevronRight" size={14} />
          </button>
          <span
            style={{
              flex: 1,
              minWidth: 0,
              fontFamily: MONO,
              fontSize: 9.5,
              fontWeight: 500,
              letterSpacing: '.08em',
              color: '#667085',
            }}
          >
            SOURCE {clamped + 1} OF {count}
          </span>
          {inContext ? (
            <span
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 22,
                padding: '0 8px',
                borderRadius: 6,
                background: '#ECFDF3',
                boxShadow: 'inset 0 0 0 1px #ABEFC6',
              }}
            >
              <span style={{ width: 6, height: 6, borderRadius: 9999, background: '#12B76A' }} />
              <span
                style={{
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.07em',
                  color: '#027A48',
                }}
              >
                IN ACTIVE CONTEXT
              </span>
            </span>
          ) : null}
        </div>
        <div
          style={{
            marginTop: 12,
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.08em',
            color: '#667085',
          }}
        >
          {source.provider}
        </div>
        <div style={{ marginTop: 7, fontSize: 16, lineHeight: '23px', fontWeight: 600, color: '#101828' }}>
          {source.title}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7, marginTop: 11 }}>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 24,
              padding: '0 9px',
              borderRadius: 6,
              background: '#F2F4F7',
              fontFamily: MONO,
              fontSize: 9,
              fontWeight: 500,
              letterSpacing: '.07em',
              color: '#344054',
            }}
          >
            {source.locator}
          </span>
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 24,
              padding: '0 9px',
              borderRadius: 6,
              background: '#F2F4F7',
              fontFamily: MONO,
              fontSize: 9,
              fontWeight: 500,
              letterSpacing: '.07em',
              color: '#344054',
            }}
          >
            98% CLIENT FIT
          </span>
          <button
            type="button"
            onClick={() => {
              if (onOpenExternal) onOpenExternal(source);
              else toast.success('Opening the source in a new tab.');
            }}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              height: 24,
              padding: '0 9px',
              borderRadius: 6,
              boxShadow: 'inset 0 0 0 1px #D0D5DD',
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: 9,
                fontWeight: 500,
                letterSpacing: '.07em',
                color: '#344054',
              }}
            >
              OPEN SOURCE
            </span>
            <MeriIcon name="LinkExternal01" size={11} color="#101828" />
          </button>
        </div>
      </div>

      <div style={{ padding: '16px 20px', borderBottom: '1px solid #EAECF0' }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.09em',
            color: '#667085',
          }}
        >
          WHY IT MATTERS
        </div>
        <div style={{ marginTop: 9, fontSize: 13, lineHeight: '20px', color: '#344054' }}>
          {WHY_IT_MATTERS}
        </div>
      </div>

      <div style={{ padding: '16px 20px', borderBottom: '1px solid #EAECF0' }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.09em',
            color: '#667085',
          }}
        >
          EVIDENCE IN THIS CONVERSATION
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            { ref: source.locator, kind: 'QUOTED FIGURE', text: source.snippet },
            {
              ref: '§ 214',
              kind: 'REPORT LANGUAGE',
              text: 'Directs the Secretary of the Army to report on the FY29 fielding decision not later than 180 days after enactment.',
            },
          ].map((evidence) => (
            <div
              key={evidence.ref + evidence.kind}
              style={{
                padding: '12px 13px',
                borderRadius: 8,
                background: '#F9FAFB',
                boxShadow: 'inset 0 0 0 1px #EAECF0',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9,
                    fontWeight: 500,
                    letterSpacing: '.07em',
                    color: '#101828',
                  }}
                >
                  {evidence.ref}
                </span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontFamily: MONO,
                    fontSize: 9,
                    fontWeight: 500,
                    letterSpacing: '.07em',
                    color: '#667085',
                  }}
                >
                  {evidence.kind}
                </span>
              </div>
              <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: '19px', color: '#344054' }}>
                {evidence.text}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ padding: '16px 20px' }}>
        <div
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.09em',
            color: '#667085',
          }}
        >
          PROVENANCE
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            ['SOURCE', source.provider],
            ['LAST VERIFIED', source.date],
            ['SCOPE', 'Client — Lockheed Martin'],
            ['CITATION', `${source.title} · ${source.locator}`],
            ['VERSION', 'v3 · immutable, Meri never edits source content'],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', gap: 12 }}>
              <span
                style={{
                  flex: '0 0 116px',
                  fontFamily: MONO,
                  fontSize: 9,
                  fontWeight: 500,
                  letterSpacing: '.07em',
                  color: '#98A2B3',
                }}
              >
                {label}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '18px', color: '#344054' }}>
                {value}
              </span>
            </div>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 11,
            marginTop: 16,
            paddingTop: 14,
            borderTop: '1px solid #EAECF0',
          }}
        >
          <span style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, color: '#344054' }}>
            Include in active context
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={inContext}
            aria-label="Include in active context"
            onClick={toggleContext}
            style={{
              position: 'relative',
              width: 38,
              height: 22,
              borderRadius: 9999,
              background: inContext
                ? 'linear-gradient(180deg,#39424F 0%,#1B2430 46%,#0E141C 100%)'
                : '#F2F4F7',
              boxShadow: inContext
                ? 'inset 0 1px 0 rgba(255,255,255,.14)'
                : 'inset 0 0 0 1px #D0D5DD',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: inContext ? 18 : 2,
                width: 18,
                height: 18,
                borderRadius: 9999,
                background: '#ffffff',
                boxShadow: '0 1px 2px rgba(16,24,40,.2)',
                transition: 'left 140ms ease',
              }}
            />
          </button>
        </div>
      </div>
    </div>
  );
}
