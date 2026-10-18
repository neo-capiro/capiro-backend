import { KeyObject, createHash, verify as nodeVerify } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { canonicalizeCoreRetainedJson } from '@capiro/shared/core-retained-jcs';
import {
  CORE_ED25519_ISSUER,
  CORE_ED25519_KID,
  CORE_ED25519_MAX_MESSAGE_BYTES,
  type CoreEd25519Signer,
} from '../../auth/core-ed25519-signer.js';
import {
  nativeCanonicalSha256,
  parseApprovalProposal,
  parseRunBinding,
  parseScope,
  type NativeApprovalDecision,
  type NativeApprovalProposal,
  type NativeIdentity,
  type NativeRunBinding,
  type NativeScope,
} from '../native-approvals/native-approval.contract.js';

/**
 * Contract `capiro.meri-execution-capability.v1` (docs/integration/
 * MERI-EXECUTION-CAPABILITY-DRAFT.md), requested by dot in #121 6246253130.
 * Rev 5: the 13-field execution member dot reviewed (rev 3, #121 6247464370;
 * Meri lane X adopts it, R0 6247577743) with rev 4's fixes: Meri's
 * deterministic request id, budgets equal to the authenticated allocation,
 * `expiresAtMs = exp*1000`, and the receiver's body inverse.
 *
 * Core issues one short-lived EdDSA (pure Ed25519) compact JWS per approved
 * proposal execution attempt. Meri's `verifyCapability` port verifies it with
 * the pinned public JWK and returns the exact `CapabilityClaims` (meri.schema
 * .json) the gateway's current-tool authority checks. The `execution` member
 * binds the immutable approved proposal and decision, the exact
 * `CommandExecutionRequest`, the command arguments and the client scopes.
 *
 * Pure codec: no route, key, grant, ledger or credential is created or enabled
 * here. Revocation is the executor's existing CURRENT checks (decision, run,
 * business policy) plus a TTL of at most 120 seconds.
 */
export const MERI_EXECUTION_TOKEN_TYPE = 'capiro-meri-execution+jwt';
export const MERI_EXECUTION_AUDIENCE = 'meri-gateway';
export const MERI_EXECUTION_ACTION = 'command.execute';
export const MERI_EXECUTION_MAX_TTL_SECONDS = 120;
/** Meri's executor accepts credentials up to 8192 bytes. */
export const MERI_EXECUTION_MAX_TOKEN_BYTES = 8192;
/** `task.create` only today (Meri `intents/approval.mjs` APPROVABLE_ACTIONS). */
export const MERI_EXECUTION_ACTIONS = Object.freeze(['task.create']);

export interface MeriCapabilityBudgets {
  maxTurns: number;
  maxRuntimeSeconds: number;
  maxCostMicrousd: number;
  maxOutputBytes: number;
}

/** Exactly Meri `CapabilityClaims` (additionalProperties: false). */
export interface MeriCapabilityClaims {
  capabilityId: string;
  issuer: string;
  audience: typeof MERI_EXECUTION_AUDIENCE;
  binding: NativeRunBinding;
  actions: [typeof MERI_EXECUTION_ACTION];
  scopes: NativeScope[];
  issuedAt: string;
  expiresAt: string;
  policyRevision: string;
  budgets: MeriCapabilityBudgets;
}

/** Exactly Meri `CommandExecutionRequest` 0.1.0. */
export interface MeriCommandExecutionRequest {
  contractVersion: '0.1.0';
  requestId: string;
  capabilityId: string;
  executorBinding: NativeRunBinding;
  proposalId: string;
  commandSha256: string;
  idempotencyKey: string;
}

/** Meri grant-fact `qualificationBinding` (dot #121 6246551969): the run's
 * actual qualification facts, which the UUID attempt/worker ids cannot
 * substitute. Core reads them from Meri's run owner, never from the caller. */
export interface MeriQualificationBinding {
  runId: string;
  attempt: number;
  workerArn: string;
  fence: number;
  policyRevision: string;
}

export interface MeriExecutionBinding {
  requestId: string;
  proposalId: string;
  commandSha256: string;
  idempotencyKey: string;
  action: string;
  argumentsSha256: string;
  /** SHA-256(JCS(Meri `commandSourceBody(command)`)): the exact tool body. */
  sourceBodySha256: string;
  clientIds: string[];
  decisionSha256: string;
  approver: NativeIdentity;
  requestSha256: string;
  /** SHA-256(JCS(admitted allocation)), read from Meri's allocation owner. */
  allocationSha256: string;
  qualification: MeriQualificationBinding;
}

export interface MeriExecutionTokenPayload {
  iss: string;
  aud: typeof MERI_EXECUTION_AUDIENCE;
  iat: number;
  nbf: number;
  exp: number;
  jti: string;
  capability: MeriCapabilityClaims;
  execution: MeriExecutionBinding;
}

export interface MeriExecutionIssuance {
  /** Meri `issueExecution` receipt fields, in its order. */
  execution: MeriCommandExecutionRequest;
  credential: string;
  checkedAtMs: number;
  expiresAtMs: number;
}

export interface MeriExecutionTrust {
  issuer: string;
  /** kid → pinned Ed25519 public key. */
  keys: Readonly<Record<string, KeyObject>>;
  nowMs: number;
}

export interface VerifiedMeriExecution {
  /** JSON text for Meri's `verifyCapability` port (it parses raw JSON). */
  claimsJson: string;
  claims: MeriCapabilityClaims;
  execution: MeriExecutionBinding;
}

export class MeriExecutionCapabilityRefused extends Error {
  constructor() { super('MERI_EXECUTION_CAPABILITY_REFUSED'); }
}
const refuse = (): never => { throw new MeriExecutionCapabilityRefused(); };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Meri `tool-budget-binding.mjs` `validateGrantBinding` (exact). */
const WORKER_ARN = /^arn:aws:ecs:us-east-1:967807252336:task\/[A-Za-z0-9_-]{1,255}\/[0-9a-f]{32}$/;
const INT32_MAX = 2147483647;
const HEX64 = /^[a-f0-9]{64}$/;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const exact = (pattern: RegExp, value: unknown): value is string =>
  typeof value === 'string' && pattern.exec(value)?.[0] === value;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
const seconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const sha256 = (value: unknown) => createHash('sha256').update(canonicalizeCoreRetainedJson(value), 'utf8').digest('hex');
const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString();
const headerJson = (kid: string) => JSON.stringify({ alg: 'EdDSA', typ: MERI_EXECUTION_TOKEN_TYPE, kid });

function own(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || nodeTypes.isProxy(value) ||
      (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) refuse();
  const names = Reflect.ownKeys(value as object);
  if (names.length !== keys.length || names.some((k) => typeof k !== 'string' || !keys.includes(k))) refuse();
  return value as Record<string, unknown>;
}

/**
 * Capability budgets from the admitted allocation, exactly as Meri's
 * `capabilityBudgets` derives them (maxCostMicroUSD -> maxCostMicrousd). The
 * allocation's run must be the executor's tenant/actor/conversation/run, its
 * budgets the closed Meri `Budgets` and its schedule present.
 */
export function meriAllocationBudgets(allocation: unknown, binding: NativeRunBinding): MeriCapabilityBudgets {
  return guarded(() => {
    if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) refuse();
    const a = allocation as Record<string, unknown>;
    const run = own(a.run, ['tenantId', 'actorId', 'conversationId', 'runId']);
    const schedule = a.schedule as { revision?: unknown; operations?: unknown } | null | undefined;
    if (run.tenantId !== binding.tenantId || run.actorId !== binding.actorId || run.conversationId !== binding.conversationId ||
        run.runId !== binding.runId || typeof schedule?.revision !== 'string' || !Array.isArray(schedule.operations)) refuse();
    const b = own(a.budgets, ['maxTurns', 'maxToolCalls', 'maxRecoveryAttempts', 'maxRuntimeSeconds', 'maxCostMicroUSD', 'maxOutputBytes']);
    return budgets({ maxTurns: b.maxTurns, maxRuntimeSeconds: b.maxRuntimeSeconds, maxCostMicrousd: b.maxCostMicroUSD, maxOutputBytes: b.maxOutputBytes });
  });
}

/** Closed qualification facts bound to the executor run, fence and policy. */
export function parseMeriQualification(value: unknown, binding: NativeRunBinding, policyRevision: string): MeriQualificationBinding {
  return guarded(() => {
    const q = own(value, ['runId', 'attempt', 'workerArn', 'fence', 'policyRevision']);
    if (q.runId !== binding.runId || !positive(q.attempt) || (q.attempt as number) > INT32_MAX || !exact(WORKER_ARN, q.workerArn) ||
        q.fence !== binding.writerFence || (q.fence as number) > INT32_MAX || q.policyRevision !== policyRevision) refuse();
    return { runId: q.runId as string, attempt: q.attempt as number, workerArn: q.workerArn as string,
      fence: q.fence as number, policyRevision: q.policyRevision as string };
  });
}

function budgets(value: unknown): MeriCapabilityBudgets {
  const b = own(value, ['maxTurns', 'maxRuntimeSeconds', 'maxCostMicrousd', 'maxOutputBytes']);
  if (![b.maxTurns, b.maxRuntimeSeconds, b.maxCostMicrousd, b.maxOutputBytes].every(positive)) refuse();
  return { maxTurns: b.maxTurns as number, maxRuntimeSeconds: b.maxRuntimeSeconds as number,
    maxCostMicrousd: b.maxCostMicrousd as number, maxOutputBytes: b.maxOutputBytes as number };
}

/**
 * Configured platform maxima (D016-A item 3; dot #121 6247742665): never a
 * hard-coded universal ceiling. Budgets always come from the authenticated
 * allocation; each `MERI_EXECUTION_MAX_*` that is set refuses an allocation
 * above it and never rewrites one. Unset means no extra platform bound. The
 * D016 default integration profile (20 turns, 900 s, $2) is configured in the
 * deployment template, not here. A malformed value throws (the route answers
 * 503 rather than issue unbounded).
 */
export interface MeriExecutionPlatformMaxima {
  maxTurns?: number;
  maxRuntimeSeconds?: number;
  maxCostMicrousd?: number;
  maxOutputBytes?: number;
}

const MAXIMA_ENV: ReadonlyArray<[keyof MeriExecutionPlatformMaxima, string]> = [
  ['maxTurns', 'MERI_EXECUTION_MAX_TURNS'],
  ['maxRuntimeSeconds', 'MERI_EXECUTION_MAX_RUNTIME_SECONDS'],
  ['maxCostMicrousd', 'MERI_EXECUTION_MAX_COST_MICROUSD'],
  ['maxOutputBytes', 'MERI_EXECUTION_MAX_OUTPUT_BYTES'],
];

export function readMeriExecutionPlatformMaxima(env: NodeJS.ProcessEnv): MeriExecutionPlatformMaxima {
  const out: MeriExecutionPlatformMaxima = {};
  for (const [key, name] of MAXIMA_ENV) {
    const raw = env[name];
    if (raw === undefined || raw.trim() === '') continue;
    if (!/^[1-9][0-9]{0,15}$/.test(raw.trim()) || !Number.isSafeInteger(Number(raw.trim()))) throw new Error(`${name} must be a positive integer`);
    out[key] = Number(raw.trim());
  }
  return out;
}

export function withinMeriExecutionPlatformMaxima(b: MeriCapabilityBudgets, m: MeriExecutionPlatformMaxima): boolean {
  return (Object.keys(m) as Array<keyof MeriExecutionPlatformMaxima>).every((k) => b[k] <= (m[k] as number));
}

/**
 * dot #121 6247742665 item 2: a task's client must be inside the approved
 * command's exact client scope. A non-null `clientId` is a lowercase UUID
 * among the client scopes; a null `clientId` is the tenant-level task
 * contract: no client scope at all and this tenant's own tenant scope, so a
 * null client never widens a client-bound approval.
 */
export function taskClientWithinScopes(clientId: string | null, scopes: readonly NativeScope[], tenantId: string): boolean {
  const clients = clientIdsOf(scopes);
  if (clientId !== null) return UUID.test(clientId) && clients.includes(clientId);
  return clients.length === 0 && scopes.some((s) => s.kind === 'tenant' && s.tenantId === tenantId && s.resourceId === tenantId);
}

/** Closed budgets: exactly the four keys, each a positive safe integer. */
export function parseMeriCapabilityBudgets(value: unknown): MeriCapabilityBudgets {
  return guarded(() => budgets(value));
}

/**
 * Meri `executionRequestId` (meri-greenfield 1cc5a554
 * `apps/runtime/native-authority/execution-capability.mjs`): a UUIDv4-shaped
 * digest of (proposal, command hash, executor binding), so a replay for the
 * same attempt carries the same id and any other attempt a different one.
 */
export function meriExecutionRequestId(input: { proposalId: string; commandSha256: string; executorBinding: NativeRunBinding }): string {
  const h = createHash('sha256').update(canonicalizeCoreRetainedJson({
    purpose: 'meri-execution-request/v1', proposalId: input.proposalId, commandSha256: input.commandSha256,
    executorBinding: input.executorBinding,
  }), 'utf8').digest('hex').split('');
  h[12] = '4';
  h[16] = '89ab'[parseInt(h[16]!, 16) & 3]!;
  const v = h.join('');
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/** Lowercase client resource ids, sorted and unique: the client scopes this execution may touch. */
export function clientIdsOf(scopes: readonly NativeScope[]): string[] {
  return [...new Set(scopes.filter((s) => s.kind === 'client').map((s) => s.resourceId.toLowerCase()))].sort();
}

function sameRun(a: NativeRunBinding, b: NativeRunBinding): boolean {
  return a.tenantId === b.tenantId && a.actorId === b.actorId && a.conversationId === b.conversationId && a.runId === b.runId;
}

/**
 * Meri `apps/control/commands/source-projection.mjs` `commandSourceBody` for
 * `task.create` (meri-greenfield 09781127): the `create_task` body drops a null
 * clientId or dueDate. `TaskCreateArguments` is closed {title, clientId, dueDate}.
 */
export function taskCreateSourceBody(args: unknown): Record<string, string> {
  const a = own(args, ['title', 'clientId', 'dueDate']);
  if (typeof a.title !== 'string' || !(a.clientId === null || typeof a.clientId === 'string') ||
      !(a.dueDate === null || typeof a.dueDate === 'string')) refuse();
  return {
    title: a.title as string,
    ...(a.clientId === null ? {} : { clientId: a.clientId as string }),
    ...(a.dueDate === null ? {} : { dueDate: a.dueDate as string }),
  };
}

/**
 * The Core receiver's inverse of that projection: Meri's `create_task` body
 * back to the closed `TaskCreateArguments`, whose hash the token binds
 * (`argumentsSha256`). Unique because the arguments are closed and the body
 * omits exactly the null members.
 */
export function taskCreateArgumentsFromBody(body: unknown): { title: string; clientId: string | null; dueDate: string | null } {
  if (!body || typeof body !== 'object' || Array.isArray(body) || nodeTypes.isProxy(body)) refuse();
  const keys = Object.keys(body as object);
  if (!keys.includes('title') || keys.some((k) => !['title', 'clientId', 'dueDate'].includes(k))) refuse();
  const b = body as Record<string, unknown>;
  const args = { title: b.title, clientId: Object.hasOwn(b, 'clientId') ? b.clientId : null, dueDate: Object.hasOwn(b, 'dueDate') ? b.dueDate : null };
  if (Object.hasOwn(b, 'clientId') && args.clientId === null || Object.hasOwn(b, 'dueDate') && args.dueDate === null) refuse();
  // Round trip: the body must be exactly Meri's projection of these arguments.
  if (canonicalizeCoreRetainedJson(taskCreateSourceBody(args)) !== canonicalizeCoreRetainedJson(b)) refuse();
  return args as { title: string; clientId: string | null; dueDate: string | null };
}

/** The capability window: at most 120 s and never past the decision, the
 * proposal or the run deadline. Shared by issuance (ledger before signing) and
 * the codec, so a replay at the recorded `iat` reproduces the same `exp`. */
export function meriExecutionWindow(input: {
  nowMs: number; decisionExpiresAt: string; proposalExpiresAt: string; runDeadlineMs: number;
}): { iat: number; exp: number } {
  const iat = Math.floor(input.nowMs / 1000);
  const exp = Math.min(
    iat + MERI_EXECUTION_MAX_TTL_SECONDS,
    Math.floor(Date.parse(input.decisionExpiresAt) / 1000),
    Math.floor(Date.parse(input.proposalExpiresAt) / 1000),
    Math.floor(input.runDeadlineMs / 1000),
  );
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat) refuse();
  return { iat, exp };
}

function guarded<T>(fn: () => T): T {
  try { return fn(); } catch { return refuse(); }
}

/** Issue after the stored decision (R12) is re-read as current and approved. */
export async function issueMeriExecutionCapability(
  input: {
    proposal: NativeApprovalProposal;
    decision: NativeApprovalDecision;
    executorBinding: NativeRunBinding;
    requestId: string;
    capabilityId: string;
    /** The admitted allocation read from Meri's allocation owner. Budgets are
     * derived from it exactly; never a ceiling Core chooses (dot #121
     * 6246551969 item 1), never a caller-supplied hash. */
    allocation: unknown;
    /** The run's qualification facts read from Meri's run owner. */
    qualification: MeriQualificationBinding;
    nowMs: number;
    /** Current run deadline; the capability never outlives it. */
    runDeadlineMs: number;
  },
  signer: CoreEd25519Signer,
  options: { signal?: AbortSignal } = {},
): Promise<MeriExecutionIssuance> {
  const prepared = guarded(() => {
    const v = own(input, ['proposal', 'decision', 'executorBinding', 'requestId', 'capabilityId', 'allocation', 'qualification', 'nowMs', 'runDeadlineMs']);
    const proposal = parseApprovalProposal(v.proposal);
    const executorBinding = parseRunBinding(v.executorBinding, 'executorBinding');
    const d = own(v.decision, ['proposalId', 'commandSha256', 'decision', 'decidedAt', 'expiresAt', 'approver', 'policyRevision']);
    const approver = own(d.approver, ['tenantId', 'actorId']);
    if (!exact(UUID_V4, v.capabilityId) || !exact(UUID, v.requestId) || !seconds(v.nowMs) || !seconds(v.runDeadlineMs) ||
        !exact(CORE_ED25519_ISSUER, signer?.issuer) || !exact(CORE_ED25519_KID, signer?.kid) || typeof signer.sign !== 'function') refuse();
    const command = proposal.command;
    const nowMs = v.nowMs as number;
    if (d.decision !== 'approved' || d.proposalId !== proposal.proposalId || d.commandSha256 !== proposal.commandSha256 ||
        nativeCanonicalSha256(command) !== proposal.commandSha256 ||
        approver.tenantId !== proposal.requiredApprover.tenantId || approver.actorId !== proposal.requiredApprover.actorId ||
        !MERI_EXECUTION_ACTIONS.includes(command.action) || !sameRun(executorBinding, command.binding) ||
        command.scopes.length < 1 || command.scopes.some((s) => s.tenantId !== executorBinding.tenantId || s.policyRevision !== d.policyRevision) ||
        new Set(command.scopes.map((s) => sha256(s))).size !== command.scopes.length) refuse();
    const { iat, exp } = meriExecutionWindow({
      nowMs, decisionExpiresAt: d.expiresAt as string, proposalExpiresAt: proposal.expiresAt, runDeadlineMs: v.runDeadlineMs as number,
    });
    // Second granularity: a replay re-signs at the recorded iat, which may be
    // earlier in the same second than the decision.
    if (Math.floor(Date.parse(d.decidedAt as string) / 1000) > iat) refuse();
    const capabilityId = v.capabilityId as string;
    const execution: MeriCommandExecutionRequest = {
      contractVersion: '0.1.0', requestId: v.requestId as string, capabilityId, executorBinding,
      proposalId: proposal.proposalId, commandSha256: proposal.commandSha256, idempotencyKey: command.idempotencyKey,
    };
    const claims: MeriCapabilityClaims = {
      capabilityId, issuer: signer.issuer, audience: MERI_EXECUTION_AUDIENCE, binding: executorBinding,
      actions: [MERI_EXECUTION_ACTION], scopes: command.scopes, issuedAt: iso(iat), expiresAt: iso(exp),
      policyRevision: d.policyRevision as string, budgets: meriAllocationBudgets(v.allocation, executorBinding),
    };
    const qualification = parseMeriQualification(v.qualification, executorBinding, d.policyRevision as string);
    const payload: MeriExecutionTokenPayload = {
      iss: signer.issuer, aud: MERI_EXECUTION_AUDIENCE, iat, nbf: iat, exp, jti: capabilityId, capability: claims,
      execution: {
        requestId: execution.requestId, proposalId: execution.proposalId, commandSha256: execution.commandSha256,
        idempotencyKey: execution.idempotencyKey, action: command.action, argumentsSha256: sha256(command.arguments),
        sourceBodySha256: sha256(taskCreateSourceBody(command.arguments)),
        clientIds: clientIdsOf(command.scopes), decisionSha256: sha256(d),
        approver: { tenantId: approver.tenantId as string, actorId: approver.actorId as string }, requestSha256: sha256(execution),
        allocationSha256: sha256(v.allocation), qualification,
      },
    };
    const signingInput = `${Buffer.from(headerJson(signer.kid)).toString('base64url')}.${Buffer.from(canonicalizeCoreRetainedJson(payload), 'utf8').toString('base64url')}`;
    if (Buffer.byteLength(signingInput) > CORE_ED25519_MAX_MESSAGE_BYTES) refuse();
    return { signingInput, execution, nowMs, exp };
  });
  let signature: Buffer;
  try { signature = await signer.sign(Buffer.from(prepared.signingInput, 'ascii'), { signal: options.signal }); } catch { return refuse(); }
  const credential = `${prepared.signingInput}.${signature.toString('base64url')}`;
  if (Buffer.byteLength(credential) > MERI_EXECUTION_MAX_TOKEN_BYTES) refuse();
  return { execution: prepared.execution, credential, checkedAtMs: prepared.nowMs, expiresAtMs: prepared.exp * 1000 };
}

function decode(part: string | undefined, maxBytes: number): string {
  if (!exact(SEGMENT, part)) refuse();
  const bytes = Buffer.from(part as string, 'base64url');
  if (bytes.length > maxBytes || bytes.toString('base64url') !== part) refuse();
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Verifier for Meri's `verifyCapability` port and Core's receiver branch. */
export function verifyMeriExecutionCapability(token: string, trust: MeriExecutionTrust): VerifiedMeriExecution {
  return guarded(() => {
    const t = own(trust, ['issuer', 'keys', 'nowMs']);
    if (!exact(CORE_ED25519_ISSUER, t.issuer) || !seconds(t.nowMs) || typeof token !== 'string' ||
        Buffer.byteLength(token) > MERI_EXECUTION_MAX_TOKEN_BYTES) refuse();
    const keys = t.keys as Record<string, unknown>;
    const parts = token.split('.');
    if (parts.length !== 3) refuse();
    const header = JSON.parse(decode(parts[0], 256)) as Record<string, unknown>;
    const kidValue = own(header, ['alg', 'typ', 'kid']).kid;
    if (!exact(CORE_ED25519_KID, kidValue)) refuse();
    const kid = kidValue as string;
    if (decode(parts[0], 256) !== headerJson(kid) || !keys || !Object.hasOwn(keys, kid)) refuse();
    const publicKey = Object.getOwnPropertyDescriptor(keys, kid)?.value;
    if (!(publicKey instanceof KeyObject) || publicKey.type !== 'public' || publicKey.asymmetricKeyType !== 'ed25519') refuse();
    const signature = Buffer.from(parts[2]!, 'base64url');
    if (!exact(SEGMENT, parts[2]) || signature.toString('base64url') !== parts[2] || signature.length !== 64 ||
        !nodeVerify(null, Buffer.from(`${parts[0]}.${parts[1]}`, 'ascii'), publicKey as KeyObject, signature)) refuse();
    const text = decode(parts[1], CORE_ED25519_MAX_MESSAGE_BYTES);
    const p = own(JSON.parse(text), ['iss', 'aud', 'iat', 'nbf', 'exp', 'jti', 'capability', 'execution']);
    // Non-malleable: the payload bytes are exactly the RFC 8785 form.
    if (canonicalizeCoreRetainedJson(p) !== text) refuse();
    const now = Math.floor((t.nowMs as number) / 1000);
    if (p.iss !== t.issuer || p.aud !== MERI_EXECUTION_AUDIENCE || !seconds(p.iat) || p.nbf !== p.iat || !seconds(p.exp) ||
        (p.exp as number) <= (p.iat as number) || (p.exp as number) - (p.iat as number) > MERI_EXECUTION_MAX_TTL_SECONDS ||
        (p.iat as number) > now || (p.exp as number) <= now || !exact(UUID_V4, p.jti)) refuse();
    const c = own(p.capability, ['capabilityId', 'issuer', 'audience', 'binding', 'actions', 'scopes', 'issuedAt', 'expiresAt', 'policyRevision', 'budgets']);
    const binding = parseRunBinding(c.binding, 'capability.binding');
    if (!Array.isArray(c.scopes) || c.scopes.length > 100) refuse();
    const scopes = (c.scopes as unknown[]).map((scope, index) => parseScope(scope, `capability.scopes[${index}]`));
    if (c.capabilityId !== p.jti || c.issuer !== p.iss || c.audience !== MERI_EXECUTION_AUDIENCE ||
        !Array.isArray(c.actions) || c.actions.length !== 1 || c.actions[0] !== MERI_EXECUTION_ACTION ||
        c.issuedAt !== iso(p.iat as number) || c.expiresAt !== iso(p.exp as number) || typeof c.policyRevision !== 'string' ||
        scopes.length < 1 || scopes.some((s) => s.tenantId !== binding.tenantId || s.policyRevision !== c.policyRevision) ||
        new Set(scopes.map((s) => sha256(s))).size !== scopes.length) refuse();
    const claims: MeriCapabilityClaims = {
      capabilityId: c.capabilityId as string, issuer: c.issuer as string, audience: MERI_EXECUTION_AUDIENCE, binding,
      actions: [MERI_EXECUTION_ACTION], scopes, issuedAt: c.issuedAt as string, expiresAt: c.expiresAt as string,
      policyRevision: c.policyRevision as string, budgets: budgets(c.budgets),
    };
    const e = own(p.execution, ['requestId', 'proposalId', 'commandSha256', 'idempotencyKey', 'action', 'argumentsSha256',
      'sourceBodySha256', 'clientIds', 'decisionSha256', 'approver', 'requestSha256', 'allocationSha256', 'qualification']);
    const approver = own(e.approver, ['tenantId', 'actorId']);
    if (!exact(UUID, e.requestId) || !exact(UUID, e.proposalId) || !exact(HEX64, e.commandSha256) ||
        typeof e.idempotencyKey !== 'string' || e.idempotencyKey.length < 1 || e.idempotencyKey.length > 128 ||
        !MERI_EXECUTION_ACTIONS.includes(e.action as string) || !exact(HEX64, e.argumentsSha256) ||
        !exact(HEX64, e.sourceBodySha256) || !exact(HEX64, e.decisionSha256) || !exact(HEX64, e.allocationSha256) ||
        approver.tenantId !== binding.tenantId || approver.actorId !== binding.actorId ||
        canonicalizeCoreRetainedJson(e.clientIds) !== canonicalizeCoreRetainedJson(clientIdsOf(scopes))) refuse();
    const request: MeriCommandExecutionRequest = {
      contractVersion: '0.1.0', requestId: e.requestId as string, capabilityId: claims.capabilityId, executorBinding: binding,
      proposalId: e.proposalId as string, commandSha256: e.commandSha256 as string, idempotencyKey: e.idempotencyKey as string,
    };
    if (e.requestSha256 !== sha256(request)) refuse();
    parseMeriQualification(e.qualification, binding, claims.policyRevision);
    const execution = e as unknown as MeriExecutionBinding;
    return Object.freeze({ claimsJson: JSON.stringify(claims), claims, execution: Object.freeze({ ...execution }) });
  });
}

/**
 * Trusted comparison before dispatch (dot #121 6246551969): a verified token is
 * only self-consistent; it authorizes nothing until it equals the actual
 * external execution request, approved proposal, current decision, admitted
 * allocation and qualification facts the dispatcher holds. Throws when any
 * differs.
 */
export function assertExecutionMatches(
  verified: VerifiedMeriExecution,
  actual: {
    request: MeriCommandExecutionRequest;
    proposal: NativeApprovalProposal;
    decision: NativeApprovalDecision;
    allocation: unknown;
    qualification: MeriQualificationBinding;
  },
): void {
  guarded(() => {
    const e = verified.execution;
    const command = actual.proposal.command;
    if (e.requestSha256 !== sha256(actual.request) || actual.request.capabilityId !== verified.claims.capabilityId ||
        e.proposalId !== actual.proposal.proposalId || e.commandSha256 !== actual.proposal.commandSha256 ||
        nativeCanonicalSha256(command) !== actual.proposal.commandSha256 || e.argumentsSha256 !== sha256(command.arguments) ||
        e.sourceBodySha256 !== sha256(taskCreateSourceBody(command.arguments)) ||
        e.allocationSha256 !== sha256(actual.allocation) || sha256(e.qualification) !== sha256(actual.qualification) ||
        e.decisionSha256 !== sha256(actual.decision) || actual.decision.decision !== 'approved' ||
        actual.decision.policyRevision !== verified.claims.policyRevision ||
        canonicalizeCoreRetainedJson(verified.claims.scopes) !== canonicalizeCoreRetainedJson(command.scopes)) refuse();
  });
}

/**
 * Receiver-branch predicate (DRAFT, not mounted): a verified capability is the
 * run/approval-bound authority for exactly this proposal's current-decision
 * read in this run, with no user bearer. Attended UI calls keep native auth.
 */
export function executionCoversDecisionRead(
  verified: VerifiedMeriExecution,
  read: { proposalId: string; commandSha256: string; binding: NativeRunBinding },
): boolean {
  return verified.execution.proposalId === read.proposalId &&
    verified.execution.commandSha256 === read.commandSha256 &&
    sameRun(verified.claims.binding, read.binding);
}
