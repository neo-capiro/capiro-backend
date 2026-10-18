/**
 * An inert projection boundary for the proposed get_client_context@0.3.0 read.
 * The caller captures the window around the existing authorized Core reader.
 * The gateway's asOf remains an independent correlation input; it is never
 * presented as the time at which Core finished collecting this profile.
 *
 * No receiver should use this until Meri's exact 0.3.0 output validator is
 * pinned and supplied. This module neither calls the reader nor grants access.
 */
export const RETAINED_CLIENT_CONTEXT_OPERATION_03 = Object.freeze({
  id: 'get_client_context',
  version: '0.3.0',
} as const);

export interface ClientContextReadWindow {
  startedAt: string;
  completedAt: string;
}

export interface ClientContextProjection03Input {
  operation: { id: string; version: string };
  source: unknown;
  readWindow: ClientContextReadWindow;
  gatewayAsOf: string;
  expectedTenantId: string;
  expectedClientId: string;
  /** Must be Meri's pinned, exact get_client_context@0.3.0 output check. */
  assertOutput03: (
    value: unknown,
    context: Readonly<{
      operation: typeof RETAINED_CLIENT_CONTEXT_OPERATION_03;
      gatewayAsOf: string;
      tenantId: string;
      clientId: string;
    }>,
  ) => void;
}

export interface ProjectedClientContext03 extends Record<string, unknown> {
  tool: 'get_client_context';
  generatedAt: string;
  readWindow: Readonly<ClientContextReadWindow>;
}

const SOURCE_FIELDS = [
  'tool', 'generatedAt', 'profileSections', 'coverageNote', 'profile',
  'profileSources', 'context',
] as const;

function invalid(): never {
  throw new Error('CLIENT_CONTEXT_03_INVALID_RESULT');
}

function exactData(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(descriptors, field)) ||
      keys.some((key) => !fields.includes(key))) invalid();
  if (Object.values(descriptors).some((descriptor) => !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable)) invalid();
  return Object.fromEntries(fields.map((field) => [field, descriptors[field]!.value]));
}

function instant(value: unknown): number {
  if (typeof value !== 'string') invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) invalid();
  return milliseconds;
}

/**
 * Projects only the known canonical Core profile wrapper. The output is
 * released only after the externally pinned Meri 0.3.0 validator accepts it.
 */
export function projectRetainedClientContext03(input: ClientContextProjection03Input): ProjectedClientContext03 {
  if (typeof input?.assertOutput03 !== 'function') invalid();
  const operation = exactData(input.operation, ['id', 'version']);
  if (operation.id !== RETAINED_CLIENT_CONTEXT_OPERATION_03.id ||
      operation.version !== RETAINED_CLIENT_CONTEXT_OPERATION_03.version) invalid();
  if (!input.expectedClientId || !input.expectedTenantId) invalid();

  const source = exactData(input.source, SOURCE_FIELDS);
  if (source.tool !== 'get_client_context' || typeof source.coverageNote !== 'string') invalid();
  const context = exactData(source.context, ['client', 'recentActivity', 'keyStakeholders', 'openThreads', 'openTasks', 'summary']);
  if (context.client === null || typeof context.client !== 'object' || Array.isArray(context.client)) invalid();
  const client = context.client as Record<string, unknown>;
  if (client.id !== input.expectedClientId || client.tenantId !== input.expectedTenantId) invalid();

  const window = exactData(input.readWindow, ['startedAt', 'completedAt']);
  // Meri owns the centrally recorded cross-host observation bound. A small
  // clock skew can put its gateway stamp after Core's startedAt numerically;
  // only the pinned Meri validator may decide whether that skew is allowed.
  if (typeof input.gatewayAsOf !== 'string' ||
      !Number.isFinite(Date.parse(input.gatewayAsOf))) invalid();
  const startedAt = instant(window.startedAt);
  const sourceAt = instant(source.generatedAt);
  const completedAt = instant(window.completedAt);
  if (startedAt > sourceAt || sourceAt > completedAt) invalid();

  const projected = Object.freeze({
    ...source,
    generatedAt: window.completedAt as string,
    readWindow: Object.freeze({ startedAt: window.startedAt as string, completedAt: window.completedAt as string }),
  }) as ProjectedClientContext03;
  try {
    input.assertOutput03(projected, Object.freeze({
      operation: RETAINED_CLIENT_CONTEXT_OPERATION_03,
      gatewayAsOf: input.gatewayAsOf,
      tenantId: input.expectedTenantId,
      clientId: input.expectedClientId,
    }));
  } catch {
    invalid();
  }
  return projected;
}
