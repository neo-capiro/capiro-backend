import { validateMeriCase12SetupPolicyBinding } from './case12-setup-binding.js';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { MeriGovernedTurnContext } from '../registry/types';
import type { MeriResearchPlanExecutionEnvelopeV1 } from './research-plan-execution';
import {
  validateMeriFixtureSemanticClock,
  type MeriFixtureSemanticClock,
} from './server-readonly-capture';
import { validateMeriGovernedArtifactPolicy } from './governed-artifact-capture';
import { canonicalJson } from '../repair/plan-remedy';

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
  resolveMeriGovernedSemanticClock(context, now);
}

/** Called after whole-context authentication. This checks agreement, not fixture
 * issuance: only the API's current canonical owner may mint the clock. */
export function resolveMeriGovernedSemanticClock(
  context: MeriGovernedTurnContext,
  now = Date.now(),
): MeriFixtureSemanticClock | undefined {
  const policy = context.serverReadonlyCapturePolicy;
  if (policy) validateMeriCase12SetupPolicyBinding(policy);
  const artifact = context.governedArtifactCapturePolicy;
  const clock = context.semanticClock;
  const compiler = context.contextPacket.clockUse;
  const qualifiedRead =
    policy &&
    !policy.syntheticReadBudget &&
    policy.fixtureVersion === 'meri-live-v1-2026-09-26.1' &&
    ['01', '12', '14', '20', '72'].includes(policy.caseId ?? '');
  const fail = (): never => {
    throw new Error('meri_fixture_semantic_clock_context_mismatch');
  };
  if (!qualifiedRead && !artifact) {
    if (clock || policy?.semanticClock || compiler) fail();
    return undefined;
  }
  if (!clock || (artifact && policy) || context.operationId !== 'meri.chat') return fail();
  const binding = artifact ?? policy!;
  validateMeriFixtureSemanticClock(clock, binding);
  if (
    binding.expiresAt <= now ||
    binding.issuedAt > now + 30_000 ||
    binding.tenantId !== context.evidence?.tenantId ||
    binding.actorUserId !== context.evidence?.userId
  )
    fail();
  if (artifact) {
    validateMeriGovernedArtifactPolicy(
      artifact,
      { tenantId: artifact.tenantId, actorUserId: artifact.actorUserId },
      now,
    );
    if (clock.currentVerifySha256 !== artifact.currentVerifySha256) fail();
  } else if (
    !policy!.semanticClock ||
    canonicalJson(clock) !== canonicalJson(policy!.semanticClock)
  )
    fail();
  if (
    !compiler ||
    compiler.instant !== clock.instant ||
    compiler.timeZone !== clock.timeZone ||
    !Number.isFinite(Date.parse(compiler.eligibilityAt)) ||
    !['used', 'not_run'].includes(compiler.scoring)
  )
    fail();
  return clock;
}
