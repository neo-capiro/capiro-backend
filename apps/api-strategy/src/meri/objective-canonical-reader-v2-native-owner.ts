import { types as nodeTypes } from 'node:util';
import type { Request } from 'express';
import type { Prisma } from '../../generated/prisma-client/index.js';
import { applicationHash, applicationJson, CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import type { CanonicalGenerationGrant, CanonicalGenerationSubject, ObjectiveCanonicalWorkloadAuthority } from '../planner/objective-canonical-authority.js';
import { GENERATION_ADMISSION, GENERATION_ACCEPTANCE, canonicalGenerationAdmissionSha256, generationSha256, generationUuid,
  parseCanonicalGenerationAdmission, requireGenerationAcceptanceForAdmission } from './objective-canonical-generation.js';
import { readGenerationLedger } from './objective-canonical-producer-ledger.js';
import { canonicalPublicationInputHash, readCanonicalRequestPublication } from './objective-canonical-request-ledger.js';
import { requireCanonicalGenerationReadWithinTx } from './objective-canonical-generation-fence.js';
import type { CanonicalReaderV2NativeOwner, CanonicalReaderV2NativeSource, CanonicalReaderV2NativeAcceptanceSource,
  CanonicalReaderV2Selector } from './objective-canonical-reader-v2-receiving.js';

/** Actual Prisma scope API, not an alternative transaction implementation.
 * Supply a plain trusted server facade whose withTenant is bound to the actual
 * service; generated Prisma clients are dynamic Proxies and are deliberately
 * not discovered here. The service must honor timeoutMs. Test fixtures label
 * synthetic rows/transactions explicitly. */
export interface CanonicalReaderV2Prisma {
  withTenant<T>(tenantId: string, run: (tx: Prisma.TransactionClient) => Promise<T>, options?: { timeoutMs?: number }): Promise<T>;
}
export interface CanonicalReaderV2RetainedAccess {
  readonly purpose: 'retained-result-read'; readonly tenantId: string; readonly clientId: string;
  readonly objectiveId: string; readonly actorUserId: string; readonly clerkUserId: string;
  readonly generationJobId: string; readonly sourceAdmissionSha256: string;
  readonly checkedAtMs: number; readonly expiresAtMs: number;
}
export interface CanonicalReaderV2RetainedAccessOwner {
  /** A genuine server-authenticated native principal/context supplies this
   * decision. Selector/job/SHA fields are comparators, never permission.
   * No caller binding, tenant hint, browser principal or old consent is a grant. */
  authorize(selector: CanonicalReaderV2Selector, options: { signal: AbortSignal }): Promise<CanonicalReaderV2RetainedAccess>;
  /** Repeat principal/session/service-purpose currentness in this SAME native
   * tenant transaction. Native DB work only; no Meri/network/model operation. */
  assertCurrent(tx: Prisma.TransactionClient, access: CanonicalReaderV2RetainedAccess, selector: CanonicalReaderV2Selector): Promise<void>;
}
export interface CanonicalReaderV2NativeOwnerOptions {
  readonly enabled?: boolean; readonly prisma?: CanonicalReaderV2Prisma;
  /** Distinct genuine base verifier. Never pass an observer that delegates
   * verifyGeneration back to receiving.verifyGenerationAcceptance. */
  readonly authority?: Pick<ObjectiveCanonicalWorkloadAuthority, 'verifyGeneration' | 'assertGenerationCurrent'>;
  readonly retainedAccess?: CanonicalReaderV2RetainedAccessOwner; readonly now?: () => number;
}
type Tx = Prisma.TransactionClient;
type Scope = { tenantId: string; clerkUserId: string; generationJobId: string };
const MAX_MS = 3000, MAX_BYTES = 2 * 1024 * 1024;
function unavailable(): never { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); }
function own(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) unavailable();
  const allowed = [...required, ...optional], keys = Reflect.ownKeys(raw);
  if (keys.some(k => typeof k !== 'string' || !allowed.includes(k))) unavailable();
  const out: Record<string, unknown> = {};
  for (const key of allowed) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d) { if (required.includes(key)) unavailable(); continue; }
    if (!d.enumerable || !('value' in d)) unavailable(); out[key] = d.value;
  }
  return out;
}
/** Bind plain server facades or native authority class methods without
 * evaluating accessors. Dynamic Prisma discovery belongs to its trusted server
 * composition, which supplies an explicit bound withTenant facade above. */
function method<T extends (...args: any[]) => any>(raw: unknown, name: string): T {
  if (!raw || (typeof raw !== 'object' && typeof raw !== 'function') || nodeTypes.isProxy(raw)) unavailable();
  let cursor: object | null = raw;
  while (cursor !== null && cursor !== Object.prototype) {
    if (nodeTypes.isProxy(cursor)) unavailable();
    const d = Object.getOwnPropertyDescriptor(cursor, name);
    if (d) {
      if (!('value' in d) || typeof d.value !== 'function' || nodeTypes.isProxy(d.value)) unavailable();
      return d.value.bind(raw) as T;
    }
    cursor = Object.getPrototypeOf(cursor);
  }
  return unavailable();
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { Object.values(value).forEach(frozen); Object.freeze(value); } return value;
}
function data<T>(value: T): T {
  // Existing canonical JSON rejects executable properties, Proxies, cycles,
  // sparse arrays, foreign prototypes and nonfinite/unsafe numeric values.
  const text = applicationJson(value); if (Buffer.byteLength(text) > MAX_BYTES) unavailable();
  return frozen(JSON.parse(text));
}
function milliseconds(value: unknown): number {
  const n = typeof value === 'string' && /^(0|[1-9][0-9]*)$/.exec(value)?.[0] === value ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > 8_640_000_000_000_000) unavailable(); return n;
}
function actor(value: unknown): string { if (typeof value !== 'string' || value.length < 1 || value.length > 128) unavailable(); return value; }
function grantData(raw: CanonicalGenerationGrant, subject: CanonicalGenerationSubject): CanonicalGenerationGrant {
  const g = own(data(raw), ['tenantId', 'actorUserId', 'clerkUserId', 'consentId', 'controlVersion', 'requestSha256',
    'checkedAtMs', 'expiresAtMs', 'delegationExpiresAtMs', 'claimExpiresAtMs'], ['delegation']);
  for (const key of ['tenantId', 'actorUserId', 'consentId']) generationUuid(g[key]); actor(g.clerkUserId);
  if (!Number.isSafeInteger(g.controlVersion) || (g.controlVersion as number) < 1 || (g.controlVersion as number) > 2147483647 ||
      generationSha256(g.requestSha256) !== subject.requestSha256) unavailable();
  for (const key of ['checkedAtMs', 'expiresAtMs', 'delegationExpiresAtMs', 'claimExpiresAtMs']) {
    if (typeof g[key] !== 'number') unavailable(); milliseconds(g[key]);
  }
  if (g.delegation !== undefined) {
    const d = own(g.delegation, ['ref', 'revision', 'issuedAtMs', 'absoluteExpiresAtMs']);
    generationUuid(d.ref); if (typeof d.revision !== 'string' || !d.revision || d.revision.length > 256) unavailable();
    if (typeof d.issuedAtMs !== 'number' || typeof d.absoluteExpiresAtMs !== 'number' || milliseconds(d.issuedAtMs) >= milliseconds(d.absoluteExpiresAtMs)) unavailable();
  }
  return data(g) as unknown as CanonicalGenerationGrant;
}
function accessData(raw: CanonicalReaderV2RetainedAccess, selector: CanonicalReaderV2Selector): CanonicalReaderV2RetainedAccess {
  const a = own(data(raw), ['purpose', 'tenantId', 'clientId', 'objectiveId', 'actorUserId', 'clerkUserId',
    'generationJobId', 'sourceAdmissionSha256', 'checkedAtMs', 'expiresAtMs']);
  for (const key of ['tenantId', 'clientId', 'objectiveId', 'actorUserId', 'generationJobId']) generationUuid(a[key]); actor(a.clerkUserId);
  if (a.purpose !== 'retained-result-read' || a.generationJobId !== selector.generationJobId ||
      generationSha256(a.sourceAdmissionSha256) !== selector.sourceAdmissionSha256) unavailable();
  if (typeof a.checkedAtMs !== 'number' || typeof a.expiresAtMs !== 'number') unavailable();
  milliseconds(a.checkedAtMs); milliseconds(a.expiresAtMs); return data(a) as unknown as CanonicalReaderV2RetainedAccess;
}

/** Persisted custody only. This reconstructs the actual original publication
 * against native job DTO/marker/revision/intent hashes using its existing owner.
 * It never calls the mutating admission helper or creates a claim/admission. */
async function stored(tx: Tx, scope: Scope) {
  const job = await tx.spDraftJob.findFirst({ where: { tenantId: scope.tenantId, id: scope.generationJobId, ownerUserId: scope.clerkUserId } });
  if (!job || job.id !== scope.generationJobId || job.tenantId !== scope.tenantId || job.ownerUserId !== scope.clerkUserId) unavailable();
  const input = data(job.input) as any;
  const rawAdmission = await readGenerationLedger(tx, GENERATION_ADMISSION, scope.tenantId, scope.clerkUserId, scope.generationJobId);
  if (!rawAdmission) unavailable();
  const admission = parseCanonicalGenerationAdmission(data(rawAdmission));
  if (admission.expectedStrategyVersionId !== null || admission.canonical.tenantId !== scope.tenantId || admission.clerkUserId !== scope.clerkUserId ||
      admission.generationJobId !== scope.generationJobId || job.clientId !== admission.canonical.clientId) unavailable();
  await requireCanonicalGenerationReadWithinTx(tx, admission, scope.clerkUserId);
  const published = await readCanonicalRequestPublication(tx, admission);
  if (!published || 'requestVersion' in published.publication.request || !input.dto || canonicalPublicationInputHash(input) !== published.inputSha256) unavailable();
  // readCanonicalRequestPublication independently reads the same locked job.
  // Pin its input hash as well as the separately captured original DTO.
  const originalDto = data(input.dto);
  const rawAcceptance = await readGenerationLedger(tx, GENERATION_ACCEPTANCE, scope.tenantId, scope.clerkUserId, scope.generationJobId);
  const acceptance = rawAcceptance === null ? null : requireGenerationAcceptanceForAdmission(data(rawAcceptance), admission);
  if (acceptance && (acceptance.issuance.expiresAtMs > published.publication.request.originalExpiresAtMs ||
      acceptance.sourceBinding.tenantId !== published.publication.request.principal.tenantId ||
      acceptance.sourceBinding.actorId !== published.publication.request.principal.actorId)) unavailable();
  const value = data({ originalDto, admission, publication: published.publication, acceptance });
  return { ...value, identity: applicationHash({ value, inputSha256: published.inputSha256, publicationSha256: published.publicationSha256 }) };
}

export function createPrismaCanonicalReaderV2NativeOwner(options: CanonicalReaderV2NativeOwnerOptions = {}): CanonicalReaderV2NativeOwner {
  const deny = async (): Promise<never> => unavailable();
  const closed: CanonicalReaderV2NativeOwner = Object.freeze({ readAcceptance: deny, readRetained: deny });
  if (!options || typeof options !== 'object' || nodeTypes.isProxy(options)) return closed;
  const enable = Object.getOwnPropertyDescriptor(options, 'enabled');
  if (!enable || !('value' in enable) || enable.value !== true) return closed;
  let withTenant: CanonicalReaderV2Prisma['withTenant'], verify: NonNullable<CanonicalReaderV2NativeOwnerOptions['authority']>['verifyGeneration'];
  let assertGeneration: NonNullable<CanonicalReaderV2NativeOwnerOptions['authority']>['assertGenerationCurrent'];
  let authorize: CanonicalReaderV2RetainedAccessOwner['authorize'], assertRetained: CanonicalReaderV2RetainedAccessOwner['assertCurrent'], now: () => number;
  try {
    const o = own(options, ['enabled', 'prisma', 'authority', 'retainedAccess'], ['now']);
    withTenant = method(o.prisma, 'withTenant'); verify = method(o.authority, 'verifyGeneration'); assertGeneration = method(o.authority, 'assertGenerationCurrent');
    authorize = method(o.retainedAccess, 'authorize'); assertRetained = method(o.retainedAccess, 'assertCurrent');
    if (o.now !== undefined && (typeof o.now !== 'function' || nodeTypes.isProxy(o.now))) return closed;
    now = (o.now as (() => number) | undefined) ?? Date.now;
  } catch { return closed; }
  async function operation<T>(rawOptions: { signal: AbortSignal }, work: (op: {
    signal: AbortSignal; started: number; deadline: number; guard: (expiry?: number) => number;
    bounded: <V>(work: () => Promise<V>, expiry?: number) => Promise<V>;
  }) => Promise<{ value: T; expiresAtMs: number }>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined, caller: AbortSignal | undefined, controller: AbortController | undefined, abort: (() => void) | undefined;
    try {
      const signal = own(rawOptions, ['signal']).signal;
      if (nodeTypes.isProxy(signal) || !(signal instanceof AbortSignal) || signal.aborted) unavailable(); caller = signal;
      let last = -1;
      const tick = () => { const n = now(); if (!Number.isSafeInteger(n) || n < 0 || n < last) unavailable(); last = n; return n; };
      const started = tick(), deadline = started + MAX_MS; controller = new AbortController();
      const internal = controller; abort = () => internal.abort(); caller.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, MAX_MS); timer.unref?.();
      const guard = (expiry = deadline) => { const n = tick(); if (internal.signal.aborted || caller!.aborted || n >= Math.min(deadline, expiry)) unavailable(); return n; };
      const bounded = <V>(run: () => Promise<V>, expiry = deadline): Promise<V> => new Promise<V>((resolve, reject) => {
        try { guard(expiry); } catch { reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE')); return; }
        const stop = () => reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE')); internal.signal.addEventListener('abort', stop, { once: true });
        let promise: Promise<V>; try { promise = run(); } catch { internal.signal.removeEventListener('abort', stop); reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE')); return; }
        promise.then(value => { try { guard(expiry); resolve(value); } catch { reject(new CanonicalApplicationError('AUTHORITY_UNAVAILABLE')); } }, reject)
          .finally(() => internal.signal.removeEventListener('abort', stop)).catch(() => undefined);
      });
      const completed = await work({ signal: internal.signal, started, deadline, guard, bounded }); guard(completed.expiresAtMs); return completed.value;
    } catch { return unavailable(); }
    finally { if (timer) clearTimeout(timer); if (caller && abort) caller.removeEventListener('abort', abort); controller?.abort(); }
  }
  async function lock(tx: Tx, scope: Scope) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`SELECT id::text AS id FROM sp_draft_job
      WHERE tenant_id=${scope.tenantId}::uuid AND id=${scope.generationJobId}::uuid FOR UPDATE`;
    if (rows.length !== 1 || rows[0]?.id !== scope.generationJobId) unavailable();
  }
  async function databaseNow(tx: Tx): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ nowMs: string }>>`SELECT floor(extract(epoch FROM clock_timestamp())*1000)::text AS "nowMs"`;
    if (rows.length !== 1) unavailable(); return milliseconds(rows[0]?.nowMs);
  }
  function current(value: { checkedAtMs: number; expiresAtMs: number }, started: number, at: number) {
    if (milliseconds(value.checkedAtMs) < started || value.checkedAtMs > at || milliseconds(value.expiresAtMs) <= at) unavailable();
  }
  return Object.freeze({
    async readAcceptance(http: Request, rawSubject: CanonicalGenerationSubject, rawOptions: { signal: AbortSignal }): Promise<CanonicalReaderV2NativeAcceptanceSource> {
      return operation(rawOptions, async op => {
        const s = own(data(rawSubject), ['phase', 'generationJobId', 'requestSha256']);
        if (s.phase !== 'accept') unavailable();
        const subject: CanonicalGenerationSubject = Object.freeze({ phase: 'accept', generationJobId: generationUuid(s.generationJobId), requestSha256: generationSha256(s.requestSha256) });
        if (subject.requestSha256 !== applicationHash({ schemaVersion: 1, generationJobId: subject.generationJobId })) unavailable();
        const grant = grantData(await op.bounded(() => verify(http, subject)), subject), at = op.guard();
        current(grant, op.started, at);
        const authorityExpiry = Math.min(grant.expiresAtMs, grant.delegationExpiresAtMs, grant.claimExpiresAtMs, op.deadline); op.guard(authorityExpiry);
        const scope = { tenantId: grant.tenantId, clerkUserId: grant.clerkUserId, generationJobId: subject.generationJobId };
        const timeoutMs = Math.max(1, Math.floor(authorityExpiry - op.guard(authorityExpiry)));
        const completed = await op.bounded(() => withTenant(scope.tenantId, async tx => {
          op.guard(authorityExpiry); await lock(tx, scope); op.guard(authorityExpiry);
          await assertGeneration(tx, grant, subject); op.guard(authorityExpiry);
          const first = await stored(tx, scope); op.guard(authorityExpiry);
          const a = first.admission;
          if (a.actorUserId !== grant.actorUserId || a.consentId !== grant.consentId || a.controlVersion !== grant.controlVersion) unavailable();
          const again = await stored(tx, scope); op.guard(authorityExpiry);
          if (first.identity !== again.identity) unavailable();
          await assertGeneration(tx, grant, subject); op.guard(authorityExpiry);
          await requireCanonicalGenerationReadWithinTx(tx, a, scope.clerkUserId); op.guard(authorityExpiry);
          const checkedAtMs = await databaseNow(tx), expiresAtMs = Math.min(authorityExpiry, a.effectExpiresAtMs,
            first.publication.request.originalExpiresAtMs, ...(first.acceptance ? [first.acceptance.issuance.expiresAtMs] : []));
          if (checkedAtMs < op.started || checkedAtMs > op.guard(expiresAtMs) || checkedAtMs >= expiresAtMs) unavailable();
          const { identity: _identity, ...source } = first;
          return { value: data({ ...source, grant, checkedAtMs, expiresAtMs }), expiresAtMs };
        }, { timeoutMs }), authorityExpiry);
        // This is AFTER actual Prisma commit, not merely after the callback.
        op.guard(completed.expiresAtMs); return completed;
      });
    },
    async readRetained(rawSelector: CanonicalReaderV2Selector, rawOptions: { signal: AbortSignal }): Promise<CanonicalReaderV2NativeSource> {
      return operation(rawOptions, async op => {
        const s = own(data(rawSelector), ['generationJobId', 'sourceAdmissionSha256']);
        const selector = Object.freeze({ generationJobId: generationUuid(s.generationJobId), sourceAdmissionSha256: generationSha256(s.sourceAdmissionSha256) });
        const access = accessData(await op.bounded(() => authorize(selector, { signal: op.signal })), selector), at = op.guard();
        current(access, op.started, at); const accessExpiry = Math.min(access.expiresAtMs, op.deadline); op.guard(accessExpiry);
        const scope = { tenantId: access.tenantId, clerkUserId: access.clerkUserId, generationJobId: selector.generationJobId };
        const timeoutMs = Math.max(1, Math.floor(accessExpiry - op.guard(accessExpiry)));
        const completed = await op.bounded(() => withTenant(scope.tenantId, async tx => {
          op.guard(accessExpiry); await lock(tx, scope); op.guard(accessExpiry);
          await assertRetained(tx, access, selector); op.guard(accessExpiry);
          const first = await stored(tx, scope); op.guard(accessExpiry);
          const a = first.admission;
          if (!first.acceptance || a.canonical.clientId !== access.clientId || a.canonical.objectiveId !== access.objectiveId ||
              a.actorUserId !== access.actorUserId || canonicalGenerationAdmissionSha256(a) !== selector.sourceAdmissionSha256) unavailable();
          const again = await stored(tx, scope); op.guard(accessExpiry);
          if (first.identity !== again.identity) unavailable();
          await assertRetained(tx, access, selector); op.guard(accessExpiry);
          await requireCanonicalGenerationReadWithinTx(tx, a, scope.clerkUserId); op.guard(accessExpiry);
          const checkedAtMs = await databaseNow(tx), expiresAtMs = accessExpiry;
          if (checkedAtMs < op.started || checkedAtMs > op.guard(expiresAtMs) || checkedAtMs >= expiresAtMs) unavailable();
          const { identity: _identity, ...source } = first;
          // Old effect/issuance expiries remain immutable evidence. Only the
          // independent fresh native READ permission bounds this projection.
          return { value: data({ ...source, checkedAtMs, expiresAtMs }), expiresAtMs };
        }, { timeoutMs }), accessExpiry);
        op.guard(completed.expiresAtMs); return completed;
      });
    },
  });
}
