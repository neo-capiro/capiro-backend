import { createHash } from 'node:crypto';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { TenantContext } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ActionRecommendationReadService, type ActionCard } from '../../intelligence/actions/action-recommendation-read.service.js';
import type { ActionStatus, ActionType, AudienceMember, ConfidenceBands, EvidenceRef } from '../../intelligence/actions/action-recommendation.types.js';
import { R5DistrictContextService } from './r5-district-context.service.js';
import type { R5DistrictContext, R5Fact } from './r5-types.js';

export interface DistrictCandidate {
  key: string;
  actionType: ActionType;
  issueTitle: string;
  whatChanged: string;
  whyItMatters: string;
  recommendedAction: string;
  targetAudience: AudienceMember[];
  suggestedArtifactType: string;
  ownerUserId: string;
  priority: number;
  confidence: ConfidenceBands;
  uncertainty: string | null;
  evidence: EvidenceRef[];
  facts: R5Fact[];
}
export type ActionText = Pick<DistrictCandidate, 'issueTitle' | 'whatChanged' | 'whyItMatters' | 'recommendedAction'>;

const textFields: (keyof ActionText)[] = ['issueTitle', 'whatChanged', 'whyItMatters', 'recommendedAction'];
function checkedText(input: Partial<ActionText>): Partial<ActionText> {
  const result: Partial<ActionText> = {};
  for (const field of textFields) {
    if (input[field] === undefined) continue;
    if (typeof input[field] !== 'string' || !input[field]?.trim() || input[field]!.length > 5000)
      throw new BadRequestException(`${field} must be nonempty text (max 5000 characters)`);
    result[field] = input[field]!.trim();
  }
  return result;
}
function factHash(facts: R5Fact[]): string {
  return createHash('sha256').update(JSON.stringify([...new Set(facts.map((f) => f.id))].sort())).digest('hex');
}
export function rankDistrictActions(context: R5DistrictContext, ownerUserId: string): DistrictCandidate[] {
  const facts = [...context.facts].sort((a, b) => a.id.localeCompare(b.id));
  const reps = facts.filter((f) => f.section === 'representation' && f.source.recordId);
  const target: AudienceMember[] = reps.map((f) => ({ kind: 'office', id: f.source.recordId!, label: f.label, outreachEligible: false }));
  const candidates: DistrictCandidate[] = [];
  const add = (actionType: ActionType, title: string, next: string, artifact: string, selected: R5Fact[], priority: number, gaps: string[] = []) => {
    if (!selected.length && !gaps.length) return;
    const uncertain = [...gaps,
      ...(selected.some((f) => f.coverage === 'partial') ? ['Partial source coverage'] : []),
      ...(selected.some((f) => f.freshness.stale || f.freshness.unavailable) ? ['Source freshness is stale or unavailable'] : []),
    ];
    const confidence = uncertain.length ? 'low' : selected.some((f) => f.basis === 'verified_client_nexus') ? 'high' : 'medium';
    const sorted = [...selected].sort((a, b) => a.id.localeCompare(b.id));
    candidates.push({ key: `${actionType}:${factHash(sorted)}`, actionType, issueTitle: title,
      whatChanged: sorted.map((f) => `${f.label} (${f.basis === 'verified_client_nexus' ? 'verified client nexus' : 'public context'}; ${f.amountStage ?? 'no amount stage'}; ${f.geography.scope})`).join('; ') || gaps.join('; '),
      whyItMatters: `Review ${title.toLowerCase()} for ${context.clientName} in ${context.state}-${context.district}; no outcome is implied.`,
      recommendedAction: next, targetAudience: target, suggestedArtifactType: artifact, ownerUserId,
      priority, confidence: { clientRelevance: confidence }, uncertainty: uncertain.join('; ') || null,
      evidence: [{ kind: 'source', note: `r5-fact-set:${factHash(sorted)}` }, ...sorted.map((f) => ({ kind: 'source' as const, sourceDocumentId: f.source.recordId ?? undefined, note: `${f.id} · ${f.source.label} · ${f.source.url ?? 'no URL'}` }))], facts: sorted });
  };
  const identity = context.gaps.filter((g) => /identit|uei|match/i.test(g.reason)).map((g) => g.reason).sort();
  if (identity.length) add('escalate_uncertainty', 'Confirm client identity before attribution', 'Verify client identifiers and source matching before using district claims.', 'internal_brief', [], 100, identity);
  add('district_one_pager', 'Prepare district evidence brief', 'Review district facts and draft a one-page summary for human approval.', 'member_one_pager', facts.filter((f) => f.basis === 'verified_client_nexus' && f.geography.scope === 'district').slice(0, 5), 80);
  add('monitor_procurement', 'Monitor public opportunities', 'Review opportunity qualification and monitor updates; no award is implied.', 'procurement_watch_note', facts.filter((f) => f.section === 'opportunities').slice(0, 5), 70);
  add('client_alert', 'Review district changes', 'Review source changes before proposing a client update.', 'internal_brief', facts.filter((f) => f.section === 'changes').slice(0, 5), 60);
  if (reps.length) add('schedule_outreach', 'Consider office outreach', 'Review the source-backed office and seek approval before any outreach.', 'talking_points', reps.slice(0, 5), 50);
  return candidates.slice(0, 5);
}

@Injectable()
export class R5DistrictActionsService {
  constructor(private readonly prisma: PrismaService, private readonly context: R5DistrictContextService,
    private readonly actions: ActionRecommendationReadService) {}

  private async load(ctx: TenantContext, clientId: string, state: string, district: string) {
    if (!/^[A-Z]{2}$/.test(state) || !/^\d{2}$/.test(district)) throw new BadRequestException('Invalid state or district');
    return this.context.getContext(ctx.tenantId, clientId, state, district);
  }
  async list(ctx: TenantContext, clientId: string, state: string, district: string) {
    const context = await this.load(ctx, clientId, state, district);
    const staged = await this.prisma.withTenant(ctx.tenantId, (tx) => tx.actionRecommendation.findMany({
      where: { tenantId: ctx.tenantId, clientId, districtKey: `${state}-${district}` },
      select: { id: true }, orderBy: { createdAt: 'desc' },
    }));
    return { candidates: rankDistrictActions(context, ctx.userId), staged: await Promise.all(staged.map((row) => this.actions.getOne(ctx, row.id))) };
  }
  async stage(ctx: TenantContext, clientId: string, state: string, district: string, key: string, edits: Partial<ActionText> = {}): Promise<ActionCard> {
    const context = await this.load(ctx, clientId, state, district);
    const candidate = rankDistrictActions(context, ctx.userId).find((c) => c.key === key);
    if (!candidate) throw new BadRequestException('Candidate is no longer available; refresh the district');
    const text = checkedText(edits);
    const districtKey = `${state}-${district}`;
    const note = `r5-fact-set:${factHash(candidate.facts)}`;
    const id = await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      // Unique district/fact index is the concurrency boundary; never overwrite a user's edits.
      const row = await tx.actionRecommendation.findFirst({ where: { tenantId: ctx.tenantId, clientId, districtKey,
        actionType: candidate.actionType, evidence: { path: ['0', 'note'], equals: note } }, select: { id: true } });
      if (row) return row.id;
      const created = await tx.actionRecommendation.createMany({ skipDuplicates: true, data: [{
          tenantId: ctx.tenantId, clientId, districtKey, actionType: candidate.actionType,
          issueTitle: text.issueTitle ?? candidate.issueTitle, whatChanged: text.whatChanged ?? candidate.whatChanged,
          whyItMatters: text.whyItMatters ?? candidate.whyItMatters, recommendedAction: text.recommendedAction ?? candidate.recommendedAction,
          targetAudience: JSON.parse(JSON.stringify(candidate.targetAudience)) as Prisma.InputJsonValue,
          suggestedArtifactType: candidate.suggestedArtifactType, ownerUserId: ctx.userId, priority: candidate.priority,
          confidence: JSON.parse(JSON.stringify(candidate.confidence)) as Prisma.InputJsonValue,
          uncertainty: candidate.uncertainty, evidence: JSON.parse(JSON.stringify(candidate.evidence)) as Prisma.InputJsonValue, status: 'triaged',
        }] });
      const existing = await tx.actionRecommendation.findFirst({ where: { tenantId: ctx.tenantId, clientId, districtKey,
        actionType: candidate.actionType, evidence: { path: ['0', 'note'], equals: note } }, select: { id: true } });
      if (!existing) throw new NotFoundException('Staged action unavailable');
      if (created.count) await tx.auditLog.create({ data: { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: ctx.role,
        action: 'intelligence.action.stage', entityType: 'action_recommendation', entityId: existing.id,
        after: { districtKey, actionType: candidate.actionType, factIds: candidate.facts.map((f) => f.id) } } });
      return existing.id;
    });
    return this.actions.getOne(ctx, id);
  }
  private async owned(ctx: TenantContext, id: string, clientId: string, state: string, district: string) {
    await this.load(ctx, clientId, state, district);
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) => tx.actionRecommendation.findFirst({ where: {
      id, tenantId: ctx.tenantId, clientId, districtKey: `${state}-${district}` }, select: { id: true } }));
    if (!row) throw new NotFoundException();
  }
  async edit(ctx: TenantContext, id: string, clientId: string, state: string, district: string, edits: Partial<ActionText>) {
    await this.owned(ctx, id, clientId, state, district);
    const data = checkedText(edits);
    if (!Object.keys(data).length) throw new BadRequestException('No text fields supplied');
    await this.prisma.withTenant(ctx.tenantId, async (tx) => {
      const before = await tx.actionRecommendation.findFirstOrThrow({ where: { id, tenantId: ctx.tenantId, clientId }, select: { issueTitle: true, whatChanged: true, whyItMatters: true, recommendedAction: true } });
      await tx.actionRecommendation.updateMany({ where: { id, tenantId: ctx.tenantId, clientId, districtKey: `${state}-${district}` }, data });
      await tx.auditLog.create({ data: { tenantId: ctx.tenantId, actorUserId: ctx.userId, actorRole: ctx.role,
        action: 'intelligence.action.edit', entityType: 'action_recommendation', entityId: id, before, after: data } });
    });
    return this.actions.getOne(ctx, id);
  }
  async status(ctx: TenantContext, id: string, clientId: string, state: string, district: string, status: ActionStatus, dismissalReason?: string) {
    await this.owned(ctx, id, clientId, state, district);
    return this.actions.updateStatus(ctx, id, status, dismissalReason);
  }
}
