import type { Client } from './clientTypes.js';
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

/** SAM.gov set-aside certifications — value is the SAM code, label is English. */
export const SET_ASIDE_CERTIFICATION_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'SBA', label: 'Total small business set-aside eligible' },
  { value: 'SBP', label: 'Partial small business set-aside eligible' },
  { value: '8A', label: '8(a)' },
  { value: '8AN', label: '8(a) sole source' },
  { value: 'SDVOSBC', label: 'Service-disabled veteran-owned small business' },
  { value: 'SDVOSBS', label: 'SDVOSB sole source' },
  { value: 'WOSB', label: 'Women-owned small business' },
  { value: 'WOSBSS', label: 'WOSB sole source' },
  { value: 'EDWOSB', label: 'Economically disadvantaged WOSB' },
  { value: 'EDWOSBSS', label: 'EDWOSB sole source' },
  { value: 'HZC', label: 'HUBZone' },
  { value: 'HZS', label: 'HUBZone sole source' },
];

const SET_ASIDE_LABEL = new Map(SET_ASIDE_CERTIFICATION_OPTIONS.map((o) => [o.value, o.label]));

/** An unrecognized code is shown as-is rather than dropped — it is real data. */
export function setAsideLabel(code: string): string {
  return SET_ASIDE_LABEL.get(code) ?? code;
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
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && !!v.trim()) : [];
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
  push('EIN', text(intake, ['ein']));

  // NAICS lives in two shapes: the free-text primary/additional pair the
  // wizard has always had, and the first-class `naicsCodes[]` array the
  // relevance engine reads. Prefer the explicit primary; fall back to the
  // array's first entry so a client edited only through the array still shows one.
  const naicsCodes = strings(client.naicsCodes);
  const primaryNaics = text(intake, ['primaryNaics', 'primary_naics', 'naics']) ?? naicsCodes[0] ?? null;
  push('Primary NAICS', primaryNaics);

  const additionalNaics =
    text(intake, ['additionalNaics', 'additional_naics']) ??
    (naicsCodes.length > 1 ? naicsCodes.slice(1).join(', ') : null);
  push('Additional NAICS', additionalNaics);

  push('PSC codes', strings(client.pscCodes).join(', '));

  // Set-asides: the verified SAM certifications first, then the self-reported
  // Small Business Classification flags. Both are real and mean different
  // things, so they are labelled separately instead of merged into one list.
  push('Set-aside certifications', strings(client.setAsideCertifications).map(setAsideLabel).join(' · '));
  push(
    'Small business classification',
    SB_CLASSIFICATION_LABELS.filter((flag) => sb[flag.key] === true)
      .map((flag) => flag.label)
      .join(' · '),
  );

  push('Eligible applicant types', strings(client.applicantTypes).join(' · '));
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
