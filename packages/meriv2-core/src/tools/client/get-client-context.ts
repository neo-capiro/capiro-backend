import { z } from 'zod';
import type { MeriContext, ToolDefinition } from '../../registry/types';

/**
 * Rich client-context payload. The AUTHORITATIVE shape is owned by the api's
 * `engagement.clientContext` (recent meetings, threads, contacts, tasks, the
 * client profile, derived stakeholders). The tool passes it through unchanged
 * so MeriV2 returns exactly what current Meri returns for the same caller
 * (SC0.7); hence the open-ended index signature.
 */
export interface ClientContextResult {
  client: { id: string; name: string } & Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Data port for `get_client_context`. The orchestrator binds a concrete
 * implementation; in Phase 0 it delegates to the api's existing authenticated
 * `/api/engagement/context/:clientId` endpoint — one query, no SQL duplicated,
 * no scoping drift (the bridge that makes SC0.7 true by construction).
 */
export interface ClientContextRepo {
  loadClientContext(ctx: MeriContext, clientId: string): Promise<ClientContextResult>;
}

export interface GetClientContextInput {
  clientId: string;
}

export const getClientContextInputSchema = z.object({
  clientId: z.string().uuid('clientId must be a client UUID'),
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
      'Load authorized Capiro client context: recent meetings, threads, contacts, and tasks, ' +
      'plus the client profile (capabilities, key people, facilities, submission history).',
    readOnly: true,
    inputSchema: getClientContextInputSchema,
    handler: (input, ctx) => repo.loadClientContext(ctx, input.clientId),
  };
}
