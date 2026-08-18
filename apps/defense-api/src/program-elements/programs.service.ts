import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DefenseTenantContext, normalizeLimit, normalizePage } from './program-elements.shared.js';

export type ProgramMatchDecision = 'accept' | 'reject' | 'quarantine';

/**
 * Programs search/detail/admin service. Program/ProgramAlias/PeProgramMatch
 * are global reference data (no tenant_id / RLS) in the frozen contract, same
 * as apps/api's programs.service. Admin mutations write AuditLog inside a
 * tenant-scoped transaction, mirroring the reconciliation-queue pattern.
 */
@Injectable()
export class ProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  async searchPrograms(q: string | undefined, limitRaw?: number) {
    const limit = normalizeLimit(limitRaw);
    const query = (q ?? '').trim();
    if (!query) {
      const rows = await this.prisma.program.findMany({
        orderBy: { canonicalName: 'asc' },
        take: limit,
        select: { id: true, canonicalName: true, mdapCode: true, status: true },
      });
      return { data: rows, total: rows.length, q: '' };
    }

    const norm = query.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
    type Row = { id: string; canonicalName: string; mdapCode: string | null; status: string; bestAlias: string; sim: number };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT p.id,
             p.canonical_name AS "canonicalName",
             p.mdap_code AS "mdapCode",
             p.status,
             a.alias AS "bestAlias",
             MAX(similarity(a.alias_normalized, ${norm})) AS "sim"
      FROM program p
      JOIN program_alias a ON a.program_id = p.id
      WHERE a.alias_normalized % ${norm}
      GROUP BY p.id, p.canonical_name, p.mdap_code, p.status, a.alias
      ORDER BY "sim" DESC, p.canonical_name ASC
      LIMIT ${limit}
    `);
    const byProgram = new Map<string, Row>();
    for (const r of rows) {
      const prev = byProgram.get(r.id);
      if (!prev || r.sim > prev.sim) byProgram.set(r.id, r);
    }
    const data = [...byProgram.values()].sort((x, y) => y.sim - x.sim);
    return { data, total: data.length, q: query };
  }

  async getProgram(id: string) {
    const program = await this.prisma.program.findUnique({ where: { id } });
    if (!program) throw new NotFoundException(`Program ${id} not found`);
    const [aliases, matches] = await Promise.all([
      this.prisma.programAlias.findMany({ where: { programId: id }, orderBy: { createdAt: 'asc' } }),
      this.prisma.peProgramMatch.findMany({ where: { programId: id, status: { in: ['accepted', 'candidate'] } } }),
    ]);
    return {
      ...program,
      aliases,
      acceptedMatches: matches.filter((m) => m.status === 'accepted'),
      candidateMatches: matches.filter((m) => m.status === 'candidate'),
    };
  }

  async listMatchQueue(statusRaw: string | undefined, pageRaw?: number, limitRaw?: number) {
    const page = normalizePage(pageRaw);
    const limit = normalizeLimit(limitRaw, 200);
    const status = statusRaw?.trim() || 'candidate';
    const where: Prisma.PeProgramMatchWhereInput = status === 'all' ? {} : { status };
    const [rows, total] = await Promise.all([
      this.prisma.peProgramMatch.findMany({ where, orderBy: { score: 'desc' }, skip: (page - 1) * limit, take: limit }),
      this.prisma.peProgramMatch.count({ where }),
    ]);
    return { data: rows, total, page, limit };
  }

  async resolveMatch(id: string, input: { decision: ProgramMatchDecision; notes?: string }, ctx: DefenseTenantContext) {
    const match = await this.prisma.peProgramMatch.findUnique({ where: { id } });
    if (!match) throw new NotFoundException(`Program match ${id} not found`);
    if (match.status !== 'candidate') {
      throw new BadRequestException(`Program match ${id} is already ${match.status}`);
    }
    const nextStatus = input.decision === 'accept' ? 'accepted' : input.decision === 'reject' ? 'rejected' : 'quarantined';

    await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.peProgramMatch.update({ where: { id }, data: { status: nextStatus, resolvedByUserId: ctx.userId, resolvedAt: new Date() } });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'programs.match.resolve',
          entityType: 'pe_program_match',
          entityId: id,
          before: { status: match.status },
          after: { status: nextStatus, decision: input.decision, notes: input.notes ?? null },
        },
      });
    });
    return { id, status: nextStatus, decision: input.decision };
  }

  async listAliases(programId: string) {
    const rows = await this.prisma.programAlias.findMany({ where: { programId }, orderBy: { createdAt: 'asc' } });
    return { data: rows };
  }

  async createAlias(programId: string, input: { alias: string; aliasType: string; source?: string }, ctx: DefenseTenantContext) {
    const program = await this.prisma.program.findUnique({ where: { id: programId }, select: { id: true } });
    if (!program) throw new NotFoundException(`Program ${programId} not found`);
    const aliasNormalized = input.alias.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();

    const row = await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      const created = await tx.programAlias.create({
        data: {
          programId,
          alias: input.alias,
          aliasNormalized,
          aliasType: input.aliasType,
          source: input.source ?? 'manual',
          confidence: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'programs.alias.create',
          entityType: 'program_alias',
          entityId: created.id,
          after: { programId, alias: input.alias, aliasType: input.aliasType },
        },
      });
      return created;
    });
    return row;
  }

  async updateAlias(id: string, input: { alias?: string; aliasType?: string }, ctx: DefenseTenantContext) {
    const existing = await this.prisma.programAlias.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Program alias ${id} not found`);
    const data: Prisma.ProgramAliasUpdateInput = { updatedAt: new Date() };
    if (input.alias !== undefined) {
      data.alias = input.alias;
      data.aliasNormalized = input.alias.toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
    }
    if (input.aliasType !== undefined) data.aliasType = input.aliasType;

    const row = await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      const updated = await tx.programAlias.update({ where: { id }, data });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'programs.alias.update',
          entityType: 'program_alias',
          entityId: id,
          before: { alias: existing.alias, aliasType: existing.aliasType },
          after: { alias: updated.alias, aliasType: updated.aliasType },
        },
      });
      return updated;
    });
    return row;
  }

  async deleteAlias(id: string, ctx: DefenseTenantContext) {
    const existing = await this.prisma.programAlias.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Program alias ${id} not found`);

    await this.prisma.withTenantActor(ctx.tenantId, ctx.userId, async (tx) => {
      await tx.programAlias.delete({ where: { id } });
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'programs.alias.delete',
          entityType: 'program_alias',
          entityId: id,
          before: { alias: existing.alias, aliasType: existing.aliasType },
        },
      });
    });
    return { deleted: true, id };
  }

  async listDuplicateAliases() {
    type Row = { aliasNormalized: string; programIds: string[]; count: number };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT alias_normalized AS "aliasNormalized",
             array_agg(DISTINCT program_id::text) AS "programIds",
             COUNT(DISTINCT program_id) AS count
      FROM program_alias
      GROUP BY alias_normalized
      HAVING COUNT(DISTINCT program_id) > 1
      ORDER BY count DESC
      LIMIT 100
    `);
    return { data: rows };
  }

  async mergePrograms(input: { keepProgramId: string; mergeProgramId: string }, ctx: DefenseTenantContext) {
    if (input.keepProgramId === input.mergeProgramId) {
      throw new BadRequestException('keepProgramId and mergeProgramId must differ');
    }
    const [keep, merge] = await Promise.all([
      this.prisma.program.findUnique({ where: { id: input.keepProgramId } }),
      this.prisma.program.findUnique({ where: { id: input.mergeProgramId } }),
    ]);
    if (!keep) throw new NotFoundException(`Program ${input.keepProgramId} not found`);
    if (!merge) throw new NotFoundException(`Program ${input.mergeProgramId} not found`);

    const result = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.current_tenant', ${ctx.tenantId}, true)`;
      await tx.$executeRaw`SELECT set_config('app.current_user', ${ctx.userId}, true)`;

      // Repoint aliases one at a time, deduping against the keeper's existing
      // (aliasNormalized, aliasType) set. A bulk updateMany would throw on the
      // real DB unique constraint (program_alias_program_norm_type_key) the
      // instant the keeper and loser share one alias, aborting the whole merge.
      const [keeperAliases, loserAliases] = await Promise.all([
        tx.programAlias.findMany({ where: { programId: input.keepProgramId }, select: { aliasNormalized: true, aliasType: true } }),
        tx.programAlias.findMany({ where: { programId: input.mergeProgramId } }),
      ]);
      const aliasKeys = new Set(keeperAliases.map((a) => `${a.aliasNormalized}|${a.aliasType}`));
      let aliasesCopied = 0;
      let aliasesDropped = 0;
      for (const alias of loserAliases) {
        const key = `${alias.aliasNormalized}|${alias.aliasType}`;
        if (aliasKeys.has(key)) {
          await tx.programAlias.delete({ where: { id: alias.id } });
          aliasesDropped += 1;
          continue;
        }
        await tx.programAlias.update({ where: { id: alias.id }, data: { programId: input.keepProgramId } });
        aliasKeys.add(key);
        aliasesCopied += 1;
      }

      // Same dedup discipline for PE/project matches, so the merge never
      // leaves two active matches for the same (peCode, projectCode) pointing
      // at the now-shared program.
      const [keeperMatches, loserMatches] = await Promise.all([
        tx.peProgramMatch.findMany({ where: { programId: input.keepProgramId }, select: { peCode: true, projectCode: true } }),
        tx.peProgramMatch.findMany({ where: { programId: input.mergeProgramId } }),
      ]);
      const matchKeys = new Set(keeperMatches.map((m) => `${m.peCode}|${m.projectCode ?? ''}`));
      let matchesRepointed = 0;
      let matchesDropped = 0;
      for (const match of loserMatches) {
        const key = `${match.peCode}|${match.projectCode ?? ''}`;
        if (matchKeys.has(key)) {
          await tx.peProgramMatch.delete({ where: { id: match.id } });
          matchesDropped += 1;
          continue;
        }
        await tx.peProgramMatch.update({ where: { id: match.id }, data: { programId: input.keepProgramId } });
        matchKeys.add(key);
        matchesRepointed += 1;
      }

      // Retire the loser instead of deleting it. A hard delete is permanent
      // data loss and risks leaving dangling references from any row this
      // schema doesn't model on the shared physical database; retiring
      // preserves the historical record, matching apps/api's merge semantics.
      const mergeMetadata = merge.metadata && typeof merge.metadata === 'object' ? (merge.metadata as Record<string, unknown>) : {};
      await tx.program.update({
        where: { id: input.mergeProgramId },
        data: {
          status: 'merged',
          metadata: { ...mergeMetadata, mergedInto: input.keepProgramId, mergedAt: new Date().toISOString() },
          updatedAt: new Date(),
        },
      });

      const repointed = { aliasesCopied, aliasesDropped, matchesRepointed, matchesDropped };
      await tx.auditLog.create({
        data: {
          tenantId: ctx.tenantId,
          actorUserId: ctx.userId,
          actorRole: ctx.role,
          action: 'programs.merge',
          entityType: 'program',
          entityId: input.keepProgramId,
          before: { mergedProgramId: input.mergeProgramId },
          after: { keepProgramId: input.keepProgramId, repointed },
        },
      });
      return { keepProgramId: input.keepProgramId, mergedProgramId: input.mergeProgramId, repointed };
    });
    return result;
  }
}
