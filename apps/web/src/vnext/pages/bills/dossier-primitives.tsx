import type { CSSProperties, ReactNode } from 'react';
import type { EvidenceOrigin } from '@capiro/shared';
import { CapiroBadge, type CapiroBadgeTone } from '../../components/badges/index.js';
import {
  CapiroTable,
  CapiroTableBody,
  CapiroTableCell,
  CapiroTableHead,
  CapiroTableHeaderCell,
  CapiroTableWrap,
} from '../../components/tables/index.js';
import { fmtAmt, fmtDate, fmtDelta } from '../../../components/dossier/dossier-format.js';

/**
 * vNext-native dossier primitives — the Untitled UI re-skin of
 * `components/dossier/*` (pill, evidence badge, KPI strip, timeline, PE table,
 * source link, hero). The legacy components stay untouched: they are shared
 * with the canonical LegiWatch drawer (pages/radar/BillDrawer.tsx), so the
 * vNext surface gets its own presentation layer here instead. Behavior — props,
 * copy, empty/absent handling — mirrors the legacy files 1:1; only presentation
 * moves onto the vNext token layer (`--capiro-*`).
 *
 * The pure formatters (fmtDate/fmtAmt/fmtDelta/scope labels) are reused from
 * dossier-format.ts, which is UI-free (no antd, no CSS) and therefore safe to
 * import from vNext under the no-legacy-ui contract. `deltaColor` is the one
 * exception — it emits legacy `--ink-*`/`--positive` tokens — so this module
 * carries a vNext-token equivalent, `deltaColorVNext`.
 */

/* ── Severity system ─────────────────────────────────────────────────────── */

/** The six severities the dossier pill primitive supports (matches SEV in the prototype). */
export type PillSev = 'critical' | 'notable' | 'info' | 'success' | 'accent' | 'neutral';

const SEV_TONE: Record<PillSev, CapiroBadgeTone> = {
  critical: 'danger',
  notable: 'warning',
  info: 'info',
  success: 'success',
  accent: 'info',
  neutral: 'neutral',
};

/** Foreground color per severity — the prototype's `SEV[sev][0]`, on vNext tokens. */
export const SEV_COLOR: Record<PillSev, string> = {
  critical: 'var(--capiro-color-danger)',
  notable: 'var(--capiro-color-warning)',
  info: 'var(--capiro-color-info)',
  success: 'var(--capiro-color-success)',
  accent: 'var(--capiro-color-text-accent)',
  neutral: 'var(--capiro-color-text-secondary)',
};

/** The single badge/pill primitive — every status/result/stance/basis/evidence chip. */
export function Pill({ sev, children }: { sev: PillSev; children: ReactNode }) {
  return (
    <CapiroBadge
      tone={SEV_TONE[sev]}
      className={`b360-pill b360-pill--${sev}`}
      data-sev={sev}
    >
      {children}
    </CapiroBadge>
  );
}

/** Provenance origin → evidence badge {label, severity} (Official / Capiro analysis / Analyst outlook). */
export function evBadge(origin: EvidenceOrigin): { label: string; sev: PillSev } {
  if (origin === 'official') return { label: 'Official', sev: 'neutral' };
  if (origin === 'derived') return { label: 'Capiro analysis', sev: 'accent' };
  return { label: 'Analyst outlook', sev: 'notable' };
}

/** Evidence provenance badge. */
export function EvidenceBadge({ origin }: { origin: EvidenceOrigin }) {
  const b = evBadge(origin);
  return <Pill sev={b.sev}>{b.label}</Pill>;
}

/**
 * Delta color token on the vNext layer (positive → success, negative → danger,
 * flat → neutral ink). Same sign logic as dossier-format's `deltaColor`, which
 * cannot be reused directly because it emits legacy `--ink-*` tokens.
 */
export function deltaColorVNext(d: number | null | undefined): string {
  if (d == null || d === 0) return 'var(--capiro-color-text-secondary)';
  return d > 0 ? 'var(--capiro-color-success)' : 'var(--capiro-color-danger)';
}

/* ── Icons (module-local, same contract as components/icons: em-sized,
      currentColor stroke, aria-hidden — call sites carry the text label) ──── */

function Glyph({
  size = 1,
  style,
  children,
}: {
  size?: number;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={`${size}em`}
      height={`${size}em`}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      style={{ flexShrink: 0, verticalAlign: '-0.125em', ...style }}
    >
      {children}
    </svg>
  );
}

export function BackIcon() {
  return (
    <Glyph>
      <path d="M19 12H5M11 18l-6-6 6-6" />
    </Glyph>
  );
}

export function CloseIcon() {
  return (
    <Glyph>
      <path d="M6 6l12 12M18 6L6 18" />
    </Glyph>
  );
}

export function OpenFullIcon() {
  return (
    <Glyph>
      <path d="M14 4h6v6M20 4l-8 8M11 5H6a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-5" />
    </Glyph>
  );
}

export function ClockIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Glyph>
  );
}

export function ScopeTeamIcon() {
  return (
    <Glyph>
      <circle cx="9" cy="8.5" r="3.25" />
      <path d="M3.5 19c.6-3 2.9-4.5 5.5-4.5s4.9 1.5 5.5 4.5" />
      <path d="M15.5 5.6a3.25 3.25 0 0 1 0 5.8M17.6 14.9c1.6.7 2.6 2 2.9 4.1" />
    </Glyph>
  );
}

export function InfoIcon() {
  return (
    <Glyph>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 11v5M12 7.75v.5" />
    </Glyph>
  );
}

export function GavelIcon() {
  return (
    <Glyph size={0.95}>
      <path d="M14 13l-7.5 7.5a2.1 2.1 0 0 1-3-3L11 10" />
      <path d="M9.5 7.5l7 7" />
      <path d="M13 4l7 7" />
      <path d="M16 3l5 5" />
      <path d="M11 6l5 5" />
    </Glyph>
  );
}

export function AudioIcon() {
  return (
    <Glyph>
      <rect x="9" y="3" width="6" height="12" rx="3" />
      <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
    </Glyph>
  );
}

export function DownloadIcon() {
  return (
    <Glyph>
      <path d="M12 4v11M7 10.5l5 5 5-5M4.5 19.5h15" />
    </Glyph>
  );
}

/* ── KPI strip (6 cells, 3-up hairline grid) ─────────────────────────────── */

export interface DossierKpi {
  label: string;
  value: string;
  sub: string | null;
  /**
   * Explicit value color, matching the prototype's per-cell `kv(color, mono)`
   * (delta sign colors, or the muted ink of an unavailable cell). Takes
   * precedence over `sev`; omit both for the default primary ink.
   */
  color?: string | null;
  /** Severity shorthand — resolved to `SEV_COLOR[sev]`. */
  sev?: PillSev | null;
  /** Monospace + tabular numerals — the prototype's `kv(_, true)` cells. */
  mono?: boolean;
}

function valueColor(k: DossierKpi): string | undefined {
  if (k.color) return k.color;
  if (k.sev) return SEV_COLOR[k.sev];
  return undefined;
}

/**
 * The 6-cell KPI strip (3-up hairline grid): label / value / sub per cell. The
 * value carries the prototype's per-cell color and optional monospace, so a
 * failed vote result reads red and every amount aligns on tabular numerals.
 */
export function DossierKpiStrip({ items }: { items: DossierKpi[] }) {
  return (
    <div className="b360-kpi-strip">
      {items.map((k, i) => (
        <div className="b360-kpi" key={`${k.label}-${i}`}>
          <div className="b360-kpi-label">{k.label}</div>
          <div className={`b360-kpi-value${k.mono ? ' mono' : ''}`} style={{ color: valueColor(k) }}>
            {k.value}
          </div>
          {k.sub != null ? <div className="b360-kpi-sub">{k.sub}</div> : null}
        </div>
      ))}
    </div>
  );
}

/* ── Legislative-path timeline ───────────────────────────────────────────── */

export type TimelineMilestoneState = 'done' | 'current' | 'failed' | 'upcoming';

export interface TimelineMilestone {
  date: string | null;
  label: string;
  detail: string | null;
  state: TimelineMilestoneState;
  sev?: PillSev;
}

function sevForState(m: TimelineMilestone): PillSev {
  if (m.state === 'failed') return 'critical';
  if (m.state === 'current') return m.sev ?? 'info';
  if (m.state === 'done') return 'success';
  return 'neutral';
}

/**
 * Vertical legislative-path timeline. Dot color follows milestone state; the dot
 * is filled for any non-upcoming state and hollow (canvas fill) for upcoming; the
 * connector line is transparent on the last item. Failed → "Failed" pill,
 * Current → "Current" pill.
 */
export function EventTimeline({ milestones }: { milestones: TimelineMilestone[] }) {
  return (
    <>
      {milestones.map((m, i) => {
        const sev = sevForState(m);
        const color = SEV_COLOR[sev];
        const filled = m.state !== 'upcoming';
        const last = i === milestones.length - 1;
        return (
          <div className="b360-timeline-row" key={`${m.label}-${i}`}>
            <div className="b360-rail">
              <span
                className="b360-dot"
                style={{
                  borderColor: color,
                  background: filled ? color : 'var(--capiro-color-bg-canvas)',
                }}
              />
              <span
                className="b360-line"
                style={{ background: last ? 'transparent' : 'var(--capiro-color-border-default)' }}
              />
            </div>
            <div className="b360-ms-body">
              <div className="b360-ms-head">
                <span
                  className="b360-ms-label"
                  style={{
                    color:
                      m.state === 'upcoming'
                        ? 'var(--capiro-color-text-muted)'
                        : 'var(--capiro-color-text-primary)',
                  }}
                >
                  {m.label}
                </span>
                {m.state === 'failed' ? <Pill sev="critical">Failed</Pill> : null}
                {m.state === 'current' ? <Pill sev={sev}>Current</Pill> : null}
                <span className="b360-ms-date">{fmtDate(m.date) || '—'}</span>
              </div>
              {m.detail ? <div className="b360-ms-detail">{m.detail}</div> : null}
            </div>
          </div>
        );
      })}
    </>
  );
}

/* ── PE impacts table (shared by Funding + Impact tabs) ──────────────────── */

export interface PeImpactRow {
  pe: string;
  name: string | null;
  requestMillions: number | null;
  houseMillions: number | null;
  senateMillions: number | null;
  conferenceMillions?: number | null;
  enactedMillions?: number | null;
  vehicleTrack?: string | null;
  houseLabel?: string;
  senateLabel?: string;
  conferenceLabel?: string;
  deltaVsRequestMillions: number | null;
  basis: 'explicit' | 'inferred';
}

/**
 * The Program-Element impacts table, reused verbatim by both the Funding and
 * Impact tabs — the Untitled UI CapiroTable primitives inside the dossier's
 * card chrome. Columns: Program element | Request | House | Senate | Δ vs req.
 * House and Δ are emphasized; Request/Senate are muted; missing chamber amounts
 * render "—" (never $0). Each PE row deep-links via onOpenPe.
 */
export function FundingPositionTable({
  title,
  count,
  rows,
  onOpenPe,
}: {
  title: string;
  count?: number;
  rows: PeImpactRow[];
  onOpenPe?: (pe: string) => void;
}) {
  const first = rows[0];
  const authorization = first?.vehicleTrack === 'authorization';
  const houseLabel =
    first?.houseLabel ??
    (authorization
      ? 'House authorization'
      : first?.vehicleTrack === 'appropriation'
        ? 'House appropriation'
        : 'House amount (track not verified)');
  const senateLabel =
    first?.senateLabel ??
    (authorization
      ? 'Senate authorization'
      : first?.vehicleTrack === 'appropriation'
        ? 'Senate appropriation'
        : 'Senate amount (track not verified)');
  const conferenceLabel =
    first?.conferenceLabel ??
    (authorization
      ? 'NDAA conference authorization'
      : first?.vehicleTrack === 'appropriation'
        ? 'Appropriations conference'
        : 'Conference amount (track not verified)');
  const hasConference = rows.some((row) => row.conferenceMillions != null);
  const hasEnacted = rows.some((row) => row.enactedMillions != null);
  return (
    <div className="b360-petable">
      <div className="b360-petable-title">
        <span>{title}</span>
        {count != null ? <span className="b360-petable-count">{count} lines</span> : null}
      </div>
      <CapiroTableWrap>
        <CapiroTable className="b360-petable-table">
          <CapiroTableHead>
            <tr>
              <CapiroTableHeaderCell>Program element</CapiroTableHeaderCell>
              <CapiroTableHeaderCell className="b360-col-num">Request</CapiroTableHeaderCell>
              <CapiroTableHeaderCell className="b360-col-num">{houseLabel}</CapiroTableHeaderCell>
              <CapiroTableHeaderCell className="b360-col-num">{senateLabel}</CapiroTableHeaderCell>
              {hasConference ? (
                <CapiroTableHeaderCell className="b360-col-num">{conferenceLabel}</CapiroTableHeaderCell>
              ) : null}
              {hasEnacted ? (
                <CapiroTableHeaderCell className="b360-col-num">Enacted appropriation</CapiroTableHeaderCell>
              ) : null}
              <CapiroTableHeaderCell className="b360-col-num">Δ vs req</CapiroTableHeaderCell>
            </tr>
          </CapiroTableHead>
          <CapiroTableBody>
            {rows.map((r) => (
              <tr key={r.pe}>
                <CapiroTableCell className="b360-pe-cell">
                  <button
                    type="button"
                    className="b360-pe-btn"
                    onClick={() => onOpenPe?.(r.pe)}
                    title={r.name ?? r.pe}
                  >
                    <span className="b360-pe-code">{r.pe}</span>
                    <span className="b360-pe-name">{r.name ?? ''}</span>
                  </button>
                  <span className={`b360-basis ${r.basis}`}>
                    {r.basis === 'explicit' ? 'Explicit PE match' : 'Inferred match'}
                  </span>
                </CapiroTableCell>
                <CapiroTableCell className="b360-num-cell muted">{fmtAmt(r.requestMillions)}</CapiroTableCell>
                <CapiroTableCell className="b360-num-cell strong">{fmtAmt(r.houseMillions)}</CapiroTableCell>
                <CapiroTableCell className="b360-num-cell muted">{fmtAmt(r.senateMillions)}</CapiroTableCell>
                {hasConference ? (
                  <CapiroTableCell className="b360-num-cell muted">
                    {fmtAmt(r.conferenceMillions ?? null)}
                  </CapiroTableCell>
                ) : null}
                {hasEnacted ? (
                  <CapiroTableCell className="b360-num-cell strong">
                    {fmtAmt(r.enactedMillions ?? null)}
                  </CapiroTableCell>
                ) : null}
                <CapiroTableCell
                  className="b360-num-cell strong"
                  style={{ color: deltaColorVNext(r.deltaVsRequestMillions) }}
                >
                  {fmtDelta(r.deltaVsRequestMillions)}
                </CapiroTableCell>
              </tr>
            ))}
          </CapiroTableBody>
        </CapiroTable>
      </CapiroTableWrap>
    </div>
  );
}

/* ── Source link + freshness pill ────────────────────────────────────────── */

/** A source label, linked when a URL is present (opens in a new tab), else plain text. */
export function SourceLink({ label, url }: { label: string; url?: string | null }) {
  if (url) {
    return (
      <a className="b360-source-link" href={url} target="_blank" rel="noreferrer">
        {label}
      </a>
    );
  }
  return <span>{label}</span>;
}

/** Current/Stale freshness pill (success/notable), keyed off a boolean. */
export function FreshnessPill({ fresh }: { fresh: boolean }) {
  return <Pill sev={fresh ? 'success' : 'notable'}>{fresh ? 'Current' : 'Stale'}</Pill>;
}

/* ── Hero ────────────────────────────────────────────────────────────────── */

export interface DossierHeroScope {
  typeLabel: string;
  label: string;
  /** Scope glyph (prototype `scopeMeta().icon`). Defaults to the client glyph. */
  icon?: ReactNode;
  /** Glyph color (prototype `scopeMeta().color`; client = secondary ink). */
  color?: string;
}

export interface DossierHeroProps {
  num: string;
  statusLabel: string;
  statusSev: PillSev;
  metaChips: string[];
  title: string;
  scope?: DossierHeroScope | null;
  stance?: { label: string; sev: PillSev } | null;
  priorityLabel?: string | null;
  lastSynced?: string | null;
}

/**
 * The dossier hero: identifier + canonical status pill + meta chips, a serif
 * title, and (only when the dossier is opened in a client/portfolio context) a
 * scope chip + stance + priority, then the last-synced line. Matches the Bill
 * 360 prototype hero exactly.
 */
export function DossierHero({
  num,
  statusLabel,
  statusSev,
  metaChips,
  title,
  scope,
  stance,
  priorityLabel,
  lastSynced,
}: DossierHeroProps) {
  return (
    <div className="b360-hero">
      <div className="b360-hero-meta">
        <span className="b360-num">{num}</span>
        <Pill sev={statusSev}>{statusLabel}</Pill>
        {metaChips.map((m, i) => (
          <span className="b360-metachip" key={i}>
            {m}
          </span>
        ))}
      </div>
      <h1 className="b360-title">{title}</h1>
      <div className="b360-hero-sub">
        {scope ? (
          <>
            <div className="b360-scopechip">
              <span
                style={{
                  display: 'inline-flex',
                  color: scope.color ?? 'var(--capiro-color-text-secondary)',
                }}
              >
                {scope.icon ?? <ScopeTeamIcon />}
              </span>
              <span className="b360-scopechip-type">{scope.typeLabel}</span>
              <span className="b360-scopechip-label">{scope.label}</span>
            </div>
            {stance ? (
              <div className="b360-herofield">
                <span className="b360-herofield-label">Stance</span>
                <Pill sev={stance.sev}>{stance.label}</Pill>
              </div>
            ) : null}
            {priorityLabel ? (
              <div className="b360-herofield">
                <span className="b360-herofield-label">Priority</span>
                <span className="b360-herofield-value">{priorityLabel}</span>
              </div>
            ) : null}
          </>
        ) : null}
        <span className="b360-hero-sub-spacer" />
        {lastSynced ? (
          <span className="b360-synced">
            <ClockIcon /> Synced {lastSynced}
          </span>
        ) : null}
      </div>
    </div>
  );
}
