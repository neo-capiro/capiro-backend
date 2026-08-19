/**
 * UI-free logic + contract types shared between the canonical Analyst Console
 * (AnalystConsolePage.tsx, antd) and its vNext port
 * (vnext/pages/admin-misc/VNextAnalystConsolePage.tsx). Extracted verbatim —
 * behavior unchanged; the canonical page re-exports what it previously
 * declared so its public API is identical.
 */

// ── Shared types (mirror the shipped capiro-admin + programs API contracts) ────

export interface ReviewCounts {
  reconciliation: { openCount: number; oldestOpenAt: string | null };
  programMatch: { openCount: number; quarantinedCount: number; oldestOpenAt: string | null };
  personCandidate: { openCount: number; oldestOpenAt: string | null };
  personnelMerge: { openCount: number; oldestOpenAt: string | null };
  provisionPeLink: { candidateCount: number; oldestOpenAt: string | null };
  programQuarantine: { count: number };
  personnelQuarantine: { count: number };
}

export const ALIAS_TYPES = [
  'canonical',
  'acronym',
  'pe_title',
  'project_title',
  'p1_line_name',
  'mdap_name',
  'office_usage',
  'congressional',
  'sam_usage',
  'award_usage',
] as const;
export type AliasType = (typeof ALIAS_TYPES)[number];

export interface ProgramAlias {
  id: string;
  programId: string;
  alias: string;
  aliasNormalized: string;
  aliasType: string;
  source: string | null;
  sourceUrl: string | null;
  confidence: number;
}

export interface ProgramSearchRow {
  id: string;
  canonicalName: string;
  component: string | null;
  mdapCode: string | null;
  status: string;
}

export interface DuplicateAliasGroup {
  aliasNormalized: string;
  programs: Array<{ programId: string; canonicalName: string | null; status: string | null; aliasId: string }>;
}

export type QuarantineType = 'program_element' | 'acquisition_personnel';

export interface QuarantineRow {
  id: string;
  rawRecord: unknown;
  reason: string | null;
  source: string;
  quarantinedAt: string;
}

export interface QuarantineResponse {
  data: QuarantineRow[];
  total: number;
  page: number;
  limit: number;
}

export interface AuditLog {
  id: string;
  actorUserId: string;
  actorRole: string;
  action: string;
  entityType: string;
  entityId: string | null;
  before: unknown;
  after: unknown;
  occurredAt: string;
}

export interface AuditLogResponse {
  data: AuditLog[];
  total: number;
  page: number;
  limit: number;
}

// ── SLA helpers ───────────────────────────────────────────────────────────────

/**
 * Approximate "business days" elapsed since `iso`. Weekends are skipped so a
 * Friday-queued item isn't flagged red purely for sitting over a weekend.
 */
export function businessDaysSince(iso: string | null): number | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const now = Date.now();
  if (now <= then) return 0;
  let days = 0;
  const cursor = new Date(then);
  // Count whole elapsed days, skipping Sat/Sun on the target side.
  while (cursor.getTime() + 24 * 60 * 60 * 1000 <= now) {
    cursor.setTime(cursor.getTime() + 24 * 60 * 60 * 1000);
    const dow = cursor.getDay();
    if (dow !== 0 && dow !== 6) days += 1;
  }
  return days;
}

export function ageLabel(iso: string | null): string {
  if (!iso) return '—';
  const ms = Math.max(0, Date.now() - new Date(iso).getTime());
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / (60 * 60 * 1000));
  if (hours >= 1) return `${hours}h`;
  const minutes = Math.floor(ms / (60 * 1000));
  return `${minutes}m`;
}

/** amber after 1 business day open, red after 3. */
export function slaColor(oldestOpenAt: string | null): 'green' | 'gold' | 'red' {
  const bd = businessDaysSince(oldestOpenAt);
  if (bd === null) return 'green';
  if (bd >= 3) return 'red';
  if (bd >= 1) return 'gold';
  return 'green';
}
