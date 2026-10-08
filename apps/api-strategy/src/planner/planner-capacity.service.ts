import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  PLANNER_DEFAULT_CAPACITY_PLAN,
  plannerCapacityDateShift,
  plannerCanManageAllocations,
  type PlannerCapacityRecord,
  type PlannerCapacityPlanData,
  type PlannerStaffTeamData,
  type PlannerStaffPlaceholderData,
  type PlannerCapacityAllocationData,
  type PlannerCapacityAllocation,
  type PlannerCapacityPage,
  type PlannerCapacityCatalog,
  type PlannerCapacityRole,
  type PlannerProjectData,
} from '@capiro/strategy-verifier';
import {
  Prisma,
  type SpPlannerProject,
  type SpPlannerResource,
} from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { AuthTenantContext } from '../auth/tenant-context.js';
import { plannerProjectAccess } from './planner.service.js';
import { object, keys, uuid, fail } from './planner.validation.js';
import {
  capacityRecordData,
  capacityAllocationData,
  CAPACITY_KINDS,
  type CapacityKind,
} from './planner-capacity.validation.js';
type Tx = Prisma.TransactionClient;
type State = { rows: SpPlannerResource[]; projects: SpPlannerProject[]; people: Set<string> };
const missing = () => new NotFoundException('Staffing record is unavailable');
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const data = <T>(row: SpPlannerResource) => row.data as unknown as T;
function sharingRole(row: SpPlannerResource, user: string): PlannerCapacityRole | null {
  if (row.ownerId === user) return 'admin';
  const d = data<{ privacy?: string; members?: { userId: string; role: PlannerCapacityRole }[] }>(
    row,
  );
  return (
    d.members?.find((m) => m.userId === user)?.role ?? (d.privacy === 'team' ? 'viewer' : null)
  );
}
function requireAdmin(role: PlannerCapacityRole | null) {
  if (!role) throw missing();
  if (role !== 'admin') throw new ForbiddenException('Staffing admin access is required');
}
function checkVersion(row: SpPlannerResource, expected: unknown) {
  if (!Number.isInteger(expected) || row.version !== expected)
    throw new ConflictException('Staffing changed. Refresh before saving.');
}
@Injectable()
export class PlannerCapacityService {
  constructor(private readonly prisma: PrismaService) {}
  private scope<T>(
    ctx: AuthTenantContext,
    fn: (tx: Tx, state: State) => Promise<T>,
    write = false,
  ) {
    return this.prisma.withTenant(
      ctx.tenantId,
      async (tx) => {
        if (write)
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`planner:${ctx.tenantId}`}, 0))`;
        const people = await tx.$queryRaw<
          { id: string }[]
        >`SELECT u.clerk_user_id AS id FROM users u JOIN tenant_memberships m ON m.user_id=u.id WHERE m.tenant_id=${ctx.tenantId}::uuid AND m.status='active'`;
        if (!people.some((p) => p.id === ctx.clerkUserId)) throw missing();
        const state: State = {
          people: new Set(people.map((p) => p.id)),
          projects: await tx.spPlannerProject.findMany({
            where: { tenantId: ctx.tenantId },
            orderBy: { id: 'asc' },
          }),
          rows: await tx.spPlannerResource.findMany({
            where: {
              tenantId: ctx.tenantId,
              kind: { in: [...CAPACITY_KINDS, 'portfolio', 'capacity'] },
            },
            orderBy: { id: 'asc' },
          }),
        };
        return fn(tx, state);
      },
      {
        timeoutMs: 15000,
        ...(write ? {} : { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),
      },
    );
  }
  private role(
    row: SpPlannerResource,
    s: State,
    ctx: AuthTenantContext,
  ): PlannerCapacityRole | null {
    if (!s.people.has(ctx.clerkUserId)) return null;
    if (row.kind === 'capacity_placeholder') {
      const team = s.rows.find(
        (r) =>
          r.id === data<PlannerStaffPlaceholderData>(row).teamId &&
          r.kind === 'capacity_team' &&
          !r.archived,
      );
      return team ? sharingRole(team, ctx.clerkUserId) : null;
    }
    return sharingRole(row, ctx.clerkUserId);
  }
  private project(s: State, ctx: AuthTenantContext, id: string, write = false) {
    const p = s.projects.find((p) => p.id === id && !p.archived);
    const role = p && plannerProjectAccess(p, ctx.clerkUserId);
    if (!p || !role) throw missing();
    if (write && !this.canAllocate(p, role))
      throw new ForbiddenException(
        'Project allocation permission is required (admin or allowed editor)',
      );
    return p;
  }
  private canAllocate(
    project: SpPlannerProject,
    access: NonNullable<ReturnType<typeof plannerProjectAccess>>,
  ) {
    return plannerCanManageAllocations({
      access,
      allocationEditors: (project.data as unknown as PlannerProjectData).allocationEditors,
    });
  }
  private view<T>(
    row: SpPlannerResource,
    s: State,
    ctx: AuthTenantContext,
  ): PlannerCapacityRecord<T> {
    const access = this.role(row, s, ctx);
    if (!access) throw missing();
    const d = structuredClone(row.data) as Record<string, unknown>;
    if (row.kind === 'capacity_plan') {
      d.projectIds = (d.projectIds as string[]).filter((id) =>
        s.projects.some(
          (p) => p.id === id && !p.archived && plannerProjectAccess(p, ctx.clerkUserId),
        ),
      );
      d.portfolioIds = (d.portfolioIds as string[]).filter((id) =>
        s.rows.some(
          (r) =>
            r.id === id && r.kind === 'portfolio' && !r.archived && this.portfolioRole(r, s, ctx),
        ),
      );
      d.teamIds = (d.teamIds as string[]).filter((id) =>
        s.rows.some(
          (r) => r.id === id && r.kind === 'capacity_team' && !r.archived && this.role(r, s, ctx),
        ),
      );
      d.views = (d.views as PlannerCapacityPlanData['views']).map((v) => ({
        ...v,
        projectId:
          v.projectId &&
          !s.projects.some(
            (p) => p.id === v.projectId && !p.archived && plannerProjectAccess(p, ctx.clerkUserId),
          )
            ? ''
            : v.projectId,
        personId:
          v.personId &&
          !s.people.has(v.personId) &&
          !s.rows.some(
            (r) =>
              r.id === v.personId &&
              r.kind === 'capacity_placeholder' &&
              !r.archived &&
              this.role(r, s, ctx),
          )
            ? ''
            : v.personId,
      }));
    }
    if (Array.isArray(d.peopleIds))
      d.peopleIds = d.peopleIds.filter((id) => s.people.has(String(id)));
    if (Array.isArray(d.members))
      d.members = (d.members as { userId: string }[]).filter((m) => s.people.has(m.userId));
    if (row.kind === 'capacity_team')
      d.jobTitles = Object.fromEntries(
        Object.entries(d.jobTitles as Record<string, string>).filter(([id]) => s.people.has(id)),
      );
    return {
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      version: row.version,
      archived: row.archived,
      access,
      data: d as T,
    };
  }
  private portfolioRole(row: SpPlannerResource, s: State, ctx: AuthTenantContext) {
    if (row.projectId)
      return s.projects.some(
        (p) => p.id === row.projectId && !p.archived && plannerProjectAccess(p, ctx.clerkUserId),
      );
    const d = data<{ privacy?: string; members?: { userId: string; role: string }[] }>(row);
    return (
      row.ownerId === ctx.clerkUserId ||
      d.members?.some((m) => m.userId === ctx.clerkUserId) ||
      d.privacy === 'team'
    );
  }
  async catalog(ctx: AuthTenantContext): Promise<PlannerCapacityCatalog> {
    return this.scope(ctx, async (_tx, s) => ({
      plans: s.rows
        .filter((r) => r.kind === 'capacity_plan' && this.role(r, s, ctx))
        .map((r) => this.view<PlannerCapacityPlanData>(r, s, ctx)),
      teams: s.rows
        .filter((r) => r.kind === 'capacity_team' && this.role(r, s, ctx))
        .map((r) => this.view<PlannerStaffTeamData>(r, s, ctx)),
      placeholders: s.rows
        .filter((r) => r.kind === 'capacity_placeholder' && this.role(r, s, ctx))
        .map((r) => this.view<PlannerStaffPlaceholderData>(r, s, ctx)),
    }));
  }
  async saveRecord(ctx: AuthTenantContext, kind: CapacityKind, raw: unknown) {
    if (kind === 'capacity_allocation' || !CAPACITY_KINDS.includes(kind))
      fail('Invalid staffing record');
    const dto = object(raw);
    keys(dto, ['id', 'version', 'name', 'data', 'archived']);
    const id = uuid(dto.id);
    if (typeof dto.name !== 'string' || !dto.name.trim() || dto.name.length > 500)
      fail('Staffing name is required');
    if (dto.archived !== undefined && typeof dto.archived !== 'boolean')
      fail('Invalid staffing archive flag');
    return this.scope(
      ctx,
      async (tx, s) => {
        const old = s.rows.find((r) => r.id === id);
        if (old) {
          if (old.kind !== kind) throw missing();
          requireAdmin(this.role(old, s, ctx));
          checkVersion(old, dto.version);
        } else if (dto.version !== undefined)
          throw new ConflictException('Staffing record no longer exists');
        const d = capacityRecordData(kind, dto.data) as PlannerCapacityPlanData &
          PlannerStaffTeamData &
          PlannerStaffPlaceholderData;
        for (const member of d.members ?? [])
          if (!s.people.has(member.userId))
            fail('Staffing members must be active organization members');
        for (const user of d.peopleIds ?? [])
          if (!s.people.has(user)) fail('Staffing people must be active organization members');
        if (kind === 'capacity_plan') {
          const before = old ? data<PlannerCapacityPlanData>(old) : PLANNER_DEFAULT_CAPACITY_PLAN;
          // Redacted references survive edits by an admin who no longer has source access.
          for (const key of ['projectIds', 'portfolioIds', 'teamIds'] as const) {
            const allowed = (ref: string) =>
              key === 'projectIds'
                ? s.projects.some(
                    (p) => p.id === ref && !p.archived && plannerProjectAccess(p, ctx.clerkUserId),
                  )
                : s.rows.some(
                    (r) =>
                      r.id === ref &&
                      r.kind === (key === 'portfolioIds' ? 'portfolio' : 'capacity_team') &&
                      !r.archived &&
                      (key === 'portfolioIds'
                        ? this.portfolioRole(r, s, ctx)
                        : this.role(r, s, ctx)),
                  );
            if (d[key].some((ref) => !allowed(ref))) throw missing();
            d[key] = [...new Set([...d[key], ...before[key].filter((ref) => !allowed(ref))])];
          }
          for (const v of d.views) {
            if (v.projectId) this.project(s, ctx, v.projectId);
            if (
              v.personId &&
              !s.people.has(v.personId) &&
              !s.rows.some(
                (r) =>
                  r.id === v.personId &&
                  r.kind === 'capacity_placeholder' &&
                  !r.archived &&
                  this.role(r, s, ctx),
              )
            )
              throw missing();
          }
        }
        if (kind === 'capacity_placeholder') {
          const team = s.rows.find(
            (r) => r.id === d.teamId && r.kind === 'capacity_team' && !r.archived,
          );
          if (!team) throw missing();
          requireAdmin(this.role(team, s, ctx));
          if (old && data<PlannerStaffPlaceholderData>(old).teamId !== d.teamId)
            fail('A placeholder remains in its original team');
        }
        const row = old
          ? await tx.spPlannerResource.update({
              where: { tenantId: ctx.tenantId, id },
              data: {
                name: (dto.name as string).trim(),
                data: json(d),
                version: { increment: 1 },
                ...(dto.archived === undefined ? {} : { archived: dto.archived as boolean }),
              },
            })
          : await tx.spPlannerResource.create({
              data: {
                id,
                tenantId: ctx.tenantId,
                ownerId: ctx.clerkUserId,
                kind,
                name: (dto.name as string).trim(),
                data: json(d),
              },
            });
        s.rows = [...s.rows.filter((r) => r.id !== row.id), row];
        return this.view(row, s, ctx);
      },
      true,
    );
  }
  private selected(plan: SpPlannerResource, s: State, ctx: AuthTenantContext) {
    const d = this.view<PlannerCapacityPlanData>(plan, s, ctx).data;
    const projectIds = new Set(d.projectIds),
      personIds = new Set(d.peopleIds);
    for (const id of d.portfolioIds) {
      const portfolio = s.rows.find((r) => r.id === id)!;
      for (const p of data<{ projectIds: string[] }>(portfolio).projectIds)
        if (
          s.projects.some(
            (project) =>
              project.id === p &&
              !project.archived &&
              plannerProjectAccess(project, ctx.clerkUserId),
          )
        )
          projectIds.add(p);
    }
    for (const id of d.teamIds) {
      const team = s.rows.find((r) => r.id === id)!;
      for (const p of data<PlannerStaffTeamData>(team).peopleIds)
        if (s.people.has(p)) personIds.add(p);
      for (const p of s.rows)
        if (
          p.kind === 'capacity_placeholder' &&
          !p.archived &&
          data<PlannerStaffPlaceholderData>(p).teamId === id &&
          this.role(p, s, ctx)
        )
          personIds.add(p.id);
    }
    return { projectIds, personIds };
  }
  private allocation(
    row: SpPlannerResource,
    s: State,
    ctx: AuthTenantContext,
  ): PlannerCapacityAllocation | null {
    if (!row.projectId) return null;
    const project = s.projects.find((p) => p.id === row.projectId && !p.archived),
      role = project && plannerProjectAccess(project, ctx.clerkUserId);
    if (!project || !role) return null;
    const d = data<PlannerCapacityAllocationData>(row);
    const placeholder = d.placeholderId
      ? s.rows.find(
          (r) =>
            r.id === d.placeholderId && r.kind === 'capacity_placeholder' && this.role(r, s, ctx),
        )
      : null;
    if (d.userId ? !s.people.has(d.userId) : !placeholder) return null;
    const pd = placeholder ? data<PlannerStaffPlaceholderData>(placeholder) : null;
    const team = s.rows.find(
      (r) =>
        r.kind === 'capacity_team' &&
        !r.archived &&
        this.role(r, s, ctx) &&
        (pd ? r.id === pd.teamId : data<PlannerStaffTeamData>(r).peopleIds.includes(d.userId!)),
    );
    const cap = d.userId
      ? s.rows.find(
          (r) =>
            r.kind === 'capacity' && !r.archived && data<{ userId: string }>(r).userId === d.userId,
        )
      : null;
    return {
      id: row.id,
      name: row.name,
      ownerId: row.ownerId,
      version: row.version,
      archived: row.archived,
      access: this.canAllocate(project, role) ? 'admin' : 'viewer',
      data: d,
      projectId: row.projectId,
      projectName: data<{ name: string }>(project as unknown as SpPlannerResource).name,
      personName: placeholder?.name ?? d.userId!,
      weeklyMinutes:
        pd?.weeklyMinutes ?? (cap ? data<{ weeklyMinutes: number }>(cap).weeklyMinutes : 2400),
      teamId: team?.id ?? null,
      jobTitle:
        pd?.jobTitle ?? (team ? (data<PlannerStaffTeamData>(team).jobTitles[d.userId!] ?? '') : ''),
    };
  }
  async plan(
    ctx: AuthTenantContext,
    id: string,
    query: Record<string, string> = {},
  ): Promise<PlannerCapacityPage> {
    uuid(id);
    keys(query, ['cursor', 'revision', 'archived']);
    if (query.cursor) uuid(query.cursor);
    if (query.cursor && !query.revision) fail('Capacity paging requires its revision');
    if (query.revision && !/^[a-f0-9]{64}$/.test(query.revision)) fail('Invalid capacity revision');
    if (query.archived !== undefined && !['true', 'false'].includes(query.archived))
      fail('Invalid capacity archive filter');
    return this.scope(ctx, async (_tx, s) => {
      const row = s.rows.find((r) => r.id === id && r.kind === 'capacity_plan');
      if (!row) throw missing();
      const plan = this.view<PlannerCapacityPlanData>(row, s, ctx),
        selected = this.selected(row, s, ctx);
      const allocations = s.rows
        .filter(
          (r) => r.kind === 'capacity_allocation' && r.archived === (query.archived === 'true'),
        )
        .map((r) => this.allocation(r, s, ctx))
        .filter(
          (a): a is PlannerCapacityAllocation =>
            !!a &&
            (selected.projectIds.has(a.projectId) ||
              selected.personIds.has(a.data.userId ?? a.data.placeholderId!)),
        );
      const projectIds = [
          ...new Set([...selected.projectIds, ...allocations.map((a) => a.projectId)]),
        ].sort(),
        personIds = [
          ...new Set([
            ...selected.personIds,
            ...allocations.map((a) => a.data.userId ?? a.data.placeholderId!),
          ]),
        ].sort();
      const revision = createHash('sha256')
        .update(
          JSON.stringify([
            ctx.clerkUserId,
            plan,
            projectIds,
            personIds,
            allocations,
            query.archived === 'true',
          ]),
        )
        .digest('hex');
      if (query.revision && query.revision !== revision)
        throw new ConflictException('Capacity or access changed. Refresh the plan.');
      const start = query.cursor ? allocations.findIndex((a) => a.id === query.cursor) + 1 : 0;
      if (query.cursor && !start) fail('Invalid capacity cursor');
      const page = allocations.slice(start, start + 100);
      return {
        plan,
        projectIds,
        personIds,
        revision,
        matched: allocations.length,
        allocations: page,
        nextCursor: start + page.length < allocations.length ? page.at(-1)!.id : null,
      };
    });
  }
  async saveAllocations(ctx: AuthTenantContext, raw: unknown) {
    const dto = object(raw);
    keys(dto, ['planId', 'planVersion', 'changes']);
    const planId = uuid(dto.planId);
    if (!Array.isArray(dto.changes) || !dto.changes.length || dto.changes.length > 100)
      fail('Change between 1 and 100 allocations');
    return this.scope(
      ctx,
      async (tx, s) => {
        const plan = s.rows.find(
          (r) => r.id === planId && r.kind === 'capacity_plan' && !r.archived,
        );
        if (!plan) throw missing();
        requireAdmin(this.role(plan, s, ctx));
        checkVersion(plan, dto.planVersion);
        const selected = this.selected(plan, s, ctx),
          used = new Set<string>();
        const changes = (dto.changes as unknown[]).map((raw) => {
          const c = object(raw);
          keys(c, ['id', 'version', 'duplicateId', 'projectId', 'data', 'shiftDays', 'archived']);
          const id = uuid(c.id);
          if (used.has(id)) fail('Duplicate allocation change');
          used.add(id);
          const old = s.rows.find((r) => r.id === id);
          if (old) {
            if (old.kind !== 'capacity_allocation') throw missing();
            const a = this.allocation(old, s, ctx);
            if (
              !a ||
              !(
                selected.projectIds.has(a.projectId) ||
                selected.personIds.has(a.data.userId ?? a.data.placeholderId!)
              )
            )
              throw missing();
            this.project(s, ctx, a.projectId, true);
            checkVersion(old, c.version);
          } else if (c.version !== undefined || c.duplicateId !== undefined) throw missing();
          if (c.archived !== undefined && typeof c.archived !== 'boolean')
            fail('Invalid allocation archive flag');
          const projectId = uuid(c.projectId ?? old?.projectId);
          this.project(s, ctx, projectId, true);
          const merged = {
            ...(old ? data<PlannerCapacityAllocationData>(old) : {}),
            ...(c.data === undefined ? {} : object(c.data)),
          } as PlannerCapacityAllocationData;
          if (c.shiftDays !== undefined) {
            if (!Number.isInteger(c.shiftDays) || Math.abs(Number(c.shiftDays)) > 3660)
              fail('Invalid allocation movement');
            try {
              merged.startOn = plannerCapacityDateShift(merged.startOn, Number(c.shiftDays));
              merged.endOn = plannerCapacityDateShift(merged.endOn, Number(c.shiftDays));
            } catch {
              fail('Invalid allocation movement');
            }
          }
          const d = capacityAllocationData(merged);
          if (d.userId && !s.people.has(d.userId)) fail('Choose an active organization member');
          if (
            d.placeholderId &&
            !s.rows.some(
              (r) =>
                r.id === d.placeholderId &&
                r.kind === 'capacity_placeholder' &&
                !r.archived &&
                this.role(r, s, ctx),
            )
          )
            throw missing();
          if (!(
            selected.projectIds.has(projectId) ||
            selected.personIds.has(d.userId ?? d.placeholderId!)
          ))
            fail('Add the project, person or team to this capacity plan first');
          const target = c.duplicateId === undefined ? id : uuid(c.duplicateId);
          if (c.duplicateId === id) fail('A duplicate needs a new allocation id');
          if (target !== id) {
            if (used.has(target) || s.rows.some((r) => r.id === target))
              throw new ConflictException('The duplicate allocation already exists');
            used.add(target);
          }
          return {
            old: target === id ? old : undefined,
            id: target,
            projectId,
            data: d,
            archived: c.archived as boolean | undefined,
          };
        });
        // Every source, destination and version has passed before the first write. The tenant lock
        // also serializes source grant changes, and the transaction makes a bulk change atomic.
        const rows: SpPlannerResource[] = [];
        for (const c of changes)
          rows.push(
            c.old
              ? await tx.spPlannerResource.update({
                  where: { tenantId: ctx.tenantId, id: c.id },
                  data: {
                    projectId: c.projectId,
                    data: json(c.data),
                    version: { increment: 1 },
                    ...(c.archived === undefined ? {} : { archived: c.archived }),
                  },
                })
              : await tx.spPlannerResource.create({
                  data: {
                    id: c.id,
                    tenantId: ctx.tenantId,
                    ownerId: ctx.clerkUserId,
                    kind: 'capacity_allocation',
                    name: 'Project allocation',
                    projectId: c.projectId,
                    data: json(c.data),
                    archived: c.archived ?? false,
                  },
                }),
          );
        return { allocations: rows.map((r) => this.allocation(r, s, ctx)!) };
      },
      true,
    );
  }
}
