/**
 * procurement-line-canonical-v1 — PURE planning step for canonical procurement
 * line writes (procurement_line / procurement_line_year / procurement_line_source).
 *
 * Turns the SAME artifacts the composer consumed (`ProcurementExhibitArtifacts`)
 * plus the composer's `ProcurementFamilyReport` into an explicit, inspectable
 * write plan. The composer report alone cannot drive canonical writes: it
 * carries identities, P-1↔P-40 comparisons and the verification decision, but
 * not the per-value page / excerpt / span-hash provenance a citation needs —
 * that lives on the artifact assertions and their evidence.
 *
 * HARD RULES (mirroring the Program Element canonical path):
 *   - Only assertions whose derived verification decision is PASS are planned
 *     for writing. REVIEW / REJECT assertions are counted and listed in
 *     `skipped` with a reason. Nothing here is a canonical approval by itself:
 *     the plan is inert until ProcurementLineWriterService applies it, and the
 *     writer is gated by DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES=1.
 *   - A procurement BLIN is NEVER reclassified as a PE. Only PROCUREMENT_BLIN
 *     identities are planned; RDTE_PE identities appearing in a P-doc artifact
 *     are skipped, and P-40 "related PE" cross-references are recorded as a
 *     reference string only (no program_element row is ever created or read).
 *   - Every planned year value carries at least one source citation with a
 *     page number; a value without page provenance is not planned.
 *   - Money stays an exact canonical decimal STRING ($ millions) end to end.
 *
 * Pure module: no database, no Nest, no parser, no writer.
 */
import { createHash } from 'node:crypto';
import type {
  DefenseBudgetAssertionV1,
  DefenseBudgetExtractionArtifactV1,
  FundingFieldV1,
  SourceEvidenceV1,
} from '../contracts/extraction-artifact-v1.js';
import type { VerificationDecisionV1 } from '../verification/verification-contract-v1.js';
import type {
  ProcurementExhibitArtifacts,
  ProcurementFamilyReport,
} from './procurement-composer-v1.js';
import type {
  ProcurementVerificationDecision,
  ProcurementVerificationFinding,
} from './procurement-verification-policy-v1.js';

/* ------------------------------------------------------------------ */
/* Gating                                                               */
/* ------------------------------------------------------------------ */

export const PROCUREMENT_LINE_CANONICAL_WRITES_ENV =
  'DEFENSE_BUDGET_PROCUREMENT_CANONICAL_WRITES' as const;

export const PROCUREMENT_LINE_WRITER_VERSION = 'procurement_line_writer_v1' as const;

/** True only when the operator has explicitly enabled canonical procurement writes. */
export function procurementCanonicalWritesEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return env[PROCUREMENT_LINE_CANONICAL_WRITES_ENV] === '1';
}

/* ------------------------------------------------------------------ */
/* Vocabulary                                                           */
/* ------------------------------------------------------------------ */

/** Money columns on procurement_line_year ($ millions). */
export const PROCUREMENT_LINE_YEAR_MONEY_FIELDS = [
  'request',
  'hascMark',
  'sascMark',
  'hacDMark',
  'sacDMark',
  'conference',
  'enacted',
  'actuals',
] as const;
export type ProcurementLineYearMoneyField = (typeof PROCUREMENT_LINE_YEAR_MONEY_FIELDS)[number];

/**
 * Extraction funding field -> canonical year column. `executed` is the
 * procurement analogue of "actuals" (prior-year execution column on the P-1).
 * `ndaaConference` and `reprogrammed` have no column on procurement_line_year
 * and are skipped as unsupported rather than silently folded into another field.
 */
export const FUNDING_FIELD_TO_YEAR_FIELD: Readonly<
  Partial<Record<FundingFieldV1, ProcurementLineYearMoneyField>>
> = {
  request: 'request',
  hascMark: 'hascMark',
  sascMark: 'sascMark',
  hacDMark: 'hacDMark',
  sacDMark: 'sacDMark',
  conference: 'conference',
  enacted: 'enacted',
  executed: 'actuals',
};

/** Proof-pack exhibit order for procurement citations (then FY desc, page asc). */
export const PROCUREMENT_PROOF_PACK_EXHIBIT_ORDER = [
  'P-1',
  'P-40',
  'P-40A',
  'P-5',
  'P-5A',
  'P-21',
  'P-3A',
] as const;

const PUBLISHER_BY_AUTHORITY: Readonly<Record<string, string>> = {
  'dod-comptroller': 'DoD Comptroller',
  hasc: 'HASC',
  sasc: 'SASC',
  hac_d: 'HAC-D',
  sac_d: 'SAC-D',
  ndaa_conference: 'NDAA Conference',
  appropriations_conference: 'Appropriations Conference',
  public_law: 'Public Law',
  reprogramming: 'DoD Comptroller',
  execution: 'DoD Comptroller',
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/* ------------------------------------------------------------------ */
/* Request / plan types                                                 */
/* ------------------------------------------------------------------ */

export interface ProcurementLineTrustedGate {
  /** Decision from the trusted V1 verification gate (PASS | REVIEW | REJECT). */
  decision: VerificationDecisionV1;
  /**
   * When present, only assertions whose id is in this list are eligible even
   * under a PASS decision (the V1 result's `acceptedAssertionIds`).
   */
  acceptedAssertionIds?: readonly string[];
}

export interface ProcurementLineCanonicalRequest {
  /** The exact artifacts the composer consumed. */
  artifacts: ProcurementExhibitArtifacts;
  /** The composer's output for those artifacts. */
  report: ProcurementFamilyReport;
  /**
   * Optional trusted gate. When supplied it REPLACES the composer-derived family
   * decision (the composer decision is family-policy only; the V1 gate is the
   * trust boundary). Absent, the composer decision is mapped
   * VERIFICATION_PASSED->PASS, NEEDS_REVIEW->REVIEW, REJECTED->REJECT.
   */
  gate?: ProcurementLineTrustedGate;
  /**
   * `family` (default, strict): nothing is planned unless the FAMILY decision is
   * PASS — one REVIEW finding anywhere holds back every line, exactly like the
   * PE promotion path before scoped review.
   * `identity`: under a family REVIEW, identities with no finding of their own
   * are still PASS; identities named by a blocking finding are REJECT, by a
   * review finding REVIEW. Findings with no identity apply to every identity.
   * A family REJECT plans nothing in either scope.
   */
  scope?: 'family' | 'identity';
}

export interface ProcurementLinePlanLine {
  /** Plan-local key: `${appropriationCode}::${lineItemNumber}`. */
  key: string;
  identityNaturalKey: string;
  appropriationCode: string;
  appropriationTitle: string | null;
  component: string | null;
  budgetActivity: string | null;
  budgetSubActivity: string | null;
  p1LineNumber: number | null;
  lineItemNumber: string;
  printedLineItemNumber: string;
  title: string;
  relatedPeCode: string | null;
  raw: Record<string, unknown>;
}

export interface ProcurementLinePlanYear {
  /** Plan-local key: `${lineKey}::${fy}::${sublineKey}`. */
  key: string;
  lineKey: string;
  fy: number;
  sublineKey: string;
  sublineTitle: string | null;
  p1LineNumber: number | null;
  /** Exact canonical decimal strings in $ millions, only for fields asserted. */
  values: Partial<Record<ProcurementLineYearMoneyField, string>>;
  quantity: number | null;
}

export interface ProcurementLinePlanSource {
  lineKey: string;
  yearKey: string | null;
  docType: 'P';
  exhibitType: string;
  fy: number | null;
  sourceUrl: string;
  pageNumber: number;
  pageEnd: number | null;
  snippet: string | null;
  publisher: string | null;
  confidence: number;
  extractorVersion: string | null;
  sourceSpanHash: string;
  sourceDocumentId: string | null;
  metadata: Record<string, unknown>;
}

export type ProcurementLineSkipDecision = 'REVIEW' | 'REJECT' | 'UNSUPPORTED';

export interface ProcurementLineSkip {
  scope: 'family' | 'identity' | 'assertion';
  decision: ProcurementLineSkipDecision;
  reason: string;
  identityNaturalKey?: string;
  assertionId?: string;
  fy?: number;
  field?: string;
}

export interface ProcurementLineCanonicalPlan {
  writerVersion: typeof PROCUREMENT_LINE_WRITER_VERSION;
  decision: VerificationDecisionV1;
  decisionSource: 'composer' | 'gate';
  scope: 'family' | 'identity';
  lines: ProcurementLinePlanLine[];
  years: ProcurementLinePlanYear[];
  sources: ProcurementLinePlanSource[];
  skipped: ProcurementLineSkip[];
  counts: {
    assertionsSeen: number;
    valueAssertionsSeen: number;
    pass: number;
    review: number;
    reject: number;
    unsupported: number;
    lines: number;
    years: number;
    yearValues: number;
    sources: number;
  };
}

/* ------------------------------------------------------------------ */
/* Decision derivation                                                  */
/* ------------------------------------------------------------------ */

export function mapComposerDecisionV1(
  decision: ProcurementVerificationDecision,
): VerificationDecisionV1 {
  switch (decision) {
    case 'VERIFICATION_PASSED':
      return 'PASS';
    case 'NEEDS_REVIEW':
      return 'REVIEW';
    case 'REJECTED':
      return 'REJECT';
  }
}

interface IdentityDecision {
  decision: VerificationDecisionV1;
  reason: string;
}

function deriveIdentityDecisions(
  findings: readonly ProcurementVerificationFinding[],
): { byIdentity: Map<string, IdentityDecision>; global: IdentityDecision | null } {
  const byIdentity = new Map<string, IdentityDecision>();
  let global: IdentityDecision | null = null;
  const rank = (d: VerificationDecisionV1) => (d === 'REJECT' ? 2 : d === 'REVIEW' ? 1 : 0);
  for (const finding of findings) {
    if (finding.severity === 'info') continue;
    const decision: VerificationDecisionV1 = finding.severity === 'blocking' ? 'REJECT' : 'REVIEW';
    const next = { decision, reason: `${finding.code}: ${finding.message}` };
    if (finding.identityNaturalKey == null) {
      if (global == null || rank(decision) > rank(global.decision)) global = next;
      continue;
    }
    const prior = byIdentity.get(finding.identityNaturalKey);
    if (prior == null || rank(decision) > rank(prior.decision)) {
      byIdentity.set(finding.identityNaturalKey, next);
    }
  }
  return { byIdentity, global };
}

/* ------------------------------------------------------------------ */
/* Identity helpers                                                     */
/* ------------------------------------------------------------------ */

interface BlinIdentityLike {
  lineKind: 'PROCUREMENT_BLIN';
  code: string;
  account: string;
  component: string;
  advanceProcurement?: boolean;
}

/**
 * MUST match the pre-existing composer's key format byte-for-byte
 * (`procurement-composer-v1.ts`'s `naturalKey` / `id.naturalKey` derivation:
 * `PROCUREMENT_BLIN:${component}:${account}:${code}:${base|advance}`, no
 * trim, no case-folding). `ProcurementVerificationFinding.identityNaturalKey`
 * — the join key `identityDecision()` uses to attribute a REJECT/REVIEW
 * finding to a value assertion — is written by that composer code, not this
 * file. An account string is typically "0300D: Procurement, Defense-Wide";
 * uppercasing it here (an earlier version of this function did) changes the
 * title-case portion and the lookup silently misses every finding, so a
 * blocking finding never gates anything and every identity looks clean. Do
 * not add normalization here without changing the composer to match.
 */
export function procurementNaturalKey(identity: BlinIdentityLike): string {
  return `PROCUREMENT_BLIN:${identity.component}:${identity.account}:${identity.code}:${identity.advanceProcurement ? 'advance' : 'base'}`;
}

/**
 * Split a printed appropriation account ("0300D: Procurement, Defense-Wide")
 * into its code ("0300D") and title ("Procurement, Defense-Wide"). An account
 * with no ':' is treated as a bare code.
 */
export function splitAppropriationAccount(account: string): {
  code: string;
  title: string | null;
} {
  const trimmed = account.trim();
  const idx = trimmed.indexOf(':');
  if (idx < 0) return { code: trimmed.toUpperCase().replace(/\s+/g, ''), title: null };
  const code = trimmed.slice(0, idx).trim().toUpperCase().replace(/\s+/g, '');
  const title = trimmed.slice(idx + 1).trim();
  return { code, title: title.length > 0 ? title : null };
}

function lineKeyFor(identity: BlinIdentityLike): string {
  const { code } = splitAppropriationAccount(identity.account);
  return `${code}::${identity.code.trim().toUpperCase()}`;
}

function metaString(meta: Record<string, unknown> | undefined, ...keys: string[]): string | null {
  if (!meta) return null;
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === 'string' && v.trim().length > 0) return v.trim();
    if (Array.isArray(v) && typeof v[0] === 'string' && v[0].trim().length > 0) return v[0].trim();
  }
  return null;
}

function metaInt(meta: Record<string, unknown> | undefined, ...keys: string[]): number | null {
  if (!meta) return null;
  for (const key of keys) {
    const v = meta[key];
    if (typeof v === 'number' && Number.isInteger(v)) return v;
    if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  }
  return null;
}

function parseIntegerQuantity(value: string): number | null {
  const trimmed = value.trim();
  if (!/^-?\d+(\.0+)?$/.test(trimmed)) return null;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : null;
}

/* ------------------------------------------------------------------ */
/* Provenance helpers                                                   */
/* ------------------------------------------------------------------ */

interface ArtifactContext {
  artifact: DefenseBudgetExtractionArtifactV1;
  exhibitBucket: string;
  evidenceById: Map<string, SourceEvidenceV1>;
  parserVersionByRunId: Map<string, string>;
}

function contextFor(
  artifact: DefenseBudgetExtractionArtifactV1,
  exhibitBucket: string,
): ArtifactContext {
  return {
    artifact,
    exhibitBucket,
    evidenceById: new Map(artifact.evidence.map((e) => [e.evidenceId, e])),
    parserVersionByRunId: new Map(
      artifact.parserRuns.map((run) => [run.parserRunId, `${run.method}:${run.parserVersion}`]),
    ),
  };
}

interface ResolvedProvenance {
  pageNumber: number;
  pageEnd: number | null;
  snippet: string | null;
  sourceSpanHash: string;
  extractorVersion: string | null;
  evidenceId: string | null;
}

function sha256Hex(material: string): string {
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

/**
 * Resolve the page/excerpt/span-hash for one assertion. Evidence rows win;
 * `metadata.page` is the fallback. Returns null when no page can be found —
 * the caller then SKIPS the value (no citation, no write).
 */
function resolveProvenance(
  ctx: ArtifactContext,
  assertion: DefenseBudgetAssertionV1,
  hashMaterial: readonly string[],
): ResolvedProvenance | null {
  const evidence = assertion.evidenceIds
    .map((id) => ctx.evidenceById.get(id))
    .filter((e): e is SourceEvidenceV1 => e != null && typeof e.page === 'number');
  const first = evidence[0];
  const metaPage = metaInt(assertion.metadata, 'page', 'pdfPage');
  const pageNumber = first?.page ?? metaPage;
  if (pageNumber == null || pageNumber <= 0) return null;

  const pages = evidence.map((e) => e.page as number);
  const pageEnd = pages.length > 1 ? Math.max(...pages) : null;
  const snippetParts = [first?.excerpt, metaString(assertion.metadata, 'excerpt', 'snippet')];
  let snippet = snippetParts.find((s) => typeof s === 'string' && s.trim().length > 0) ?? null;
  if (snippet == null) {
    const row = first?.rowLabel ?? metaString(assertion.metadata, 'rowLabel');
    const col =
      first?.columnLabel ?? metaString(assertion.metadata, 'columnLabel', 'headerText');
    if (row || col) snippet = [row, col].filter(Boolean).join(' | ');
  }
  const extractorVersion =
    (first ? ctx.parserVersionByRunId.get(first.parserRunId) : undefined) ??
    [...ctx.parserVersionByRunId.values()][0] ??
    null;
  const sourceSpanHash =
    first?.sourceSpanSha256 ??
    sha256Hex(
      [
        PROCUREMENT_LINE_WRITER_VERSION,
        ctx.artifact.source.sourcePdfSha256,
        ctx.exhibitBucket,
        String(pageNumber),
        ...hashMaterial,
      ].join('|'),
    );
  return {
    pageNumber,
    pageEnd: pageEnd != null && pageEnd > pageNumber ? pageEnd : null,
    snippet: snippet ? snippet.slice(0, 2000) : null,
    sourceSpanHash,
    extractorVersion,
    evidenceId: first?.evidenceId ?? null,
  };
}

function sourceRow(
  ctx: ArtifactContext,
  assertion: DefenseBudgetAssertionV1,
  prov: ResolvedProvenance,
  lineKey: string,
  yearKey: string | null,
  fy: number | null,
  metadata: Record<string, unknown>,
): ProcurementLinePlanSource {
  const src = ctx.artifact.source;
  const sourceDocumentId =
    src.sourceDocumentId && UUID_RE.test(src.sourceDocumentId) ? src.sourceDocumentId : null;
  return {
    lineKey,
    yearKey,
    docType: 'P',
    exhibitType: (metaString(assertion.metadata, 'subExhibit', 'exhibit') ?? ctx.exhibitBucket)
      .toUpperCase()
      .slice(0, 16),
    fy,
    sourceUrl: src.sourceUrl ?? src.sourceLocator,
    pageNumber: prov.pageNumber,
    pageEnd: prov.pageEnd,
    snippet: prov.snippet,
    publisher: PUBLISHER_BY_AUTHORITY[src.authority] ?? null,
    confidence: assertion.confidence,
    extractorVersion: prov.extractorVersion,
    sourceSpanHash: prov.sourceSpanHash,
    sourceDocumentId,
    metadata: {
      writerVersion: PROCUREMENT_LINE_WRITER_VERSION,
      artifactId: ctx.artifact.artifactId,
      artifactContentSha256: ctx.artifact.contentSha256,
      sourcePdfSha256: src.sourcePdfSha256,
      manifestDocumentKey: src.manifestDocumentKey,
      budgetCycle: src.budgetCycle,
      assertionId: assertion.assertionId,
      assertionKind: assertion.assertionKind,
      ...(prov.evidenceId ? { evidenceId: prov.evidenceId } : {}),
      ...(src.sourceDocumentId && !sourceDocumentId
        ? { unlinkedSourceDocumentId: src.sourceDocumentId }
        : {}),
      ...metadata,
    },
  };
}

/* ------------------------------------------------------------------ */
/* Planner                                                              */
/* ------------------------------------------------------------------ */

interface PendingValue {
  yearKey: string;
  field: ProcurementLineYearMoneyField;
  value: string;
  source: ProcurementLinePlanSource;
  assertionId: string;
  identityNaturalKey: string;
  fy: number;
}

interface PendingQuantity {
  yearKey: string;
  quantity: number;
  source: ProcurementLinePlanSource;
  assertionId: string;
  identityNaturalKey: string;
  fy: number;
}

export function planProcurementLineCanonicalWrites(
  request: ProcurementLineCanonicalRequest,
): ProcurementLineCanonicalPlan {
  const scope = request.scope ?? 'family';
  const decisionSource: 'composer' | 'gate' = request.gate ? 'gate' : 'composer';
  const familyDecision: VerificationDecisionV1 =
    request.gate?.decision ?? mapComposerDecisionV1(request.report.verification.decision);
  const accepted =
    request.gate?.acceptedAssertionIds != null ? new Set(request.gate.acceptedAssertionIds) : null;
  const { byIdentity, global } = deriveIdentityDecisions(request.report.verification.findings);

  const skipped: ProcurementLineSkip[] = [];
  const counts = {
    assertionsSeen: 0,
    valueAssertionsSeen: 0,
    pass: 0,
    review: 0,
    reject: 0,
    unsupported: 0,
    lines: 0,
    years: 0,
    yearValues: 0,
    sources: 0,
  };

  const buckets: Array<[string, readonly DefenseBudgetExtractionArtifactV1[]]> = [
    ['P-1', request.artifacts.p1Artifacts],
    ['P-40', request.artifacts.p40Artifacts],
    ['P-5', request.artifacts.p5Artifacts],
    ['P-21', request.artifacts.p21Artifacts],
    ['P-3A', request.artifacts.p3aArtifacts],
  ];
  const contexts = buckets.flatMap(([bucket, list]) =>
    list.map((artifact) => contextFor(artifact, bucket)),
  );
  for (const ctx of contexts) counts.assertionsSeen += ctx.artifact.assertions.length;

  const empty = (): ProcurementLineCanonicalPlan => ({
    writerVersion: PROCUREMENT_LINE_WRITER_VERSION,
    decision: familyDecision,
    decisionSource,
    scope,
    lines: [],
    years: [],
    sources: [],
    skipped,
    counts,
  });

  /* Family-level gate. */
  if (familyDecision === 'REJECT') {
    skipped.push({
      scope: 'family',
      decision: 'REJECT',
      reason: `family verification decision is REJECT (${decisionSource}); nothing is written`,
    });
    counts.reject = countValueAssertions(contexts);
    counts.valueAssertionsSeen = counts.reject;
    return empty();
  }
  if (familyDecision === 'REVIEW' && scope === 'family') {
    skipped.push({
      scope: 'family',
      decision: 'REVIEW',
      reason: `family verification decision is REVIEW (${decisionSource}) and scope=family; nothing is written until the family passes or scope=identity is requested`,
    });
    counts.review = countValueAssertions(contexts);
    counts.valueAssertionsSeen = counts.review;
    return empty();
  }

  const identityDecision = (naturalKey: string): IdentityDecision => {
    const own = byIdentity.get(naturalKey);
    if (own) return own;
    if (global) return global;
    if (familyDecision === 'REVIEW') {
      // Family REVIEW with identity scope but no finding names this identity or
      // applies globally — the report's REVIEW came from an identity-attributed
      // finding elsewhere, so THIS identity is clean.
      return { decision: 'PASS', reason: 'no finding names this identity' };
    }
    return { decision: 'PASS', reason: 'no findings' };
  };

  /* 1. Catalog: procurement_line assertions from P-1 (preferred) then P-40. */
  const lines = new Map<string, ProcurementLinePlanLine>();
  const catalogAssertions: Array<{ ctx: ArtifactContext; a: DefenseBudgetAssertionV1 }> = [];
  for (const ctx of contexts) {
    for (const a of ctx.artifact.assertions) {
      if (a.assertionKind === 'procurement_line') catalogAssertions.push({ ctx, a });
    }
  }
  const exhibitPreference = (bucket: string) => (bucket === 'P-1' ? 0 : bucket === 'P-40' ? 1 : 2);
  catalogAssertions.sort(
    (x, y) => exhibitPreference(x.ctx.exhibitBucket) - exhibitPreference(y.ctx.exhibitBucket),
  );
  for (const { ctx, a } of catalogAssertions) {
    if (a.assertionKind !== 'procurement_line') continue;
    const id = a.parentIdentity;
    if (id.advanceProcurement) continue; // handled (skipped) with its values below
    const key = lineKeyFor(id);
    const { code, title: accountTitle } = splitAppropriationAccount(id.account);
    const existing = lines.get(key);
    const meta = a.metadata;
    const description = a.description.trim();
    if (!existing) {
      lines.set(key, {
        key,
        identityNaturalKey: procurementNaturalKey(id),
        appropriationCode: code,
        appropriationTitle: metaString(meta, 'appropriationTitle') ?? accountTitle,
        component: id.component,
        budgetActivity: metaString(meta, 'budgetActivity'),
        budgetSubActivity: metaString(meta, 'budgetSubActivity', 'bsa'),
        p1LineNumber: metaInt(meta, 'p1LineNumber', 'lineNumber'),
        lineItemNumber: id.code.trim().toUpperCase(),
        printedLineItemNumber: id.code,
        title: description.length > 0 ? description : id.code.trim().toUpperCase(),
        relatedPeCode: metaString(meta, 'relatedPeCode', 'otherRelatedPeCodes', 'referencedPeCodes'),
        raw: {
          account: id.account,
          catalogExhibit: ctx.exhibitBucket,
          catalogAssertionId: a.assertionId,
          titleSource: description.length > 0 ? 'description' : 'line_item_number_fallback',
        },
      });
      continue;
    }
    // Fill gaps only — P-1 wins for title, later exhibits enrich empty fields.
    existing.appropriationTitle ??= metaString(meta, 'appropriationTitle') ?? accountTitle;
    existing.budgetActivity ??= metaString(meta, 'budgetActivity');
    existing.budgetSubActivity ??= metaString(meta, 'budgetSubActivity', 'bsa');
    existing.p1LineNumber ??= metaInt(meta, 'p1LineNumber', 'lineNumber');
    existing.relatedPeCode ??= metaString(
      meta,
      'relatedPeCode',
      'otherRelatedPeCodes',
      'referencedPeCodes',
    );
    if (existing.raw.titleSource === 'line_item_number_fallback' && description.length > 0) {
      existing.title = description;
      existing.raw.titleSource = `description:${ctx.exhibitBucket}`;
    }
  }

  /* 1b. Related PE from explicit relationship assertions (reference only). */
  for (const ctx of contexts) {
    for (const a of ctx.artifact.assertions) {
      if (a.assertionKind !== 'relationship') continue;
      if (a.from.lineKind !== 'PROCUREMENT_BLIN' || a.to.lineKind !== 'RDTE_PE') continue;
      if (a.relationshipType !== 'references' && a.relationshipType !== 'supports') continue;
      const line = lines.get(lineKeyFor(a.from));
      if (line && line.relatedPeCode == null) line.relatedPeCode = a.to.peCode;
    }
  }

  /* 2. Values: funding + quantity assertions. */
  const pendingValues: PendingValue[] = [];
  const pendingQuantities: PendingQuantity[] = [];
  const yearMeta = new Map<
    string,
    {
      lineKey: string;
      fy: number;
      sublineKey: string;
      sublineTitle: string | null;
      p1LineNumber: number | null;
    }
  >();

  const skipAssertion = (
    decision: ProcurementLineSkipDecision,
    reason: string,
    a: DefenseBudgetAssertionV1,
    extra: Partial<ProcurementLineSkip> = {},
  ) => {
    skipped.push({ scope: 'assertion', decision, reason, assertionId: a.assertionId, ...extra });
    if (decision === 'REVIEW') counts.review += 1;
    else if (decision === 'REJECT') counts.reject += 1;
    else counts.unsupported += 1;
  };

  for (const ctx of contexts) {
    for (const a of ctx.artifact.assertions) {
      if (a.assertionKind !== 'funding' && a.assertionKind !== 'quantity') continue;
      counts.valueAssertionsSeen += 1;
      const identity = a.identity;

      if (identity.lineKind !== 'PROCUREMENT_BLIN') {
        skipAssertion(
          'UNSUPPORTED',
          `identity lineKind ${identity.lineKind} is not PROCUREMENT_BLIN; procurement writer never writes PE or other line kinds`,
          a,
          { fy: a.fiscalYear },
        );
        continue;
      }
      const naturalKey = procurementNaturalKey(identity);
      if (identity.advanceProcurement) {
        skipAssertion(
          'UNSUPPORTED',
          'advance-procurement identities are not represented on procurement_line_year in v1 (base/AP separation preserved by skipping, never by merging)',
          a,
          { identityNaturalKey: naturalKey, fy: a.fiscalYear },
        );
        continue;
      }
      if (accepted && !accepted.has(a.assertionId)) {
        skipAssertion('REVIEW', 'assertion is not in the trusted gate acceptedAssertionIds', a, {
          identityNaturalKey: naturalKey,
          fy: a.fiscalYear,
        });
        continue;
      }
      const idDecision = identityDecision(naturalKey);
      if (idDecision.decision !== 'PASS') {
        skipAssertion(idDecision.decision, idDecision.reason, a, {
          identityNaturalKey: naturalKey,
          fy: a.fiscalYear,
          ...(a.assertionKind === 'funding' ? { field: a.field } : { field: 'quantity' }),
        });
        continue;
      }
      const lineKey = lineKeyFor(identity);
      const line = lines.get(lineKey);
      if (!line) {
        skipAssertion(
          'REVIEW',
          'no procurement_line catalog assertion (title) exists for this identity in the P-1/P-40 artifacts',
          a,
          { identityNaturalKey: naturalKey, fy: a.fiscalYear },
        );
        continue;
      }
      const sublineKey = (metaString(a.metadata, 'sublineKey', 'category') ?? '')
        .toUpperCase()
        .slice(0, 32);
      const sublineTitle = metaString(a.metadata, 'sublineTitle', 'categoryTitle');
      const yearKey = `${lineKey}::${a.fiscalYear}::${sublineKey}`;

      if (a.assertionKind === 'funding') {
        const field = FUNDING_FIELD_TO_YEAR_FIELD[a.field];
        if (!field) {
          skipAssertion(
            'UNSUPPORTED',
            `funding field ${a.field} has no column on procurement_line_year`,
            a,
            { identityNaturalKey: naturalKey, fy: a.fiscalYear, field: a.field },
          );
          continue;
        }
        const prov = resolveProvenance(ctx, a, [
          String(a.fiscalYear),
          field,
          sublineKey,
          a.money.valueMillions,
        ]);
        if (!prov) {
          skipAssertion(
            'REVIEW',
            'no page provenance (evidence.page or metadata.page); a value without a citation is not written',
            a,
            { identityNaturalKey: naturalKey, fy: a.fiscalYear, field: a.field },
          );
          continue;
        }
        pendingValues.push({
          yearKey,
          field,
          value: a.money.valueMillions,
          assertionId: a.assertionId,
          identityNaturalKey: naturalKey,
          fy: a.fiscalYear,
          source: sourceRow(ctx, a, prov, lineKey, yearKey, a.fiscalYear, {
            field,
            fundingField: a.field,
            valueMillions: a.money.valueMillions,
            originalValue: a.money.originalValue,
            originalUnit: a.money.originalUnit,
            ...(sublineKey ? { sublineKey } : {}),
            ...(sublineTitle ? { sublineTitle } : {}),
          }),
        });
        // Remember subline title / p1 line for the year row.
        yearMeta.set(yearKey, {
          lineKey,
          fy: a.fiscalYear,
          sublineKey,
          sublineTitle: yearMeta.get(yearKey)?.sublineTitle ?? sublineTitle,
          p1LineNumber:
            yearMeta.get(yearKey)?.p1LineNumber ??
            metaInt(a.metadata, 'p1LineNumber', 'lineNumber') ??
            line.p1LineNumber,
        });
        continue;
      }

      // quantity
      const quantity = parseIntegerQuantity(a.quantity);
      if (quantity == null) {
        skipAssertion(
          'UNSUPPORTED',
          `quantity "${a.quantity}" is not an integer; procurement_line_year.quantity is INTEGER`,
          a,
          { identityNaturalKey: naturalKey, fy: a.fiscalYear, field: 'quantity' },
        );
        continue;
      }
      const prov = resolveProvenance(ctx, a, [
        String(a.fiscalYear),
        'quantity',
        sublineKey,
        String(quantity),
      ]);
      if (!prov) {
        skipAssertion(
          'REVIEW',
          'no page provenance (evidence.page or metadata.page); a value without a citation is not written',
          a,
          { identityNaturalKey: naturalKey, fy: a.fiscalYear, field: 'quantity' },
        );
        continue;
      }
      pendingQuantities.push({
        yearKey,
        quantity,
        assertionId: a.assertionId,
        identityNaturalKey: naturalKey,
        fy: a.fiscalYear,
        source: sourceRow(ctx, a, prov, lineKey, yearKey, a.fiscalYear, {
          field: 'quantity',
          quantity,
          ...(a.unitLabel ? { unitLabel: a.unitLabel } : {}),
          ...(sublineKey ? { sublineKey } : {}),
          ...(sublineTitle ? { sublineTitle } : {}),
        }),
      });
      yearMeta.set(yearKey, {
        lineKey,
        fy: a.fiscalYear,
        sublineKey,
        sublineTitle: yearMeta.get(yearKey)?.sublineTitle ?? sublineTitle,
        p1LineNumber:
          yearMeta.get(yearKey)?.p1LineNumber ??
          metaInt(a.metadata, 'p1LineNumber', 'lineNumber') ??
          line.p1LineNumber,
      });
    }
  }

  /* 3. Resolve same-field conflicts: identical values merge (both cited);
   *    differing PASS values for one (year, field) are REVIEW, not written. */
  const years = new Map<string, ProcurementLinePlanYear>();
  const sources: ProcurementLinePlanSource[] = [];
  const seenSpanHash = new Set<string>();
  const pushSource = (s: ProcurementLinePlanSource) => {
    const dedupe = `${s.lineKey}|${s.sourceSpanHash}`;
    if (seenSpanHash.has(dedupe)) return;
    seenSpanHash.add(dedupe);
    sources.push(s);
  };
  const ensureYear = (yearKey: string): ProcurementLinePlanYear => {
    const existing = years.get(yearKey);
    if (existing) return existing;
    const meta = yearMeta.get(yearKey)!;
    const row: ProcurementLinePlanYear = {
      key: yearKey,
      lineKey: meta.lineKey,
      fy: meta.fy,
      sublineKey: meta.sublineKey,
      sublineTitle: meta.sublineTitle,
      p1LineNumber: meta.p1LineNumber,
      values: {},
      quantity: null,
    };
    years.set(yearKey, row);
    return row;
  };

  const byYearField = new Map<string, PendingValue[]>();
  for (const v of pendingValues) {
    const k = `${v.yearKey}::${v.field}`;
    const list = byYearField.get(k) ?? [];
    list.push(v);
    byYearField.set(k, list);
  }
  for (const list of byYearField.values()) {
    const distinct = new Set(list.map((v) => v.value));
    if (distinct.size > 1) {
      for (const v of list) {
        skipped.push({
          scope: 'assertion',
          decision: 'REVIEW',
          reason: `conflicting PASS values for the same year/field: ${[...distinct].join(' vs ')}`,
          assertionId: v.assertionId,
          identityNaturalKey: v.identityNaturalKey,
          fy: v.fy,
          field: v.field,
        });
        counts.review += 1;
      }
      continue;
    }
    const first = list[0]!;
    const year = ensureYear(first.yearKey);
    year.values[first.field] = first.value;
    counts.yearValues += 1;
    counts.pass += list.length;
    for (const v of list) pushSource(v.source);
  }

  const byYearQuantity = new Map<string, PendingQuantity[]>();
  for (const q of pendingQuantities) {
    const list = byYearQuantity.get(q.yearKey) ?? [];
    list.push(q);
    byYearQuantity.set(q.yearKey, list);
  }
  for (const list of byYearQuantity.values()) {
    const distinct = new Set(list.map((q) => q.quantity));
    if (distinct.size > 1) {
      for (const q of list) {
        skipped.push({
          scope: 'assertion',
          decision: 'REVIEW',
          reason: `conflicting PASS quantities for the same year: ${[...distinct].join(' vs ')}`,
          assertionId: q.assertionId,
          identityNaturalKey: q.identityNaturalKey,
          fy: q.fy,
          field: 'quantity',
        });
        counts.review += 1;
      }
      continue;
    }
    const first = list[0]!;
    const year = ensureYear(first.yearKey);
    year.quantity = first.quantity;
    counts.yearValues += 1;
    counts.pass += list.length;
    for (const q of list) pushSource(q.source);
  }

  /* 4. Only lines that received at least one year are written; a catalog row
   *    with no verified value has nothing to cite and is left out. */
  const linesWithYears = new Set([...years.values()].map((y) => y.lineKey));
  const plannedLines = [...lines.values()]
    .filter((l) => linesWithYears.has(l.key))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const line of lines.values()) {
    if (linesWithYears.has(line.key)) continue;
    skipped.push({
      scope: 'identity',
      decision: 'REVIEW',
      reason: 'catalog line has no PASS year value with page provenance; nothing to cite, line not written',
      identityNaturalKey: line.identityNaturalKey,
    });
  }
  // Latest-cycle P-1 line number on the line row: highest FY row that has one.
  for (const line of plannedLines) {
    const latest = [...years.values()]
      .filter((y) => y.lineKey === line.key && y.p1LineNumber != null)
      .sort((a, b) => b.fy - a.fy)[0];
    if (latest?.p1LineNumber != null) line.p1LineNumber = latest.p1LineNumber;
  }

  const plannedYears = [...years.values()].sort((a, b) => a.key.localeCompare(b.key));
  const plannedSources = [...sources].sort((a, b) =>
    `${a.lineKey}|${a.sourceSpanHash}`.localeCompare(`${b.lineKey}|${b.sourceSpanHash}`),
  );
  counts.lines = plannedLines.length;
  counts.years = plannedYears.length;
  counts.sources = plannedSources.length;

  return {
    writerVersion: PROCUREMENT_LINE_WRITER_VERSION,
    decision: familyDecision,
    decisionSource,
    scope,
    lines: plannedLines,
    years: plannedYears,
    sources: plannedSources,
    skipped,
    counts,
  };
}

function countValueAssertions(contexts: readonly ArtifactContext[]): number {
  let n = 0;
  for (const ctx of contexts) {
    for (const a of ctx.artifact.assertions) {
      if (a.assertionKind === 'funding' || a.assertionKind === 'quantity') n += 1;
    }
  }
  return n;
}

/* ------------------------------------------------------------------ */
/* Proof-pack ordering for citations                                    */
/* ------------------------------------------------------------------ */

export interface ProcurementProofPackSortable {
  exhibitType: string | null;
  fy: number | null;
  pageNumber: number | null;
}

/** Lower rank sorts first; unknown exhibits sort after the known ones. */
export function procurementProofPackRank(exhibitType: string | null | undefined): number {
  const e = (exhibitType ?? '').toUpperCase().replace(/\s+/g, '');
  const idx = (PROCUREMENT_PROOF_PACK_EXHIBIT_ORDER as readonly string[]).indexOf(e);
  return idx >= 0 ? idx : PROCUREMENT_PROOF_PACK_EXHIBIT_ORDER.length;
}

/** Exhibit order (P-1 -> P-40 -> P-40A -> P-5 -> ...), then FY desc, then page asc. */
export function compareProcurementProofPackSources(
  a: ProcurementProofPackSortable,
  b: ProcurementProofPackSortable,
): number {
  const ra = procurementProofPackRank(a.exhibitType);
  const rb = procurementProofPackRank(b.exhibitType);
  if (ra !== rb) return ra - rb;
  const fya = a.fy ?? -1;
  const fyb = b.fy ?? -1;
  if (fya !== fyb) return fyb - fya;
  return (a.pageNumber ?? Number.MAX_SAFE_INTEGER) - (b.pageNumber ?? Number.MAX_SAFE_INTEGER);
}
