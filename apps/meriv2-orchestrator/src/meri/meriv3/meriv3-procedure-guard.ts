import type {
  MeriGovernedProcedureBinding,
  MeriGovernedTurnContext,
  ToolRegistry,
} from '@capiro/meriv2-core';
import type { MeriV3ChatInput } from './meriv3.types.js';

const MAX_BINDING_LIFETIME_MS = 5 * 60_000;
const MAX_ARRAY_ENTRIES = 32;
const COMMITMENTS_CASES = ['CD-01', 'CD-02', 'CD-03', 'CD-04', 'CD-05', 'CD-06', 'CD-07'];

export class MeriProcedureBindingError extends Error {
  readonly name = 'MeriProcedureBindingError';
}

function fail(): never {
  throw new MeriProcedureBindingError('Served procedure binding is invalid or no longer current');
}

function boundedStrings(value: unknown, min = 0): value is string[] {
  return (
    Array.isArray(value) &&
    value.length >= min &&
    value.length <= MAX_ARRAY_ENTRIES &&
    value.every((entry) => typeof entry === 'string' && entry.length > 0 && entry.length <= 500) &&
    new Set(value).size === value.length
  );
}

function sameMembers(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

/** Validate the signed projection against the authenticated actor and request. */
export function requireMeriProcedureBinding(input: {
  governed: MeriGovernedTurnContext;
  dto: MeriV3ChatInput;
  tenantId: string;
  now?: number;
}): MeriGovernedProcedureBinding | null {
  const procedure = input.governed.procedure;
  if (!procedure) return null;
  const now = input.now ?? Date.now();
  const expectedScope = input.dto.clientId ? 'client' : 'general';
  if (
    procedure.version !== 1 ||
    procedure.tenantId !== input.tenantId ||
    procedure.identity?.source !== 'firm' ||
    typeof procedure.identity.recordId !== 'string' ||
    !procedure.identity.recordId ||
    !/^[a-z0-9_]{2,48}$/.test(procedure.identity.canonicalId) ||
    !Number.isInteger(procedure.identity.version) ||
    procedure.identity.version <= 0 ||
    !/^[a-f0-9]{64}$/.test(procedure.manifestDigest) ||
    typeof procedure.instruction !== 'string' ||
    !procedure.instruction.trim() ||
    procedure.instruction.length > 4_000 ||
    procedure.scope !== expectedScope ||
    procedure.clientId !== (input.dto.clientId ?? null) ||
    !Number.isFinite(procedure.resolvedAt) ||
    !Number.isFinite(procedure.validUntil) ||
    procedure.resolvedAt > now + 30_000 ||
    procedure.validUntil <= now ||
    procedure.validUntil - procedure.resolvedAt > MAX_BINDING_LIFETIME_MS ||
    (procedure.policy.effectMode !== 'read_only' &&
      procedure.policy.effectMode !== 'approval_required') ||
    !boundedStrings(procedure.policy.allowedCapabilities, 1) ||
    !boundedStrings(procedure.policy.allowedTools, 1) ||
    !boundedStrings(procedure.policy.requiredTools, 1) ||
    procedure.policy.requiredTools.some((name) => !procedure.policy.allowedTools.includes(name)) ||
    !boundedStrings(procedure.contract.outputFields, 1) ||
    !boundedStrings(procedure.contract.completionChecks, 1) ||
    !boundedStrings(procedure.contract.coverageStates) ||
    !boundedStrings(procedure.contract.caseIds, 1)
  ) {
    fail();
  }
  if (procedure.clientRequired && !input.dto.clientId) fail();
  if (
    procedure.identity.canonicalId === 'commitments_audit' &&
    (!procedure.clientRequired ||
      !input.dto.clientId ||
      procedure.policy.effectMode !== 'read_only' ||
      !sameMembers(procedure.contract.caseIds, COMMITMENTS_CASES))
  ) {
    fail();
  }
  return procedure;
}

/**
 * Canonical schemas remain the authority. A procedure can only narrow the API's
 * currently authorized schemas, and every required tool must still be present.
 */
export function bindMeriProcedureSchemas<T extends { name: string }>(input: {
  procedure: MeriGovernedProcedureBinding | null;
  schemas: readonly T[];
  registry: Pick<ToolRegistry, 'get'>;
}): { schemas: T[]; requiredTools: string[] } {
  if (!input.procedure) return { schemas: [...input.schemas], requiredTools: [] };
  const allowed = new Set(input.procedure.policy.allowedTools);
  const schemas = input.schemas.filter((schema) => {
    if (!allowed.has(schema.name)) return false;
    const definition = input.registry.get(schema.name);
    return Boolean(
      definition &&
        (input.procedure!.policy.effectMode !== 'read_only' || definition.readOnly === true),
    );
  });
  const available = new Set(schemas.map((schema) => schema.name));
  if (input.procedure.policy.requiredTools.some((name) => !available.has(name))) fail();
  return { schemas, requiredTools: [...input.procedure.policy.requiredTools] };
}

/** Last-mile effect boundary. This runs immediately before every registry dispatch. */
export function assertMeriProcedureToolDispatch(input: {
  procedure: MeriGovernedProcedureBinding | null | undefined;
  toolName: string;
  readOnly: boolean | undefined;
  now?: number;
}): void {
  const procedure = input.procedure;
  if (!procedure) return;
  const now = input.now ?? Date.now();
  if (
    procedure.validUntil <= now ||
    !procedure.policy.allowedTools.includes(input.toolName) ||
    (procedure.policy.effectMode === 'read_only' && input.readOnly !== true)
  ) {
    fail();
  }
}
