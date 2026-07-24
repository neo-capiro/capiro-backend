import type { ReactNode } from 'react';
import type { EvidenceOrigin } from '@capiro/shared';

/** The six severities the dossier pill primitive supports (matches SEV in the prototype). */
export type PillSev = 'critical' | 'notable' | 'info' | 'success' | 'accent' | 'neutral';

/** The single badge/pill primitive — every status/result/stance/basis/evidence chip. */
export function Pill({ sev, children }: { sev: PillSev; children: ReactNode }) {
  return <span className={`dsr-pill ${sev}`}>{children}</span>;
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
