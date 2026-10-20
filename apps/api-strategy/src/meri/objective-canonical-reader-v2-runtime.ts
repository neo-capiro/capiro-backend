import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { types as nodeTypes } from 'node:util';
import type { Request } from 'express';
import { CanonicalApplicationError } from '../planner/objective-canonical-application.js';
import { ObjectiveCanonicalWorkloadAuthority } from '../planner/objective-canonical-authority.js';
import { createPrismaCanonicalReaderV2NativeOwner, type CanonicalReaderV2NativeOwnerOptions } from './objective-canonical-reader-v2-native-owner.js';
import { createCanonicalReaderV2Receiving, type CanonicalReaderV2ReceivingOptions } from './objective-canonical-reader-v2-receiving.js';
import { ObjectiveCanonicalResultOwner } from './objective-canonical-result-owner.js';

export const OBJECTIVE_CANONICAL_READER_V2_RUNTIME = Symbol('OBJECTIVE_CANONICAL_READER_V2_RUNTIME');
export interface CanonicalReaderV2Runtime {
  readonly authority: ObjectiveCanonicalWorkloadAuthority;
  readonly resultOwner: ObjectiveCanonicalResultOwner;
}
export interface CanonicalReaderV2RuntimeBindings {
  readonly prisma: NonNullable<CanonicalReaderV2NativeOwnerOptions['prisma']>;
  /** A distinct, genuinely authenticated base owner. It must not delegate
   * generation verification/currentness back to this acceptance observer. */
  readonly authority: ObjectiveCanonicalWorkloadAuthority;
  readonly retainedAccess: NonNullable<CanonicalReaderV2NativeOwnerOptions['retainedAccess']>;
  readonly createClient: NonNullable<CanonicalReaderV2ReceivingOptions['createClient']>;
  readonly now?: () => number;
}
export interface CanonicalReaderV2RuntimeOptions {
  readonly enabled?: boolean;
  readonly bindings?: CanonicalReaderV2RuntimeBindings;
}

function unavailable(): never { throw new CanonicalApplicationError('AUTHORITY_UNAVAILABLE'); }
function closed(): CanonicalReaderV2Runtime {
  return Object.freeze({ authority: new ObjectiveCanonicalWorkloadAuthority(), resultOwner: new ObjectiveCanonicalResultOwner() });
}
function own(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw) || Array.isArray(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) unavailable();
  const keys = Reflect.ownKeys(raw), allowed = [...required, ...optional];
  if (keys.some(k => typeof k !== 'string' || !allowed.includes(k))) unavailable();
  const captured: Record<string, unknown> = Object.create(null);
  for (const key of allowed) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d) { if (required.includes(key)) unavailable(); continue; }
    if (!d.enumerable || !('value' in d)) unavailable();
    captured[key] = d.value;
  }
  return captured;
}
type Base = Pick<ObjectiveCanonicalWorkloadAuthority, 'verifyGeneration' | 'assertGenerationCurrent' |
  'verifyGenerationAcceptance' | 'verify' | 'assertCurrent'>;
/** Capture trusted native prototype methods without invoking configuration
 * accessors. This supplies no proof or policy; each base operation still owns
 * its genuine caller, current membership, delegation and transaction fences. */
function baseAuthority(raw: unknown): Base {
  if (!raw || typeof raw !== 'object' || nodeTypes.isProxy(raw)) unavailable();
  const captured: Record<string, unknown> = Object.create(null);
  for (const name of ['verifyGeneration', 'assertGenerationCurrent', 'verifyGenerationAcceptance', 'verify', 'assertCurrent']) {
    let cursor: object | null = raw, method: Function | undefined;
    for (let depth = 0; cursor && depth < 32; depth++) {
      if (nodeTypes.isProxy(cursor)) unavailable();
      const d = Object.getOwnPropertyDescriptor(cursor, name);
      if (d) {
        if (!('value' in d) || typeof d.value !== 'function' || nodeTypes.isProxy(d.value)) unavailable();
        method = d.value; break;
      }
      cursor = Object.getPrototypeOf(cursor);
    }
    if (!method) unavailable();
    const fn = method;
    captured[name] = (...args: unknown[]) => Reflect.apply(fn, raw, args);
  }
  return Object.freeze(captured) as unknown as Base;
}
type Observer = ReturnType<typeof createCanonicalReaderV2Receiving>['observeAcceptance'];

/** Native HTTP cancellation belongs to this internal workload read, not the
 * earlier browser consent request. Its closure never cancels an already-owned
 * Planner continuation or creates a second orchestration loop. */
async function observeHttp(observer: Observer, http: Request,
  subject: Parameters<ObjectiveCanonicalWorkloadAuthority['verifyGenerationAcceptance']>[1]) {
  if (nodeTypes.isProxy(http) || !(http instanceof IncomingMessage) || http.aborted) unavailable();
  const socket = http.socket;
  if (nodeTypes.isProxy(socket) || !(socket instanceof Socket) || socket.destroyed) unavailable();
  const controller = new AbortController(), abort = () => controller.abort();
  const close = () => { if (http.aborted || !http.complete) abort(); };
  http.once('aborted', abort); http.once('close', close); socket.once('close', abort);
  try {
    if (http.aborted || socket.destroyed) unavailable();
    const result = await observer(http, subject, { signal: controller.signal });
    if (http.aborted || socket.destroyed || controller.signal.aborted) unavailable();
    return result;
  } finally {
    http.removeListener('aborted', abort); http.removeListener('close', close);
    socket.removeListener('close', abort); controller.abort();
  }
}

/** Only the acceptance method is observed through Meri v2. All base native
 * verification/currentness methods retain their original owner and behavior. */
class ObservedCanonicalAuthority extends ObjectiveCanonicalWorkloadAuthority {
  constructor(private readonly base: Base, private readonly observer: Observer) { super(); }
  override verifyGeneration(...args: Parameters<Base['verifyGeneration']>) { return this.base.verifyGeneration(...args); }
  override assertGenerationCurrent(...args: Parameters<Base['assertGenerationCurrent']>) { return this.base.assertGenerationCurrent(...args); }
  override verify(...args: Parameters<Base['verify']>) { return this.base.verify(...args); }
  override assertCurrent(...args: Parameters<Base['assertCurrent']>) { return this.base.assertCurrent(...args); }
  override verifyGenerationAcceptance(...args: Parameters<Base['verifyGenerationAcceptance']>) {
    return observeHttp(this.observer, args[0], args[1]);
  }
}

/** Production calls this with no arguments. No environment, key, database,
 * credential discovery, timers or network access occurs at the closed mount.
 * Explicit server composition still requires genuine Core authority, retained
 * access and v2 credential owners; it cannot make Fable's held custody ready. */
export function createCanonicalReaderV2Runtime(options: CanonicalReaderV2RuntimeOptions = {}): CanonicalReaderV2Runtime {
  try {
    if (!options || typeof options !== 'object' || nodeTypes.isProxy(options)) return closed();
    const flag = Object.getOwnPropertyDescriptor(options, 'enabled');
    if (!flag || !('value' in flag) || flag.value !== true) return closed();
    const c = own(options, ['enabled', 'bindings']), b = own(c.bindings,
      ['prisma', 'authority', 'retainedAccess', 'createClient'], ['now']);
    if (typeof b.createClient !== 'function' || nodeTypes.isProxy(b.createClient) ||
        b.now !== undefined && (typeof b.now !== 'function' || nodeTypes.isProxy(b.now))) return closed();
    const base = baseAuthority(b.authority), now = b.now as (() => number) | undefined;
    const nativeOwner = createPrismaCanonicalReaderV2NativeOwner({ enabled: true,
      prisma: b.prisma as CanonicalReaderV2RuntimeBindings['prisma'], authority: base,
      retainedAccess: b.retainedAccess as CanonicalReaderV2RuntimeBindings['retainedAccess'], ...(now ? { now } : {}) });
    const factory = b.createClient as CanonicalReaderV2RuntimeBindings['createClient'];
    const receiving = createCanonicalReaderV2Receiving({ enabled: true, nativeOwner,
      createClient: parsers => Reflect.apply(factory, c.bindings, [parsers]), ...(now ? { now } : {}) });
    return Object.freeze({ authority: new ObservedCanonicalAuthority(base, receiving.observeAcceptance),
      resultOwner: new ObjectiveCanonicalResultOwner(receiving.retainedBridge) });
  } catch { return closed(); }
}
