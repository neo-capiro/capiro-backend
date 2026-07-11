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
  /**
   * W3.1 (D-8 strong form): each step is a VALIDATED member id + the roster name
   * we resolved for it — never free text the model wrote. Steps referencing a
   * dropped (off-roster / ungrounded / validator-rejected) member are removed,
   * so no dropped member's id or name can leak through this structured field.
   */
  recommendedSequence: Array<{ memberId: string; memberName: string }>;
  validationStatus: 'passed' | 'failed';
  materiality: 'low' | 'high';
  qaStatus: 'approved' | 'pending';
  droppedByGrounding: number;
  droppedByValidator: number;
  droppedOffRoster: number;
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
        droppedOffRoster: 0,
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
      claims: {
        extract: (d) => d.targets.map(targetToClaim),
        remove: (d, dropped) => {
          const droppedKeys = new Set(dropped.map(claimKey));
          return {
            ...d,
            targets: d.targets.filter((t) => !droppedKeys.has(claimKey(targetToClaim(t)))),
          };
        },
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

    const memberById = new Map(roster.map((m) => [m.id, m]));

    // W3.1 — ROSTER-MEMBERSHIP GATE: a deterministic third drop layer, run
    // BEFORE the validator. The validator (below) confirms a member EXISTS and
    // has the claimed role/district in the source-of-truth tables, but NOT that
    // they are on THIS bill's resolved chokepoint roster — so a real member
    // holding a real role on some OTHER committee would sail through it (the
    // M5-B false the audit flagged). Drop any target whose memberId is not a
    // roster id, deterministically, so it never reaches the validator or output.
    const onRosterTargets = grounded.data.targets.filter((t) => memberById.has(t.memberId));
    const offRosterDropped = grounded.data.targets.filter((t) => !memberById.has(t.memberId));
    if (offRosterDropped.length) {
      this.logger.warn(
        `targeting brief for ${trigger.billKey}: roster gate dropped ${offRosterDropped.length} off-roster target(s): ${offRosterDropped
          .map((t) => t.memberId)
          .join(', ')}`,
      );
    }

    // Belt-and-suspenders: re-derive independently from source-of-truth
    // tables (never trust that our own evidence construction was bug-free).
    const claims: TargetingMemberClaim[] = onRosterTargets.map((t) => {
      const member = memberById.get(t.memberId)!; // guaranteed on-roster
      const overlap = chokepoint.footprintOverlap.find((o) => o.memberId === t.memberId);
      return {
        jurisdiction: chokepoint.jurisdiction,
        memberId: t.memberId,
        memberName: member.name,
        claimedRole: member.role ?? null,
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
    const targets = onRosterTargets
      .filter((t) => validIds.has(t.memberId))
      .map((t) => ({
        ...t,
        memberName: memberById.get(t.memberId)!.name,
        jurisdiction: chokepoint.jurisdiction,
      }));

    // W3.1 (D-8 strong form): the model's recommendedSequence is a list of
    // memberIds; keep only VALIDATED ids and render names from the roster
    // (source of truth). A dropped member's id is filtered out and its name is
    // never taken from the model — structurally impossible to leak a dropped
    // member through this field.
    const recommendedSequence = grounded.data.recommendedSequence
      .filter((id) => validIds.has(id))
      .map((id) => ({ memberId: id, memberName: memberById.get(id)!.name }));

    // W3.1 confidence = kept / (kept + every deterministic drop). null only when
    // the model emitted no targets at all (nothing to have confidence about).
    const droppedByGrounding = grounded.droppedClaims.length;
    const droppedByValidator = validatorDropped.length;
    const droppedOffRoster = offRosterDropped.length;
    const totalClaims =
      targets.length + droppedByGrounding + droppedByValidator + droppedOffRoster;
    const confidence = totalClaims > 0 ? targets.length / totalClaims : null;

    const materiality: 'low' | 'high' = targets.some((t) => t.priority === 'primary')
      ? 'high'
      : 'low';
    // Interim QA gating (agentic doc §5.4/parent M5.4): a brief stays ai_run-only
    // (never surfaced) until a human clears it. Held when EITHER (a) it's
    // high-materiality (a primary target), OR (b) ANY deterministic gate dropped
    // something — grounding, validator, or the roster gate. (b) is the Wave-3
    // adversarial-gate hardening: a per-target `rationale` is free model prose
    // that the citation gate only checks for QUOTED substrings (unquoted
    // interpretive prose citing a valid evidence id is a known, documented
    // boundary of citation-grounding, shared by the memo generators and not
    // deterministically closeable without an LLM judge). Rather than let that
    // prose reach a client on a low-materiality auto-approve, any brief where the
    // model ALREADY showed fabrication behavior (something had to be dropped) is
    // routed to human review — a deterministic, complete backstop that pairs with
    // the dark-by-default posture (attach requires INTEL_WORKFLOWS_TARGETING_ENABLED).
    const anyDrops = droppedByGrounding + droppedByValidator + droppedOffRoster > 0;
    const qaStatus: 'approved' | 'pending' = materiality === 'high' || anyDrops ? 'pending' : 'approved';

    await this.writeAiRun(trigger, credential, {
      rail: chokepoint.jurisdiction,
      promptVersion: PROMPT_VERSION,
      inputRefs: roster.map((m) => m.id),
      output: { targets, recommendedSequence },
      confidence,
      droppedByGrounding,
      droppedByValidator,
      droppedOffRoster,
      validationStatus: grounded.validationStatus,
      qaStatus,
      status: grounded.usedFallback ? 'fallback' : 'ok',
      durationMs: Date.now() - t0,
    });

    return {
      billKey: trigger.billKey,
      targets,
      recommendedSequence,
      validationStatus: grounded.validationStatus,
      materiality,
      qaStatus,
      droppedByGrounding,
      droppedByValidator,
      droppedOffRoster,
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
      droppedByGrounding?: number;
      droppedByValidator?: number;
      droppedOffRoster?: number;
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
            // W3.1: targeting briefs are per-client — record it so the
            // idempotency guard keys on (bill, client, tenant).
            clientId: trigger.clientId,
            promptVersion: fields.promptVersion,
            model: credential.model,
            provider: 'anthropic',
            usedTenantKey: credential.usedTenantKey,
            inputRefs: fields.inputRefs,
            toolCalls: [],
            output: fields.output as never,
            confidence: fields.confidence ?? null,
            droppedByGrounding: fields.droppedByGrounding ?? 0,
            droppedByValidator: fields.droppedByValidator ?? 0,
            droppedOffRoster: fields.droppedOffRoster ?? 0,
            validationStatus: fields.validationStatus,
            qaStatus: fields.qaStatus,
            status: fields.status,
            durationMs: fields.durationMs,
          },
        }),
      );
    } catch (err) {
      // 2026-07-10 (Wave-2 closure): FAIL LOUD. W2.3 makes this ai_run row the
      // SOLE idempotency record that stops a QA-held/zero-target brief from
      // re-billing BYOK on the next run (in shadow posture — the default — no
      // intel_action_item is written either, so ai_run is the only dedup trail
      // for ALL briefs). Swallowing a write failure let the run report success
      // with no trail, so the same alert re-qualified and re-spent every cycle,
      // silently. Rethrowing surfaces it as a per-alert error in the worker loop
      // (which W4.3 makes pageable) and bounds re-spend to the incident window
      // instead of forever. Complete belt-and-braces — reserve-before-spend so a
      // persistent write failure cannot re-charge at all — needs an ai_run
      // idempotency key and lands in W3.1 (which adds client_id + the guard
      // index to this table).
      this.logger.error(`ai_run write failed: ${(err as Error).message}`);
      throw err;
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
    'Emit primary/secondary/blocking targets with a rationale citing evidence ids. ' +
      'For recommendedSequence, return an ORDERED list of member IDS (from the roster ' +
      'above, and only ids you also listed as targets) giving the outreach order — ' +
      'NOT free-text sentences.',
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
    recommendedSequence: {
      type: 'array',
      items: { type: 'string', description: 'A roster member id, in outreach order.' },
      description: 'Ordered member ids (from the roster / your targets) — not free text.',
    },
  },
  required: ['targets', 'recommendedSequence'],
} as const;
