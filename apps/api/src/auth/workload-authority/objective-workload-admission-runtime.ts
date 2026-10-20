import { KeyObject } from 'node:crypto';
import { types as nodeTypes } from 'node:util';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { createObjectiveAdmissionIngress, type ObjectiveAdmissionHttpRequest } from './objective-workload-admission-ingress.js';
import { createPrismaObjectiveAdmissionSource } from './objective-workload-admission-source.js';
import { createPrismaObjectiveIssuancePort } from './objective-workload-issuance-prisma.js';
import { ObjectiveWorkloadIssuanceError, type ObjectiveIssuanceSignerPins } from './objective-workload-issuance.js';
import { OBJECTIVE_GENERATION_WORKER_SUBJECT } from './objective-workload-jwt.js';
import type { ObjectiveWorkloadCallerKeyPin } from './objective-workload-proof.js';

export interface ObjectiveAdmissionRuntimeBindings {
  /** Explicit server-owned objects. Request data and environment discovery are
   * deliberately absent; this factory never creates a delegation or key. */
  readonly prisma: PrismaService;
  readonly signerPins: ObjectiveIssuanceSignerPins;
  readonly callerKeys: Readonly<Record<string, ObjectiveWorkloadCallerKeyPin>>;
  readonly policyRevision: string;
  readonly nowSeconds?: () => number;
}
export interface ObjectiveAdmissionRuntimeOptions {
  readonly enabled?: boolean;
  readonly bindings?: ObjectiveAdmissionRuntimeBindings;
}
export type ObjectiveAdmissionRuntimeResult = Awaited<ReturnType<ReturnType<typeof createObjectiveAdmissionIngress>>>;
export type ObjectiveAdmissionRuntime = (request: ObjectiveAdmissionHttpRequest) => Promise<ObjectiveAdmissionRuntimeResult>;

const unavailable = (): never => { throw new ObjectiveWorkloadIssuanceError('UNAVAILABLE'); };
const closed: ObjectiveAdmissionRuntime = async () => unavailable();
const NAME = /^[a-z][a-z0-9:._-]{0,127}$/;
const KID = /^[A-Za-z0-9._-]{1,64}$/;

function own(raw: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return unavailable();
  const keys = Reflect.ownKeys(raw), captured: Record<string, unknown> = Object.create(null);
  if (required.some(key => !keys.includes(key)) || keys.some(key => typeof key !== 'string' ||
      !required.includes(key) && !optional.includes(key))) return unavailable();
  for (const key of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) return unavailable();
    captured[key] = d.value;
  }
  return captured;
}

function callerPins(raw: unknown): Readonly<Record<string, ObjectiveWorkloadCallerKeyPin>> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || nodeTypes.isProxy(raw) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(raw))) return unavailable();
  const keys = Reflect.ownKeys(raw), pins: Record<string, ObjectiveWorkloadCallerKeyPin> = Object.create(null);
  if (!keys.length) return unavailable();
  for (const key of keys) {
    if (typeof key !== 'string' || KID.exec(key)?.[0] !== key) return unavailable();
    const d = Object.getOwnPropertyDescriptor(raw, key);
    if (!d || !d.enumerable || !('value' in d)) return unavailable();
    const pin = own(d.value, ['issuer', 'subject', 'publicKey']);
    if (typeof pin.issuer !== 'string' || NAME.exec(pin.issuer)?.[0] !== pin.issuer ||
        pin.subject !== OBJECTIVE_GENERATION_WORKER_SUBJECT || !(pin.publicKey instanceof KeyObject) ||
        pin.publicKey.type !== 'public' || pin.publicKey.asymmetricKeyType !== 'rsa' ||
        (pin.publicKey.asymmetricKeyDetails?.modulusLength ?? 0) < 3072) return unavailable();
    pins[key] = Object.freeze(pin) as unknown as ObjectiveWorkloadCallerKeyPin;
  }
  return Object.freeze(pins);
}

/** The production mount calls this with no arguments and remains hard closed.
 * An explicitly allocated server composition may supply bindings later. The
 * existing native issuer still independently rechecks current authority and
 * the DB CHECK(enabled=false) fence is unchanged. This composes admit only;
 * no Meri acceptance, retained reader or later-phase issuer is manufactured. */
export function createObjectiveAdmissionRuntime(options: ObjectiveAdmissionRuntimeOptions = {}): ObjectiveAdmissionRuntime {
  try {
    // Read only the data-valued enable bit before touching any bindings. A
    // disabled mount cannot consult clocks, Prisma, key pins or request bytes.
    if (!options || typeof options !== 'object' || nodeTypes.isProxy(options) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options))) return closed;
    const enabled = Object.getOwnPropertyDescriptor(options, 'enabled');
    if (!enabled || !('value' in enabled) || enabled.value !== true) return closed;
    const configured = own(options, ['enabled', 'bindings']);
    const b = own(configured.bindings, ['prisma', 'signerPins', 'callerKeys', 'policyRevision'], ['nowSeconds']);
    if (typeof b.policyRevision !== 'string' || /^[0-9a-f]{64}$/.exec(b.policyRevision)?.[0] !== b.policyRevision ||
        b.nowSeconds !== undefined && typeof b.nowSeconds !== 'function') return closed;
    const prisma = b.prisma as PrismaService, signerPins = b.signerPins as ObjectiveIssuanceSignerPins;
    if (!prisma || typeof prisma.withSystem !== 'function' || typeof prisma.withTenant !== 'function' ||
        !signerPins || typeof signerPins.active !== 'function' || typeof signerPins.byKid !== 'function') return closed;
    const keys = callerPins(b.callerKeys);
    const source = createPrismaObjectiveAdmissionSource(prisma, { enabled: true });
    const port = createPrismaObjectiveIssuancePort(prisma, { enabled: true, policyRevision: b.policyRevision });
    return createObjectiveAdmissionIngress(source, port, signerPins, { enabled: true, callerKeys: keys,
      ...(b.nowSeconds === undefined ? {} : { nowSeconds: b.nowSeconds as () => number }) });
  } catch { return closed; }
}
