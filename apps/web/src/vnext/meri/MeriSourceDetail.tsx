import { useEffect, useState } from 'react';
import type { MeriCitation } from '../../components/chat/chat-store.js';
import { MeriIcon } from './meri-icons.js';

/**
 * MeriSourceDetail — the SOURCE DETAIL right-panel content: prev/next
 * navigation across a turn's real citations, an excerpt, and provenance.
 * Pixel-parity port of the prototype's `panelIsSource` block, rebuilt against
 * the real MeriCitation shape rather than the hardcoded evidence-sources
 * fixture it originally rendered.
 *
 * Three prototype fields have no real backing and are dropped rather than
 * fabricated: the "why it matters" narrative (no such field exists — the
 * excerpt below is the real thing citation data can say), a numeric
 * client-fit match percentage, a second hardcoded evidence citation, and an
 * local context-membership switch. The Context Packet is read-only here;
 * there is no thread-context-membership mutation endpoint to call.
 */

const MONO = "var(--meri-font-mono, Inter, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif)";

function providerLabel(citation: MeriCitation): string {
  return citation.tool.replace(/_/g, ' ').toUpperCase();
}

function locatorLabel(citation: MeriCitation): string {
  return citation.type.replace(/_/g, ' ').toUpperCase();
}

interface MeriSourceDetailProps {
  citations: MeriCitation[];
  initialIndex: number;
  /** Real client scope label, when one is set — used in the provenance row rather than a fabricated one. */
  scopeLabel: string;
  onClose: () => void;
}

export function MeriSourceDetail({ citations, initialIndex, scopeLabel, onClose }: MeriSourceDetailProps) {
  const [index, setIndex] = useState(initialIndex);
  useEffect(() => { setIndex(initialIndex); }, [citations, initialIndex]);

  const count = citations.length;
  const clamped = count > 0 ? ((index % count) + count) % count : 0;
  const citation = citations[clamped];

  if (!citation) return null;

  return (
    <div style={{ animation: 'vnext-meri-rise .2s cubic-bezier(.2,0,0,1)' }}>
      <div style={{ padding: '14px 20px 0' }}>
        <button
          type="button"
          onClick={onClose}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            border: 0,
            background: 'transparent',
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.08em',
            color: '#667085',
            cursor: 'pointer',
          }}
        >
          <MeriIcon name="ChevronLeft" size={13} color="#98A2B3" />
          BACK TO CONTEXT
        </button>
      </div>
      <div style={{ padding: '12px 20px 14px', borderBottom: '1px solid #EAECF0' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            type="button"
            title="Previous source"
            aria-label="Previous source"
            disabled={count <= 1}
            onClick={() => setIndex((i) => i - 1)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              border: '1px solid #EAECF0',
              color: '#667085',
              opacity: count <= 1 ? 0.5 : 1,
            }}
          >
            <MeriIcon name="ChevronLeft" size={14} />
          </button>
          <button
            type="button"
            title="Next source"
            aria-label="Next source"
            disabled={count <= 1}
            onClick={() => setIndex((i) => i + 1)}
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: 26,
              height: 26,
              borderRadius: 7,
              border: '1px solid #EAECF0',
              color: '#667085',
              opacity: count <= 1 ? 0.5 : 1,
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
        </div>
        <div style={{ marginTop: 12, fontFamily: MONO, fontSize: 9.5, fontWeight: 500, letterSpacing: '.08em', color: '#667085' }}>
          {providerLabel(citation)}
        </div>
        <div style={{ marginTop: 7, fontSize: 16, lineHeight: '23px', fontWeight: 600, color: '#101828' }}>
          {citation.title}
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
            {locatorLabel(citation)}
          </span>
          {citation.url ? (
            <a
              href={citation.url}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                height: 24,
                padding: '0 9px',
                borderRadius: 6,
                border: '1px solid #D0D5DD',
                textDecoration: 'none',
              }}
            >
              <span style={{ fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.07em', color: '#344054' }}>
                OPEN SOURCE
              </span>
              <MeriIcon name="LinkExternal01" size={11} color="#101828" />
            </a>
          ) : null}
        </div>
      </div>

      <div style={{ padding: '16px 20px', borderBottom: '1px solid #EAECF0' }}>
        <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 500, letterSpacing: '.09em', color: '#667085' }}>
          EXCERPT
        </div>
        <div style={{ marginTop: 9, fontSize: 13, lineHeight: '20px', color: '#344054' }}>
          {citation.snippet ?? 'No excerpt was returned for this source.'}
        </div>
      </div>

      <div style={{ padding: '16px 20px' }}>
        <div style={{ fontFamily: MONO, fontSize: 9.5, fontWeight: 500, letterSpacing: '.09em', color: '#667085' }}>
          PROVENANCE
        </div>
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {[
            ['SOURCE', providerLabel(citation)],
            ['RETRIEVED', 'THIS TURN'],
            ['TURN SCOPE', scopeLabel],
            ['CITATION', `${citation.title} · ${locatorLabel(citation)}`],
          ].map(([label, value]) => (
            <div key={label} style={{ display: 'flex', gap: 12 }}>
              <span style={{ flex: '0 0 96px', fontFamily: MONO, fontSize: 9, fontWeight: 500, letterSpacing: '.07em', color: '#98A2B3' }}>
                {label}
              </span>
              <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: '18px', color: '#344054' }}>
                {value}
              </span>
            </div>
          ))}
        </div>
        <div style={{ marginTop: 12, fontSize: 11.5, lineHeight: '16px', color: '#98A2B3' }}>
          Meri never edits source content.
        </div>
      </div>
    </div>
  );
}
