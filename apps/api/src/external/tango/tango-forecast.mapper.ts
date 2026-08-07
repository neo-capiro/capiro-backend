import type { Prisma } from '@prisma/client';
import type { TangoForecast } from './tango.types.js';

/**
 * Maps a normalized `TangoForecast` (`tango.mappers.ts`'s `mapForecast`) to
 * the row `tango_procurement_forecast` (P24) persists.
 *
 * A SEPARATE, second mapping step from `mapForecast` — that step turns raw
 * provider JSON into Capiro's typed domain object and answers "what did the
 * provider actually say"; this one turns that domain object into a database
 * row and answers "what does this table need to store it". Kept as two
 * steps, and two files, because a raw-provider quirk (an unexpected field
 * shape, a materialization gap) is `mapForecast`'s problem, and a
 * persistence decision (which columns exist, what NOT NULL means here) is
 * this file's — conflating them would mean every future provider quirk
 * risks touching storage code, and vice versa.
 *
 * ── Why this can return null ──────────────────────────────────────────────
 *
 * `title` is NOT NULL on the table but nullable on `TangoForecast` (the
 * provider's own schema states it as required, and `mapForecast`'s `str()`
 * helper nulls out anything empty/whitespace defensively, same as every
 * other string field — so "provider genuinely sent no title" is possible in
 * principle even though it should not happen for a well-formed record). A
 * forecast with no title is DROPPED here, not written with an invented
 * placeholder — the same "a record with no usable identity is dropped and
 * counted, never half-mapped" posture `tango.client.ts`'s own `page()`
 * helper already takes for a missing external id.
 */
export type TangoForecastRow = Omit<
  Prisma.TangoProcurementForecastCreateInput,
  'id' | 'firstSyncedAt' | 'lastSyncedAt' | 'createdAt' | 'updatedAt'
>;

export function toForecastRow(forecast: TangoForecast): TangoForecastRow | null {
  if (forecast.title == null) return null;

  return {
    tangoForecastId: forecast.forecastId,
    externalId: forecast.externalId,
    title: forecast.title,
    description: forecast.description,
    agency: forecast.agency,
    departmentCode: forecast.departmentCode,
    departmentName: forecast.departmentName,
    organizationAgencyCode: forecast.organizationAgencyCode,
    organizationAgencyName: forecast.organizationAgencyName,
    officeCode: forecast.officeCode,
    officeName: forecast.officeName,
    organizationId: forecast.organizationId,
    // DATE, not TIMESTAMPTZ — the provider states a calendar date, never a
    // time of day, for this field. `new Date(iso)` at UTC midnight (per
    // `iso()`'s own date-only anchoring) round-trips through Prisma's `Date`
    // column correctly without a timezone shift.
    anticipatedAwardDate: forecast.anticipatedAwardDate ? new Date(forecast.anticipatedAwardDate) : null,
    estimatedPeriod: forecast.estimatedPeriod,
    fiscalYear: forecast.fiscalYear,
    naicsCode: forecast.naicsCode,
    // ALWAYS NULL — see TangoForecast's own doc (decision-log D-45).
    pscCode: forecast.pscCode,
    setAside: forecast.setAside,
    contractVehicle: forecast.contractVehicle,
    placeOfPerformance: forecast.placeOfPerformance,
    primaryContactName: forecast.primaryContact?.name ?? null,
    primaryContactEmail: forecast.primaryContact?.email ?? null,
    primaryContactPhone: forecast.primaryContact?.phone ?? null,
    primaryContactTitle: forecast.primaryContact?.title ?? null,
    status: forecast.status,
    isActive: forecast.isActive,
    sourceSystem: forecast.sourceSystem,
    // ALWAYS NULL — see TangoForecast's own doc (decision-log D-45).
    sourceUrl: forecast.sourceUrl,
    providerModifiedAt: forecast.provenance.providerUpdatedAt
      ? new Date(forecast.provenance.providerUpdatedAt)
      : null,
    // The full normalized domain object, not the raw provider JSON — so a
    // reader of this column sees exactly what Capiro's own mapper decided
    // the record means (organization flattened, contact structured, the two
    // confirmed-absent fields explicit), not a second, differently-shaped
    // copy of the wire payload to reconcile against the columns above.
    snapshot: forecast as unknown as Prisma.InputJsonValue,
  };
}
