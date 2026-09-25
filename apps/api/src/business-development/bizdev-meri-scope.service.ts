import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  businessDevelopmentEnabled,
  businessDevelopmentMeriProspectToolsEnabled,
} from '../common/tenant-flags.js';

/**
 * Business Development Phase 4 — Meri prospect-conversation scope resolution.
 *
 * Phase 4's server-only slice: when a Meri conversation is created against a
 * BD prospect, the server — never the client — resolves a BOUNDED prospect
 * scope (ids, display name, and an opaque scopeVersion digest). No provider
 * payloads, notes, or dossier data are embedded in the conversation metadata;
 * future dispatch must re-resolve authorization through `assertCurrent`.
 *
 * Fail-closed on every path, mirroring the Phase 1/2/4 guards: every failure
 * mode (missing tenant context, missing tenant row, either flag off, missing
 * or cross-tenant prospect, thrown DB error) yields the SAME bare
 * NotFoundException — indistinguishable from a route that doesn't exist.
 */

/** The one bounded metadata key Meri prospect conversations persist scope under. */
export const MERI_PROSPECT_SCOPE_METADATA_KEY = 'bizdevProspectScope' as const;

/** Semantic (typed) shape of the persisted scope. */
export interface MeriProspectScope {
  prospectId: string;
  prospectName: string;
  canonicalOrganizationId: string | null;
  linkedClientId: string | null;
  scopeVersion: string;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SCOPE_VERSION_RE = /^[0-9a-f]{64}$/;
const SCOPE_KEYS = [
  'canonicalOrganizationId',
  'linkedClientId',
  'prospectId',
  'prospectName',
  'scopeVersion',
] as const;

/** Typed failure for a persisted scope that no longer matches server reality. */
export class MeriProspectScopeConflictError extends ConflictException {
  constructor(reason: 'changed' | 'not_found') {
    super(
      reason === 'changed'
        ? 'The prospect this chat was created for has changed. Start a new chat from the prospect.'
        : 'This prospect chat is no longer available.',
    );
  }
}

/**
 * Deterministic SHA-256 over the stable, authorized selection fields only.
 * Pure so it unit-tests; two resolutions of the same prospect state produce
 * the same digest, and any change to id / canonical id / linked client /
 * linked client changes it. Ordinary prospect edits do not silently switch or
 * invalidate the conversation's selected prospect.
 */
export function computeMeriProspectScopeVersion(input: {
  prospectId: string;
  canonicalOrganizationId: string | null;
  linkedClientId: string | null;
}): string {
  const payload = [
    'meri-prospect-scope-v1',
    input.prospectId,
    input.canonicalOrganizationId ?? '',
    input.linkedClientId ?? '',
  ].join('|');
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Fail-closed parser for a scope persisted in conversation metadata.
 * Returns null for anything absent/malformed — callers must treat null as
 * "no usable scope" and reject prospect-dependent dispatch.
 */
export function parsePersistedMeriProspectScope(
  metadata: unknown,
): MeriProspectScope | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  const raw = (metadata as Record<string, unknown>)[MERI_PROSPECT_SCOPE_METADATA_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    Object.keys(record).sort().join('|') !== [...SCOPE_KEYS].sort().join('|') ||
    typeof record.prospectId !== 'string' ||
    !UUID_RE.test(record.prospectId) ||
    typeof record.prospectName !== 'string' ||
    record.prospectName.length < 1 ||
    record.prospectName.length > 200 ||
    (record.canonicalOrganizationId !== null &&
      (typeof record.canonicalOrganizationId !== 'string' ||
        !UUID_RE.test(record.canonicalOrganizationId))) ||
    (record.linkedClientId !== null &&
      (typeof record.linkedClientId !== 'string' || !UUID_RE.test(record.linkedClientId))) ||
    typeof record.scopeVersion !== 'string' ||
    !SCOPE_VERSION_RE.test(record.scopeVersion)
  ) {
    return null;
  }
  return {
    prospectId: record.prospectId,
    prospectName: record.prospectName,
    canonicalOrganizationId: record.canonicalOrganizationId,
    linkedClientId: record.linkedClientId,
    scopeVersion: record.scopeVersion,
  };
}

@Injectable()
export class BizDevMeriScopeService {
  private readonly logger = new Logger(BizDevMeriScopeService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve the bounded prospect scope for a Meri conversation. Both the
   * Phase 1 `businessDevelopment.enabled` and the Phase 4
   * `businessDevelopment.meriProspectTools.enabled` tenant flags must be true,
   * and the prospect must exist on the caller's tenant. Every failure mode
   * throws the same bare safe NotFoundException.
   */
  async resolve(ctx: TenantContext, prospectId: string): Promise<MeriProspectScope> {
    const notFound = new NotFoundException();
    if (!ctx?.tenantId) throw notFound;
    if (!prospectId) throw notFound;
    try {
      return await this.prisma.withTenant(ctx.tenantId, async (tx) => {
        const tenant = await tx.tenant.findUnique({
          where: { id: ctx.tenantId },
          select: { settings: true },
        });
        if (
          !tenant ||
          !businessDevelopmentEnabled(tenant.settings) ||
          !businessDevelopmentMeriProspectToolsEnabled(tenant.settings)
        ) {
          throw notFound;
        }
        const prospect = await tx.businessDevelopmentProspect.findFirst({
          where: { tenantId: ctx.tenantId, id: prospectId },
          select: {
            id: true,
            displayName: true,
            canonicalEntityId: true,
            linkedClientId: true,
          },
        });
        if (!prospect) throw notFound;
        return {
          prospectId: prospect.id,
          prospectName: prospect.displayName,
          canonicalOrganizationId: prospect.canonicalEntityId,
          linkedClientId: prospect.linkedClientId,
          scopeVersion: computeMeriProspectScopeVersion({
            prospectId: prospect.id,
            canonicalOrganizationId: prospect.canonicalEntityId,
            linkedClientId: prospect.linkedClientId,
          }),
        };
      });
    } catch (error) {
      if (error instanceof NotFoundException) throw error;
      this.logger.error(
        `meri prospect scope resolution failed for tenant ${ctx.tenantId}; failing closed`,
        error instanceof Error ? error.stack : String(error),
      );
      throw new NotFoundException();
    }
  }

  /**
   * Guard for future prospect-dependent dispatch: re-resolve the scope under
   * current authorization and reject a changed or missing persisted scope
   * with the typed conflict / safe 404. Never repairs or silently accepts a
   * stale scope.
   */
  async assertCurrent(
    ctx: TenantContext,
    persistedScope: unknown,
  ): Promise<MeriProspectScope> {
    // Accept either a bare scope object or the full metadata bag it was
    // persisted in; both go through the same fail-closed parser.
    const candidate =
      persistedScope &&
      typeof persistedScope === 'object' &&
      MERI_PROSPECT_SCOPE_METADATA_KEY in (persistedScope as Record<string, unknown>)
        ? parsePersistedMeriProspectScope(persistedScope)
        : parsePersistedMeriProspectScope({
            [MERI_PROSPECT_SCOPE_METADATA_KEY]: persistedScope,
          });
    if (!candidate) throw new MeriProspectScopeConflictError('not_found');
    const current = await this.resolve(ctx, candidate.prospectId).catch((error) => {
      if (error instanceof NotFoundException) {
        throw new MeriProspectScopeConflictError('not_found');
      }
      throw error;
    });
    if (
      current.scopeVersion !== candidate.scopeVersion ||
      current.prospectId !== candidate.prospectId ||
      current.canonicalOrganizationId !== candidate.canonicalOrganizationId ||
      current.linkedClientId !== candidate.linkedClientId
    ) {
      throw new MeriProspectScopeConflictError('changed');
    }
    return current;
  }
}
