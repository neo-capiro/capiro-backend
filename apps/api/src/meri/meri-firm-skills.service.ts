import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { MERI_CAPABILITY_REGISTRY, type TenantContext } from '@capiro/shared';
import type { AppConfig } from '../config/config.schema.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { validateFirmSkill } from './meri-firm-skills.helpers.js';
import { CLIO_SKILLS } from './skills/skill-registry.js';
import type { MeriProcedureBinding, MeriSkill } from './skills/skill.types.js';
import { TOOL_DEFINITIONS } from './meri-tools.service.js';

const VERSION_HISTORY_CAP = 10;
const CACHE_TTL_MS = 60_000; // disable/save takes effect within one minute

interface SkillVersionSnapshot {
  version: number;
  skillJson: MeriSkill;
  savedAt: string;
}

/**
 * Firm-authored Meri skills (assistant-parity F6b).
 *
 * Persistence + CRUD over clio_firm_skills with the security-critical
 * validation (meri-firm-skills.helpers.ts) applied at every write: reserved
 * and built-in triggers rejected, field/count caps enforced, tools restricted
 * to the real registry. Built-ins always win on conflict via the registry
 * safe-merge at turn time. A 60-second per-tenant cache keeps the chat path
 * cheap while changes (incl. disable) propagate within a minute.
 */
@Injectable()
export class MeriFirmSkillsService {
  private readonly logger = new Logger(MeriFirmSkillsService.name);
  private readonly cache = new Map<string, { skills: MeriSkill[]; fetchedAt: number }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  private enabled(): boolean {
    return this.config.get('CLIO_FIRM_SKILLS_ENABLED', { infer: true });
  }

  private allowedTools(): string[] {
    return TOOL_DEFINITIONS.map((t) => t.name);
  }

  private readOnlyTools(): string[] {
    return MERI_CAPABILITY_REGISTRY.filter((capability) => capability.readOnly).map(
      (capability) => capability.name,
    );
  }

  /** Built-in triggers are reserved too — a firm skill may never claim them. */
  private validate(input: Record<string, unknown>) {
    const validation = validateFirmSkill(input, this.allowedTools(), {
      readOnlyTools: this.readOnlyTools(),
    });
    if (!validation.ok || !validation.skill) {
      throw new BadRequestException(validation.errors.join('; ') || 'Invalid skill');
    }
    const builtInTriggers = new Set(CLIO_SKILLS.flatMap((s) => s.triggers));
    const collisions = validation.skill.triggers.filter((t) => builtInTriggers.has(t));
    if (collisions.length) {
      throw new BadRequestException(
        `trigger(s) reserved by built-in skills: ${collisions.join(', ')}`,
      );
    }
    return validation.skill;
  }

  invalidate(tenantId: string): void {
    this.cache.delete(tenantId);
  }

  // ── CRUD ─────────────────────────────────────────────────────────────────

  async list(ctx: TenantContext) {
    const rows = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioFirmSkill.findMany({
        where: { tenantId: ctx.tenantId },
        orderBy: { createdAt: 'asc' },
      }),
    );
    return rows.map((row) => ({
      id: row.id,
      skillId: row.skillId,
      name: row.name,
      skill: row.skillJson,
      version: row.version,
      versions:
        (row.versions as unknown as SkillVersionSnapshot[] | null)?.map((v) => ({
          version: v.version,
          savedAt: v.savedAt,
        })) ?? [],
      enabled: row.enabled,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async create(ctx: TenantContext, input: Record<string, unknown>) {
    const skill = this.validate(input);
    try {
      const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.clioFirmSkill.create({
          data: {
            tenantId: ctx.tenantId,
            skillId: skill.id,
            name: skill.name,
            skillJson: skill as unknown as Prisma.InputJsonValue,
            createdByUserId: ctx.userId,
            updatedByUserId: ctx.userId,
          },
        }),
      );
      await this.audit(ctx, 'clio.firm_skill.create', row.id, {
        skillId: skill.id,
        name: skill.name,
      });
      this.invalidate(ctx.tenantId);
      return row;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException(`A skill with id "${skill.id}" already exists`);
      }
      throw err;
    }
  }

  async update(ctx: TenantContext, id: string, input: Record<string, unknown>) {
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clioFirmSkill.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });
      if (!existing) throw new NotFoundException('Firm skill not found');
      const skill = this.validate({
        ...(input ?? {}),
        id: (input.id as string) ?? existing.skillId,
      });
      const history = this.pushVersion(existing);
      const result = await tx.clioFirmSkill.updateMany({
        where: { id, tenantId: ctx.tenantId, version: existing.version },
        data: {
          skillId: skill.id,
          name: skill.name,
          skillJson: skill as unknown as Prisma.InputJsonValue,
          version: existing.version + 1,
          versions: history as unknown as Prisma.InputJsonValue,
          updatedByUserId: ctx.userId,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Firm skill changed concurrently; reload and retry');
      }
      const updated = await tx.clioFirmSkill.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });
      if (!updated) {
        throw new ConflictException('Firm skill changed concurrently; reload and retry');
      }
      return updated;
    });
    await this.audit(ctx, 'clio.firm_skill.update', id, {
      skillId: row.skillId,
      version: row.version,
    });
    this.invalidate(ctx.tenantId);
    return row;
  }

  async setEnabled(ctx: TenantContext, id: string, enabled: boolean) {
    await this.findOrThrow(ctx, id);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioFirmSkill.update({ where: { id }, data: { enabled, updatedByUserId: ctx.userId } }),
    );
    await this.audit(ctx, 'clio.firm_skill.set_enabled', id, { enabled });
    this.invalidate(ctx.tenantId);
    return row;
  }

  async remove(ctx: TenantContext, id: string) {
    const existing = await this.findOrThrow(ctx, id);
    await this.prisma.withTenant(ctx.tenantId, (tx) => tx.clioFirmSkill.delete({ where: { id } }));
    await this.audit(ctx, 'clio.firm_skill.delete', id, { skillId: existing.skillId });
    this.invalidate(ctx.tenantId);
    return { deleted: true };
  }

  /** Restore a prior version (current state is pushed into history first). */
  async restore(ctx: TenantContext, id: string, version: number) {
    const row = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const existing = await tx.clioFirmSkill.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });
      if (!existing) throw new NotFoundException('Firm skill not found');
      const history = (existing.versions as unknown as SkillVersionSnapshot[] | null) ?? [];
      const snapshot = history.find((candidate) => candidate.version === version);
      if (!snapshot) throw new NotFoundException(`No stored version ${version}`);
      // Re-validate the snapshot against TODAY's rules (a tool may have been
      // removed since); restore must not resurrect an invalid skill.
      const skill = this.validate(snapshot.skillJson as unknown as Record<string, unknown>);
      const newHistory = this.pushVersion(existing);
      const result = await tx.clioFirmSkill.updateMany({
        where: { id, tenantId: ctx.tenantId, version: existing.version },
        data: {
          skillId: skill.id,
          name: skill.name,
          skillJson: skill as unknown as Prisma.InputJsonValue,
          version: existing.version + 1,
          versions: newHistory as unknown as Prisma.InputJsonValue,
          updatedByUserId: ctx.userId,
        },
      });
      if (result.count !== 1) {
        throw new ConflictException('Firm skill changed concurrently; reload and retry');
      }
      const updated = await tx.clioFirmSkill.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });
      if (!updated) {
        throw new ConflictException('Firm skill changed concurrently; reload and retry');
      }
      return updated;
    });
    await this.audit(ctx, 'clio.firm_skill.restore', id, { restoredVersion: version });
    this.invalidate(ctx.tenantId);
    return row;
  }

  /** Dry run: resolve what the skill would inject — no tools execute. */
  async testRun(ctx: TenantContext, id: string) {
    const existing = await this.findOrThrow(ctx, id);
    const skill = existing.skillJson as unknown as MeriSkill;
    return {
      skillId: skill.id,
      triggers: skill.triggers,
      systemAddendum: skill.systemAddendum,
      template: skill.template,
      requiredTools: skill.requiredTools,
      note: 'Dry run — this is the guidance/template the skill injects when a trigger fires. No tools were executed.',
    };
  }

  // ── Turn-time read (cached) ──────────────────────────────────────────────

  /** Validated, enabled skills for a tenant; safe to merge into the registry. */
  async skillsForTenant(tenantId: string): Promise<MeriSkill[]> {
    if (!this.enabled()) return [];
    const cached = this.cache.get(tenantId);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.skills;
    const rows = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioFirmSkill.findMany({ where: { tenantId, enabled: true } }),
    );
    const skills: MeriSkill[] = [];
    for (const row of rows) {
      const validation = validateFirmSkill(
        row.skillJson as unknown as Record<string, unknown>,
        this.allowedTools(),
        { readOnlyTools: this.readOnlyTools() },
      );
      if (validation.ok && validation.skill) {
        skills.push({
          ...validation.skill,
          procedureBinding: {
            source: 'firm',
            recordId: row.id,
            canonicalId: row.skillId,
            version: row.version,
          },
        });
      } else {
        this.logger.warn(
          `Skipping invalid stored firm skill [${row.skillId}]: ${validation.errors.join('; ')}`,
        );
      }
    }
    this.cache.set(tenantId, { skills, fetchedAt: Date.now() });
    return skills;
  }

  /**
   * Resolve an untrusted binding against the current tenant row. This read is
   * deliberately uncached: disable, delete/revoke, tenant mismatch, ID change,
   * or version drift must fail closed before procedure content is used.
   */
  async resolveProcedureReference(
    tenantId: string,
    binding: MeriProcedureBinding,
  ): Promise<MeriSkill> {
    if (!this.enabled() || !this.validBinding(binding)) {
      throw new NotFoundException('Procedure binding is unavailable');
    }
    const row = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clioFirmSkill.findFirst({
        where: { id: binding.recordId, tenantId, enabled: true },
      }),
    );
    if (
      !row ||
      !row.enabled ||
      row.skillId !== binding.canonicalId ||
      row.version !== binding.version
    ) {
      throw new NotFoundException('Procedure binding is unavailable');
    }
    const validation = validateFirmSkill(
      row.skillJson as unknown as Record<string, unknown>,
      this.allowedTools(),
      { readOnlyTools: this.readOnlyTools() },
    );
    if (!validation.ok || !validation.skill?.procedure || validation.skill.id !== row.skillId) {
      throw new NotFoundException('Procedure binding is unavailable');
    }
    return {
      ...validation.skill,
      procedureBinding: {
        source: 'firm',
        recordId: row.id,
        canonicalId: row.skillId,
        version: row.version,
      },
    };
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async findOrThrow(ctx: TenantContext, id: string) {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clioFirmSkill.findFirst({ where: { id, tenantId: ctx.tenantId } }),
    );
    if (!row) throw new NotFoundException('Firm skill not found');
    return row;
  }

  private validBinding(binding: MeriProcedureBinding): boolean {
    return Boolean(
      binding &&
      binding.source === 'firm' &&
      typeof binding.recordId === 'string' &&
      binding.recordId.length > 0 &&
      typeof binding.canonicalId === 'string' &&
      /^[a-z0-9_]{2,48}$/.test(binding.canonicalId) &&
      Number.isInteger(binding.version) &&
      binding.version > 0,
    );
  }

  private pushVersion(existing: {
    version: number;
    skillJson: unknown;
    versions: unknown;
  }): SkillVersionSnapshot[] {
    const history = ((existing.versions as unknown as SkillVersionSnapshot[] | null) ?? []).slice(
      0,
      VERSION_HISTORY_CAP - 1,
    );
    return [
      {
        version: existing.version,
        skillJson: existing.skillJson as unknown as MeriSkill,
        savedAt: new Date().toISOString(),
      },
      ...history,
    ];
  }

  private async audit(
    ctx: TenantContext,
    action: string,
    entityId: string,
    after: Record<string, unknown>,
  ): Promise<void> {
    await this.prisma
      .withTenant(ctx.tenantId, (tx) =>
        tx.auditLog.create({
          data: {
            tenantId: ctx.tenantId,
            actorUserId: ctx.userId,
            actorRole: ctx.role,
            action,
            entityType: 'clio_firm_skill',
            entityId,
            after: after as Prisma.InputJsonValue,
          },
        }),
      )
      .catch((err) => {
        this.logger.warn(`Firm-skill audit write failed [${action}]: ${(err as Error).message}`);
      });
  }
}
