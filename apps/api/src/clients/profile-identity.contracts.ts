import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { researchWebsite } from './client-profile-fill-research-inputs.js';

export const identityClaimSchema = z
  .object({
    kind: z.enum(['alias', 'former_name', 'parent', 'subsidiary']),
    name: z.string().trim().min(1).max(300),
    sourceUrl: z.string().url().max(2048).optional(),
    attachmentId: z.string().uuid().optional(),
    quote: z.string().trim().min(2).max(600),
  })
  .strict()
  .refine((value) => Boolean(value.sourceUrl) !== Boolean(value.attachmentId));
export const identitySourceCandidateSchema = z
  .object({
    source: z.enum(['sam', 'lda', 'sec', 'website', 'document']),
    externalId: z.string().trim().min(1).max(2048),
    name: z.string().trim().min(1).max(300),
    website: z.string().url().max(2048).optional(),
  })
  .strict();
const previewSchema = z
  .object({
    name: z.union([z.string().trim().min(1).max(300), z.literal('')]).default(''),
    attachmentId: z.string().uuid().optional(),
    website: z.string().max(2048).optional(),
    state: z.string().max(100).optional(),
    city: z.string().max(100).optional(),
    identifiers: z
      .array(
        z
          .object({
            type: z.enum(['uei', 'cage', 'cageCode', 'cik', 'lda_client_id', 'domain']),
            value: z.string().trim().min(1).max(300),
          })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
export type ProfileIdentityInput = z.infer<typeof previewSchema>;
export type ProfileIdentityClaim = z.infer<typeof identityClaimSchema>;
export type ProfileIdentitySourceCandidate = z.infer<typeof identitySourceCandidateSchema>;
export interface ProfileIdentityEvidence {
  label: string;
  url?: string;
  attachmentId?: string;
  excerpt: string;
  observedAt: string;
  source: string;
}
export interface DiscoveredProfileIdentity {
  sourceCandidate: ProfileIdentitySourceCandidate;
  identifiers: Array<{ type: string; value: string }>;
  state?: string;
  city?: string;
  evidence: ProfileIdentityEvidence[];
  claims: ProfileIdentityClaim[];
  sourceType:
    | 'sam_entity'
    | 'lda_client'
    | 'sec_filing'
    | 'person_confirmed_website'
    | 'person_confirmed_document';
}
export function parseIdentityPreview(raw: unknown): ProfileIdentityInput {
  const result = previewSchema.safeParse(raw);
  if (!result.success) throw new BadRequestException('Invalid company identity request');
  if (result.data.website?.trim())
    result.data.website = researchWebsite(result.data.website) ?? undefined;
  else result.data.website = undefined;
  if (!result.data.name && !result.data.attachmentId && !result.data.website)
    throw new BadRequestException('Provide a company name, website or a ready identity document');
  for (const identifier of result.data.identifiers ?? [])
    if (identifier.type === 'cageCode') identifier.type = 'cage';
  for (const identifier of result.data.identifiers ?? []) {
    const pattern =
      identifier.type === 'uei'
        ? /^[a-z0-9]{12}$/i
        : identifier.type === 'cage'
          ? /^[a-z0-9]{5}$/i
          : identifier.type === 'cik' || identifier.type === 'lda_client_id'
            ? /^\d{1,10}$/
            : null;
    if (pattern && !pattern.test(identifier.value))
      throw new BadRequestException('Invalid identity identifier format');
    if (identifier.type === 'cik') identifier.value = identifier.value.padStart(10, '0');
    if (identifier.type === 'lda_client_id' && Number(identifier.value) > 2147483647)
      throw new BadRequestException('Invalid LDA identity identifier');
  }
  return result.data;
}
export function identityName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(incorporated|inc|llc|corporation|corp|limited|ltd)\b/g, '')
    .trim()
    .replace(/\s+/g, ' ');
}
export function identityDomain(value: string | undefined) {
  try {
    return value
      ? new URL(value.includes('://') ? value : `https://${value}`).hostname
          .toLowerCase()
          .replace(/^www\./, '')
      : null;
  } catch {
    return null;
  }
}
export function identityScore(input: ProfileIdentityInput, candidate: DiscoveredProfileIdentity) {
  const conflictingId = (input.identifiers ?? []).some((entered) =>
    candidate.identifiers.some(
      (found) =>
        entered.type === found.type &&
        entered.value.replace(/\W/g, '').toUpperCase() !==
          found.value.replace(/\W/g, '').toUpperCase(),
    ),
  );
  if (conflictingId) return 0.4;
  const exactId = (input.identifiers ?? []).some((entered) =>
    candidate.identifiers.some(
      (found) =>
        entered.type === found.type &&
        entered.value.replace(/\W/g, '').toUpperCase() ===
          found.value.replace(/\W/g, '').toUpperCase(),
    ),
  );
  const sameName = identityName(input.name) === identityName(candidate.sourceCandidate.name);
  const sameDomain =
    identityDomain(input.website) !== null &&
    identityDomain(input.website) === identityDomain(candidate.sourceCandidate.website);
  const sameState =
    input.state && candidate.state && input.state.toLowerCase() === candidate.state.toLowerCase();
  const sameCity =
    input.city && candidate.city && input.city.toLowerCase() === candidate.city.toLowerCase();
  return exactId
    ? 1
    : sameName && sameDomain
      ? 0.97
      : sameName && (sameState || sameCity)
        ? 0.88
        : sameName
          ? 0.8
          : 0.55;
}
