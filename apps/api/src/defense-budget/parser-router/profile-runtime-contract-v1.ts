/** Strict cross-language contract for the cheap PDF profiling command. */
import { z } from 'zod';
import { jsonValueSchema, sha256Schema } from '../contracts/extraction-artifact-v1.js';

export const DEFENSE_BUDGET_PROFILE_JOB_SCHEMA_VERSION = 'defense_budget_profile_job_v1' as const;

const sortedUniquePositivePages = z
  .array(z.number().int().positive())
  .refine((pages) => pages.every((page, index) => index === 0 || page > pages[index - 1]!), {
    message: 'requestedPages must be sorted and unique',
  });

export const parserProfileJobV1Schema = z
  .object({
    schemaVersion: z.literal(DEFENSE_BUDGET_PROFILE_JOB_SCHEMA_VERSION),
    jobId: z.string().min(1),
    sourcePath: z.string().min(1),
    sourceSha256: sha256Schema,
    engine: z.literal('deterministic_pdfplumber'),
    allPages: z.boolean(),
    requestedPages: sortedUniquePositivePages,
    parserVersion: z.string().min(1),
    parserConfig: jsonValueSchema,
    parserConfigSha256: sha256Schema,
    outputDirectory: z.string().min(1),
    includeDebugArtifacts: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.allPages && value.requestedPages.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedPages'],
        message: 'allPages=true requires an empty requestedPages list',
      });
    }
    if (!value.allPages && value.requestedPages.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['requestedPages'],
        message: 'allPages=false requires at least one requested page',
      });
    }
  });

export type ParserProfileJobV1 = z.infer<typeof parserProfileJobV1Schema>;

export function parseParserProfileJobV1(input: unknown): ParserProfileJobV1 {
  return parserProfileJobV1Schema.parse(input);
}
