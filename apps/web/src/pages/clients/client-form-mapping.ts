/**
 * UI-free client-form domain logic: the wizard's step structure and the
 * form ⇄ payload mapping.
 *
 * Extracted from `ClientFormModal.tsx` so the canonical (antd) wizard and the
 * vNext wizard (`vnext/pages/client-crm/ClientFormDialogVNext.tsx`) share ONE
 * definition of what the form collects and how it round-trips through
 * `Client.intakeData` — without vNext taking a runtime path into an
 * antd-carrying module. Behavior is unchanged; the functions moved verbatim.
 */
import { normalizeSector } from '@capiro/shared';
import type { Client, ClientFormValues, ClientPayload } from './clientTypes.js';

// The 3 wizard steps (post cleanup — see docs/plans note below). Logo lives
// below the steps and is NOT part of the company-info field set — it's a
// separate wired upload feature.
//
// Removed 2026-08-23 (client profile wizard cleanup, user-directed):
//  - Step 1 "Documents" upload — real feature (S3 presign/confirm), but it
//    duplicates the dedicated Files tab; dropped from the wizard only.
//  - Step 1 "DBA / trade name" — `dba` had exactly one downstream reader
//    (news-catcher alias matching); `name` (Legal name) is the field every
//    other surface keys off. Kept `name`, dropped `dba`.
//  - Step 1 address (city/state/country/address1/zip) — no consumer;
//    District Nexus geographic relevance reads Facility.state via
//    facilityStates, not these intakeData fields. Configure addresses under
//    the client's Facilities editor instead.
//  - Former step 2 "Contact & Social" (primaryContactEmail/Phone) — folded
//    into step 1 as a single "Company contact" block rather than removed:
//    these ARE wired (Outreach recipient fallback, Meri, admin client list)
//    and are NOT the same data as the Relationships/Organization people
//    roster, which has no "primary contact" concept today.
//  - Step 3 duplicate NAICS — `primaryNaics`/`additionalNaics` free-text
//    pair dropped; `naicsCodes[]` (the first-class column the PE-relevance
//    engine reads) is the functional one and is kept.
// NOT removed — flagged for follow-up, see plan doc:
//  - `ldaRegistrantName` stays single-value for now. Carrying the name over
//    from the firm's LDA import and supporting multiple linked registrant
//    names is a real schema change (needs a list/table, not a field tweak).
//  - Step 4 (Sector & Tracks) kept in full — every field there is wired
//    (sectorTag, insight generator, LDA issue-code matching, client-since
//    date) except `internalNotes`, which is captured but never displayed
//    anywhere; flagged as a gap rather than silently dropped.
export const CLIENT_FORM_STEP_TITLES = ['Company Info', "Gov't Registration", 'Sector & Tracks'] as const;

// Field names owned by each step, used to scope per-step validation so Next
// only validates the fields the user has actually seen.
export const CLIENT_FORM_STEP_FIELDS: Array<Array<keyof ClientFormValues>> = [
  [
    'name',
    'website',
    'description',
    'primaryContactEmail',
    'primaryContactPhone',
    'sbSb',
    'sbWosb',
    'sbSdvosb',
    'sbHubzone',
    'sbEightA',
    'sbLarge',
    'sbForeignOwned',
  ],
  [
    'cageCode',
    'uei',
    'samStatus',
    'samExpirationDate',
    'ldaRegistrantName',
    'ein',
    'naicsCodes',
    'pscCodes',
    'applicantTypes',
    'setAsideCertifications',
  ],
  [
    'sectors',
    'submissionTracks',
    'issueCodes',
    'engagementStartDate',
    'primaryContactName',
    'internalNotes',
  ],
];

export const SAM_STATUS_OPTIONS = [
  { label: 'Active', value: 'Active' },
  { label: 'Expired', value: 'Expired' },
  { label: 'Not registered', value: 'Not registered' },
  { label: 'Pending', value: 'Pending' },
];

/* ── Form ⇄ payload mapping ──────────────────────────────────────────────── */

export function formValuesToClientPayload(
  values: ClientFormValues,
  existing?: Client,
): ClientPayload {
  // Small Business Classification: store only the flags that are checked.
  const sbClassification = compactBooleans({
    sb: values.sbSb,
    wosb: values.sbWosb,
    sdvosb: values.sbSdvosb,
    hubzone: values.sbHubzone,
    eightA: values.sbEightA,
    large: values.sbLarge,
    foreignOwned: values.sbForeignOwned,
  });

  // Sectors multi-select stores the full list; the FIRST selected sector is
  // mirrored to the top-level controlled Client.sectorTag so the wired
  // intelligence engine keeps working.
  const sectors = Array.isArray(values.sectors) ? values.sectors.filter(Boolean) : [];
  const primarySector = sectors[0];

  // The wizard-owned intakeData keys. Compute their new values; an undefined
  // value means "clear this key". Everything NOT in this set (peNumber,
  // profileNotes, governmentHistory, documents, dba, address fields,
  // primaryNaics/additionalNaics — all removed from the wizard 2026-08-23,
  // see CLIENT_FORM_STEP_FIELDS comment — plus anything else unrendered) is
  // preserved from the existing blob below so editing through the wizard
  // never wipes data written by an older wizard version or another surface.
  const wizardIntake: Record<string, unknown> = {
    sbClassification: Object.keys(sbClassification).length ? sbClassification : undefined,
    cageCode: optionalText(values.cageCode)?.toUpperCase(),
    uei: optionalText(values.uei)?.toUpperCase(),
    samStatus: optionalText(values.samStatus),
    samExpirationDate: optionalText(values.samExpirationDate),
    ldaRegistrantName: optionalText(values.ldaRegistrantName),
    ein: optionalText(values.ein),
    sectors: sectors.length ? sectors : undefined,
    engagementStartDate: optionalText(values.engagementStartDate),
    internalNotes: optionalText(values.internalNotes),
  };

  // Merge: existing blob first, then apply each wizard-owned key (set or
  // delete). Non-wizard keys — including dba/address/primaryNaics/
  // additionalNaics from older intakeData — ride through untouched so
  // removing these fields from the wizard does not delete pre-existing data.
  const intakeData: Record<string, unknown> = { ...toRecord(existing?.intakeData) };
  for (const [key, value] of Object.entries(wizardIntake)) {
    if (value === undefined) delete intakeData[key];
    else intakeData[key] = value;
  }

  const payload: ClientPayload = {
    name: optionalText(values.name) ?? '',
    ...compactObject({
      website: optionalText(values.website),
      description: optionalText(values.description),
      primaryContactName: optionalText(values.primaryContactName),
      primaryContactEmail: optionalText(values.primaryContactEmail),
      primaryContactPhone: formatPhone(values.primaryContactPhone),
    }),
  };
  payload.intakeData = intakeData;
  // Mirror primary sector → controlled top-level tag. Map the chosen label/value
  // to a controlled SECTOR_TAG; SECTOR_TAGS values pass through normalizeSector
  // (which uppercases + matches), so a free label like "Other" still resolves.
  if (primarySector) {
    payload.sectorTag = normalizeSector(primarySector) ?? primarySector;
  }
  if (values.submissionTracks?.length) payload.submissionTracks = values.submissionTracks;
  // Always send issueCodes (even when empty) so clearing the override persists.
  payload.issueCodes = Array.isArray(values.issueCodes) ? values.issueCodes : [];
  if (values.profileType) payload.profileType = values.profileType;
  if (values.profileStatus) payload.profileStatus = values.profileStatus;

  // Step 2.3 — mirror the government identifiers to the first-class client columns the
  // relevance engine reads (clients.uei / cage_code / naics_codes[] / psc_codes[]). UEI/CAGE
  // also continue to ride in intakeData above for back-compat reads; here we additionally send
  // the canonical columns. Always send the arrays (even empty) so clearing them persists.
  payload.uei = optionalText(values.uei)?.toUpperCase() ?? null;
  payload.cageCode = optionalText(values.cageCode)?.toUpperCase() ?? null;
  payload.naicsCodes = normalizeCodes(values.naicsCodes);
  payload.pscCodes = normalizeCodes(values.pscCodes);
  // NOT normalizeCodes: these are exact vendor label strings, and upper-casing or
  // stripping punctuation would stop them matching federal_grant.eligibility.
  payload.applicantTypes = Array.isArray(values.applicantTypes)
    ? values.applicantTypes.filter((v: unknown): v is string => typeof v === 'string')
    : [];
  payload.setAsideCertifications = Array.isArray(values.setAsideCertifications)
    ? values.setAsideCertifications.filter((v: unknown): v is string => typeof v === 'string')
    : [];
  return payload;
}

export function clientToFormValues(client?: Client): ClientFormValues {
  if (!client) return {};
  const intake = toRecord(client.intakeData);
  const sb = toRecord(readFirst(intake, ['sbClassification']));

  // Sectors: prefer the stored multi-select list; otherwise seed from the
  // controlled top-level sectorTag (or legacy free-text sector) so edit mode
  // pre-fills at least the primary sector for clients created before v3.
  const storedSectors = readList(intake, ['sectors']);
  const seedSector =
    (client.sectorTag ?? undefined) || (normalizeSector(readText(intake, ['sector'])) ?? undefined);
  const sectors = storedSectors.length ? storedSectors : seedSector ? [seedSector] : [];

  return {
    name: client.name,
    website: client.website ?? undefined,
    description: client.description ?? undefined,
    productDescription: client.productDescription ?? undefined,
    primaryContactName: client.primaryContactName ?? undefined,
    primaryContactEmail: client.primaryContactEmail ?? undefined,
    primaryContactPhone: client.primaryContactPhone ?? undefined,
    sectors,
    submissionTracks: client.submissionTracks ?? [],
    issueCodes: client.issueCodes ?? [],
    profileType: client.profileType ?? undefined,
    profileStatus: client.profileStatus ?? undefined,
    // Small Business Classification flags
    sbSb: readBool(sb, ['sb']),
    sbWosb: readBool(sb, ['wosb']),
    sbSdvosb: readBool(sb, ['sdvosb']),
    sbHubzone: readBool(sb, ['hubzone']),
    sbEightA: readBool(sb, ['eightA', 'eight_a', '8a']),
    sbLarge: readBool(sb, ['large']),
    sbForeignOwned: readBool(sb, ['foreignOwned', 'foreign_owned']),
    // Gov't registration — prefer the first-class columns (Step 2.3), fall back to intakeData.
    cageCode: client.cageCode ?? readText(intake, ['cageCode', 'cage_code']),
    uei: client.uei ?? readText(intake, ['uei']),
    naicsCodes: Array.isArray(client.naicsCodes) ? client.naicsCodes : [],
    pscCodes: Array.isArray(client.pscCodes) ? client.pscCodes : [],
    applicantTypes: Array.isArray(client.applicantTypes) ? client.applicantTypes : [],
    setAsideCertifications: Array.isArray(client.setAsideCertifications)
      ? client.setAsideCertifications
      : [],
    samStatus: readText(intake, ['samStatus', 'sam_status']),
    samExpirationDate: readDate(intake, ['samExpirationDate', 'sam_expiration_date']),
    ldaRegistrantName: readText(intake, ['ldaRegistrantName', 'lda_registrant_name']),
    ein: readText(intake, ['ein']),
    // Sector & tracks
    engagementStartDate: readDate(intake, ['engagementStartDate', 'engagement_start_date']),
    internalNotes: readText(intake, ['internalNotes', 'internal_notes']),
    // ── Legacy reads retained so older intakeData round-trips even though the
    //    wizard no longer renders these fields. dba/address/primaryNaics/
    //    additionalNaics removed from the wizard 2026-08-23 join this list:
    //    editing a client no longer touches them, but pre-existing values
    //    stay intact in intakeData (see the merge in formValuesToClientPayload)
    //    for any other surface that still reads them (e.g. news-catcher's
    //    dba-based alias matching, BulkImportClientsModal's csv mapping). ──
    trl: readText(intake, ['trl']),
    fundingAsk: readText(intake, ['fundingAsk', 'funding_ask', 'funding ask']),
    requestType: readText(intake, ['requestType', 'request_type', 'request type']),
    peNumber: readText(intake, ['peNumber', 'pe_number', 'PE number']),
    engagement: readText(intake, ['engagement']),
    portfolioText: readList(intake, ['portfolio', 'tags']).join(', '),
    pocName: readText(intake, ['pocName', 'poc_name']),
    pocTitle: readText(intake, ['pocTitle', 'poc_title']),
    pocPhone: readText(intake, ['pocPhone', 'poc_phone']),
    pocEmail: readText(intake, ['pocEmail', 'poc_email']),
    headName: readText(intake, ['headName', 'head_name']),
    headTitle: readText(intake, ['headTitle', 'head_title']),
  };
}

export function optionalText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  return text.length ? text : undefined;
}

/** Trim + uppercase + de-dupe a code list (NAICS/PSC) from a tags input; drops empties. */
function normalizeCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    const code = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push(code);
  }
  return out;
}

export function formatPhone(value: unknown): string | undefined {
  const text = optionalText(value);
  if (!text) return undefined;
  const digits = text.replace(/\D/g, '');
  const normalized = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (normalized.length !== 10) return text;
  return `+1 ${normalized.slice(0, 3)}-${normalized.slice(3, 6)}-${normalized.slice(6)}`;
}

function readBool(record: Record<string, unknown>, keys: string[]): boolean {
  const raw = readFirst(record, keys);
  return raw === true || raw === 'true' || raw === 1 || raw === '1';
}

/** Keep only the boolean flags that are truthy. */
function compactBooleans(value: Record<string, boolean | undefined>): Record<string, boolean> {
  return Object.fromEntries(Object.entries(value).filter(([, on]) => on === true)) as Record<
    string,
    boolean
  >;
}

function readList(record: Record<string, unknown>, keys: string[]): string[] {
  const raw = readFirst(record, keys);
  if (Array.isArray(raw)) {
    return raw.map((item) => optionalText(item)).filter((item): item is string => Boolean(item));
  }
  const text = optionalText(raw);
  return text
    ? text
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)
    : [];
}

function readText(record: Record<string, unknown>, keys: string[]): string | undefined {
  return optionalText(readFirst(record, keys));
}

/**
 * Read a date value as a YYYY-MM-DD string suitable for <input type="date">.
 * Truncates any full-ISO timestamp (legacy values) to the date portion.
 */
function readDate(record: Record<string, unknown>, keys: string[]): string | undefined {
  const text = readText(record, keys);
  if (!text) return undefined;
  const match = /^\d{4}-\d{2}-\d{2}/.exec(text);
  return match ? match[0] : text;
}

function readFirst(record: Record<string, unknown>, keys: string[]): unknown {
  for (const key of keys) {
    if (key in record) return record[key];
  }
  return undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => {
      if (entry == null) return false;
      if (typeof entry === 'string') return entry.trim().length > 0;
      if (Array.isArray(entry)) return entry.length > 0;
      if (typeof entry === 'object') return Object.keys(entry).length > 0;
      return true;
    }),
  );
}
