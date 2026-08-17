import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ContextResolutionError,
  type ContextSecurityScopeInput,
  type ResolvedContextSecurityScope,
} from './context.types.js';

const MAILBOX_PROVIDERS = ['microsoft_365', 'google_workspace', 'imap_caldav'] as const;

export interface ResolveContextSecurityScopeInput {
  tenantId: string;
  actorUserId: string;
  securityScope: ContextSecurityScopeInput;
}

/**
 * Establishes what the actor is allowed to see before subject interpretation or
 * retrieval. Caller lists are optional upper bounds, never authorization grants.
 * Client ethical walls and mailbox ownership are rechecked in the tenant DB.
 */
@Injectable()
export class ContextSecurityScopeService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(input: ResolveContextSecurityScopeInput): Promise<ResolvedContextSecurityScope> {
    const tenantId = requiredId(input.tenantId, 'tenantId');
    const actorUserId = requiredId(input.actorUserId, 'actorUserId');
    const requestedClientIds = normalizeIds(input.securityScope.authorizedClientIds);
    const requestedMailboxIds = normalizeIds(
      input.securityScope.authorizedMailboxConnectionIds,
    );
    const clientConstraintProvided = input.securityScope.authorizedClientIds !== undefined;
    const mailboxConstraintProvided =
      input.securityScope.authorizedMailboxConnectionIds !== undefined;

    return this.prisma.withTenant(tenantId, async (tx) => {
      const authorizedClientIds = await this.resolveClients(
        tx,
        actorUserId,
        requestedClientIds,
        clientConstraintProvided,
      );
      const authorizedMailboxConnectionIds = await this.resolveMailboxes(
        tx,
        actorUserId,
        requestedMailboxIds,
        mailboxConstraintProvided,
      );
      const allowGlobalPublic = input.securityScope.allowGlobalPublic === true;

      return {
        tenantId,
        actorUserId,
        authorizedClientIds,
        authorizedMailboxConnectionIds,
        graphPartitions: dedupeGraphPartitions(input.securityScope.graphPartitions ?? []),
        allowGlobalPublic,
        allowExternalResearch:
          allowGlobalPublic && input.securityScope.allowExternalResearch === true,
      };
    });
  }

  private async resolveClients(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    requestedIds: string[],
    constraintProvided: boolean,
  ): Promise<string[]> {
    if (constraintProvided && requestedIds.length === 0) return [];

    const rows = await tx.client.findMany({
      where: {
        ...(constraintProvided ? { id: { in: requestedIds } } : {}),
        OR: [
          { memoryWall: false },
          { memoryAccessGrants: { some: { userId: actorUserId } } },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const resolved = rows.map((row) => row.id);

    if (constraintProvided && resolved.length !== requestedIds.length) {
      throw new ContextResolutionError(
        'requested_client_scope_not_fully_authorized',
        'Requested client security scope is not fully authorized.',
        { requestedCount: requestedIds.length, authorizedCount: resolved.length },
      );
    }
    return resolved;
  }

  private async resolveMailboxes(
    tx: Prisma.TransactionClient,
    actorUserId: string,
    requestedIds: string[],
    constraintProvided: boolean,
  ): Promise<string[]> {
    if (constraintProvided && requestedIds.length === 0) return [];

    const rows = await tx.integrationConnection.findMany({
      where: {
        createdByUserId: actorUserId,
        provider: { in: [...MAILBOX_PROVIDERS] },
        ...(constraintProvided ? { id: { in: requestedIds } } : {}),
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    const resolved = rows.map((row) => row.id);

    if (constraintProvided && resolved.length !== requestedIds.length) {
      throw new ContextResolutionError(
        'requested_mailbox_scope_not_fully_authorized',
        'Requested mailbox security scope is not fully authorized.',
        { requestedCount: requestedIds.length, authorizedCount: resolved.length },
      );
    }
    return resolved;
  }
}

function requiredId(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ContextResolutionError(
      'invalid_context_request',
      `${field} is required.`,
      { field },
    );
  }
  return normalized;
}

function normalizeIds(values: readonly string[] | undefined): string[] {
  if (!values) return [];
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))].sort();
}

function dedupeGraphPartitions<T>(values: readonly T[]): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const value of values) {
    const key = stableJson(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, child]) => `${JSON.stringify(key)}:${stableJson(child)}`)
    .join(',')}}`;
}
