import { z } from 'zod';
import type { MeriContext, ToolDefinition } from '../../registry/types';

/**
 * Delegated tools (Workstream C, strangler-fig step).
 *
 * Instead of re-implementing each of Meri's ~50 tools natively in meriv2-core,
 * a delegated tool forwards execution to apps/api's existing authenticated tool
 * executor (`POST /api/clio/tools/:name`, backed by MeriToolsService), reusing
 * the ONE tenant-scoped implementation + BYOK path — no SQL duplicated, no
 * behavior drift. It is the same bridge `get_client_context` already uses,
 * generalized to any tool.
 *
 * The registry still owns the guarantees that matter at this layer: it validates
 * the caller's MeriContext (scoping) and, for write tools (`readOnly:false`),
 * runs the approval/compliance gate BEFORE the delegated call. Field-level input
 * validation stays with apps/api (the authority), so the delegated tool accepts
 * a permissive object and passes it through — the orchestrator is not a second,
 * drift-prone copy of every tool's schema.
 */

/** Executes a named apps/api tool for the caller (the orchestrator binds a concrete impl). */
export interface ToolExecutor {
  execute(ctx: MeriContext, toolName: string, input: Record<string, unknown>): Promise<unknown>;
}

export interface DelegatedToolSpec {
  readonly name: string;
  readonly description: string;
  /**
   * false for side-effecting tools — the registry then requires the approval
   * gate to pass before the delegated call runs. MUST match apps/api's
   * SIDE_EFFECTING_TOOLS classification (a delegated write registered as
   * readOnly would bypass the gate — the one thing the migration must not do).
   */
  readonly readOnly: boolean;
}

/**
 * The permissive input schema for a delegated tool: any JSON object. apps/api
 * re-validates each field on execution, so this is the authority boundary, not a
 * gap — the orchestrator deliberately does not maintain a parallel copy of every
 * tool's field schema.
 */
const passthroughInputSchema = z.record(z.string(), z.unknown());

export function createDelegatedTool(
  spec: DelegatedToolSpec,
  executor: ToolExecutor,
): ToolDefinition<Record<string, unknown>, unknown> {
  return {
    name: spec.name,
    description: spec.description,
    readOnly: spec.readOnly,
    inputSchema: passthroughInputSchema,
    handler: (input: Record<string, unknown>, ctx: MeriContext) =>
      executor.execute(ctx, spec.name, input),
  };
}

/**
 * Register a batch of delegated tools on a registry. Returns the registered
 * names so callers can assert coverage against a source-of-truth catalog.
 */
export function registerDelegatedTools(
  register: (def: ToolDefinition<Record<string, unknown>, unknown>) => void,
  specs: readonly DelegatedToolSpec[],
  executor: ToolExecutor,
): string[] {
  for (const spec of specs) {
    register(createDelegatedTool(spec, executor));
  }
  return specs.map((s) => s.name);
}
