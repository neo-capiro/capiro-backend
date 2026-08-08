import { Injectable } from '@nestjs/common';
import type { AuthorizedCapabilityContext, CapabilitySurface } from '../capability-context.js';
import { CapabilityRegistry } from '../capability-registry.js';
import type { CapabilityResult } from '../capability-result.js';

export interface ProviderNeutralToolDefinition {
  name: string;
  description: string;
  inputSchema: string;
  readOnly: true;
}

export interface CapabilityToolAdapter {
  toolDefinitions(surface: CapabilitySurface): ProviderNeutralToolDefinition[];
  execute(
    call: { name: string; input: unknown },
    ctx: AuthorizedCapabilityContext,
  ): Promise<CapabilityResult<unknown>>;
}

/**
 * Thin adapter contract shared by future OpenAI-function and MCP adapters.
 * It contains no provider SDK and owns no capability implementation.
 */
@Injectable()
export class SharedCapabilityToolAdapter implements CapabilityToolAdapter {
  constructor(private readonly registry: CapabilityRegistry) {}

  toolDefinitions(surface: CapabilitySurface): ProviderNeutralToolDefinition[] {
    return this.registry.listForSurface(surface).map((definition) => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema.name,
      readOnly: true,
    }));
  }

  execute(
    call: { name: string; input: unknown },
    ctx: AuthorizedCapabilityContext,
  ): Promise<CapabilityResult<unknown>> {
    return this.registry.execute(call.name, ctx, call.input);
  }
}
