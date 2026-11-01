import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { TenantRole } from '@capiro/shared';
import {
  applicationMembershipPermissions,
  APPLICATION_FIRM_MEMORY_PROPOSAL,
} from '../../auth/application-membership.js';
import { retainedReadObject } from '../retained-read-context.js';
import { UUID, type NativeApprovalProposal } from './native-approval.contract.js';

export interface NativeMemoryArguments extends Record<string, unknown> {
  content: string;
  key: string | null;
  scope: 'personal' | 'client' | 'firm';
  clientId: string | null;
  ttlDays: number | null;
}
const invalid = () => new BadRequestException('Invalid native memory proposal');
export function parseNativeMemoryArguments(raw: unknown): NativeMemoryArguments {
  let v: Record<string, unknown>;
  try {
    v = retainedReadObject(raw, ['content', 'key', 'scope', 'clientId', 'ttlDays']);
  } catch {
    throw invalid();
  }
  if (
    typeof v.content !== 'string' ||
    !v.content ||
    v.content.trim() !== v.content ||
    v.content.length > 4000 ||
    (v.key !== null &&
      (typeof v.key !== 'string' || !v.key || v.key.trim() !== v.key || v.key.length > 120)) ||
    !['personal', 'client', 'firm'].includes(String(v.scope)) ||
    (v.scope === 'client'
      ? typeof v.clientId !== 'string' || !UUID.test(v.clientId)
      : v.clientId !== null) ||
    (v.ttlDays !== null &&
      (!Number.isSafeInteger(v.ttlDays) ||
        (v.ttlDays as number) < 1 ||
        (v.ttlDays as number) > 365))
  )
    throw invalid();
  return v as NativeMemoryArguments;
}

/** Canonical destination and proposal permission, rechecked with the current role. */
export function authorizeNativeMemory(
  p: NativeApprovalProposal,
  selected: string | null,
  role: TenantRole,
) {
  const a = parseNativeMemoryArguments(p.command.arguments);
  if (
    p.command.action !== 'memory.propose' ||
    p.command.scopes.length !== 1 ||
    p.command.attachments.length !== 0 ||
    (a.scope === 'client' && (selected === null || a.clientId !== selected)) ||
    (a.scope === 'firm' &&
      !applicationMembershipPermissions(role, p.command.binding.actorId).includes(
        APPLICATION_FIRM_MEMORY_PROPOSAL,
      ))
  )
    throw new ForbiddenException('Native memory proposal authority refused');
  return a;
}

export function nativeMemoryCandidate(p: NativeApprovalProposal) {
  const a = parseNativeMemoryArguments(p.command.arguments),
    b = p.command.binding;
  return {
    schema: 'meri.memory-candidate.v1' as const,
    candidateId: p.proposalId,
    tenantId: b.tenantId,
    proposerActorId: b.actorId,
    kind: 'addition' as const,
    ...a,
    corrects: null,
    reason: null,
    sources: [],
    origin: {
      kind: 'conversation',
      conversationId: b.conversationId,
      runId: b.runId,
      commandId: p.command.commandId,
      commandSha256: p.commandSha256,
    },
    idempotencyKey: p.command.idempotencyKey,
    createdAt: p.createdAt,
  };
}
