import type { Prisma } from '@prisma/client';
import { retiredFields } from './retention-subject.js';

/** Called after the membership owner updates/remaps its row in this transaction.
 * Office writers hold that same row FOR SHARE, then recheck membership. No late
 * write can cross the committed removal. Preserve ordinary tenant/actor RLS and
 * restore the caller's actor context before its audit/outbox work. */
export async function retireMemberOfficeDraftsInTx(tx: Prisma.TransactionClient,
  tenantId: string, actorId: string) {
  const [context] = await tx.$queryRaw<Array<{ actor: string }>>`
    SELECT COALESCE(current_setting('app.current_user',true),'') AS actor`;
  let failed = false;
  try {
    await tx.$executeRaw`SELECT set_config('app.current_user',${actorId},true)`;
    await tx.$executeRaw`UPDATE meri_office_drafts d SET ${retiredFields}
      WHERE d.tenant_id=${tenantId}::uuid AND d.actor_user_id=${actorId}::uuid AND d.state<>'discarded'
        AND NOT EXISTS(SELECT 1 FROM tenant_memberships m WHERE m.tenant_id=d.tenant_id
          AND m.user_id=d.actor_user_id AND m.status='active')`;
  } catch (error) { failed = true; throw error; }
  finally {
    // SQL failure may already have aborted the transaction. Preserve the cause;
    // rollback clears transaction-local settings when restoration cannot run.
    try { await tx.$executeRaw`SELECT set_config('app.current_user',${context!.actor},true)`; }
    catch (error) { if (!failed) throw error; }
  }
}
