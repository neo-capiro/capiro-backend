/**
 * Phase 10B-5 — expected-source → official document resolution.
 *
 * Discovery here answers:
 *   "Where is the official document corresponding to this known expected source?"
 * not:
 *   "What budget documents exist anywhere on the internet?"
 *
 * The 56 FY24 request-track expected sources are the inventory. This module is
 * pure: no HTTP, no Prisma, no observation writes. A candidate it returns still
 * has to pass the watcher's byte-fetch + classification path before anything is
 * queued for governed ingestion.
 *
 * Fail-closed rules:
 *  * official HTTPS host only (caller supplies the adapter's host allowlist)
 *  * fiscal year on the URL/title must match the expected source exactly
 *  * exhibit/family identity must match the expected sourceFamily
 *  * component (when the expected source carries one) must not contradict the
 *    document identity
 *  * zero matches → explicit no_match (never a fake success)
 *  * two+ equally-strong matches → ambiguous (never auto-pick by title similarity)
 */

import { assertFiscalYear, expectedSourceDedupKey } from '../cycle.js';
import type {
  AuthorityTrack,
  BudgetComponent,
  Chamber,
  LifecycleStage,
  SourceFamily,
} from '../types.js';

export type ExpectedSourceResolutionOutcome =
  | 'resolved'
  | 'no_match'
  | 'ambiguous'
  | 'refused_non_official_host'
  | 'refused_wrong_fiscal_year'
  | 'refused_wrong_family'
  | 'refused_wrong_component'
  | 'refused_unsupported_family';

export interface ExpectedSourceResolutionTarget {
  readonly fiscalYear: number;
  readonly authorityTrack: AuthorityTrack;
  readonly sourceFamily: SourceFamily;
  readonly stage: LifecycleStage;
  readonly chamber: Chamber;
  readonly committee: string | null;
  readonly component: BudgetComponent;
  readonly adapterId: string;
  /** When provided, must equal the canonical dedup key for the identity fields. */
  readonly dedupKey?: string;
}

export interface OfficialDocumentCandidate {
  readonly url: string;
  readonly title: string | null;
  readonly detectedFiscalYear: number | null;
  readonly detectedSourceFamily: SourceFamily | null;
  readonly detectedComponent: BudgetComponent | null;
  readonly retrievalMetadata?: Readonly<Record<string, string | number | boolean | null>>;
}

export interface ExpectedSourceResolution {
  readonly outcome: ExpectedSourceResolutionOutcome;
  readonly expectedSourceDedupKey: string;
  readonly candidate: OfficialDocumentCandidate | null;
  readonly reasons: readonly string[];
  /** Present only when outcome === 'ambiguous'. */
  readonly ambiguousCandidates: readonly OfficialDocumentCandidate[];
}

/** Deterministic official URL seeds for DoD Comptroller DW topline exhibits. */
export interface ComptrollerCatalogEntry {
  readonly sourceFamily: SourceFamily;
  readonly component: BudgetComponent;
  /** Path template under the official host; `{FY}` substituted. */
  readonly pathTemplate: string;
  readonly titleTemplate: string;
}

/**
 * Known official DW exhibit paths under the comptroller defbudget tree.
 * These are the same path conventions PE budget-doc-watch and Session 5 gold
 * evidence already rely on. Service-component volumes are NOT listed here —
 * those need a successful listing crawl or a separate service catalog.
 */
export const COMPTROLLER_DW_CATALOG: readonly ComptrollerCatalogEntry[] = Object.freeze([
  {
    sourceFamily: 'pb_overview',
    component: 'DW',
    pathTemplate: '/Portals/45/Documents/defbudget/FY{FY}/FY{FY}_Budget_Request_Overview_Book.pdf',
    titleTemplate: 'Department of Defense Fiscal Year {FY} Budget Request Overview',
  },
  {
    sourceFamily: 'pb_r1',
    component: 'DW',
    pathTemplate: '/Portals/45/Documents/defbudget/FY{FY}/FY{FY}_r1.pdf',
    titleTemplate: 'FY{FY} R-1 RDT&E Programs',
  },
  {
    sourceFamily: 'pb_p1',
    component: 'DW',
    pathTemplate: '/Portals/45/Documents/defbudget/FY{FY}/FY{FY}_p1.pdf',
    titleTemplate: 'FY{FY} P-1 Procurement Programs',
  },
  {
    sourceFamily: 'pb_o1',
    component: 'DW',
    pathTemplate: '/Portals/45/Documents/defbudget/FY{FY}/FY{FY}_o1.pdf',
    titleTemplate: 'FY{FY} O-1 Operation and Maintenance Programs',
  },
  {
    sourceFamily: 'pb_milcon_c1',
    component: 'DW',
    pathTemplate: '/Portals/45/Documents/defbudget/FY{FY}/FY{FY}_c1.pdf',
    titleTemplate: 'FY{FY} C-1 Military Construction Programs',
  },
]);

const FILENAME_FAMILY: readonly { readonly pattern: RegExp; readonly family: SourceFamily }[] =
  Object.freeze([
    { pattern: /(?:^|[_\-/])r2a(?:[_\-./]|$)/i, family: 'pb_r2a' },
    { pattern: /(?:^|[_\-/])r1(?:[_\-./]|$)/i, family: 'pb_r1' },
    { pattern: /(?:^|[_\-/])r2(?:[_\-./]|$)/i, family: 'pb_r2' },
    { pattern: /(?:^|[_\-/])r3(?:[_\-./]|$)/i, family: 'pb_r3' },
    { pattern: /(?:^|[_\-/])r4(?:[_\-./]|$)/i, family: 'pb_r4' },
    { pattern: /(?:^|[_\-/])op[_-]?5(?:[_\-./]|$)/i, family: 'pb_op5' },
    { pattern: /(?:^|[_\-/])o1(?:[_\-./]|$)/i, family: 'pb_o1' },
    { pattern: /(?:^|[_\-/])p1r?(?:[_\-./]|$)/i, family: 'pb_p1' },
    { pattern: /(?:^|[_\-/])c1(?:[_\-./]|$)/i, family: 'pb_milcon_c1' },
    { pattern: /dd[_-]?1391/i, family: 'pb_dd1391' },
    { pattern: /budget_request_overview/i, family: 'pb_overview' },
    { pattern: /p[_-]?(?:3a?|5a?|21|40)/i, family: 'pb_p_series' },
  ]);

const TITLE_FAMILY: readonly { readonly pattern: RegExp; readonly family: SourceFamily }[] =
  Object.freeze([
    { pattern: /\bR[-\s]?2A\b/i, family: 'pb_r2a' },
    { pattern: /\bR[-\s]?1\b/i, family: 'pb_r1' },
    { pattern: /\bR[-\s]?2\b/i, family: 'pb_r2' },
    { pattern: /\bR[-\s]?3\b/i, family: 'pb_r3' },
    { pattern: /\bR[-\s]?4\b/i, family: 'pb_r4' },
    { pattern: /\bOP[-\s]?5\b/i, family: 'pb_op5' },
    { pattern: /\bO[-\s]?1\b/i, family: 'pb_o1' },
    { pattern: /\bP[-\s]?1\b/i, family: 'pb_p1' },
    { pattern: /\bC[-\s]?1\b/i, family: 'pb_milcon_c1' },
    { pattern: /\bDD[-\s]?1391\b/i, family: 'pb_dd1391' },
    { pattern: /\boverview\b/i, family: 'pb_overview' },
    { pattern: /\bP[-\s]?(?:3A?|5A?|21|40)\b/i, family: 'pb_p_series' },
  ]);

const COMPONENT_HINTS: readonly { readonly pattern: RegExp; readonly component: Exclude<BudgetComponent, null> }[] =
  Object.freeze([
    { pattern: /\barmy\b|\busa\b/i, component: 'ARMY' },
    { pattern: /\bnavy\b|\busn\b/i, component: 'NAVY' },
    { pattern: /\bmarine\b|\busmc\b/i, component: 'USMC' },
    { pattern: /\bair\s*force\b|\busaf\b/i, component: 'AF' },
    { pattern: /\bspace\s*force\b|\bussf\b/i, component: 'SF' },
    { pattern: /\bdefense[-\s]?wide\b|\bdod[-\s]?wide\b|\bdw\b/i, component: 'DW' },
  ]);

function freezeResolution(input: {
  outcome: ExpectedSourceResolutionOutcome;
  expectedSourceDedupKey: string;
  candidate?: OfficialDocumentCandidate | null;
  reasons: readonly string[];
  ambiguousCandidates?: readonly OfficialDocumentCandidate[];
}): ExpectedSourceResolution {
  return Object.freeze({
    outcome: input.outcome,
    expectedSourceDedupKey: input.expectedSourceDedupKey,
    candidate: input.candidate ?? null,
    reasons: Object.freeze([...input.reasons]),
    ambiguousCandidates: Object.freeze([...(input.ambiguousCandidates ?? [])]),
  });
}

export function canonicalExpectedSourceDedupKey(identity: ExpectedSourceResolutionTarget): string {
  return expectedSourceDedupKey({
    fiscalYear: assertFiscalYear(identity.fiscalYear),
    authorityTrack: identity.authorityTrack,
    sourceFamily: identity.sourceFamily,
    stage: identity.stage,
    chamber: identity.chamber,
    committee: identity.committee,
    component: identity.component,
  });
}

export function detectFiscalYearFromText(...parts: Array<string | null | undefined>): number | null {
  const blob = parts.filter(Boolean).join(' ');
  const fy =
    blob.match(/\bFY[\s_-]?(20\d{2})(?!\d)/i)?.[1] ?? blob.match(/\/(?:fy)?(20\d{2})\//i)?.[1];
  if (fy) return Number(fy);
  const bare = blob.match(/\b(20\d{2})\b/);
  return bare ? Number(bare[1]) : null;
}

export function detectSourceFamilyFromDocument(input: {
  url: string;
  title?: string | null;
}): SourceFamily | null {
  let path = '';
  try {
    path = new URL(input.url).pathname;
  } catch {
    path = input.url;
  }
  const file = path.split('/').pop() ?? path;
  for (const entry of FILENAME_FAMILY) {
    if (entry.pattern.test(file) || entry.pattern.test(path)) return entry.family;
  }
  const title = input.title ?? '';
  for (const entry of TITLE_FAMILY) {
    if (entry.pattern.test(title)) return entry.family;
  }
  return null;
}

export function detectComponentFromDocument(input: {
  url: string;
  title?: string | null;
}): BudgetComponent | null {
  const blob = `${input.url} ${input.title ?? ''}`;
  for (const entry of COMPONENT_HINTS) {
    if (entry.pattern.test(blob)) return entry.component;
  }
  return null;
}

function isOfficialHost(url: string, officialHosts: readonly string[]): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (new URL(url).protocol !== 'https:') return false;
    return officialHosts.some((allowed) => allowed.toLowerCase() === host);
  } catch {
    return false;
  }
}

function scoreCandidate(
  expected: ExpectedSourceResolutionTarget,
  candidate: OfficialDocumentCandidate,
): { ok: boolean; reasons: string[]; strength: number } {
  const reasons: string[] = [];
  let strength = 0;

  if (candidate.detectedFiscalYear == null) {
    reasons.push('document fiscal year could not be detected');
    return { ok: false, reasons, strength: 0 };
  }
  if (candidate.detectedFiscalYear !== expected.fiscalYear) {
    reasons.push(
      `document FY${candidate.detectedFiscalYear} does not match expected FY${expected.fiscalYear}`,
    );
    return { ok: false, reasons, strength: 0 };
  }
  strength += 2;

  if (candidate.detectedSourceFamily == null) {
    reasons.push('document source family could not be detected');
    return { ok: false, reasons, strength: 0 };
  }
  if (candidate.detectedSourceFamily !== expected.sourceFamily) {
    reasons.push(
      `document family ${candidate.detectedSourceFamily} does not match expected ${expected.sourceFamily}`,
    );
    return { ok: false, reasons, strength: 0 };
  }
  strength += 4;

  if (expected.component != null) {
    if (candidate.detectedComponent != null && candidate.detectedComponent !== expected.component) {
      reasons.push(
        `document component ${candidate.detectedComponent} does not match expected ${expected.component}`,
      );
      return { ok: false, reasons, strength: 0 };
    }
    if (candidate.detectedComponent === expected.component) strength += 2;
  }

  reasons.push(
    `matched FY${expected.fiscalYear} family=${expected.sourceFamily}` +
      (expected.component ? ` component=${expected.component}` : ''),
  );
  return { ok: true, reasons, strength };
}

function enrichCandidate(raw: {
  url: string;
  title?: string | null;
  retrievalMetadata?: OfficialDocumentCandidate['retrievalMetadata'];
}): OfficialDocumentCandidate {
  const title = raw.title ?? null;
  return Object.freeze({
    url: raw.url,
    title,
    detectedFiscalYear: detectFiscalYearFromText(raw.url, title),
    detectedSourceFamily: detectSourceFamilyFromDocument({ url: raw.url, title }),
    detectedComponent: detectComponentFromDocument({ url: raw.url, title }),
    ...(raw.retrievalMetadata ? { retrievalMetadata: Object.freeze({ ...raw.retrievalMetadata }) } : {}),
  });
}

/**
 * Build the deterministic comptroller DW candidate for one expected source, if
 * the catalog knows that (family, component) pair.
 */
export function catalogCandidateForExpectedSource(
  identity: ExpectedSourceResolutionTarget,
  officialHosts: readonly string[],
  options: { readonly preferredHost?: string } = {},
): OfficialDocumentCandidate | null {
  if (identity.authorityTrack !== 'request') return null;
  const entry = COMPTROLLER_DW_CATALOG.find(
    (row) =>
      row.sourceFamily === identity.sourceFamily &&
      row.component === (identity.component ?? 'DW'),
  );
  if (!entry) return null;

  const host =
    options.preferredHost && officialHosts.map((h) => h.toLowerCase()).includes(options.preferredHost.toLowerCase())
      ? options.preferredHost
      : officialHosts[0];
  if (!host) return null;

  const fy = String(assertFiscalYear(identity.fiscalYear));
  const path = entry.pathTemplate.replaceAll('{FY}', fy);
  const title = entry.titleTemplate.replaceAll('{FY}', fy);
  const url = `https://${host}${path}`;
  return enrichCandidate({
    url,
    title,
    retrievalMetadata: {
      resolutionMode: 'deterministic_catalog',
      catalogFamily: entry.sourceFamily,
      catalogComponent: entry.component,
    },
  });
}

/**
 * Resolve one expected source against optional listing documents and/or the
 * deterministic DW catalog. Pure / read-only w.r.t. lifecycle state.
 */
export function resolveExpectedSourceDocument(input: {
  readonly expectedSource: ExpectedSourceResolutionTarget;
  readonly officialHosts: readonly string[];
  /** Links already extracted from an official listing page (may be empty). */
  readonly listingDocuments?: readonly { readonly url: string; readonly title?: string | null }[];
  /** When true (default), also consult COMPTROLLER_DW_CATALOG. */
  readonly useDeterministicCatalog?: boolean;
  readonly preferredCatalogHost?: string;
}): ExpectedSourceResolution {
  const expected = input.expectedSource;
  const dedupKey = canonicalExpectedSourceDedupKey(expected);
  if (expected.dedupKey && expected.dedupKey !== dedupKey) {
    return freezeResolution({
      outcome: 'no_match',
      expectedSourceDedupKey: dedupKey,
      reasons: [
        `provided dedupKey does not match canonical identity hash for FY${expected.fiscalYear}/${expected.sourceFamily}`,
      ],
    });
  }

  if (expected.authorityTrack !== 'request') {
    return freezeResolution({
      outcome: 'refused_unsupported_family',
      expectedSourceDedupKey: dedupKey,
      reasons: [
        `authorityTrack ${expected.authorityTrack} is outside the PB/request expected-source resolver scope`,
      ],
    });
  }

  const pool: OfficialDocumentCandidate[] = [];

  if (input.useDeterministicCatalog !== false) {
    const catalog = catalogCandidateForExpectedSource(expected, input.officialHosts, {
      preferredHost: input.preferredCatalogHost,
    });
    if (catalog) pool.push(catalog);
  }

  for (const doc of input.listingDocuments ?? []) {
    if (!isOfficialHost(doc.url, input.officialHosts)) {
      // Skip off-host links quietly in the pool builder; a sole off-host input
      // is reported below if nothing else matched.
      continue;
    }
    pool.push(
      enrichCandidate({
        url: doc.url,
        title: doc.title ?? null,
        retrievalMetadata: { resolutionMode: 'listing_document' },
      }),
    );
  }

  if (pool.length === 0) {
    const onlyOffHost = (input.listingDocuments ?? []).some(
      (doc) => !isOfficialHost(doc.url, input.officialHosts),
    );
    return freezeResolution({
      outcome: onlyOffHost ? 'refused_non_official_host' : 'no_match',
      expectedSourceDedupKey: dedupKey,
      reasons: [
        onlyOffHost
          ? 'listing documents were not on the adapter official host allowlist'
          : `no official document candidate available for ${expected.sourceFamily}` +
            (expected.component ? `/${expected.component}` : ''),
      ],
    });
  }

  const scored = pool
    .map((candidate) => ({ candidate, ...scoreCandidate(expected, candidate) }))
    .filter((row) => row.ok)
    .sort((a, b) => b.strength - a.strength || a.candidate.url.localeCompare(b.candidate.url));

  if (scored.length === 0) {
    // Prefer the most specific refusal reason from the first pool entry.
    const sample = pool[0]!;
    if (sample.detectedFiscalYear != null && sample.detectedFiscalYear !== expected.fiscalYear) {
      return freezeResolution({
        outcome: 'refused_wrong_fiscal_year',
        expectedSourceDedupKey: dedupKey,
        reasons: [
          `candidates had fiscal year ${sample.detectedFiscalYear}, expected ${expected.fiscalYear}`,
        ],
      });
    }
    if (sample.detectedSourceFamily != null && sample.detectedSourceFamily !== expected.sourceFamily) {
      return freezeResolution({
        outcome: 'refused_wrong_family',
        expectedSourceDedupKey: dedupKey,
        reasons: [
          `candidates had family ${sample.detectedSourceFamily}, expected ${expected.sourceFamily}`,
        ],
      });
    }
    if (
      expected.component != null &&
      sample.detectedComponent != null &&
      sample.detectedComponent !== expected.component
    ) {
      return freezeResolution({
        outcome: 'refused_wrong_component',
        expectedSourceDedupKey: dedupKey,
        reasons: [
          `candidates had component ${sample.detectedComponent}, expected ${expected.component}`,
        ],
      });
    }
    return freezeResolution({
      outcome: 'no_match',
      expectedSourceDedupKey: dedupKey,
      reasons: [`no candidate satisfied FY/family/component identity for ${expected.sourceFamily}`],
    });
  }

  const best = scored[0]!;
  const tied = scored.filter((row) => row.strength === best.strength);
  // Deduplicate by URL before calling ambiguity — catalog + listing of same URL is fine.
  const uniqueUrls = new Map<string, OfficialDocumentCandidate>();
  for (const row of tied) uniqueUrls.set(row.candidate.url, row.candidate);
  if (uniqueUrls.size > 1) {
    return freezeResolution({
      outcome: 'ambiguous',
      expectedSourceDedupKey: dedupKey,
      reasons: [
        `ambiguous: ${uniqueUrls.size} equally-strong official documents matched ${expected.sourceFamily}`,
      ],
      ambiguousCandidates: [...uniqueUrls.values()],
    });
  }

  return freezeResolution({
    outcome: 'resolved',
    expectedSourceDedupKey: dedupKey,
    candidate: best.candidate,
    reasons: best.reasons,
  });
}

/**
 * Resolve every provided expected source independently. Used by adapter-level
 * discovery to emit at most one candidate per expected source without a broad
 * crawl dependency when the deterministic catalog is sufficient.
 */
export function resolveExpectedSourceDocuments(input: {
  readonly expectedSources: readonly ExpectedSourceResolutionTarget[];
  readonly officialHosts: readonly string[];
  readonly listingDocuments?: readonly { readonly url: string; readonly title?: string | null }[];
  readonly useDeterministicCatalog?: boolean;
  readonly preferredCatalogHost?: string;
  /** Optional adapter filter — skip expected sources bound to a different adapter. */
  readonly adapterId?: string;
}): readonly ExpectedSourceResolution[] {
  const out: ExpectedSourceResolution[] = [];
  for (const expectedSource of input.expectedSources) {
    if (input.adapterId && expectedSource.adapterId !== input.adapterId) continue;
    out.push(
      resolveExpectedSourceDocument({
        expectedSource,
        officialHosts: input.officialHosts,
        listingDocuments: input.listingDocuments,
        useDeterministicCatalog: input.useDeterministicCatalog,
        preferredCatalogHost: input.preferredCatalogHost,
      }),
    );
  }
  return Object.freeze(out);
}
