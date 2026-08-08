import { allowedKeys, type TangoShapeName } from './tango.shapes.js';
import type {
  TangoAddress,
  TangoEntity,
  TangoForecast,
  TangoNotice,
  TangoOpportunity,
  TangoProvenance,
  TangoResourceType,
  TangoVehicle,
  TangoVehicleAwardee,
  TangoWebhookAlert,
  TangoWebhookEndpoint,
} from './tango.types.js';

/**
 * Provider record → Capiro domain object.
 *
 * ── The one rule ─────────────────────────────────────────────────────────────
 *
 * A field that was not requested cannot appear in the output. Every mapper reads
 * through {@link pick}, which allow-lists against the same field list the shape
 * was built from — so a provider adding `risk_score` next month does not become a
 * Capiro fact because somebody spread the raw record somewhere.
 *
 * That also means the failure mode of a provider RENAME is a null at the
 * boundary, not an `undefined` three services deep.
 *
 * ── Normalisation, and what it refuses to do ─────────────────────────────────
 *
 * Dates become ISO-8601 or null. Money becomes a number or null. Absence — an
 * omitted key, an explicit `null`, or an empty string — becomes `null`, one
 * absence for a consumer to check.
 *
 * What normalisation must NOT do is invent. An unparseable date is null, not
 * today. A missing figure is null, NEVER 0 — the whole surface exists to keep
 * "the source stated nothing" distinct from "the source stated zero".
 */

/**
 * Allow-list a raw record down to the fields its shape actually requested.
 *
 * Keyed on the TOP-LEVEL key of each selector, so `office(agency,code,name)`
 * admits the `office` object — otherwise every nested selection would be dropped
 * as unrequested.
 */
export function pick(
  raw: Record<string, unknown>,
  shapeName: TangoShapeName,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of allowedKeys(shapeName)) {
    if (Object.hasOwn(raw, key)) out[key] = raw[key];
  }
  return out;
}

/** The fields a raw record carries that its shape never asked for. Diagnostics only. */
export function unexpectedFields(
  raw: Record<string, unknown>,
  shapeName: TangoShapeName,
): string[] {
  const allowed = new Set(allowedKeys(shapeName));
  return Object.keys(raw).filter((k) => !allowed.has(k));
}

/** `''`, `null` and `undefined` all collapse to null. Everything else is trimmed text. */
export function str(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

/**
 * A number, or null.
 *
 * A numeric STRING is accepted — the provider sends decimals as strings on some
 * endpoints — but an unparseable one is null rather than NaN, and NaN itself is
 * null. `0` survives as `0`: a stated zero is a fact.
 */
export function num(value: unknown): number | null {
  if (value == null || value === '') return null;
  const n = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : null;
}

/** An integer, or null. Used for counts and fiscal years. */
export function int(value: unknown): number | null {
  const n = num(value);
  if (n == null) return null;
  return Number.isInteger(n) ? n : Math.trunc(n);
}

/** A real boolean, or null. A missing flag is UNKNOWN, never false. */
export function bool(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'True' || value === 1 || value === '1') return true;
  if (value === 'false' || value === 'False' || value === 0 || value === '0') return false;
  return null;
}

/**
 * ISO-8601, or null.
 *
 * Accepts the date-only and full-timestamp forms the provider mixes. A date-only
 * value is anchored at UTC midnight rather than local midnight — otherwise the
 * same forecast reads as a different day depending on where the job ran.
 */
export function iso(value: unknown): string | null {
  // The SDK parses every field its schema types as `date`/`datetime` into a real
  // Date before the adapter sees it, so this arrives as an object roughly half the
  // time. Without this branch `str()` returns null for those and the field
  // silently disappears — which is how `last_update_date` went missing on the
  // first run of this adapter.
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  }
  const raw = str(value);
  if (raw == null) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const time = Date.parse(candidate);
  if (!Number.isFinite(time)) return null;
  return new Date(time).toISOString();
}

/** A string array, from an array, a comma-separated string, or nothing. */
export function strList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => str(v)).filter((v): v is string => v != null);
  }
  const single = str(value);
  if (single == null) return [];
  return single
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

/**
 * An address, from either the flat SAM-style block (entities) or the provider's
 * `PlaceOfPerformance` model (`city_name` / `state_code` / …).
 */
function address(value: unknown): TangoAddress | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const a = value as Record<string, unknown>;
  const out: TangoAddress = {
    line1: str(a.address_line_1 ?? a.addressLine1 ?? a.line1 ?? a.street_address),
    city: str(a.city ?? a.city_name),
    state: str(a.state ?? a.state_code),
    postalCode: str(a.zip ?? a.zip_code ?? a.postal_code),
    countryCode: str(a.country ?? a.country_code),
  };
  // An address whose every field is absent is an ABSENT address, not an empty one.
  return Object.values(out).some((v) => v != null) ? out : null;
}

/**
 * A code list, from the several forms the provider uses.
 *
 * `naics_codes`, `psc_codes`, `business_types` and `sba_business_types` are all
 * typed `dict` in the SDK schema, which in practice means an array of
 * code/description objects on some endpoints and a plain array of strings on
 * others. Both flatten to codes; anything else is an empty list rather than a
 * stringified object landing in a column.
 */
function codeList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          return str(o.code ?? o.naics_code ?? o.psc_code ?? o.value ?? o.name);
        }
        return str(item);
      })
      .filter((v): v is string => v != null);
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const single = str(o.code ?? o.value ?? o.name);
    return single ? [single] : [];
  }
  return strList(value);
}

/**
 * A code/description list where the DESCRIPTION is the useful value.
 *
 * Business types and SBA socio-economic types go through this rather than
 * {@link codeList}, and the difference is not cosmetic:
 *
 *   NAICS and PSC codes are IDENTIFIERS. Matching happens on them, an operator
 *   filters by them, and "336412" is the fact — the description is a label.
 *
 *   A business type is a CLAIM A HUMAN REVIEWS. "27" is unreadable; "Small
 *   Disadvantaged Business" is the thing an admin accepts or rejects in P20's
 *   enrichment workflow, and the thing that must never be silently promoted into
 *   Capiro's reviewed set-aside certifications.
 *
 * Falls back to the code when the provider sends no description, because an
 * opaque value is still better than dropping the type entirely.
 */
function descriptionList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (item && typeof item === 'object') {
          const o = item as Record<string, unknown>;
          return str(o.description ?? o.desc ?? o.name ?? o.code ?? o.value);
        }
        return str(item);
      })
      .filter((v): v is string => v != null);
  }
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    const single = str(o.description ?? o.desc ?? o.name ?? o.code);
    return single ? [single] : [];
  }
  return strList(value);
}

/**
 * A field the provider models as code-plus-description but sometimes sends flat.
 * Prefers the DESCRIPTION, because that is what a human reads on a card.
 */
function codeDescription(value: unknown): string | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    return str(o.description ?? o.desc ?? o.name ?? o.code);
  }
  return str(value);
}

function provenance(
  resourceType: TangoResourceType,
  externalId: string,
  providerUpdatedAt: string | null,
  fetchedAt: string,
): TangoProvenance {
  return { provider: 'tango', resourceType, externalId, fetchedAt, providerUpdatedAt };
}

export function mapEntity(raw: Record<string, unknown>, fetchedAt: string): TangoEntity | null {
  const picked = pick(raw, 'entity');
  const uei = str(picked.uei);
  // No UEI, no entity. The whole point of the entity rail is exact-identifier
  // matching; a record we cannot key is not evidence, it is noise.
  if (uei == null) return null;
  return {
    provenance: provenance('entity', uei, iso(picked.last_update_date), fetchedAt),
    uei,
    cageCode: str(picked.cage_code),
    legalBusinessName: str(picked.legal_business_name),
    dbaName: str(picked.dba_name),
    businessTypes: descriptionList(picked.business_types),
    sbaBusinessTypes: descriptionList(picked.sba_business_types),
    naicsCodes: codeList(picked.naics_codes),
    pscCodes: codeList(picked.psc_codes),
    primaryNaics: str(picked.primary_naics),
    registrationStatus: str(picked.registration_status),
    // The provider calls this the SAM registration expiry. Named for what it is,
    // not for what a later phase might want it to mean.
    samExpirationDate: iso(picked.sam_expiration_date),
    physicalAddress: address(picked.physical_address),
    // Always null: neither this SDK's own field name nor the live server's
    // current one round-trips end-to-end through @makegov/tango-node@1.1.0 —
    // a genuine SDK-vs-server incompatibility, not an absent value to
    // recover with a fallback. See ENTITY_FIELDS's doc (P19, decision-log
    // D-35) before assuming this is fixable with a different field name.
    entityStructure: null,
    stateOfIncorporation: null,
  };
}

export function mapOpportunity(
  raw: Record<string, unknown>,
  fetchedAt: string,
): TangoOpportunity | null {
  const picked = pick(raw, 'opportunity');
  const opportunityId = str(picked.opportunity_id);
  if (opportunityId == null) return null;
  const office =
    picked.office && typeof picked.office === 'object' && !Array.isArray(picked.office)
      ? (picked.office as Record<string, unknown>)
      : {};
  return {
    // `last_notice_date` is the closest thing the provider has to a modified
    // stamp on an opportunity; there is no `updated_at` on this model.
    provenance: provenance('opportunity', opportunityId, iso(picked.last_notice_date), fetchedAt),
    opportunityId,
    solicitationNumber: str(picked.solicitation_number),
    title: str(picked.title),
    // The provider carries no notice TYPE on an opportunity — that lives on the
    // individual notices — so there is deliberately no field for it here.
    firstNoticeDate: iso(picked.first_notice_date),
    lastNoticeDate: iso(picked.last_notice_date),
    responseDeadline: iso(picked.response_deadline),
    active: bool(picked.active),
    setAside: codeDescription(picked.set_aside),
    naicsCode: str(picked.naics_code),
    pscCode: str(picked.psc_code),
    sourceUrl: str(picked.sam_url),
    agency: str(office.agency),
    officeCode: str(office.code),
    officeName: str(office.name),
  };
}

export function mapNotice(raw: Record<string, unknown>, fetchedAt: string): TangoNotice | null {
  const picked = pick(raw, 'notice');
  const noticeId = str(picked.notice_id);
  if (noticeId == null) return null;
  return {
    provenance: provenance('notice', noticeId, iso(picked.last_updated), fetchedAt),
    noticeId,
    solicitationNumber: str(picked.solicitation_number),
    title: str(picked.title),
    description: str(picked.description),
    postedDate: iso(picked.posted_date),
    responseDeadline: iso(picked.response_deadline),
    active: bool(picked.active),
    setAside: codeDescription(picked.set_aside),
    naicsCode: str(picked.naics_code),
    pscCode: str(picked.psc_code),
    attachmentCount: int(picked.attachment_count),
    sourceUrl: str(picked.sam_url),
  };
}

/** `organization(agency_code,agency_name,department_code,department_name,office_code,office_name,organization_id)`. Every level independently nullable — see TangoForecast's own doc. */
function forecastOrganization(value: unknown): {
  departmentCode: string | null;
  departmentName: string | null;
  organizationAgencyCode: string | null;
  organizationAgencyName: string | null;
  officeCode: string | null;
  officeName: string | null;
  organizationId: string | null;
} {
  const o =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return {
    departmentCode: str(o.department_code),
    departmentName: str(o.department_name),
    organizationAgencyCode: str(o.agency_code),
    organizationAgencyName: str(o.agency_name),
    officeCode: str(o.office_code),
    officeName: str(o.office_name),
    organizationId: str(o.organization_id),
  };
}

/** Structured on the live server despite the SDK typing this field as a plain string — see TangoForecastContact's own doc. */
function forecastContact(value: unknown): TangoForecast['primaryContact'] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const o = value as Record<string, unknown>;
  return { name: str(o.name), email: str(o.email), phone: str(o.phone), title: str(o.title) };
}

export function mapForecast(raw: Record<string, unknown>, fetchedAt: string): TangoForecast | null {
  const picked = pick(raw, 'forecast');
  const forecastId = str(picked.id);
  if (forecastId == null) return null;
  const org = forecastOrganization(picked.organization);
  return {
    // `modified` is real (D-45) — the live server's own last-touched stamp,
    // requested via the raw-HTTP bypass tango.client.ts's listForecasts uses.
    // This is NOT the SDK's typed materialization, so there is no client-side
    // schema to fight here.
    provenance: provenance('forecast', forecastId, iso(picked.modified), fetchedAt),
    forecastId,
    externalId: str(picked.external_id),
    title: str(picked.title),
    description: str(picked.description),
    agency: str(picked.agency),
    ...org,
    anticipatedAwardDate: iso(picked.anticipated_award_date),
    estimatedPeriod: str(picked.estimated_period),
    fiscalYear: int(picked.fiscal_year),
    naicsCode: str(picked.naics_code),
    // Confirmed absent from this resource's own available_fields (D-45) —
    // not a naming guess, not an oversight. See TangoForecast's own doc.
    pscCode: null,
    setAside: codeDescription(picked.set_aside),
    contractVehicle: str(picked.contract_vehicle),
    // A STRING on this model, not a structured address.
    placeOfPerformance: str(picked.place_of_performance),
    primaryContact: forecastContact(picked.primary_contact),
    status: str(picked.status),
    isActive: bool(picked.is_active),
    sourceSystem: str(picked.source_system),
    // Confirmed absent from this resource's own available_fields (D-45).
    sourceUrl: null,
  };
}

export function mapVehicle(raw: Record<string, unknown>, fetchedAt: string): TangoVehicle | null {
  const picked = pick(raw, 'vehicle');
  const vehicleId = str(picked.uuid);
  if (vehicleId == null) return null;
  return {
    provenance: provenance('vehicle', vehicleId, null, fetchedAt),
    vehicleId,
    programAcronym: str(picked.program_acronym),
    solicitationTitle: str(picked.solicitation_title),
    solicitationIdentifier: str(picked.solicitation_identifier),
    vehicleType: codeDescription(picked.vehicle_type),
    agencyId: str(picked.agency_id),
    organizationId: str(picked.organization_id),
    naicsCode: str(picked.naics_code),
    pscCode: str(picked.psc_code),
    setAside: codeDescription(picked.set_aside),
    whoCanUse: codeDescription(picked.who_can_use),
    awardDate: iso(picked.award_date),
    lastDateToOrder: iso(picked.last_date_to_order),
    idvCount: int(picked.idv_count),
    awardeeCount: int(picked.awardee_count),
    orderCount: int(picked.order_count),
    // PROVIDER-LABELLED money. Never combined with an opportunity value, and null
    // when the provider states nothing — never 0.
    totalObligated: num(picked.total_obligated),
  };
}

export function mapVehicleAwardee(
  raw: Record<string, unknown>,
  fetchedAt: string,
): TangoVehicleAwardee | null {
  const picked = pick(raw, 'vehicleAwardee');
  const awardeeId = str(picked.uuid) ?? str(picked.key);
  if (awardeeId == null) return null;
  const recipient =
    picked.recipient && typeof picked.recipient === 'object' && !Array.isArray(picked.recipient)
      ? (picked.recipient as Record<string, unknown>)
      : {};
  return {
    provenance: provenance('vehicle_awardee', awardeeId, null, fetchedAt),
    awardeeId,
    contractKey: str(picked.key),
    piid: str(picked.piid),
    title: str(picked.title),
    awardDate: iso(picked.award_date),
    orderCount: int(picked.order_count),
    idvObligations: num(picked.idv_obligations),
    idvContractsValue: num(picked.idv_contracts_value),
    // A UEI is what makes direct access PROVABLE. A display name is not an
    // identifier, and matching on one is the fuzzy identity P02 removed from the
    // award-history rail.
    recipientUei: str(recipient.uei),
    // Always null: this endpoint's `recipient` expansion has no parent/owner
    // UEI field at all (confirmed live, P22, decision-log D-41) — not an
    // absent value to recover with a fallback. See VEHICLE_AWARDEE_FIELDS's
    // own doc before assuming a different field name fixes this.
    recipientParentUei: null,
    recipientName: str(recipient.display_name ?? recipient.legal_business_name),
  };
}

// ── Webhook subscription management (P47) ────────────────────────────────────

/**
 * Coerce a provider list response into an array.
 *
 * The webhook endpoints differ from the dataset endpoints: some return a bare
 * array and some wrap it in `{results: [...]}`. Neither shape is documented as
 * stable, so this accepts both rather than picking one and breaking the moment
 * the provider changes it. Anything else — null, an object with neither shape —
 * becomes an EMPTY list, never a crash: "the provider told us about no
 * endpoints" is a survivable answer for a reconciler whose default mode is to
 * print a diff.
 */
export function asArray(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) return raw as Record<string, unknown>[];
  if (raw && typeof raw === 'object') {
    const results = (raw as { results?: unknown }).results;
    if (Array.isArray(results)) return results as Record<string, unknown>[];
  }
  return [];
}

/**
 * One delivery endpoint.
 *
 * `secret` is carried through ONLY because a create response is the one and
 * only time the provider ever discloses it. It is never logged, never printed,
 * and never written to the reconciler's stdout — see the CLI's own handling.
 */
export function mapWebhookEndpoint(raw: Record<string, unknown>): TangoWebhookEndpoint {
  const secret = str(raw.secret);
  return {
    id: str(raw.id) ?? '',
    name: str(raw.name) ?? '',
    callbackUrl: str(raw.callback_url) ?? '',
    // Absent is treated as INACTIVE, not active. A reconciler that assumes an
    // endpoint of unknown state is live would report "already configured" and
    // skip the very work it exists to do.
    isActive: bool(raw.is_active) ?? false,
    ...(secret === null ? {} : { secret }),
  };
}

/**
 * One filter subscription.
 *
 * `status` is narrowed to the two values the provider documents. Anything else
 * is recorded as 'paused' — the conservative reading, because treating an
 * unrecognized status as 'active' would let the reconciler believe delivery is
 * happening when it may not be.
 */
export function mapWebhookAlert(raw: Record<string, unknown>): TangoWebhookAlert {
  return {
    alertId: str(raw.alert_id) ?? str(raw.id) ?? '',
    name: str(raw.name) ?? '',
    queryType: str(raw.query_type) ?? '',
    filters:
      raw.filters && typeof raw.filters === 'object' && !Array.isArray(raw.filters)
        ? (raw.filters as Record<string, unknown>)
        : {},
    frequency: str(raw.frequency) ?? '',
    status: str(raw.status) === 'active' ? 'active' : 'paused',
  };
}
