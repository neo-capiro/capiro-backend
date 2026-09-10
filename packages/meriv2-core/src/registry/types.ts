import type { ZodType, ZodIssue } from 'zod';
import type { MeriCitation, TenantContext, TenantRole } from '@capiro/shared';
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

/**
 * Model-facing projection of the shared Context Plane.
 *
 * Phase 19 introduced this transport for Meri/research. Workspace, Outreach and
 * Strategies reuse the same runtime-only prompt plus body-free packet/coverage
 * projection so their orchestrators never need another context compiler.
 */
export interface MeriGovernedTurnContext {
  version: 1;
  operationId:
    | 'meri.chat'
    | 'meri.research'
    | 'research.generate-report'
    | 'workspace.generate'
    | 'workspace.editor-assist'
    | 'outreach.generate'
    | 'strategies.generate';
  prompt: string;
  /** API-projected evidence; authenticated before it can enter a grounding ledger. */
  evidence?: MeriContextEvidenceEnvelope;
  /** Server-saved document observations; canonical source authorization and hash checked this turn. */
  inheritedDocumentEvidence?: MeriCitation[];
  attestation?: { version: 1; issuedAt: number; signature: string };
  contextPacket: MeriContextPacketSummary;
  retrieval: {
    plan: {
      version: 1;
      queryClass: string;
      subjectScope: 'client' | 'portfolio' | 'external_entity' | 'general';
      targetHint: string | null;
      recipeTool: null;
      requireCompleteCoverage: boolean;
      requiredDomains: string[];
      timeWindow: { expression: string; withinDays: number } | null;
    };
    coverage: {
      version: 1;
      complete: boolean;
      requestedDomains: string[];
      searchedDomains: string[];
      missingDomains: string[];
      partialDomains: string[];
      requestedEntityCount: number | null;
      searchedEntityCount: number | null;
      recordsEvaluated: number;
      recordsReturned: number;
      /** Counts from the same initial retrieval, after model projection. */
      recordsDisplayed?: number;
      recordsOmitted?: number;
      sourceCounts?: Array<{
        source: string;
        recordsReturned: number | null;
        recordsEvaluated: number | null;
        recordsMatched: number | null;
        recordsDisplayed: number | null;
        recordsOmitted: number | null;
      }>;
      paginationComplete: boolean;
      truncated: boolean;
      sourceHealth: Array<{
        source: string;
        status: 'complete' | 'partial' | 'error' | 'unavailable';
        lastSyncAt?: string;
        detail?: string;
      }>;
      unavailableSources: Array<{ source: string; reason: string }>;
      toolsInvoked: string[];
      stopReason: string;
    };
  };
}

export interface MeriContextEvidenceRecord {
  domain: string;
  recordId: string;
  /** Canonical service identifier when a long ID needs a bounded citation alias. */
  sourceRecordId?: string;
  payload: Record<string, unknown>;
  provenance?: Record<string, unknown>;
  projection: {
    truncated: boolean;
    originalCharacters: number;
    returnedCharacters: number;
  };
}

/** Runtime-only data, never a browser-supplied ledger or a memory approval. */
export interface MeriContextEvidenceEnvelope {
  version: 1;
  tenantId: string;
  userId: string;
  packetId: string | null;
  sourceRecordCount: number;
  projectedRecordCount: number;
  truncated: boolean;
  records: MeriContextEvidenceRecord[];
}

/** Body-free, durable provenance for the sources displayed with a saved reply. */
export interface MeriEvidenceManifest {
  version: 1;
  packetId: string | null;
  /** Counts from the initial Context Plane; later tool sources are listed below. */
  sourceRecordCount: number;
  projectedRecordCount: number;
  /** True if any initial or subsequent tool projection disclosed clipping. */
  truncated: boolean;
  sources: Array<{
    id: string;
    tool: string;
    origin: 'initial_context' | 'tool' | 'conversation';
    /** Null when the runtime did not receive a complete-source assertion. */
    truncated: boolean | null;
  }>;
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
  readonly handler: (
    input: I,
    ctx: MeriContext,
    control?: import('./tool-execution-control').ToolExecutionControl,
  ) => Promise<O>;
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
  invoke<O>(
    name: string,
    input: unknown,
    ctx: MeriContext,
    control?: import('./tool-execution-control').ToolExecutionControl,
  ): Promise<O>;
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
