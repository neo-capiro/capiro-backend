import type { SourceVerification } from '@capiro/shared';
import type { FeedItem } from './intel-feed-api.js';

/**
 * §4.1 / P1-13 — the web mirror of intel-api's GovernmentAffairsAlertPacket
 * (apps/intel-api/src/feed/alert-packet.ts). Field names match that contract exactly.
 * Every field optional-tolerant on read: a not-yet-deployed intel-api or an older cached
 * response must degrade, never throw.
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

/**
 * P1-13: today's outreach context body, kept as a NAMED helper so the packet-fetch
 * failure path degrades to EXACTLY the behavior that shipped before, not to something
 * new. Do not "improve" this — its whole job is to be identical to the old projection.
 */
export function actionTextOf(item: FeedItem): string {
  const bill = item.evidence?.bill;
  const actionText = bill
    ? `${bill.displayNum}${bill.actionText ? ` — ${bill.actionText}` : ''}`
    : null;
  return [item.whyItMatters, actionText].filter(Boolean).join(' · ');
}

/**
 * The keys `OutreachContextPoolItemDto` whitelists, mirrored from
 * apps/api/src/engagement/engagement.controller.ts:620-652. The global ValidationPipe runs
 * `forbidNonWhitelisted`, so sending ANY key outside this set 400s the whole POST — which
 * is why the packet rides inside `summary` as text rather than as its own `packet` key
 * (widening that DTO would touch a contract the outreach wizard also uses).
 */
export const OUTREACH_CONTEXT_POOL_KEYS = [
  'id',
  'sourceType',
  'title',
  'summary',
  'note',
  'scope',
] as const;

/** The DTO's own bounds: title @Length(1,240), summary @Length(0,2000). */
export const OUTREACH_TITLE_MAX = 240;
export const OUTREACH_SUMMARY_MAX = 2000;

/**
 * Build the outreach `contextPool` entry for an alert. Extracted so the DTO contract is
 * unit-testable: intel_alert.title is unbounded and federal bill/hearing titles routinely
 * exceed 240 chars, and a packet summary easily exceeds 2000 — either would 400 the POST.
 */
export function buildOutreachContextPoolItem(
  ctxId: string,
  item: FeedItem,
  body: string,
): { id: string; sourceType: string; title: string; summary: string; note: string; scope: string } {
  return {
    id: ctxId,
    sourceType: 'intel',
    title: item.title.slice(0, OUTREACH_TITLE_MAX),
    summary: body.slice(0, OUTREACH_SUMMARY_MAX),
    note: '',
    scope: 'all',
  };
}

/**
 * Render the packet as the plain-text context block the outreach wizard opens with.
 *
 * The `Unknowns:` line is deliberate and required: a wizard that silently omits what the
 * server could not establish invites the model to fill the gap with something plausible.
 * Naming the gaps is the point of the packet.
 *
 * HP-05 c-4 (Gate L): `Unknowns:`, next steps and recommended actions come BEFORE the
 * (potentially large) evidence list, and evidence is budgeted against whatever of
 * OUTREACH_SUMMARY_MAX remains after everything else — never a bare, unbounded loop —
 * with an explicit "(N evidence line(s) omitted)" marker when it doesn't all fit.
 * Previously the evidence loop was unbounded and came FIRST, so a handful of long
 * hearing quotes could push `Unknowns:` and the recommended actions past the 2,000-char
 * save/generate cap entirely (the render-exceeds-2000 regression this file's own test
 * already proved).
 *
 * Byte-identical in algorithm to apps/api's renderAlertPacketForOutreach
 * (engagement/generation/alert-packet-client.service.ts) — HP-05 c-5 requires the wizard
 * to display the same body the model receives. Keep them in lockstep.
 */
export function renderPacketSummary(packet: GovernmentAffairsAlertPacket): string {
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
