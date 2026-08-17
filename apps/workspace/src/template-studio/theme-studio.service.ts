import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service.js';
import type {
  WsTheme,
  WsThemeVersion,
  WsThemeVersionStatus,
} from '../../generated/prisma-client/index.js';
import type { CreateThemeDto, SaveThemeDraftDto, CreateThemeVersionDto } from './dto/theme.dto.js';

/**
 * Theme Studio — document theme CRUD with versioned, immutable published
 * versions (GAPS §15). Mirrors the blueprint versioning pattern from
 * TemplateStudioService.
 *
 * Tenancy:
 *  - Every query is tenant-scoped. Themes are firm-scoped (not capiro-global).
 *  - Any authenticated tenant member may create, version, publish, and retire.
 *
 * Immutability:
 *  - A published WsThemeVersion is immutable; PATCH → 409.
 *  - The settingsHash is the content-addressed hash of the settings JSON.
 */
@Injectable()
export class ThemeStudioService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Theme CRUD ─────────────────────────────────────────────────────────

  /** List all themes for this tenant with their latest version. */
  async listThemes(tenantId: string): Promise<Array<WsTheme & { versions: WsThemeVersion[] }>> {
    return this.prisma.wsTheme.findMany({
      where: { tenantId },
      orderBy: [{ name: 'asc' }],
      include: { versions: { orderBy: { version: 'desc' }, take: 1 } },
    }) as Promise<Array<WsTheme & { versions: WsThemeVersion[] }>>;
  }

  /** Get one theme with all its versions. */
  async getTheme(tenantId: string, themeId: string): Promise<WsTheme & { versions: WsThemeVersion[] }> {
    const theme = await this.prisma.wsTheme.findFirst({
      where: { id: themeId, tenantId },
      include: { versions: { orderBy: { version: 'asc' } } },
    });
    if (!theme) throw new NotFoundException('Theme not found');
    return theme as WsTheme & { versions: WsThemeVersion[] };
  }

  /** Create a new theme with an initial draft version. */
  async createTheme(
    tenantId: string,
    clerkUserId: string,
    dto: CreateThemeDto,
  ): Promise<WsTheme & { versions: WsThemeVersion[] }> {
    const theme = await this.prisma.wsTheme.create({
      data: {
        tenantId,
        slug: dto.slug,
        name: dto.name,
        description: dto.description ?? null,
        ownerId: clerkUserId,
      },
    });
    // Initial draft version (version 1).
    const settingsHash = this.computeSettingsHash({});
    const version = await this.prisma.wsThemeVersion.create({
      data: {
        tenantId,
        themeId: theme.id,
        version: 1,
        status: 'draft' as WsThemeVersionStatus,
        settings: {} as never,
        settingsHash,
        createdById: clerkUserId,
      },
    });
    return { ...theme, versions: [version] };
  }

  // ── Versions ───────────────────────────────────────────────────────────

  /** Get a single theme version. */
  async getVersion(
    tenantId: string,
    themeId: string,
    versionId: string,
  ): Promise<WsThemeVersion> {
    await this.getTheme(tenantId, themeId);
    const row = await this.prisma.wsThemeVersion.findFirst({
      where: { id: versionId, themeId },
    });
    if (!row) throw new NotFoundException('Theme version not found');
    return row;
  }

  /** Create a new draft version (branched from the latest version's settings). */
  async createVersion(
    tenantId: string,
    themeId: string,
    clerkUserId: string,
    dto: CreateThemeVersionDto,
  ): Promise<WsThemeVersion> {
    const theme = await this.getTheme(tenantId, themeId);
    const versions = await this.prisma.wsThemeVersion.findMany({
      where: { themeId },
      orderBy: { version: 'desc' },
    });
    const nextVersion = (versions[0]?.version ?? 0) + 1;
    const seedSettings =
      dto.settings ?? (versions[0]?.settings as Record<string, unknown> | undefined) ?? {};
    const settingsHash = this.computeSettingsHash(seedSettings);
    return this.prisma.wsThemeVersion.create({
      data: {
        tenantId,
        themeId,
        version: nextVersion,
        status: 'draft' as WsThemeVersionStatus,
        settings: seedSettings as never,
        settingsHash,
        createdById: clerkUserId,
      },
    }) as Promise<WsThemeVersion>;
  }

  /** Save (update) a draft version's settings. Published/retired → 409. */
  async saveDraft(
    tenantId: string,
    themeId: string,
    versionId: string,
    dto: SaveThemeDraftDto,
  ): Promise<WsThemeVersion> {
    const version = await this.getVersion(tenantId, themeId, versionId);
    if (version.status !== 'draft') {
      throw new ConflictException(
        `Theme version is ${version.status} and cannot be edited`,
      );
    }
    const settingsHash = this.computeSettingsHash(dto.settings);
    return this.prisma.wsThemeVersion.update({
      where: { id: versionId },
      data: {
        settings: dto.settings as never,
        settingsHash,
      },
    }) as Promise<WsThemeVersion>;
  }

  /** Publish a draft version. Published versions are immutable. */
  async publishVersion(
    tenantId: string,
    themeId: string,
    versionId: string,
    clerkUserId: string,
  ): Promise<WsThemeVersion> {
    const version = await this.getVersion(tenantId, themeId, versionId);
    if (version.status !== 'draft') {
      throw new ConflictException(
        `Theme version is ${version.status}; only draft versions can be published`,
      );
    }
    const settings = version.settings as Record<string, unknown>;
    const settingsHash = this.computeSettingsHash(settings);
    return this.prisma.wsThemeVersion.update({
      where: { id: versionId },
      data: {
        status: 'published' as WsThemeVersionStatus,
        settingsHash,
        publishedAt: new Date(),
      },
    }) as Promise<WsThemeVersion>;
  }

  /** Retire a published version. */
  async retireVersion(
    tenantId: string,
    themeId: string,
    versionId: string,
    clerkUserId: string,
  ): Promise<WsThemeVersion> {
    const version = await this.getVersion(tenantId, themeId, versionId);
    if (version.status !== 'published') {
      throw new ConflictException(
        `Theme version is ${version.status}; only published versions can be retired`,
      );
    }
    return this.prisma.wsThemeVersion.update({
      where: { id: versionId },
      data: {
        status: 'retired' as WsThemeVersionStatus,
        retiredAt: new Date(),
      },
    }) as Promise<WsThemeVersion>;
  }

  // ── Helpers ────────────────────────────────────────────────────────────

  /** Content-addressed hash of the settings JSON. */
  private computeSettingsHash(settings: Record<string, unknown>): string {
    const stable = this.stableStringify(settings);
    return createHash('sha256').update(stable, 'utf8').digest('hex');
  }

  private stableStringify(v: unknown): string {
    if (Array.isArray(v)) return '[' + v.map((x) => this.stableStringify(x)).join(',') + ']';
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as Record<string, unknown>).sort()) {
        out[k] = (v as Record<string, unknown>)[k];
      }
      return '{' + Object.keys(out).map((k) => `${JSON.stringify(k)}:${this.stableStringify(out[k])}`).join(',') + '}';
    }
    return JSON.stringify(v);
  }
}
