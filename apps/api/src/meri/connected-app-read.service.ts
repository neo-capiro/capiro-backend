import { ForbiddenException, Injectable } from '@nestjs/common';
import { ROLE_RANK, type TenantContext } from '@capiro/shared';
import { isDeepStrictEqual } from 'node:util';
import { ApplicationMembershipService } from '../auth/application-membership.service.js';
import { ContextSecurityScopeService } from '../context/context-security-scope.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { MeriManagedMcpService } from './meri-managed-mcp.service.js';
import { MeriMcpService } from './meri-mcp.service.js';
import { assertMeriToolRequestActive } from './meri-tool-request-control.js';
import {
  assertConnectedArguments,
  connectedReadJson,
  parseConnectedAppRead,
} from './connected-app-read.contract.js';

@Injectable()
export class ConnectedAppReadService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly membership: ApplicationMembershipService,
    private readonly security: ContextSecurityScopeService,
    private readonly managed: MeriManagedMcpService,
    private readonly mcp: MeriMcpService,
  ) {}

  private async authority(ctx: TenantContext, clientId: string | null) {
    assertMeriToolRequestActive();
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const current = await this.membership.readInTransaction(ctx, tx);
      if (ROLE_RANK[current.role] < ROLE_RANK.standard_user)
        throw new ForbiddenException('Connected read refused');
      const client =
        clientId === null
          ? null
          : await this.security.resolveApplicationAuthorityClient(
              ctx.tenantId,
              ctx.userId,
              clientId,
              tx,
            );
      return { membership: current.membershipRevision, client };
    });
  }

  async read(ctx: TenantContext, operation: string, raw: unknown) {
    const request = parseConnectedAppRead(operation, raw);
    const before = await this.authority(ctx, request.clientId);
    // This existing owner hardens managed read allowlists and discovers their exact schemas.
    const managedCatalog = await this.managed.managedCatalogForMeriV3(ctx);
    const selections = await this.mcp.connectedReadSelections(ctx);
    const current = async () => {
      if (!isDeepStrictEqual(before, await this.authority(ctx, request.clientId)))
        throw new ForbiddenException('Connected read authority changed');
      assertMeriToolRequestActive();
    };
    if (operation === 'list_connected_app_reads') {
      for (const selection of selections)
        await this.mcp.assertConnectedReadCurrent(
          ctx,
          selection.connectionId,
          selection.bridgedName,
        );
      await current();
      return {
        operation,
        clientId: request.clientId,
        observedAt: new Date().toISOString(),
        status: selections.length ? 'ok' : 'unavailable',
        untrusted: true,
        complete: false,
        scope: 'current_connection_catalog',
        managedAvailability: managedCatalog.availability.state,
        capabilities: selections.map(({ bridgedName: _private, ...selection }) => selection),
      };
    }
    const selection = selections.find(
      (item) =>
        item.connectionId === request.connectionId &&
        item.provider === request.provider &&
        item.tool === request.tool &&
        item.schemaHash === request.schemaHash,
    );
    const base = {
      operation,
      clientId: request.clientId,
      connectionId: request.connectionId,
      provider: request.provider,
      tool: request.tool,
      schemaHash: request.schemaHash,
      untrusted: true,
      scope: 'connection_permissions',
      completeness: 'provider_page',
    };
    if (!selection) {
      const status = await this.mcp.connectedReadUnavailableState(
        ctx,
        request.connectionId!,
        request.provider!,
        request.tool!,
      );
      await current();
      return {
        ...base,
        observedAt: new Date().toISOString(),
        status,
        content: null,
        providerResult: null,
        reason:
          status === 'disconnected'
            ? 'connection_disconnected'
            : status === 'permission_required'
              ? 'connection_permission_required'
              : 'current_read_schema_unavailable',
      };
    }
    assertConnectedArguments(selection, request.arguments!);
    const connection = await this.mcp.assertConnectedReadCurrent(
      ctx,
      selection.connectionId,
      selection.bridgedName,
    );
    const options = {
      structuredRead: true,
      connectedRead: { connectionId: selection.connectionId, revision: connection.revision },
    };
    let result: unknown;
    try {
      assertMeriToolRequestActive();
      result = ['hubspot', 'airtable', 'google-drive'].includes(selection.provider)
        ? await this.managed.executeRead(ctx, selection.bridgedName, request.arguments!, options)
        : await this.mcp.executeBridged(ctx, selection.bridgedName, request.arguments!, options);
    } finally {
      // Neither a failed provider nor a successful late response bypasses current authority.
      await current();
      const after = await this.mcp.assertConnectedReadCurrent(
        ctx,
        selection.connectionId,
        selection.bridgedName,
      );
      if (!isDeepStrictEqual(connection, after))
        throw new ForbiddenException('Connected read connection changed');
    }
    const envelope = result as { content?: unknown; structuredResult?: unknown };
    const content =
      typeof envelope?.content === 'string' ? envelope.content.slice(0, 12_000) : null;
    let providerResult: unknown = null;
    let status = 'ok',
      reason: string | null = null;
    try {
      providerResult = connectedReadJson(envelope?.structuredResult, 131_072, true);
      if (!providerResult || typeof providerResult !== 'object' || Array.isArray(providerResult)) {
        status = 'unavailable';
        reason = 'provider_result_unavailable';
        providerResult = null;
      }
    } catch {
      status = 'partial';
      reason = 'provider_result_exceeds_safe_json_boundary';
    }
    if (
      providerResult &&
      typeof providerResult === 'object' &&
      'isError' in providerResult &&
      providerResult.isError === true
    ) {
      status = 'unavailable';
      reason = 'provider_reported_error';
    }
    return {
      ...base,
      observedAt: new Date().toISOString(),
      status,
      content,
      providerResult,
      reason,
    };
  }
}
