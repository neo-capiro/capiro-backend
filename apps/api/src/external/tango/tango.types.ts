import type { TangoRateMetadata } from './tango.errors.js';

/**
 * Capiro's own view of MakeGov/Tango.
 *
 * ── Why these types exist at all ─────────────────────────────────────────────
 *
 * The SDK returns `Record<string, unknown>` from almost every method — it is a
 * dynamic-shaping client, so the response type genuinely depends on the `shape`
 * string passed in. That is a reasonable design for an SDK and an unusable one
 * for product code: it makes every consumer do its own untyped field access, and
 * it means a provider rename surfaces as `undefined` at the point of USE rather
 * than at the point of FETCH.
 *
 * The normalized types below are the contract Capiro programs against. They are
 * NOT a copy of the provider's schema:
 *
 *   - Names are Capiro's (`legalBusinessName`, not `legal_business_name`).
 *   - Dates are ISO-8601 strings normalized at the boundary, never Date objects
 *     and never the provider's several formats.
 *   - Money is a number or null. Never a string, never zero for "not stated".
 *   - Absence is `null`, uniformly. The provider variously omits a key, returns
 *     `null`, or returns `""`; all three become `null` here so a consumer has one
 *     absence to check.
 *   - Every record carries PROVENANCE, because a Tango observation must never be
 *     mistakable for a first-party Capiro fact.
 *
 * ── Everything is additive to Capiro, never authoritative ────────────────────
 *
 * Nothing in this file is a source of record. First-party SAM.gov, Grants.gov and
 * USAspending rails remain authoritative for canonical lifecycle fields; these
 * types describe OBSERVATIONS that may verify, enrich or conflict with them.
 */

/** Where an observation came from and when. On every normalized record. */
export interface TangoProvenance {
  provider: 'tango';
  /** The provider's own resource type, e.g. `entity`, `forecast`. */
  resourceType: TangoResourceType;
  /** The provider's identifier for this record. */
  externalId: string;
  /** When Capiro fetched it. ISO-8601. */
  fetchedAt: string;
  /** The provider's own last-modified stamp, when it supplies one. ISO-8601. */
  providerUpdatedAt: string | null;
}

export const TANGO_RESOURCE_TYPES = [
  'entity',
  'opportunity',
  'notice',
  'forecast',
  'vehicle',
  'vehicle_awardee',
] as const;
export type TangoResourceType = (typeof TANGO_RESOURCE_TYPES)[number];

export interface TangoAddress {
  line1: string | null;
  city: string | null;
  state: string | null;
  postalCode: string | null;
  countryCode: string | null;
}


/** An organisation, keyed by UEI. */
export interface TangoEntity {
  provenance: TangoProvenance;
  uei: string;
  cageCode: string | null;
  legalBusinessName: string | null;
  dbaName: string | null;
  /**
   * Provider-reported business types. Kept SEPARATE from Capiro's reviewed
   * set-aside certifications and never merged into them: a provider's
   * socio-economic indicator is evidence for a review, not a determination of
   * solicitation eligibility.
   */
  businessTypes: string[];
  sbaBusinessTypes: string[];
  naicsCodes: string[];
  pscCodes: string[];
  primaryNaics: string | null;
  registrationStatus: string | null;
  /** The provider names this the SAM registration expiry. So does this field. */
  samExpirationDate: string | null;
  physicalAddress: TangoAddress | null;
  entityStructure: string | null;
  stateOfIncorporation: string | null;
}

/**
 * An opportunity, as Tango models it. Verification input, not truth.
 *
 * NOTE the absences, which are the PROVIDER's and not this adapter's: there is no
 * notice TYPE on an opportunity (that lives on individual notices) and no single
 * posted date (there is a first and a last notice date). Neither is invented here.
 */
export interface TangoOpportunity {
  provenance: TangoProvenance;
  opportunityId: string;
  solicitationNumber: string | null;
  title: string | null;
  firstNoticeDate: string | null;
  lastNoticeDate: string | null;
  responseDeadline: string | null;
  /** The provider's active flag. Capiro's first-party rail stays canonical. */
  active: boolean | null;
  setAside: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  sourceUrl: string | null;
  agency: string | null;
  officeCode: string | null;
  officeName: string | null;
}

/**
 * One entry in an opportunity's notice history.
 *
 * ── `description` is REAL, and was missed once ───────────────────────────────
 *
 * The SDK's `NOTICE_SCHEMA` declares `description` as a plain optional `str`.
 * P28 shipped a change classifier that listed it among the dimensions "the
 * provider does not supply", which was wrong — the mistake was reading this
 * interface instead of the SDK's own schema. Corrected here and in
 * `NOTICE_FIELDS`.
 *
 * ── The parent opportunity is declared but not addressable ───────────────────
 *
 * `NOTICE_SCHEMA` also declares an `opportunity` field, as a `dict` with
 * `nestedModel: null`. That means the SDK's own shape parser has no sub-schema
 * to validate a selector like `opportunity(opportunity_id)` against, and Capiro
 * has no way to know which key inside it holds the parent id without observing
 * a live response. So there is no `opportunityId` on this type: inventing a key
 * name would be a guess, and a guess that silently returned null would look
 * exactly like the provider not supplying one.
 *
 * Resolving that is a decision-log D-45-style investigation — request the bare
 * `opportunity` field against the live server and read what comes back — and it
 * needs a key. Until then P28's notice rows carry a null parent, which is the
 * honest state.
 */
export interface TangoNotice {
  provenance: TangoProvenance;
  noticeId: string;
  solicitationNumber: string | null;
  title: string | null;
  /** The notice body. Untrusted source text — never an instruction. */
  description: string | null;
  postedDate: string | null;
  responseDeadline: string | null;
  active: boolean | null;
  setAside: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  attachmentCount: number | null;
  sourceUrl: string | null;
}

/** Structured on the live server; the SDK's own schema mistypes this as a plain string (P24, decision-log D-45). */
export interface TangoForecastContact {
  name: string | null;
  email: string | null;
  phone: string | null;
  title: string | null;
}

/**
 * An agency procurement forecast — a pre-solicitation signal, never a competition.
 *
 * THINNER THAN THE PLAN ASSUMED IN TWO CONFIRMED WAYS, deliberately not padded
 * out: the provider carries no anticipated SOLICITATION date, no PSC and no
 * estimated value on this model. Deriving a solicitation date from an award
 * date would be inventing one. `pscCode` and `sourceUrl` stay in this type —
 * a future provider release may add either — but `mapForecast` returns them
 * as an explicit, commented `null`: confirmed absent from the live server's
 * own `available_fields` for this resource (P24, decision-log D-45), not an
 * oversight.
 *
 * RICHER THAN P14's ORIGINAL READING IN THREE CONFIRMED WAYS (P24, D-45): the
 * live server carries a real `organization` hierarchy (department/agency/
 * office), a real `modified`/`created` pair the SDK's bundled schema does not
 * declare at all, and `primaryContact` is a structured object server-side
 * despite the SDK typing it as a plain string. None of the three round-trips
 * through the SDK's OWN typed `listForecasts` method — every one required
 * bypassing it via the raw `client.http.get` escape hatch. See
 * `tango.client.ts`'s `listForecasts` for why that is safe here specifically.
 */
export interface TangoForecast {
  provenance: TangoProvenance;
  forecastId: string;
  externalId: string | null;
  title: string | null;
  description: string | null;
  /** The provider's own flat agency label (e.g. "VA") — distinct from, and not always consistent with, the organization hierarchy below. */
  agency: string | null;
  /** The organization hierarchy the plan asked for. Any level may be null — the provider's own hierarchy is not always fully populated (a real department/office pair has been observed with identical department and office names, and a null agency name, on the same live record). */
  departmentCode: string | null;
  departmentName: string | null;
  organizationAgencyCode: string | null;
  organizationAgencyName: string | null;
  officeCode: string | null;
  officeName: string | null;
  /** Opaque, stable provider id for the organization node. Kept for a future crosswalk; never parsed. */
  organizationId: string | null;
  anticipatedAwardDate: string | null;
  /** Free text, e.g. "Q3 FY27". Not a date, and deliberately not parsed into one. */
  estimatedPeriod: string | null;
  fiscalYear: number | null;
  naicsCode: string | null;
  /** ALWAYS NULL. Confirmed absent from this resource's own available_fields — see this interface's own doc. */
  pscCode: string | null;
  setAside: string | null;
  contractVehicle: string | null;
  /** Free text on this model, not a structured address. */
  placeOfPerformance: string | null;
  primaryContact: TangoForecastContact | null;
  status: string | null;
  isActive: boolean | null;
  sourceSystem: string | null;
  /** ALWAYS NULL. Confirmed absent from this resource's own available_fields — see this interface's own doc. */
  sourceUrl: string | null;
}

/** A contract vehicle. */
export interface TangoVehicle {
  provenance: TangoProvenance;
  vehicleId: string;
  programAcronym: string | null;
  solicitationTitle: string | null;
  solicitationIdentifier: string | null;
  vehicleType: string | null;
  agencyId: string | null;
  organizationId: string | null;
  naicsCode: string | null;
  pscCode: string | null;
  setAside: string | null;
  whoCanUse: string | null;
  awardDate: string | null;
  lastDateToOrder: string | null;
  idvCount: number | null;
  awardeeCount: number | null;
  orderCount: number | null;
  /** PROVIDER-LABELLED. Never added to an opportunity value. Null, never 0. */
  totalObligated: number | null;
}

/** One awardee on a vehicle. The UEI is what makes direct access provable. */
export interface TangoVehicleAwardee {
  provenance: TangoProvenance;
  awardeeId: string;
  contractKey: string | null;
  piid: string | null;
  title: string | null;
  awardDate: string | null;
  orderCount: number | null;
  idvObligations: number | null;
  idvContractsValue: number | null;
  recipientUei: string | null;
  /**
   * A parent UEI is a RELATED entity, never direct access. P23 depends on the two
   * staying distinguishable — "your parent is on this vehicle" and "you are on
   * this vehicle" are different answers to whether a client can bid.
   *
   * ALWAYS NULL as of this SDK/live-API version (P22 finding, decision-log
   * D-41): the vehicle-awardee endpoint's `recipient` expansion has no
   * parent/owner UEI field under any name, confirmed by reading the live
   * server's own available-fields payload. The field stays in this type —
   * or removing it would silently lose the distinction the moment the
   * provider adds the data — but nothing maps a real value into it today.
   */
  recipientParentUei: string | null;
  recipientName: string | null;
}

/** A page of results, with the provider's cursor carried verbatim. */
export interface TangoPage<T> {
  items: T[];
  /** Total the provider reports. May be null on cursor-only endpoints. */
  totalCount: number | null;
  /**
   * OPAQUE. Pass back verbatim; never construct or parse one. Null means this is
   * the last page.
   */
  nextCursor: string | null;
  /** Rate metadata from the response that produced this page. */
  rate: TangoRateMetadata | null;
}

export interface TangoListOptions {
  /** Provider page size. The gateway clamps this. */
  limit?: number;
  /** From a previous page's `nextCursor`. */
  cursor?: string | null;
}

export interface TangoEntityListOptions extends TangoListOptions {
  uei?: string;
  naics?: string;
  state?: string;
}

/**
 * Filters, in Capiro's vocabulary.
 *
 * Deliberately a SUBSET of what the provider accepts, and named for what Capiro
 * means rather than for the provider's parameter. Every one of these maps to a
 * real query parameter in the SDK's `ListXOptions`; a filter with no provider
 * equivalent is absent here rather than silently ignored, which is what a
 * pass-through `[key: string]: unknown` bag would allow.
 */
export interface TangoOpportunityListOptions extends TangoListOptions {
  solicitationNumber?: string;
  naics?: string;
  psc?: string;
  /** Notices last touched on or after this ISO date. Drives incremental sync. */
  changedSince?: string;
  active?: boolean;
}

export interface TangoNoticeListOptions extends TangoListOptions {
  solicitationNumber?: string;
  naics?: string;
  psc?: string;
  /** Posted on or after this ISO date. */
  postedSince?: string;
  active?: boolean;
}

export interface TangoForecastListOptions extends TangoListOptions {
  /** Modified on or after this ISO date. The provider's incremental key. */
  changedSince?: string;
  fiscalYear?: number;
  naics?: string;
  agency?: string;
}

export interface TangoVehicleListOptions extends TangoListOptions {
  naics?: string;
  psc?: string;
  agency?: string;
  vehicleType?: string;
}

/**
 * The ONLY surface product code may use.
 *
 * ── Why an interface, and why this narrow ────────────────────────────────────
 *
 * The SDK exposes 100 methods across every dataset MakeGov sells. This exposes
 * the eight this program actually needs. A method not on this interface is a
 * capability Capiro has not decided to depend on, and adding one is a visible
 * change in a reviewed file rather than an import somebody wrote at 2am.
 *
 * It is also what makes the whole provider swappable and, more usefully,
 * FAKEABLE: every test in every later phase implements this interface with
 * checked-in fixtures instead of reaching for the SDK's own internals.
 *
 * ── Deliberately absent ──────────────────────────────────────────────────────
 *
 * No webhook write methods (P46 owns those, behind a separate secret). No MCP
 * (P39, research-only). No retry, no circuit breaker, no usage persistence —
 * those are P18, and putting them here would mean two places decide when to give
 * up. This adapter surfaces typed rate metadata and stops.
 */
export interface TangoGateway {
  /** Whether a key is configured. FALSE is a normal state, not a failure. */
  readonly configured: boolean;

  /** Rate metadata from the most recent response, or null before the first call. */
  readonly lastRate: TangoRateMetadata | null;

  /**
   * Version/health probe. The cheapest authenticated call there is, which is why
   * P17's capability probe leads with it.
   */
  getVersion(): Promise<Record<string, unknown>>;

  /** One entity by exact UEI. A 404 is explicit unresolved evidence, not an error to swallow. */
  getEntity(uei: string): Promise<TangoEntity | null>;
  listEntities(options?: TangoEntityListOptions): Promise<TangoPage<TangoEntity>>;

  listOpportunities(options?: TangoOpportunityListOptions): Promise<TangoPage<TangoOpportunity>>;
  listNotices(options?: TangoNoticeListOptions): Promise<TangoPage<TangoNotice>>;
  listForecasts(options?: TangoForecastListOptions): Promise<TangoPage<TangoForecast>>;
  listVehicles(options?: TangoVehicleListOptions): Promise<TangoPage<TangoVehicle>>;
  listVehicleAwardees(
    vehicleId: string,
    options?: TangoListOptions,
  ): Promise<TangoPage<TangoVehicleAwardee>>;
}

/** DI token. Product code injects the INTERFACE, never the implementation class. */
export const TANGO_GATEWAY = Symbol('TANGO_GATEWAY');

/**
 * DI token for the resilient wrapper (P18): retry, circuit breaker, request
 * ceiling, and usage recording around {@link TANGO_GATEWAY}. Implements the
 * SAME `TangoGateway` interface, so a consumer switching between the two
 * tokens changes nothing about how it calls the methods — only whether
 * calling them is protected. P19 and later sync/enrichment phases should
 * inject THIS token, not the raw one, unless they have a specific, documented
 * reason not to want that protection (see tango-resilience.service.ts's class
 * doc for why both tokens continue to exist side by side).
 */
export const TANGO_RESILIENT_GATEWAY = Symbol('TANGO_RESILIENT_GATEWAY');
