/**
 * Backward-compatible Phase 5 supplement for MILCON identity.
 *
 * The Phase 1 union predates Phase 5 and carries project/component/location.
 * Phase 5 additionally owns appropriation/account through the reviewed annual
 * manifest. This strict supplement joins those facts without changing the V1
 * artifact schema and is the identity used by verification/projection/schema.
 */
import { z } from 'zod';
import { budgetComponentV1Schema } from '../contracts/extraction-artifact-v1.js';

const nonBlank = z
  .string()
  .min(1)
  .refine((value) => value.trim().length > 0, {
    message: 'must be nonblank',
  });
const concreteComponent = budgetComponentV1Schema.refine(
  (component) => component !== 'UNKNOWN' && component !== 'OTHER',
  { message: 'MILCON identity requires a concrete component' },
);

export const phase5MilconNativeIdentityV1Schema = z
  .object({
    lineKind: z.literal('MILCON_PROJECT'),
    projectCode: nonBlank,
    component: concreteComponent,
    account: nonBlank,
    location: z.string().optional(),
    printedProjectCode: nonBlank.optional(),
  })
  .strict();

export type Phase5MilconNativeIdentityV1 = z.infer<typeof phase5MilconNativeIdentityV1Schema>;

export interface ResolvedPhase5MilconNativeIdentityV1 extends Phase5MilconNativeIdentityV1 {
  naturalKey: string;
}

export function buildPhase5MilconNativeIdentityV1(
  input: Phase5MilconNativeIdentityV1,
): ResolvedPhase5MilconNativeIdentityV1 {
  const parsed = phase5MilconNativeIdentityV1Schema.parse(input);
  const projectCode = parsed.projectCode.trim().toUpperCase();
  const account = parsed.account.trim().toUpperCase();
  const location = parsed.location?.trim().toUpperCase();
  const locationPart = location && location.length > 0 ? location : 'NO_LOC';
  return {
    ...parsed,
    projectCode,
    account,
    ...(location != null && location.length > 0 ? { location } : {}),
    naturalKey: `MILCON_PROJECT:${parsed.component}:${projectCode}:${locationPart}:${account}`,
  };
}
