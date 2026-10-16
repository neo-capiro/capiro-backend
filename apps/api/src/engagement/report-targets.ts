import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { randomUUID } from 'node:crypto';
import type { DirectoryMemberContext, DirectoryService } from '../directory/directory.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';

export const reportStatusFields = ['prepStatus', 'outreachStatus', 'submissionStatus'] as const;
export type ReportStatusField = (typeof reportStatusFields)[number];
type Status = 'auto' | 'not_started' | 'in_progress' | 'complete';
const displayFields = ['memberPrincipal', 'committee', 'staffer', 'building', 'leadOwner'] as const;
type DisplayField = (typeof displayFields)[number];
type DisplayInput = Partial<Record<DisplayField, string | null>>;
export interface ReportTargetInput extends DisplayInput {
  clientId?: string | null;
  reportYear: number;
  directoryContactId?: string;
  manualOnly?: boolean;
}
export interface ReportTargetOverrideInput extends ReportTargetInput {
  officeKey: string;
  prepStatus?: Status;
  outreachStatus?: Status;
  submissionStatus?: Status;
  source?: string;
}
export interface ReportTargetLinkInput {
  targetId?: string;
  officeKey?: string;
  clientId: string;
  directoryContactId: string;
  conflictResolutions?: Record<string, 'manual' | 'existing'>;
}

export function requireReportYear(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 1900 || Number(value) > 2200) {
    throw new BadRequestException('An explicit reportYear between 1900 and 2200 is required');
  }
  return Number(value);
}

function requiredClient(value?: string | null) {
  if (!value?.trim()) throw new BadRequestException('Choose a client for this target');
  return value.trim();
}

function displayValues(input: DisplayInput): DisplayInput {
  const result: DisplayInput = {};
  for (const field of displayFields) {
    if (input[field] === undefined) continue;
    const value = input[field]?.trim() ?? null;
    const max = field === 'memberPrincipal' ? 240 : field === 'staffer' ? 160 : 120;
    if (value && value.length > max) throw new BadRequestException(`${field} is too long`);
    if (field === 'memberPrincipal' && !value) throw new BadRequestException('memberPrincipal is required');
    result[field] = value || null;
  }
  return result;
}

function directoryDefaults(context: DirectoryMemberContext): DisplayInput & { memberPrincipal: string } {
  return {
    memberPrincipal: context.fullName,
    committee: context.committees.join('; ').slice(0, 120) || null,
    staffer: context.staff.length === 1 ? context.staff[0]!.fullName.slice(0, 160) : null,
    // office is a display label; officeLocation is the canonical postal address.
    building: context.officeLocation?.slice(0, 120) ?? null,
    leadOwner: null,
  };
}

async function directoryContext(directory: DirectoryService, id: string) {
  const context = await directory.getMemberContextById(id.trim());
  if (!context) throw new NotFoundException('Directory contact not found');
  return context;
}

async function lockTargets(tx: Prisma.TransactionClient, tenantId: string) {
  // All mutations share one tenant-scoped transaction lock, including link and
  // rescope. A concurrent add cannot slip between collision checks and rekeying.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`engagement-report-targets:${tenantId}`}))`;
  // Legacy API writers lock the parent before their compatibility trigger writes
  // the annual row. Match that order during rollout, before touching overrides;
  // otherwise a restore and an old parent-status update can deadlock each other.
  await tx.$executeRaw`SELECT id FROM engagement_report_target_offices WHERE tenant_id = ${tenantId}::uuid ORDER BY id FOR UPDATE`;
}

// Plan bindings share the existing owner fence; existing writers keep their order.
export { lockTargets as lockEngagementReportTargets };

async function checkClient(tx: Prisma.TransactionClient, ctx: TenantContext, clientId: string) {
  if (!(await tx.client.findFirst({ where: { tenantId: ctx.tenantId, id: clientId }, select: { id: true } }))) {
    throw new NotFoundException('Client not found');
  }
}

const identity = (ctx: TenantContext, clientId: string, officeKey: string) => ({
  tenantId_scopeKey_officeKey: { tenantId: ctx.tenantId, scopeKey: clientId, officeKey },
});

export async function createReportTarget(
  prisma: PrismaService, directory: DirectoryService, ctx: TenantContext, input: ReportTargetInput,
) {
  const clientId = requiredClient(input.clientId);
  const reportYear = requireReportYear(input.reportYear);
  const contactId = input.directoryContactId?.trim();
  if (!contactId && input.manualOnly !== true) throw new BadRequestException('Select a Directory office or explicitly choose manual-only');
  if (contactId && input.manualOnly) throw new BadRequestException('Choose either Directory tracking or manual-only');
  const context = contactId ? await directoryContext(directory, contactId) : null;
  const fields = displayValues(input);
  const defaults = context ? directoryDefaults(context) : { memberPrincipal: '' };
  const memberPrincipal = fields.memberPrincipal ?? defaults.memberPrincipal;
  if (!memberPrincipal) throw new BadRequestException('memberPrincipal is required');
  const officeKey = context ? `directory:${context.id}` : `manual:${randomUUID()}`;
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await lockTargets(tx, ctx.tenantId);
    await checkClient(tx, ctx, clientId);
    const before = await tx.engagementReportTargetOffice.findUnique({ where: identity(ctx, clientId, officeKey) });
    if (before) {
      const conflicts = displayFields.filter((field) => fields[field] !== undefined && fields[field] !== before[field]
        && (before[field] !== null || before.displayOverrides.includes(field)));
      if (conflicts.length) throw new ConflictException({ code: 'TARGET_EXISTS', targetId: before.id,
        message: 'This office is already planned with different saved values. Edit the existing target.', fields: conflicts });
    }
    const target = await tx.engagementReportTargetOffice.upsert({
      where: identity(ctx, clientId, officeKey),
      // Adding an already planned office never overwrites its saved edits.
      update: {},
      create: {
        tenantId: ctx.tenantId, clientId, scopeKey: clientId, officeKey,
        ...defaults, ...fields, memberPrincipal, firstReportYear: reportYear,
        displayOverrides: Object.keys(fields), source: 'manual', createdByUserId: ctx.userId,
      },
    });
    if (target.archivedAt) throw new ConflictException({ code: 'TARGET_ARCHIVED', message: 'This office is archived; its history has been preserved.' });
    const enrichment: DisplayInput = {};
    for (const field of displayFields) {
      if (target[field] === null && !target.displayOverrides.includes(field)) {
        const value = fields[field] !== undefined ? fields[field] : defaults[field];
        if (value !== undefined) enrichment[field] = value;
      }
    }
    // A plan added to an earlier cycle is also a plan in later cycles. Existing
    // values (including deliberate blanks) win over any form/directory defaults.
    if (target.firstReportYear > reportYear || Object.keys(enrichment).length) {
      const updated = await tx.engagementReportTargetOffice.update({ where: { id: target.id }, data: {
        ...enrichment, memberPrincipal: target.memberPrincipal,
        firstReportYear: Math.min(target.firstReportYear, reportYear),
        displayOverrides: [...new Set([...target.displayOverrides, ...Object.keys(enrichment).filter((field) => fields[field as DisplayField] !== undefined)])],
      } });
      return { ...updated, reused: Boolean(before) };
    }
    return { ...target, reused: Boolean(before) };
  });
}

export async function upsertReportTargetOverride(
  prisma: PrismaService, directory: DirectoryService, ctx: TenantContext, input: ReportTargetOverrideInput,
) {
  const clientId = requiredClient(input.clientId);
  const reportYear = requireReportYear(input.reportYear);
  if (!/^(directory|manual):.+/.test(input.officeKey)) throw new BadRequestException('Invalid office identity');
  const context = input.officeKey.startsWith('directory:')
    ? await directoryContext(directory, input.officeKey.slice('directory:'.length)) : null;
  const officeKey = context ? `directory:${context.id}` : input.officeKey;
  const statuses: Partial<Record<ReportStatusField, Status>> = {};
  for (const field of reportStatusFields) {
    if (input[field] === undefined) continue;
    if (!['auto', 'not_started', 'in_progress', 'complete'].includes(input[field]!)) throw new BadRequestException(`Invalid ${field}`);
    statuses[field] = input[field];
  }
  if (!Object.keys(statuses).length) throw new BadRequestException('Choose a status to update');
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await lockTargets(tx, ctx.tenantId);
    await checkClient(tx, ctx, clientId);
    const existing = await tx.engagementReportTargetOffice.findUnique({ where: identity(ctx, clientId, officeKey) });
    if (existing?.archivedAt) throw new ConflictException('Archived targets cannot be edited');
    if (!existing && officeKey.startsWith('manual:')) throw new NotFoundException('Manual target not found');
    const fields = { ...(context ? directoryDefaults(context) : {}), ...displayValues(input) };
    if (!existing && !fields.memberPrincipal) throw new BadRequestException('memberPrincipal is required');
    const target = existing ?? await tx.engagementReportTargetOffice.create({
      data: {
        tenantId: ctx.tenantId, clientId, scopeKey: clientId, officeKey,
        ...fields, memberPrincipal: fields.memberPrincipal!, firstReportYear: reportYear,
        displayOverrides: [], source: 'manual_override', createdByUserId: ctx.userId,
      },
    });
    if (target.firstReportYear > reportYear) {
      await tx.engagementReportTargetOffice.update({ where: { id: target.id }, data: { firstReportYear: reportYear } });
    }
    return tx.engagementReportTargetOverride.upsert({
      where: { targetId_reportYear: { targetId: target.id, reportYear } },
      create: { tenantId: ctx.tenantId, targetId: target.id, reportYear, ...statuses },
      update: statuses,
    });
  });
}

export async function clearReportTargetOverride(
  prisma: PrismaService, ctx: TenantContext,
  input: { clientId: string; officeKey: string; reportYear: number; field: ReportStatusField },
) {
  const clientId = requiredClient(input.clientId);
  const reportYear = requireReportYear(input.reportYear);
  if (!reportStatusFields.includes(input.field)) throw new BadRequestException('Choose the status field to restore');
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await lockTargets(tx, ctx.tenantId);
    await checkClient(tx, ctx, clientId);
    const target = await tx.engagementReportTargetOffice.findUnique({ where: identity(ctx, clientId, input.officeKey) });
    if (target?.archivedAt) throw new ConflictException('Archived targets cannot be edited');
    if (target) await tx.engagementReportTargetOverride.updateMany({
      where: { tenantId: ctx.tenantId, targetId: target.id, reportYear }, data: { [input.field]: 'auto' },
    });
    return { ok: true, reportYear, field: input.field };
  });
}

export async function updateReportTarget(
  prisma: PrismaService, ctx: TenantContext, targetId: string, input: DisplayInput & { clientId?: string | null },
) {
  const fields = displayValues(input);
  const nextClientId = input.clientId === undefined ? undefined : requiredClient(input.clientId);
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await lockTargets(tx, ctx.tenantId);
    const target = await tx.engagementReportTargetOffice.findFirst({ where: { id: targetId, tenantId: ctx.tenantId } });
    if (!target) throw new NotFoundException('Target office not found');
    if (target.archivedAt) throw new ConflictException('Archived targets cannot be edited');
    const clientId = nextClientId ?? requiredClient(target.clientId);
    await checkClient(tx, ctx, clientId);
    const collision = await tx.engagementReportTargetOffice.findUnique({ where: identity(ctx, clientId, target.officeKey) });
    if (collision && collision.id !== target.id) throw new ConflictException({ code: 'TARGET_CLIENT_CONFLICT', message: 'This client already has this target. Both records were preserved.' });
    return tx.engagementReportTargetOffice.update({ where: { id: target.id }, data: {
      ...fields, memberPrincipal: fields.memberPrincipal ?? target.memberPrincipal, clientId, scopeKey: clientId,
      displayOverrides: [...new Set([...target.displayOverrides, ...Object.keys(fields)])],
    } });
  });
}

export async function archiveReportTarget(prisma: PrismaService, ctx: TenantContext, targetId: string) {
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await lockTargets(tx, ctx.tenantId);
    const target = await tx.engagementReportTargetOffice.findFirst({ where: { id: targetId, tenantId: ctx.tenantId } });
    if (!target) throw new NotFoundException('Target office not found');
    return target.archivedAt ? target : tx.engagementReportTargetOffice.update({ where: { id: target.id }, data: { archivedAt: new Date() } });
  });
}

export async function linkReportTarget(
  prisma: PrismaService, directory: DirectoryService, ctx: TenantContext, input: ReportTargetLinkInput,
) {
  const clientId = requiredClient(input.clientId);
  if (!input.targetId && !input.officeKey) throw new BadRequestException('Target identity is required');
  const context = await directoryContext(directory, input.directoryContactId);
  return prisma.withTenant(ctx.tenantId, async (tx) => {
    await lockTargets(tx, ctx.tenantId);
    await checkClient(tx, ctx, clientId);
    const manual = await tx.engagementReportTargetOffice.findFirst({
      where: { tenantId: ctx.tenantId, ...(input.targetId ? { id: input.targetId } : {
        officeKey: input.officeKey, OR: [{ clientId }, { clientId: null }],
      }) },
      include: { annualOverrides: true },
    });
    if (!manual) throw new NotFoundException('Target office not found');
    if (manual.clientId && manual.clientId !== clientId) throw new BadRequestException('The chosen client does not own this target');
    if (manual.archivedAt) throw new ConflictException('Archived targets cannot be linked');
    if (!manual.officeKey.startsWith('manual:')) throw new BadRequestException('Only manual-only targets can be linked');
    const officeKey = `directory:${context.id}`;
    const existing = await tx.engagementReportTargetOffice.findUnique({
      where: identity(ctx, clientId, officeKey), include: { annualOverrides: true },
    });
    if (existing?.archivedAt) throw new ConflictException({ code: 'TARGET_ARCHIVED', message: 'The Directory target is archived. Both records were preserved.' });
    if (!existing) return tx.engagementReportTargetOffice.update({ where: { id: manual.id }, data: { officeKey, clientId, scopeKey: clientId } });

    const conflicts: Array<{ field: string; manual: string | null; existing: string | null }> = [];
    const choose = (field: string, fromManual: string | null, fromExisting: string | null, empty: string | null,
      manualExplicit = false, existingExplicit = false) => {
      if (fromManual === fromExisting || (fromManual === empty && !manualExplicit)) return fromExisting;
      if (fromExisting === empty && !existingExplicit) return fromManual;
      const decision = input.conflictResolutions?.[field];
      if (decision !== 'manual' && decision !== 'existing') conflicts.push({ field, manual: fromManual, existing: fromExisting });
      return decision === 'manual' ? fromManual : fromExisting;
    };
    const fields: DisplayInput = {};
    for (const field of displayFields) fields[field] = choose(field, manual[field], existing[field], null,
      manual.displayOverrides.includes(field), existing.displayOverrides.includes(field));
    const years = new Set([...manual.annualOverrides, ...existing.annualOverrides].map((item) => item.reportYear));
    const overrides = [...years].map((reportYear) => {
      const left = manual.annualOverrides.find((item) => item.reportYear === reportYear);
      const right = existing.annualOverrides.find((item) => item.reportYear === reportYear);
      const statuses = Object.fromEntries(reportStatusFields.map((field) => [field, choose(`${reportYear}.${field}`, left?.[field] ?? 'auto', right?.[field] ?? 'auto', 'auto')])) as Record<ReportStatusField, string>;
      return { reportYear, ...statuses };
    });
    if (conflicts.length) throw new ConflictException({ code: 'TARGET_LINK_CONFLICT', message: 'Choose which saved values to keep before linking.', conflicts });
    await tx.engagementReportTargetOffice.update({ where: { id: existing.id }, data: {
      ...fields, memberPrincipal: fields.memberPrincipal!, source: 'manual',
      firstReportYear: Math.min(existing.firstReportYear, manual.firstReportYear),
      displayOverrides: [...new Set([...manual.displayOverrides, ...existing.displayOverrides])],
    } });
    for (const values of overrides) await tx.engagementReportTargetOverride.upsert({
      where: { targetId_reportYear: { targetId: existing.id, reportYear: values.reportYear } },
      create: { tenantId: ctx.tenantId, targetId: existing.id, ...values }, update: values,
    });
    // Only after every nonempty conflict is explicitly resolved, in this same
    // transaction, can the redundant identity and its copied overrides go away.
    await tx.engagementReportTargetOffice.delete({ where: { id: manual.id } });
    return tx.engagementReportTargetOffice.findUniqueOrThrow({ where: { id: existing.id } });
  });
}
