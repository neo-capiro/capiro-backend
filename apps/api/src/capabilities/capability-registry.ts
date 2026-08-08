import { Injectable } from '@nestjs/common';
import { assertAuthorizedCapabilityContext, type AuthorizedCapabilityContext, type CapabilitySurface } from './capability-context.js';
import type { AnyCapabilityDefinition, CapabilityDefinition } from './capability-definition.js';
import { CapabilityError, normalizeCapabilityError } from './capability-errors.js';
import type { CapabilityResult } from './capability-result.js';

@Injectable()
export class CapabilityRegistry {
  private readonly definitions = new Map<string, AnyCapabilityDefinition>();

  register<I, O>(definition: CapabilityDefinition<I, O>): void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`duplicate capability: ${definition.name}`);
    }
    if (definition.readOnly !== true || definition.riskClass !== 'read') {
      throw new Error(`write/action capability is prohibited in the shared read registry: ${definition.name}`);
    }
    if (definition.timeoutMs <= 0 || definition.maxResultCount <= 0 || definition.maxResultBytes <= 0) {
      throw new Error(`invalid capability bounds: ${definition.name}`);
    }
    this.definitions.set(definition.name, definition as AnyCapabilityDefinition);
  }

  get(name: string): AnyCapabilityDefinition | undefined {
    return this.definitions.get(name);
  }

  listForSurface(surface: CapabilitySurface): AnyCapabilityDefinition[] {
    return [...this.definitions.values()]
      .filter((definition) => definition.surfaces.includes(surface))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async execute<T = unknown>(
    name: string,
    ctx: AuthorizedCapabilityContext,
    input: unknown,
  ): Promise<CapabilityResult<T>> {
    try {
      assertAuthorizedCapabilityContext(ctx);
      const definition = this.definitions.get(name);
      if (!definition || !definition.surfaces.includes(ctx.surface)) {
        throw new CapabilityError('CAPABILITY_UNAUTHORIZED', 'This capability is not available on the current surface.');
      }
      if (definition.requiresClientScope && !ctx.clientScope) {
        throw new CapabilityError('CAPABILITY_INVALID_SCOPE', 'An authorized client scope is required.');
      }
      const parsed = definition.inputSchema.parse(input);
      const result = await withTimeout(
        definition.execute(ctx, parsed),
        definition.timeoutMs,
        definition.name,
      );
      const validated = definition.outputSchema.parse(result);
      if (validated.scope.tenantId !== ctx.tenantId) {
        throw new CapabilityError('CAPABILITY_INVALID_SCOPE', 'Capability scope did not match the authenticated tenant.');
      }
      const encoded = JSON.stringify(validated);
      if (Buffer.byteLength(encoded, 'utf8') > definition.maxResultBytes) {
        throw new CapabilityError('CAPABILITY_BUDGET_EXCEEDED', 'The capability result exceeded its safe response budget.');
      }
      return validated as CapabilityResult<T>;
    } catch (error) {
      throw normalizeCapabilityError(error);
    }
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, name: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CapabilityError('CAPABILITY_TIMEOUT', `${name} timed out safely.`, true)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
