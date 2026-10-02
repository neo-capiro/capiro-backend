import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

/** A separate capability for the original governed-write row. It confers no
 * read-only capture authority and does not replace ordinary action approval. */
export const MERI_GOVERNED_ARTIFACT_HEADER = 'x-meri-governed-artifact-capture' as const;
export const MERI_CASE46 = Object.freeze({
  namespace: 'meri-foundation-20260928',
  tenantId: 'f2d6cf8f-057c-479a-8110-62fe5086d43f',
  tenantSlug: 'meri-foundation-20260928-t1',
  actorUserId: 'b1f758fc-17bd-40f8-bef2-fa2d2380300f',
  clientId: '41f9ec63-3963-479f-b747-59a3767ef44b',
  prompt: 'Export that briefing and give me the file.',
  sourceLogicalId: 'ARTIFACT-BRIEF-1',
  filename: 'aster-synthetic-briefing.txt',
  title: 'aster-synthetic-briefing',
  text: 'Synthetic Aster briefing v1\n',
  byteLength: 28,
  sha256: 'c26beebc62f179a568981d811784dc75ad7e2cad79c94165d6f4859dcb278c53',
} as const);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const uuid = z.string().uuid();
const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9_.:-]+$/);
const policySchema = z
  .object({
    version: z.literal(1),
    kind: z.literal('governed_artifact_acceptance_capture'),
    caseId: z.literal('46'),
    fixtureNamespace: z.literal(MERI_CASE46.namespace),
    tenantId: z.literal(MERI_CASE46.tenantId),
    tenantSlug: z.literal(MERI_CASE46.tenantSlug),
    actorUserId: z.literal(MERI_CASE46.actorUserId),
    clientId: z.literal(MERI_CASE46.clientId),
    conversationId: uuid,
    captureRunId: uuid,
    policyId: uuid,
    requestId: identifier,
    traceId: identifier,
    turnId: uuid.nullable(),
    source: z
      .object({
        owner: z.literal('engagement_attachment'),
        logicalId: z.literal(MERI_CASE46.sourceLogicalId),
        physicalId: uuid,
        rowVersion: z.string().regex(/^[0-9]{1,10}$/),
        ownershipSha256: hash,
        contentSha256: z.literal(MERI_CASE46.sha256),
        byteLength: z.literal(MERI_CASE46.byteLength),
      })
      .strict(),
    currentVerifySha256: hash,
    qualificationSha256: hash,
    issuedAt: z.number().int().nonnegative().safe(),
    expiresAt: z.number().int().positive().safe(),
    allowedTool: z.literal('create_word'),
    approval: z.literal('canonical_current_user_required'),
    maximumProposals: z.literal(1),
    maximumArtifactEffects: z.literal(1),
    dynamicMcpAllowed: z.literal(false),
    incidentalWriters: z.literal('suppressed'),
    expectedWrites: z.tuple([
      z.literal('context_packet_and_evidence'),
      z.literal('conversation_user_message'),
      z.literal('conversation_assistant_message'),
      z.literal('provider_budget_ledger'),
      z.literal('canonical_action_proposal'),
      z.literal('approved_text_artifact'),
    ]),
  })
  .strict();
export type MeriGovernedArtifactCapturePolicy = z.infer<typeof policySchema>;
export type MeriGovernedArtifactPurpose = 'provider_budget' | 'action_proposal' | 'tool';
const purposeSchema = z.enum(['provider_budget', 'action_proposal', 'tool']);
const envelopeSchema = z
  .object({
    version: z.literal(1),
    purpose: purposeSchema,
    policy: policySchema,
    signature: hash,
  })
  .strict();
const fail = (): never => {
  throw new Error('meri_governed_artifact_capability_invalid');
};

export function validateMeriGovernedArtifactPolicy(
  value: unknown,
  binding: { tenantId: string; actorUserId: string; conversationId?: string; clientId?: string },
  now = Date.now(),
): MeriGovernedArtifactCapturePolicy {
  const parsed = policySchema.safeParse(value);
  if (!parsed.success) return fail();
  const p = parsed.data;
  if (
    !Number.isSafeInteger(now) ||
    p.issuedAt > now + 30_000 ||
    p.expiresAt <= now ||
    p.expiresAt <= p.issuedAt ||
    p.expiresAt - p.issuedAt > 15 * 60_000 ||
    p.tenantId !== binding.tenantId ||
    p.actorUserId !== binding.actorUserId ||
    (binding.conversationId !== undefined && p.conversationId !== binding.conversationId) ||
    (binding.clientId !== undefined && p.clientId !== binding.clientId)
  )
    return fail();
  return p;
}
function payload(p: MeriGovernedArtifactCapturePolicy, purpose: MeriGovernedArtifactPurpose) {
  return JSON.stringify({
    audience: 'capiro:meri:governed-artifact-capture:v1',
    purpose,
    policy: p,
  });
}
export function encodeMeriGovernedArtifactTransport(
  value: MeriGovernedArtifactCapturePolicy,
  purpose: MeriGovernedArtifactPurpose,
  secret: string | undefined,
  now = Date.now(),
): string {
  if (!secret?.trim() || !purposeSchema.safeParse(purpose).success) return fail();
  const policy = validateMeriGovernedArtifactPolicy(value, value, now);
  const signature = createHmac('sha256', secret.trim())
    .update(payload(policy, purpose))
    .digest('hex');
  return Buffer.from(JSON.stringify({ version: 1, purpose, policy, signature })).toString(
    'base64url',
  );
}
export function decodeMeriGovernedArtifactTransport(
  value: string | undefined,
  binding: {
    purpose: MeriGovernedArtifactPurpose;
    tenantId: string;
    actorUserId: string;
    conversationId?: string;
    clientId?: string;
  },
  secret: string | undefined,
  now = Date.now(),
): MeriGovernedArtifactCapturePolicy {
  if (!secret?.trim() || !value || value.length > 8192 || !/^[A-Za-z0-9_-]+$/.test(value))
    return fail();
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
  } catch {
    return fail();
  }
  const parsed = envelopeSchema.safeParse(raw);
  if (!parsed.success || parsed.data.purpose !== binding.purpose) return fail();
  const { signature, purpose } = parsed.data;
  const policy = validateMeriGovernedArtifactPolicy(parsed.data.policy, binding, now);
  const expected = createHmac('sha256', secret.trim()).update(payload(policy, purpose)).digest();
  if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return fail();
  return policy;
}

/** No normalized/truncated approximation is acceptable for the frozen export. */
export function assertMeriCase46ToolInput(
  policy: MeriGovernedArtifactCapturePolicy,
  tool: string,
  value: unknown,
): void {
  const p = validateMeriGovernedArtifactPolicy(policy, policy);
  const input = z
    .object({
      title: z.literal(MERI_CASE46.title),
      format: z.literal('txt'),
      text: z.literal(MERI_CASE46.text),
      conversationId: z.literal(p.conversationId),
      clientId: z.literal(MERI_CASE46.clientId),
    })
    .strict()
    .safeParse(value);
  if (
    tool !== 'create_word' ||
    !p.turnId ||
    !input.success ||
    createHash('sha256').update(input.data.text, 'utf8').digest('hex') !== MERI_CASE46.sha256
  )
    return fail();
}
