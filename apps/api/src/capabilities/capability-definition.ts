import type { AuthorizedCapabilityContext, CapabilitySurface } from './capability-context.js';
import type { CapabilityResult } from './capability-result.js';

export interface CapabilityRuntimeSchema<T> {
  readonly name: string;
  parse(value: unknown): T;
}

export interface CapabilityDefinition<I, O> {
  name: string;
  description: string;
  version: 1;
  readOnly: true;
  riskClass: 'read';
  surfaces: readonly CapabilitySurface[];
  supportsClientScope: boolean;
  requiresClientScope: boolean;
  timeoutMs: number;
  maxResultCount: number;
  maxResultBytes: number;
  provenanceRequired: boolean;
  inputSchema: CapabilityRuntimeSchema<I>;
  outputSchema: CapabilityRuntimeSchema<CapabilityResult<O>>;
  execute(ctx: AuthorizedCapabilityContext, input: I): Promise<CapabilityResult<O>>;
}

export type AnyCapabilityDefinition = CapabilityDefinition<unknown, unknown>;
