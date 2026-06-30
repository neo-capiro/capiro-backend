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
import { DefaultScopingWrapper, type ScopingWrapper } from '../scoping/scoping-wrapper';

export interface ToolRegistryOptions {
  /** Defaults to `DefaultScopingWrapper`. */
  scoping?: ScopingWrapper;
  /** Required for any write tool (`readOnly: false`); absent → fail closed. */
  approvalGate?: ApprovalGate;
}

/**
 * The single place tools are invoked. `invoke` is the choke point that always
 * (1) validates input against the tool's zod schema, (2) runs the scoping
 * wrapper, and (3) for write tools, runs the approval gate before the handler.
 * Because handlers require a `MeriContext` and the only path to a handler is
 * `invoke`, scope cannot be bypassed.
 */
export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private readonly scoping: ScopingWrapper;
  private readonly approvalGate: ApprovalGate | undefined;

  constructor(options: ToolRegistryOptions = {}) {
    this.scoping = options.scoping ?? new DefaultScopingWrapper();
    this.approvalGate = options.approvalGate;
  }

  register<I, O>(def: ToolDefinition<I, O>): void {
    if (this.tools.has(def.name)) {
      throw new ToolAlreadyRegisteredError(def.name);
    }
    this.tools.set(def.name, def as unknown as AnyToolDefinition);
  }

  get(name: string): AnyToolDefinition | undefined {
    return this.tools.get(name);
  }

  list(): string[] {
    return [...this.tools.keys()].sort();
  }

  async invoke<O>(name: string, input: unknown, ctx: MeriContext): Promise<O> {
    const def = this.tools.get(name);
    if (!def) {
      throw new ToolNotFoundError(name);
    }

    const parsed = def.inputSchema.safeParse(input);
    if (!parsed.success) {
      throw new ToolInputValidationError(name, parsed.error.issues);
    }
    const validInput = parsed.data;

    return this.scoping.enforce(ctx, async () => {
      if (!def.readOnly) {
        if (!this.approvalGate) {
          throw new ApprovalRequiredError(name);
        }
        await this.approvalGate.check(name, validInput, ctx);
      }
      return (await def.handler(validInput, ctx)) as O;
    });
  }
}
