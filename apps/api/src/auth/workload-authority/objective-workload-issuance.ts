import { createHash, randomUUID } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import { ObjectiveCurrentSourceUnavailable } from './objective-workload-current.js';
import {
  issueObjectiveWorkloadJwt,
  ObjectiveWorkloadJwtError,
  type ObjectiveWorkloadIssuerSigner,
  type ObjectiveWorkloadPhase,
  type ObjectiveWorkloadOperation,
  type ObjectiveWorkloadRequestBinding,
} from './objective-workload-jwt.js';

/** Source-only Core issuance ledger seam. No route or runtime provider creates
 * this adapter. The current migration enforces enabled=false on delegations,
 * so a genuine database load must return unavailable. The future ingress must
 * verify the named caller proof and closed raw request before invoking it. */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_REQUEST_BYTES = 12 * 1024 * 1024;
const MAX_TIME = 253_402_300_799;
// Only admit has a genuine owner-backed current loader. The retained-read
// operation map below is a protocol definition, not authorization to issue:
// later phases remain HOLD until their trusted source and raw-body adapters
// observe the original Meri full binding, source admission and custody.
const FIRST_SLICE_PHASES = new Set<ObjectiveWorkloadPhase>(['admit']);
const INPUT_KEYS = ['selector', 'proof', 'rawIssuanceRequestBytes', 'binding'];
const SELECTOR_KEYS = ['tenantId', 'delegationRef', 'consentId', 'generationJobId', 'phase'];
const PROOF_KEYS = ['issuer', 'subject', 'keyId', 'jti', 'operationId',
  'requestSha256', 'iatSeconds', 'nbfSeconds', 'expSeconds'];
const BINDING_KEYS = ['subject', 'audience', 'method', 'path', 'query', 'body',
  'operation', 'phase', 'tenantId', 'generationJobId', 'delegationRef',
  'consentId', 'attemptId', 'runId', 'acceptedBindingSha256', 'sourceSha256'];

/** A draft delegation may authorize a distinct, read-only Meri token. This
 * mapping is an issuer decision, never inferred from caller-supplied claims. */
export function tokenOperationForWorkAction(
  workAction: string, phase: ObjectiveWorkloadPhase,
): ObjectiveWorkloadOperation | null {
  if (workAction !== 'objective.strategy.draft') return null;
  return phase === 'retained-result-read'
    ? 'objective.retained-result.read' : 'objective.strategy.draft';
}

export class ObjectiveWorkloadIssuanceError extends Error {
  constructor(readonly code: 'UNAVAILABLE' | 'CONFLICT' | 'EXPIRED') {
    super('Objective workload issuance unavailable');
  }
}

function unavailable(): never { throw new ObjectiveWorkloadIssuanceError('UNAVAILABLE'); }
function conflict(): never { throw new ObjectiveWorkloadIssuanceError('CONFLICT'); }
const seconds = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME;
const uuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);
const uuidV4 = (value: unknown): value is string => typeof value === 'string' && UUID_V4.test(value);
const sha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);

function captureOwn<T>(raw: unknown, keys: readonly string[]): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
      Reflect.ownKeys(raw).length !== keys.length) unavailable();
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) unavailable();
    captured[key] = descriptor.value;
  }
  if (Reflect.ownKeys(raw).some((key) => typeof key !== 'string' || !keys.includes(key))) unavailable();
  return captured as T;
}

export interface VerifiedObjectiveCallerProof {
  /** Supplied only by an independently verified, pinned caller-proof verifier. */
  readonly issuer: string;
  readonly subject: string;
  readonly keyId: string;
  readonly jti: string;
  readonly operationId: string;
  /** SHA-256 of exact raw bytes received by the Core issuance ingress. */
  readonly requestSha256: string;
  readonly iatSeconds: number;
  readonly nbfSeconds: number;
  readonly expSeconds: number;
}

export interface ObjectiveIssuanceSelector {
  readonly tenantId: string;
  readonly delegationRef: string;
  readonly consentId: string;
  readonly generationJobId: string;
  readonly phase: ObjectiveWorkloadPhase;
}

/** The current-authority adapter must derive and lock these facts from Core's
 * exact consent/control/delegation and the queued Strategy job, including its
 * immutable request fingerprint, key, actor and policy revision. It must deny
 * changed or incomplete source independently of this narrower ledger tuple. */
export interface CurrentObjectiveIssuanceSource {
  readonly enabled: boolean;
  readonly databaseNowSeconds: number;
  readonly validUntilSeconds: number;
  readonly tenantId: string;
  readonly clientId: string;
  readonly objectiveId: string;
  readonly workAction: 'objective.strategy.draft';
  readonly controlId: string;
  readonly consentId: string;
  readonly generationJobId: string;
  readonly delegationRef: string;
  readonly serviceSubject: string;
  readonly audience: string;
  /** Derived from independently locked full source for Meri retained reads;
   * null for Strategy phases. Never copy this from the target request. */
  readonly sourceSha256: string | null;
}

/** Camel-case scalar mirror of the source migration's immutable row. */
export interface ObjectiveWorkloadIssuanceRecord {
  readonly operationId: string;
  readonly tenantId: string;
  readonly clientId: string;
  readonly objectiveId: string;
  readonly workAction: 'objective.strategy.draft';
  readonly controlId: string;
  readonly consentId: string;
  readonly generationJobId: string;
  readonly delegationRef: string;
  readonly callerIssuer: string;
  readonly callerSubject: string;
  readonly issuanceRequestSha256: string;
  readonly authorizationJti: string;
  readonly tokenIssuer: string;
  readonly tokenSubject: string;
  readonly tokenAudience: string;
  readonly signerKeyId: string;
  readonly phase: ObjectiveWorkloadPhase;
  readonly targetMethod: 'GET' | 'POST';
  readonly targetPath: string;
  readonly targetQuery: '';
  readonly targetBodySha256: string;
  readonly attemptId: string | null;
  readonly runId: string | null;
  readonly acceptedBindingSha256: string | null;
  readonly sourceSha256: string | null;
  readonly iatSeconds: bigint;
  readonly nbfSeconds: bigint;
  readonly expSeconds: bigint;
}

export interface ObjectiveWorkloadProofUseRecord {
  readonly tenantId: string | null;
  readonly callerIssuer: string;
  readonly callerSubject: string;
  readonly callerKeyId: string;
  readonly proofJti: string;
  readonly operationId: string;
  readonly operationDecision: 'issued' | 'denied';
  readonly proofOutcome: 'issued' | 'denied';
  readonly proofRequestSha256: string;
  readonly proofIatSeconds: bigint;
  readonly proofNbfSeconds: bigint;
  readonly proofExpSeconds: bigint;
}

/** Global operation identity survives source revocation or delegation deletion.
 * A denied decision is terminal; later proofs for the operation remain denied. */
export interface ObjectiveWorkloadIssueDecisionRecord {
  readonly operationId: string;
  readonly callerIssuer: string;
  readonly callerSubject: string;
  readonly issuanceRequestSha256: string;
  readonly decision: 'issued' | 'denied';
  readonly tenantId: string | null;
  readonly generationJobId: string | null;
  readonly phase: ObjectiveWorkloadPhase | null;
}

/** The claim commits before any signature is produced. A crashed/uncertain
 * finalization remains CLAIMED and is treated as UNKNOWN on every replay. */
export interface ObjectiveWorkloadDeliveryRecord {
  readonly operationId: string;
  readonly tenantId: string;
  readonly authorizationJti: string;
  readonly state: 'claimed' | 'issued' | 'unknown';
  readonly tokenSha256: string | null;
}

export interface ObjectiveIssuanceTransaction {
  /** Must serialize this operation ID across processes until commit/rollback. */
  lockOperation(operationId: string): Promise<void>;
  findDecision(operationId: string): Promise<ObjectiveWorkloadIssueDecisionRecord | null>;
  insertDecision(row: ObjectiveWorkloadIssueDecisionRecord): Promise<void>;
  findIssuance(operationId: string): Promise<ObjectiveWorkloadIssuanceRecord | null>;
  insertIssuance(row: ObjectiveWorkloadIssuanceRecord): Promise<void>;
  findDelivery(operationId: string): Promise<ObjectiveWorkloadDeliveryRecord | null>;
  insertDelivery(row: ObjectiveWorkloadDeliveryRecord): Promise<void>;
  finalizeDelivery(operationId: string, state: 'issued' | 'unknown', tokenSha256: string | null): Promise<void>;
  findProofUse(callerIssuer: string, proofJti: string): Promise<ObjectiveWorkloadProofUseRecord | null>;
  insertProofUse(row: ObjectiveWorkloadProofUseRecord): Promise<void>;
}

export interface ObjectiveIssuanceTransactionPort {
  /** One tenant-scoped database transaction covers current authority, the
   * issuance row and proof use. Failed inserts must roll back all three. */
  withTenantTransaction<T>(
    tenantId: string,
    run: (tx: ObjectiveIssuanceTransaction) => Promise<T>,
  ): Promise<T>;
  loadCurrent(
    tx: ObjectiveIssuanceTransaction,
    selector: ObjectiveIssuanceSelector,
  ): Promise<CurrentObjectiveIssuanceSource>;
}

export interface ObjectiveIssuanceSignerPins {
  /** Local, issuer-owned key pins; never fetched from the proof or JWT.
   * For a new claim, byKid must return the same private KeyObject instance
   * selected by active until signing finishes. Rotation or a reconstructed
   * object closes delivery as UNKNOWN; it never silently changes the key. */
  active(): ObjectiveWorkloadIssuerSigner | null;
  byKid(kid: string): ObjectiveWorkloadIssuerSigner | null;
}

export interface ObjectiveIssuanceInput {
  /** Future ingress must resolve tenant/delegation/job from Core-owned source;
   * caller JSON cannot choose a tenant or override this selector. */
  readonly selector: ObjectiveIssuanceSelector;
  readonly proof: VerifiedObjectiveCallerProof;
  readonly rawIssuanceRequestBytes: Uint8Array;
  /** Fixed route and target bytes resolved by trusted ingress, then compared
   * with the locked source. Neither proof claims nor caller JSON are a grant. */
  readonly binding: ObjectiveWorkloadRequestBinding;
}

const IMMUTABLE_TUPLE = [
  'operationId', 'tenantId', 'clientId', 'objectiveId', 'workAction', 'controlId',
  'consentId', 'generationJobId', 'delegationRef', 'callerIssuer', 'callerSubject',
  'issuanceRequestSha256', 'tokenIssuer', 'tokenSubject', 'tokenAudience',
  'phase', 'targetMethod', 'targetPath', 'targetQuery', 'targetBodySha256',
  'attemptId', 'runId', 'acceptedBindingSha256',
  'sourceSha256',
] as const satisfies ReadonlyArray<keyof ObjectiveWorkloadIssuanceRecord>;

function sameTuple(
  saved: ObjectiveWorkloadIssuanceRecord,
  expected: Pick<ObjectiveWorkloadIssuanceRecord, (typeof IMMUTABLE_TUPLE)[number]>,
): boolean {
  return IMMUTABLE_TUPLE.every((key) => saved[key] === expected[key]);
}

function sameProofIdentity(saved: ObjectiveWorkloadProofUseRecord, expected: ObjectiveWorkloadProofUseRecord) {
  return (Object.keys(expected) as Array<keyof ObjectiveWorkloadProofUseRecord>)
    .filter((key) => key !== 'proofOutcome')
    .every((key) => saved[key] === expected[key]);
}

function requireAdmitTargetBody(body: Uint8Array, generationJobId: string): void {
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(body);
    const parsed: unknown = JSON.parse(decoded);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.getPrototypeOf(parsed) !== Object.prototype) unavailable();
    const fields = Object.keys(parsed).sort();
    if (fields.length !== 2 || fields[0] !== 'generationJobId' || fields[1] !== 'schemaVersion') unavailable();
    const request = parsed as Record<string, unknown>;
    if (request.schemaVersion !== 1 || request.generationJobId !== generationJobId) unavailable();
  } catch { unavailable(); }
}

/** Reserve an operation, exact claim and verified proof before signing. A
 * second transaction releases the token only after current authority and the
 * original claim are checked again. A CLAIMED receipt is an UNKNOWN delivery
 * on retry; it never allocates another jti or re-signs. The source migration
 * still disables every real delegation until a reviewed enablement change. */
export function createObjectiveWorkloadIssuanceAdapter(
  port: ObjectiveIssuanceTransactionPort,
  pins: ObjectiveIssuanceSignerPins,
  allocateJti: () => string = randomUUID,
) {
  return async (input: ObjectiveIssuanceInput): Promise<Readonly<{
    token: string;
    authorizationJti: string;
    iatSeconds: number;
    expSeconds: number;
  }>> => {
    const request = captureOwn<ObjectiveIssuanceInput>(input, INPUT_KEYS);
    const selector = captureOwn<ObjectiveIssuanceSelector>(request.selector, SELECTOR_KEYS);
    const proof = captureOwn<VerifiedObjectiveCallerProof>(request.proof, PROOF_KEYS);
    const raw = request.rawIssuanceRequestBytes;
    const supplied = captureOwn<ObjectiveWorkloadRequestBinding>(request.binding, BINDING_KEYS);
    if (!selector || !proof || !supplied || !uuid(selector.tenantId) ||
        !uuid(selector.delegationRef) || !uuid(selector.consentId) ||
        !uuid(selector.generationJobId) || !FIRST_SLICE_PHASES.has(selector.phase) ||
        !uuid(proof.operationId) || !uuid(proof.jti) || !sha256(proof.requestSha256) ||
        typeof proof.issuer !== 'string' || !proof.issuer ||
        typeof proof.subject !== 'string' || !proof.subject ||
        typeof proof.keyId !== 'string' || !proof.keyId ||
        !seconds(proof.iatSeconds) || !seconds(proof.nbfSeconds) ||
        !seconds(proof.expSeconds) || proof.nbfSeconds < proof.iatSeconds ||
        proof.expSeconds <= proof.nbfSeconds || proof.expSeconds - proof.iatSeconds > 30 ||
        !(raw instanceof Uint8Array) || nodeTypes.isProxy(raw) ||
        raw.byteLength === 0 || raw.byteLength > MAX_REQUEST_BYTES ||
        createHash('sha256').update(raw).digest('hex') !== proof.requestSha256 ||
        !(supplied.body instanceof Uint8Array) || nodeTypes.isProxy(supplied.body)) unavailable();

    // Capture the bytes before the first await. A mutable caller buffer cannot
    // change the stored hash or signed target after current-source reads.
    const binding: ObjectiveWorkloadRequestBinding = {
      subject: supplied.subject, audience: supplied.audience,
      method: supplied.method, path: supplied.path, query: supplied.query,
      body: Buffer.from(supplied.body), operation: supplied.operation,
      phase: supplied.phase, tenantId: supplied.tenantId,
      generationJobId: supplied.generationJobId, delegationRef: supplied.delegationRef,
      consentId: supplied.consentId, attemptId: supplied.attemptId,
      runId: supplied.runId, acceptedBindingSha256: supplied.acceptedBindingSha256,
      sourceSha256: supplied.sourceSha256,
    };
    if (binding.phase !== selector.phase || binding.tenantId !== selector.tenantId ||
        binding.delegationRef !== selector.delegationRef ||
        binding.consentId !== selector.consentId ||
        binding.generationJobId !== selector.generationJobId) unavailable();
    if (binding.phase !== 'admit') unavailable();
    requireAdmitTargetBody(binding.body, selector.generationJobId);
    const bodySha256 = createHash('sha256').update(binding.body).digest('hex');

    const isCurrent = (facts: CurrentObjectiveIssuanceSource): boolean =>
      !!facts && facts.enabled === true && seconds(facts.databaseNowSeconds) &&
          seconds(facts.validUntilSeconds) &&
          facts.validUntilSeconds > facts.databaseNowSeconds &&
          facts.tenantId === selector.tenantId &&
          facts.delegationRef === selector.delegationRef &&
          facts.consentId === selector.consentId &&
          facts.generationJobId === selector.generationJobId &&
          tokenOperationForWorkAction(facts.workAction, binding.phase) === binding.operation &&
          facts.serviceSubject === binding.subject && facts.audience === binding.audience &&
          facts.sourceSha256 === binding.sourceSha256 &&
          uuid(facts.clientId) && uuid(facts.objectiveId) && uuid(facts.controlId) &&
          proof.iatSeconds <= facts.databaseNowSeconds &&
          proof.nbfSeconds <= facts.databaseNowSeconds &&
          proof.expSeconds > facts.databaseNowSeconds;
    const currentOrNull = async (tx: ObjectiveIssuanceTransaction): Promise<CurrentObjectiveIssuanceSource | null> => {
      try {
        const facts = await port.loadCurrent(tx, selector);
        return isCurrent(facts) ? facts : null;
      } catch (error) {
        // Semantic absence commits a denial; SQL and transaction faults roll back.
        if (error instanceof ObjectiveCurrentSourceUnavailable) return null;
        throw error;
      }
    };
    type Outcome =
      | { readonly kind: 'issued'; readonly token: string; readonly authorizationJti: string;
          readonly iatSeconds: number; readonly expSeconds: number }
      | { readonly kind: 'claimed'; readonly row: ObjectiveWorkloadIssuanceRecord;
          readonly signer: ObjectiveWorkloadIssuerSigner }
      | { readonly kind: 'denied'; readonly code: ObjectiveWorkloadIssuanceError['code'] };
    const outcome = await port.withTenantTransaction<Outcome>(selector.tenantId, async (tx) => {
      // Keep the source job lock before the operation lock. An operation wait
      // can age the proof or source, so only a second locked read can issue.
      const first = await currentOrNull(tx);
      await tx.lockOperation(proof.operationId);
      const decision = await tx.findDecision(proof.operationId);
      if (decision && (decision.callerIssuer !== proof.issuer ||
          decision.callerSubject !== proof.subject ||
          decision.issuanceRequestSha256 !== proof.requestSha256 ||
          decision.tenantId !== selector.tenantId ||
          (decision.decision === 'issued' &&
            (decision.generationJobId !== selector.generationJobId ||
             decision.phase !== selector.phase)))) conflict();
      const priorProof = await tx.findProofUse(proof.issuer, proof.jti);
      const proofUse = (operationDecision: 'issued' | 'denied', proofOutcome: 'issued' | 'denied'):
          ObjectiveWorkloadProofUseRecord => ({
        tenantId: selector.tenantId, callerIssuer: proof.issuer,
        callerSubject: proof.subject, callerKeyId: proof.keyId,
        proofJti: proof.jti, operationId: proof.operationId,
        operationDecision, proofOutcome,
        proofRequestSha256: proof.requestSha256,
        proofIatSeconds: BigInt(proof.iatSeconds),
        proofNbfSeconds: BigInt(proof.nbfSeconds),
        proofExpSeconds: BigInt(proof.expSeconds),
      });
      if (priorProof && (!decision ||
          !sameProofIdentity(priorProof, proofUse(decision.decision, priorProof.proofOutcome)))) conflict();
      const deny = async (code: ObjectiveWorkloadIssuanceError['code']): Promise<Outcome> => {
        const finalDecision = decision ?? {
          operationId: proof.operationId, callerIssuer: proof.issuer,
          callerSubject: proof.subject, issuanceRequestSha256: proof.requestSha256,
          decision: 'denied' as const, tenantId: selector.tenantId,
          generationJobId: null, phase: null,
        };
        if (!decision) await tx.insertDecision(finalDecision);
        if (!priorProof) await tx.insertProofUse(proofUse(finalDecision.decision, 'denied'));
        return { kind: 'denied', code };
      };
      if (decision?.decision === 'denied' || priorProof?.proofOutcome === 'denied')
        return deny('UNAVAILABLE');
      if (!first) return deny('UNAVAILABLE');
      const facts = await currentOrNull(tx);
      if (!facts) return deny('UNAVAILABLE');
      const saved = decision ? await tx.findIssuance(proof.operationId) : null;
      if (decision?.decision === 'issued' && !saved) return deny('UNAVAILABLE');
      const delivery = saved ? await tx.findDelivery(proof.operationId) : null;
      if (saved && (!delivery || delivery.tenantId !== selector.tenantId ||
          delivery.authorizationJti !== saved.authorizationJti ||
          delivery.state !== 'issued' || !sha256(delivery.tokenSha256))) {
        // CLAIMED may still be finalizing elsewhere. UNKNOWN is terminal. In
        // both cases a retry may neither sign nor allocate another jti.
        return deny('UNAVAILABLE');
      }
      const activeSigner = saved ? null : pins.active();
      const expected = {
        operationId: proof.operationId, tenantId: facts.tenantId,
        clientId: facts.clientId, objectiveId: facts.objectiveId,
        workAction: facts.workAction, controlId: facts.controlId,
        consentId: facts.consentId, generationJobId: facts.generationJobId,
        delegationRef: facts.delegationRef, callerIssuer: proof.issuer,
        callerSubject: proof.subject, issuanceRequestSha256: proof.requestSha256,
        tokenIssuer: saved?.tokenIssuer ?? activeSigner?.issuer ?? '',
        tokenSubject: binding.subject, tokenAudience: binding.audience,
        phase: binding.phase, targetMethod: binding.method,
        targetPath: binding.path, targetQuery: binding.query,
        targetBodySha256: bodySha256, attemptId: binding.attemptId,
        runId: binding.runId, acceptedBindingSha256: binding.acceptedBindingSha256,
        sourceSha256: binding.sourceSha256,
      } satisfies Pick<ObjectiveWorkloadIssuanceRecord, (typeof IMMUTABLE_TUPLE)[number]>;
      if (saved && !sameTuple(saved, expected)) return deny('CONFLICT');

      const signer = saved ? pins.byKid(saved.signerKeyId) : activeSigner;
      if (!signer || signer.issuer !== expected.tokenIssuer ||
          (saved && signer.kid !== saved.signerKeyId)) return deny('UNAVAILABLE');
      let issuance = saved;
      if (saved) {
        if (!seconds(Number(saved.iatSeconds)) || !seconds(Number(saved.nbfSeconds)) ||
            !seconds(Number(saved.expSeconds)) ||
            saved.nbfSeconds !== saved.iatSeconds ||
            saved.expSeconds <= saved.nbfSeconds ||
            saved.expSeconds - saved.iatSeconds > 60n ||
            facts.databaseNowSeconds >= Number(saved.expSeconds) ||
            facts.validUntilSeconds < Number(saved.expSeconds) ||
            !uuidV4(saved.authorizationJti)) return deny('EXPIRED');
      } else {
        const jti = allocateJti();
        const exp = Math.min(facts.validUntilSeconds, facts.databaseNowSeconds + 60);
        if (!uuidV4(jti) || exp <= facts.databaseNowSeconds) return deny('UNAVAILABLE');
        issuance = {
          ...expected, authorizationJti: jti, signerKeyId: signer.kid,
          iatSeconds: BigInt(facts.databaseNowSeconds),
          nbfSeconds: BigInt(facts.databaseNowSeconds), expSeconds: BigInt(exp),
        };
      }
      const row = Object.freeze(issuance ?? unavailable());
      if (!decision) {
        await tx.insertDecision({ operationId: proof.operationId,
          callerIssuer: proof.issuer, callerSubject: proof.subject,
          issuanceRequestSha256: proof.requestSha256,
          decision: 'issued', tenantId: facts.tenantId,
          generationJobId: facts.generationJobId, phase: binding.phase });
        await tx.insertIssuance(row);
        await tx.insertDelivery({ operationId: proof.operationId,
          tenantId: selector.tenantId, authorizationJti: row.authorizationJti,
          state: 'claimed', tokenSha256: null });
        await tx.insertProofUse(proofUse('issued', 'issued'));
        return Object.freeze({ kind: 'claimed' as const, row, signer });
      }
      let token: string;
      try {
        token = issueObjectiveWorkloadJwt(binding, signer, {
          jti: row.authorizationJti, nowSeconds: Number(row.iatSeconds),
          expiresAtSeconds: Number(row.expSeconds),
        });
      } catch (error) {
        if (error instanceof ObjectiveWorkloadJwtError) return deny('UNAVAILABLE');
        throw error;
      }
      if (createHash('sha256').update(token).digest('hex') !== delivery?.tokenSha256)
        return deny('UNAVAILABLE');
      if (!priorProof) await tx.insertProofUse(proofUse('issued', 'issued'));
      return Object.freeze({
        kind: 'issued' as const, token, authorizationJti: row.authorizationJti,
        iatSeconds: Number(row.iatSeconds), expSeconds: Number(row.expSeconds),
      });
    });
    if (outcome.kind === 'denied') throw new ObjectiveWorkloadIssuanceError(outcome.code);
    if (outcome.kind === 'claimed') {
      const row = outcome.row;
      let token: string;
      try {
        const signer = pins.byKid(row.signerKeyId);
        if (!signer || signer.issuer !== row.tokenIssuer || signer.kid !== row.signerKeyId ||
            signer.privateKey !== outcome.signer.privateKey)
          unavailable();
        token = issueObjectiveWorkloadJwt(binding, signer, {
          jti: row.authorizationJti, nowSeconds: Number(row.iatSeconds),
          expiresAtSeconds: Number(row.expSeconds),
        });
      } catch {
        // If this write fails, CLAIMED itself remains the permanent uncertain
        // delivery fence. A later request never attempts another signature.
        try {
          await port.withTenantTransaction(selector.tenantId, async (tx) => {
            await tx.lockOperation(proof.operationId);
            const delivery = await tx.findDelivery(proof.operationId);
            if (delivery?.state === 'claimed' && delivery.authorizationJti === row.authorizationJti)
              await tx.finalizeDelivery(proof.operationId, 'unknown', null);
          });
        } catch { /* The committed claim is the fallback UNKNOWN state. */ }
        unavailable();
      }
      const tokenSha256 = createHash('sha256').update(token).digest('hex');
      // The token stays private until this transaction commits. A failed or
      // uncertain commit leaks no bearer and leaves an immutable JTI claim.
      const finalized = await port.withTenantTransaction(selector.tenantId, async (tx) => {
        const first = await currentOrNull(tx);
        await tx.lockOperation(proof.operationId);
        const decision = await tx.findDecision(proof.operationId);
        const saved = await tx.findIssuance(proof.operationId);
        const delivery = await tx.findDelivery(proof.operationId);
        const facts = await currentOrNull(tx);
        const valid = !!first && !!facts && !!saved && !!delivery &&
          decision?.decision === 'issued' && decision.tenantId === selector.tenantId &&
          decision.generationJobId === selector.generationJobId && decision.phase === selector.phase &&
          decision.callerIssuer === proof.issuer && decision.callerSubject === proof.subject &&
          decision.issuanceRequestSha256 === proof.requestSha256 &&
          sameTuple(saved, row) && saved.authorizationJti === row.authorizationJti &&
          saved.signerKeyId === row.signerKeyId && saved.iatSeconds === row.iatSeconds &&
          saved.nbfSeconds === row.nbfSeconds && saved.expSeconds === row.expSeconds &&
          delivery.tenantId === selector.tenantId &&
          delivery.authorizationJti === row.authorizationJti && delivery.state === 'claimed' &&
          facts.clientId === row.clientId && facts.objectiveId === row.objectiveId &&
          facts.controlId === row.controlId &&
          facts.databaseNowSeconds < Number(row.expSeconds) &&
          facts.validUntilSeconds >= Number(row.expSeconds);
        if (!valid) {
          if (delivery?.state === 'claimed' && delivery.authorizationJti === row.authorizationJti)
            await tx.finalizeDelivery(proof.operationId, 'unknown', null);
          return false;
        }
        await tx.finalizeDelivery(proof.operationId, 'issued', tokenSha256);
        return true;
      });
      if (!finalized) unavailable();
      return Object.freeze({ token, authorizationJti: row.authorizationJti,
        iatSeconds: Number(row.iatSeconds), expSeconds: Number(row.expSeconds) });
    }
    return Object.freeze({ token: outcome.token, authorizationJti: outcome.authorizationJti,
      iatSeconds: outcome.iatSeconds, expSeconds: outcome.expSeconds });
  };
}
