import { BadRequestException } from '@nestjs/common';
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
  intakeData?: Record<string, unknown>;
};

type StoredFundingProfile = {
  applicantTypes?: readonly string[];
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

  if ('intakeData' in input) {
    const supplied = input.intakeData ?? {};
    if (typeof supplied !== 'object' || Array.isArray(supplied)) {
      throw new BadRequestException('Client intake data must be an object.');
    }
    // Keep the existing whole-object write contract. Editors merge unrelated
    // saved fields and can intentionally clear a priority by omitting its key.
    const intakeData = { ...supplied };
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

  return result;
}
