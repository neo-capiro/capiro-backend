import type { MeriGovernedProcedureBinding, MeriGovernedTurnContext } from '@capiro/meriv2-core';
import {
  assertMeriProcedureToolDispatch,
  bindMeriProcedureSchemas,
  requireMeriProcedureBinding,
} from './meriv3-procedure-guard.js';

const now = 1_000_000;
function procedure(
  overrides: Partial<MeriGovernedProcedureBinding> = {},
): MeriGovernedProcedureBinding {
  return {
    version: 1,
    tenantId: 'tenant-1',
    identity: {
      source: 'firm',
      recordId: 'row-1',
      canonicalId: 'commitments_audit',
      version: 4,
    },
    manifestDigest: 'a'.repeat(64),
    instruction: 'Run the signed commitments procedure.',
    scope: 'client',
    clientId: 'client-1',
    clientRequired: true,
    resolvedAt: now,
    validUntil: now + 60_000,
    policy: {
      effectMode: 'read_only',
      allowedCapabilities: ['client.read', 'tasks.read'],
      allowedTools: ['get_client_context', 'query_tasks'],
      requiredTools: ['get_client_context', 'query_tasks'],
    },
    contract: {
      outputFields: ['auditStatus'],
      completionChecks: ['Report every source coverage state'],
      coverageStates: ['checked', 'disconnected', 'unavailable', 'not mapped'],
      caseIds: ['CD-01', 'CD-02', 'CD-03', 'CD-04', 'CD-05', 'CD-06', 'CD-07'],
    },
    ...overrides,
  };
}

function governed(binding = procedure()): MeriGovernedTurnContext {
  return { procedure: binding } as MeriGovernedTurnContext;
}

const dto = { clientId: 'client-1', messages: [{ role: 'user' as const, text: 'Audit' }] };

describe('MeriV3 served procedure guard', () => {
  it('accepts an exact signed tenant/client binding and leaves legacy turns unchanged', () => {
    expect(
      requireMeriProcedureBinding({ governed: governed(), dto, tenantId: 'tenant-1', now }),
    ).toMatchObject({ identity: { version: 4 }, clientId: 'client-1' });
    expect(
      requireMeriProcedureBinding({
        governed: {} as MeriGovernedTurnContext,
        dto,
        tenantId: 'tenant-1',
        now,
      }),
    ).toBeNull();
  });

  it.each([
    ['wrong tenant', { tenantId: 'tenant-2' }],
    ['wrong client', { clientId: 'client-2' }],
    ['stale binding', { validUntil: now }],
  ] as const)('rejects %s', (_label, changed) => {
    expect(() =>
      requireMeriProcedureBinding({
        governed: governed(procedure(changed)),
        dto,
        tenantId: 'tenant-1',
        now,
      }),
    ).toThrow('invalid or no longer current');
  });

  it('intersects all manifest-authorized readers with current schemas while keeping required tools mandatory', () => {
    const get = jest.fn((name: string) =>
      name === 'send_email' ? { readOnly: false } : { readOnly: true },
    );
    const bound = bindMeriProcedureSchemas({
      procedure: procedure({
        policy: {
          ...procedure().policy,
          allowedCapabilities: ['client.read', 'tasks.read', 'meetings.read'],
          allowedTools: [
            'get_client_context',
            'query_tasks',
            'list_upcoming_meetings',
            'send_email',
          ],
        },
      }),
      schemas: [
        { name: 'get_client_context' },
        { name: 'query_tasks' },
        { name: 'list_upcoming_meetings' },
        { name: 'send_email' },
        { name: 'search_public_web' },
      ],
      registry: { get } as never,
    });
    expect(bound.schemas).toEqual([
      { name: 'get_client_context' },
      { name: 'query_tasks' },
      { name: 'list_upcoming_meetings' },
    ]);
    expect(bound.requiredTools).toEqual(['get_client_context', 'query_tasks']);
  });

  it('fails closed when an authorized required read is no longer available', () => {
    expect(() =>
      bindMeriProcedureSchemas({
        procedure: procedure(),
        schemas: [{ name: 'get_client_context' }],
        registry: { get: () => ({ readOnly: true }) } as never,
      }),
    ).toThrow('invalid or no longer current');
  });

  it('allows an authorized read and blocks writes at the actual dispatch boundary', () => {
    expect(() =>
      assertMeriProcedureToolDispatch({
        procedure: procedure(),
        toolName: 'query_tasks',
        readOnly: true,
        now,
      }),
    ).not.toThrow();
    expect(() =>
      assertMeriProcedureToolDispatch({
        procedure: procedure({
          policy: { ...procedure().policy, allowedTools: ['query_tasks', 'send_email'] },
        }),
        toolName: 'send_email',
        readOnly: false,
        now,
      }),
    ).toThrow('invalid or no longer current');
  });
});
