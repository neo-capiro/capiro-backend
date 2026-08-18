import {
  defineContextMigrationException,
  type ContextAwareOperationRegistration,
  type ContextSurface as PacketContextSurface,
  validateContextOperationRegistry,
} from '@capiro/meriv2-core';
import type { ContextSurface as ResolverContextSurface } from './context-resolver.types.js';

/**
 * API-side inventory of the context-aware AI operation families named by the
 * Knowledge Plane plan. Phase 18 makes legacy ownership explicit; Phases 19-25
 * delete these exceptions as each product adopts the shared Context Plane.
 */
export interface ContextPlaneOperationRegistration {
  registration: ContextAwareOperationRegistration;
  /** Resolver surface can be more specific than the compiler's historic surface vocabulary. */
  resolverSurface: ResolverContextSurface;
  owner: string;
  /** Concrete implementation areas audited as legacy context/RAG debt. */
  legacyPaths: readonly string[];
}

const APPROVAL_BASIS = 'knowledge-plane-phase-sequence';

function migrationOperation(input: {
  id: string;
  product: string;
  packetSurface: PacketContextSurface;
  resolverSurface: ResolverContextSurface;
  targetPhase: number;
  exceptionId: string;
  reason: string;
  legacyPaths: readonly string[];
}): ContextPlaneOperationRegistration {
  return {
    registration: defineContextMigrationException({
      id: input.id,
      product: input.product,
      surface: input.packetSurface,
      exception: {
        id: input.exceptionId,
        targetPhase: input.targetPhase,
        reason: input.reason,
        approvalBasis: APPROVAL_BASIS,
      },
    }),
    resolverSurface: input.resolverSurface,
    owner: input.product,
    legacyPaths: input.legacyPaths,
  };
}

export const CONTEXT_PLANE_OPERATIONS: readonly ContextPlaneOperationRegistration[] = [
  migrationOperation({
    id: 'meri.chat',
    product: 'meri',
    packetSurface: 'chat',
    resolverSurface: 'chat',
    targetPhase: 19,
    exceptionId: 'phase19-meri-chat-adoption',
    reason: 'Meri reasoning cutover to ContextPacket V2 is Phase 19.',
    legacyPaths: [
      'apps/api/src/meri/meri.service.ts',
      'apps/api/src/meri/meri-tools.service.ts',
      'apps/api/src/meri/meriv3-runtime.proxy.ts',
    ],
  }),
  migrationOperation({
    id: 'meri.research',
    product: 'meri',
    packetSurface: 'research',
    resolverSurface: 'research',
    targetPhase: 19,
    exceptionId: 'phase19-meri-research-adoption',
    reason: 'Meri research cutover to the shared Context Plane is Phase 19.',
    legacyPaths: [
      'apps/api/src/meri/meri-research.service.ts',
      'apps/api/src/meri/governed-meri-research.factory.ts',
    ],
  }),
  migrationOperation({
    id: 'research.generate-report',
    product: 'research',
    packetSurface: 'research',
    resolverSurface: 'research',
    targetPhase: 19,
    exceptionId: 'phase19-research-report-adoption',
    reason: 'Current Meri/research report reasoning is migrated with Meri in Phase 19.',
    legacyPaths: [
      'apps/api/src/meri/meri-research.service.ts',
      'apps/api/src/meri/meri-docgen.service.ts',
    ],
  }),
  migrationOperation({
    id: 'outreach.generate',
    product: 'outreach',
    packetSurface: 'outreach',
    resolverSurface: 'outreach',
    targetPhase: 20,
    exceptionId: 'phase20-outreach-adoption',
    reason: 'Outreach ContextPacket adoption and independent retrieval retirement is Phase 20.',
    legacyPaths: [
      'apps/api/src/engagement/engagement-ai.service.ts',
      'apps/api/src/engagement/generation/**',
      'apps/api/src/engagement/outreach-job.service.ts',
    ],
  }),
  migrationOperation({
    id: 'workspace.generate',
    product: 'workspace',
    packetSurface: 'workspace-gen',
    resolverSurface: 'workspace-gen',
    targetPhase: 21,
    exceptionId: 'phase21-workspace-generation-adoption',
    reason: 'Workspace document generation adopts governed ContextPackets in Phase 21.',
    legacyPaths: ['apps/workspace/**'],
  }),
  migrationOperation({
    id: 'workspace.editor-assist',
    product: 'workspace',
    packetSurface: 'workspace-editor',
    resolverSurface: 'workspace-editor',
    targetPhase: 21,
    exceptionId: 'phase21-workspace-editor-adoption',
    reason: 'Workspace editor assistance adopts the same Context Plane in Phase 21.',
    legacyPaths: [
      'apps/api/src/workspace-assistant/workspace-assistant.service.ts',
      'apps/api/src/workspace-assistant/meriv2-orchestrator.client.ts',
    ],
  }),
  migrationOperation({
    id: 'legiwatch.generate-report',
    product: 'legiwatch',
    packetSurface: 'memo',
    resolverSurface: 'legiwatch',
    targetPhase: 22,
    exceptionId: 'phase22-legiwatch-adoption',
    reason: 'LegiWatch report/alert context cutover is Phase 22; legislative systems remain authoritative.',
    legacyPaths: [
      'apps/api/src/intelligence/alert-memo/**',
      'apps/intel-api/**',
    ],
  }),
  migrationOperation({
    id: 'crm.fill-with-meri',
    product: 'crm',
    packetSurface: 'research',
    resolverSurface: 'client-profile',
    targetPhase: 23,
    exceptionId: 'phase23-crm-adoption',
    reason: 'CRM / Fill with Meri canonical-identity and Context Plane adoption is Phase 23.',
    legacyPaths: ['apps/api/src/clients/**'],
  }),
  migrationOperation({
    id: 'meetings.prep-debrief',
    product: 'meetings',
    packetSurface: 'memo',
    resolverSurface: 'engagement',
    targetPhase: 24,
    exceptionId: 'phase24-meetings-adoption',
    reason: 'Meeting prep/debrief shared-context adoption is Phase 24.',
    legacyPaths: [
      'apps/api/src/engagement/engagement-ai.service.ts',
      'apps/api/src/engagement/notetaker/**',
      'apps/api/src/meeting-capture/**',
    ],
  }),
  migrationOperation({
    id: 'strategies.generate',
    product: 'strategies',
    packetSurface: 'strategy',
    resolverSurface: 'strategy',
    targetPhase: 25,
    exceptionId: 'phase25-strategies-adoption',
    reason: 'Strategy generation/revision ContextPacket adoption is Phase 25.',
    legacyPaths: [
      'apps/api-strategy/src/context/**',
      'apps/api-strategy/src/agents/**',
      'apps/api-strategy/src/meri/**',
    ],
  }),
] as const;

validateContextOperationRegistry(CONTEXT_PLANE_OPERATIONS.map((entry) => entry.registration));
for (const entry of CONTEXT_PLANE_OPERATIONS) {
  if (entry.legacyPaths.length === 0) {
    throw new Error(`context_operation_legacy_audit_required:${entry.registration.id}`);
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
