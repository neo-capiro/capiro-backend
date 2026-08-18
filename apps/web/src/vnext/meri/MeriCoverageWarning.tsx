import type { ChatMessageRetrieval } from '../../components/chat/chat-store.js';
import { MeriIcon, type MeriIconName } from './meri-icons.js';

/**
 * MeriCoverageWarning — expanded detail behind the trust strip's coverage
 * pill, naming exactly which domains the retrieval plan required, searched,
 * partially covered or missed. Pixel-parity port of the prototype's `COV`
 * tone dictionary (screen F).
 *
 * Every field here — requiredDomains, searchedDomains, partialDomains,
 * missingDomains, stopReason — is the server's own RetrievalFrame, carried
 * through by the ChatMessageRetrieval widening. There is no "sources
 * disagree" state: nothing in the retrieval frame reports a conflict between
 * sources, so — unlike the prototype's four-tone COV dictionary — this only
 * ever renders as a missing or a partial warning, never a conflict.
 */

const MONO = "var(--meri-font-mono, 'IBM Plex Mono', monospace)";

interface Tone {
  label: string;
  icon: MeriIconName;
  bg: string;
  ring: string;
  fg: string;
}

const TONE: Record<'missing' | 'partial', Tone> = {
  missing: { label: 'REQUIRED SOURCE MISSING', icon: 'AlertCircle', bg: '#FEF3F2', ring: '#FECDCA', fg: '#B42318' },
  partial: { label: 'PARTIAL COVERAGE', icon: 'AlertTriangle', bg: '#FFFAEB', ring: '#FEDF89', fg: '#B54708' },
};

function domainLabel(domain: string): string {
  return domain.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * `coverage.stopReason` is a fixed server enum (`complete` | `partial` |
 * `no-retrieval-required`), not a sentence — render its meaning, not the
 * raw code.
 */
function stopReasonCopy(stopReason: string): string | null {
  if (stopReason === 'partial') {
    return 'Meri stopped retrieving before covering every domain the plan required.';
  }
  return null;
}

/** Null when coverage is complete and every required domain was searched — nothing to warn about. */
export function coverageWarningTone(retrieval: ChatMessageRetrieval): 'missing' | 'partial' | null {
  const required = retrieval.plan.requiredDomains ?? [];
  const missing = retrieval.coverage.missingDomains ?? [];
  const partial = retrieval.coverage.partialDomains ?? [];
  const missingRequired = required.some((domain) => missing.includes(domain));
  if (missingRequired) return 'missing';
  if (!retrieval.coverage.complete || partial.length > 0 || missing.length > 0) return 'partial';
  return null;
}

export function MeriCoverageWarning({ retrieval }: { retrieval: ChatMessageRetrieval }) {
  const tone = coverageWarningTone(retrieval);
  if (!tone) return null;
  const spec = TONE[tone];
  const missing = retrieval.coverage.missingDomains ?? [];
  const partial = retrieval.coverage.partialDomains ?? [];
  const searched = retrieval.coverage.searchedDomains ?? [];

  return (
    <div
      role="status"
      style={{
        margin: '0 18px 16px',
        padding: '13px 15px',
        borderRadius: 10,
        background: spec.bg,
        boxShadow: `inset 0 0 0 1px ${spec.ring}`,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
        <MeriIcon name={spec.icon} size={14} color={spec.fg} />
        <span
          style={{
            fontFamily: MONO,
            fontSize: 9.5,
            fontWeight: 500,
            letterSpacing: '.08em',
            color: spec.fg,
          }}
        >
          {spec.label}
        </span>
      </div>

      {missing.length ? (
        <div style={{ marginTop: 9, fontSize: 13, lineHeight: '19px', color: '#344054' }}>
          Not searched: {missing.map(domainLabel).join(', ')}.
        </div>
      ) : null}
      {partial.length ? (
        <div style={{ marginTop: missing.length ? 4 : 9, fontSize: 13, lineHeight: '19px', color: '#344054' }}>
          Incomplete results: {partial.map(domainLabel).join(', ')}.
        </div>
      ) : null}
      {searched.length ? (
        <div
          style={{
            marginTop: 8,
            fontFamily: MONO,
            fontSize: 9,
            fontWeight: 500,
            letterSpacing: '.07em',
            color: spec.fg,
          }}
        >
          SEARCHED · {searched.map(domainLabel).join(' · ').toUpperCase()}
        </div>
      ) : null}
      {stopReasonCopy(retrieval.coverage.stopReason) ? (
        <div style={{ marginTop: 8, fontSize: 12.5, lineHeight: '18px', color: '#475467' }}>
          {stopReasonCopy(retrieval.coverage.stopReason)}
        </div>
      ) : null}
    </div>
  );
}
