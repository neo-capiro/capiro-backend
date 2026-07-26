import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { TrackerWatchlistService } from '../tracker/tracker-watchlist.service.js';
import { recommendedActionsFor } from './recommended-actions.util.js';
import { normalizeEvidence, type NormalizedAlertEvidence } from './normalize-evidence.js';
import {
  MAX_OFFICIAL_EVIDENCE,
  PACKET_UNAVAILABLE_IN_INTEL_API,
  packetVerificationFor,
  type GovernmentAffairsAlertPacket,
} from './alert-packet.js';

/**
 * §4.1 / P1-13. Builds the server-side Government Affairs Alert Packet for one alert.
 *
 * Why it exists: `draftOutreach` used to hand the wizard
 * `[whyItMatters, oneBillAction].join(' · ')`, which dropped every hearing quote and
 * speaker, every PE funding delta, every regulation field, the official source URL, the
 * client's position and priority, and the active strategy and target offices. The
 * generator then had to invent whatever it needed.
 *
 * Built entirely from data intel-api already owns. Everything it cannot reach is named in
 * `confidence.missingFields` rather than omitted (plan §6.1 option a).
 */
@Injectable()
export class AlertPacketService {
  private readonly logger = new Logger(AlertPacketService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly watchlist: TrackerWatchlistService,
  ) {}

  async build(
    tenantId: string,
    clientId: string,
    alertId: string,
  ): Promise<GovernmentAffairsAlertPacket> {
    // Two independent ownership proofs. assertClientInTenant covers the CLIENT
    // (intel-api has no RLS); the alert predicate below covers the ALERT, so fetching
    // alert X under client Y 404s instead of leaking a sibling client's alert
    // (§4 edge case 13).
    await this.watchlist.assertClientInTenant(tenantId, clientId);
    const alert = await this.prisma.withTenant(tenantId, (tx) =>
      tx.intelAlert.findFirst({
        where: { id: alertId, tenantId, clientId },
        select: {
          id: true,
          clientId: true,
          sourceType: true,
          sourceRef: true,
          severity: true,
          score: true,
          title: true,
          whyItMatters: true,
          evidence: true,
          termId: true,
          createdAt: true,
        },
      }),
    );
    if (!alert) throw new NotFoundException('Alert not found');

    const evidence = normalizeEvidence({
      sourceType: alert.sourceType,
      sourceRef: alert.sourceRef,
      title: alert.title,
      whyItMatters: alert.whyItMatters,
      termId: alert.termId,
      evidence: alert.evidence,
    });

    const missingFields: string[] = [...PACKET_UNAVAILABLE_IN_INTEL_API];
    const retrievedAt = new Date().toISOString().slice(0, 10);
    const bill = evidence.bill;
    const hearing = evidence.hearing as
      | { title?: string | null; committeeId?: string | null; occurredAt?: string | null; mentions?: Array<{ speakerName?: string | null; quote?: string | null }> }
      | undefined;
    const pe = evidence.programElement as
      | { peCode?: string; title?: string | null; fiscalYear?: number | null; deltaTypeLabel?: string | null; fromRef?: string | null; toRef?: string | null; amountFromMillions?: number | null; amountToMillions?: number | null; deltaMillions?: number | null; href?: string | null }
      | undefined;
    const reg = evidence.regulation as
      | { ruleTitle?: string | null; agency?: string | null; ruleType?: string | null; commentEndDate?: string | null; effectiveDate?: string | null; actionText?: string | null; url?: string | null }
      | undefined;
    const extra = evidence.extra as {
      cutoffType?: string | null;
      cutoffDate?: string | null;
      daysUntil?: number | null;
    };

    // ---- officialEvidence: one entry per real fact, each with its own provenance.
    const facts: Array<{ text: string; url?: string | null }> = [];
    if (bill) {
      facts.push({ text: `Bill: ${bill.displayNum}${bill.title ? ` — ${bill.title}` : ''}`, url: bill.url });
      if (bill.stage) facts.push({ text: `Stage: ${bill.stage}`, url: bill.url });
      if (bill.actionText)
        facts.push({
          text: `Official action${bill.actionDate ? ` (${bill.actionDate})` : ''}: ${bill.actionText}`,
          url: bill.url,
        });
    }
    if (hearing) {
      if (hearing.title) facts.push({ text: `Hearing: ${hearing.title}`, url: evidence.provenance.sourceUrl });
      if (hearing.committeeId) facts.push({ text: `Committee: ${hearing.committeeId}` });
      for (const m of hearing.mentions ?? []) {
        if (!m?.quote) continue; // an undecryptable quote stays absent, never a placeholder
        facts.push({
          text: `Hearing statement — ${m.speakerName ? `${m.speakerName}: ` : ''}"${m.quote}"`,
          url: evidence.provenance.sourceUrl,
        });
      }
    }
    if (pe?.peCode) {
      facts.push({ text: `Program Element: ${pe.peCode}${pe.title ? ` — ${pe.title}` : ''}`, url: pe.href });
      if (pe.fiscalYear) facts.push({ text: `Fiscal year: FY${pe.fiscalYear}`, url: pe.href });
      if (pe.deltaTypeLabel) facts.push({ text: `Budget-stage movement: ${pe.deltaTypeLabel}`, url: pe.href });
      if (pe.fromRef || pe.toRef)
        facts.push({ text: `Source comparison: from ${pe.fromRef ?? 'unknown'} to ${pe.toRef ?? 'unknown'}`, url: pe.href });
      if (pe.amountFromMillions != null || pe.amountToMillions != null)
        facts.push({
          text: `Funding (millions): ${pe.amountFromMillions ?? 'unknown'} → ${pe.amountToMillions ?? 'unknown'}${pe.deltaMillions != null ? ` (delta ${pe.deltaMillions})` : ''}`,
          url: pe.href,
        });
    }
    if (reg) {
      if (reg.ruleTitle) facts.push({ text: `Regulatory action: ${reg.ruleTitle}`, url: reg.url });
      if (reg.agency) facts.push({ text: `Issuing agency: ${reg.agency}` });
      if (reg.ruleType) facts.push({ text: `Document type: ${reg.ruleType}` });
      if (reg.commentEndDate) facts.push({ text: `Public comment period closes: ${reg.commentEndDate}`, url: reg.url });
      if (reg.effectiveDate) facts.push({ text: `Effective date: ${reg.effectiveDate}`, url: reg.url });
      if (reg.actionText) facts.push({ text: `Rule summary: ${reg.actionText}`, url: reg.url });
    }
    if (extra?.cutoffType || extra?.cutoffDate || extra?.daysUntil != null) {
      facts.push({
        text: `Procedural deadline: ${[
          extra.cutoffType ? `type ${extra.cutoffType}` : null,
          extra.cutoffDate ? `date ${extra.cutoffDate}` : null,
          extra.daysUntil != null ? `${extra.daysUntil} day(s) remaining as of this alert` : null,
        ]
          .filter(Boolean)
          .join(', ')}`,
      });
    }
    if (evidence.match.why) facts.push({ text: `Relevance to client: ${evidence.match.why}` });

    if (facts.length > MAX_OFFICIAL_EVIDENCE) {
      // Never silently truncate (MASTER "no silent caps").
      this.logger.warn(
        `[alert-packet] alert=${alertId} produced ${facts.length} evidence entries; ` +
          `capping at ${MAX_OFFICIAL_EVIDENCE} (${facts.length - MAX_OFFICIAL_EVIDENCE} dropped)`,
      );
      missingFields.push(
        `officialEvidence.truncated:${facts.length - MAX_OFFICIAL_EVIDENCE}`,
      );
    }
    const officialEvidence = facts.slice(0, MAX_OFFICIAL_EVIDENCE).map((f, i) => ({
      claimId: `c${i + 1}`,
      text: f.text,
      ...(f.url ? { sourceUrl: f.url } : {}),
      retrievedAt,
      verification: packetVerificationFor(f.url),
    }));

    // ---- clientContext: the client's OWN topic rows for the tags this alert matched.
    const topics = await this.prisma.withTenant(tenantId, (tx) =>
      tx.watchlistTopic.findMany({
        where: { tenantId, watchlistId: `wl:${clientId}` },
        select: { label: true, issueArea: true, position: true, priority: true },
      }),
    );
    const matchedLabels = new Set(
      [...evidence.match.matchedTags, evidence.match.topicLabel ?? '']
        .filter(Boolean)
        .map((t) => t.toLowerCase()),
    );
    const matched = topics.filter(
      (t) =>
        matchedLabels.has(t.label.toLowerCase()) ||
        (t.issueArea ? matchedLabels.has(t.issueArea.toLowerCase()) : false),
    );
    const matchedTopics = matched.map((t) => t.label);
    if (!matchedTopics.length) missingFields.push('clientContext.matchedTopics');
    // The strongest matched topic governs. `position`/`priority` are per-topic, so with no
    // matched topic there is no defensible value — omit rather than default to 'monitor'.
    const primary = matched[0];
    if (!primary) {
      missingFields.push('clientContext.position', 'clientContext.priority');
    }

    // ---- proceduralMeaning. nextPossibleSteps needs Gate D phase b's state machine.
    const currentStage =
      bill?.stage || reg?.ruleType || pe?.deltaTypeLabel || evidence.provenance.band || 'not established';
    if (currentStage === 'not established') missingFields.push('proceduralMeaning.currentStage');
    missingFields.push('proceduralMeaning.nextPossibleSteps', 'proceduralMeaning.priorStage');
    const deadline = reg?.commentEndDate ?? extra?.cutoffDate ?? null;

    const recommendedActions = recommendedActionsFor({
      sourceType: alert.sourceType,
      severity: alert.severity,
      sourceRef: alert.sourceRef,
      evidence,
    }).map((a) => a.label);

    // ---- confidence.evidenceCoverage: filled / total over the SEVEN canonical Alert
    // fields (the same seven buildAlert is defined over), so the number means something
    // a reader can check rather than being an opaque score.
    const canonical = [
      alert.title, // whatChanged
      alert.whyItMatters, // whyItMatters
      alert.clientId, // clientId
      matchedTopics[0] ?? evidence.match.matchedTags[0] ?? null, // issueId
      null, // whoActs — no feed source today (P1-11, Gate D phase c)
      bill?.actionDate ?? hearing?.occurredAt ?? deadline, // deadline
      alert.sourceType, // sourceType
    ];
    const filled = canonical.filter((v) => v !== null && v !== undefined && v !== '').length;
    missingFields.push('confidence.whoActs');

    return {
      event: {
        sourceType: alert.sourceType,
        whatChanged: alert.title,
        canonicalStatus: bill?.stage || reg?.ruleType || pe?.deltaTypeLabel || null,
        occurredAt:
          bill?.actionDate ?? hearing?.occurredAt ?? alert.createdAt.toISOString().slice(0, 10),
        effectiveAt: reg?.effectiveDate ?? null,
      },
      officialEvidence,
      proceduralMeaning: {
        currentStage,
        nextPossibleSteps: [], // Gate D phase b
        uncertainty: officialEvidence.length ? [] : ['No official evidence resolved for this alert.'],
        ...(deadline ? { deadline } : {}),
      },
      clientContext: {
        clientId: alert.clientId,
        ...(primary ? { position: primary.position as 'support' | 'oppose' | 'monitor' } : {}),
        ...(primary ? { priority: primary.priority as 'low' | 'med' | 'high' } : {}),
        matchedTopics,
        // Structurally unavailable in intel-api — see PACKET_UNAVAILABLE_IN_INTEL_API.
        capabilities: [],
        activeStrategies: [],
        redLines: [],
        facilities: [],
      },
      relationshipContext: {
        targetOffices: [],
        existingRelationships: [],
        recentMeetings: [],
        openCommitments: [],
      },
      actionContext: {
        recommendedTargets: [],
        recommendedActions,
        ...(deadline ? { actionWindow: `Before ${deadline}` } : {}),
      },
      confidence: {
        // The alert's own composite score is the best relevance signal intel-api has.
        relevance: alert.score ?? 0,
        procedural: 0, // no state machine yet — 0 is honest, not a guess
        evidenceCoverage: Number((filled / canonical.length).toFixed(2)),
        missingFields,
      },
    };
  }
}

/** Exported for tests: the normalized evidence shape the builder consumes. */
export type { NormalizedAlertEvidence };
