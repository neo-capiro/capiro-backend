/**
 * Shared, prototype-exact presentational primitives for the Meetings & Meri v2
 * module. These are direct ports of the design prototype
 * ("Capiro — Engagement · Meetings (Meri redesign)") — inline styles reproduced
 * verbatim so the shipped UI matches it pixel-for-pixel — retyped for TypeScript
 * and wired to the real `Meeting` payload. Icons come from lucide-react (the
 * prototype used the lucide global); the Meri mark is a hand-built SVG glyph.
 *
 * Used by the Meetings module AND the dashboard Home strip (via meeting-actions
 * re-exports) so the two surfaces cannot drift.
 */
import type { CSSProperties, ReactNode } from 'react';
import { Video, MapPin, Link2Off, Check, Circle, Users, ExternalLink } from 'lucide-react';
import { providerLabel } from './meetings-format.js';
import {
  completedDebrief,
  completedPrep,
  eligibleForMeri,
  type Meeting,
  type ArtifactKind,
  type MeriState,
} from './meetings-types.js';

// ── Status model (spec §2.2 / §5): uniform gray = not complete, green =
//    COMPLETED. Green now means the artifact has been produced (prep/debrief
//    generated, notes captured) — it does NOT require approval. No red.
//    Mirrors the prototype MaterialBadges. ──
export interface MeetingStatus {
  prep: boolean;
  notes: boolean;
  debrief: boolean;
}

/** The completed artifacts for the P/N/D badges (green once generated/captured,
 *  even if not yet approved). */
export function meetingStatus(m: Meeting): MeetingStatus {
  return {
    prep: Boolean(completedPrep(m)),
    notes: Boolean(m.notesApproved || m.meri === 'done' || m.notes.length > 0),
    debrief: Boolean(completedDebrief(m)),
  };
}

/** A meeting can be shared only once it has an associated client (spec §6.2). */
export function canShare(m: Meeting): boolean {
  return Boolean(m.client);
}

/** Whether Meri's "Send Meri" affordance shows (virtual + not already captured). */
export function showSendMeri(m: Meeting): boolean {
  return m.isVirtual && m.provider !== 'In person' && m.meri !== 'done';
}

// ── Meri glyph — navy roundel + soft "m" mark (prototype MeriGlyph) ──
export function MeriGlyph({
  size = 18,
  tone = 'navy',
}: {
  size?: number;
  tone?: 'navy' | 'soft' | 'white' | 'invert';
}) {
  // 'invert' = transparent roundel + white mark, for use ON a colored button.
  const bg =
    tone === 'navy'
      ? '#0C1A38'
      : tone === 'soft'
        ? '#DEE6F8'
        : tone === 'invert'
          ? 'transparent'
          : '#fff';
  const fg = tone === 'navy' ? '#DCE4F8' : tone === 'invert' ? '#fff' : '#1A3F9F';
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: bg,
        display: 'inline-grid',
        placeItems: 'center',
        flexShrink: 0,
      }}
    >
      <svg
        width={size * 0.62}
        height={size * 0.62}
        viewBox="0 0 24 24"
        fill="none"
        stroke={fg}
        strokeWidth={2.4}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M4 18 L4 9 Q4 6 7 6 Q10 6 10 9 L10 14 Q10 12 12 12 Q14 12 14 14 L14 9 Q14 6 17 6 Q20 6 20 9 L20 18" />
      </svg>
    </span>
  );
}

const AVA_PALETTE = ['#4E78D8', '#1A3F9F', '#2E6B43', '#A26913', '#B5301B', '#6B4FA3'];
function avaColor(initials: string): string {
  let h = 0;
  for (let i = 0; i < initials.length; i++) h = (h * 31 + initials.charCodeAt(i)) >>> 0;
  return AVA_PALETTE[h % AVA_PALETTE.length] ?? '#4E78D8';
}

export function Ava({ initials, size = 28 }: { initials: string; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: avaColor(initials),
        color: '#fff',
        display: 'inline-grid',
        placeItems: 'center',
        fontSize: size * 0.38,
        fontWeight: 600,
        flexShrink: 0,
        fontFamily: 'var(--font-mono)',
      }}
    >
      {initials}
    </span>
  );
}

export function initialsOf(name: string | null | undefined): string {
  if (!name) return '??';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || '??';
}

// ── Provider / virtual tag — quiet, informational (prototype ProviderTag) ──
export function ProviderTag({ m }: { m: Meeting }) {
  const name = providerLabel(m.provider);
  if (m.isVirtual && m.joinLink) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 11.5,
          color: 'var(--ink-3)',
        }}
      >
        <Video size={13} style={{ color: 'var(--ink-3)' }} />
        {name ?? 'Virtual'}
      </span>
    );
  }
  if (!m.isVirtual) {
    return (
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          fontSize: 11.5,
          color: 'var(--ink-3)',
        }}
      >
        <MapPin size={12} />
        In person
      </span>
    );
  }
  // virtual, provider named but no parseable join link
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11.5,
        color: 'var(--ink-4)',
      }}
    >
      <Link2Off size={12} />
      {name ? `${name} · link not detected` : 'link not detected'}
    </span>
  );
}

// ── Material badge — uniform P/N/D pill (prototype MatBadge) ──
export function MatBadge({ label, done }: { label: string; done: boolean }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        fontSize: 11,
        fontWeight: 600,
        padding: '4px 10px',
        borderRadius: 6,
        whiteSpace: 'nowrap',
        background: done ? 'var(--success-soft)' : 'var(--bg-sunken)',
        color: done ? 'var(--success)' : 'var(--ink-3)',
        border: `1px solid ${done ? 'transparent' : 'var(--border-1)'}`,
      }}
    >
      {done ? <Check size={12} strokeWidth={3} /> : <Circle size={9} strokeWidth={2} />}
      {label}
    </span>
  );
}

const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  prep: 'Prep',
  notes: 'Notes',
  debrief: 'Debrief',
};

export function MaterialBadges({ m, status }: { m: Meeting; status?: MeetingStatus }) {
  const s = status ?? meetingStatus(m);
  return (
    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {(Object.keys(ARTIFACT_LABELS) as ArtifactKind[]).map((k) => (
        <MatBadge key={k} label={ARTIFACT_LABELS[k]} done={s[k]} />
      ))}
    </div>
  );
}

/** Minimal shape both `Meeting` and the dashboard `DashMeeting` satisfy, so the
 *  SAME button renders on both surfaces (no drift). */
export interface MeriActionTarget {
  meri?: MeriState | null;
  isVirtual?: boolean;
  joinLink?: string | null;
}

// ── Send Meri button — light-blue brand button → "Meri Attending" (in call) →
//    "Meri Attended" greyed (call ended, summarizing) → gone (done, summary on
//    the Notes tab). Same component used on Meetings + the dashboard strip. ──
export function SendMeriButton({
  m,
  onClick,
  size = 'md',
  block = false,
}: {
  m: MeriActionTarget;
  onClick?: () => void;
  size?: 'sm' | 'md';
  block?: boolean;
}) {
  if (m.meri === 'done') return null;
  const canDetect = m.isVirtual && m.joinLink;
  const scheduled = m.meri === 'scheduled' || m.meri === 'attending';
  // The call has ended (all participants left, or the scheduled end passed) and
  // Meri is turning the transcript into Meeting Notes — show a disabled chip.
  const attended = m.meri === 'attended';
  const pad = size === 'sm' ? '6px 12px' : '8px 14px';
  const base: CSSProperties = {
    display: block ? 'flex' : 'inline-flex',
    width: block ? '100%' : 'auto',
    justifyContent: 'center',
    alignItems: 'center',
    gap: 7,
    borderRadius: 8,
    padding: pad,
    fontFamily: 'var(--font-sans)',
    fontSize: size === 'sm' ? 12.5 : 13.5,
    fontWeight: 600,
    letterSpacing: '-0.005em',
    whiteSpace: 'nowrap',
  };
  if (attended) {
    return (
      <span
        style={{
          ...base,
          background: 'var(--bg-sunken)',
          color: 'var(--ink-3)',
          border: '1px solid var(--border-1)',
          cursor: 'default',
        }}
      >
        <MeriGlyph size={size === 'sm' ? 16 : 18} tone="soft" />
        Meri Attended
      </span>
    );
  }
  if (scheduled) {
    return (
      <span
        style={{
          ...base,
          background: 'var(--accent-soft)',
          color: 'var(--accent-ink)',
          border: '1px solid transparent',
        }}
      >
        <MeriGlyph size={size === 'sm' ? 16 : 18} tone="soft" />
        Meri Attending
      </span>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onClick?.();
      }}
      title={canDetect ? '' : 'No join link detected — paste it in the next step'}
      style={{
        ...base,
        border: 'none',
        background: 'var(--accent)',
        color: '#fff',
        cursor: 'pointer',
      }}
    >
      <MeriGlyph size={size === 'sm' ? 16 : 18} tone="invert" />
      Send Meri
    </button>
  );
}

// ── "Join" button — navy filled, same shape as Send Meri (opens the join link). ──
export function JoinButton({
  m,
  size = 'md',
}: {
  m: { isVirtual?: boolean; joinLink?: string | null };
  size?: 'sm' | 'md';
}) {
  if (!(m.isVirtual && m.joinLink)) return null;
  const pad = size === 'sm' ? '6px 12px' : '8px 14px';
  return (
    <a
      href={m.joinLink}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e) => e.stopPropagation()}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 7,
        borderRadius: 8,
        padding: pad,
        fontFamily: 'var(--font-sans)',
        fontSize: size === 'sm' ? 12.5 : 13.5,
        fontWeight: 600,
        letterSpacing: '-0.005em',
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        background: '#0C1A38',
        color: '#F5F2EB',
      }}
    >
      <ExternalLink size={size === 'sm' ? 14 : 16} />
      Join
    </a>
  );
}

// ShareToggle (binary Private/Shared segmented control) was removed in
// Phase 2 §3.e — it unshared EVERYTHING on a single click. Replaced by
// ShareArtifactsControl in MeetingDetailPanel.tsx (explicit per-artifact
// selection via ShareConfirmation).

export function SectionLabel({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        fontSize: 10.5,
        fontWeight: 700,
        textTransform: 'uppercase',
        letterSpacing: '0.09em',
        color: 'var(--ink-3)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

export function Empty({
  icon,
  title,
  body,
  action,
}: {
  icon: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 10,
        padding: '30px 24px',
        textAlign: 'center',
        color: 'var(--ink-3)',
      }}
    >
      <div
        style={{
          width: 40,
          height: 40,
          borderRadius: 10,
          background: 'var(--bg-sunken)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <span style={{ opacity: 0.4, display: 'grid', placeItems: 'center' }}>{icon}</span>
      </div>
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--ink-2)' }}>{title}</div>
      {body && <div style={{ fontSize: 12, lineHeight: 1.55, maxWidth: 300 }}>{body}</div>}
      {action}
    </div>
  );
}

export { eligibleForMeri };
