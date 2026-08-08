import { createHash } from 'node:crypto';
import type { TangoSubaward } from './tango-subaward.types.js';

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length ? trimmed : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function money(value: unknown): number | null {
  if (value == null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(String(value).replace(/[$,\s]/g, ''));
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: unknown): number | null {
  const parsed = money(value);
  return parsed == null ? null : Math.trunc(parsed);
}

function iso(value: unknown): string | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  const raw = text(value);
  if (!raw) return null;
  const candidate = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00.000Z` : raw;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function dateOnly(value: unknown): string | null {
  const normalized = iso(value);
  return normalized ? normalized.slice(0, 10) : null;
}

function exactUei(value: unknown): string | null {
  const normalized = (text(value) ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{12}$/.test(normalized) ? normalized : null;
}

function first(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = text(value);
    if (normalized != null) return normalized;
  }
  return null;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, child]) => [key, stable(child)]),
    );
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(stable(value));
}

/**
 * Map Tango's documented shaped subaward response.
 *
 * The endpoint nests money/date/description under `subaward_details`, source
 * modification time under `fsrs_details`, and identities under
 * `prime_recipient` / `subaward_recipient`. Compatibility aliases are retained
 * only for historical synthetic fixtures.
 */
export function mapTangoSubaward(
  raw: Record<string, unknown>,
  fetchedAt = new Date().toISOString(),
): TangoSubaward | null {
  const providerKey = first(raw.key, raw.subaward_key, raw.subawardKey, raw.id, raw.subaward_id);
  if (!providerKey) return null;

  const details = record(raw.subaward_details ?? raw.subawardDetails);
  const fsrs = record(raw.fsrs_details ?? raw.fsrsDetails);
  const prime = record(raw.prime_recipient ?? raw.primeRecipient ?? raw.prime_award_recipient);
  const recipient = record(
    raw.subaward_recipient ?? raw.subawardRecipient ?? raw.recipient ?? raw.subawardee,
  );
  const awarding = record(raw.awarding_office ?? raw.awardingOffice);
  const funding = record(raw.funding_office ?? raw.fundingOffice);
  const pop = record(raw.place_of_performance ?? raw.placeOfPerformance ?? raw.pop);
  const naics = record(raw.naics);

  const actionDate = dateOnly(
    details.action_date ?? details.actionDate ?? raw.action_date ?? raw.actionDate,
  );
  const fiscalYear =
    integer(details.fiscal_year ?? details.fiscalYear ?? raw.fiscal_year ?? raw.fiscalYear) ??
    (actionDate ? new Date(`${actionDate}T00:00:00.000Z`).getUTCFullYear() : null);

  // Tango's documented subaward place-of-performance shape contains city,
  // state, zip and country_code — not a congressional district. Preserve a
  // district only if a future/source-specific payload explicitly supplies one;
  // never derive it from ZIP or the prime award's geography here.
  const placeOfPerformance = {
    country: first(pop.country_code, pop.country, raw.pop_country),
    state: first(pop.state, pop.state_code, raw.pop_state)?.toUpperCase() ?? null,
    city: first(pop.city, pop.city_name, raw.pop_city),
    zip: first(pop.zip, pop.zip_code, pop.postal_code, raw.pop_zip),
    congressionalDistrict: first(
      pop.congressional_district,
      pop.congressional_code,
      pop.district,
      raw.pop_congressional_district,
    ),
  };

  const normalized: Record<string, unknown> = {
    providerKey,
    awardKey: first(raw.award_key, raw.awardKey),
    primeAwardKey: first(raw.prime_award_key, raw.primeAwardKey),
    piid: first(raw.piid, raw.prime_award_piid),
    subawardNumber: first(details.number, raw.subaward_number, raw.subawardNumber),
    subawardType: first(details.type, raw.subaward_type, raw.subawardType),
    subawardAmount: money(details.amount ?? raw.subaward_amount ?? raw.amount),
    actionDate,
    fiscalYear,
    description: first(details.description, raw.description, raw.subaward_description),
    naicsCode: first(raw.naics_code, raw.naicsCode, naics.code),
    primeRecipientUei: exactUei(prime.uei ?? prime.unique_entity_id ?? raw.prime_recipient_uei),
    primeRecipientName: first(
      prime.display_name,
      prime.recipient_name,
      prime.legal_business_name,
      prime.name,
      raw.prime_recipient_name,
    ),
    primeParentUei: exactUei(
      prime.parent_uei ?? prime.parent_unique_entity_id ?? raw.prime_parent_uei,
    ),
    primeParentName: first(prime.parent_name, raw.prime_parent_name),
    subawardeeUei: exactUei(recipient.uei ?? recipient.unique_entity_id ?? raw.subawardee_uei),
    subawardeeName: first(
      recipient.display_name,
      recipient.recipient_name,
      recipient.legal_business_name,
      recipient.name,
      raw.subawardee_name,
    ),
    subawardeeParentUei: exactUei(
      recipient.parent_uei ?? recipient.parent_unique_entity_id ?? raw.subawardee_parent_uei,
    ),
    subawardeeParentName: first(recipient.parent_name, raw.subawardee_parent_name),
    awardingAgency: first(
      awarding.agency_name,
      awarding.department_name,
      raw.awarding_agency_name,
      raw.awarding_agency,
    ),
    awardingOffice: first(awarding.office_name, awarding.name, raw.awarding_office_name),
    fundingAgency: first(
      funding.agency_name,
      funding.department_name,
      raw.funding_agency_name,
      raw.funding_agency,
    ),
    fundingOffice: first(funding.office_name, funding.name, raw.funding_office_name),
    placeOfPerformance: Object.values(placeOfPerformance).some((value) => value != null)
      ? placeOfPerformance
      : null,
    sourceUrl: first(raw.usaspending_permalink, raw.source_url, raw.sourceUrl),
    providerModifiedAt: iso(
      fsrs.last_modified_date ??
        fsrs.lastModifiedDate ??
        raw.modified ??
        raw.modified_at ??
        raw.last_modified ??
        raw.updated_at,
    ),
  };

  // `fetchedAt` is observation metadata, not source content. Hashing it would
  // make every identical sync look like a source change.
  const contentSha256 = createHash('sha256').update(canonicalJson(normalized)).digest('hex');
  return {
    ...(normalized as Omit<TangoSubaward, 'fetchedAt' | 'contentSha256' | 'normalized'>),
    fetchedAt,
    contentSha256,
    normalized,
  };
}
