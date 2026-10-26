import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import type { IntegrationConnectionToken } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service.js';
import {
  assertActiveMailboxActor,
  lockMailboxConnection,
  tokenFingerprint,
} from '../mailbox-oauth-authority.js';
import { MailboxReconnectRequiredError } from '../mail-sync-failure.js';
import { withMailboxProviderBudget } from '../mailbox-provider-transport.js';
import { mailboxState } from '../mailbox-sync-claim.js';
import {
  parseTeamsInput,
  projectTeamsPage,
  teamsPageUrl,
  TEAMS_PERMISSIONS,
  TeamsReadUnavailable,
  type TeamsReadInput,
  type TeamsReadOperation,
  type TeamsReadResult,
} from './microsoft-teams-contract.js';

type Transport = {
  token(
    connectionId: string,
    snapshot: IntegrationConnectionToken,
    grantedScope: string,
  ): Promise<{ accessToken: string; snapshot: IntegrationConnectionToken }>;
  get(url: string, accessToken: string): Promise<unknown>;
};

/** The existing actor-owned connection and active membership are rechecked on every page and release. */
async function admit(
  prisma: PrismaService,
  ctx: TenantContext,
  input: TeamsReadInput,
  operation: TeamsReadOperation,
  expected?: IntegrationConnectionToken,
) {
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await assertActiveMailboxActor(tx, ctx.tenantId, ctx.userId);
    const connection = await lockMailboxConnection(tx, ctx.tenantId, input.connectionId);
    if (connection.createdByUserId !== ctx.userId || connection.provider !== 'microsoft_365')
      throw new NotFoundException('Microsoft connection not found');
    if (input.clientId) throw new TeamsReadUnavailable('client_scope_unavailable');
    if (!['connected', 'error'].includes(connection.status))
      throw new TeamsReadUnavailable('disconnected');
    const token = connection.token;
    if (!token?.homeAccountId) throw new TeamsReadUnavailable('reconnect_required');
    if (token.tenantId !== ctx.tenantId || token.connectionId !== connection.id)
      throw new NotFoundException('Microsoft connection not found');
    if (
      Number(mailboxState(mailboxState(connection.syncState).oauthAttempt).expiresAt) >
        Date.now() / 1000 ||
      (expected && tokenFingerprint(expected) !== tokenFingerprint(token))
    )
      throw new TeamsReadUnavailable('source_changed');
    // Actual returned token grants, never the OAuth requested-scope catalog.
    const grants = new Set(
      token.scopes.map((s) => s.toLowerCase().replace(/^https:\/\/graph\.microsoft\.com\//, '')),
    );
    const grantedScope = TEAMS_PERMISSIONS[operation].find((scope) =>
      grants.has(scope.toLowerCase()),
    );
    if (!grantedScope) throw new TeamsReadUnavailable('permission_required');
    return { token, grantedScope };
  });
}

export async function readMicrosoftTeams(
  prisma: PrismaService,
  ctx: TenantContext,
  operation: TeamsReadOperation,
  raw: unknown,
  transport: Transport,
): Promise<TeamsReadResult> {
  const input = parseTeamsInput(operation, raw);
  const url = teamsPageUrl(operation, input);
  try {
    return await withMailboxProviderBudget(async () => {
      const initial = await admit(prisma, ctx, input, operation);
      const current = await transport.token(
        input.connectionId,
        initial.token,
        initial.grantedScope,
      );
      await admit(prisma, ctx, input, operation, current.snapshot);
      const rawPage = await transport.get(url, current.accessToken);
      // Never release bytes from a disconnect, account replacement, lost grant or revoked actor.
      await admit(prisma, ctx, input, operation, current.snapshot);
      return projectTeamsPage(operation, input, rawPage);
    });
  } catch (error) {
    if (error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
    const status = (error as { graphStatus?: number } | null)?.graphStatus;
    const reason =
      error instanceof TeamsReadUnavailable
        ? error.reason
        : error instanceof MailboxReconnectRequiredError || status === 401
          ? 'reconnect_required'
          : status === 403
            ? 'permission_required'
            : error instanceof BadRequestException
              ? 'source_changed'
              : error instanceof ServiceUnavailableException && status === undefined
                ? 'configuration_required'
                : 'provider_unavailable';
    return {
      kind: 'unavailable',
      operation,
      reason,
      requiredPermission: TEAMS_PERMISSIONS[operation][0],
    };
  }
}
