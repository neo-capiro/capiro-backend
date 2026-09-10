/**
 * LegiWatch V2 Wave 2 (W2-2) — Saved Views.
 *
 * A real persistence system replacing the `SavedViewsOverlay`/
 * `LegiWatchSettingsTab` "no persistence backend" placeholders (GAPS LW-G8).
 *
 * ── authorization model ──
 *
 * A view is always mutable ONLY by its owner (`ownerUserId`). `scope`
 * ('personal' | 'tenant') controls READ visibility alone: a 'tenant' view is
 * listable/appliable by any tenant member, but rename/duplicate/delete/
 * default/re-share still 404 for everyone except the owner — "duplicate it"
 * is the path for someone who wants a shared view under their own control,
 * exactly like "Personal views cannot be mutated by another user" requires.
 *
 * Every read is additionally scoped by `withTenant`, so a cross-tenant id
 * guess 404s rather than leaking whether the row exists at all.
 */
import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  boundedViewConfigViolation,
  type LegiWatchSavedViewScope,
  type LegiWatchSavedViewSurface,
} from './legiwatch-wave2-saved-views.dto.js';

/** Bumped only when the stored `config` SHAPE changes incompatibly. */
export const CURRENT_CONFIG_VERSION = 1;

export interface SavedViewRow {
  id: string;
  surface: string;
  name: string;
  scope: string;
  isDefault: boolean;
  clientId: string | null;
  configVersion: number;
  config: Record<string, unknown>;
  ownerUserId: string;
  isOwnedByCaller: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApplyViewResult extends SavedViewRow {
  /**
   * Set when `clientId` no longer resolves under this tenant (archived or
   * deleted) — an honest warning, never a silent substitution of "All
   * clients" or a stale name.
   */
  clientWarning: string | null;
  folderWarning: string | null;
}

@Injectable()
export class LegiWatchWave2SavedViewsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    ctx: TenantContext,
    input: { surface?: LegiWatchSavedViewSurface; scope?: 'personal' | 'tenant' | 'all' },
  ): Promise<{ rows: SavedViewRow[] }> {
    const scopeFilter =
      input.scope === 'personal'
        ? { ownerUserId: ctx.userId, scope: 'personal' }
        : input.scope === 'tenant'
          ? { scope: 'tenant' }
          : // 'all' (default): every view this user may see — their own personal
            // views, plus every tenant-shared view regardless of owner.
            undefined;

    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchSavedView.findMany({
        where: {
          ...(input.surface ? { surface: input.surface } : {}),
          ...(scopeFilter ?? { OR: [{ ownerUserId: ctx.userId }, { scope: 'tenant' }] }),
        },
        orderBy: [{ isDefault: 'desc' }, { updatedAt: 'desc' }],
      }),
    );
    return { rows: rows.map((r) => this.toRow(ctx, r)) };
  }

  async create(
    ctx: TenantContext,
    input: {
      surface: LegiWatchSavedViewSurface;
      name: string;
      scope?: LegiWatchSavedViewScope;
      clientId?: string;
      configVersion?: number;
      config?: Record<string, unknown>;
    },
  ): Promise<SavedViewRow> {
    this.assertConfigVersion(input.configVersion);
    if (input.clientId) await this.assertClientInTenant(ctx.tenantId, input.clientId);

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchSavedView.create({
        data: {
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          surface: input.surface,
          name: input.name,
          scope: input.scope ?? 'personal',
          clientId: input.clientId ?? null,
          configVersion: input.configVersion ?? CURRENT_CONFIG_VERSION,
          config: (input.config ?? {}) as object,
        },
      }),
    );
    return this.toRow(ctx, row);
  }

  async update(
    ctx: TenantContext,
    id: string,
    input: {
      name?: string;
      scope?: LegiWatchSavedViewScope;
      clientId?: string;
      configVersion?: number;
      config?: Record<string, unknown>;
    },
  ): Promise<SavedViewRow> {
    this.assertConfigVersion(input.configVersion);
    const existing = await this.requireOwned(ctx, id);
    const clientId = input.clientId === undefined ? existing.clientId : input.clientId;
    if (clientId) await this.assertClientInTenant(ctx.tenantId, clientId);

    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchSavedView.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.scope !== undefined ? { scope: input.scope } : {}),
          ...(input.clientId !== undefined ? { clientId: input.clientId } : {}),
          ...(input.configVersion !== undefined ? { configVersion: input.configVersion } : {}),
          ...(input.config !== undefined ? { config: input.config as object } : {}),
          updatedAt: new Date(),
        },
      }),
    );
    return this.toRow(ctx, row);
  }

  /** Rename. A thin, explicitly-named alias over `update` for the one field. */
  async rename(ctx: TenantContext, id: string, name: string): Promise<SavedViewRow> {
    return this.update(ctx, id, { name });
  }

  /**
   * Duplicate. Always lands as a PERSONAL view owned by the caller — a
   * duplicate of a tenant-shared view is exactly the "make my own mutable
   * copy" path, so it must never inherit `scope: 'tenant'` from the source.
   */
  async duplicate(ctx: TenantContext, id: string, name?: string): Promise<SavedViewRow> {
    // Duplicating reads like APPLYING the source: any tenant member may
    // duplicate a tenant-shared view (that's the whole point of sharing),
    // not only its owner.
    const source = await this.requireVisible(ctx, id);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchSavedView.create({
        data: {
          tenantId: ctx.tenantId,
          ownerUserId: ctx.userId,
          surface: source.surface,
          name: name?.trim() || `${source.name} (copy)`,
          scope: 'personal',
          clientId: source.clientId,
          configVersion: source.configVersion,
          config: source.config as object,
        },
      }),
    );
    return this.toRow(ctx, row);
  }

  /** Make/unmake default. Only the owner may default their own view. */
  async setDefault(ctx: TenantContext, id: string, isDefault: boolean): Promise<SavedViewRow> {
    const existing = await this.requireOwned(ctx, id);
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      if (isDefault) {
        // Clear any other default this owner holds for the same surface
        // first — the partial unique index would otherwise reject the second
        // `is_default=true` row outright rather than swapping it in.
        await tx.legiWatchSavedView.updateMany({
          where: {
            tenantId: ctx.tenantId,
            ownerUserId: ctx.userId,
            surface: existing.surface,
            isDefault: true,
          },
          data: { isDefault: false },
        });
      }
      return tx.legiWatchSavedView.update({
        where: { id },
        data: { isDefault, updatedAt: new Date() },
      });
    });
    return this.toRow(ctx, row);
  }

  /**
   * Idempotent delete, matching `LegiWatchSavedItem.deleteSavedItem`'s
   * established convention: no pre-check, just attempt the owner-scoped
   * delete and report whether a row actually went away. This deliberately
   * does NOT throw for "someone else's view" the way rename/update do — a
   * throwing delete would make a plain re-delete of your OWN
   * already-deleted view an error too, which is worse idempotent-DELETE
   * behavior than reporting `{deleted:false}` for both "already gone" and
   * "not yours" (indistinguishable outcomes that need no distinguishing:
   * either way, the caller's view is not present after this call).
   */
  async delete(ctx: TenantContext, id: string): Promise<{ deleted: boolean }> {
    const result = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchSavedView.deleteMany({ where: { id, ownerUserId: ctx.userId } }),
    );
    return { deleted: result.count > 0 };
  }

  /**
   * Apply — read-only. Any tenant member may apply a view they can see
   * (their own, or a tenant-shared one); applying never mutates the row.
   * Returns an honest `clientWarning` when the referenced client is no
   * longer resolvable, rather than silently substituting a different scope.
   */
  async apply(ctx: TenantContext, id: string): Promise<ApplyViewResult> {
    const row = await this.requireVisible(ctx, id);
    let clientWarning: string | null = null;
    if (row.clientId) {
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({ where: { id: row.clientId! }, select: { id: true, status: true } }),
      );
      if (!client) {
        clientWarning = 'The client this view references no longer exists in this workspace.';
      } else if (client.status !== 'active') {
        clientWarning = 'The client this view references has been archived.';
      }
    }
    const filters = (row.config as { filters?: { params?: Record<string, unknown> } })?.filters;
    const params = filters?.params ?? {};
    // URL scope is part of the persisted contract as well as the legacy
    // clientId field. A missing reference must never widen the restored view.
    const urlClient = typeof params.client === 'string' ? params.client : null;
    if (urlClient && urlClient !== '_all' && urlClient !== row.clientId) {
      const client = isUUID(urlClient)
        ? await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.client.findFirst({ where: { id: urlClient }, select: { status: true } }),
          )
        : null;
      if (!client || client.status !== 'active')
        clientWarning = 'The saved client is unavailable in this workspace.';
    }
    let folderWarning: string | null = null;
    if (typeof params.folder === 'string' && params.folder) {
      const folders = await this.prisma.withTenant(
        ctx.tenantId,
        (tx) =>
          tx.$queryRaw<
            Array<{ id: string; clientId: string | null }>
          >`SELECT id,client_id AS "clientId" FROM intel_legiwatch_folder WHERE tenant_id=${ctx.tenantId} AND id=${params.folder}`,
      );
      if (!folders.length)
        folderWarning =
          'The saved folder is unavailable in this workspace. Choose an accessible folder before restoring this view.';
      const effectiveClient = urlClient && urlClient !== '_all' ? urlClient : row.clientId;
      if (folders.length && effectiveClient && folders[0]?.clientId !== effectiveClient)
        folderWarning = 'The saved folder does not belong to the saved client scope.';
    }
    return { ...this.toRow(ctx, row), clientWarning, folderWarning };
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  private assertConfigVersion(version: number | undefined): void {
    if (version !== undefined && version > CURRENT_CONFIG_VERSION) {
      // Fail closed: a config shape newer than this server understands must
      // never be silently accepted and then misapplied on read.
      throw new ForbiddenException(
        `Unsupported saved-view config version ${version}; this server understands up to ${CURRENT_CONFIG_VERSION}.`,
      );
    }
  }

  private async assertClientInTenant(tenantId: string, clientId: string): Promise<void> {
    const found = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true } }),
    );
    if (!found) throw new NotFoundException('Client not found');
  }

  /** Loaded and owned by the caller, or 404 (never leaks existence otherwise). */
  private async requireOwned(
    ctx: TenantContext,
    id: string,
  ): Promise<NonNullable<Awaited<ReturnType<PrismaService['legiWatchSavedView']['findFirst']>>>> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchSavedView.findFirst({ where: { id, ownerUserId: ctx.userId } }),
    );
    if (!row) throw new NotFoundException('Saved view not found');
    return row;
  }

  /** Loaded and visible to the caller (own, or tenant-shared), or 404. */
  private async requireVisible(
    ctx: TenantContext,
    id: string,
  ): Promise<NonNullable<Awaited<ReturnType<PrismaService['legiWatchSavedView']['findFirst']>>>> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.legiWatchSavedView.findFirst({
        where: { id, OR: [{ ownerUserId: ctx.userId }, { scope: 'tenant' }] },
      }),
    );
    if (!row) throw new NotFoundException('Saved view not found');
    return row;
  }

  private toRow(
    ctx: TenantContext,
    row: {
      id: string;
      surface: string;
      name: string;
      scope: string;
      isDefault: boolean;
      clientId: string | null;
      configVersion: number;
      config: unknown;
      ownerUserId: string;
      createdAt: Date;
      updatedAt: Date;
    },
  ): SavedViewRow {
    // A defensive re-check on the way OUT too: a row written by an older,
    // looser server build must not be trusted just because it made it into
    // the table.
    const violation = boundedViewConfigViolation(row.config);
    return {
      id: row.id,
      surface: row.surface,
      name: row.name,
      scope: row.scope,
      isDefault: row.isDefault,
      clientId: row.clientId,
      configVersion: row.configVersion,
      config: violation ? {} : ((row.config ?? {}) as Record<string, unknown>),
      ownerUserId: row.ownerUserId,
      isOwnedByCaller: row.ownerUserId === ctx.userId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}
