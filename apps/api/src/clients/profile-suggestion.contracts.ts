import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { researchWebsite } from './client-profile-fill-research-inputs.js';

export const REGISTRATION_FIELDS = [
  'uei',
  'cageCode',
  'naicsCodes',
  'pscCodes',
  'issueCodes',
] as const;
export type RegistrationField = (typeof REGISTRATION_FIELDS)[number];
const subject = z.object({ kind: z.enum(['client', 'prospect']), id: z.string().uuid() }).strict();
const requestSchema = z
  .object({
    requestId: z.string().uuid(),
    field: z.enum(REGISTRATION_FIELDS),
    identity: z
      .object({
      name: z.string().trim().min(1).max(300),
        website: z.string().max(2048).optional(),
        description: z.string().max(6000).optional(),
      })
      .strict(),
    currentValue: z.union([z.string().max(100), z.array(z.string().max(100)).max(100)]).optional(),
    existingIdentifiers: z
      .object({ uei: z.string().max(12).optional(), cageCode: z.string().max(5).optional() })
      .strict()
      .optional(),
    contextText: z.string().max(12000).optional(),
    subject: subject.optional(),
    attachmentIds: z.array(z.string().uuid()).max(3).optional(),
  })
  .strict();
export type RegistrationSuggestionRequest = z.infer<typeof requestSchema>;
export function parseRegistrationSuggestionRequest(raw: unknown): RegistrationSuggestionRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException('Invalid registration suggestion request');
  const input = parsed.data;
  if (input.attachmentIds?.length && !input.subject)
    throw new BadRequestException('A saved profile is required for selected documents');
  if (input.identity.website?.trim())
    input.identity.website = researchWebsite(input.identity.website) ?? undefined;
  return input;
}

export interface RegistrationSuggestionEvidence {
  label: string;
  url?: string;
  attachmentId?: string;
  excerpt: string;
  source: string;
  observedAt: string;
}
export interface RegistrationSuggestion {
  code: string;
  label: string;
  reason: string;
  confidence: number;
  evidence: RegistrationSuggestionEvidence[];
  reference?: Record<string, unknown>;
}
export interface RegistrationSuggestionResult {
  requestId: string;
  field: RegistrationField;
  status: 'complete' | 'empty' | 'unavailable';
  message: string;
  suggestions: RegistrationSuggestion[];
  sourceGaps: string[];
}
