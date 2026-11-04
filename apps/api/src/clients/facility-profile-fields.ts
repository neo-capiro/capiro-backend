import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  isVerifiedFacilityPoint,
  type VerifiedFacilityPoint,
} from '../external/census-geocoder/geographic-boundary.js';

export interface FacilityProfileFields {
  country?: string;
  siteRole?:
    | 'headquarters'
    | 'manufacturing'
    | 'research'
    | 'engineering'
    | 'testing'
    | 'office'
    | 'other';
  siteStatus?: 'operating' | 'announced' | 'under_construction' | 'proposed' | 'closed' | 'unknown';
  siteVerificationStatus?: 'unverified' | 'verified' | 'proposed' | 'closed';
  sourceEvidence?: Array<{
    sourceType: string;
    sourceUrl?: string;
    attachmentId?: string;
    evidence?: string;
  }>;
  sourceObservedAt?: string;
  verifiedPoint?: VerifiedFacilityPoint | null;
  economicImpact?: Record<string, unknown> | null;
  capabilityIds?: string[];
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function facilityProfileFields(
  input: FacilityProfileFields,
): Prisma.ClientFacilityUncheckedUpdateManyInput {
  for (const [field, allowed] of Object.entries({
    siteRole: [
      'headquarters',
      'manufacturing',
      'research',
      'engineering',
      'testing',
      'office',
      'other',
    ],
    siteStatus: ['operating', 'announced', 'under_construction', 'proposed', 'closed', 'unknown'],
    siteVerificationStatus: ['unverified', 'verified', 'proposed', 'closed'],
  })) {
    const value = input[field as keyof FacilityProfileFields];
    if (value !== undefined && (typeof value !== 'string' || !allowed.includes(value)))
      throw new BadRequestException(`Invalid ${field}`);
  }
  if (input.country !== undefined && !/^[A-Za-z]{2}$/.test(input.country))
    throw new BadRequestException('country must be an ISO country code');
  if (input.verifiedPoint != null && !isVerifiedFacilityPoint(input.verifiedPoint))
    throw new BadRequestException(
      'A verified point requires valid coordinates and verification time',
    );
  if (input.sourceObservedAt !== undefined && !Number.isFinite(Date.parse(input.sourceObservedAt)))
    throw new BadRequestException('sourceObservedAt must be a date');
  if (
    input.sourceEvidence !== undefined &&
    (!Array.isArray(input.sourceEvidence) ||
      input.sourceEvidence.length > 30 ||
      input.sourceEvidence.some(
        (e) =>
          !e ||
          typeof e.sourceType !== 'string' ||
          (!e.sourceUrl && !e.attachmentId) ||
          (e.sourceUrl && !/^https?:\/\//i.test(e.sourceUrl)) ||
          (e.attachmentId && !UUID.test(e.attachmentId)),
      ))
  ) {
    throw new BadRequestException('Site evidence must identify a source URL or attachment');
  }
  if (
    input.economicImpact != null &&
    (typeof input.economicImpact !== 'object' ||
      Array.isArray(input.economicImpact) ||
      JSON.stringify(input.economicImpact).length > 20_000 ||
      !Array.isArray(input.economicImpact.evidence) ||
      !input.economicImpact.evidence.length)
  ) {
    throw new BadRequestException('Economic impact requires source evidence');
  }
  if (
    input.capabilityIds !== undefined &&
    (!Array.isArray(input.capabilityIds) ||
      input.capabilityIds.length > 100 ||
      input.capabilityIds.some((id) => !UUID.test(id)))
  ) {
    throw new BadRequestException('capabilityIds must identify at most 100 capabilities');
  }
  return {
    ...('country' in input ? { country: input.country?.toUpperCase() ?? null } : {}),
    ...('siteRole' in input ? { siteRole: input.siteRole ?? null } : {}),
    ...('siteStatus' in input ? { siteStatus: input.siteStatus ?? null } : {}),
    ...('siteVerificationStatus' in input
      ? { siteVerificationStatus: input.siteVerificationStatus ?? 'unverified' }
      : {}),
    ...('sourceObservedAt' in input
      ? { sourceObservedAt: input.sourceObservedAt ? new Date(input.sourceObservedAt) : null }
      : {}),
    ...('sourceEvidence' in input
      ? { sourceEvidence: input.sourceEvidence as Prisma.InputJsonValue }
      : {}),
    ...('verifiedPoint' in input
      ? {
          verifiedPoint:
            input.verifiedPoint == null
              ? Prisma.JsonNull
              : (input.verifiedPoint as unknown as Prisma.InputJsonValue),
        }
      : {}),
    ...('economicImpact' in input
      ? {
          economicImpact:
            input.economicImpact == null
              ? Prisma.JsonNull
              : (input.economicImpact as Prisma.InputJsonValue),
        }
      : {}),
  };
}
