export const FEDERAL_AWARD_DATE_SEMANTICS =
  'baseAwardSignedDate is the original award signing date; latestActionDate is the latest transaction action; sourceLastModifiedDate is the source record update; popStartDate and popEndDate are the performance period; capiroSyncedAt is when Capiro fetched the record; unknown dates stay null.';

export interface FederalAwardDateSource {
  latestActionDate?: Date | string | null;
  baseAwardSignedDate?: Date | string | null;
  sourceLastModifiedDate?: Date | string | null;
  popStartDate?: Date | string | null;
  popEndDate?: Date | string | null;
  lastSyncedAt?: Date | string | null;
  sourceUpdatedAt?: Date | string | null;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function federalAwardDates(source: FederalAwardDateSource) {
  return {
    latestActionDate: iso(source.latestActionDate),
    baseAwardSignedDate: iso(source.baseAwardSignedDate),
    sourceLastModifiedDate: iso(source.sourceLastModifiedDate),
    popStartDate: iso(source.popStartDate),
    popEndDate: iso(source.popEndDate),
    capiroSyncedAt: iso(source.lastSyncedAt ?? source.sourceUpdatedAt),
    semantics: FEDERAL_AWARD_DATE_SEMANTICS,
  };
}

export function serializeFederalAwardDates<T extends FederalAwardDateSource>(
  row: T,
  enforce: boolean,
): T | (T & { dates: ReturnType<typeof federalAwardDates> }) {
  return enforce ? { ...row, dates: federalAwardDates(row) } : row;
}
