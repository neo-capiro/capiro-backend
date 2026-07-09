// Single-file consumer-facing module. Earlier this file re-exported from
// roles.ts + tenant.ts, but Rollup (used by Vite) can't always trace named
// exports through CommonJS-compiled `export { x } from './y'` statements.
// Inlining keeps both Vite and the NestJS CJS runtime happy without dual
// builds or compatibility plugins.

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

export const TENANT_ROLES = [
  'capiro_admin',
  'user_admin',
  'standard_user',
  'client_portal_user',
] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];

export const ROLE_RANK: Record<TenantRole, number> = {
  client_portal_user: 0,
  standard_user: 1,
  user_admin: 2,
  capiro_admin: 3,
};

export function hasAtLeast(role: TenantRole, minimum: TenantRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export function isCapiroAdmin(role: TenantRole): boolean {
  return role === 'capiro_admin';
}

/** Tenant-admin power: own tenant for `user_admin`, any tenant for `capiro_admin`. */
export function isTenantAdmin(role: TenantRole): boolean {
  return role === 'user_admin' || role === 'capiro_admin';
}

// ---------------------------------------------------------------------------
// Tenant context
// ---------------------------------------------------------------------------

export interface TenantContext {
  tenantId: string;
  tenantSlug: string;
  userId: string;
  clerkUserId: string;
  role: TenantRole;
}

// ---------------------------------------------------------------------------
// Controlled vocabularies, Portfolio v2
// Centralized to avoid drift between API validation, UI pickers, and rendering.
// ---------------------------------------------------------------------------

export const SECTOR_TAGS = [
  'DEFENSE',
  'HEALTH',
  'ENERGY',
  'TRANSPORTATION',
  'AGRICULTURE',
  'HOMELAND_SECURITY',
  'ENVIRONMENT_WATER',
  'COMMERCE_TECH',
  'EDUCATION',
  'FINANCIAL_SERVICES',
  'OTHER',
] as const;

export type SectorTag = (typeof SECTOR_TAGS)[number];

export const SECTOR_LABELS: Record<SectorTag, string> = {
  DEFENSE: 'Defense',
  HEALTH: 'Health & Pharma',
  ENERGY: 'Energy',
  TRANSPORTATION: 'Transportation',
  AGRICULTURE: 'Agriculture',
  HOMELAND_SECURITY: 'Homeland Security',
  ENVIRONMENT_WATER: 'Environment / Water',
  COMMERCE_TECH: 'Commerce / Tech',
  EDUCATION: 'Education',
  FINANCIAL_SERVICES: 'Financial Services',
  OTHER: 'Other',
};

export const SECTOR_COLORS: Record<SectorTag, string> = {
  DEFENSE: 'volcano',
  HEALTH: 'green',
  ENERGY: 'gold',
  TRANSPORTATION: 'blue',
  AGRICULTURE: 'lime',
  HOMELAND_SECURITY: 'orange',
  ENVIRONMENT_WATER: 'cyan',
  COMMERCE_TECH: 'geekblue',
  EDUCATION: 'purple',
  FINANCIAL_SERVICES: 'magenta',
  OTHER: 'default',
};

/** Normalize free-form sector text to a controlled SectorTag, or null if no clean match. */
export function normalizeSector(raw: string | null | undefined): SectorTag | null {
  if (!raw) return null;
  const upper = raw
    .trim()
    .toUpperCase()
    .replace(/[\s\-\/&]+/g, '_');
  if ((SECTOR_TAGS as readonly string[]).includes(upper)) return upper as SectorTag;
  // Common free-text variants
  const aliases: Record<string, SectorTag> = {
    HEALTHCARE: 'HEALTH',
    HEALTH_CARE: 'HEALTH',
    PHARMA: 'HEALTH',
    PHARMACEUTICALS: 'HEALTH',
    DEFENSE_INDUSTRIAL_BASE: 'DEFENSE',
    DOD: 'DEFENSE',
    DHS: 'HOMELAND_SECURITY',
    HOMELAND: 'HOMELAND_SECURITY',
    ENVIRONMENT: 'ENVIRONMENT_WATER',
    WATER: 'ENVIRONMENT_WATER',
    EPA: 'ENVIRONMENT_WATER',
    DOE: 'ENERGY',
    DOT: 'TRANSPORTATION',
    USDA: 'AGRICULTURE',
    AG: 'AGRICULTURE',
    COMMERCE: 'COMMERCE_TECH',
    TECH: 'COMMERCE_TECH',
    TECHNOLOGY: 'COMMERCE_TECH',
    ED: 'EDUCATION',
    EDU: 'EDUCATION',
    FINANCE: 'FINANCIAL_SERVICES',
    FINANCIAL: 'FINANCIAL_SERVICES',
    TREASURY: 'FINANCIAL_SERVICES',
  };
  return aliases[upper] ?? null;
}

// ---------------------------------------------------------------------------
// Federal agency → SectorTag mapping.
// Used by comment-period relevance scoring and any future agency-driven alerts.
// Keep keys aligned with Federal Register agency_names + common abbreviations.
// ---------------------------------------------------------------------------

export const AGENCY_SECTOR_MAP: Record<string, SectorTag[]> = {
  'Department of Defense': ['DEFENSE'],
  DOD: ['DEFENSE'],
  'Environmental Protection Agency': ['ENVIRONMENT_WATER'],
  EPA: ['ENVIRONMENT_WATER'],
  'Department of Health and Human Services': ['HEALTH'],
  HHS: ['HEALTH'],
  'Food and Drug Administration': ['HEALTH'],
  FDA: ['HEALTH'],
  'Department of Energy': ['ENERGY'],
  DOE: ['ENERGY'],
  'Department of Transportation': ['TRANSPORTATION'],
  DOT: ['TRANSPORTATION'],
  'Department of Agriculture': ['AGRICULTURE'],
  USDA: ['AGRICULTURE'],
  'Department of Homeland Security': ['HOMELAND_SECURITY'],
  DHS: ['HOMELAND_SECURITY'],
  'Department of Commerce': ['COMMERCE_TECH'],
  'Federal Communications Commission': ['COMMERCE_TECH'],
  FCC: ['COMMERCE_TECH'],
  'Department of Education': ['EDUCATION'],
  'Securities and Exchange Commission': ['FINANCIAL_SERVICES'],
  SEC: ['FINANCIAL_SERVICES'],
  'Department of the Treasury': ['FINANCIAL_SERVICES'],
  'Consumer Financial Protection Bureau': ['FINANCIAL_SERVICES'],
  'Department of the Interior': ['ENVIRONMENT_WATER'],
  'Army Corps of Engineers': ['ENVIRONMENT_WATER', 'DEFENSE'],
};

// ---------------------------------------------------------------------------
// SectorTag → canonical LDA issue codes.
// Bridges the controlled SectorTag taxonomy to the LDA filing taxonomy so
// market-wide intel changes can be tagged with `relatedIssues` (LDA codes)
// when the emitter only has sector context. Codes are the 3-letter LDA
// issue-code identifiers (see lda_issue_code table). Multiple codes per
// sector is intentional, a "DEFENSE" sector touches DEF + HOM + AER.
// ---------------------------------------------------------------------------

export const SECTOR_TO_LDA_CODES: Record<SectorTag, string[]> = {
  DEFENSE: ['DEF', 'HOM', 'AER', 'INT'],
  HEALTH: ['HCR', 'MMM', 'PHA', 'MED'],
  ENERGY: ['ENG', 'FUE'],
  TRANSPORTATION: ['TRA', 'AVI', 'RRR', 'MAR', 'AUT'],
  AGRICULTURE: ['AGR', 'FOO'],
  HOMELAND_SECURITY: ['HOM', 'IMM', 'LAW'],
  ENVIRONMENT_WATER: ['ENV', 'WAT', 'CAW', 'NAT'],
  COMMERCE_TECH: ['CPT', 'COM', 'TEC', 'SCI', 'TEL', 'SMB'],
  EDUCATION: ['EDU'],
  FINANCIAL_SERVICES: ['BAN', 'FIN', 'TAX', 'INS', 'ACC'],
  OTHER: [],
};

/** Collect LDA issue codes for a list of sectors, deduped. */
export function ldaCodesForSectors(sectors: readonly SectorTag[]): string[] {
  const out = new Set<string>();
  for (const sector of sectors) {
    for (const code of SECTOR_TO_LDA_CODES[sector] ?? []) out.add(code);
  }
  return [...out];
}

// ---------------------------------------------------------------------------
// Tracker issue-area taxonomy (Capiro-managed) — the checkboxes on the client
// profile Tracker → Configure panel. Deliberately a SUPERSET of SECTOR_LABELS:
// the first block is 1:1 (identical strings) with the sector labels so a
// client's sector relates to an issue area by identity, and the second block
// adds cross-cutting issue areas that have no single owning sector. Single
// source of truth — the API serves this list and the Tracker recommendations
// matcher tokenizes against it.
// ---------------------------------------------------------------------------

export const ISSUE_AREAS: readonly string[] = [
  // Sector-aligned (verbatim SECTOR_LABELS, excluding OTHER)
  'Defense',
  'Homeland Security',
  'Health & Pharma',
  'Energy',
  'Environment / Water',
  'Transportation',
  'Agriculture',
  'Commerce / Tech',
  'Education',
  'Financial Services',
  // Cross-cutting (no single owning sector)
  'AI / Data Privacy',
  'Procurement',
  'Labor',
  'Tax',
  'Housing',
  'Public Safety',
];

// SectorTag → the issue area it maps to (identity on the label). Drives the
// Tracker "seed from profile" carryover: a client whose sector is DEFENSE
// gets the "Defense" issue area pre-selected. OTHER has no mapping.
export const SECTOR_TO_ISSUE_AREA: Record<SectorTag, string | null> = {
  DEFENSE: 'Defense',
  HOMELAND_SECURITY: 'Homeland Security',
  HEALTH: 'Health & Pharma',
  ENERGY: 'Energy',
  ENVIRONMENT_WATER: 'Environment / Water',
  TRANSPORTATION: 'Transportation',
  AGRICULTURE: 'Agriculture',
  COMMERCE_TECH: 'Commerce / Tech',
  EDUCATION: 'Education',
  FINANCIAL_SERVICES: 'Financial Services',
  OTHER: null,
};

/** The issue area a sector maps to, or null. Accepts free-form sector text. */
export function issueAreaForSector(sector: string | null | undefined): string | null {
  const tag = normalizeSector(sector);
  return tag ? SECTOR_TO_ISSUE_AREA[tag] : null;
}

// Legacy → canonical issue-area label remap. The first Tracker taxonomy used
// energy-mockup labels; this reconciliation renamed several to align 1:1 with
// sector labels. normalizeIssueArea keeps already-saved watchlist selections
// from being silently dropped by the canonical-only filter on the next save.
const ISSUE_AREA_ALIASES: Record<string, string> = {
  'energy & utilities': 'Energy',
  healthcare: 'Health & Pharma',
  environment: 'Environment / Water',
  insurance: 'Financial Services',
};

/** Map a stored/free-form issue-area label to a canonical ISSUE_AREAS value, or null. */
export function normalizeIssueArea(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const t = raw.trim();
  if (ISSUE_AREAS.includes(t)) return t;
  return ISSUE_AREA_ALIASES[t.toLowerCase()] ?? null;
}

// ---------------------------------------------------------------------------
// Submission tracks (Portfolio v2 §2.5)
// ---------------------------------------------------------------------------

export const SUBMISSION_TRACKS = [
  'NDAA',
  'APPROPRIATIONS',
  'CDS',
  'AUTHORIZATION',
  'FARM_BILL',
  'ADVOCACY',
] as const;

export type SubmissionTrack = (typeof SUBMISSION_TRACKS)[number];

export const SUBMISSION_TRACK_LABELS: Record<SubmissionTrack, string> = {
  NDAA: 'NDAA Authorization Request',
  APPROPRIATIONS: 'Appropriations Plus-Up',
  CDS: 'CDS / Earmark Request',
  AUTHORIZATION: 'Authorization (non-NDAA)',
  FARM_BILL: 'Farm Bill Provision',
  ADVOCACY: 'Advocacy / Dear Colleague',
};

// ---------------------------------------------------------------------------
// Profile types / status (Portfolio v2 §2.1)
// ---------------------------------------------------------------------------

export const PROFILE_TYPES = ['CLIENT', 'PROGRAM'] as const;
export type ProfileType = (typeof PROFILE_TYPES)[number];

export const PROFILE_STATUSES = ['ACTIVE', 'PAUSED', 'MONITORING', 'ARCHIVED'] as const;
export type ProfileStatus = (typeof PROFILE_STATUSES)[number];

export const ACCOUNT_TYPES = ['LOBBYING_FIRM', 'INHOUSE_GA'] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const PLAN_TIERS = ['FOUNDATION', 'GROWTH', 'ENTERPRISE'] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

// ---------------------------------------------------------------------------
// Submission-history outcome types
// Canonical set: drawer is the writer, render must follow.
// ---------------------------------------------------------------------------

export const OUTCOME_TYPES = ['in_progress', 'success', 'partial', 'failed'] as const;
export type OutcomeType = (typeof OUTCOME_TYPES)[number];

export const OUTCOME_LABELS: Record<OutcomeType, string> = {
  in_progress: 'In Progress',
  success: 'Success',
  partial: 'Partial',
  failed: 'Failed',
};

export const OUTCOME_COLORS: Record<OutcomeType, string> = {
  in_progress: 'blue',
  success: 'green',
  partial: 'gold',
  failed: 'red',
};

/**
 * Coerce legacy / freeform outcome values to the canonical set.
 * Historical data has 'won', 'lost' which we map back into the new vocabulary.
 */
export function normalizeOutcome(raw: string | null | undefined): OutcomeType {
  if (!raw) return 'in_progress';
  const lower = raw.trim().toLowerCase();
  if ((OUTCOME_TYPES as readonly string[]).includes(lower)) return lower as OutcomeType;
  const aliases: Record<string, OutcomeType> = {
    won: 'success',
    win: 'success',
    successful: 'success',
    lost: 'failed',
    loss: 'failed',
    fail: 'failed',
    partial_win: 'partial',
    mixed: 'partial',
    pending: 'in_progress',
    ongoing: 'in_progress',
  };
  return aliases[lower] ?? 'in_progress';
}

// ---------------------------------------------------------------------------
// Capability tag suggestions
// Free-add still permitted, but these prevent typo-divergence on common terms.
// ---------------------------------------------------------------------------

export const CAPABILITY_TAG_SUGGESTIONS = [
  // technical
  'autonomy',
  'ai',
  'machine learning',
  'cybersecurity',
  'quantum',
  'space',
  'unmanned',
  'maritime',
  'aviation',
  'biotech',
  'genomics',
  'medical devices',
  'pharmaceutical',
  'vaccines',
  'energy storage',
  'nuclear',
  'renewable',
  'grid',
  'semiconductor',
  'microelectronics',
  'manufacturing',
  'logistics',
  'supply chain',
  // mission / domain
  'small business',
  'rural',
  'workforce',
  'workforce development',
  'research',
  'r&d',
  'commercialization',
  'sbir',
  'sttr',
  'dual-use',
  'critical infrastructure',
  'climate',
  'water',
  'transportation',
  'broadband',
  // policy
  'export control',
  'foreign investment',
  'procurement reform',
  'acquisition',
];

export const TENANT_HEADER = 'x-capiro-tenant';

// ---------------------------------------------------------------------------
// Billing (Stripe-direct). Single source of truth for pricing shared by the
// API (Checkout line items, slot enforcement, overage math) and the web app
// (subscribe screen, settings billing page). Keep in sync with the Stripe
// products/prices created in the dashboard (Phase 7).
// ---------------------------------------------------------------------------

/** Minimum client slots a tenant must purchase at sign-up. */
export const MIN_CLIENT_SLOTS = 10;

/**
 * The slot allowance ENFORCEMENT should use, given a tenant's billing status.
 * A trialing tenant always gets at least the 10-profile trial allowance
 * (Gherkin Flow 1: "10 client profile limit"), even if its clientSlots column
 * was stamped smaller — every slot gate (LDA import, client create, CSV) and
 * the setup dashboard cap must agree on this number.
 */
export function effectiveClientSlots(
  billingStatus: string | null | undefined,
  clientSlots: number,
): number {
  return billingStatus === 'trialing' ? Math.max(clientSlots, MIN_CLIENT_SLOTS) : clientSlots;
}

/**
 * Client-slot pricing (onboarding v1, Ninja decision Q2 2026-07-06): FLAT
 * $200/slot/month for every self-serve quantity. The previous $180/$160
 * volume tiers were removed — volume discounts are contact-sales only, never
 * automatic. Matches the flat Stripe price (lookup_key
 * capiro_client_slots_flat200 in onboard-api's setup-stripe.ts).
 */
export const CLIENT_SLOT_TIERS = [{ minSlots: MIN_CLIENT_SLOTS, pricePerSlotUsd: 200 }] as const;

/**
 * Subscribing locks the $200/slot price for this many months
 * (tenants.price_lock_expires_at); the "limited-time" launch offer copy.
 */
export const PRICE_LOCK_MONTHS = 12;

/** Pricing headline shown wherever the $200 price appears (Ninja copy ask). */
export const PRICE_LOCK_COPY = 'Limited-time price — lock in $200/profile for 1 year.';

/**
 * "Prices subject to change" language reconciled with the 12-month lock
 * (shown on-screen on plan selection, not buried in the legal docs).
 */
export const PRICE_CHANGE_COPY =
  'Your price is locked for 12 months from subscription; thereafter prices are subject to change.';

/** Per-slot monthly price for a given purchased quantity (flat $200). */
export function pricePerSlotUsd(quantity: number): number {
  for (const tier of CLIENT_SLOT_TIERS) {
    if (quantity >= tier.minSlots) return tier.pricePerSlotUsd;
  }
  // Below the minimum we still quote the base price (the UI/server clamps the
  // purchasable quantity to MIN_CLIENT_SLOTS separately).
  return CLIENT_SLOT_TIERS[CLIENT_SLOT_TIERS.length - 1]!.pricePerSlotUsd;
}

/** Total monthly slot subscription cost for a given quantity. */
export function monthlySlotCostUsd(quantity: number): number {
  return quantity * pricePerSlotUsd(quantity);
}

/** Included LLM usage allowance, pooled across the tenant, per purchased slot. */
export const LLM_ALLOWANCE_USD_PER_SLOT = 20;

/** Fraction of allowance at which we surface a soft usage warning. */
export const LLM_WARN_THRESHOLD = 0.8;

/** Overage above the allowance is billed at this multiple of our real cost. */
export const LLM_OVERAGE_MULTIPLIER = 2;

export const BILLING_STATUSES = [
  'none',
  'trialing',
  'active',
  'past_due',
  'canceled',
  'comped',
] as const;
export type BillingStatus = (typeof BILLING_STATUSES)[number];

/** A tenant is entitled to use the product (and bypass paywalls) when: */
export function isBillingEntitled(status: BillingStatus): boolean {
  return status === 'active' || status === 'trialing' || status === 'comped';
}

/** Structured error code returned (HTTP 402) when a client create exceeds slots. */
export const CLIENT_SLOT_LIMIT_CODE = 'CLIENT_SLOT_LIMIT';

/** Response shape of GET /api/billing/summary. */
export interface BillingSummary {
  /**
   * Master switch: false when Stripe is not configured on this environment
   * (STRIPE_SECRET_KEY unset). While false, billing is DORMANT — the app must
   * not paywall, cap client slots, or meter overage. Lets the feature ship to
   * prod inert and be turned on later by wiring Stripe + comping tenants.
   */
  billingEnabled: boolean;
  status: BillingStatus;
  /** Purchased client slots (0 before first subscription). */
  slots: number;
  /** Active (non-archived) clients currently in use. */
  usedSlots: number;
  /** Per-slot monthly price at the current quantity, whole USD. */
  pricePerSlotUsd: number;
  /** Included pooled LLM allowance for the period, USD. */
  llmAllowanceUsd: number;
  /** Month-to-date real LLM cost, USD. */
  llmUsedUsd: number;
  /** Billable overage so far this period = max(0, used − allowance) × multiplier. */
  llmOverageUsd: number;
  /** True once MTD usage crosses LLM_WARN_THRESHOLD of the allowance. */
  llmWarn: boolean;
  /** Optional admin-set hard cap on real LLM spend, USD (null = uncapped). */
  llmHardCapUsd: number | null;
  /** End of the current Stripe billing period, ISO string (null if not subscribed). */
  currentPeriodEnd: string | null;
  /** Whether a Stripe customer/subscription exists (drives portal vs checkout). */
  hasSubscription: boolean;
}

// ---------------------------------------------------------------------------
// Canonical Alert (MeriV2 Phase-1, SC1.1/SC1.2)
// ---------------------------------------------------------------------------
// The ONE seven-field alert shape all three alert surfaces (Tracker,
// Intelligence, the web feed) import — no surface invents a divergent
// "almost-alert". buildAlert FLAGS missing required fields rather than
// dropping the alert (SC1.2). Lives here (not @capiro/meriv2-core) because
// this is the lowest common dependency of all three surfaces — apps/web and
// apps/intel-api depend on @capiro/shared but not on meriv2-core; meriv2-core
// re-exports it so its existing importers are unchanged. Pure and DB-free.

/** Source taxonomy across the three surfaces. Optional — never affects completeness. */
export type SourceType =
  | 'bill'
  | 'hearing'
  | 'combined'
  | 'comment_deadline'
  | 'comment_overdue'
  | 'competitor_filing'
  | 'contract_award'
  | 'bill_movement';

export const SOURCE_TYPES: readonly SourceType[] = [
  'bill',
  'hearing',
  'combined',
  'comment_deadline',
  'comment_overdue',
  'competitor_filing',
  'contract_award',
  'bill_movement',
] as const;

export interface Alert {
  /** What changed — the underlying event, in plain language. Required. */
  whatChanged: string;
  /** Why it matters to THIS client. Required. */
  whyItMatters: string;
  /** The client this alert is for. Required. */
  clientId: string;
  /** The issue / interest area it maps to. Required. */
  issueId: string;
  /** Who should act (role or person). Required. */
  whoActs: string;
  /** Optional action deadline (ISO-8601 date/datetime); null when none. */
  deadline?: string | null;
  /** Optional drafted artifact (memo/email) prepared for the action. */
  draftArtifactId?: string | null;
  /** Optional compliance-check id gating any action taken from this alert. */
  complianceCheckId?: string | null;
  /** Optional source taxonomy (never affects completeness). */
  sourceType?: SourceType;
}

/** The five fields an alert MUST have to be actionable (SC1.2). */
export const REQUIRED_ALERT_FIELDS = [
  'whatChanged',
  'whyItMatters',
  'clientId',
  'issueId',
  'whoActs',
] as const;

export type RequiredAlertField = (typeof REQUIRED_ALERT_FIELDS)[number];

export interface AlertBuildResult {
  /** The normalized alert. Present even when incomplete — never dropped. */
  alert: Alert;
  /** Required fields that were absent/blank — surfaced, never swallowed. */
  missingFields: RequiredAlertField[];
  /** True iff no required field is missing. */
  complete: boolean;
}

/**
 * Build a canonical `Alert`, FLAGGING (not dropping) any missing required field.
 * A blank/whitespace/absent required value is recorded in `missingFields` and
 * the alert is still returned (with that field as an empty string) so the
 * caller can render it marked-incomplete. Optional fields normalize to `null`
 * when absent. Never throws.
 */
export function buildAlert(input: Partial<Alert>): AlertBuildResult {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  const optId = (v: unknown): string | null => {
    const s = str(v);
    return s.length > 0 ? s : null;
  };

  const alert: Alert = {
    whatChanged: str(input.whatChanged),
    whyItMatters: str(input.whyItMatters),
    clientId: str(input.clientId),
    issueId: str(input.issueId),
    whoActs: str(input.whoActs),
    deadline: optId(input.deadline),
    draftArtifactId: optId(input.draftArtifactId),
    complianceCheckId: optId(input.complianceCheckId),
    ...(input.sourceType ? { sourceType: input.sourceType } : {}),
  };

  const missingFields = REQUIRED_ALERT_FIELDS.filter((field) => alert[field].length === 0);
  return { alert, missingFields, complete: missingFields.length === 0 };
}

/** Convenience: true iff every required field is present. */
export function isAlertComplete(input: Partial<Alert>): boolean {
  return buildAlert(input).complete;
}

// ---------------------------------------------------------------------------
// Canonical entity IDs (Bucket-#3 C6 / architecture-plan Appendix B)
// ---------------------------------------------------------------------------
// THE registry of external-identifier types every tool and sync speaks. One
// validator + normalizer per type so "does this member/bill/company exist"
// checks (SC2.2-class evals) have a single source of truth. Pure + DB-free;
// crosswalk PERSISTENCE lives in apps/api (entity_crosswalk).

export const CANONICAL_ID_TYPES = [
  'bioguide', // Congress member (B000944)
  'billId', // Capiro house format "{congress}-{type}-{number}" e.g. "119-hr-8800"
  'committee', // Congress.gov systemCode e.g. hsas00 / ssas00
  'cik', // SEC Central Index Key (numeric, ≤10 digits)
  'uei', // SAM.gov Unique Entity ID (12 alphanumeric, no I/O)
  'cage', // CAGE code (5 alphanumeric)
  'rin', // Regulation Identifier Number (4 alnum agency + '-' + 4 alnum)
  'docketId', // regulations.gov docket e.g. EPA-HQ-OAR-2021-0317
  'fain', // Federal Award Identification Number (grants)
  'piid', // Procurement Instrument ID (contracts)
  'naics', // NAICS code (2-6 digits)
  'peCode', // DoD Program Element e.g. 0603270A
] as const;

export type CanonicalIdType = (typeof CANONICAL_ID_TYPES)[number];

/** Congress.gov bill types, lowercase (the segment in our billId + API paths). */
export const BILL_TYPES = [
  'hr',
  's',
  'hjres',
  'sjres',
  'hconres',
  'sconres',
  'hres',
  'sres',
] as const;
export type BillType = (typeof BILL_TYPES)[number];

const PATTERNS: Record<CanonicalIdType, RegExp> = {
  bioguide: /^[A-Z][0-9]{6}$/,
  billId: new RegExp(`^[0-9]{2,3}-(${BILL_TYPES.join('|')})-[0-9]{1,5}$`),
  committee: /^[hsj][sc][a-z]{2}[0-9]{2}$/,
  cik: /^[0-9]{1,10}$/,
  uei: /^[A-HJ-NP-Z0-9]{12}$/,
  cage: /^[A-Z0-9]{5}$/,
  rin: /^[A-Z0-9]{4}-[A-Z0-9]{2,4}$/,
  docketId: /^[A-Z0-9]{2,10}(-[A-Za-z0-9]+)+$/,
  fain: /^[A-Z0-9][A-Z0-9.-]{3,29}$/,
  piid: /^[A-Z0-9]{4,17}$/,
  naics: /^[0-9]{2,6}$/,
  peCode: /^[0-9]{7}[A-Z]{1,2}$/,
};

/** True iff `value` (after normalizeCanonicalId) is a well-formed id of `type`. */
export function isValidCanonicalId(type: CanonicalIdType, value: string): boolean {
  return PATTERNS[type].test(normalizeCanonicalId(type, value));
}

/**
 * Normalize an id to its canonical textual form (what we store and compare):
 * trims, then per-type casing — bioguide/committee ids are case-normalized,
 * CIK strips leading zeros, billId lowercases its type segment. Never throws;
 * returns the trimmed input when no rule applies.
 */
export function normalizeCanonicalId(type: CanonicalIdType, value: string): string {
  const v = (value ?? '').trim();
  switch (type) {
    case 'bioguide':
      return v.toUpperCase();
    case 'committee':
      return v.toLowerCase();
    case 'cik':
      return v.replace(/^0+(?=[0-9])/, '');
    case 'uei':
    case 'cage':
    case 'rin':
      return v.toUpperCase();
    case 'billId':
      return v.toLowerCase();
    case 'naics':
    case 'fain':
    case 'piid':
    case 'docketId':
    case 'peCode':
    default:
      return v;
  }
}

export interface ParsedBillId {
  congress: number;
  type: BillType;
  number: number;
}

/** Parse OUR bill-id house format ("119-hr-8800"). Null when malformed. */
export function parseBillId(billId: string): ParsedBillId | null {
  const v = normalizeCanonicalId('billId', billId);
  if (!PATTERNS.billId.test(v)) return null;
  const [congress, type, number] = v.split('-');
  return { congress: Number(congress), type: type as BillType, number: Number(number) };
}

/** Format the canonical Capiro bill id from its parts. */
export function formatBillId(congress: number, type: string, number: number): string | null {
  const t = type.toLowerCase().replace(/[^a-z]/g, '');
  if (!(BILL_TYPES as readonly string[]).includes(t)) return null;
  if (!Number.isInteger(congress) || congress < 1 || !Number.isInteger(number) || number < 1) {
    return null;
  }
  return `${congress}-${t}-${number}`;
}

/**
 * Parse a human/citation bill designation ("H.R. 8800", "S. 663", "H. Res. 5",
 * with optional trailing congress like "H.R. 8800 (119th)") into parts, given a
 * default congress. Whitespace/punctuation tolerant — feed-normalization for
 * floor schedules and vote records ("H.R. 5347 " with trailing space, etc.).
 */
export function parseBillDesignation(text: string, defaultCongress: number): ParsedBillId | null {
  const cleaned = (text ?? '').trim();
  const congressMatch = cleaned.match(/\((\d{2,3})(?:st|nd|rd|th)?\)\s*$/);
  const congress = congressMatch ? Number(congressMatch[1]) : defaultCongress;
  const body = congressMatch ? cleaned.slice(0, congressMatch.index).trim() : cleaned;
  const m = body.match(
    /^(h\.?\s*r\.?|s\.?|h\.?\s*j\.?\s*res\.?|s\.?\s*j\.?\s*res\.?|h\.?\s*con\.?\s*res\.?|s\.?\s*con\.?\s*res\.?|h\.?\s*res\.?|s\.?\s*res\.?)\s*(\d{1,5})$/i,
  );
  if (!m || !m[1] || !m[2]) return null;
  const rawType = m[1].toLowerCase().replace(/[^a-z]/g, '');
  // "s" designations: plain "S. 663" is type 's'; the res forms already parsed.
  const type = (BILL_TYPES as readonly string[]).includes(rawType) ? (rawType as BillType) : null;
  if (!type) return null;
  const number = Number(m[2]);
  const id = formatBillId(congress, type, number);
  return id ? { congress, type, number } : null;
}

/** The api.congress.gov path segment for a bill ("/bill/119/hr/8800"). */
export function billIdToCongressGovPath(billId: string): string | null {
  const p = parseBillId(billId);
  return p ? `/bill/${p.congress}/${p.type}/${p.number}` : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Bill stage / status (LegiWatch A4). ONE canonical home — the tracker board
// helpers (billStage/passageProbability/currentCongress/…) and the per-action
// normalizer (normalizeBillStage) were duplicated across apps/api, apps/intel-api
// and apps/web; those files now re-export from here. deriveBillStatus is the NEW
// rich, rule- and vote-aware bill-LEVEL status behind congress_bill.status.
// ─────────────────────────────────────────────────────────────────────────

/** The four kanban board columns (simple bill-level stage). */
export type BillStage = 'introduced' | 'committee' | 'passed' | 'enacted';

export const BILL_STAGES: ReadonlyArray<{ id: BillStage; label: string }> = [
  { id: 'introduced', label: 'Introduced' },
  { id: 'committee', label: 'In committee' },
  { id: 'passed', label: 'Passed chamber' },
  { id: 'enacted', label: 'Enacted' },
];

/** Classify a bill's latest action text into a board stage (status-driven). */
export function billStage(latestActionText: string | null | undefined): BillStage {
  const txt = (latestActionText ?? '').toLowerCase();
  if (/signed|enacted|public law|pl\s+\d/.test(txt)) return 'enacted';
  if (/passed|agreed to/.test(txt)) return 'passed';
  if (/committee|referred|reported|markup/.test(txt)) return 'committee';
  return 'introduced';
}

/**
 * Calibrated passage-likelihood heuristic (0..1). NOT a trained model. `nowMs`
 * is injectable for tests (defaults to Date.now()).
 */
export function passageProbability(bill: {
  latestActionText: string | null;
  title?: string | null;
  latestActionDate?: Date | null;
  nowMs?: number;
}): number {
  const stage = billStage(bill.latestActionText);
  if (stage === 'enacted') return 0.99;
  const mustPass =
    /national defense authorization|consolidated appropriations|making appropriations|defense appropriation|continuing appropriations|further (consolidated |additional )?appropriations/i.test(
      bill.title ?? '',
    );
  let p =
    stage === 'passed'
      ? mustPass
        ? 0.85
        : 0.4
      : stage === 'committee'
        ? mustPass
          ? 0.55
          : 0.12
        : mustPass
          ? 0.3
          : 0.04;
  const actionMs = bill.latestActionDate ? bill.latestActionDate.getTime() : null;
  if (actionMs != null) {
    const days = ((bill.nowMs ?? Date.now()) - actionMs) / 86_400_000;
    if (days > 270) p *= 0.6;
    else if (days < 45) p = Math.min(0.95, p * 1.15);
  }
  return Math.max(0.02, Math.min(0.97, p));
}

/** The current US Congress number (a Congress spans 2 years from the odd year). */
export function currentCongress(now: Date = new Date()): number {
  return Math.floor((now.getFullYear() - 1789) / 2) + 1;
}

/** Parse the leading Congress number from a bill id ("119-hr-7702" → 119), or null. */
export function congressFromBillId(id: string): number | null {
  const n = Number((id ?? '').split('-')[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

const BILL_TYPE_LABEL: Record<string, string> = {
  hr: 'H.R.',
  s: 'S.',
  hjres: 'H.J.Res.',
  sjres: 'S.J.Res.',
  hconres: 'H.Con.Res.',
  sconres: 'S.Con.Res.',
  hres: 'H.Res.',
  sres: 'S.Res.',
};

/** Humanize a congress_bill id ("119-hr-7702") into a display label ("H.R. 7702"). */
export function humanizeBillId(id: string): string {
  const parts = (id ?? '').split('-');
  if (parts.length < 3) return id;
  const type = parts[1] ?? '';
  const number = parts.slice(2).join('-');
  if (!type) return id;
  const prefix = BILL_TYPE_LABEL[type.toLowerCase()] ?? type.toUpperCase();
  return `${prefix} ${number}`;
}

// Per-ACTION stage normalizer (legislative-timeline). Distinct from the
// bill-level BillStage above: classifies a single action row for the timeline
// display. Type names kept as ActionStage/ActionStageResult here (the
// program-element module re-exports them under its historical BillStage names).
export type ActionStage =
  | 'introduced'
  | 'referred'
  | 'markup'
  | 'reported'
  | 'passed_house'
  | 'passed_senate'
  | 'conference'
  | 'to_president'
  | 'enacted'
  | 'other';

export interface ActionStageResult {
  stage: ActionStage;
  label: string;
  rank: number;
}

const ACTION_STAGE_META: Record<ActionStage, { label: string; rank: number }> = {
  introduced: { label: 'Introduced', rank: 0 },
  referred: { label: 'Referred', rank: 1 },
  markup: { label: 'Markup', rank: 2 },
  reported: { label: 'Reported', rank: 3 },
  passed_house: { label: 'Passed House', rank: 4 },
  passed_senate: { label: 'Passed Senate', rank: 5 },
  conference: { label: 'Conference', rank: 6 },
  to_president: { label: 'To President', rank: 7 },
  enacted: { label: 'Became law', rank: 8 },
  other: { label: 'Action', rank: -1 },
};

function actionResult(stage: ActionStage): ActionStageResult {
  return { stage, ...ACTION_STAGE_META[stage] };
}

/** Classify one congress_bill_action into a normalized timeline stage. */
export function normalizeBillStage(
  text: string | null | undefined,
  type?: string | null,
  chamber?: string | null,
): ActionStageResult {
  const t = (text ?? '').toLowerCase();
  const ch = (chamber ?? '').toLowerCase();
  if (
    t.includes('became public law') ||
    t.includes('became law') ||
    t.includes('signed by president') ||
    t.includes('public law no')
  ) {
    return actionResult('enacted');
  }
  if (t.includes('presented to president') || t.includes('to president')) {
    return actionResult('to_president');
  }
  if (
    t.includes('conference report') ||
    t.includes('conferees') ||
    t.includes('resolving differences') ||
    t.includes('amendment between the houses')
  ) {
    return actionResult('conference');
  }
  if (t.includes('passed') || t.includes('agreed to')) {
    if (t.includes('senate') || ch === 'senate') return actionResult('passed_senate');
    if (t.includes('house') || ch === 'house') return actionResult('passed_house');
    return actionResult('other');
  }
  if (t.includes('markup') || t.includes('ordered to be reported')) {
    return actionResult('markup');
  }
  if (t.includes('reported')) {
    return actionResult('reported');
  }
  if (t.includes('referred to')) {
    return actionResult('referred');
  }
  if (t.includes('introduced')) {
    return actionResult('introduced');
  }
  const ty = (type ?? '').toLowerCase();
  if (ty === 'introreferral') return actionResult('referred');
  if (ty === 'becamelaw') return actionResult('enacted');
  if (ty === 'president') return actionResult('to_president');
  return actionResult('other');
}

/**
 * Rich, canonical bill-LEVEL legislative status (LegiWatch A4) — the source of
 * truth behind congress_bill.status and the get_bill_status Meri tool. Unlike
 * the 4-value billStage board classifier, this distinguishes rule_pending from
 * rule_failed: a bill whose own latest action is only "Rules Committee
 * Resolution ... Reported" READS like it is advancing, but if its governing
 * rule FAILED the bill is stalled. That distinction is the exact H.R. 8800 miss
 * — so the caller passes the governing rule's outcome + any chamber-passage
 * vote (both from the DB) and this function resolves the honest status.
 */
export type BillStatus =
  | 'introduced'
  | 'committee'
  | 'reported'
  | 'rule_pending'
  | 'rule_failed'
  | 'floor'
  | 'passed_chamber'
  | 'resolving'
  | 'to_president'
  | 'enacted'
  | 'failed'
  | 'vetoed';

const BILL_STATUS_META: Record<BillStatus, { label: string; rank: number }> = {
  introduced: { label: 'Introduced', rank: 0 },
  committee: { label: 'In committee', rank: 1 },
  reported: { label: 'Reported out of committee', rank: 2 },
  rule_pending: { label: 'Rule granted (floor pending)', rank: 3 },
  rule_failed: { label: 'Rule failed — stalled on the floor', rank: 3 },
  floor: { label: 'On the floor', rank: 4 },
  passed_chamber: { label: 'Passed a chamber', rank: 5 },
  resolving: { label: 'Resolving differences', rank: 6 },
  to_president: { label: 'Sent to the President', rank: 7 },
  enacted: { label: 'Enacted', rank: 9 },
  failed: { label: 'Failed', rank: 9 },
  vetoed: { label: 'Vetoed', rank: 9 },
};

export interface BillStatusResult {
  status: BillStatus;
  label: string;
  rank: number;
}

/** Human label for a persisted congress_bill.status value (or the raw value). */
export function billStatusLabel(status: string | null | undefined): string {
  if (status && status in BILL_STATUS_META) return BILL_STATUS_META[status as BillStatus].label;
  return status ?? 'Unknown';
}

export function deriveBillStatus(input: {
  latestActionText?: string | null;
  /** Outcome of the bill's most recent GOVERNING rule (from bill_rule_link + the rule's vote/status). */
  ruleOutcome?: 'adopted' | 'failed' | null;
  /** True when a roll_call_vote on THIS bill (not its rule) passed a chamber. */
  passedChamber?: boolean;
  /**
   * True when a roll_call_vote on THIS bill was a FAILED passage vote. Needed
   * because a bill/resolution can fail a floor vote while its latest action
   * text is procedural (e.g. a rule hres whose vote failed but whose last
   * action is "POSTPONED PROCEEDINGS…") — text alone would mislabel it.
   */
  failedChamber?: boolean;
}): BillStatusResult {
  const t = (input.latestActionText ?? '').toLowerCase();
  const mk = (status: BillStatus): BillStatusResult => ({ status, ...BILL_STATUS_META[status] });

  // Terminal / advanced states from the bill's own action text win first.
  if (/became (public )?law|public law no|signed by (the )?president|\benacted\b/.test(t)) {
    return mk('enacted');
  }
  if (/vetoed|veto message/.test(t)) return mk('vetoed');
  if (
    /failed of passage|failed to pass|rejected|motion to table agreed|failed by the yeas/.test(t)
  ) {
    return mk('failed');
  }
  if (/presented to (the )?president|\bto president\b/.test(t)) return mk('to_president');
  if (
    /resolving differences|conference report|amendment(s)? between the houses|conferees/.test(t)
  ) {
    return mk('resolving');
  }

  // A real chamber-passage vote (from roll_call_vote) or explicit passage text.
  if (
    input.passedChamber ||
    /passed (the )?(house|senate)|passed\/agreed to in (house|senate)/.test(t)
  ) {
    return mk('passed_chamber');
  }

  // A real FAILED passage vote on this measure (outranks the rule-governed and
  // procedural fallbacks, but not an actual passage above). Only when the bill
  // hasn't otherwise advanced past a floor decision.
  if (input.failedChamber) return mk('failed');

  // Governing-rule outcome — the H.R. 8800 fix. A "rule reported" bill whose
  // rule FAILED is stalled, not advancing; a rule ADOPTED sends it to the floor.
  if (input.ruleOutcome === 'failed') return mk('rule_failed');
  if (input.ruleOutcome === 'adopted') return mk('floor');

  // The bill's own rule-granted marker (rule reported, floor not yet resolved).
  if (/rules committee resolution/.test(t)) return mk('rule_pending');

  if (/ordered to be reported|\breported\b/.test(t)) return mk('reported');
  if (/committee|referred|markup|hearing/.test(t)) return mk('committee');
  return mk('introduced');
}

/**
 * Classify a roll-call / action RESULT string into pass / fail (LegiWatch A4).
 * Used to derive a rule resolution's outcome from its own vote or action text.
 * Order matters: "not agreed to" must read as fail even though it contains
 * "agreed to".
 */
export function classifyVoteResult(result: string | null | undefined): 'pass' | 'fail' | null {
  const t = (result ?? '').toLowerCase();
  if (!t) return null;
  if (/not agreed|fail|reject|defeat|not passed|motion to table agreed/.test(t)) return 'fail';
  if (/agreed to|passed|adopted|prevail/.test(t)) return 'pass';
  return null;
}

// ─────────────────────────────────────────────────────────────────────────
// PE funding lifecycle — THE canonical per-FY "which stage counts" precedence.
// The PE detail page (apps/web funding-model.ts) and every server-side funding
// figure (finder list current, spark, summary trend, capability current) MUST
// derive from THIS so no surface invents a divergent rule. Inlined here (not a
// re-exported ./funding-model file) for the Rollup/CJS reason at the top of
// this module. Pure + DB-free; all values are $ MILLIONS (program_element_year).
// ─────────────────────────────────────────────────────────────────────────

/** A point in the appropriations lifecycle a funding value can come from. */
export type FundingStage =
  | 'enacted'
  | 'conference'
  | 'sacd'
  | 'hacd'
  | 'sasc'
  | 'hasc'
  | 'request'
  | 'none';

/** Human-facing label for each funding stage (legends, tooltips, "Latest: …"). */
export const FUNDING_STAGE_LABEL: Record<FundingStage, string> = {
  enacted: 'Enacted',
  conference: 'Conference',
  sacd: 'SAC-D',
  hacd: 'HAC-D',
  sasc: 'SASC',
  hasc: 'HASC',
  request: 'Request',
  none: 'No data',
};

/**
 * Congressional-position precedence: furthest-along stage EXCLUDING the
 * President's request, latest-stage first. Delta-vs-request uses this so a
 * request-only year (no congressional action) has no "position".
 */
export const FUNDING_CONGRESSIONAL_PRECEDENCE = [
  'enacted',
  'conference',
  'sacd',
  'hacd',
  'sasc',
  'hasc',
] as const satisfies readonly FundingStage[];

/**
 * "Current authoritative number" precedence: the congressional ladder, then the
 * request as the baseline fallback. Drives the trajectory line, the bar chart,
 * the finder headline, the spark, and the capability current.
 */
export const FUNDING_CURRENT_PRECEDENCE = [
  ...FUNDING_CONGRESSIONAL_PRECEDENCE,
  'request',
] as const satisfies readonly FundingStage[];

/** Per-FY stage values after numeric coercion. */
export interface FundingStageValues {
  request: number | null;
  hascMark: number | null;
  sascMark: number | null;
  hacDMark: number | null;
  sacDMark: number | null;
  conference: number | null;
  enacted: number | null;
}

export interface FundingPick {
  value: number | null;
  stage: FundingStage;
}

/** Map a stage key to its value in a FundingStageValues record. */
export function fundingValueForStage(
  values: FundingStageValues,
  stage: FundingStage,
): number | null {
  switch (stage) {
    case 'enacted':
      return values.enacted;
    case 'conference':
      return values.conference;
    case 'sacd':
      return values.sacDMark;
    case 'hacd':
      return values.hacDMark;
    case 'sasc':
      return values.sascMark;
    case 'hasc':
      return values.hascMark;
    case 'request':
      return values.request;
    case 'none':
      return null;
  }
}

/** Walk a precedence list and return the first stage that has a value. */
export function pickFunding(
  values: FundingStageValues,
  precedence: readonly FundingStage[],
): FundingPick {
  for (const stage of precedence) {
    const value = fundingValueForStage(values, stage);
    if (value != null) return { value, stage };
  }
  return { value: null, stage: 'none' };
}

/** The furthest-along authoritative number for a year (request as fallback). */
export function currentFunding(values: FundingStageValues): FundingPick {
  return pickFunding(values, FUNDING_CURRENT_PRECEDENCE);
}

/** Congress's furthest-along position for a year, or {null,'none'} if none. */
export function congressionalPosition(values: FundingStageValues): FundingPick {
  return pickFunding(values, FUNDING_CONGRESSIONAL_PRECEDENCE);
}

/**
 * DB column name (snake_case program_element_year) for each stage — lets the API
 * GENERATE its SQL COALESCE ladder from FUNDING_CURRENT_PRECEDENCE instead of
 * hand-ordering columns, so the server "current" can never drift from this
 * precedence. 'none' has no column.
 */
export const FUNDING_STAGE_DB_COLUMN: Record<Exclude<FundingStage, 'none'>, string> = {
  enacted: 'enacted',
  conference: 'conference',
  sacd: 'sac_d_mark',
  hacd: 'hac_d_mark',
  sasc: 'sasc_mark',
  hasc: 'hasc_mark',
  request: 'request',
};

/**
 * Build a SQL `COALESCE(<prefix>enacted, <prefix>conference, …, <prefix>request)`
 * fragment in the canonical current precedence order. Callers interpolate this
 * only with a trusted table-alias prefix (e.g. "y.") — never user input.
 */
export function fundingCurrentCoalesceSql(prefix = ''): string {
  const cols = FUNDING_CURRENT_PRECEDENCE.map((s) => `${prefix}${FUNDING_STAGE_DB_COLUMN[s]}`);
  return `COALESCE(${cols.join(', ')})`;
}

/**
 * Build a SQL `CASE WHEN <prefix>enacted IS NOT NULL THEN 'enacted' … ELSE 'none' END`
 * that yields the winning FundingStage key in canonical current precedence — the
 * stage counterpart to fundingCurrentCoalesceSql, so a server row can report
 * WHICH stage its "current" value came from without shipping every column. Same
 * trusted-prefix contract (no user input).
 */
export function fundingCurrentStageSql(prefix = ''): string {
  const whens = FUNDING_CURRENT_PRECEDENCE.map(
    (s) => `WHEN ${prefix}${FUNDING_STAGE_DB_COLUMN[s]} IS NOT NULL THEN '${s}'`,
  );
  return `CASE ${whens.join(' ')} ELSE 'none' END`;
}
