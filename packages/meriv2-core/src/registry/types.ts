import type { ZodType, ZodIssue } from 'zod';
import type { TenantContext, TenantRole } from '@capiro/shared';

/**
 * The resolved caller identity every tool handler receives. Mirrors
 * `@capiro/shared` `TenantContext` (the source of truth) plus the optional
 * Clerk org nesting (`o.{id,slg,rol}`). A handler that does not filter on this
 * context is a bug, not a configuration — the type system makes it impossible
 * to invoke a tool without a context (see `ToolRegistry.invoke`).
 */
export interface MeriContext {
  tenantId: string;
  userId: string;
  clerkUserId: string;
  role: TenantRole;
  org?: { id: string; slug: string; role: string };
  /**
   * The tenant's Firm Soul / Firm Compass memory files (rendered human-authored
   * sections only), loaded unconditionally by the orchestrator's context
   * resolver — every tool call carries firm identity, not just client-linked
   * ones. Absent when the tenant hasn't written either file yet.
   */
  firmMemory?: { soul?: string; compass?: string };
  /**
   * The calling user's "My Writing Style" memory file (rendered), so any
   * narrative a tool drafts can mirror the author's voice. Absent when the
   * user hasn't written one.
   */
  userVoice?: string;
  /**
   * The tenant's AUTHORITATIVE client roster (from the `client` table, RLS-
   * scoped), loaded by the orchestrator's context resolver. This — not memory —
   * is the system of record for "who are my clients"; the chat prompt renders it
   * and instructs the model to answer roster questions from it, never from
   * clio_memory (which can hold stale/demo-seeded names). Absent on a load error.
   */
  clientRoster?: Array<{ name: string; status: string }>;
}

/** Adapt a `@capiro/shared` `TenantContext` into a `MeriContext`. */
export function meriContextFromTenant(ctx: TenantContext, org?: MeriContext['org']): MeriContext {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clerkUserId: ctx.clerkUserId,
    role: ctx.role,
    ...(org ? { org } : {}),
  };
}

/**
 * A deterministic tool: retrieves or mutates exactly one bounded thing.
 *
 * `handler` REQUIRES a `MeriContext`, so "a tool that ignores scope" cannot
 * typecheck. Write tools (`readOnly: false`) route through the approval-gate
 * hook before the handler runs (see `ToolRegistry`).
 */
export interface ToolDefinition<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<I>;
  readonly handler: (input: I, ctx: MeriContext) => Promise<O>;
  readonly readOnly: boolean;
}

export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

/**
 * Approval-gate hook invoked before any write tool (`readOnly: false`). The
 * Phase-2 `compliance_precheck` engine implements this. In Phase 0 the registry
 * fails closed: a write tool with no gate configured cannot run.
 */
export interface ApprovalGate {
  check(toolName: string, input: unknown, ctx: MeriContext): Promise<void>;
}

export interface ToolRegistry {
  register<I, O>(def: ToolDefinition<I, O>): void;
  get(name: string): AnyToolDefinition | undefined;
  list(): string[];
  /** Validates input, enforces scoping, runs the write-gate, then the handler. */
  invoke<O>(name: string, input: unknown, ctx: MeriContext): Promise<O>;
}

export class ToolNotFoundError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool not found in registry: ${toolName}`);
    this.name = 'ToolNotFoundError';
  }
}

export class ToolInputValidationError extends Error {
  constructor(
    public readonly toolName: string,
    public readonly issues: ZodIssue[],
  ) {
    super(
      `Invalid input for tool "${toolName}": ` +
        issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
    this.name = 'ToolInputValidationError';
  }
}

export class ApprovalRequiredError extends Error {
  constructor(public readonly toolName: string) {
    super(`Write tool "${toolName}" requires an approval gate, but none is configured`);
    this.name = 'ApprovalRequiredError';
  }
}

export class ToolAlreadyRegisteredError extends Error {
  constructor(public readonly toolName: string) {
    super(`Tool already registered: ${toolName}`);
    this.name = 'ToolAlreadyRegisteredError';
  }
}
