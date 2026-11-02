import type { Prisma } from '@prisma/client';
import { retiredFields } from './retention-subject.js';

/** The client owner holds its client row FOR UPDATE through grant/status changes
 * and this cleanup. Every Office writer first locks that row FOR SHARE and then
 * rechecks access. Actor IDs come from the client's canonical conversations;
 * ordinary actor RLS stays enabled while each affected actor's bytes are retired.
 * The caller must roll back its transaction if any step fails. */
export async function retireClientOfficeDraftsInTx(tx: Prisma.TransactionClient,
  tenantId: string, clientId: string, allowedActors: readonly string[] = []) {
  const actors = await tx.$queryRaw<Array<{ actor: string }>>`SELECT DISTINCT user_id::text AS actor
    FROM clio_conversations WHERE tenant_id=${tenantId}::uuid AND client_id=${clientId}::uuid
      AND NOT (user_id=ANY(${[...allowedActors]}::uuid[])) ORDER BY actor`;
  if (!actors.length) return;
  const [context] = await tx.$queryRaw<Array<{ actor: string }>>`
    SELECT COALESCE(current_setting('app.current_user',true),'') AS actor`;
  let failed = false;
  try {
    for (const { actor } of actors) {
      await tx.$executeRaw`SELECT set_config('app.current_user',${actor},true)`;
      await tx.$executeRaw`UPDATE meri_office_drafts d SET ${retiredFields}
        WHERE d.tenant_id=${tenantId}::uuid AND d.actor_user_id=${actor}::uuid AND d.state<>'discarded'
          AND EXISTS(SELECT 1 FROM clio_conversations c WHERE c.id=d.conversation_id
            AND c.tenant_id=d.tenant_id AND c.user_id=d.actor_user_id AND c.client_id=${clientId}::uuid)`;
    }
  } catch (error) { failed = true; throw error; }
  finally {
    // A SQL error may already have aborted the transaction. Preserve that error;
    // rollback also clears the local setting. Successful callers regain context.
    try { await tx.$executeRaw`SELECT set_config('app.current_user',${context!.actor},true)`; }
    catch (error) { if (!failed) throw error; }
  }
}
