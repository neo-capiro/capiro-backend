import { describe, expect, it, jest } from '@jest/globals';
import { EvaluationQueryService } from './evaluation-query.service.js';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '99999999-9999-4999-8999-999999999999';
const USER_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * Behavioral isolation spec, same style as
 * `quality-telemetry-tenant-isolation.spec.ts`: a fake DB seeded with rows
 * for TWO tenants sharing the same artifactId, asserting a tenant-A-scoped
 * query never returns tenant B's rows even when the raw where-clause is
 * otherwise identical. Complements (does not replace) the static
 * `tenant-scope-guard.spec.ts` census, which already auto-covers
 * EvaluationRecord because it carries a `tenantId` field.
 */
function fakeScopedPrisma(rows: {
  records: Array<{
    id: string;
    tenantId: string;
    treatmentArtifactType: string;
    treatmentArtifactId: string;
    surface: string;
    operation: string;
    status: string;
    skipReason: string | null;
    metricsJsonb: unknown;
    observedAt: Date;
    completedAt: Date | null;
  }>;
}) {
  return {
    withTenant: jest.fn(async (tenantId: string, fn: (tx: unknown) => unknown) => {
      const tx = {
        evaluationRecord: {
          findMany: jest.fn(
            async (args: {
              where: { tenantId: string; treatmentArtifactType?: string; treatmentArtifactId?: string };
            }) =>
              rows.records.filter(
                (r) =>
                  r.tenantId === tenantId &&
                  r.tenantId === args.where.tenantId &&
                  (!args.where.treatmentArtifactType || r.treatmentArtifactType === args.where.treatmentArtifactType) &&
                  (!args.where.treatmentArtifactId || r.treatmentArtifactId === args.where.treatmentArtifactId),
              ),
          ),
        },
      };
      return fn(tx);
    }),
  };
}

describe('EvaluationQueryService tenant isolation', () => {
  it("tenant A's artifact evaluations never include tenant B's rows for the SAME artifactType/artifactId", async () => {
    const artifactId = 'shared-collision-id';
    const prisma = fakeScopedPrisma({
      records: [
        {
          id: 'eval-a',
          tenantId: TENANT_A,
          treatmentArtifactType: 'outreach_draft_version',
          treatmentArtifactId: artifactId,
          surface: 'outreach',
          operation: 'outreach.draft_version.generate',
          status: 'completed',
          skipReason: null,
          metricsJsonb: { normalizedEditDistance: 0.1 },
          observedAt: new Date('2026-08-01'),
          completedAt: new Date('2026-08-01'),
        },
        {
          id: 'eval-b',
          tenantId: TENANT_B,
          treatmentArtifactType: 'outreach_draft_version',
          treatmentArtifactId: artifactId,
          surface: 'outreach',
          operation: 'outreach.draft_version.generate',
          status: 'skipped',
          skipReason: 'not_sampled',
          metricsJsonb: null,
          observedAt: new Date('2026-08-02'),
          completedAt: null,
        },
      ],
    });
    const service = new EvaluationQueryService(prisma as never);

    const evalsA = await service.getArtifactEvaluations(
      { tenantId: TENANT_A, userId: USER_A } as never,
      'outreach_draft_version',
      artifactId,
    );
    expect(evalsA.map((e) => e.id)).toEqual(['eval-a']);
    expect(evalsA[0]?.status).toBe('completed');

    const evalsB = await service.getArtifactEvaluations(
      { tenantId: TENANT_B, userId: USER_A } as never,
      'outreach_draft_version',
      artifactId,
    );
    expect(evalsB.map((e) => e.id)).toEqual(['eval-b']);
    expect(evalsB[0]?.skipReason).toBe('not_sampled');
  });
});
