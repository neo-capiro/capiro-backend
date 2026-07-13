import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service.js';
import { ClientPeRelevanceService } from '../client-pe-relevance.service.js';
import type { PathResult } from '../client-pe-relevance.scoring.js';
import { GATE_MATERIALITY_MIN, GATE_RELEVANCE_MIN, shouldGenerate } from './action-gating.js';
import {
  selectAudience,
  type AudienceCommittee,
  type AudiencePersonRole,
} from './action-audience.js';
import {
  assembleCard,
  type ProvisionFact,
  type RelevancePathFact,
} from './action-card-assembly.js';
import type {
  ActionType,
  AudienceMember,
  ConfidenceBand,
  ConfidenceBands,
  EvidenceRef,
} from './action-recommendation.types.js';

/**
 * Step 3.2 — ActionRecommendation GENERATOR (plan §10 card, §19 workflow, §12.4 board).
 *
 * Walks the current, material budget deltas; for each delta finds the clients (across
 * tenants) it is relevant to; and — when BOTH the materiality and relevance gates pass —
 * assembles ONE client-specific, evidence-backed action card per (client, delta,
 * actionType). Persistence is idempotent and tenant-isolated: a card is UPSERTED on the
 * `(tenant_id, client_id, COALESCE(delta_id,''), action_type)` dedupe unique index, and a
 * re-run only re-writes the GENERATED fields (narrative / audience / confidence / evidence /
 * priority) — it never clobbers human-managed workflow state (status / owner /
 * dismissalReason) and never resets a card that has moved past `new`.
 *
 * This is the DB-fetching + persistence half; all the policy lives in the pure cores
 * (action-gating / action-audience / action-card-assembly / action-recommendation.types).
 * It reuses the 2.3 relevance service's SYSTEM cross-tenant path so a delta fans out to
 * every relevant tenant in one pass, then re-scopes writes per tenant via `withTenant`.
 *
 * Money convention: $ MILLIONS throughout (project-wide; see program-element-writer).
 */

/** Default recency window (by computedAt) when `sinceDays` is supplied. */
const DEFAULT_SINCE_DAYS: number | undefined = undefined;

/** Committee audience members keyed off the delta's budget stage. Stable ids/labels so a
 * re-run produces the same audience rows. Authorization marks (HASC/SASC) and appropriations
 * marks (HAC-D/SAC-D) live in different ProgramElementYear fields; the delta's from/to ref
 * tells us which committee the card should reach. */
interface CommitteeDef {
  id: string;
  label: string;
}
const COMMITTEE_BY_REF: Record<string, CommitteeDef> = {
  hascMark: { id: 'cmte-hasc', label: 'House Armed Services Committee' },
  sascMark: { id: 'cmte-sasc', label: 'Senate Armed Services Committee' },
  hacDMark: { id: 'cmte-hac-d', label: 'House Appropriations Committee — Defense' },
  sacDMark: { id: 'cmte-sac-d', label: 'Senate Appropriations Committee — Defense' },
};

/** A loaded delta row, normalized for the generator. */
interface DeltaFacts {
  id: string;
  peCode: string;
  assertedFy: number;
  deltaType: string;
  fromRef: string | null;
  toRef: string | null;
  amountFrom: number | null;
  amountTo: number | null;
  deltaPct: number | null;
  materialityScore: number;
}

export interface GenerateOptions {
  /** Restrict generation to a single tenant (otherwise all relevant tenants). */
  tenantId?: string;
  /** Only consider deltas computed within the last N days (by computedAt). */
  sinceDays?: number;
  /**
   * Dry run: COMPUTE and COUNT every card that WOULD be generated, but skip the DB write
   * entirely (no upsert). Used by the CLI's default (no `--commit`) mode so it can report an
   * accurate count without persisting anything. (The old transaction-rollback approach did
   * NOT work under Prisma v5: each inner `withTenant` opens its own transaction that commits
   * immediately, so a dry run silently persisted.)
   */
  dryRun?: boolean;
}

export interface GenerateResult {
  generated: number;
}

@Injectable()
export class ActionRecommendationService {
  private readonly logger = new Logger(ActionRecommendationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly relevanceService: ClientPeRelevanceService,
  ) {}

  /**
   * Generate (idempotently upsert) action cards for every current, material delta and the
   * clients it is relevant to. Returns the number of cards created OR updated this run.
   */
  async generate(opts: GenerateOptions = {}): Promise<GenerateResult> {
    const sinceDays = opts.sinceDays ?? DEFAULT_SINCE_DAYS;
    const deltas = await this.loadCandidateDeltas(sinceDays);

    let generated = 0;
    for (const delta of deltas) {
      // Relevant (tenant, client) pairs across all tenants for this PE; optionally narrowed
      // to a single tenant. Reuses the 2.3 SYSTEM cross-tenant relevance path.
      let relevant = await this.relevanceService
        .getRelevantTenantClientsForPe(delta.peCode, { minScore: GATE_RELEVANCE_MIN })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `relevance lookup failed for PE ${delta.peCode} (non-fatal): ${message}`,
          );
          return [] as Array<{ tenantId: string; clientId: string; score: number }>;
        });
      if (opts.tenantId) {
        relevant = relevant.filter((r) => r.tenantId === opts.tenantId);
      }
      if (relevant.length === 0) continue;

      // G5: hoist the relevance-paths lookup OUT of the per-client loop. Compute the paths
      // for every relevant client of this PE ONCE per (tenant, delta) — each call scores up
      // to MAX_CANDIDATE_CLIENTS (200), so calling it per-client was an O(K×200) blow-up.
      // Group the (tenant, client) pairs by tenant, resolve the path map for each tenant, and
      // look up precomputed paths in the per-card path (fall back to no paths when absent).
      const tenantsThisDelta = [...new Set(relevant.map((r) => r.tenantId))];
      const pathsByTenant = new Map<string, Map<string, RelevancePathFact[]>>();
      for (const tenantId of tenantsThisDelta) {
        pathsByTenant.set(
          tenantId,
          await this.resolveRelevancePathsForTenant(tenantId, delta.peCode),
        );
      }

      for (const { tenantId, clientId, score } of relevant) {
        // Materiality + relevance gate. Both inclusive; skip silently when either fails.
        if (!shouldGenerate({ materialityScore: delta.materialityScore, relevanceScore: score })) {
          continue;
        }
        const relevancePaths = pathsByTenant.get(tenantId)?.get(clientId) ?? [];
        const wrote = await this.generateOneCard(tenantId, clientId, score, delta, {
          relevancePaths,
          dryRun: opts.dryRun === true,
        });
        if (wrote) generated += 1;
      }
    }

    return { generated };
  }

  /**
   * Candidate deltas: LIVE (supersededAt null), material (>= the materiality gate), optionally
   * filtered to the last `sinceDays` by computedAt. Read via the un-scoped client (the delta
   * table is GLOBAL public-domain data, no RLS).
   */
  private async loadCandidateDeltas(sinceDays?: number): Promise<DeltaFacts[]> {
    const where: Prisma.ProgramElementDeltaWhereInput = {
      supersededAt: null,
      materialityScore: { gte: GATE_MATERIALITY_MIN },
    };
    if (sinceDays !== undefined && Number.isFinite(sinceDays)) {
      const floor = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000);
      where.computedAt = { gte: floor };
    }
    const rows = await this.prisma.programElementDelta.findMany({
      where,
      select: {
        id: true,
        peCode: true,
        assertedFy: true,
        deltaType: true,
        fromRef: true,
        toRef: true,
        amountFrom: true,
        amountTo: true,
        deltaPct: true,
        materialityScore: true,
      },
      orderBy: { materialityScore: 'desc' },
    });
    return rows.map((r) => ({
      id: r.id,
      peCode: r.peCode,
      assertedFy: r.assertedFy,
      deltaType: r.deltaType,
      fromRef: r.fromRef,
      toRef: r.toRef,
      amountFrom: r.amountFrom === null ? null : r.amountFrom.toNumber(),
      amountTo: r.amountTo === null ? null : r.amountTo.toNumber(),
      deltaPct: r.deltaPct,
      materialityScore: r.materialityScore,
    }));
  }

  /**
   * Build + upsert a single card. Returns true when a row was created or updated (or, in dry
   * run, when a card WOULD be written). When `opts.dryRun` is set, everything is computed and
   * counted but the DB upsert is skipped entirely.
   */
  private async generateOneCard(
    tenantId: string,
    clientId: string,
    relevanceScore: number,
    delta: DeltaFacts,
    opts: { relevancePaths: RelevancePathFact[]; dryRun: boolean },
  ): Promise<boolean> {
    // 1) Initial action type from the delta shape (documented mapping below).
    let actionType = mapDeltaToActionType(delta);

    // 2) Global graph reads (PE title, program, matches, roles) — all RLS-exempt.
    const graph = await this.loadDeltaGraph(delta.peCode);

    // 3) Audience: accepted, non-stale roles on offices linked (accepted) to a program that
    //    has an accepted match for this PE, plus the stage-relevant committees. The pure
    //    selector enforces the §17 contact-use guardrail + §7 quarantine escalation.
    //
    //    G3: pass ONLY the statuses of the matches the card actually RELIES ON. When at least
    //    one accepted match exists, the card hangs off the accepted match(es), so we pass just
    //    the accepted statuses — a stray candidate/quarantined match among accepted ones must
    //    NOT over-escalate the whole card. Only when there is NO accepted match does the card
    //    lean on candidate/quarantined matches, in which case those statuses are passed and
    //    selectAudience escalates to escalate_uncertainty.
    const committees = committeesForDelta(delta);
    const acceptedStatuses = graph.matchStatuses.filter((s) => s === 'accepted');
    const reliedOnStatuses = acceptedStatuses.length > 0 ? acceptedStatuses : graph.matchStatuses;
    const { audience, forcedActionType, uncertaintyNotes } = selectAudience({
      personRoles: graph.personRoles,
      committees,
      matchStatuses: reliedOnStatuses,
    });
    if (forcedActionType) {
      // §7: an unconfirmed match the card relies on forces escalate_uncertainty.
      actionType = forcedActionType;
    }
    const uncertainty = uncertaintyNotes.length > 0 ? uncertaintyNotes.join(' ') : null;

    // 4) Narrative. Prefer the relevance PATHS (precomputed once per (tenant, delta) and
    //    passed in — see G5) so the why-it-matters sentence is client-specific; an empty array
    //    falls back to a generic relevance sentence.
    const clientName = await this.resolveClientName(tenantId, clientId);
    const relevancePaths = opts.relevancePaths;
    const card = assembleCard({
      actionType,
      clientName,
      peCode: delta.peCode,
      peTitle: graph.peTitle ?? delta.peCode,
      programName: graph.programName,
      delta: {
        deltaType: delta.deltaType,
        amountFrom: delta.amountFrom ?? 0,
        amountTo: delta.amountTo ?? 0,
        deltaPct: (delta.deltaPct ?? 0) * 100,
        assertedFy: delta.assertedFy,
        stageFrom: delta.fromRef ?? undefined,
        stageTo: delta.toRef ?? undefined,
      },
      relevancePaths,
      provisions: graph.provisions,
    });

    // 5) Confidence bands + evidence.
    const confidence = deriveConfidence({
      materialityScore: delta.materialityScore,
      matchStatuses: graph.matchStatuses,
      audience,
      relevanceScore,
    });
    const evidence = buildEvidence(delta, graph);

    // 6) Priority from materiality + relevance (deadline proximity folds in when a deadline
    //    exists; today deltas carry no deadline, so it contributes 0).
    const priority = computePriority({
      materialityScore: delta.materialityScore,
      relevanceScore,
    });

    // G1: dry run computes + counts the card but performs NO DB write. (An outer
    //    $transaction rollback does NOT work under Prisma v5 — each withTenant below opens its
    //    own transaction that commits immediately — so dry run must skip the upsert here.)
    if (opts.dryRun) {
      return true;
    }

    // generatedFields are re-written on every run. actionType is INCLUDED here (it is a
    // GENERATED field): if the underlying match flips accepted↔candidate between runs, the
    // card's actionType must flip too (G2). status / ownerUserId / dismissalReason / outcome
    // are human-managed and are NEVER part of an update.
    const generatedFields = {
      actionType,
      peCode: delta.peCode,
      programId: graph.programId,
      issueTitle: card.issueTitle,
      whatChanged: card.whatChanged,
      whyItMatters: card.whyItMatters,
      recommendedAction: card.recommendedAction,
      targetAudience: audience as unknown as Prisma.InputJsonValue,
      suggestedArtifactType: card.suggestedArtifactType ?? null,
      priority,
      confidence: confidence as unknown as Prisma.InputJsonValue,
      uncertainty,
      evidence: evidence as unknown as Prisma.InputJsonValue,
    };

    // 7) Idempotent upsert inside the tenant scope. Find the existing card by
    //    (tenantId, clientId, deltaId) ONLY — NOT actionType (G2). There is at most ONE card
    //    per (tenant, client, delta); looking up by actionType too would MISS when actionType
    //    changed between runs (e.g. accepted→candidate flips the card to escalate_uncertainty)
    //    and CREATE a second card, orphaning the first.
    return this.prisma.withTenant(tenantId, async (tx) => {
      const existing = await tx.actionRecommendation.findFirst({
        where: {
          tenantId,
          clientId,
          // dedupe key coalesces delta_id to '' — here deltaId is always set.
          deltaId: delta.id,
        },
        select: { id: true },
      });

      if (existing) {
        // Re-write generated fields ONLY (incl. actionType). status / ownerUserId /
        // dismissalReason / outcome are human-managed and intentionally left untouched, so a
        // triaged/assigned card is not reset by a regeneration.
        await tx.actionRecommendation.update({
          where: { id: existing.id },
          data: generatedFields,
        });
        return true;
      }

      try {
        await tx.actionRecommendation.create({
          data: {
            tenantId,
            clientId,
            deltaId: delta.id,
            status: 'new',
            ...generatedFields,
          },
        });
        return true;
      } catch (err) {
        // P2002: a concurrent generate (or the dedupe unique index) created the row between
        // our find and our create. Re-find by (tenantId, clientId, deltaId) and UPDATE the
        // generated fields instead of duplicating.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
          const raced = await tx.actionRecommendation.findFirst({
            where: { tenantId, clientId, deltaId: delta.id },
            select: { id: true },
          });
          if (raced) {
            await tx.actionRecommendation.update({
              where: { id: raced.id },
              data: generatedFields,
            });
            return true;
          }
        }
        throw err;
      }
    });
  }

  /**
   * Global graph reads for a PE: title, the accepted program match (program id + name), the
   * statuses of all matches the card relies on, and the eligible person-roles (accepted,
   * non-stale) reachable via an ACCEPTED office→program link to a program with an ACCEPTED
   * match for this PE. All tables here are GLOBAL (no RLS), read via the un-scoped client.
   */
  private async loadDeltaGraph(peCode: string): Promise<{
    peTitle: string | null;
    programId: string | null;
    programName?: string;
    matchStatuses: string[];
    personRoles: AudiencePersonRole[];
    sources: Array<{ sourceDocumentId: string | null; page: number | null }>;
    provisions: ProvisionFact[];
  }> {
    const [pe, matches, sourceRows, provisionLinks] = await Promise.all([
      this.prisma.programElement.findUnique({
        where: { peCode },
        select: { title: true },
      }),
      this.prisma.peProgramMatch.findMany({
        where: { peCode },
        select: {
          status: true,
          programId: true,
          program: { select: { id: true, canonicalName: true } },
        },
      }),
      this.prisma.programElementSource.findMany({
        where: { peCode },
        select: { sourceDocumentId: true, pageNumber: true },
        take: 20,
      }),
      // G5 (§8.2 "show report language"): committee report provisions linked
      // to THIS PE by an ACCEPTED link (verbatim pe_code matches — never the
      // review-pending fuzzy ones), newest fiscal year first, bounded.
      this.prisma.provisionPeLink.findMany({
        where: { peCode, reviewStatus: 'accepted' },
        select: {
          provision: {
            select: {
              id: true,
              committee: true,
              fy: true,
              heading: true,
              text: true,
              actionType: true,
            },
          },
        },
        orderBy: { provision: { fy: 'desc' } },
        take: 5,
      }),
    ]);

    const matchStatuses = matches.map((m) => m.status);
    const accepted = matches.filter((m) => m.status === 'accepted');
    // The card "relies on" the accepted match when present; otherwise it leans on the best
    // available (candidate/quarantined) match, which selectAudience will escalate on.
    const primary = accepted[0] ?? matches[0];
    const programId = primary?.programId ?? null;
    const programName = primary?.program?.canonicalName;

    // Person-roles only when there is a confirmed program to hang them off.
    const acceptedProgramIds = [...new Set(accepted.map((m) => m.programId))];
    const personRoles =
      acceptedProgramIds.length > 0 ? await this.loadEligiblePersonRoles(acceptedProgramIds) : [];

    const provisions: ProvisionFact[] = provisionLinks
      .map((l) => l.provision)
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({
        id: p.id,
        committee: p.committee,
        fy: p.fy,
        heading: p.heading,
        text: p.text,
        actionType: p.actionType,
      }));

    return {
      peTitle: pe?.title ?? null,
      programId,
      programName,
      matchStatuses,
      personRoles,
      sources: sourceRows.map((s) => ({
        sourceDocumentId: s.sourceDocumentId,
        page: s.pageNumber,
      })),
      provisions,
    };
  }

  /**
   * Person-roles for the card audience: accepted + non-stale roles at offices that have an
   * ACCEPTED office→program link (`reviewStatus = accepted`) to one of the accepted-match
   * programs. The role label is the person's full name. The pure selector still applies the
   * contact-use guardrail, so this layer only needs to gather candidate rows.
   */
  private async loadEligiblePersonRoles(programIds: string[]): Promise<AudiencePersonRole[]> {
    const links = await this.prisma.programOfficeProgramLink.findMany({
      where: { programId: { in: programIds }, reviewStatus: 'accepted' },
      select: { officeId: true },
    });
    const officeIds = [...new Set(links.map((l) => l.officeId))];
    if (officeIds.length === 0) return [];

    const roles = await this.prisma.personRole.findMany({
      where: { officeId: { in: officeIds }, reviewStatus: 'accepted', staleAt: null },
      select: {
        id: true,
        contactUse: true,
        reviewStatus: true,
        staleAt: true,
        person: { select: { fullName: true } },
      },
    });
    return roles.map((r) => ({
      id: r.id,
      label: r.person?.fullName ?? 'Unknown',
      contactUse: r.contactUse,
      reviewStatus: r.reviewStatus,
      staleAt: r.staleAt ? r.staleAt.toISOString() : null,
    }));
  }

  /** Resolve the client's display name under its tenant (RLS-scoped). Falls back to the id. */
  private async resolveClientName(tenantId: string, clientId: string): Promise<string> {
    return this.prisma.withTenant(tenantId, async (tx) => {
      const client = await tx.client.findUnique({
        where: { id: clientId },
        select: { name: true },
      });
      return client?.name ?? clientId;
    });
  }

  /**
   * Client-specific relevance PATHS for the why-it-matters narrative, computed ONCE per
   * (tenant, delta) and returned as a Map<clientId, RelevancePathFact[]> (G5: hoisted out of
   * the per-client loop — the underlying read scores up to MAX_CANDIDATE_CLIENTS per call).
   * Uses the tenantId-only relevance method (G4: no unsound `as never` cast). Best-effort: a
   * failure degrades to an empty map (each card then renders a generic relevance sentence).
   */
  private async resolveRelevancePathsForTenant(
    tenantId: string,
    peCode: string,
  ): Promise<Map<string, RelevancePathFact[]>> {
    const byClient = new Map<string, RelevancePathFact[]>();
    try {
      const rows = await this.relevanceService.getRelevantClientsForPeByTenantId(tenantId, peCode, {
        minScore: 0,
      });
      for (const row of rows) {
        byClient.set(row.clientId, pathsToFacts(row.paths ?? []));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`relevance-path recompute failed (non-fatal): ${message}`);
    }
    return byClient;
  }
}

// ── pure helpers (no `this`) ──────────────────────────────────────────────────────

/**
 * DELTA → ACTION TYPE mapping (documented, deterministic). Small + intentional:
 *   - new_start                                 -> client_alert  (a brand-new line: inform first)
 *   - termination / zeroed                      -> restore_cut   (money removed: fight to restore)
 *   - mark_vs_request / enacted_vs_request /
 *     conference_vs_marks / pb_vs_prior_pb with
 *       a POSITIVE move (amountTo > amountFrom)  -> protect_funding (defend the gain)
 *       a NEGATIVE/zero move (amountTo <= from)  -> restore_cut     (recover the loss)
 *   - everything else                           -> client_alert  (safe default)
 * NOTE: an unconfirmed (candidate/quarantined) program match later OVERRIDES this to
 * escalate_uncertainty via selectAudience.forcedActionType.
 */
/**
 * G5 (mark-impact §8.2 "propose next actions"): a cut at an APPROPRIATIONS stage
 * (HAC-D / SAC-D / enacted) is strategically distinct from a cut at an
 * authorization mark. The next action for money lost in appropriations is to
 * pursue restoration/directive language in the report or the next cycle —
 * `add_report_language` — not the generic `restore_cut`. Authorization-stage
 * cuts (HASC/SASC marks) keep `restore_cut` (the fight there is the bill text,
 * not report language). Positive moves stay `protect_funding` at every stage.
 * `toRef` identifies the appropriations stages unambiguously; the appropriations
 * `conference` column is reserved/unpopulated today (its deltas would arrive
 * once a loader lands — a follow-up), so it is deliberately absent here.
 */
const APPROPRIATIONS_STAGE_REFS = new Set(['hacDMark', 'sacDMark', 'enacted']);

export function mapDeltaToActionType(delta: {
  deltaType: string;
  amountFrom: number | null;
  amountTo: number | null;
  toRef?: string | null;
}): ActionType {
  switch (delta.deltaType) {
    case 'new_start':
      return 'client_alert';
    case 'termination':
    case 'zeroed':
      return 'restore_cut';
    case 'mark_vs_request':
    case 'enacted_vs_request':
    case 'conference_vs_marks':
    case 'mark_vs_mark':
    case 'pb_vs_prior_pb':
    case 'outyear_shift': {
      const from = delta.amountFrom ?? 0;
      const to = delta.amountTo ?? 0;
      if (to > from) return 'protect_funding';
      // A cut: route appropriations-stage losses to report-language advocacy.
      return delta.toRef && APPROPRIATIONS_STAGE_REFS.has(delta.toRef)
        ? 'add_report_language'
        : 'restore_cut';
    }
    default:
      return 'client_alert';
  }
}

/**
 * Committees relevant to a delta's budget stage: authorization marks (HASC/SASC) and
 * appropriations marks (HAC-D/SAC-D) come from distinct ProgramElementYear fields, named in
 * the delta's from/to ref. We include the committee for each mark-field that the delta
 * touches; conference/enacted/request refs carry no single committee. Returns stable
 * ids/labels so a re-run yields the same audience.
 */
export function committeesForDelta(delta: {
  fromRef: string | null;
  toRef: string | null;
}): AudienceCommittee[] {
  const out: AudienceCommittee[] = [];
  const seen = new Set<string>();
  for (const ref of [delta.fromRef, delta.toRef]) {
    if (!ref) continue;
    const def = COMMITTEE_BY_REF[ref];
    if (def && !seen.has(def.id)) {
      seen.add(def.id);
      out.push({ id: def.id, label: def.label });
    }
  }
  return out;
}

/** Map a 0..1 score to a confidence band (high >= 0.7, medium >= 0.4, else low). */
function band(score: number): ConfidenceBand {
  if (score >= 0.7) return 'high';
  if (score >= 0.4) return 'medium';
  return 'low';
}

/**
 * Per-dimension confidence: delta from materiality, programMatch from the best match status,
 * peopleMatch from audience presence, clientRelevance from the relevance score.
 */
function deriveConfidence(input: {
  materialityScore: number;
  matchStatuses: string[];
  audience: AudienceMember[];
  relevanceScore: number;
}): ConfidenceBands {
  const hasAccepted = input.matchStatuses.includes('accepted');
  const hasAnyMatch = input.matchStatuses.length > 0;
  const programMatch: ConfidenceBand = hasAccepted ? 'high' : hasAnyMatch ? 'low' : 'low';
  const hasPerson = input.audience.some((a) => a.kind === 'person_role');
  const hasCommittee = input.audience.some((a) => a.kind === 'committee');
  const peopleMatch: ConfidenceBand = hasPerson ? 'high' : hasCommittee ? 'medium' : 'low';
  return {
    delta: band(input.materialityScore),
    programMatch,
    peopleMatch,
    clientRelevance: band(input.relevanceScore),
  };
}

/** Evidence refs: the delta, the PE source pages, the program match, and (G5)
 *  any committee report provisions on record for this PE. */
function buildEvidence(
  delta: DeltaFacts,
  graph: {
    programId: string | null;
    sources: Array<{ sourceDocumentId: string | null; page: number | null }>;
    provisions: ProvisionFact[];
  },
): EvidenceRef[] {
  const refs: EvidenceRef[] = [{ kind: 'delta', deltaId: delta.id }];
  for (const s of graph.sources) {
    refs.push({
      kind: 'source',
      sourceDocumentId: s.sourceDocumentId ?? undefined,
      page: s.page ?? undefined,
    });
  }
  if (graph.programId) {
    refs.push({ kind: 'program_match', programId: graph.programId, note: 'program match' });
  }
  // G5: a real provision ref per linked committee report provision — the
  // reviewer can pull the verbatim language behind the mark.
  for (const p of graph.provisions) {
    refs.push({
      kind: 'provision',
      provisionId: p.id,
      note: `${p.committee} FY${p.fy}: ${p.heading}`,
    });
  }
  return refs;
}

/** Priority 0..100 from materiality + relevance (and deadline proximity when present). */
export function computePriority(input: {
  materialityScore: number;
  relevanceScore: number;
  deadline?: Date | null;
}): number {
  let proximity = 0;
  if (input.deadline) {
    const days = (input.deadline.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
    // Closer deadlines push priority up; clamp to [0,1].
    proximity = Math.max(0, Math.min(1, (30 - days) / 30));
  }
  const blended = 0.5 * input.materialityScore + 0.4 * input.relevanceScore + 0.1 * proximity;
  return Math.round(blended * 100);
}

/** Convert §2.3 PathResult[] to the card-assembly RelevancePathFact[] shape. */
function pathsToFacts(paths: PathResult[]): RelevancePathFact[] {
  return paths.map((p) => ({ path: p.path, evidence: p.evidence }));
}
