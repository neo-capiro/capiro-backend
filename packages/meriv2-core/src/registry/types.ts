import type { ZodType, ZodIssue } from 'zod';
import type { TenantContext, TenantRole } from '@capiro/shared';
import type { MemoryAuthority } from '../memory/governance';
import type { ToolExecutionMetadata } from './tool-execution-metadata';

export type MeriContextScope = 'personal' | 'client' | 'firm';

export type MeriContextAuthority =
  | 'human-authored'
  | 'system-of-record'
  | 'derived'
  | 'unknown'
  | MemoryAuthority;

export interface MeriContextPacketItem {
  id: string;
  label: string;
  type: string;
  scope: MeriContextScope;
  authority: MeriContextAuthority;
  clientName?: string | null;
  userScoped?: boolean;
  asOf?: string | null;
  lastConfirmedAt?: string | null;
  rationale?: string | null;
  selection: 'explicit' | 'automatic';
}

export interface MeriContextPacketExclusion {
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

/** Safe display projection of a compiled context packet; never carries body text. */
export interface MeriContextPacketSummary {
  /** Durable ID only. Null when persistence failed or no row exists. */
  packetId?: string | null;
  persisted?: boolean;
  /** Bounded code only; never a database/provider message. */
  persistenceErrorCode?: string | null;
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
      `Invalid input for "${toolName}": ` +
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
