import {
  CONTEXT_PLANE_ENFORCEMENT_PHASE,
  defineContextMigrationException,
  defineContextOperation,
  evaluateContextOperationEnforcement,
  validateContextOperationRegistry,
} from './operation-enforcement';

describe('Knowledge Plane Phase 18 context operation enforcement', () => {
  const governed = defineContextOperation({
    id: 'future.agent.generate',
    product: 'future-agent',
    surface: 'research',
  });
  const legacy = defineContextMigrationException({
    id: 'meri.chat',
    product: 'meri',
    surface: 'chat',
    exception: {
      id: 'phase19-meri-adoption',
      targetPhase: 19,
      reason: 'Meri product-path adoption is Phase 19.',
      approvalBasis: 'knowledge-plane-phase-sequence',
    },
  });

  test('future operations are governed-packet-required by default', () => {
    expect(governed.mode).toBe('packet_required');
    expect(governed.migrationException).toBeUndefined();
  });

  test('unregistered operations fail closed before any context path can run', () => {
    expect(
      evaluateContextOperationEnforcement({
        operationId: 'rogue.rag',
        requestedSurface: 'research',
        rolloutMode: 'enforce',
      }),
    ).toMatchObject({ allowed: false, reason: 'operation_not_registered' });
  });

  test('registered operation cannot silently switch packet surface', () => {
    expect(
      evaluateContextOperationEnforcement({
        operationId: governed.id,
        requestedSurface: 'memo',
        registration: governed,
        rolloutMode: 'enforce',
        packet: { version: 2 },
      }),
    ).toMatchObject({ allowed: false, reason: 'operation_surface_mismatch' });
  });

  test('enforce mode requires a governed v2 packet for packet-required operations', () => {
    expect(
      evaluateContextOperationEnforcement({
        operationId: governed.id,
        requestedSurface: 'research',
        registration: governed,
        rolloutMode: 'enforce',
        packet: { version: 1 },
      }),
    ).toMatchObject({ allowed: false, reason: 'governed_packet_required' });

    expect(
      evaluateContextOperationEnforcement({
        operationId: governed.id,
        requestedSurface: 'research',
        registration: governed,
        rolloutMode: 'enforce',
        packet: { version: 2 },
      }),
    ).toMatchObject({ allowed: true, reason: 'governed_packet' });
  });

  test('existing off/shadow release switch is the only rollback path', () => {
    for (const rolloutMode of ['off', 'shadow'] as const) {
      expect(
        evaluateContextOperationEnforcement({
          operationId: governed.id,
          requestedSurface: 'research',
          registration: governed,
          rolloutMode,
          packet: { version: 1 },
        }),
      ).toMatchObject({ allowed: true, reason: 'release_switch_rollback' });
    }
  });

  test('reviewed migration exceptions are phase-bounded and automatically expire', () => {
    expect(CONTEXT_PLANE_ENFORCEMENT_PHASE).toBe(18);
    expect(
      evaluateContextOperationEnforcement({
        operationId: legacy.id,
        requestedSurface: 'chat',
        registration: legacy,
        rolloutMode: 'enforce',
        currentPhase: 18,
      }),
    ).toMatchObject({
      allowed: true,
      reason: 'migration_exception',
      migrationTargetPhase: 19,
    });

    expect(
      evaluateContextOperationEnforcement({
        operationId: legacy.id,
        requestedSurface: 'chat',
        registration: legacy,
        rolloutMode: 'enforce',
        currentPhase: 19,
      }),
    ).toMatchObject({ allowed: false, reason: 'migration_exception_expired' });
  });

  test('registry rejects duplicate, wildcard and unreviewed exceptions', () => {
    expect(() => validateContextOperationRegistry([governed, governed])).toThrow(
      'context_operation_duplicate',
    );

    expect(() =>
      defineContextMigrationException({
        id: 'workspace.*',
        product: 'workspace',
        surface: 'workspace-gen',
        exception: {
          id: 'wildcard',
          targetPhase: 20,
          reason: 'no',
          approvalBasis: 'knowledge-plane-phase-sequence',
        },
      }),
    ).toThrow('context_operation_invalid_id');

    expect(() =>
      defineContextMigrationException({
        id: 'workspace.generate',
        product: 'workspace',
        surface: 'workspace-gen',
        exception: {
          id: 'phase20-workspace-adoption',
          targetPhase: 20,
          reason: '',
          approvalBasis: '',
        },
      }),
    ).toThrow('context_operation_exception_review_required');
  });
});
