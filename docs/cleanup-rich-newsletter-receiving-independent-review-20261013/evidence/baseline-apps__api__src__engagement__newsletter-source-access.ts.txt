import { NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import {
  newsletterSourceClients,
  type NewsletterCampaignConfig,
  type NewsletterDesign,
} from '@capiro/shared/newsletter';
import type { PrismaService } from '../prisma/prisma.service.js';

/** Both interactive sends and the delivery worker must recheck source access.
 * A previously prepared copy is not authority to bypass a later client wall. */
export async function assertNewsletterSourceAccess(
  prisma: PrismaService,
  ctx: TenantContext,
  stageId: string,
) {
  const rows = await prisma.withTenant(
    ctx.tenantId,
    (tx) => tx.$queryRaw<Array<{ design: NewsletterDesign; config: NewsletterCampaignConfig }>>`
    SELECT s.design, s.config FROM ws_newsletter_stage s
    JOIN users u ON u.clerk_user_id = s.owner_id
    JOIN tenant_memberships m ON m.user_id = u.id AND m.tenant_id = s.tenant_id AND m.status = 'active'
    WHERE s.id = ${stageId}::uuid AND s.tenant_id = ${ctx.tenantId}::uuid AND u.id = ${ctx.userId}::uuid
  `,
  );
  const stage = rows[0];
  if (!stage) throw new NotFoundException('Staged newsletter not available');
  for (const clientId of newsletterSourceClients(stage.design, stage.config.clientId)) {
    const clients = await prisma.withTenant(
      ctx.tenantId,
      (tx) => tx.$queryRaw<Array<{ allowed: boolean }>>`
      SELECT (NOT c.memory_wall OR EXISTS (
        SELECT 1 FROM client_memory_access a WHERE a.client_id = c.id AND a.user_id = ${ctx.userId}::uuid
      )) AS allowed FROM clients c WHERE c.id = ${clientId}::uuid AND c.tenant_id = ${ctx.tenantId}::uuid
    `,
    );
    if (!clients[0]?.allowed) throw new NotFoundException('Newsletter source not available');
  }
}
