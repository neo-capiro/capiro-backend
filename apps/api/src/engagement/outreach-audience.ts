import { Prisma } from '@prisma/client';

export type OutreachDirection = 'on-behalf' | 'to-clients';

const workflowPath = ['workflow', 'state', 'direction'];
const legacyPath = ['direction'];

const equals = (path: string[], value: OutreachDirection): Prisma.OutreachRecordWhereInput => ({
  metadata: { path, equals: value },
});

/** Include both SQL/missing-path and JSON null; NOT alone does not match SQL null. */
const unspecified = (path: string[]): Prisma.OutreachRecordWhereInput => ({
  OR: [
    { metadata: { path, equals: Prisma.AnyNull } },
    { AND: [
      { NOT: equals(path, 'on-behalf') },
      { NOT: equals(path, 'to-clients') },
    ] },
  ],
});

/**
 * Canonical compatibility: workflow direction wins over stale legacy metadata. Without a valid
 * saved direction, every legacy type retains Core's on-behalf default, including follow_up/prep.
 * The old OS's type-based fallback is deliberately not adopted. This is a read predicate only;
 * client association, recipient email and campaign category never infer audience.
 */
export function outreachAudienceWhere(direction: OutreachDirection): Prisma.OutreachRecordWhereInput {
  return {
    OR: [
      equals(workflowPath, direction),
      { AND: [
        unspecified(workflowPath),
        direction === 'to-clients'
          ? equals(legacyPath, direction)
          : { OR: [equals(legacyPath, direction), unspecified(legacyPath)] },
      ] },
    ],
  };
}
