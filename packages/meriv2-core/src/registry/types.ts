import type { ZodType, ZodIssue } from 'zod';
import type { TenantContext, TenantRole } from '@capiro/shared';
import type { ToolExecutionMetadata } from './tool-execution-metadata';

export type MeriContextScope = 'personal' | 'client' | 'firm';

export interface MeriContextPacketItem {
  id: string;
  label: string;
  type: string;
  scope: MeriContextScope;
  authority: 'human-authored' | 'system-of-record' | 'derived' | 'unknown';
  clientName?: string | null;
  userScoped?: boolean;
  asOf?: string | null;
  lastConfirmedAt?: string | null;
  rationale?: string | null;
  selection: 'explicit' | 'automatic';
}

export interface MeriContextPacketExclusion {
  /**
   * Omitted for access-control exclusions. An unauthorized row must never be
   * identifiable from the packet — it may only ever appear in unauthorizedCount.
   */
  id?: string;
  label?: string;
  type?: string;
  reason:
    | 'expired'
    | 'superseded'
    | 'revoked'
    | 'over-budget'
    | 'unauthorized'
    | 'unavailable'
    | 'empty'
    | string;
}

/**
 * Safe display projection of a compiled context packet. Deliberately carries NO
 * rendered body text: this is the provenance the trust UX shows, not the content
 * the model was given.
 */
export interface MeriContextPacketSummary {
  packetId?: string | null;
  compiledAt?: string | null;
  surface?: string | null;
  clientId?: string | null;
  items: MeriContextPacketItem[];
  exclusions: MeriContextPacketExclusion[];
  unauthorizedCount: number;
  degraded: boolean;
  degradedReason?: string | null;
}

export interface MeriContext {
  tenantId: string;
  userId: string;
  clerkUserId: string;
  role: TenantRole;
  org?: { id: string; slug: string; role: string };
  firmMemory?: { soul?: string; compass?: string };
  userVoice?: string;
  clientRoster?: Array<{ name: string; status: string }>;
  clientSteering?: { soul?: string; compass?: string; people?: string };
  /** Safe provenance summary for trust UX; never includes context body text. */
  contextPacket?: MeriContextPacketSummary;
}

export function meriContextFromTenant(ctx: TenantContext, org?: MeriContext['org']): MeriContext {
  return {
    tenantId: ctx.tenantId,
    userId: ctx.userId,
    clerkUserId: ctx.clerkUserId,
    role: ctx.role,
    ...(org ? { org } : {}),
  };
}

export interface ToolDefinition<I, O> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<I>;
  readonly handler: (input: I, ctx: MeriContext) => Promise<O>;
  readonly readOnly: boolean;
  /** Optional explicit metadata; registry derives the canonical default otherwise. */
  readonly execution?: ToolExecutionMetadata;
}

export type AnyToolDefinition = ToolDefinition<unknown, unknown>;

export interface ApprovalGate {
  check(toolName: string, input: unknown, ctx: MeriContext): Promise<void>;
}

export interface ToolRegistry {
  register<I, O>(def: ToolDefinition<I, O>): void;
  get(name: string): AnyToolDefinition | undefined;
  list(): string[];
  executionMetadata(name: string): ToolExecutionMetadata | undefined;
  /** Validates input, enforces scoping, runs the write gate, then the handler. */
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
        issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; '),
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
