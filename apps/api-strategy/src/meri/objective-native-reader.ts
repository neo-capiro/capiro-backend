import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { canonicalGenerationAdmissionSha256, parseAcceptedRunBinding,
  parseCanonicalGenerationAdmission } from './objective-canonical-generation.js';
import { privateRequestJcsSha256 as hash } from './objective-canonical-request.js';

const MAX_BYTES = 8 * 1024 * 1024;
const refused = (): never => { throw new CanonicalApplicationError('OUTCOME_UNCONFIRMED'); };
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
export function nativeObject(value: any, keys: string[]): any {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) return refused();
  return value;
}

/** Native persisted facts, not a capability or a claim that compute has begun. */
export function readNativeObjectiveAcceptance(raw: unknown, expected: { admission: unknown; publication: any }) {
  // Validate the complete JSON domain before reading supplied properties.
  hash(raw);
  const json = JSON.stringify(raw);
  if (Buffer.byteLength(json ?? '', 'utf8') > MAX_BYTES) return refused();
  const v = nativeObject(raw, ['schemaVersion', 'record', 'request', 'run']);
  const r = nativeObject(v.record, ['schemaVersion','generationJobId','binding','sourceAdmissionSha256',
    'sourceRequestSha256','typedRequestSha256','selectionSha256','effectExpiresAtMs','selection']);
  const a = parseCanonicalGenerationAdmission(expected.admission), p = expected.publication;
  const b = parseAcceptedRunBinding(r.binding), selection = nativeObject(r.selection,
    ['sourceAdmission','request','executionContext','queuedType']);
  const accepted = { requestId: a.generationRequestId, prompt: p.executionContext.prompt,
    skill: null, window: null, windowRequest: null };
  if (v.schemaVersion !== 1 || r.schemaVersion !== 1 || r.generationJobId !== a.generationJobId ||
      b.tenantId !== a.canonical.tenantId || b.actorId !== a.actorUserId ||
      r.sourceAdmissionSha256 !== canonicalGenerationAdmissionSha256(a) ||
      !same(selection.sourceAdmission, a) || !same(selection.request, p.request) ||
      !same(selection.executionContext, p.executionContext) || selection.queuedType !== p.request.input.typeHint ||
      r.selectionSha256 !== hash(selection) || r.typedRequestSha256 !== p.requestSha256 ||
      r.sourceRequestSha256 !== hash(accepted) || !same(v.request, accepted) ||
      !Number.isSafeInteger(r.effectExpiresAtMs) || r.effectExpiresAtMs <= a.admittedAtMs ||
      r.effectExpiresAtMs !== Math.min(a.effectExpiresAtMs, p.request.originalExpiresAtMs) ||
      !v.run || !same(v.run.binding, b) || !['queued','starting','running','completed'].includes(v.run.state) ||
      typeof v.run.policyRevision !== 'string' || !v.run.policyRevision || !Array.isArray(v.run.scopes) ||
      !v.run.scopes.length || v.run.scopes.some((s: any) => s.tenantId !== b.tenantId ||
        s.policyRevision !== v.run.policyRevision || s.kind !== 'client' || s.resourceId !== a.canonical.clientId)) return refused();
  return { record: r, request: accepted, run: v.run, sourceBinding: b,
    sourceAdmission: a, sourceAdmissionSha256: r.sourceAdmissionSha256,
    sourceRequestSha256: r.sourceRequestSha256, effectExpiresAtMs: r.effectExpiresAtMs,
    typedRequestSha256: r.typedRequestSha256, executionContextSha256: hash(selection.executionContext),
    acceptedRequestId: accepted.requestId,
    acceptedPromptSha256: createHash('sha256').update(accepted.prompt).digest('hex') };
}

/** One bounded private HTTP read. A failed/ambiguous read is never retried as a mutation. */
@Injectable()
export class ObjectiveNativeReader {
  private readonly origin: string;
  private readonly secret: string;
  constructor(config: ConfigService) {
    this.origin = config.get<string>('MERI_CONTROL_ORIGIN') ?? '';
    this.secret = config.get<string>('INTERNAL_SERVICE_SECRET') ?? '';
  }
  available() { return Boolean(this.origin && this.secret); }
  acceptance(generationJobId: string, sourceAdmissionSha256: string, signal?: AbortSignal) {
    return this.post('acceptance', { schemaVersion: 1, generationJobId, sourceAdmissionSha256 }, signal);
  }
  read(source: { generationJobId: string; binding: unknown; sourceAdmissionSha256: string }, options: { signal: AbortSignal }) {
    return this.post('completion', { schemaVersion: 1, ...source }, options.signal);
  }
  private async post(kind: 'acceptance' | 'completion', body: unknown, signal?: AbortSignal): Promise<unknown> {
    if (!this.available() || signal?.aborted) return refused();
    let origin: URL;
    try { origin = new URL(this.origin); } catch { return refused(); }
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' ||
        origin.search || origin.hash) return refused();
    const abort = AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]);
    let response: Response | undefined;
    try {
      response = await fetch(new URL(`/v1/internal/objective-generation/${kind}/read`, origin), {
        method: 'POST', redirect: 'error', signal: abort,
        headers: { 'content-type': 'application/json', 'x-internal-service-secret': this.secret }, body: JSON.stringify(body),
      });
      if (!response.ok || !response.headers.get('content-type')?.toLowerCase().startsWith('application/json') ||
          Number(response.headers.get('content-length') ?? 0) > MAX_BYTES || !response.body) return refused();
      const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          bytes += next.value.byteLength;
          if (bytes > MAX_BYTES || abort.aborted) return refused();
          chunks.push(next.value);
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      if (abort.aborted) return refused();
      const buffer = Buffer.concat(chunks), text = buffer.toString('utf8');
      if (!Buffer.from(text).equals(buffer)) return refused();
      return JSON.parse(text);
    } catch { return refused(); }
    finally { if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined); }
  }
}
