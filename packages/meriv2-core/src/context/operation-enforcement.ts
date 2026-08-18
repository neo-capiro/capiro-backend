import type { CompiledContextPacket, ContextSurface } from './contract';
import type { ContextPacketMode } from './context-release-switch';

/**
 * Knowledge Plane Phase 18 is the architectural enforcement boundary. Product
 * migrations happen in later phases, but every context-aware AI operation must
 * be registered here first and must either consume the governed Context Plane or
 * carry one explicit, phase-bounded migration exception.
 */
export const CONTEXT_PLANE_ENFORCEMENT_PHASE = 18 as const;

export type ContextOperationMode = 'packet_required' | 'migration_exception';

export interface ContextMigrationException {
  /** Stable review identifier; never a wildcard. */
  id: string;
  /** The adoption phase that must remove this exception. */
  targetPhase: number;
  /** Why the legacy path still exists during Phase 18. */
  reason: string;
  /** Evidence that this is part of the reviewed phased rollout, not an ad-hoc bypass. */
  approvalBasis: string;
}

export interface ContextAwareOperationRegistration {
  /** Stable operation identity, e.g. "meri.chat". */
  id: string;
  product: string;
  /** The canonical ContextPacket/compiler surface. */
  surface: ContextSurface;
  mode: ContextOperationMode;
  migrationException?: ContextMigrationException;
}

export type ContextOperationDecisionReason =
  | 'governed_packet'
  | 'release_switch_rollback'
  | 'migration_exception'
  | 'operation_not_registered'
  | 'operation_surface_mismatch'
  | 'operation_scope_mismatch'
  | 'governed_packet_required'
  | 'migration_exception_expired';

export interface ContextOperationEnforcementDecision {
  allowed: boolean;
  reason: ContextOperationDecisionReason;
  operationId: string;
  surface: ContextSurface | null;
  mode: ContextOperationMode | null;
  migrationExceptionId: string | null;
  migrationTargetPhase: number | null;
}

export interface EvaluateContextOperationInput {
  operationId: string;
  requestedSurface: ContextSurface;
  registration?: ContextAwareOperationRegistration;
  rolloutMode: ContextPacketMode;
  packet?: Pick<CompiledContextPacket, 'version'> | null;
  /** Injectable phase for exception-expiry tests; defaults to Phase 18. */
  currentPhase?: number;
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** Future operations are governed-packet-required by default. */
export function defineContextOperation(
  input: Omit<ContextAwareOperationRegistration, 'mode' | 'migrationException'>,
): ContextAwareOperationRegistration {
  return validateRegistration({ ...input, mode: 'packet_required' });
}

/**
 * Explicit legacy migration escape hatch. It expires automatically when the
 * target adoption phase begins; there is no indefinite or wildcard bypass.
 */
export function defineContextMigrationException(
  input: Omit<ContextAwareOperationRegistration, 'mode' | 'migrationException'> & {
    exception: ContextMigrationException;
  },
): ContextAwareOperationRegistration {
  return validateRegistration({
    id: input.id,
    product: input.product,
    surface: input.surface,
    mode: 'migration_exception',
    migrationException: input.exception,
  });
}

export function validateContextOperationRegistry(
  registrations: readonly ContextAwareOperationRegistration[],
): void {
  const seen = new Set<string>();
  for (const registration of registrations) {
    validateRegistration(registration);
    if (seen.has(registration.id)) {
      throw new Error(`context_operation_duplicate:${registration.id}`);
    }
    seen.add(registration.id);
  }
}

export function evaluateContextOperationEnforcement(
  input: EvaluateContextOperationInput,
): ContextOperationEnforcementDecision {
  const registration = input.registration;
  if (!registration || registration.id !== input.operationId) {
    return denied(input.operationId, 'operation_not_registered');
  }

  validateRegistration(registration);

  if (registration.surface !== input.requestedSurface) {
    return {
      ...baseDecision(registration),
      allowed: false,
      reason: 'operation_surface_mismatch',
    };
  }

  if (registration.mode === 'migration_exception') {
    const exception = registration.migrationException!;
    const currentPhase = input.currentPhase ?? CONTEXT_PLANE_ENFORCEMENT_PHASE;
    if (currentPhase >= exception.targetPhase) {
      return {
        ...baseDecision(registration),
        allowed: false,
        reason: 'migration_exception_expired',
      };
    }
    return {
      ...baseDecision(registration),
      allowed: true,
      reason: 'migration_exception',
    };
  }

  // The existing release switch is the sole rollback mechanism. Off/shadow is
  // therefore allowed only for a REGISTERED operation, and is auditable as a
  // rollback rather than misrepresented as governed V2 consumption.
  if (input.rolloutMode !== 'enforce') {
    return {
      ...baseDecision(registration),
      allowed: true,
      reason: 'release_switch_rollback',
    };
  }

  if (!input.packet || input.packet.version !== 2) {
    return {
      ...baseDecision(registration),
      allowed: false,
      reason: 'governed_packet_required',
    };
  }

  return {
    ...baseDecision(registration),
    allowed: true,
    reason: 'governed_packet',
  };
}

function validateRegistration(
  registration: ContextAwareOperationRegistration,
): ContextAwareOperationRegistration {
  if (!ID_PATTERN.test(registration.id) || registration.id.includes('*')) {
    throw new Error(`context_operation_invalid_id:${registration.id}`);
  }
  if (!registration.product.trim()) {
    throw new Error(`context_operation_product_required:${registration.id}`);
  }

  if (registration.mode === 'packet_required') {
    if (registration.migrationException) {
      throw new Error(`context_operation_exception_on_packet_required:${registration.id}`);
    }
    return registration;
  }

  const exception = registration.migrationException;
  if (!exception) {
    throw new Error(`context_operation_exception_required:${registration.id}`);
  }
  if (!ID_PATTERN.test(exception.id) || exception.id.includes('*')) {
    throw new Error(`context_operation_invalid_exception_id:${registration.id}`);
  }
  if (!exception.reason.trim() || !exception.approvalBasis.trim()) {
    throw new Error(`context_operation_exception_review_required:${registration.id}`);
  }
  if (
    !Number.isInteger(exception.targetPhase) ||
    exception.targetPhase <= CONTEXT_PLANE_ENFORCEMENT_PHASE
  ) {
    throw new Error(`context_operation_invalid_target_phase:${registration.id}`);
  }
  return registration;
}

function baseDecision(
  registration: ContextAwareOperationRegistration,
): Omit<ContextOperationEnforcementDecision, 'allowed' | 'reason'> {
  return {
    operationId: registration.id,
    surface: registration.surface,
    mode: registration.mode,
    migrationExceptionId: registration.migrationException?.id ?? null,
    migrationTargetPhase: registration.migrationException?.targetPhase ?? null,
  };
}

function denied(
  operationId: string,
  reason: ContextOperationDecisionReason,
): ContextOperationEnforcementDecision {
  return {
    allowed: false,
    reason,
    operationId,
    surface: null,
    mode: null,
    migrationExceptionId: null,
    migrationTargetPhase: null,
  };
}
