import { Injectable, Logger } from '@nestjs/common';
import { z } from 'zod';
import {
  generateGroundedJson,
  type GroundedClaim,
  type GroundedEvidence,
  type LlmClient,
} from '@capiro/meriv2-core';
import { recordAiUsageEvent } from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { ChokepointService } from '../intelligence/chokepoint/chokepoint.service.js';
import type {
  ChokepointMember,
  ChokepointResult,
} from '../intelligence/chokepoint/chokepoint.types.js';
import {
  TargetingValidatorService,
  type TargetingMemberClaim,
} from './targeting-validator.service.js';

/**
 * Targeting-brief mode (Phase 1 M5.2 — "the P1 agentic headline"): for a
 * tracked bill with a material event, produce primary/secondary/blocking
 * targets with evidence + a recommended sequence — decision support, NEVER
 * executed (agentic doc §4.3). The model may only SELECT from and write a
 * rationale about the roster `ChokepointService` (M2, deterministic) already
 * resolved; it never invents a member. `GroundedJson`'s citation check
 * (internal consistency with the evidence WE supplied) and
 * `TargetingValidatorService`'s INDEPENDENT re-derivation from
 * congress_member/state_legislator/committee_membership (the M5-B success
 * criterion: "a seeded hallucinated member is dropped and logged") are two
 * separate, deliberately redundant gates — belt and suspenders.
 */

export interface TargetingBriefTrigger {
  alertId: string;
  tenantId: string;
  clientId: string;
  billKey: string;
  billTitle: string;
}

const TargetTargetSchema = z.object({
  memberId: z.string(),
  priority: z.enum(['primary', 'secondary', 'blocking']),
  rationale: z.string().min(1),
  evidenceIds: z.array(z.string()).min(1),
});
const TargetingBriefSchema = z.object({
  targets: z.array(TargetTargetSchema),
  recommendedSequence: z.array(z.string()),
});
type TargetingBriefOutput = z.infer<typeof TargetingBriefSchema>;

export interface TargetingBriefResult {
  billKey: string;
  targets: Array<
    z.infer<typeof TargetTargetSchema> & { memberName: string; jurisdiction: 'federal' | 'state' }
  >;
  recommendedSequence: string[];
  validationStatus: 'passed' | 'failed';
  materiality: 'low' | 'high';
  qaStatus: 'approved' | 'pending';
  droppedByGrounding: number;
  droppedByValidator: number;
}

const TOOL_NAME = 'emit_targeting_brief';
const PROMPT_VERSION = 'targeting-brief-v1';
const FALLBACK: TargetingBriefOutput = { targets: [], recommendedSequence: [] };

@Injectable()
export class TargetingBriefService {
  private readonly logger = new Logger(TargetingBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly chokepoint: ChokepointService,
    private readonly validator: TargetingValidatorService,
  ) {}

  /**
   * Build one brief. `llm` is caller-injected (the worker resolves the
   * tenant's credential via `aiCreds.resolveProvider`, BYOK-first) so this
   * service stays credential-agnostic and unit-testable with a fake client.
   * `credential` carries the SAME resolved model/usedTenantKey the worker
   * bound `llm` to — needed only for accurate `ai_usage_events` metering
   * (an `LlmClient` doesn't expose which model it's bound to).
   */
  async generate(
    trigger: TargetingBriefTrigger,
    llm: LlmClient,
    credential: { model: string; usedTenantKey: boolean },
  ): Promise<TargetingBriefResult> {
    const t0 = Date.now();
    const chokepoint = await this.chokepoint.forBill(trigger.billKey, {
      tenantId: trigger.tenantId,
      clientId: trigger.clientId,
    });
    const roster = rosterEntries(chokepoint);
    const evidence = buildEvidence(chokepoint, roster);

    if (!roster.length) {
      await this.writeAiRun(trigger, credential, {
        rail: chokepoint.jurisdiction,
        promptVersion: PROMPT_VERSION,
        inputRefs: [],
        output: null,
        validationStatus: 'skipped',
        qaStatus: 'none',
        status: 'ok',
        durationMs: Date.now() - t0,
      });
      return {
        billKey: trigger.billKey,
        targets: [],
        recommendedSequence: [],
        validationStatus: 'passed',
        materiality: 'low',
        qaStatus: 'approved',
        droppedByGrounding: 0,
        droppedByValidator: 0,
      };
    }

    const grounded = await generateGroundedJson({
      llm,
      system: SYSTEM_PROMPT,
      prompt: buildPrompt(trigger, chokepoint, roster),
      toolName: TOOL_NAME,
      toolDescription: 'Emit the targeting brief: prioritized targets + a recommended sequence.',
      inputSchema: TARGETING_BRIEF_JSON_SCHEMA,
      schema: TargetingBriefSchema,
      evidence,
      extractClaims: (d) => d.targets.map(targetToClaim),
      removeClaims: (d, dropped) => {
        const droppedKeys = new Set(dropped.map(claimKey));
        return {
          ...d,
          targets: d.targets.filter((t) => !droppedKeys.has(claimKey(targetToClaim(t)))),
        };
      },
      fallback: FALLBACK,
    });

    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: trigger.tenantId, userId: null },
      'intel_targeting',
      {
        provider: 'anthropic',
        model: credential.model,
        usage: grounded.usage,
        usedTenantKey: credential.usedTenantKey,
      },
    );

    // Belt-and-suspenders: re-derive independently from source-of-truth
    // tables (never trust that our own evidence construction was bug-free).
    const memberById = new Map(roster.map((m) => [m.id, m]));
    const claims: TargetingMemberClaim[] = grounded.data.targets.map((t) => {
      const member = memberById.get(t.memberId);
      const overlap = chokepoint.footprintOverlap.find((o) => o.memberId === t.memberId);
      return {
        jurisdiction: chokepoint.jurisdiction,
        memberId: t.memberId,
        memberName: member?.name ?? t.memberId,
        claimedRole: member?.role ?? null,
        claimedDistrictFacilityId: overlap ? overlap.facilityId : null,
      };
    });
    const { valid, dropped: validatorDropped } = await this.validator.validateMemberClaims(
      trigger.tenantId,
      trigger.clientId,
      claims,
    );
    if (validatorDropped.length) {
      this.logger.warn(
        `targeting brief for ${trigger.billKey}: validator dropped ${validatorDropped.length} member claim(s): ${validatorDropped
          .map((d) => `${d.claim.memberId} (${d.reason})`)
          .join(', ')}`,
      );
    }
    const validIds = new Set(valid.map((c) => c.memberId));
    const targets = grounded.data.targets
      .filter((t) => validIds.has(t.memberId))
      .map((t) => {
        const member = memberById.get(t.memberId);
        return {
          ...t,
          memberName: member?.name ?? t.memberId,
          jurisdiction: chokepoint.jurisdiction,
        };
      });

    const materiality: 'low' | 'high' = targets.some((t) => t.priority === 'primary')
      ? 'high'
      : 'low';
    // Interim QA gating (agentic doc §5.4/parent M5.4): high-materiality
    // briefs stay ai_run-only until a human clears them via the P0.5
    // source-quality dashboard — not built this phase, so they stay
    // unrendered rather than blocking on an unbuilt surface.
    const qaStatus: 'approved' | 'pending' = materiality === 'high' ? 'pending' : 'approved';

    await this.writeAiRun(trigger, credential, {
      rail: chokepoint.jurisdiction,
      promptVersion: PROMPT_VERSION,
      inputRefs: roster.map((m) => m.id),
      output: { targets, recommendedSequence: grounded.data.recommendedSequence },
      confidence: targets.length
        ? 1 - grounded.droppedClaims.length / (targets.length + grounded.droppedClaims.length)
        : null,
      validationStatus: grounded.validationStatus,
      qaStatus,
      status: grounded.usedFallback ? 'fallback' : 'ok',
      durationMs: Date.now() - t0,
    });

    return {
      billKey: trigger.billKey,
      targets,
      recommendedSequence: grounded.data.recommendedSequence,
      validationStatus: grounded.validationStatus,
      materiality,
      qaStatus,
      droppedByGrounding: grounded.droppedClaims.length,
      droppedByValidator: validatorDropped.length,
    };
  }

  private async writeAiRun(
    trigger: TargetingBriefTrigger,
    credential: { model: string; usedTenantKey: boolean },
    fields: {
      rail: 'federal' | 'state';
      promptVersion: string;
      inputRefs: string[];
      output: unknown;
      confidence?: number | null;
      validationStatus: 'passed' | 'failed' | 'skipped';
      qaStatus: 'approved' | 'pending' | 'none';
      status: 'ok' | 'failed' | 'fallback';
      durationMs: number;
    },
  ): Promise<void> {
    try {
      await this.prisma.withTenant(trigger.tenantId, (tx) =>
        tx.aiRun.create({
          data: {
            workflow: 'intel_targeting',
            rail: fields.rail,
            subjectType: 'bill',
            subjectKey: trigger.billKey,
            tenantId: trigger.tenantId,
            promptVersion: fields.promptVersion,
            model: credential.model,
            provider: 'anthropic',
            usedTenantKey: credential.usedTenantKey,
            inputRefs: fields.inputRefs,
            toolCalls: [],
            output: fields.output as never,
            confidence: fields.confidence ?? null,
            validationStatus: fields.validationStatus,
            qaStatus: fields.qaStatus,
            status: fields.status,
            durationMs: fields.durationMs,
          },
        }),
      );
    } catch (err) {
      this.logger.warn(`ai_run write failed (non-fatal): ${(err as Error).message}`);
    }
  }
}

const SYSTEM_PROMPT =
  'You are a government-affairs targeting analyst. You are given the REAL, already-resolved ' +
  'committee/sponsor roster for one bill (never invent a member not in the roster) and, where ' +
  "relevant, which of those members also represent the client's own facilities. Select which " +
  'members are worth engaging, in priority order, and write a short rationale for each citing ' +
  'the evidence id(s) it draws on. Never fabricate a role, district, or relationship not stated ' +
  'in the evidence.';

function buildPrompt(
  trigger: TargetingBriefTrigger,
  chokepoint: ChokepointResult,
  roster: ChokepointMember[],
): string {
  return [
    `Bill: ${trigger.billTitle} (${trigger.billKey})`,
    `Survival assessment: ${chokepoint.survivalBand ?? 'unknown'} (score ${chokepoint.survivalScore ?? 'n/a'})`,
    '',
    `Roster (${roster.length} member(s) — select ONLY from these ids):`,
    ...roster.map((m) => `- ${m.id}: ${m.name}${m.role ? ` (${m.role})` : ''}`),
    '',
    'Emit primary/secondary/blocking targets with a rationale citing evidence ids, and a recommended outreach sequence.',
  ].join('\n');
}

/** The distinct real chokepoint members this bill has — never a guess, one row per resolved role. */
function rosterEntries(chokepoint: ChokepointResult): ChokepointMember[] {
  const byId = new Map<string, ChokepointMember>();
  for (const m of [
    chokepoint.chair,
    chokepoint.viceChair,
    chokepoint.rankingMember,
    chokepoint.chamberLeadership,
    chokepoint.sponsor,
  ]) {
    if (m && m.id) byId.set(m.id, m);
  }
  return [...byId.values()];
}

function buildEvidence(
  chokepoint: ChokepointResult,
  roster: ChokepointMember[],
): GroundedEvidence[] {
  const evidence: GroundedEvidence[] = roster.map((m) => ({
    id: m.id,
    text: `${m.name}${m.party ? ` (${m.party})` : ''} — role on ${chokepoint.referredCommittee?.name ?? 'this bill'}: ${m.role ?? 'member'}.`,
  }));
  for (const o of chokepoint.footprintOverlap) {
    evidence.push({
      id: `${o.memberId}:footprint`,
      text: `${o.memberName} (${o.memberRole}) represents the client's facility "${o.facilityName}".`,
    });
  }
  return evidence;
}

function targetToClaim(t: z.infer<typeof TargetTargetSchema>): GroundedClaim {
  return { text: `${t.memberId}::${t.rationale}`, evidenceIds: t.evidenceIds };
}
function claimKey(c: GroundedClaim): string {
  return JSON.stringify({ text: c.text, evidenceIds: [...c.evidenceIds].sort() });
}

const TARGETING_BRIEF_JSON_SCHEMA = {
  type: 'object',
  properties: {
    targets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          memberId: { type: 'string', description: 'Must be one of the roster ids provided.' },
          priority: { type: 'string', enum: ['primary', 'secondary', 'blocking'] },
          rationale: { type: 'string' },
          evidenceIds: { type: 'array', items: { type: 'string' } },
        },
        required: ['memberId', 'priority', 'rationale', 'evidenceIds'],
      },
    },
    recommendedSequence: { type: 'array', items: { type: 'string' } },
  },
  required: ['targets', 'recommendedSequence'],
} as const;
