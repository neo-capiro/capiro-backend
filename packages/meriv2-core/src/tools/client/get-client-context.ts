import { z } from 'zod';
import type { MeriContext, ToolDefinition } from '../../registry/types';
import type { ToolExecutionControl } from '../../registry/tool-execution-control';

/**
 * Rich client-context payload. The AUTHORITATIVE shape is owned by the api's
 * canonical get_client_context handler: engagement plus structured profile
 * sections and explicit coverage/paging metadata. The bridge preserves the
 * established top-level engagement fields for existing native consumers.
 */
export interface ClientContextResult {
  client: { id: string; name: string } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Data port for `get_client_context`. The orchestrator binds a concrete
 * implementation delegates to the API's authenticated canonical tool executor,
 * reusing its domain services and tenant/client visibility checks.
 */
export interface ClientContextRepo {
  loadClientContext(
    ctx: MeriContext,
    clientId: string,
    options?: Omit<GetClientContextInput, 'clientId'>,
    control?: ToolExecutionControl,
  ): Promise<ClientContextResult>;
}

export interface GetClientContextInput {
  clientId: string;
  section?: 'capabilities' | 'people' | 'facilities' | 'submissionHistory';
  cursor?: string;
  limit?: number;
}

export const getClientContextInputSchema = z.object({
  clientId: z.string().uuid('clientId must be a client UUID'),
  section: z.enum(['capabilities', 'people', 'facilities', 'submissionHistory']).optional(),
  cursor: z.string().min(1).max(1024).optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

/**
 * `get_client_context` — the tool-migration template (architecture-plan PR3 /
 * P0-T5). The handler REQUIRES a `MeriContext` and forwards it to the repo, so
 * it can never run unscoped; the repo filters on `ctx.tenantId` / `ctx.userId`.
 */
export function createGetClientContextTool(
  repo: ClientContextRepo,
): ToolDefinition<GetClientContextInput, ClientContextResult> {
  return {
    name: 'get_client_context',
    description:
      'Load authorized client context and profile capabilities, people, facilities and submission history. ' +
      'Inspect profileSections for exact counts, availability and nextCursor; request a section with its cursor to read more. ' +
      'A missing or unavailable section is not evidence that the client lacks it.',
    readOnly: true,
    inputSchema: getClientContextInputSchema,
    handler: ({ clientId, ...options }, ctx, control) =>
      repo.loadClientContext(ctx, clientId, options, control),
  };
}
