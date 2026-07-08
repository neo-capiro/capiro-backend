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
