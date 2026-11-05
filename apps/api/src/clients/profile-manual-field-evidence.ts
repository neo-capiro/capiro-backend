import { BadRequestException } from '@nestjs/common';
import { z } from 'zod';
import { REGISTRATION_FIELDS, type RegistrationField } from './profile-suggestion.contracts.js';

const citation = z
  .object({
    label: z.string().trim().min(1).max(300),
    url: z
      .string()
      .url()
      .max(2048)
      .refine((value) => ['http:', 'https:'].includes(new URL(value).protocol))
      .optional(),
    attachmentId: z.string().uuid().optional(),
    excerpt: z.string().trim().min(1).max(1200),
    source: z.string().trim().max(80).optional(),
    observedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
const selected = z
  .object({ code: z.string().trim().min(1).max(20), evidence: z.array(citation).min(1).max(6) })
  .strict();
const fieldEvidenceSchema = z
  .object(
    Object.fromEntries(
      REGISTRATION_FIELDS.map((key) => [key, z.array(selected).max(100).optional()]),
    ) as Record<RegistrationField, z.ZodOptional<z.ZodArray<typeof selected>>>,
  )
  .strict();
export type ManualFieldEvidence = Partial<Record<RegistrationField, z.infer<typeof selected>[]>>;

/** A person's explicit code choice may retain citations, but cannot assert official verification. */
export function parseManualFieldEvidence(
  raw: unknown,
  fields: Record<string, unknown>,
): ManualFieldEvidence | undefined {
  if (raw === undefined) return undefined;
  const parsed = fieldEvidenceSchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException('Invalid accepted code evidence');
  for (const [key, entries] of Object.entries(parsed.data)) {
    const value = fields[key];
    const selectedValues = new Set(
      (Array.isArray(value) ? value : [value])
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim().toUpperCase()),
    );
    for (const entry of entries ?? []) {
      entry.code = entry.code.toUpperCase();
      if (!selectedValues.has(entry.code))
        throw new BadRequestException(
          'Code evidence must match a value explicitly saved in the same request',
        );
    }
  }
  return parsed.data;
}

export function manualCodeEvidence(input: ManualFieldEvidence | undefined, key: string) {
  const entries = input?.[key as RegistrationField] ?? [];
  return entries.flatMap((entry) =>
    entry.evidence.map((evidence) => ({
      ...evidence,
      code: entry.code,
      sourceType: 'person_reviewed_suggestion' as const,
    })),
  );
}
