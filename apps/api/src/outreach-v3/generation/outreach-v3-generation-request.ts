import type { LedgerEntry } from '@capiro/meriv2-core';
import type {
  GenerationRequest,
  GatewayRecipient,
} from '../../engagement/generation/generation-gateway.types.js';
import type { EnrichmentChannel } from '../../engagement/generation/evidence-packet.service.js';
import type { SelectedContextItemRef } from '../../engagement/generation/evidence-source.service.js';
import {
  campaignStyleSamplesV1,
  campaignTargetCcBccV1,
  type OutreachCampaignSpecV1,
} from '../state/outreach-campaign-spec.v1.js';
import { OutreachCommandError } from '../state/outreach-command-errors.js';
import type { PreparedOutreachV3GenerationSlot } from './outreach-v3-generation-preparation.service.js';
import type { OutreachV3GenerationPlan } from './outreach-v3-generation-plan.js';

export interface BuildOutreachV3GatewayRequestInput {
  plan: OutreachV3GenerationPlan;
  spec: OutreachCampaignSpecV1;
  prepared: PreparedOutreachV3GenerationSlot;
  outreachRecordId?: string | null;
  authHeader?: string;
}

export interface OutreachV3GatewayUnit {
  request: GenerationRequest;
  enrichments: EnrichmentChannel[];
  /** Exact bounded factual strings returned by the enrichment loaders. */
  auditLedger: LedgerEntry[];
}

/**
 * Compile one fully reauthorized V3 slot into the existing governed generation
 * gateway contract. This is still a pure assembly boundary: calling the model is
 * owned by GenerationGatewayService, not by this function or by reasoning.
 *
 * V3 factual context has already been bounded with `boundEvidenceText()` during
 * preparation. Each enrichment loader returns that captured string unchanged,
 * and `auditLedger` serializes that SAME string. EvidencePacketService applies
 * the same bound again idempotently, so writer/verifier/auditor factual text is
 * byte-identical without changing Classic gateway behavior.
 */
export function buildOutreachV3GatewayUnit(
  input: BuildOutreachV3GatewayRequestInput,
): OutreachV3GatewayUnit {
  assertClientIsolation(input.plan.sponsorClientId, input.prepared);

  const selectedItems: SelectedContextItemRef[] = [
    ...input.prepared.selectedItems,
    ...strategyDirectives(input.spec, input.plan.stateVersion),
  ];
  const recipient = gatewayRecipient(input.prepared, input.spec);
  const styleSamples = campaignStyleSamplesV1(input.spec).map((sample) => ({
    sampleKey: sample.sampleKey,
    label: sample.label,
    subject: sample.subject,
    body: sample.body,
  }));
  const request: GenerationRequest = {
    runtimeAction: 'outreach_v3_generate',
    surface: 'outreach_email',
    clientId: input.plan.sponsorClientId,
    ...(input.outreachRecordId ? { outreachRecordId: input.outreachRecordId } : {}),
    ref: {
      outreachV3SessionId: input.plan.sessionId,
      outreachV3StateVersion: String(input.plan.stateVersion),
      outreachV3SpecHash: input.plan.specHash,
      outreachV3PlanHash: input.plan.planHash,
      generationKey: input.prepared.slot.generationKey,
    },
    items: selectedItems,
    templateId: 'outreach_v3_canonical_v1',
    templatePrompt: canonicalTemplatePrompt(input.spec),
    objective: input.spec.goal.objective,
    tone: gatewayTone(input.spec.strategy.tone),
    length: gatewayLength(input.spec.strategy.length),
    audienceKind: input.prepared.slot.audienceKind,
    ...(input.prepared.slot.audienceKind === 'group'
      ? { groupMemberCount: input.prepared.currentTargets.length }
      : {}),
    // Few-shot exemplars ride their own request field, not `items`. Routing them
    // through the Evidence Packet would put last quarter's figures into this
    // campaign's claim pool; see GenerationRequest.styleSamples.
    ...(styleSamples.length ? { styleSamples } : {}),
    // The campaign's own authored skeleton, when it has one. Same reasoning as
    // styleSamples for why it is a first-class field rather than a context item:
    // it is structure, not evidence, and the gateway needs it as structured data
    // to assemble the body after the model returns section prose.
    ...(input.spec.contentSkeleton ? { contentSkeleton: input.spec.contentSkeleton } : {}),
    recipient,
    ...(input.authHeader ? { authHeader: input.authHeader } : {}),
  };

  const enrichments: EnrichmentChannel[] = [];
  const auditLedger: LedgerEntry[] = [];
  for (const entry of input.prepared.serverEvidence) {
    // The packet's own sourceId is `${sourceType}:${scope}` (evidence-packet.service),
    // so sourceType must stay SHORT and must not re-state what the contextKey
    // already says.
    //
    // This used to be `${entry.sourceType}:${entry.contextKey}` — but
    // outreach-v3-generation-context.ts derives sourceType FROM the same locator
    // the contextKey is built from, so the type was always already a prefix of the
    // key. The concatenation produced a 129-char type and a 133-char id like:
    //
    //   outreach_v3:government_record:lda_filing:campaign_fact:campaign:government_record:lda_filing:<uuid>:all
    //    \________________ sourceType ________/ \_______ contextKey (repeats it) ______/ \_/
    //
    // The plan prompt shows that id to the model and check #2
    // (CLAIM_CITES_UNKNOWN_SOURCE) required it back byte-exact for every claim.
    // Verified live 2026-08-24: campaigns failed with 0 sendable drafts because
    // the planner could not transcribe it. The contextKey alone is already unique
    // per selected source, so the prefix bought nothing and cost every draft.
    const packetSourceType = entry.sourceType;
    const packetSourceId = entry.contextKey;
    enrichments.push({
      sourceType: packetSourceType,
      // Carry the stable per-source identity explicitly rather than letting it be
      // re-derived from `${sourceType}:${scope}`, which cannot distinguish two
      // selected sources that share a type.
      sourceKey: entry.contextKey,
      title: entry.title,
      trust: entry.trust,
      scope: 'all',
      // Captured bounded server text. No second mutable source read occurs here.
      load: async () => entry.text,
      failureSeverity: 'critical',
      failureCode: 'OUTREACH_V3_CONTEXT_UNAVAILABLE',
      failureMessage:
        'Selected campaign context could not be materialized for this recipient. Review Context and try again.',
      authoritativeAsOf: entry.authoritativeAsOf,
    });
    auditLedger.push({
      tool: `outreach_evidence:${entry.contextKey}`,
      serialized: entry.text,
      result: {
        sourceType: packetSourceType,
        sourceId: packetSourceId,
        contextKey: entry.contextKey,
        title: entry.title,
        trust: entry.trust,
        clientId: entry.clientId,
        authoritativeAsOf: entry.authoritativeAsOf,
        truncated: entry.truncated,
      },
    });
  }

  return { request, enrichments, auditLedger };
}

function gatewayRecipient(
  prepared: PreparedOutreachV3GenerationSlot,
  spec: OutreachCampaignSpecV1,
): GatewayRecipient {
  if (prepared.slot.audienceKind === 'group') {
    const members = prepared.currentTargets.map((target) => targetSnapshot(target, spec));
    // OutreachSendIntentService.buildEnvelope() reads cc/bcc off THIS top-level
    // snapshot for a shared-thread send — it never walks `members[i].cc`. Union
    // every member's own Cc/Bcc here (deduped, minus anyone already in To) so a
    // group send honors the same Cc/Bcc an individual send does. Shipped gap
    // from PR #1360: members[i].cc was populated but the top level never was,
    // so every shared-thread send silently dropped all Cc/Bcc.
    const toEmails = new Set(
      members.map((member) => member.email?.trim().toLowerCase()).filter(Boolean),
    );
    const unionAddresses = (pick: (m: (typeof members)[number]) => string[]): string[] => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const member of members) {
        for (const address of pick(member)) {
          const normalized = address.trim().toLowerCase();
          if (!normalized || seen.has(normalized) || toEmails.has(normalized)) continue;
          seen.add(normalized);
          out.push(address.trim());
        }
      }
      return out;
    };
    const groupCc = unionAddresses((member) => member.cc);
    // An address one member Cc'd and another Bcc'd must not appear in BOTH
    // headers — Cc (visible) wins, so the Bcc union also excludes groupCc.
    const groupCcSet = new Set(groupCc.map((address) => address.toLowerCase()));
    const groupBcc = unionAddresses((member) => member.bcc).filter(
      (address) => !groupCcSet.has(address.toLowerCase()),
    );
    return {
      generationKey: prepared.slot.generationKey,
      scopeKeys: prepared.slot.scopeKeys,
      recipientKey: prepared.slot.recipientKey,
      name: `${members.length} outreach recipients`,
      email: null,
      title: null,
      office: null,
      state: commonValue(members.map((member) => member.state)),
      district: null,
      chamber: commonValue(members.map((member) => member.chamber)),
      snapshot: {
        kind: 'shared_thread',
        // OutreachSendIntentService.buildEnvelope() consumes this exact property.
        // Keep every intended member here; preflight blocks if any member lacks
        // an email so the envelope can never silently drop a participant.
        groupMembers: members.map((member) => ({
          email: member.email,
          name: member.name,
          targetKey: member.targetKey,
        })),
        members,
        // buildEnvelope() reads THESE for the shared thread's Cc/Bcc headers
        // (see the union above). Also part of the delivery idempotency key.
        cc: groupCc,
        bcc: groupBcc,
      },
    };
  }

  const target = prepared.currentTargets[0];
  if (!target) {
    throw new OutreachCommandError(
      'OUTREACH_STATE_CORRUPT',
      'An individual generation slot has no authorized recipient.',
      500,
    );
  }
  return {
    generationKey: prepared.slot.generationKey,
    scopeKeys: prepared.slot.scopeKeys,
    recipientKey: target.targetKey,
    name: target.displayName,
    email: target.email,
    title: target.title,
    office: target.organization,
    state: target.jurisdiction.state,
    district: target.jurisdiction.district,
    chamber: target.jurisdiction.chamber,
    // Server-resolved committee names. For committee_staff this is the
    // committee they serve; for directory_staff, the member's assignments.
    // This is what gives a bioguide-less staffer a committee hook in the
    // recipient brief (see GenerationGatewayService.recipientBrief).
    committees: target.jurisdiction.committees,
    snapshot: targetSnapshot(target, spec),
  };
}

function targetSnapshot(
  target: PreparedOutreachV3GenerationSlot['currentTargets'][number],
  spec: OutreachCampaignSpecV1,
) {
  const ccBcc = campaignTargetCcBccV1(spec, target.targetKey);
  return {
    targetKey: target.targetKey,
    name: target.displayName,
    displayName: target.displayName,
    email: target.email,
    title: target.title,
    organization: target.organization,
    clientId: target.clientId,
    jurisdiction: target.jurisdiction,
    source: target.locator.source,
    sourceId: target.locator.id,
    snapshotHash: target.snapshotHash,
    sourceSnapshot: target.sourceSnapshot,
    state: target.jurisdiction.state,
    chamber: target.jurisdiction.chamber,
    // Read from the campaign spec's separate (non-hashed) targetCcBcc map —
    // see outreach-campaign-spec.v1.ts's field comment for why Cc/Bcc is not
    // part of the resolved target ref's own snapshotHash. Consumed directly
    // by OutreachSendIntentService.buildEnvelope()'s r.cc/r.bcc reads.
    cc: ccBcc.cc,
    bcc: ccBcc.bcc,
  };
}

function strategyDirectives(
  spec: OutreachCampaignSpecV1,
  stateVersion: number,
): SelectedContextItemRef[] {
  const items: SelectedContextItemRef[] = [];
  const tone = spec.strategy.tone?.trim();
  if (tone && gatewayTone(tone) === 'professional' && tone.toLowerCase() !== 'professional') {
    items.push({
      id: `v3-strategy-tone:${stateVersion}`,
      kind: 'note',
      scope: 'all',
      customNoteText: `Use this user-approved tone instruction: ${tone}`,
      noteUse: 'instruction',
    });
  }
  if (spec.strategy.length === 'custom' && spec.strategy.customLengthInstruction?.trim()) {
    items.push({
      id: `v3-strategy-length:${stateVersion}`,
      kind: 'note',
      scope: 'all',
      customNoteText: `Use this user-approved length instruction: ${spec.strategy.customLengthInstruction.trim()}`,
      noteUse: 'instruction',
    });
  }
  return items;
}

function canonicalTemplatePrompt(spec: OutreachCampaignSpecV1): string {
  const lines = [
    'Draft one government-affairs outreach email for the resolved recipient using only the governed Evidence Packet for factual claims.',
    `Campaign goal: ${spec.goal.goal ?? 'Not stated'}`,
    `Objective: ${spec.goal.objective ?? 'Not stated'}`,
    `Topic: ${spec.goal.topic ?? 'Not stated'}`,
    `Desired outcome: ${spec.goal.desiredOutcome ?? 'Not stated'}`,
    `Campaign angle: ${spec.strategy.campaignAngle ?? 'Not stated'}`,
    spec.goal.ask.mode === 'explicit'
      ? `Explicit ask: ${spec.goal.ask.text ?? 'Not stated'}`
      : 'Explicit ask: none; do not invent a formal ask.',
    `Why now: ${spec.goal.whyNow ?? 'Not stated'}`,
    'Do not convert writing guidance into factual evidence. Do not invent recipient history, commitments, votes, dates, funding, or relationships.',
  ];
  return lines.join('\n');
}

function gatewayTone(value: string | null): GenerationRequest['tone'] {
  const normalized = value?.trim().toLowerCase() ?? '';
  if (normalized.includes('friendly') || normalized.includes('warm')) return 'friendly';
  if (normalized.includes('formal')) return 'formal';
  if (normalized.includes('concise') || normalized.includes('brief')) return 'concise';
  return 'professional';
}

function gatewayLength(
  value: OutreachCampaignSpecV1['strategy']['length'],
): NonNullable<GenerationRequest['length']> {
  if (value === 'short') return 'short';
  if (value === 'long') return 'long';
  return 'standard';
}

function assertClientIsolation(
  sponsorClientId: string | null,
  prepared: PreparedOutreachV3GenerationSlot,
): void {
  for (const evidence of prepared.serverEvidence) {
    if (evidence.clientId !== null && evidence.clientId !== sponsorClientId) {
      throw new OutreachCommandError(
        'OUTREACH_COMMAND_BLOCKED',
        'Selected context does not match the campaign client boundary.',
        409,
        { contextKey: evidence.contextKey, reason: 'client_scope_mismatch' },
      );
    }
  }
}

function commonValue(values: Array<string | null>): string | null {
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return unique.length === 1 ? unique[0]! : null;
}
