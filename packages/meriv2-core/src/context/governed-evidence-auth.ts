import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MeriGovernedTurnContext } from '../registry/types';
import type { MeriResearchPlanExecutionEnvelopeV1 } from './research-plan-execution';

export interface MeriGovernedRequestBinding {
  conversationId?: string;
  clientId?: string;
  messages?: readonly { role?: unknown; text?: unknown }[];
  researchRun?: { sessionId: string; runId: string; leaseEpoch: number };
  researchPlanExecution?: MeriResearchPlanExecutionEnvelopeV1;
}

const MAX_AGE_MS = 5 * 60_000;
const FUTURE_SKEW_MS = 30_000;

function signedPayload(
  context: MeriGovernedTurnContext,
  binding: MeriGovernedRequestBinding,
  issuedAt: number,
): string {
  const { attestation: _attestation, ...content } = context;
  return JSON.stringify({
    audience: 'capiro:meriv3:governed-context:v1',
    issuedAt,
    conversationId: binding.conversationId ?? null,
    clientId: binding.clientId ?? null,
    messages: (binding.messages ?? []).map(({ role, text }) => ({ role, text })),
    ...(binding.researchRun || binding.researchPlanExecution
      ? {
          researchRun: binding.researchRun ?? null,
          researchPlanExecution: binding.researchPlanExecution ?? null,
        }
      : {}),
    context: content,
  });
}

/** Called only in the API after its Context Plane has resolved live authorization. */
export function attestMeriGovernedContext(
  context: MeriGovernedTurnContext,
  binding: MeriGovernedRequestBinding,
  secret: string | undefined,
  now = Date.now(),
): MeriGovernedTurnContext {
  if (!secret?.trim()) throw new Error('meri_governed_context_service_identity_unavailable');
  if (!context.evidence) throw new Error('meri_governed_context_evidence_required');
  const signature = createHmac('sha256', secret.trim())
    .update(signedPayload(context, binding, now))
    .digest('hex');
  return { ...context, attestation: { version: 1, issuedAt: now, signature } };
}

/** Bearer authentication identifies the actor; this proves the context came from the API. */
export function verifyMeriGovernedContext(
  context: MeriGovernedTurnContext,
  binding: MeriGovernedRequestBinding,
  actor: { tenantId: string; userId: string },
  secret: string | undefined,
  now = Date.now(),
): void {
  const proof = context.attestation;
  const evidence = context.evidence;
  if (
    !secret?.trim() ||
    !proof ||
    proof.version !== 1 ||
    !Number.isFinite(proof.issuedAt) ||
    now - proof.issuedAt > MAX_AGE_MS ||
    proof.issuedAt - now > FUTURE_SKEW_MS ||
    !/^[a-f0-9]{64}$/.test(proof.signature) ||
    !evidence ||
    evidence.version !== 1 ||
    evidence.tenantId !== actor.tenantId ||
    evidence.userId !== actor.userId ||
    evidence.packetId !== (context.contextPacket.packetId ?? null)
  )
    throw new Error('meri_governed_context_authentication_failed');
  const expected = createHmac('sha256', secret.trim())
    .update(signedPayload(context, binding, proof.issuedAt))
    .digest();
  if (!timingSafeEqual(expected, Buffer.from(proof.signature, 'hex'))) {
    throw new Error('meri_governed_context_authentication_failed');
  }
}
