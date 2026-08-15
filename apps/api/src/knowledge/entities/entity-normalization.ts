const ENTITY_TOKEN_PATTERN = /[^a-z0-9@.+-]+/g;
const IDENTIFIER_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export function normalizeEntityText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(ENTITY_TOKEN_PATTERN, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeIdentifierType(value: string): string {
  const normalized = value.trim().toLocaleLowerCase('en-US').replace(/[-\s]+/g, '_');
  if (!IDENTIFIER_TYPE_PATTERN.test(normalized)) {
    throw new Error(`Invalid entity identifier type: ${value}`);
  }
  return normalized;
}

export function normalizeEntityIdentifier(type: string, value: string): string {
  const normalizedType = normalizeIdentifierType(type);
  const trimmed = value.normalize('NFKC').trim();
  if (!trimmed) throw new Error('Entity identifier value is required.');

  switch (normalizedType) {
    case 'email':
      return trimmed.toLocaleLowerCase('en-US');
    case 'domain':
    case 'official_domain':
      return normalizeDomain(trimmed);
    case 'cik':
      return normalizeCik(trimmed);
    case 'bioguide_id':
    case 'lis_id':
      return trimmed.toUpperCase().replace(/\s+/g, '');
    case 'openstates_person_id':
    case 'federal_contractor_id':
      return trimmed.toLocaleLowerCase('en-US');
    case 'uei':
    case 'cage':
    case 'sam_entity_id':
    case 'congress_id':
    case 'committee_id':
    case 'directory_person_id':
    case 'usaspending_recipient_id':
    case 'lda_client_id':
    case 'lda_registrant_id':
    case 'legiscan_people_id':
    case 'crm_client_id':
    case 'crm_contact_id':
    case 'engagement_contact_id':
    case 'acquisition_personnel_id':
    case 'provider_contact_id':
    case 'bill_id':
    case 'program_element_code':
      return trimmed.toUpperCase().replace(/[\s-]+/g, '');
    default:
      return trimmed.toLocaleLowerCase('en-US');
  }
}

export function normalizeDomain(value: string): string {
  const candidate = value.includes('@') ? value.slice(value.lastIndexOf('@') + 1) : value;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate)
    ? candidate
    : `https://${candidate}`;
  let hostname: string;
  try {
    hostname = new URL(withScheme).hostname;
  } catch {
    throw new Error(`Invalid entity domain: ${value}`);
  }

  const normalized = hostname
    .toLocaleLowerCase('en-US')
    .replace(/^www\./, '')
    .replace(/\.$/, '');

  if (!normalized || !normalized.includes('.') || /\s/.test(normalized)) {
    throw new Error(`Invalid entity domain: ${value}`);
  }
  return normalized;
}

function normalizeCik(value: string): string {
  const digits = value.replace(/\D+/g, '');
  if (!digits || digits.length > 10) {
    throw new Error(`Invalid SEC CIK: ${value}`);
  }
  return digits.padStart(10, '0');
}

export function clampResolutionConfidence(value: number | undefined, fallback = 1): number {
  const candidate = value ?? fallback;
  if (!Number.isFinite(candidate) || candidate < 0 || candidate > 1) {
    throw new Error('Resolution confidence must be between 0 and 1.');
  }
  return Math.round(candidate * 10_000) / 10_000;
}

export function normalizeEntityType(value: string | null | undefined): string | null {
  if (value == null) return null;
  const normalized = value.trim().toLocaleLowerCase('en-US').replace(/[-\s]+/g, '_');
  if (!IDENTIFIER_TYPE_PATTERN.test(normalized)) {
    throw new Error(`Invalid canonical entity type: ${value}`);
  }
  return normalized;
}
