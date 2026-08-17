import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';

const MAX_TITLE_LENGTH = 160;
const MAX_PROMPT_BODY_LENGTH = 24_000;
const MAX_WORKSPACE_NAME_LENGTH = 120;

type SavedPromptRow = {
  id: string;
  title: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
};

type WorkspaceRow = {
  id: string;
  name: string;
  clientId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export interface SavedPromptInput {
  title: string;
  body: string;
}

export interface WorkspaceInput {
  name: string;
  clientId?: string | null;
}

export interface MeriVNextPreferenceInput {
  windowChrome?: unknown;
  railCollapsed?: unknown;
  openSection?: unknown;
}

export interface MeriVNextPreference {
  windowChrome: 'undocked' | 'maximized' | 'docked';
  railCollapsed: boolean;
  openSection: 'context' | 'sources' | 'actions' | null;
}

function requiredText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw new BadRequestException(`${field} must be text`);
  const normalized = value.trim();
  if (!normalized) throw new BadRequestException(`${field} cannot be empty`);
  if (normalized.length > max) throw new BadRequestException(`${field} is too long`);
  return normalized;
}

function optionalUuid(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  ) {
    throw new BadRequestException(`${field} must be a UUID`);
  }
  return value;
}

function normalizePreference(value: MeriVNextPreferenceInput): MeriVNextPreference {
  const windowChrome = value.windowChrome;
  if (windowChrome !== 'undocked' && windowChrome !== 'maximized' && windowChrome !== 'docked') {
    throw new BadRequestException('windowChrome is invalid');
  }
  if (typeof value.railCollapsed !== 'boolean') {
    throw new BadRequestException('railCollapsed must be boolean');
  }
  const openSection = value.openSection;
  if (openSection !== null && openSection !== 'context' && openSection !== 'sources' && openSection !== 'actions') {
    throw new BadRequestException('openSection is invalid');
  }
  return { windowChrome, railCollapsed: value.railCollapsed, openSection };
}

function publicSavedPrompt(row: SavedPromptRow) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    createdAt: row.createdAt?.toISOString?.() ?? '',
    updatedAt: row.updatedAt?.toISOString?.() ?? '',
  };
}

function publicWorkspace(row: WorkspaceRow) {
  return {
    id: row.id,
    name: row.name,
    clientId: row.clientId,
    createdAt: row.createdAt?.toISOString?.() ?? '',
    updatedAt: row.updatedAt?.toISOString?.() ?? '',
  };
}

/**
 * Durable vNext-only user library state. Every lookup has the tenant and user
 * boundary in its predicate; browser input is never treated as ownership.
 */
@Injectable()
export class MeriVNextLibraryService {
  constructor(private readonly prisma: PrismaService) {}

  async listSavedPrompts(ctx: TenantContext) {
    const rows = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriSavedPrompt.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    )) as SavedPromptRow[];
    return { prompts: rows.map(publicSavedPrompt) };
  }

  async createSavedPrompt(ctx: TenantContext, input: SavedPromptInput) {
    const title = requiredText(input.title, 'title', MAX_TITLE_LENGTH);
    const body = requiredText(input.body, 'body', MAX_PROMPT_BODY_LENGTH);
    const row = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriSavedPrompt.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, title, body } }),
    )) as SavedPromptRow;
    return publicSavedPrompt(row);
  }

  async updateSavedPrompt(ctx: TenantContext, promptId: string, input: Partial<SavedPromptInput>) {
    const existing = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriSavedPrompt.findFirst({ where: { id: promptId, tenantId: ctx.tenantId, userId: ctx.userId } }),
    )) as SavedPromptRow | null;
    if (!existing) throw new NotFoundException('Saved prompt not found');
    const data = {
      ...(input.title !== undefined ? { title: requiredText(input.title, 'title', MAX_TITLE_LENGTH) } : {}),
      ...(input.body !== undefined ? { body: requiredText(input.body, 'body', MAX_PROMPT_BODY_LENGTH) } : {}),
    };
    if (!Object.keys(data).length) return publicSavedPrompt(existing);
    const row = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriSavedPrompt.update({ where: { id: existing.id }, data }),
    )) as SavedPromptRow;
    return publicSavedPrompt(row);
  }

  async deleteSavedPrompt(ctx: TenantContext, promptId: string) {
    const existing = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriSavedPrompt.findFirst({ where: { id: promptId, tenantId: ctx.tenantId, userId: ctx.userId } }),
    )) as SavedPromptRow | null;
    if (!existing) throw new NotFoundException('Saved prompt not found');
    await this.prisma.withTenant(ctx.tenantId, (tx) => tx.meriSavedPrompt.delete({ where: { id: existing.id } }));
    return { ok: true, id: existing.id };
  }

  async listWorkspaces(ctx: TenantContext) {
    const rows = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriWorkspace.findMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        orderBy: { updatedAt: 'desc' },
        take: 100,
      }),
    )) as WorkspaceRow[];
    return { workspaces: rows.map(publicWorkspace) };
  }

  async createWorkspace(ctx: TenantContext, input: WorkspaceInput) {
    const name = requiredText(input.name, 'name', MAX_WORKSPACE_NAME_LENGTH);
    const clientId = optionalUuid(input.clientId, 'clientId');
    if (clientId) {
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({ where: { id: clientId, tenantId: ctx.tenantId }, select: { id: true } }),
      );
      if (!client) throw new NotFoundException('Client not found');
    }
    const row = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriWorkspace.create({ data: { tenantId: ctx.tenantId, userId: ctx.userId, name, clientId } }),
    )) as WorkspaceRow;
    return publicWorkspace(row);
  }

  async updateWorkspace(ctx: TenantContext, workspaceId: string, input: Partial<WorkspaceInput>) {
    const existing = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriWorkspace.findFirst({ where: { id: workspaceId, tenantId: ctx.tenantId, userId: ctx.userId } }),
    )) as WorkspaceRow | null;
    if (!existing) throw new NotFoundException('Workspace not found');
    const data = {
      ...(input.name !== undefined ? { name: requiredText(input.name, 'name', MAX_WORKSPACE_NAME_LENGTH) } : {}),
      ...(input.clientId !== undefined ? { clientId: optionalUuid(input.clientId, 'clientId') } : {}),
    };
    const nextClientId = data.clientId;
    if (nextClientId) {
      const client = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.client.findFirst({ where: { id: nextClientId, tenantId: ctx.tenantId }, select: { id: true } }),
      );
      if (!client) throw new NotFoundException('Client not found');
    }
    if (!Object.keys(data).length) return publicWorkspace(existing);
    const row = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriWorkspace.update({ where: { id: existing.id }, data }),
    )) as WorkspaceRow;
    return publicWorkspace(row);
  }

  async deleteWorkspace(ctx: TenantContext, workspaceId: string) {
    const existing = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriWorkspace.findFirst({ where: { id: workspaceId, tenantId: ctx.tenantId, userId: ctx.userId } }),
    )) as WorkspaceRow | null;
    if (!existing) throw new NotFoundException('Workspace not found');
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      await tx.clioConversation.updateMany({
        where: { tenantId: ctx.tenantId, userId: ctx.userId, workspaceId: existing.id },
        data: { workspaceId: null },
      });
      await tx.meriWorkspace.delete({ where: { id: existing.id } });
    });
    return { ok: true, id: existing.id };
  }

  async getPreferences(ctx: TenantContext): Promise<MeriVNextPreference> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriVnextPreference.findFirst({
        where: { tenantId: ctx.tenantId, userId: ctx.userId },
        select: { windowChrome: true, railCollapsed: true, openSection: true },
      }),
    );
    if (!row) return { windowChrome: 'undocked', railCollapsed: false, openSection: null };
    return normalizePreference({
      windowChrome: row.windowChrome,
      railCollapsed: row.railCollapsed,
      openSection: row.openSection,
    });
  }

  async savePreferences(ctx: TenantContext, input: MeriVNextPreferenceInput): Promise<MeriVNextPreference> {
    const preference = normalizePreference(input);
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.meriVnextPreference.upsert({
        where: { tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId } },
        create: { tenantId: ctx.tenantId, userId: ctx.userId, ...preference },
        update: preference,
      }),
    );
    return preference;
  }

  async assignConversation(ctx: TenantContext, conversationId: string, workspaceId: string | null) {
    if (workspaceId) {
      const workspace = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.meriWorkspace.findFirst({ where: { id: workspaceId, tenantId: ctx.tenantId, userId: ctx.userId } }),
      )) as WorkspaceRow | null;
      if (!workspace) throw new NotFoundException('Workspace not found');
    }
    const conversation = (await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.findFirst({
        where: { id: conversationId, tenantId: ctx.tenantId, userId: ctx.userId, archivedAt: null },
        select: { id: true },
      }),
    )) as { id: string } | null;
    if (!conversation) throw new NotFoundException('Meri conversation not found');
    await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioConversation.update({
        where: { id: conversation.id },
        data: { workspaceId },
      }),
    );
    return { id: conversation.id, workspaceId };
  }
}
