import type {
  AnyToolDefinition,
  ApprovalGate,
  MeriContext,
  ToolDefinition,
  ToolRegistry,
} from './types';
import {
  ApprovalRequiredError,
  ToolAlreadyRegisteredError,
  ToolInputValidationError,
  ToolNotFoundError,
} from './types';
import { toolExecutionMetadataFor, type ToolExecutionMetadata } from './tool-execution-metadata';
import { DefaultScopingWrapper, type ScopingWrapper } from '../scoping/scoping-wrapper';

export interface ToolRegistryOptions {
  scoping?: ScopingWrapper;
  approvalGate?: ApprovalGate;
}

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly scoping: ScopingWrapper;
  private readonly approvalGate: ApprovalGate | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.scoping = options.scoping ?? new DefaultScopingWrapper();
    this.approvalGate = options.approvalGate;
  }

  register<I, O>(definition: ToolDefinition<I, O>): void {
    if (this.tools.has(definition.name)) throw new ToolAlreadyRegisteredError(definition.name);
    const execution =
      definition.execution ?? toolExecutionMetadataFor(definition.name, definition.readOnly);
    if (execution.name !== definition.name || execution.readOnly !== definition.readOnly) {
      throw new Error(`Tool execution metadata disagrees with definition: ${definition.name}`);
    }
    this.tools.set(definition.name, { ...definition, execution } as unknown as AnyToolDefinition);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): string[] {
    return [...this.tools.keys()].sort();
  }

  executionMetadata(name: string): ToolExecutionMetadata | undefined {
    return this.tools.get(name)?.execution;
  }

  async invoke<O>(name: string, input: unknown, ctx: MeriContext): Promise<O> {
    const definition = this.tools.get(name);
    if (!definition) throw new ToolNotFoundError(name);

    const parsed = definition.inputSchema.safeParse(input);
    if (!parsed.success) throw new ToolInputValidationError(name, parsed.error.issues);
    const validInput = parsed.data;

    return this.scoping.enforce(ctx, async () => {
      if (!definition.readOnly) {
        if (!this.approvalGate) throw new ApprovalRequiredError(name);
        await this.approvalGate.check(name, validInput, ctx);
      }
      return (await definition.handler(validInput, ctx)) as O;
    });
  }
}
