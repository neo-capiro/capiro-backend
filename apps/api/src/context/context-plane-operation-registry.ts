import {
  defineContextOperation,
  type ContextAwareOperationRegistration,
  type ContextSurface as PacketContextSurface,
  validateContextOperationRegistry,
} from '@capiro/meriv2-core';
import type { ContextSurface as ResolverContextSurface } from './context-resolver.types.js';

/**
 * API-side inventory of every context-aware AI operation family named by the
 * Knowledge Plane adoption plan. Phases 19-25 have now adopted every product;
 * there are no reviewed legacy exceptions or legacy-path declarations left for
 * production code to use.
 */
export interface ContextPlaneOperationRegistration {
  registration: ContextAwareOperationRegistration;
  /** Resolver surface can be more specific than the compiler's surface vocabulary. */
  resolverSurface: ResolverContextSurface;
  owner: string;
}

function governedOperation(input: {
  id: string;
  product: string;
  packetSurface: PacketContextSurface;
  resolverSurface: ResolverContextSurface;
}): ContextPlaneOperationRegistration {
  return {
    registration: defineContextOperation({
      id: input.id,
      product: input.product,
      surface: input.packetSurface,
    }),
    resolverSurface: input.resolverSurface,
    owner: input.product,
  };
}

export const CONTEXT_PLANE_OPERATIONS: readonly ContextPlaneOperationRegistration[] = [
  governedOperation({
    id: 'meri.chat',
    product: 'meri',
    packetSurface: 'chat',
    resolverSurface: 'chat',
  }),
  governedOperation({
    id: 'meri.research',
    product: 'meri',
    packetSurface: 'research',
    resolverSurface: 'research',
  }),
  governedOperation({
    id: 'research.generate-report',
    product: 'research',
    packetSurface: 'research',
    resolverSurface: 'research',
  }),
  governedOperation({
    id: 'outreach.generate',
    product: 'outreach',
    packetSurface: 'outreach',
    resolverSurface: 'outreach',
  }),
  governedOperation({
    id: 'workspace.generate',
    product: 'workspace',
    packetSurface: 'workspace-gen',
    resolverSurface: 'workspace-gen',
  }),
  governedOperation({
    id: 'workspace.editor-assist',
    product: 'workspace',
    packetSurface: 'workspace-editor',
    resolverSurface: 'workspace-editor',
  }),
  governedOperation({
    id: 'legiwatch.generate-report',
    product: 'legiwatch',
    packetSurface: 'memo',
    resolverSurface: 'legiwatch',
  }),
  governedOperation({
    id: 'crm.fill-with-meri',
    product: 'crm',
    packetSurface: 'research',
    resolverSurface: 'client-profile',
  }),
  governedOperation({
    id: 'meetings.prep-debrief',
    product: 'meetings',
    packetSurface: 'memo',
    resolverSurface: 'engagement',
  }),
  governedOperation({
    id: 'strategies.generate',
    product: 'strategies',
    packetSurface: 'strategy',
    resolverSurface: 'strategy',
  }),
] as const;

validateContextOperationRegistry(CONTEXT_PLANE_OPERATIONS.map((entry) => entry.registration));
for (const entry of CONTEXT_PLANE_OPERATIONS) {
  if (entry.registration.mode !== 'packet_required') {
    throw new Error(`context_operation_migration_debt_remains:${entry.registration.id}`);
  }
}

const OPERATION_BY_ID = new Map(
  CONTEXT_PLANE_OPERATIONS.map((entry) => [entry.registration.id, entry] as const),
);

export function contextPlaneOperation(
  operationId: string,
): ContextPlaneOperationRegistration | undefined {
  return OPERATION_BY_ID.get(operationId);
}
