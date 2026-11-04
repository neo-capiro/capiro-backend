import { BadRequestException } from '@nestjs/common';
import { isEmail, isUUID } from 'class-validator';
import { MANUAL_FIELDS } from './profile-projection.service.js';
import {
  lookupProfileBuildReferenceCode,
  type ProfileBuildReferenceKind,
} from './profile-build-reference-catalog.js';
import { researchWebsite } from './client-profile-fill-research-inputs.js';
import { parseManualFieldEvidence, type ManualFieldEvidence } from './profile-manual-field-evidence.js';

export type ManualReferenceMetadata = {
  kind: ProfileBuildReferenceKind;
  code: string;
  sourceType: 'person_entry';
  referenceStatus: 'verified' | 'unverified';
  label: string;
  reference?: Record<string, unknown>;
};
export type SaveProfileInput = {
  requestId: string;
  expectedVersion: string;
  fields?: Record<string, unknown>;
  locations?: unknown[];
  leadership?: unknown[];
  capabilities?: unknown[];
  advocacy?: unknown;
  notes?: unknown;
  fieldEvidence?: ManualFieldEvidence;
  /** Computed by this parser; callers cannot submit reference provenance. */
  referenceMetadata?: Partial<Record<'naicsCodes' | 'pscCodes', ManualReferenceMetadata[]>>;
};

const SECTIONS = ['locations', 'leadership', 'capabilities', 'advocacy', 'notes'] as const;
const ARRAY_FIELDS = new Set([
  'naicsCodes',
  'pscCodes',
  'issueCodes',
  'applicantTypes',
  'setAsideCertifications',
]);
const FIELD_LIMITS: Record<string, number> = {
  name: 200,
  website: 2048,
  description: 600,
  productDescription: 600,
  primaryContactName: 200,
  primaryContactEmail: 254,
  primaryContactPhone: 80,
  uei: 12,
  cageCode: 5,
  samStatus: 100,
  samExpirationDate: 10,
  ein: 32,
  ldaRegistrantName: 300,
};
const SITE_ROLES = [
  'headquarters',
  'manufacturing',
  'research',
  'engineering',
  'testing',
  'office',
  'other',
];
const SITE_STATUSES = [
  'operating',
  'announced',
  'under_construction',
  'proposed',
  'closed',
  'unknown',
];
const CAPABILITY_TYPES = ['product', 'platform', 'service', 'program', 'component'];

function invalid(message: string): never {
  throw new BadRequestException(message);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    invalid(`${label} must be an object`);
  const result = value as Record<string, unknown>;
  if (Object.keys(result).some((key) => ['__proto__', 'prototype', 'constructor'].includes(key)))
    invalid(`Invalid ${label} property`);
  return result;
}
function allowedKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    invalid(`Unsupported ${label} property`);
}
function text(value: unknown, label: string, max: number, required = false): string {
  if (typeof value !== 'string' || value.length > max)
    invalid(`${label} must be text of at most ${max} characters`);
  const normalized = value.trim();
  if (required && !normalized) invalid(`${label} is required`);
  return normalized;
}
function strings(value: unknown, label: string, maxCount = 100, maxLength = 300): string[] {
  if (!Array.isArray(value) || value.length > maxCount)
    invalid(`${label} must contain at most ${maxCount} values`);
  return [...new Set(value.map((item) => text(item, label, maxLength, true)))];
}
function email(value: string, label: string): string {
  if (value && !isEmail(value)) invalid(`${label} must be a valid email`);
  return value;
}
function day(value: string, label: string): string {
  if (
    value &&
    (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(Date.parse(value)) ||
      new Date(value).toISOString().slice(0, 10) !== value)
  )
    invalid(`${label} must be a valid YYYY-MM-DD date`);
  return value;
}
function classificationCodes(
  value: unknown,
  kind: ProfileBuildReferenceKind,
): { codes: string[]; metadata: ManualReferenceMetadata[] } {
  const codes = [
    ...new Set(
      strings(value, `${kind.toUpperCase()} codes`, 100, 20).map((code) => code.toUpperCase()),
    ),
  ];
  const metadata = codes.map((code) => {
    // The manual form also accepts NAICS hierarchy codes. Only exact assignable
    // codes in the pinned official edition receive a verified reference label.
    if (!(kind === 'naics' ? /^\d{2,6}$/ : /^[A-Z0-9]{4}$/).test(code))
      invalid(`Invalid ${kind.toUpperCase()} code format`);
    const match = lookupProfileBuildReferenceCode(kind, code);
    if (match.status === 'inactive_code') invalid(`Inactive ${kind.toUpperCase()} code: ${code}`);
    const base = { kind, code, sourceType: 'person_entry' as const };
    return match.status === 'valid'
      ? {
          ...base,
          referenceStatus: 'verified' as const,
          label: `Entered by a person · ${match.entry.label}`,
          reference: { ...match.entry },
        }
      : {
          ...base,
          referenceStatus: 'unverified' as const,
          label: `Entered by a person · ${kind.toUpperCase()} ${code} is outside the current reference list (unverified)`,
        };
  });
  return { codes, metadata };
}
function sectionRows(
  raw: unknown,
  section: 'locations' | 'leadership' | 'capabilities',
): unknown[] {
  if (!Array.isArray(raw) || raw.length > 100) invalid('Choose no more than 100 section entries');
  return raw.map((value) => {
    const row = object(value, section);
    const limits: Record<string, number> =
      section === 'locations'
        ? {
            name: 200,
            addressLine: 500,
            city: 200,
            state: 100,
            zip: 20,
            country: 2,
            role: 40,
            siteRole: 40,
            status: 40,
            siteStatus: 40,
          }
        : section === 'leadership'
          ? { name: 200, title: 200, email: 254, phone: 80, role: 100, notes: 5000 }
          : { name: 300, type: 40, lifecycle: 40, description: 600 };
    allowedKeys(
      row,
      [
        'id',
        ...Object.keys(limits),
        ...(section === 'locations'
          ? ['employeeCount']
          : section === 'capabilities'
            ? ['tags', 'keywords']
            : []),
      ],
      section,
    );
    const result: Record<string, unknown> = {};
    if (row.id !== undefined) {
      if (typeof row.id !== 'string' || !isUUID(row.id)) invalid('Invalid section entry ID');
      result.id = row.id;
    }
    result.name = text(row.name, `${section} name`, limits.name!, true);
    for (const [key, max] of Object.entries(limits))
      if (key !== 'name' && row[key] !== undefined) result[key] = text(row[key], key, max);
    if (section === 'locations') {
      if (result.country === '') delete result.country;
      else if (result.country !== undefined) {
        if (!/^[A-Za-z]{2}$/.test(String(result.country)))
          invalid('Country must be a two-letter ISO country code');
        result.country = String(result.country).toUpperCase();
      }
      for (const [key, values] of [
        ['role', SITE_ROLES],
        ['siteRole', SITE_ROLES],
        ['status', SITE_STATUSES],
        ['siteStatus', SITE_STATUSES],
      ] as const)
        if (result[key] !== undefined && !values.includes(String(result[key])))
          invalid(`Invalid location ${key}`);
      if (
        result.role !== undefined &&
        result.siteRole !== undefined &&
        result.role !== result.siteRole
      )
        invalid('Conflicting location roles');
      if (
        result.status !== undefined &&
        result.siteStatus !== undefined &&
        result.status !== result.siteStatus
      )
        invalid('Conflicting location statuses');
      if (row.employeeCount !== undefined) {
        if (!Number.isSafeInteger(row.employeeCount) || Number(row.employeeCount) < 0)
          invalid('Employee count must be a nonnegative integer');
        result.employeeCount = row.employeeCount;
      }
    } else if (section === 'leadership') {
      if (result.email !== undefined)
        result.email = email(String(result.email), 'Leadership email');
    } else {
      if (
        result.lifecycle !== undefined &&
        !['in_service', 'in_development', 'planned', 'unspecified'].includes(
          String(result.lifecycle),
        )
      )
        invalid('Invalid capability lifecycle');
      if (result.type !== undefined && !CAPABILITY_TYPES.includes(String(result.type)))
        invalid('Invalid capability type');
      for (const key of ['tags', 'keywords'])
        if (row[key] !== undefined) result[key] = strings(row[key], key);
    }
    return result;
  });
}
function advocacy(raw: unknown): Record<string, unknown> {
  const row = object(raw, 'Advocacy');
  allowedKeys(
    row,
    [
      'sectors',
      'submissionTracks',
      'issueCodes',
      'fundingPriorities',
      'engagementStartDate',
      'internalNotes',
    ],
    'advocacy',
  );
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === 'fundingPriorities') result[key] = strings(value, 'Funding priorities', 20, 120);
    else if (key === 'engagementStartDate') result[key] = day(text(value, key, 10), key);
    else if (key === 'internalNotes') result[key] = text(value, key, 20000);
    else result[key] = strings(value, key);
  }
  return result;
}
function notes(raw: unknown): unknown {
  if (typeof raw === 'string') return text(raw, 'Note', 20000, true);
  const parse = (value: unknown) => {
    const row = object(value, 'Note');
    allowedKeys(row, ['id', 'body'], 'note');
    if (row.id !== undefined && (typeof row.id !== 'string' || !isUUID(row.id)))
      invalid('Invalid note ID');
    return {
      ...(row.id === undefined ? {} : { id: row.id }),
      body: text(row.body, 'Note', 20000, true),
    };
  };
  if (!Array.isArray(raw)) return parse(raw);
  if (raw.length > 100) invalid('Choose no more than 100 notes');
  return raw.map(parse);
}

/** Normalize once before request hashing, projection and person-fact persistence. */
export function parseProfileSave(raw: unknown): SaveProfileInput {
  const value = object(raw, 'Profile');
  allowedKeys(value, ['requestId', 'expectedVersion', 'fields', 'fieldEvidence', ...SECTIONS], 'profile');
  if (
    typeof value.requestId !== 'string' ||
    !isUUID(value.requestId) ||
    typeof value.expectedVersion !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.expectedVersion)
  )
    invalid('A request ID and current profile version are required');
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    invalid('Profile must contain JSON values');
  }
  if (serialized.length > 250000) invalid('Profile is too large');
  const fields: Record<string, unknown> = {};
  const referenceMetadata: NonNullable<SaveProfileInput['referenceMetadata']> = {};
  for (const [key, supplied] of Object.entries(
    value.fields === undefined ? {} : object(value.fields, 'Fields'),
  )) {
    if (!MANUAL_FIELDS.has(key)) invalid(`Unsupported profile field: ${key}`);
    if (key === 'naicsCodes' || key === 'pscCodes') {
      const parsed = classificationCodes(supplied, key === 'naicsCodes' ? 'naics' : 'psc');
      fields[key] = parsed.codes;
      referenceMetadata[key] = parsed.metadata;
    } else if (ARRAY_FIELDS.has(key)) fields[key] = strings(supplied, key);
    else if (key === 'sbClassification') {
      const flags = object(supplied, key);
      if (
        Object.keys(flags).length > 64 ||
        Object.entries(flags).some(
          ([flag, enabled]) =>
            !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(flag) || typeof enabled !== 'boolean',
        )
      )
        invalid('Invalid small-business classification flags');
      fields[key] = { ...flags };
    } else {
      if (supplied === null && key !== 'name') {
        fields[key] = null;
        continue;
      }
      const normalized = text(supplied, key, FIELD_LIMITS[key] ?? 300, key === 'name');
      fields[key] =
        key === 'website'
          ? researchWebsite(normalized)
          : key === 'primaryContactEmail'
            ? email(normalized, key)
            : key === 'samExpirationDate'
              ? day(normalized, key)
              : ['cageCode', 'uei'].includes(key)
                ? normalized.toUpperCase()
                : normalized;
    }
  }
  const result: SaveProfileInput = {
    requestId: value.requestId,
    expectedVersion: value.expectedVersion,
    fields,
  };
  if (Object.keys(referenceMetadata).length) result.referenceMetadata = referenceMetadata;
  const fieldEvidence = parseManualFieldEvidence(value.fieldEvidence, fields);
  if (fieldEvidence) result.fieldEvidence = fieldEvidence;
  for (const section of ['locations', 'leadership', 'capabilities'] as const)
    if (value[section] !== undefined) result[section] = sectionRows(value[section], section);
  if (value.advocacy !== undefined) result.advocacy = advocacy(value.advocacy);
  if (value.notes !== undefined) result.notes = notes(value.notes);
  return result;
}
