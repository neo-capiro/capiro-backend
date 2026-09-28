import { BadRequestException, NotFoundException } from '@nestjs/common';
import { commitmentsAuditProcedureSkill } from './skills/commitments-audit.procedure.js';
import { resolveServedProcedure } from './meri-procedure-runtime.js';

const selected = {
  ...commitmentsAuditProcedureSkill,
  procedureBinding: {
    source: 'firm' as const,
    recordId: 'row-1',
    canonicalId: 'commitments_audit',
    version: 3,
  },
};

function resolver(result = selected) {
  return { resolveProcedureReference: jest.fn(async () => result) };
}

describe('served procedure API binding', () => {
  it('re-resolves the exact tenant/version uncached and derives read-only canonical tools', async () => {
    const firmSkills = resolver();
    const served = await resolveServedProcedure({
      tenantId: 'tenant-a',
      clientId: 'client-a',
      selected,
      firmSkills,
      now: 1_000,
    });

    expect(firmSkills.resolveProcedureReference).toHaveBeenCalledWith(
      'tenant-a',
      selected.procedureBinding,
    );
    expect(served?.binding).toMatchObject({
      tenantId: 'tenant-a',
      clientId: 'client-a',
      identity: { canonicalId: 'commitments_audit', version: 3 },
      manifestDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      policy: {
        effectMode: 'read_only',
        allowedTools: expect.arrayContaining(['get_client_context', 'query_tasks']),
        requiredTools: selected.requiredTools,
      },
      contract: { caseIds: ['CD-01', 'CD-02', 'CD-03', 'CD-04', 'CD-05', 'CD-06', 'CD-07'] },
    });
    expect(served?.receipt).toEqual({
      id: 'commitments_audit',
      version: 3,
      source: 'firm',
      scope: 'client',
      clientId: 'client-a',
      effectMode: 'read_only',
      caseIds: ['CD-01', 'CD-02', 'CD-03', 'CD-04', 'CD-05', 'CD-06', 'CD-07'],
      completionCheckCount: 7,
      coverageStates: ['checked', 'disconnected', 'unavailable', 'not mapped'],
    });
  });

  it('requires a client for commitments_audit even from the general launcher', async () => {
    await expect(
      resolveServedProcedure({
        tenantId: 'tenant-a',
        clientId: null,
        selected,
        firmSkills: resolver(),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each(['wrong tenant', 'stale version', 'disabled or revoked'])(
    'does not fall back to unrestricted chat for %s',
    async () => {
      const firmSkills = {
        resolveProcedureReference: jest.fn(async () => {
          throw new NotFoundException('Procedure binding is unavailable');
        }),
      };
      await expect(
        resolveServedProcedure({
          tenantId: 'tenant-b',
          clientId: 'client-a',
          selected,
          firmSkills,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('leaves a legacy or unselected turn unchanged', async () => {
    const firmSkills = resolver();
    await expect(
      resolveServedProcedure({
        tenantId: 'tenant-a',
        clientId: 'client-a',
        selected: null,
        firmSkills,
      }),
    ).resolves.toBeNull();
    expect(firmSkills.resolveProcedureReference).not.toHaveBeenCalled();
  });
});
