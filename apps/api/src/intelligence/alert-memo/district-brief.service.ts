import { Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  recordAiUsageEvent,
  parseProviderUsage,
  DELIVERABLE_RISK_TIERS,
  type TenantContext,
} from '@capiro/shared';
import { runAuditor, type LedgerEntry } from '@capiro/meriv2-core';
import { applySkepticEscalation } from './skeptic-escalation.js';
import { applyEntailmentGate, resolveEntailmentMode } from './entailment-gate.js';
import { resolveTenantAuditorMode } from '../../common/auditor-mode.js';
import { AiCredentialResolverService } from '../../engagement/ai-credential-resolver.service.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { ContextCompilerService } from '../../context/context-compiler.service.js';
import { ReviewsService } from '../../reviews/reviews.service.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  RepresentationResolverService,
  type FederalMemberSummary,
  type RepresentationResult,
  type StateLegislatorSummary,
} from '../../clients/representation-resolver.service.js';
import { renderMemoDocx, type MemoDocInput } from './alert-memo-docx.js';
import type { AlertMemoAlertInput } from './alert-memo.types.js';
import type { DistrictBriefResult } from './district-brief.types.js';

/**
 * District-impact one-pager (Phase 1 M1.5, PD6). A sibling of `AlertMemoService`
 * grounded in the District Impact Engine instead of just the alert: the fact
 * sheet adds the facility's footprint and its resolved federal + state
 * representation (M1.3's `RepresentationResolverService` — the SAME
 * deterministic join the M5 targeting-brief validator will use, so a claim
 * here means the same thing everywhere). Kept self-contained (not sharing
 * `AlertMemoService`'s private helpers) — this codebase's convention for
 * grounded-generation services is a local copy of the claims/prompt/grounding
 * logic per site rather than a shared abstraction (see alert-memo.service.ts's
 * own "borrowed from the artifact generator" comment).
 */
const BRIEF_TIMEOUT_MS = 60_000;
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const SECTION_ORDER = [
  'Facility & footprint',
  'Who represents it',
  'The bill/rule at stake',
  'District impact',
  'The ask',
] as const;

const SYSTEM_PROMPT = `You are a senior government-affairs strategist writing a concise DISTRICT-IMPACT BRIEF for a lobbying firm's account team, connecting a specific legislative or regulatory development to ONE of the client's physical facilities and the elected officials who represent it.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...) covering the facility, its representatives (federal and/or state — only those actually resolved are listed), and the bill/rule/hearing at stake.
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a number, date, name, committee assignment, vote, or quote that is not in a claim.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- If no representative is listed for a chamber, say nothing about that chamber — do not guess who holds the seat.
- Use the ABOUT-THE-CLIENT brief to shape tone and "the ask" — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page. "The ask" = 1-3 concrete, facility-specific next steps (e.g. a constituent meeting, a plant tour invitation, a letter citing local jobs/investment).
Return ONLY JSON: {"sections":[{"heading":"Facility & footprint","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Facility & footprint, Who represents it, The bill/rule at stake, District impact, The ask. No prose outside the JSON.`;

interface Claim {
  id: string;
  text: string;
  url?: string | null;
}

interface GenSection {
  heading: string;
  paragraphs: Array<{ text: string; claimIds: string[] }>;
}

interface BriefFacility {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
  employeeCount: number | null;
}

@Injectable()
export class DistrictBriefService {
  private readonly logger = new Logger(DistrictBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly representation: RepresentationResolverService,
    private readonly credentials: AiCredentialResolverService,
    private readonly contextCompiler: ContextCompilerService,
    private readonly engagement: EngagementService,
    private readonly reviews: ReviewsService,
  ) {}

  async generate(
    ctx: TenantContext,
    clientId: string,
    facilityId: string,
    alert: AlertMemoAlertInput,
    replaceAttachmentId?: string,
  ): Promise<DistrictBriefResult> {
    const row = await this.prisma.withTenant(ctx.tenantId, (tx) =>
      tx.clientFacility.findFirst({
        where: { tenantId: ctx.tenantId, id: facilityId, clientId },
        include: { client: { select: { id: true, name: true } } },
      }),
    );
    if (!row) throw new NotFoundException('Facility not found for this client');
    const facility: BriefFacility = {
      id: row.id,
      name: row.name,
      city: row.city,
      state: row.state,
      employeeCount: row.employeeCount,
    };
    const clientName = row.client.name;

    const repResult = await this.representation.representativesForFacility(row);
    const committeeRoles = await this.resolveCommitteeRoles(
      alert.committee,
      collectBioguideIds(repResult),
    );

    const { claims, sources } = buildDistrictClaims(alert, facility, repResult, committeeRoles);
    const { steering, memoryFilesUsed } = await this.loadSteering(ctx, clientId, clientName);

    const cred = await this.credentials.resolveProvider(ctx, 'anthropic');
    if (!cred)
      throw new ServiceUnavailableException('No Anthropic credential available for this tenant');

    let sections: GenSection[] = [];
    let lowConfidence = false;
    let rawUsage: unknown = null;
    let entailmentUsage: unknown[] = [];
    try {
      const { text, raw } = await this.callAnthropic(
        cred.apiKey,
        cred.model,
        buildUserPrompt(alert, facility, clientName, steering, claims),
      );
      rawUsage = raw;
      sections = verifyGrounded(parseSections(text), claims);
      // MP-12 (Gate I phase d): shadow-only entailment measurement. Clamped to
      // 'shadow' regardless of MERI_ENTAILMENT_MODE — this surface has no
      // saveEdited equivalent to guard a hold (I_GOVERNANCE.md phase d-3), so
      // it must never enforce even once alert-memo's env var is set for CG-01.
      // `held` is deliberately never adopted from this: entailment-gate.ts:169
      // guarantees shadow's `held` is always false, and the assignment is
      // omitted here anyway as a second, structural guarantee against it ever
      // holding a brief in this gate. Sits inside this try/catch exactly like
      // alert-memo's call, so an entailment throw falls through to the
      // existing scaffold path — the correct fail-open.
      const briefEntailmentMode =
        resolveEntailmentMode(process.env.MERI_ENTAILMENT_MODE) === 'off' ? 'off' : 'shadow';
      // d-2: the total BEFORE the gate runs, so the log line below can state
      // whether this generation would have held (every paragraph rejected) —
      // shadow's own `held` is hardcoded false (entailment-gate.ts:169), so
      // that signal has to be recomputed here for it to be measurable at all.
      const paragraphsBeforeEntailment = sections.reduce((n, s) => n + s.paragraphs.length, 0);
      const entail = await applyEntailmentGate({
        sections,
        claims,
        cred: { apiKey: cred.apiKey, model: cred.model },
        logger: this.logger,
        modeOverride: briefEntailmentMode,
      });
      sections = entail.sections;
      entailmentUsage = entail.usage;
      if (entail.findings.length) {
        // d-2: grep this prefix + would-hold=true to compute a hold-rate proxy
        // over a real corpus before ever proposing enforce for this surface.
        const wouldHold = entail.findings.length === paragraphsBeforeEntailment;
        this.logger.warn(
          `[meri-entailment:shadow] district brief — ${entail.findings.length}/${paragraphsBeforeEntailment} ` +
            `paragraph(s) would fail entailment (would-hold=${wouldHold}): ` +
            entail.findings.map((f) => `${f.heading}/${f.verdict}: ${f.reason}`).join(', '),
        );
      }
    } catch (err) {
      this.logger.warn(
        `district-brief generation failed (${(err as Error).message}); using scaffold`,
      );
    }
    if (!sections.length) {
      sections = scaffold(alert, facility, claims);
      lowConfidence = true;
    }

    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      'district_brief',
      {
        provider: 'anthropic',
        model: cred.model,
        usage: parseProviderUsage(rawUsage),
        usedTenantKey: cred.usedTenantKey,
      },
    );

    // §4.9 precedent (alert-memo.service.ts): an unmetered BYOK LLM call is a
    // billing defect. Only fires when the gate actually ran (mode !== 'off').
    for (const raw of entailmentUsage) {
      await recordAiUsageEvent(
        { prisma: this.prisma, logger: this.logger },
        { tenantId: ctx.tenantId, userId: ctx.userId },
        'district_brief_entailment',
        {
          provider: 'anthropic',
          model: process.env.MERI_ENTAILMENT_MODEL || cred.model,
          usage: parseProviderUsage(raw),
          usedTenantKey: cred.usedTenantKey,
        },
      );
    }

    const title =
      `District brief — ${facility.name} — ${alert.billDisplayNum ?? alert.hearingTitle ?? alert.title}`.slice(
        0,
        200,
      );
    let markdown = toMarkdown(title, sections, sources, clientName, facility);

    // Wave-2 post-hoc auditor on the DISTRICT-BRIEF surface — SHADOW by default
    // (MERI_AUDITOR_MODE off = no-op). This surface has its own PRE-EXISTING
    // claim-citation grounding gate (verifyGrounded above); the auditor adds a
    // second, independent pass. Unlike the plain alert-memo, this service
    // already resolves a real representation lookup (`repResult`, from
    // `RepresentationResolverService.representativesForFacility` — the SAME
    // deterministic join M1.3/PD6 use) — that's a natural fit for a
    // `get_representation`-shaped ledger entry, which lets the auditor's D11
    // check verify that any "represents this district" claim in the assembled
    // brief actually traces to a district this turn's representation lookup
    // returned (never an inference). The `claims` fact sheet is included too so
    // D1 citation checks have real substance. Fully guarded; never breaks brief
    // generation.
    // held: set true only when the auditor returns decision==='hold' — which
    // decisionFor() produces ONLY under mode==='enforce' on this (blocking,
    // surface:'alert') surface with a finding. Under shadow/annotate it stays
    // false, so the auto-file below is unchanged by default. Mirrors
    // AlertMemoService: a held brief is generated and returned for review but
    // NOT auto-filed, and becomes a pending review_request (G4).
    let held = false;
    let heldReason = '';
    const auditorMode = await resolveTenantAuditorMode(this.prisma, ctx.tenantId);
    if (auditorMode !== 'off' && markdown.trim().length > 0) {
      try {
        const ledgerEntries: LedgerEntry[] = [
          // Always pushed (even when unresolved) — the lookup DID run this turn,
          // which is what the D11 check's "was get_representation called"
          // distinction cares about; an unresolved result serializes with no
          // district tokens, so it grounds nothing (as it should — the prompt's
          // own rule is "say nothing about that chamber" when unresolved).
          //
          // The auditor's D11 check confirms a claimed district by scanning this
          // entry's SERIALIZED text for a literal "STATE-NN" token — but
          // RepresentationResult stores state and district as separate JSON
          // fields (e.g. {state:"AL",district:5}), never joined with a dash, so
          // the raw JSON alone contains no such substring. Appending the SAME
          // "STATE-NN" token this file already renders into the memo via
          // formatFederalDistrict (below) is what lets a CORRECT claim ground
          // instead of being false-flagged as unsupported. (At-large districts —
          // formatFederalDistrict's "STATE-at-large" — don't fit D11's numeric
          // token shape; that narrow case stays an honest gap, not a broken fix.)
          {
            tool: 'get_representation',
            serialized: `${JSON.stringify(repResult)} ${
              !repResult.unresolved && repResult.federal.house?.district != null
                ? formatFederalDistrict(repResult.federal.house)
                : ''
            }`.trim(),
            result: repResult,
          },
        ];
        if (claims.length) {
          ledgerEntries.push({
            tool: 'district_brief_fact_sheet',
            serialized: JSON.stringify(claims),
            result: { claims },
            rowCount: claims.length,
          });
        }
        let verdict = runAuditor({
          output: markdown,
          ledger: { entries: ledgerEntries },
          surface: 'alert',
          mode: auditorMode,
        });
        // Wave-4 skeptic escalation (MERI_SKEPTIC_MODE, default off) — same
        // contract as alert-memo: shadow observes, enforce merges confident
        // refutations via the shared decision policy. Fail-open by contract.
        verdict = await applySkepticEscalation({
          verdict,
          output: markdown,
          ledger: { entries: ledgerEntries },
          cred: { apiKey: cred.apiKey, model: cred.model },
          logger: this.logger,
        });
        if (verdict.findings.length > 0) {
          this.logger.warn(
            `[meri-auditor:${auditorMode}] district brief — ${verdict.findings.length} finding(s), ` +
              `top=${verdict.topSeverity}, decision=${verdict.decision}: ` +
              verdict.findings.map((f) => `${f.check}/${f.severity}`).join(', '),
          );
          await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.meriAuditLedger.create({
              data: {
                tenantId: ctx.tenantId,
                surface: 'alert',
                mode: auditorMode,
                model: cred.model,
                decision: verdict.decision,
                topSeverity: verdict.topSeverity ?? null,
                findingCount: verdict.findings.length,
                findings: verdict.findings as unknown as Prisma.InputJsonValue,
                outputChars: markdown.length,
              },
            }),
          );
          if (auditorMode === 'annotate' || auditorMode === 'enforce') {
            const checks = [...new Set(verdict.findings.map((f) => f.check))].join(', ');
            markdown =
              `> ⚠️ **Unverified — ${verdict.findings.length} grounding finding(s) held for review ` +
              `(${checks}).** Treat flagged claims as unconfirmed until a reviewer clears them.\n\n` +
              markdown;
          }
          // Enforce = hold: block the auto-file below. decisionFor() returns
          // 'hold' only in enforce mode, so this is inert under shadow/annotate.
          held = verdict.decision === 'hold';
          if (held) {
            heldReason = `Grounding auditor: ${verdict.findings
              .map((f) => `${f.check} (${f.severity}): ${f.detail}`)
              .join('; ')}`.slice(0, 2000);
          }
        }
      } catch (err) {
        this.logger.warn(
          `[meri-auditor] district brief audit failed (brief unaffected): ${(err as Error).message}`,
        );
      }
    }

    // Render docx + auto-file — UNLESS held for review (enforce + finding). A
    // held brief is returned to the composer (markdown carries the Unverified
    // banner) but NOT filed to the client's Documents until a reviewer clears
    // it. G4: the hold becomes a pending review_request carrying everything
    // approve() needs to file the brief (markdown + title + client). The review
    // uses a district-brief-specific subject (facility+alert) so it never
    // collides with — or blocks — an alert-memo review for the same alert.
    let document: DistrictBriefResult['document'] = null;
    let reviewRequestId: string | null = null;
    if (held) {
      this.logger.warn(
        `[meri-auditor:enforce] district brief HELD for review — not auto-filed to client Documents`,
      );
      // c-8: the id is now RETURNED so the composer can offer "View review request"
      // instead of mislabeling a governed hold as an auto-file failure.
      reviewRequestId = await this.reviews.createSystem(ctx.tenantId, {
        riskTier: DELIVERABLE_RISK_TIERS.district_brief ?? 'high',
        surface: 'district-brief',
        subjectType: 'district-brief',
        subjectId: `${facilityId}:${alert.alertId}`,
        clientId,
        title,
        reason: heldReason || 'Grounding auditor held this district brief for review.',
        payload: { markdown, title, clientName, clientId, alertId: alert.alertId, facilityId },
        requestedBy: ctx.userId,
      });
    } else {
      try {
        const buffer = await renderMemoDocx(
          toMemoDocInput(clientName, facility, alert, sections, sources),
        );
        const fileName = `${title}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
        const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
          clientId,
          fileName,
          contentType: DOCX_MIME,
          buffer,
          source: 'district_brief',
        });
        document = { attachmentId: saved.id, fileName: saved.fileName };
        if (replaceAttachmentId) {
          await this.engagement
            .deleteAttachment(ctx, replaceAttachmentId)
            .catch((e) =>
              this.logger.warn(`replace prior district brief doc failed: ${(e as Error).message}`),
            );
        }
      } catch (err) {
        this.logger.error(
          `district-brief auto-file to Documents failed: ${(err as Error).message}`,
        );
      }
    }

    return {
      title,
      markdown,
      sections,
      sources,
      document,
      usedTenantKey: cred.usedTenantKey,
      model: cred.model,
      lowConfidence,
      memoryFilesUsed,
      held,
      reviewRequestId,
      heldReason,
      facility: {
        id: facility.id,
        name: facility.name,
        city: facility.city,
        state: facility.state,
      },
    };
  }

  /**
   * Best-effort federal committee role (Chair/Ranking Member/...) for the
   * alert's named committee. Only asserted when the free-text committee name
   * matches EXACTLY one current `CongressCommittee` — ambiguous or no match
   * yields no claim at all (never guess, PD2's own standard).
   */
  private async resolveCommitteeRoles(
    committeeName: string | null | undefined,
    bioguideIds: string[],
  ): Promise<Map<string, string>> {
    const roles = new Map<string, string>();
    const needle = (committeeName ?? '').trim().toLowerCase();
    if (!needle || !bioguideIds.length) return roles;
    const committees = await this.prisma.congressCommittee.findMany({
      where: { isCurrent: true },
      select: { systemCode: true, name: true },
    });
    const matches = committees.filter((c) => {
      const n = c.name.toLowerCase();
      return n.includes(needle) || needle.includes(n);
    });
    if (matches.length !== 1) return roles;
    const memberships = await this.prisma.congressCommitteeMembership.findMany({
      where: { systemCode: matches[0]!.systemCode, bioguideId: { in: bioguideIds } },
      select: { bioguideId: true, title: true },
    });
    for (const m of memberships) {
      if (m.title) roles.set(m.bioguideId, m.title);
    }
    return roles;
  }

  /** Pull the client's Memory files (voice/priorities/red-lines) + firm playbook as steering text. */
  private async loadSteering(
    ctx: TenantContext,
    clientId: string,
    clientName: string,
  ): Promise<{ steering: string; memoryFilesUsed: string[] }> {
    // Context Compiler v1 (G1): same conversion as AlertMemoService.loadSteering
    // (this service is its district twin). render:'all' keeps the historical
    // full-file steering; charBudget:8000 drops whole items as traced
    // 'over-budget' exclusions instead of slicing mid-file; superseded files
    // no longer steer (traced as 'superseded' exclusions).
    const LABEL_BY_TYPE: Record<string, string> = {
      'client-soul': 'client-soul',
      'client-compass': 'client-compass',
      'client-people': 'client-people',
      playbook: 'firm-playbook',
    };
    const blocks: string[] = [];
    const used: string[] = [];
    try {
      const packet = await this.contextCompiler.compile({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId,
        surface: 'district-brief',
        layers: ['client-steering', 'client-people', 'firm-playbook'],
        render: 'all',
        charBudget: 8000,
        ref: { clientId },
      });
      for (const type of ['client-soul', 'client-compass', 'client-people', 'playbook']) {
        const r = packet.rendered.find((x) => x.type === type);
        if (!r) continue;
        blocks.push(`## ${r.title ?? type}\n${r.body}`);
        used.push(LABEL_BY_TYPE[type] ?? type);
      }
    } catch (err) {
      this.logger.debug(`steering compile skipped: ${(err as Error).message}`);
    }
    const steering = blocks.length
      ? blocks.join('\n\n')
      : `(No client knowledge files on record for ${clientName}. Write a professional, neutral government-affairs brief.)`;
    return { steering: steering.slice(0, 8000), memoryFilesUsed: used };
  }

  /** The only network call. Direct Anthropic Messages with the resolved per-tenant key. */
  private async callAnthropic(
    apiKey: string,
    model: string,
    prompt: string,
  ): Promise<{ text: string; raw: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), BRIEF_TIMEOUT_MS);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 2000,
          // Zero-trust Wave 1 (RC8): district briefs restate districts/figures —
          // low temperature cuts the numeric-scramble sampling variance.
          temperature: 0.2,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: prompt }],
        }),
        signal: controller.signal,
      });
      const json = (await res.json()) as Record<string, unknown>;
      if (!res.ok) {
        throw new ServiceUnavailableException(
          `Anthropic failed: ${JSON.stringify(json).slice(0, 200)}`,
        );
      }
      const content = Array.isArray(json.content) ? json.content : [];
      const text = content
        .map((part) => {
          const r = part && typeof part === 'object' ? (part as Record<string, unknown>) : {};
          return r.type === 'text' && typeof r.text === 'string' ? r.text : '';
        })
        .join('\n')
        .trim();
      return { text, raw: json };
    } finally {
      clearTimeout(timer);
    }
  }
}

// ---- pure helpers ----------------------------------------------------------

function collectBioguideIds(rep: RepresentationResult): string[] {
  if (rep.unresolved) return [];
  const ids: string[] = [];
  if (rep.federal.house) ids.push(rep.federal.house.bioguideId);
  for (const s of rep.federal.senate) ids.push(s.bioguideId);
  return ids;
}

function formatFederalDistrict(m: FederalMemberSummary): string {
  return m.district == null
    ? `${m.state ?? ''}-at-large`.replace(/^-/, '')
    : `${m.state}-${String(m.district).padStart(2, '0')}`;
}

function buildDistrictClaims(
  alert: AlertMemoAlertInput,
  facility: BriefFacility,
  rep: RepresentationResult,
  committeeRoles: Map<string, string>,
): { claims: Claim[]; sources: DistrictBriefResult['sources'] } {
  const claims: Claim[] = [];
  const push = (text: string | null | undefined, url?: string | null) => {
    const t = (text ?? '').trim();
    if (!t) return;
    claims.push({ id: `c${claims.length + 1}`, text: t, url: url ?? null });
  };

  const location = [facility.city, facility.state].filter(Boolean).join(', ');
  push(`Facility: ${facility.name}${location ? ` in ${location}` : ''}`);
  if (facility.employeeCount != null) {
    push(`This facility employs approximately ${facility.employeeCount} people.`);
  }

  if (!rep.unresolved) {
    const h = rep.federal.house;
    if (h) {
      const role = committeeRoles.get(h.bioguideId);
      push(
        `U.S. Representative for this facility's district (${formatFederalDistrict(h)}): ${h.fullName}${h.party ? ` (${h.party})` : ''}${role ? `, ${role} on ${alert.committee}` : ''}.`,
      );
    }
    for (const s of rep.federal.senate) {
      const role = committeeRoles.get(s.bioguideId);
      push(
        `U.S. Senator for ${facility.state}: ${s.fullName}${s.party ? ` (${s.party})` : ''}${role ? `, ${role} on ${alert.committee}` : ''}.`,
      );
    }
    const describeState = (label: string, l: StateLegislatorSummary | null) => {
      if (!l) return;
      push(`${label} for this facility's district: ${l.name}${l.party ? ` (${l.party})` : ''}.`);
    };
    describeState('State Representative (lower chamber)', rep.state.lower);
    describeState('State Senator (upper chamber)', rep.state.upper);
  }

  push(`Alert: ${alert.title}`, alert.url);
  if (alert.actionText)
    push(
      `Official action${alert.actionDate ? ` (${alert.actionDate})` : ''}: ${alert.actionText}`,
      alert.url,
    );
  if (alert.billDisplayNum || alert.billTitle)
    push(`Bill: ${[alert.billDisplayNum, alert.billTitle].filter(Boolean).join(' — ')}`, alert.url);
  if (alert.committee) push(`Committee: ${alert.committee}`);
  if (alert.hearingTitle) push(`Hearing: ${alert.hearingTitle}`, alert.url);
  // HP-03 (Gate L phase a): state-bill framing, byte-identical in intent to
  // alert-memo.service.ts's twin. The jurisdiction claim exists so the model cannot
  // quietly describe a state bill as federal, and the deadline claim is the whole
  // point of a state-facing brief — a cutoff can kill a bill regardless of its
  // merits. Only pushed when the data exists: a state bill with no cutoff on record
  // gets no deadline claim at all (an honest gap, never a fabricated one).
  if (alert.sourceType === 'state_bill') {
    const jur = alert.jurisdiction && alert.jurisdiction !== 'US' ? alert.jurisdiction : null;
    push(
      jur
        ? `Jurisdiction: this is STATE legislation in ${jur}, not federal legislation.`
        : `Jurisdiction: this is STATE legislation, not federal legislation.`,
    );
  }
  const dl = alert.deadline;
  if (dl && (dl.cutoffType || dl.cutoffDate || dl.daysUntil != null)) {
    const parts = [
      dl.cutoffType ? `deadline type ${dl.cutoffType}` : null,
      dl.cutoffDate ? `date ${dl.cutoffDate}` : null,
      dl.daysUntil != null ? `${dl.daysUntil} day(s) remaining as of this alert` : null,
    ].filter(Boolean);
    push(`Procedural deadline: ${parts.join(', ')}.`);
  }
  if (alert.whyItMatters) push(`Relevance to client: ${alert.whyItMatters}`);
  if (alert.matchedTags?.length)
    push(`Matched the client's tracked interests: ${alert.matchedTags.join(', ')}`);
  for (const q of alert.quotes ?? []) {
    const who = q.speaker ? `${q.speaker}: ` : '';
    push(`Hearing statement — ${who}"${q.text}"`, alert.url);
  }

  // §4.6 — kept symmetric with alert-memo.service.ts's twin.
  const retrievedAt = new Date().toISOString().slice(0, 10);
  const sources = claims
    .filter((c) => c.url)
    .map((c) => ({
      claimId: c.id,
      label: c.text.slice(0, 80),
      url: c.url,
      retrievedAt,
      verification: verificationFor(c.url),
    }));
  return { claims, sources };
}

/** §4.6. Never returns 'verified'. Symmetric with alert-memo.service.ts. */
function verificationFor(url: string | null | undefined): 'official' | 'extracted' {
  return url && /^https?:\/\//i.test(url) ? 'official' : 'extracted';
}

function buildUserPrompt(
  alert: AlertMemoAlertInput,
  facility: BriefFacility,
  clientName: string,
  steering: string,
  claims: Claim[],
): string {
  return [
    `Write the district-impact brief for client "${clientName}" about facility "${facility.name}" regarding: ${alert.title}`,
    '',
    'ABOUT THE CLIENT (voice/priorities/red lines — steer by this, do not cite as fact):',
    steering,
    '',
    'FACT SHEET (the ONLY material you may assert; cite ids):',
    claims.map((c) => `${c.id}: ${c.text}`).join('\n'),
    '',
    'Return JSON: {"sections":[{"heading":"Facility & footprint","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]}',
  ].join('\n');
}

function parseSections(text: string): GenSection[] {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return [];
  let parsed: { sections?: unknown };
  try {
    parsed = JSON.parse(trimmed) as { sections?: unknown };
  } catch {
    const m = trimmed.match(/\{[\s\S]*\}/);
    if (!m) return [];
    try {
      parsed = JSON.parse(m[0]) as { sections?: unknown };
    } catch {
      return [];
    }
  }
  if (!Array.isArray(parsed.sections)) return [];
  const out: GenSection[] = [];
  for (const raw of parsed.sections) {
    if (!raw || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    if (typeof s.heading !== 'string') continue;
    const paras = Array.isArray(s.paragraphs) ? s.paragraphs : [];
    const paragraphs = paras
      .map((p) => {
        const r = p && typeof p === 'object' ? (p as Record<string, unknown>) : {};
        const t = typeof r.text === 'string' ? r.text.trim() : '';
        const ids = Array.isArray(r.claimIds)
          ? r.claimIds.filter((x): x is string => typeof x === 'string')
          : [];
        return { text: t, claimIds: ids };
      })
      .filter((p) => p.text);
    out.push({ heading: s.heading.trim(), paragraphs });
  }
  return out;
}

/**
 * Drop any paragraph that is not fully grounded (grounding gate). W3.3: a
 * paragraph must cite at least one claim AND every cited id must be a real
 * fact-sheet claim. The old `claimIds.every(...)` was VACUOUSLY TRUE for a
 * zero-citation paragraph (`[].every` === true), so ungrounded model prose —
 * asserting facts with no citation at all — sailed through into a
 * client-facing brief. Requiring `length > 0` closes that hole; a generation
 * that ends up fully uncited drops to zero sections and the caller downgrades
 * to the deterministic scaffold with lowConfidence=true.
 */
function verifyGrounded(sections: GenSection[], claims: Claim[]): GenSection[] {
  const valid = new Set(claims.map((c) => c.id));
  const out: GenSection[] = [];
  for (const s of sections) {
    const kept = s.paragraphs.filter(
      (p) => p.claimIds.length > 0 && p.claimIds.every((id) => valid.has(id)),
    );
    if (kept.length) out.push({ heading: s.heading, paragraphs: kept });
  }
  return out;
}

/** Deterministic fallback when generation fails or is fully ungrounded. */
function scaffold(
  alert: AlertMemoAlertInput,
  facility: BriefFacility,
  claims: Claim[],
): GenSection[] {
  const allIds = claims.map((c) => c.id);
  return [
    {
      heading: 'Facility & footprint',
      paragraphs: [{ text: facility.name, claimIds: claims[0] ? [claims[0].id] : [] }],
    },
    {
      heading: 'The bill/rule at stake',
      paragraphs: [{ text: alert.actionText || alert.title, claimIds: allIds.slice(0, 3) }],
    },
    {
      heading: 'District impact',
      paragraphs: alert.whyItMatters ? [{ text: alert.whyItMatters, claimIds: allIds }] : [],
    },
  ].filter((s) => s.paragraphs.length);
}

function toMarkdown(
  title: string,
  sections: GenSection[],
  sources: DistrictBriefResult['sources'],
  clientName: string,
  facility: BriefFacility,
): string {
  const lines: string[] = [`# ${title}`, `*Prepared for ${clientName} — ${facility.name}*`, ''];
  for (const s of sections) {
    lines.push(`## ${s.heading}`, '');
    for (const p of s.paragraphs) lines.push(withClaimAnchors(p.text, p.claimIds), '');
  }
  if (sources.length) {
    lines.push('## Sources', '');
    for (const src of sources) {
      lines.push(
        `- **[${src.claimId}]** ${src.label}` +
          (src.url ? ` — ${src.url}` : '') +
          (src.retrievedAt ? ` · retrieved ${src.retrievedAt}` : '') +
          (src.verification ? ` · ${src.verification}` : ''),
      );
    }
  }
  return lines.join('\n').trimEnd() + '\n';
}

/**
 * P1-15. BYTE-IDENTICAL to alert-memo.service.ts's withClaimAnchors — these two files are
 * deliberate near-duplicates and are kept symmetric rather than extracted (a shared
 * module would also need DistrictBriefResult['sources'] widened in lockstep; noted as a
 * follow-up, not done here). A symmetry test asserts both produce the same string.
 */
export function withClaimAnchors(text: string, claimIds: string[]): string {
  if (!claimIds.length) return text;
  return `${text} ${claimIds.map((id) => `[${id}]`).join('')}`;
}

function toMemoDocInput(
  clientName: string,
  facility: BriefFacility,
  alert: AlertMemoAlertInput,
  sections: GenSection[],
  sources: DistrictBriefResult['sources'],
): MemoDocInput {
  const reLine = `${facility.name}${alert.billDisplayNum ? ` — ${alert.billDisplayNum}` : alert.hearingTitle ? ` — ${alert.hearingTitle}` : ''}`;
  return {
    clientName,
    dateStr: formatBriefDate(alert.actionDate),
    reLine,
    sections: sections.map((s) => ({
      heading: s.heading,
      // P1-15: anchors ride into the DOCX as plain trailing text.
      paragraphs: s.paragraphs.map((p) => withClaimAnchors(p.text, p.claimIds)),
    })),
    sources: sources.map((s) => ({ label: s.label, url: s.url })),
  };
}

/** Long-form brief date; parses YYYY-MM-DD as a local date to avoid tz drift. */
function formatBriefDate(actionDate?: string | null): string {
  let d: Date;
  if (actionDate && /^\d{4}-\d{2}-\d{2}/.test(actionDate)) {
    const parts = actionDate.slice(0, 10).split('-').map(Number);
    d = new Date(parts[0] ?? 1970, (parts[1] ?? 1) - 1, parts[2] ?? 1);
  } else if (actionDate) {
    d = new Date(actionDate);
  } else {
    d = new Date();
  }
  if (Number.isNaN(d.getTime())) d = new Date();
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}
