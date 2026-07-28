import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SourceVerification } from '@capiro/shared';
import type { AppConfig } from '../../config/config.schema.js';

/**
 * HP-04 / HP-05 (Gate L): the outreach generator's view of intel-api's
 * Government Affairs Alert Packet.
 *
 * This is apps/api's own copy of the contract — apps/intel-api/src/feed/alert-packet.ts
 * and apps/web/src/pages/clients/tracker/alert-packet.ts each already carry their own,
 * this codebase's established convention for a cross-service contract (see
 * district-brief.service.ts's "local copy per site" note). Field names/order match
 * exactly; do not rename or reorder without updating all three.
 */
export interface GovernmentAffairsAlertPacket {
  event: {
    sourceType: string;
    whatChanged: string;
    canonicalStatus: string | null;
    occurredAt: string | null;
    effectiveAt: string | null;
  };
  officialEvidence: Array<{
    claimId: string;
    text: string;
    sourceUrl?: string;
    sourceDocumentId?: string;
    page?: number;
    retrievedAt: string;
    verification: SourceVerification;
  }>;
  proceduralMeaning: {
    currentStage: string;
    priorStage?: string;
    nextPossibleSteps: string[];
    blockedBy?: string[];
    deadline?: string;
    uncertainty: string[];
  };
  clientContext: {
    clientId: string;
    position?: 'support' | 'oppose' | 'monitor';
    priority?: 'low' | 'med' | 'high';
    matchedTopics: string[];
    capabilities: string[];
    activeStrategies: string[];
    redLines: string[];
    facilities: Array<{ state?: string; district?: string; employees?: number }>;
  };
  relationshipContext: {
    targetOffices: string[];
    existingRelationships: string[];
    recentMeetings: string[];
    openCommitments: string[];
  };
  actionContext: {
    recommendedOwner?: string;
    recommendedTargets: string[];
    recommendedActions: string[];
    actionWindow?: string;
  };
  confidence: {
    relevance: number;
    procedural: number;
    evidenceCoverage: number;
    missingFields: string[];
  };
}

/** Mirrors apps/web's OUTREACH_SUMMARY_MAX (alert-packet.ts) — the DTO's own bound. */
export const OUTREACH_SUMMARY_MAX = 2000;

/**
 * Render the packet as the plain-text context block the outreach generator reads.
 *
 * HP-05 c-4: `Unknowns:`, next steps and recommended actions come BEFORE the
 * (potentially large) evidence list, and the evidence section is budgeted against
 * whatever of OUTREACH_SUMMARY_MAX remains after everything else — never a bare
 * slice — with an explicit "(N evidence line(s) omitted)" marker when it doesn't
 * all fit. A single long hearing quote can no longer silently crowd out the
 * Unknowns line the model most needs to see.
 *
 * Byte-identical in algorithm to apps/web's renderPacketSummary (alert-packet.ts)
 * — HP-05 c-5 requires the wizard to display the same body the model receives, and
 * these are the two places that render one. Keep them in lockstep.
 */
export function renderAlertPacketForOutreach(packet: GovernmentAffairsAlertPacket): string {
  const lines: string[] = [];
  const ev = packet.event ?? ({} as GovernmentAffairsAlertPacket['event']);

  lines.push(`What changed: ${ev.whatChanged ?? '(not established)'}`);
  if (ev.canonicalStatus) lines.push(`Canonical status: ${ev.canonicalStatus}`);
  const stage = packet.proceduralMeaning?.currentStage;
  if (stage) lines.push(`Current stage: ${stage}`);
  if (ev.occurredAt) lines.push(`Occurred: ${ev.occurredAt}`);
  if (ev.effectiveAt) lines.push(`Effective: ${ev.effectiveAt}`);
  const deadline = packet.proceduralMeaning?.deadline;
  if (deadline) lines.push(`Deadline: ${deadline}`);

  const client = packet.clientContext;
  const clientBits = [
    client?.position ? `position ${client.position}` : null,
    client?.priority ? `priority ${client.priority}` : null,
    client?.matchedTopics?.length ? `matched topics ${client.matchedTopics.join(', ')}` : null,
  ].filter(Boolean);
  if (clientBits.length) lines.push(`Client context: ${clientBits.join('; ')}`);

  const rel = packet.relationshipContext;
  const relBits = [
    rel?.existingRelationships?.length ? `known contacts: ${rel.existingRelationships.join('; ')}` : null,
    rel?.targetOffices?.length ? `target offices: ${rel.targetOffices.join('; ')}` : null,
    rel?.recentMeetings?.length ? `recent meetings: ${rel.recentMeetings.join('; ')}` : null,
  ].filter(Boolean);
  if (relBits.length) lines.push(`Relationship context: ${relBits.join(' | ')}`);

  const steps = packet.proceduralMeaning?.nextPossibleSteps;
  if (steps?.length) lines.push('', `Next possible steps: ${steps.join('; ')}`);
  const actions = packet.actionContext?.recommendedActions;
  if (actions?.length) lines.push(`Recommended actions: ${actions.join('; ')}`);

  const unknowns = [
    ...(packet.confidence?.missingFields ?? []),
    ...(packet.proceduralMeaning?.uncertainty ?? []),
  ];
  if (unknowns.length) lines.push('', `Unknowns: ${unknowns.join(', ')}`);

  const evidence = packet.officialEvidence ?? [];
  if (evidence.length) {
    const header = 'Official evidence:';
    const soFar = [...lines, '', header].join('\n');
    // Headroom for the trailing omission marker line, so adding it never itself
    // busts the budget.
    const omissionMarkerBudget = 40;
    let remaining = Math.max(0, OUTREACH_SUMMARY_MAX - soFar.length - omissionMarkerBudget);
    const shown: string[] = [];
    for (const e of evidence) {
      const line =
        `- [${e.claimId}] ${e.text}` +
        (e.sourceUrl ? ` — ${e.sourceUrl}` : '') +
        (e.verification ? ` (${e.verification})` : '');
      if (line.length + 1 > remaining) break;
      shown.push(line);
      remaining -= line.length + 1;
    }
    if (shown.length) lines.push('', header, ...shown);
    const omitted = evidence.length - shown.length;
    if (omitted > 0) lines.push(`(${omitted} evidence line(s) omitted)`);
  }

  return lines.join('\n');
}

/**
 * HP-04 (Gate L phase b): overlay apps/api-only client-relationship data onto a
 * packet fetched from intel-api, and honestly recompute which fields are still
 * missing.
 *
 * intel-api's own packet always emits `relationshipContext.existingRelationships`
 * / `.targetOffices` / `.recentMeetings` empty (with the three field names
 * listed in `confidence.missingFields`) — not because the data doesn't exist,
 * but because it lives in apps/api's schema (ClientPerson, ClientTarget,
 * Meeting) and reaching across the service boundary was rejected in favor of an
 * honestly-incomplete packet (a LAYERING rule, not an inability — see
 * PACKET_UNAVAILABLE_IN_INTEL_API's corrected comment, alert-packet.ts).
 * apps/api already has this data in hand at outreach-generation time, so this
 * fills exactly those three fields and drops exactly those three names from
 * `missingFields` — never touching `clientContext.capabilities` /
 * `.activeStrategies` / `.redLines` / `.facilities` or
 * `actionContext.recommendedOwner` / `.recommendedTargets`, which stay honest
 * gaps because no apps/api data backs them either (Gate L phase b-3;
 * `redLines`/`activeStrategies` exist in no schema anywhere in this codebase).
 *
 * Never clobbers a field intel-api DID populate — only fills what arrived empty.
 */
export function overlayClientRelationshipContext(
  packet: GovernmentAffairsAlertPacket,
  overlay: {
    existingRelationships?: string[];
    targetOffices?: string[];
    recentMeetings?: string[];
  },
): GovernmentAffairsAlertPacket {
  const filled: string[] = [];
  const rel = { ...packet.relationshipContext };

  if (overlay.existingRelationships?.length && !rel.existingRelationships?.length) {
    rel.existingRelationships = overlay.existingRelationships;
    filled.push('relationshipContext.existingRelationships');
  }
  if (overlay.targetOffices?.length && !rel.targetOffices?.length) {
    rel.targetOffices = overlay.targetOffices;
    filled.push('relationshipContext.targetOffices');
  }
  if (overlay.recentMeetings?.length && !rel.recentMeetings?.length) {
    rel.recentMeetings = overlay.recentMeetings;
    filled.push('relationshipContext.recentMeetings');
  }
  if (!filled.length) return packet;

  return {
    ...packet,
    relationshipContext: rel,
    confidence: {
      ...packet.confidence,
      missingFields: (packet.confidence?.missingFields ?? []).filter((f) => !filled.includes(f)),
    },
  };
}

const PACKET_FETCH_TIMEOUT_MS = 5_000;

/**
 * HP-05 (Gate L, c-1/c-2): fetches intel-api's alert packet for one alert, from
 * apps/api, at outreach-generation time.
 *
 * Auth: intel-api has no service-to-service auth channel today (unlike the
 * reverse direction — apps/intel-api already calls apps/api's
 * /api/internal/* routes with INTERNAL_SERVICE_SECRET). Rather than stand one
 * up here (a new guard on intel-api plus a hand-provisioned secret, since
 * intel-api has no CDK ownership at all — see infra/cdk/DRIFT-FINDINGS.md),
 * this forwards the END USER'S OWN already-verified Clerk bearer token, the
 * same one that authenticated the inbound apps/api request. intel-api's
 * existing TenantGuard verifies it exactly as if the browser had called it
 * directly — which, in fact, it already does for this exact endpoint from
 * TrackerFeedPanel.tsx. No new secret, no new guard, no new infra, and no
 * widening of what any request is authorized to read.
 *
 * Fail-open by contract, mirroring every other best-effort outreach-context
 * channel in this file: a missing header, a timeout, a non-2xx, or a network
 * error all degrade to `null` so a slow or unavailable intel-api never blocks
 * outreach generation.
 */
@Injectable()
export class AlertPacketClientService {
  private readonly logger = new Logger(AlertPacketClientService.name);

  constructor(private readonly config: ConfigService<AppConfig, true>) {}

  async fetchAlertPacket(
    authHeader: string | undefined,
    clientId: string,
    alertId: string,
  ): Promise<GovernmentAffairsAlertPacket | null> {
    if (!authHeader) return null;
    // Same public ALB, path-based routing (apps/intel-api/src/main.ts sets the
    // 'intel-api' global prefix) — the same base host apps/api is itself served
    // from, so no new base-URL config surface is needed.
    const baseUrl = (
      this.config.get('TRACKER_APP_BASE_URL', { infer: true }) || 'https://app.capiro.ai'
    ).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PACKET_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(
        `${baseUrl}/intel-api/clients/${encodeURIComponent(clientId)}/alerts/${encodeURIComponent(alertId)}/packet`,
        { headers: { authorization: authHeader }, signal: controller.signal },
      );
      if (!res.ok) return null;
      return (await res.json()) as GovernmentAffairsAlertPacket;
    } catch (err) {
      this.logger.warn(`alert packet fetch failed for alert ${alertId}: ${(err as Error).message}`);
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}
