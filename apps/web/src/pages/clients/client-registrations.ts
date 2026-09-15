import {
  GRANTS_GOV_UNRESTRICTED_APPLICANTS,
  applicantTypeKey,
  getClientOrganizationTypes,
  getGrantsGovOrganizationTypeLabel,
  isGrantsGovSourceEligibilityRule,
  fundingPrioritiesFromIntake,
} from '@capiro/shared';
import type { Client } from './clientTypes.js';
import { isValidEin, normalizeEin, readRegistrationNaics, registrationConflicts } from '@capiro/shared/client-registration-integrity';
import { toRecord } from './client-profile-crm-model.js';

/**
 * The client's government registration record, read from the one place it is
 * actually stored.
 *
 * Deliberately antd-free so `src/vnext` can consume it (that subtree is
 * antd-free by design). `ClientFormModal` — the editor that writes these
 * fields — imports the same option lists from here, so the labels a user picks
 * and the labels rendered back are one list, not two that drift.
 *
 * Read order mirrors `clientToFormValues`: prefer the first-class columns the
 * relevance engine reads (Step 2.3 — `clients.uei` / `cage_code` /
 * `naics_codes[]` / `psc_codes[]`), fall back to the `intakeData` JSON blob
 * where the field only ever lived there.
 */

/**
 * SAM.gov set-aside certifications offered in the editor — value is the code
 * the API accepts, label is English.
 *
 * Reconciled to the canonical durable-certification set in
 * `apps/api/src/funding-opportunities/set-aside.ts`
 * (`DURABLE_SET_ASIDE_CERTIFICATIONS`) and the update DTO's `@IsIn`. The list
 * previously offered SAM *solicitation restriction* codes — SBA/SBP (general
 * small-business restrictions, not certifications) and the sole-source /
 * competed variants 8AN, SDVOSBC/SDVOSBS, WOSBSS, EDWOSBSS, HZC/HZS — which
 * the API rejects with a 400, so picking "Total small business set-aside
 * eligible" could never save. A restriction describes what a NOTICE is limited
 * to; a certification is a status the COMPANY holds. Only the durable statuses
 * are offered now.
 */
export const SET_ASIDE_CERTIFICATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: '8A', label: '8(a) Business Development' },
  { value: 'SDVOSB', label: 'Service-disabled veteran-owned small business' },
  { value: 'VOSB', label: 'Veteran-owned small business' },
  { value: 'WOSB', label: 'Women-owned small business' },
  { value: 'EDWOSB', label: 'Economically disadvantaged women-owned small business' },
  { value: 'HUBZONE', label: 'HUBZone' },
];

const SET_ASIDE_LABEL = new Map(SET_ASIDE_CERTIFICATION_OPTIONS.map((o) => [o.value, o.label]));

/**
 * Display labels for codes that are NOT current certifications but may already
 * be persisted on older records — kept so a stored legacy value renders as
 * English instead of a raw code. Mirrors the canonical
 * `LEGACY_SET_ASIDE_VALUE_MIGRATION` keys; never offered for new edits.
 */
const LEGACY_SET_ASIDE_LABEL: Readonly<Record<string, string>> = {
  SBA: 'Total small business set-aside (legacy)',
  SBP: 'Partial small business set-aside (legacy)',
  '8AN': '8(a) sole source (legacy)',
  SDVOSBC: 'Service-disabled veteran-owned small business (legacy)',
  SDVOSBS: 'SDVOSB sole source (legacy)',
  WOSBSS: 'WOSB sole source (legacy)',
  EDWOSBSS: 'EDWOSB sole source (legacy)',
  HZC: 'HUBZone (legacy)',
  HZS: 'HUBZone sole source (legacy)',
};

/** An unrecognized code is shown as-is rather than dropped — it is real data. */
export function setAsideLabel(code: string): string {
  return SET_ASIDE_LABEL.get(code) ?? LEGACY_SET_ASIDE_LABEL[code] ?? code;
}

/** Small Business Classification flags, in the order the wizard renders them. */
export const SB_CLASSIFICATION_LABELS: ReadonlyArray<{ key: string; label: string }> = [
  { key: 'sb', label: 'Small Business' },
  { key: 'wosb', label: 'WOSB' },
  { key: 'sdvosb', label: 'SDVOSB' },
  { key: 'hubzone', label: 'HUBZone' },
  { key: 'eightA', label: '8(a)' },
  { key: 'large', label: 'Large Business' },
  { key: 'foreignOwned', label: 'Foreign-owned' },
];

export interface RegistrationRow {
  /** Stable key — also the row label. */
  label: string;
  value: string;
}

export interface ClientRegistrations {
  rows: RegistrationRow[];
  /** e.g. "Active" — from intakeData.samStatus. Null when never recorded. */
  samStatus: string | null;
  /** ISO date string from intakeData.samExpirationDate. Null when unrecorded. */
  samExpiration: string | null;
}

function text(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string' && !!v.trim())
    : [];
}

/** The same saved priorities used by opportunity matching, separate from sector tags. */
export function readClientFundingPriorities(client: Client): string[] {
  return fundingPrioritiesFromIntake(client.intakeData);
}

/** Source eligibility rules in older profiles are visible for review, never identity. */
export function readClientOrganizationTypeRows(client: Client): RegistrationRow[] {
  const savedTypes = strings(client.applicantTypes);
  const organizationTypes = getClientOrganizationTypes(savedTypes);
  const organizationKeys = new Set(organizationTypes.map(applicantTypeKey));
  const reviewValues = new Map<string, string>();
  for (const value of savedTypes) {
    const key = applicantTypeKey(value);
    if (organizationKeys.has(key)) continue;
    reviewValues.set(
      key,
      isGrantsGovSourceEligibilityRule(value)
        ? key === applicantTypeKey(GRANTS_GOV_UNRESTRICTED_APPLICANTS)
          ? 'Unrestricted (opportunity rule)'
          : 'Other (requires source eligibility review)'
        : value.trim(),
    );
  }
  const rows: RegistrationRow[] = [];
  if (organizationTypes.length) {
    rows.push({
      label: 'Organization types',
      value: organizationTypes.map(getGrantsGovOrganizationTypeLabel).join(' · '),
    });
  }
  if (reviewValues.size) {
    rows.push({
      label: 'Organization types — review needed',
      value: [...reviewValues.values()].join(' · '),
    });
  }
  return rows;
}

/**
 * Every registration field this product actually stores, as display rows.
 *
 * Rows with no recorded value are omitted rather than rendered blank — an
 * absent row reads as "not recorded", an empty one reads as "recorded as
 * nothing". The design's two other rows have no store anywhere in this
 * codebase and are therefore not produced at all: "Contract vehicles" (only
 * the legacy free-text `intakeData.existingContracts`, surfaced here under its
 * own honest label) and "Facility clearance" (no field, no endpoint, no
 * source — see the ship notes).
 */
export function readClientRegistrations(client: Client): ClientRegistrations {
  const intake = toRecord(client.intakeData);
  const sb = toRecord(intake['sbClassification']);
  const rows: RegistrationRow[] = [];

  const push = (label: string, value: string | null | undefined) => {
    if (value && value.trim()) rows.push({ label, value: value.trim() });
  };

  push('UEI', client.uei ?? text(intake, ['uei']));
  push('CAGE', client.cageCode ?? text(intake, ['cageCode', 'cage_code']));
  const ein = text(intake, ['ein']);
  push('EIN', normalizeEin(ein) ?? ein);
  if (!isValidEin(ein)) push('EIN — review needed', 'Saved value does not contain nine digits. Verify it against the client’s registration record.');

  // Display the same canonical list the editor and matching engine use. A
  // primary is shown only when it was explicitly recorded and is still listed.
  const naics = readRegistrationNaics(client);
  if (naics.primary) {
    push('Primary NAICS', naics.primary);
    push('Additional NAICS', naics.codes.filter((code) => code !== naics.primary).join(', '));
  } else push('NAICS codes', naics.codes.join(', '));
  if (naics.disagreement) push('NAICS — review needed', `Older registration fields contain ${naics.legacyCodes.join(', ')} and differ from the current NAICS code list. Review the current list in Edit client; it is the list used for matching.`);
  if (naics.legacyOnly) push('NAICS — review needed', 'These codes come from an older registration record. Review and save them in Edit client to use them for matching.');

  push('PSC codes', strings(client.pscCodes).join(', '));

  // Set-asides: the verified SAM certifications first, then the self-reported
  // Small Business Classification flags. Both are real and mean different
  // things, so they are labelled separately instead of merged into one list.
  push(
    'Set-aside certifications',
    strings(client.setAsideCertifications).map(setAsideLabel).join(' · '),
  );
  push(
    'Small business classification',
    SB_CLASSIFICATION_LABELS.filter((flag) => sb[flag.key] === true)
      .map((flag) => flag.label)
      .join(' · '),
  );

  rows.push(...readClientOrganizationTypeRows(client));
  push('Registration — review needed', registrationConflicts(client).map((issue) => issue.message).join(' '));
  push('LDA registrant', text(intake, ['ldaRegistrantName', 'lda_registrant_name']));
  // Legacy free-text. Named for what the field is, not the design's "Contract
  // vehicles" — nothing guarantees the text describes vehicles.
  push('Existing contracts', text(intake, ['existingContracts', 'existing_contracts']));

  return {
    rows,
    samStatus: text(intake, ['samStatus', 'sam_status']),
    samExpiration: text(intake, ['samExpirationDate', 'sam_expiration_date']),
  };
}
