import { assertMeriCase12BindingInTx } from './meri-case12-capture-authority.js';
import {
  MERI_FIXTURE_SEMANTIC_INSTANT,
  MERI_FIXTURE_SEMANTIC_ZONE,
  validateMeriFixtureSemanticClock,
  type MeriFixtureSemanticClock,
  type MeriServerReadonlyCapturePolicy,
  type MeriGovernedArtifactCapturePolicy,
} from '@capiro/meriv2-core';
import type { TenantContext } from '@capiro/shared';
import type { PrismaService } from '../prisma/prisma.service.js';
import { qualifyMeriCase01CaptureFixture } from './meri-case01-capture-authority.js';
import { assertMeriCase14BindingInTx } from './meri-case14-capture-authority.js';
import { assertMeriControlledReadBindingInTx } from './meri-controlled-read-fixture.js';
import { assertMeriServerReadonlyCaptureCurrentAuthority } from './meri-server-readonly-capture.js';
import { issueCurrentCase46Policy } from './meri-case46-provider-budget-owner.js';
import { case46BudgetHash } from './meri-case46-provider-budget.js';
import { requireCase46Owner } from './meri-case46-turn-owner.js';
import type { Case46AuthorityDependencies } from './meri-case46-authority.js';

/** Fixed original-fixture semantics, minted only after the existing canonical
 * owner requalifies the current binding. Accounting authority alone is insufficient. */
export async function qualifyMeriCaptureSemanticClock(args: {
  prisma: PrismaService;
  ctx: TenantContext;
  policy: MeriServerReadonlyCapturePolicy | null;
  artifactPolicy?: MeriGovernedArtifactCapturePolicy | null;
  case46?: Case46AuthorityDependencies;
}): Promise<MeriFixtureSemanticClock | undefined> {
  const { policy, artifactPolicy, prisma, ctx } = args;
  if (policy && artifactPolicy) throw new Error('meri_fixture_semantic_clock_authority_conflict');
  let binding: { caseId: string | null; captureRunId: string | null; issuedAt: number };
  let currentVerifySha256: string;
  if (artifactPolicy) {
    const current = await issueCurrentCase46Policy(requireCase46Owner(args.case46), {
      ctx,
      conversationId: artifactPolicy.conversationId,
    });
    if (!current || case46BudgetHash(current) !== case46BudgetHash(artifactPolicy))
      throw new Error('meri_fixture_semantic_clock_current_artifact_changed');
    binding = artifactPolicy;
    currentVerifySha256 = current.currentVerifySha256;
  } else {
    if (!policy) return undefined;
    if (policy.semanticClock) validateMeriFixtureSemanticClock(policy.semanticClock, policy);
    if (
      policy.syntheticReadBudget ||
      !policy.caseId ||
      policy.fixtureVersion !== 'meri-live-v1-2026-09-26.1'
    )
      return undefined;
    // The clock adds no new admitted case, source or provider capability.
    if (!['01', '12', '14', '20', '72'].includes(policy.caseId))
      throw new Error('meri_fixture_semantic_clock_case_not_qualified');
    await assertMeriServerReadonlyCaptureCurrentAuthority({ prisma, ctx, policy });
    const proof: { currentVerifySha256: string } =
      policy.caseId === '01'
        ? await qualifyMeriCase01CaptureFixture({ prisma, ctx, policy })
        : await prisma.withTenantUser<{ currentVerifySha256: string }>(
            ctx.tenantId,
            ctx.userId,
            async (tx) => {
              if (policy.caseId === '12')
                return await assertMeriCase12BindingInTx(prisma, tx, ctx, policy);
              if (policy.caseId === '14')
                return await assertMeriCase14BindingInTx(prisma, tx, ctx, policy);
              return await assertMeriControlledReadBindingInTx(tx, ctx, policy);
            },
          );
    await assertMeriServerReadonlyCaptureCurrentAuthority({ prisma, ctx, policy });
    binding = policy;
    currentVerifySha256 = proof.currentVerifySha256;
  }
  const clock = validateMeriFixtureSemanticClock(
    {
      version: 1,
      kind: 'qualified_original_fixture_semantic_clock',
      instant: MERI_FIXTURE_SEMANTIC_INSTANT,
      timeZone: MERI_FIXTURE_SEMANTIC_ZONE,
      caseId: binding.caseId as MeriFixtureSemanticClock['caseId'],
      captureRunId: binding.captureRunId!,
      currentVerifySha256,
      observedAt: binding.issuedAt,
    },
    binding,
  );
  if (policy?.semanticClock && policy.semanticClock.currentVerifySha256 !== currentVerifySha256)
    throw new Error('meri_fixture_semantic_clock_current_fixture_changed');
  return Object.freeze(clock);
}
