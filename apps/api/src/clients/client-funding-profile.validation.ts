import { BadRequestException } from '@nestjs/common';
import { isValidEin, normalizeEin, normalizeNaicsCodes, reconcileRegistrationNaics, registrationConflicts } from '@capiro/shared/client-registration-integrity';
import { DURABLE_SET_ASIDE_CERTIFICATIONS } from '../funding-opportunities/set-aside.js';
import {
  applicantTypeKey,
  GRANTS_GOV_ORGANIZATION_TYPE_GROUPS,
  MAX_FUNDING_PRIORITIES,
  MAX_FUNDING_PRIORITY_LENGTH,
  normalizeFundingPriorities,
} from '@capiro/shared';

export const CLIENT_ORGANIZATION_TYPES = GRANTS_GOV_ORGANIZATION_TYPE_GROUPS.flatMap((group) =>
  group.options.map((option) => option.value),
);

type FundingProfileInput = {
  applicantTypes?: string[];
  naicsCodes?: string[];
  setAsideCertifications?: string[];
  intakeData?: Record<string, unknown>;
};

type StoredFundingProfile = {
  applicantTypes?: readonly string[];
  naicsCodes?: readonly string[];
  setAsideCertifications?: readonly string[];
  intakeData?: unknown;
};

/**
 * Used by every client writer, including imports and internal service callers.
 * Source eligibility rules are not new organization identities. Existing legacy
 * labels may remain or be removed during an edit, so unrelated saves still work.
 */
export function validateClientFundingProfile(
  input: FundingProfileInput,
  existing?: StoredFundingProfile,
): FundingProfileInput {
  const result: FundingProfileInput = {};

  if ('applicantTypes' in input) {
    const applicantTypes = input.applicantTypes ?? [];
    if (!Array.isArray(applicantTypes)) {
      throw new BadRequestException('Organization types must be a list of applicant categories.');
    }
    const existingLabels = new Set(existing?.applicantTypes ?? []);
    const normalized: string[] = [];
    for (const label of applicantTypes) {
      if (typeof label !== 'string') {
        throw new BadRequestException('Each organization type must be a text value.');
      }
      const canonical = CLIENT_ORGANIZATION_TYPES.find(
        (type) => applicantTypeKey(type) === applicantTypeKey(label),
      );
      if (!canonical && !existingLabels.has(label)) {
        throw new BadRequestException(
          'Choose an organization type that describes the client. Other and Unrestricted are opportunity rules, not organization types.',
        );
      }
      const value = canonical ?? label;
      if (!normalized.includes(value)) normalized.push(value);
    }
    result.applicantTypes = normalized;
  }

  // Set-aside certifications: only the six DURABLE socioeconomic certifications
  // are valid NEW selections. A client row can carry historical values recorded
  // under the old SAM `typeOfSetAside` vocabulary (sole-source/restriction codes
  // such as SDVOSBC/HZC/SBA). Those stored values are preserved verbatim so an
  // unrelated profile save does not fail, and may be removed — but they are
  // never re-claimed as a NEW certification, and an arbitrary invalid code is
  // never accepted. This mirrors the applicantTypes preserve-existing pattern.
  if ('setAsideCertifications' in input) {
    const certs = input.setAsideCertifications ?? [];
    if (!Array.isArray(certs)) {
      throw new BadRequestException('Set-aside certifications must be a list of codes.');
    }
    const existingCerts = new Set(existing?.setAsideCertifications ?? []);
    const durable = new Set<string>(DURABLE_SET_ASIDE_CERTIFICATIONS);
    const normalized: string[] = [];
    for (const code of certs) {
      if (typeof code !== 'string') {
        throw new BadRequestException('Each set-aside certification must be a text value.');
      }
      if (!durable.has(code) && !existingCerts.has(code)) {
        throw new BadRequestException(
          'Choose a set-aside certification the client actually holds. Sole-source and small-business restriction codes are solicitation rules, not company certifications.',
        );
      }
      if (!normalized.includes(code)) normalized.push(code);
    }
    result.setAsideCertifications = normalized;
  }

  if ('intakeData' in input) {
    const supplied = input.intakeData ?? {};
    if (typeof supplied !== 'object' || Array.isArray(supplied)) {
      throw new BadRequestException('Client intake data must be an object.');
    }
    // Keep the existing whole-object write contract. Editors merge unrelated
    // saved fields and can intentionally clear a priority by omitting its key.
    const intakeData = { ...supplied };
    if ('ein' in intakeData) {
      const oldIntake = existing?.intakeData && typeof existing.intakeData === 'object' && !Array.isArray(existing.intakeData)
        ? existing.intakeData as Record<string, unknown> : {};
      if (!isValidEin(intakeData.ein) && intakeData.ein !== oldIntake.ein) {
        throw new BadRequestException('EIN must contain nine digits, for example 12-3456789, or be left empty.');
      }
      if (isValidEin(intakeData.ein)) {
        const ein = normalizeEin(intakeData.ein);
        if (ein) intakeData.ein = ein;
        else delete intakeData.ein;
      }
    }
    if ('fundingPriorities' in supplied) {
      const priorities = supplied.fundingPriorities;
      if (!Array.isArray(priorities) || priorities.length > MAX_FUNDING_PRIORITIES) {
        throw new BadRequestException(
          `Funding priorities must be a list of at most ${MAX_FUNDING_PRIORITIES} project or outcome phrases.`,
        );
      }
      for (const priority of priorities) {
        if (
          typeof priority !== 'string' ||
          !priority.trim() ||
          priority.length > MAX_FUNDING_PRIORITY_LENGTH
        ) {
          throw new BadRequestException(
            `Each funding priority must contain 1 to ${MAX_FUNDING_PRIORITY_LENGTH} characters.`,
          );
        }
      }
      intakeData.fundingPriorities = normalizeFundingPriorities(priorities);
    }
    result.intakeData = intakeData;
  }

  if ('naicsCodes' in input) {
    if (!Array.isArray(input.naicsCodes) || input.naicsCodes.some((value) => typeof value !== 'string')) {
      throw new BadRequestException('NAICS codes must be a list of text values.');
    }
    result.naicsCodes = normalizeNaicsCodes(input.naicsCodes);
    // An API caller may update only the canonical list. Reconcile legacy fields
    // in the same write so they cannot reappear as contradictory display data.
    const intake = result.intakeData ?? existing?.intakeData;
    if (intake !== undefined) result.intakeData = reconcileRegistrationNaics(intake, result.naicsCodes);
  }

  const previousConflicts = new Set(registrationConflicts(existing ?? {}).map((issue) => issue.code));
  const nextProfile = { ...existing, ...input, ...result };
  const newConflict = registrationConflicts(nextProfile).find((issue) => issue.blocking && !previousConflicts.has(issue.code));
  if (newConflict) throw new BadRequestException(newConflict.message);

  return result;
}
