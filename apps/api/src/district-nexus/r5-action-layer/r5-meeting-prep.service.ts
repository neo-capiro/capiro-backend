import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ownMeetingWhere } from '../../engagement/engagement-access.helpers.js';
import { R5DistrictContextService } from './r5-district-context.service.js';
import type { R5Fact } from './r5-types.js';

export interface PrepItem { text: string; factIds: string[] }
export interface DistrictPrepInput { clientId: string; state: string; district: string; meetingId: string }
export interface DistrictPrepEdit {
  agenda?: PrepItem[];
  talkingPoints?: PrepItem[];
  questions?: PrepItem[];
  followUps?: PrepItem[];
  reviewed?: boolean;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function item(text: string, factIds: string[] = []): PrepItem { return { text, factIds }; }

function factText(f: R5Fact): string {
  const value = f.value === null ? 'unknown' : String(f.value);
  return `${f.label}: ${value}${f.unit ? ` ${f.unit}` : ''} (${f.basis === 'verified_client_nexus' ? 'verified client nexus' : 'public context'}${f.amountStage ? `, ${f.amountStage}` : ''}${f.geography.scope === 'statewide' ? ', statewide' : ''})`;
}

function validItems(value: unknown): value is PrepItem[] {
  return Array.isArray(value) && value.length <= 100 && value.every((entry: unknown) =>
    typeof entry === 'object' && entry !== null && !Array.isArray(entry) &&
    'text' in entry && typeof entry.text === 'string' && entry.text.length <= 4000 &&
    'factIds' in entry && Array.isArray(entry.factIds) && entry.factIds.every((id: unknown) => typeof id === 'string'));
}

@Injectable()
export class R5MeetingPrepService {
  constructor(private readonly prisma: PrismaService, private readonly context: R5DistrictContextService) {}

  async listMeetings(ctx: TenantContext, clientId: string, from?: string, to?: string) {
    await this.contextClient(ctx.tenantId, clientId);
    const start = from ? new Date(from) : null;
    const end = to ? new Date(to) : null;
    if ((start && Number.isNaN(start.getTime())) || (end && Number.isNaN(end.getTime())) || (start && end && start > end))
      throw new BadRequestException('Invalid date range');
    const now = new Date();
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const rows = await tx.meeting.findMany({
        where: { tenantId: ctx.tenantId, clientId, ...ownMeetingWhere(ctx.userId),
          ...(start || end ? { startsAt: { ...(start ? { gte: start } : {}), ...(end ? { lte: end } : {}) } } : {}) },
        select: { id: true, subject: true, startsAt: true, attendees: { select: { name: true, email: true } } },
        orderBy: { startsAt: 'asc' }, take: 200,
      });
      return [...rows.filter((m) => m.startsAt >= now), ...rows.filter((m) => m.startsAt < now).reverse()]
        .map((m) => ({ id: m.id, subject: m.subject, startsAt: m.startsAt,
          attendees: m.attendees.map((a) => a.name || a.email).filter((s): s is string => Boolean(s)) }));
    });
  }

  private async contextClient(tenantId: string, clientId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) => tx.client.findFirst({
      where: { id: clientId, tenantId, status: { not: 'archived' } }, select: { id: true },
    }));
    if (!client) throw new NotFoundException('Client not found');
  }

  private async meeting(ctx: TenantContext, meetingId: string) {
    const meeting = await this.prisma.withTenant(ctx.tenantId, (tx) => tx.meeting.findFirst({
      where: { id: meetingId, tenantId: ctx.tenantId, ...ownMeetingWhere(ctx.userId) },
      select: { id: true, clientId: true, attendees: { select: { name: true, email: true } } },
    }));
    if (!meeting) throw new NotFoundException('Meeting not found');
    return meeting;
  }

  async generate(ctx: TenantContext, input: DistrictPrepInput) {
    if (!input.clientId?.trim() || !input.meetingId?.trim() || !/^[A-Za-z]{2}$/.test(input.state ?? '') || !/^(?:0[0-9]|[1-4][0-9]|5[0-3])$/.test(input.district ?? ''))
      throw new BadRequestException('clientId, meetingId, two-letter state and two-digit district are required');
    await this.contextClient(ctx.tenantId, input.clientId);
    const meeting = await this.meeting(ctx, input.meetingId);
    if (meeting.clientId !== input.clientId) throw new ConflictException('Meeting is not linked to this client; link it in Engagement first');
    const context = await this.context.getContext(ctx.tenantId, input.clientId, input.state.toUpperCase(), input.district);
    const fingerprint = hash({ clientId: input.clientId, state: context.state, district: context.district,
      facts: context.facts, gaps: context.gaps, sourceHealth: context.sourceHealth });
    const bySection = (section: R5Fact['section']) => context.facts.filter((f) => f.section === section);
    const fromFacts = (facts: R5Fact[]) => facts.map((f) => item(factText(f), [f.id]));
    const agenda = [item(`Review ${context.clientName} district context in ${context.state}-${context.district}`), ...fromFacts(bySection('footprint').filter((f) => f.basis === 'verified_client_nexus'))];
    const talkingPoints = fromFacts(context.facts.filter((f) => ['cpf_cds', 'economic', 'changes'].includes(f.section)));
    const questions = [
      ...bySection('opportunities').map((f) => item(`What is the relevance of ${f.label} to this client?`, [f.id])),
      ...context.gaps.map((g) => item(`How should we address missing ${g.section} context: ${g.reason}?`)),
    ];
    const followUps = fromFacts(bySection('changes'));
    const risks = context.gaps.map((g) => item(`${g.section}: ${g.reason}${g.source ? ` (${g.source})` : ''}`));
    const attendeesTargets = [
      ...meeting.attendees.map((a) => a.name || a.email).filter((s): s is string => Boolean(s)),
      ...bySection('representation').map((f) => f.label),
    ];
    const evidence = context.facts;
    const generatedFrom = { kind: 'district_nexus_r5', clientId: input.clientId, state: context.state,
      district: context.district, factIds: context.facts.map((f) => f.id), questions, attendeesTargets,
      evidence, contextGeneratedAt: context.generatedAt };
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Serialize competing requests on the meeting/district; no schema change to existing preps.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${ctx.tenantId + ':' + meeting.id + ':' + context.state + ':' + context.district}))`;
      const current = await tx.meeting.findFirst({ where: { id: meeting.id, tenantId: ctx.tenantId, clientId: input.clientId, ...ownMeetingWhere(ctx.userId) }, select: { id: true } });
      if (!current) throw new NotFoundException('Meeting not found or no longer linked to client');
      const previous = await tx.meetingPrep.findFirst({ where: { tenantId: ctx.tenantId, meetingId: meeting.id, clientId: input.clientId,
        promptHash: fingerprint, generatedFrom: { path: ['kind'], equals: 'district_nexus_r5' } }, orderBy: { createdAt: 'asc' } });
      if (previous) return previous;
      return tx.meetingPrep.create({ data: { tenantId: ctx.tenantId, meetingId: meeting.id, clientId: input.clientId,
        status: 'generated', agenda: JSON.parse(JSON.stringify(agenda)), talkingPoints: JSON.parse(JSON.stringify(talkingPoints)),
        followUps: JSON.parse(JSON.stringify(followUps)), risks: JSON.parse(JSON.stringify(risks)),
        generatedFrom: JSON.parse(JSON.stringify(generatedFrom)), promptHash: fingerprint,
        provider: null, model: null } });
    });
  }

  async get(ctx: TenantContext, id: string) {
    const prep = await this.prisma.withTenant(ctx.tenantId, (tx) => tx.meetingPrep.findFirst({
      where: { id, tenantId: ctx.tenantId, generatedFrom: { path: ['kind'], equals: 'district_nexus_r5' } },
    }));
    if (!prep) throw new NotFoundException('District meeting prep not found');
    const meeting = await this.meeting(ctx, prep.meetingId);
    if (meeting.clientId !== prep.clientId) throw new NotFoundException('Meeting no longer linked to client');
    return prep;
  }

  async edit(ctx: TenantContext, id: string, input: DistrictPrepEdit) {
    const prep = await this.get(ctx, id);
    const changed = (['agenda', 'talkingPoints', 'questions', 'followUps'] as const).filter((key) => input[key] !== undefined);
    if (!changed.length && input.reviewed !== true) throw new BadRequestException('No edits provided');
    for (const key of changed) if (!validItems(input[key])) throw new BadRequestException(`Invalid ${key}`);
    if (input.reviewed !== undefined && typeof input.reviewed !== 'boolean') throw new BadRequestException('Invalid reviewed');
    const source = prep.generatedFrom;
    if (!source || typeof source !== 'object' || Array.isArray(source)) throw new NotFoundException();
    const known = new Set(Array.isArray(source.factIds) ? source.factIds : []);
    for (const key of changed) for (const entry of input[key] ?? [])
      if (entry.factIds.some((factId) => !known.has(factId))) throw new BadRequestException('Unknown fact reference');
    const generatedFrom = { ...source, ...(input.questions !== undefined ? { questions: input.questions } : {}) };
    return this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const result = await tx.meetingPrep.updateMany({ where: { id, tenantId: ctx.tenantId,
        updatedAt: prep.updatedAt, generatedFrom: { path: ['kind'], equals: 'district_nexus_r5' } },
        data: { ...(input.agenda !== undefined ? { agenda: JSON.parse(JSON.stringify(input.agenda)) } : {}),
          ...(input.talkingPoints !== undefined ? { talkingPoints: JSON.parse(JSON.stringify(input.talkingPoints)) } : {}),
          ...(input.followUps !== undefined ? { followUps: JSON.parse(JSON.stringify(input.followUps)) } : {}),
          ...(input.questions !== undefined ? { generatedFrom: JSON.parse(JSON.stringify(generatedFrom)) } : {}),
          ...(input.reviewed ? { status: 'reviewed' as const } : {}), editedByUserId: ctx.userId } });
      if (!result.count) throw new ConflictException('Prep changed; reload before editing');
      return tx.meetingPrep.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId } });
    });
  }
}
