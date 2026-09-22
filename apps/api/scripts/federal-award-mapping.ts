export interface ContractAwardRecord extends Record<string, unknown> {
  generated_internal_id?: string;
  internal_id?: number | string;
  'Award ID'?: string | null;
  'Recipient Name'?: string | null;
  'Recipient UEI'?: string | null;
  'Award Amount'?: number | string | null;
  Description?: string | null;
  'Awarding Agency'?: string | null;
  'Awarding Sub Agency'?: string | null;
  'Action Date'?: string | null;
  'Start Date'?: string | null;
  'End Date'?: string | null;
  'Base Obligation Date'?: string | null;
  'Last Modified Date'?: string | null;
  'Place of Performance State Code'?: string | null;
  'Place of Performance Congressional District'?: string | null;
  'Recipient Location State Code'?: string | null;
  'Recipient Location Congressional District'?: string | null;
}

/** Normalize USAspending Recipient UEI for storage / tier-1 matching. */
export function parseRecipientUei(raw: unknown): string | null {
  const value = String(raw ?? '')
    .trim()
    .toUpperCase();
  return /^[A-Z0-9]{12}$/.test(value) ? value : null;
}

function dateOrNull(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

/** Pure mapping from a verbatim USAspending search record to FederalAward data. */
export function mapContractAwardRecord(record: ContractAwardRecord, nowIso: string) {
  const legacyActionDate = record['Action Date'] ?? record['Last Modified Date'] ?? null;
  const legacyRecord = {
    generatedInternalId: String(record.generated_internal_id ?? record.internal_id ?? ''),
    piid: record['Award ID'] ?? null,
    fain: null,
    recipientName: record['Recipient Name'] ?? null,
    recipientUei: parseRecipientUei(record['Recipient UEI']),
    amount: record['Award Amount'] != null ? Number(record['Award Amount']) : null,
    description: record.Description ?? null,
    awardingAgency: record['Awarding Agency'] ?? null,
    awardingSubTier: record['Awarding Sub Agency'] ?? null,
    actionDate: legacyActionDate,
    popState: record['Place of Performance State Code'] ?? null,
    popCongressionalDistrict: record['Place of Performance Congressional District'] ?? null,
    recipientState: record['Recipient Location State Code'] ?? null,
    recipientCongressionalDistrict: record['Recipient Location Congressional District'] ?? null,
  };

  return {
    awardUniqueId: legacyRecord.generatedInternalId,
    piid: legacyRecord.piid,
    fain: legacyRecord.fain,
    awardingAgency: legacyRecord.awardingAgency,
    awardingSubTier: legacyRecord.awardingSubTier,
    contractorName: legacyRecord.recipientName,
    recipientUei: legacyRecord.recipientUei,
    amount: legacyRecord.amount,
    description: legacyRecord.description,
    popState: legacyRecord.popState,
    popCongressionalDistrict: legacyRecord.popCongressionalDistrict,
    recipientState: legacyRecord.recipientState,
    recipientCongressionalDistrict: legacyRecord.recipientCongressionalDistrict,
    // Legacy-mispopulated columns intentionally retain the old Last Modified fallback.
    // Consumers move to the distinct fields below in docs/meri/grounding/stage-0/0b-award-dates.md.
    actionDate: dateOrNull(legacyRecord.actionDate),
    awardedAt: dateOrNull(legacyRecord.actionDate),
    raw: legacyRecord,
    baseAwardSignedDate: dateOrNull(record['Base Obligation Date']),
    latestActionDate: dateOrNull(record['Action Date']),
    sourceLastModifiedDate: dateOrNull(record['Last Modified Date']),
    popStartDate: dateOrNull(record['Start Date']),
    popEndDate: dateOrNull(record['End Date']),
    dateSemanticsVersion: 1,
    // JSON round-trip produces Prisma-compatible JSON while retaining the API
    // payload's keys and values verbatim (and avoids sharing a mutable reference).
    sourceRecord: JSON.parse(JSON.stringify(record)),
    lastSyncedAt: new Date(nowIso),
  };
}