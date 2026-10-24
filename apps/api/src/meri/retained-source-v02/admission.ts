import { ForbiddenException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { MERI_RETAINED_SOURCE_TOOLS, canonicalSha256 } from '../../auth/read-delegation/read-delegation.contract.js';
import {
  parseRetainedReadContext, assertRetainedReadSelectors, retainedReadObject, retainedReadSnapshot,
  type RetainedReadContext,
} from '../retained-read-context.js';

export const RETAINED_SOURCE_V02_OPERATIONS: ReadonlySet<string> = MERI_RETAINED_SOURCE_TOOLS;
const CLIENT_ONLY = new Set(['read_monday_client_boards', 'get_client_context',
  'meeting.list_upcoming_meetings', 'meeting.query_debriefs', 'meeting.read_client_meetings', 'read_client_documents']);
export type AuthenticatedRetainedSourceCorrelation = RetainedReadContext;

export interface RetainedSourceV02Admission extends RetainedReadContext {
  operation: { id: string; version: '0.2.0' | '0.3.0' };
  input: Record<string, unknown>;
  metadata: unknown;
  argumentsSha256: string;
  requestSha256: string;
  clientId: string | null;
  hardExpiryMs: number;
}

/** Core's ordinary bearer/service boundary admits the request. Correlation
 * supplies selectors and output lineage; domain owners check actual access. */
export function assertRetainedSourceV02Admission(
  ctx: Pick<TenantContext, 'tenantId' | 'userId'>,
  operationId: string,
  protocol: unknown,
  correlation: unknown,
  options: { verifiedServiceIdentity: boolean; nowMs: number; deadlineMs: number },
): RetainedSourceV02Admission {
  const refuse = () => new ForbiddenException('Retained source read refused');
  if (!RETAINED_SOURCE_V02_OPERATIONS.has(operationId) || !Number.isSafeInteger(options.nowMs) ||
      !Number.isSafeInteger(options.deadlineMs) || options.deadlineMs <= options.nowMs) throw refuse();
  const context = parseRetainedReadContext(ctx, correlation, options.verifiedServiceIdentity);
  const wire = retainedReadSnapshot(retainedReadObject(protocol, ['input', 'metadata']), 16_384);
  if (!wire.input || typeof wire.input !== 'object' || Array.isArray(wire.input)) throw refuse();
  const input = wire.input as Record<string, unknown>;
  const clientId = context.subject.kind === 'client' ? context.subject.entityIds[0]! : null;
  assertRetainedReadSelectors(input, context);
  if (CLIENT_ONLY.has(operationId) && (clientId === null || input.clientId !== clientId)) throw refuse();
  if (input.subject !== undefined) {
    const selected = retainedReadObject(input.subject, clientId === null ? ['kind'] : ['kind', 'entityId']);
    if (selected.kind !== context.subject.kind || clientId !== null && selected.entityId !== clientId) throw refuse();
  } else if (clientId === null && operationId !== 'resolve_entity') throw refuse();
  return Object.freeze({ ...context,
    operation: { id: operationId, version: operationId === 'get_client_context' ? '0.3.0' as const : '0.2.0' as const },
    input, metadata: wire.metadata, argumentsSha256: canonicalSha256(input), requestSha256: canonicalSha256(wire),
    clientId, hardExpiryMs: options.deadlineMs,
  });
}
