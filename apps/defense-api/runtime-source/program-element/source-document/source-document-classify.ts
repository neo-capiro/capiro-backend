/**
 * Step 0.1 — classify a committed defense-budget artifact (by filename + optional parsed
 * JSON) into the SourceDocument descriptor fields: sourceKey, fiscalYear, budgetCycle,
 * component, documentType, title, and (for committee/conference/public-law docs) the
 * `sourceTag` that the parse scripts stamp onto program_element_year_source_value.source.
 *
 * Pure + deterministic so it is unit-tested and shared by both the sync/parse scripts and
 * backfill-source-documents.ts. Returns null for artifacts that are not budget documents
 * (e.g. dow_directory_*), so the backfill can skip them.
 */

export type BudgetCycle =
  | 'pb'
  | 'hasc'
  | 'sasc'
  | 'hac_d'
  | 'sac_d'
  | 'conference'
  | 'enacted'
  | 'supplemental';

export type DocumentType =
  | 'r1'
  | 'r2'
  | 'r3'
  | 'p1'
  | 'p40'
  | 'committee_report'
  | 'conference_report'
  | 'public_law'
  | 'other';

export interface ClassifiedArtifact {
  /** Stable human key — the artifact filename without its .json extension. */
  sourceKey: string;
  fiscalYear: number | null;
  budgetCycle: BudgetCycle;
  /** ARMY | NAVY | AF | SF | DW, or null for the all-component R-1 / committee docs. */
  component: string | null;
  documentType: DocumentType;
  title: string;
  /**
   * The `source` tag the committee/conference/public-law parse scripts write to
   * program_element_year_source_value.source (e.g. 'hasc_report_fy27'); null for J-books.
   */
  sourceTag: string | null;
}

/** Minimal shape of a parsed artifact we read metadata from (all optional). */
export interface ArtifactMeta {
  fy?: number | null;
  chamber?: string | null;
  sourceUrl?: string | null;
  publisher?: string | null;
}

function baseName(fileName: string): string {
  const noDir = fileName.replace(/\\/g, '/').split('/').pop() ?? fileName;
  return noDir.replace(/\.json$/i, '');
}

function detectFy(base: string, meta?: ArtifactMeta): number | null {
  const m = base.match(/fy(\d{4})/i);
  if (m) return Number(m[1]);
  if (meta && typeof meta.fy === 'number' && Number.isFinite(meta.fy)) return meta.fy;
  return null;
}

function fy2(fy: number | null): string | null {
  return fy === null ? null : String(fy).slice(-2);
}

function detectComponent(tokens: string[]): string | null {
  if (tokens.includes('af')) return 'AF';
  if (tokens.includes('sf')) return 'SF';
  if (tokens.includes('dw')) return 'DW';
  if (tokens.includes('navy') || tokens.includes('rdten') || tokens.includes('usmc')) return 'NAVY';
  if (tokens.includes('army') || tokens.some((t) => /^vol\d/.test(t))) return 'ARMY';
  return null;
}

/**
 * Classify an artifact. Pass the parsed JSON (or just {fy}) as `meta` to fill fiscalYear
 * when the filename omits it. Returns null when the filename is not a recognized budget
 * artifact.
 */
export function classifyArtifact(fileName: string, meta?: ArtifactMeta): ClassifiedArtifact | null {
  const sourceKey = baseName(fileName);
  const lower = sourceKey.toLowerCase();
  const tokens = lower.split(/[_.\s-]+/).filter(Boolean);
  const fy = detectFy(lower, meta);
  const ff = fy2(fy);

  // ── DoD Comptroller J-books (President's Budget) ──────────────────────────
  if (lower.startsWith('jbook_r1')) {
    return mk(sourceKey, fy, 'pb', null, 'r1', `DoD Comptroller R-1 RDT&E master list${fyLabel(fy)}`, null);
  }
  if (lower.startsWith('jbook_performers')) {
    const comp = detectComponent(tokens);
    return mk(sourceKey, fy, 'pb', comp, 'r3', `RDT&E R-3 performers${compLabel(comp)}${fyLabel(fy)}`, null);
  }
  if (lower.startsWith('jbook_r2')) {
    const comp = detectComponent(tokens);
    return mk(sourceKey, fy, 'pb', comp, 'r2', `RDT&E R-2/R-2A justification${compLabel(comp)}${fyLabel(fy)}`, null);
  }
  if (lower.startsWith('jbook_p1') || lower.startsWith('jbook_p40')) {
    const comp = detectComponent(tokens);
    const dt: DocumentType = lower.startsWith('jbook_p40') ? 'p40' : 'p1';
    return mk(sourceKey, fy, 'pb', comp, dt, `Procurement ${dt.toUpperCase()}${compLabel(comp)}${fyLabel(fy)}`, null);
  }

  // ── Congressional committee / conference / enacted marks ──────────────────
  if (lower.includes('hasc') || (lower.includes('armed_services') && (meta?.chamber ?? '').toUpperCase() === 'HASC')) {
    return mk(sourceKey, fy, 'hasc', null, 'committee_report', `HASC report marks${fyLabel(fy)}`, ff ? `hasc_report_fy${ff}` : null);
  }
  if (lower.includes('sasc') || (lower.includes('armed_services') && (meta?.chamber ?? '').toUpperCase() === 'SASC')) {
    return mk(sourceKey, fy, 'sasc', null, 'committee_report', `SASC report marks${fyLabel(fy)}`, ff ? `sasc_report_fy${ff}` : null);
  }
  if (lower.includes('hac_d') || lower.includes('hacd')) {
    return mk(sourceKey, fy, 'hac_d', null, 'committee_report', `HAC-D report marks${fyLabel(fy)}`, ff ? `hac_d_report_fy${ff}` : null);
  }
  if (lower.includes('sac_d') || lower.includes('sacd')) {
    return mk(sourceKey, fy, 'sac_d', null, 'committee_report', `SAC-D report marks${fyLabel(fy)}`, ff ? `sac_d_report_fy${ff}` : null);
  }
  if (lower.includes('public_law')) {
    return mk(sourceKey, fy, 'enacted', null, 'public_law', `Defense Appropriations public law${fyLabel(fy)}`, ff ? `public_law_fy${ff}` : null);
  }
  if (lower.includes('conference') || lower.includes('ndaa_conf')) {
    return mk(sourceKey, fy, 'conference', null, 'conference_report', `NDAA conference report${fyLabel(fy)}`, ff ? `conference_report_fy${ff}` : null);
  }

  return null;
}

function mk(
  sourceKey: string,
  fiscalYear: number | null,
  budgetCycle: BudgetCycle,
  component: string | null,
  documentType: DocumentType,
  title: string,
  sourceTag: string | null,
): ClassifiedArtifact {
  return { sourceKey, fiscalYear, budgetCycle, component, documentType, title, sourceTag };
}

function fyLabel(fy: number | null): string {
  return fy === null ? '' : ` (FY${fy})`;
}
function compLabel(comp: string | null): string {
  return comp ? ` — ${comp}` : '';
}
