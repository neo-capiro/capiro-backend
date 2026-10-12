import type { MeriCapability } from '@capiro/shared';

/** The existing canonical core owner supplies the finite callable name type. */
export type MeriLocalToolName = Extract<MeriCapability, { backend: 'meri' }>['name'];

/** Each thunk reads its current owning instance only when selected. */
export type MeriLocalDispatchRegistry = Readonly<Record<MeriLocalToolName, () => unknown>>;

/** Synchronous selection preserves the caller's existing async boundary. */
export function executeMeriLocalDispatch<Registry extends MeriLocalDispatchRegistry>(
  name: MeriLocalToolName,
  registry: Registry,
  unknownTool: (value: never) => never,
): ReturnType<Registry[MeriLocalToolName]> {
  // A switch never coerced malformed names into a property key. Keep that
  // distinction, and never let an inherited object member become a tool.
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(registry, name)) {
    return unknownTool(name as never);
  }
  return registry[name]() as ReturnType<Registry[MeriLocalToolName]>;
}
