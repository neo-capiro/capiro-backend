import type { ReactNode } from 'react';
import { ClockCircleOutlined, TeamOutlined } from '@ant-design/icons';
import { Pill, type PillSev } from './EvidenceBadge.js';

export interface DossierHeroScope {
  typeLabel: string;
  label: string;
  /** Scope glyph (prototype `scopeMeta().icon`). Defaults to the client glyph. */
  icon?: ReactNode;
  /** Glyph color (prototype `scopeMeta().color`; client = ink-2). */
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
    <div className="dsr-hero">
      <div className="dsr-hero-meta">
        <span className="dsr-num">{num}</span>
        <Pill sev={statusSev}>{statusLabel}</Pill>
        {metaChips.map((m, i) => (
          <span className="dsr-metachip" key={i}>
            {m}
          </span>
        ))}
      </div>
      <h1 className="dsr-title">{title}</h1>
      <div className="dsr-hero-sub">
        {scope ? (
          <>
            <div className="dsr-scopechip">
              <span style={{ display: 'inline-flex', color: scope.color ?? 'var(--ink-2)' }}>
                {scope.icon ?? <TeamOutlined />}
              </span>
              <span className="dsr-scopechip-type">{scope.typeLabel}</span>
              <span className="dsr-scopechip-label">{scope.label}</span>
            </div>
            {stance ? (
              <div className="dsr-herofield">
                <span className="dsr-herofield-label">Stance</span>
                <Pill sev={stance.sev}>{stance.label}</Pill>
              </div>
            ) : null}
            {priorityLabel ? (
              <div className="dsr-herofield">
                <span className="dsr-herofield-label">Priority</span>
                <span className="dsr-herofield-value">{priorityLabel}</span>
              </div>
            ) : null}
          </>
        ) : null}
        <span className="dsr-hero-sub-spacer" />
        {lastSynced ? (
          <span className="dsr-synced">
            <ClockCircleOutlined /> Synced {lastSynced}
          </span>
        ) : null}
      </div>
    </div>
  );
}
