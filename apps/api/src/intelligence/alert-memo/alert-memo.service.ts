import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import {
  recordAiUsageEvent,
  parseProviderUsage,
  billStatusLabel,
  classifySourceVerification,
  type SourceVerification,
  type TenantContext,
} from '@capiro/shared';
import { runAuditor, type LedgerEntry } from '@capiro/meriv2-core';
import { applySkepticEscalation } from './skeptic-escalation.js';
import { applyEntailmentGate } from './entailment-gate.js';
import { resolveTenantAuditorMode } from '../../common/auditor-mode.js';
import { AiCredentialResolverService } from '../../engagement/ai-credential-resolver.service.js';
import { EngagementService } from '../../engagement/engagement.service.js';
import { ContextCompilerService } from '../../context/context-compiler.service.js';
import { ReviewsService } from '../../reviews/reviews.service.js';
import { DELIVERABLE_RISK_TIERS, isTenantAdmin } from '@capiro/shared';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  DOCX_MIME,
  markdownToMemoDocInput,
  formatMemoDate,
  renderMemoDocx,
  type MemoDocInput,
} from './alert-memo-docx.js';
import type {
  AlertMemoAlertInput,
  AlertMemoProgramElement,
  AlertMemoResult,
} from './alert-memo.types.js';

/**
 * Generates a client-voiced, source-grounded MEMO from an intel alert and
 * auto-files it in the client's Documents.
 *
 * Grounding (borrowed from the artifact generator): the model may assert ONLY
 * the supplied claims (each with an id); it returns JSON sections whose
 * paragraphs cite claim ids; any paragraph citing an unknown claim is dropped.
 * The client's Memory files (client-soul / compass / people + firm playbook) are
 * injected as STEERING — voice, priorities, red lines — never as citable facts.
 * That split is what makes the memo bespoke without hallucinating.
 */
const MEMO_TIMEOUT_MS = 60_000;

/**
 * §4.5 / P0-08: the requested section list is per-source. `bill` is byte-identical to
 * the single pre-Gate-C SECTION_ORDER, so no existing memo changes shape. A sourceType
 * with no entry falls back to the bill order — never an empty list.
 */
const SECTION_ORDER_BY_SOURCE: Record<string, readonly string[]> = {
  bill: ['Bottom line', 'What happened', 'Why it matters', 'Recommended actions', 'Talking points'],
  // §4.5 (d-3): a hearing memo's value is the testimony, so the template asks for speaker
  // relevance, commitments, and a verbatim-quotes section instead of folding all of it
  // into "Key statements".
  hearing: [
    'Bottom line',
    'Key statements',
    'Speaker relevance',
    'Commitments & questions',
    'Why it matters',
    'Follow-up targets',
    'Verbatim quotes',
  ],
  combined: [
    'Bottom line',
    'What happened',
    'Why it matters',
    'Recommended actions',
    'Talking points',
  ],
  program_element: [
    'Bottom line',
    'Budget movement',
    'Authorization vs appropriation context',
    'Client program alignment',
    'Committee & program-office targets',
    'Recommended engagement',
  ],
  // §4.5 (d-1): a state bill lives or dies on procedural deadlines, so the template leads
  // with the cutoff/crossover risk rather than a generic "what happened".
  state_bill: [
    'Bottom line',
    'State procedural update',
    'Deadline & crossover risk',
    'District & facility impact',
    'State targets',
    'Coalition & opposition considerations',
  ],
  regulation: [
    'Bottom line',
    'Rule or action summary',
    'Comment & effective deadlines',
    'Covered entities',
    'Client compliance & policy impact',
    'Agency outreach options',
  ],
};

export function sectionOrderFor(sourceType: string): readonly string[] {
  return SECTION_ORDER_BY_SOURCE[sourceType] ?? SECTION_ORDER_BY_SOURCE['bill']!;
}

const SYSTEM_PROMPT = `You are a senior federal government-affairs strategist writing a concise internal MEMO for a lobbying firm's account team about a development affecting a specific client.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...).
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a number, date, name, bill, or quote that is not in a claim.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- Use the ABOUT-THE-CLIENT brief to shape tone, emphasis, and the recommended actions — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page. "Recommended actions" = 2-4 concrete, client-specific next steps.
Return ONLY JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Bottom line, What happened, Why it matters, Recommended actions, Talking points. No prose outside the JSON.`;

/**
 * P0-08 / §4.5: a Program Element movement is a budget fact, not a legislative one. The
 * bill prompt has no place to put a funding delta, an authorization-vs-appropriation
 * stage, or a program office — so a PE alert generated against it produced a memo that
 * silently dropped every figure the alert card displays.
 *
 * The arithmetic ban is the point: every dollar figure and delta is already a claim,
 * pre-computed by code (see fmtM in buildClaims), so the model has no reason to compute.
 */
const PE_SYSTEM_PROMPT = `You are a senior defense-budget government-affairs strategist writing a concise internal MEMO for a lobbying firm's account team about a Program Element funding movement affecting a specific client.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...).
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a dollar figure, percentage, fiscal year, PE code, or document reference that is not in a claim.
- NEVER compute or restate arithmetic. Every figure and delta you need is already a claim; use it verbatim.
- Distinguish AUTHORIZATION (NDAA) from APPROPRIATION (defense approps) explicitly, and say which stage this movement is at. If the fact sheet does not establish the stage, say the stage is not established rather than inferring it.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- Use the ABOUT-THE-CLIENT brief to shape tone, emphasis, and the recommended engagement — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page. "Recommended engagement" = 2-4 concrete, client-specific next steps naming the committee or program office where possible.
Return ONLY JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Bottom line, Budget movement, Authorization vs appropriation context, Client program alignment, Committee & program-office targets, Recommended engagement. No prose outside the JSON.`;

/**
 * §4.5 (d-3): a hearing memo's job is to carry testimony accurately. The Verbatim quotes
 * section is the risky one — a paraphrase presented as a quote is worse than no quote —
 * so the prompt requires character-exact reproduction from the claims only. buildClaims
 * already emits each quote as `Hearing statement — {speaker}: "{text}"`.
 */
const HEARING_SYSTEM_PROMPT = `You are a senior federal government-affairs strategist writing a concise internal MEMO for a lobbying firm's account team about a congressional HEARING affecting a specific client.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...).
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a number, date, name, bill, or quote that is not in a claim.
- In "Verbatim quotes", reproduce quotes CHARACTER-EXACT from the claims, in quotation marks, each attributed to the speaker named in that claim. Never paraphrase inside quotation marks, never merge two speakers, and never attribute a quote to someone the claim does not name. If a claim gives no speaker, say the speaker is not identified.
- "Speaker relevance" may only rest on what the fact sheet establishes about the speaker (committee, role). If it establishes nothing, say so rather than inferring influence.
- "Commitments & questions" covers what a member committed to or asked. If the fact sheet contains no commitment, say none was captured rather than manufacturing one.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- Use the ABOUT-THE-CLIENT brief to shape tone, emphasis, and follow-up targets — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page.
Return ONLY JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Bottom line, Key statements, Speaker relevance, Commitments & questions, Why it matters, Follow-up targets, Verbatim quotes. No prose outside the JSON.`;

/**
 * §4.5 (d-2, full-feature option): a state bill is a DEADLINE instrument — a committee
 * cutoff or crossover date can kill it regardless of merits — and its targets are state
 * legislators, not Congress. The federal prompt had nowhere to put either.
 */
const STATE_BILL_SYSTEM_PROMPT = `You are a senior STATE government-affairs strategist writing a concise internal MEMO for a lobbying firm's account team about a state legislative development affecting a specific client.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...).
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a number, date, chamber, bill, or deadline that is not in a claim.
- This is STATE legislation. Never describe it as federal, never call a state chamber "Congress", and name the state exactly as the fact sheet names it.
- Deadlines are the point: if the fact sheet establishes a committee cutoff, crossover, or sine die date, state it and what missing it would mean. If it establishes NO deadline, say the deadline posture is not established rather than inventing one.
- Never assert a district or facility impact the fact sheet does not support, and never name a state legislator who is not in a claim.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- Use the ABOUT-THE-CLIENT brief to shape tone, emphasis, and the recommended posture — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page.
Return ONLY JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Bottom line, State procedural update, Deadline & crossover risk, District & facility impact, State targets, Coalition & opposition considerations. No prose outside the JSON.`;

/**
 * §4.5 (d-2, full-feature option): a rulemaking has a comment window and an effective
 * date, and the client-facing question is compliance exposure — none of which the
 * bill-shaped prompt could express (which is why a regulation memo used to arrive with
 * null bill fields).
 */
const REGULATION_SYSTEM_PROMPT = `You are a senior regulatory-affairs strategist writing a concise internal MEMO for a lobbying firm's account team about an agency RULEMAKING or regulatory action affecting a specific client.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...).
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a docket number, agency, date, or CFR citation that is not in a claim.
- Distinguish a PROPOSED rule from a FINAL rule explicitly, and never describe a proposed rule as being in effect. If the fact sheet does not establish which it is, say the stage is not established.
- Deadlines are legally operative: state the comment deadline and the effective date ONLY as the fact sheet gives them. Never estimate, extend, or infer a deadline, and never say comments are open if the fact sheet does not establish that.
- "Covered entities" may only describe who the fact sheet says the rule applies to. Do NOT assert that the client is covered unless a claim establishes it — say what would determine coverage instead.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- Use the ABOUT-THE-CLIENT brief to shape tone, emphasis, and the outreach options — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page. This is not legal advice; do not tell the client what compliance steps are required, only what the action means and what the options are.
Return ONLY JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Bottom line, Rule or action summary, Comment & effective deadlines, Covered entities, Client compliance & policy impact, Agency outreach options. No prose outside the JSON.`;

const SYSTEM_PROMPT_BY_SOURCE: Record<string, string> = {
  program_element: PE_SYSTEM_PROMPT,
  hearing: HEARING_SYSTEM_PROMPT,
  state_bill: STATE_BILL_SYSTEM_PROMPT,
  regulation: REGULATION_SYSTEM_PROMPT,
};

/** bill and combined keep the original federal prompt, byte-identical. */
function systemPromptFor(sourceType: string): string {
  return SYSTEM_PROMPT_BY_SOURCE[sourceType] ?? SYSTEM_PROMPT;
}

interface Claim {
  id: string;
  text: string;
  url?: string | null;
}

interface GenSection {
  heading: string;
  paragraphs: Array<{ text: string; claimIds: string[] }>;
}

/** Stable marker inside the enforce/annotate grounding banner (see the prefix built at generation). */
export const HELD_BANNER_MARKER = 'grounding finding(s) held for review';

/**
 * P0-01: shown to a standard_user whose save was blocked by the held-memo
 * guard. Identical wording to the pre-fix single-lock message so no consumer's
 * error-string match breaks.
 */
export const HELD_MEMO_MESSAGE =
  'This memo is held for review. An admin or the assigned reviewer must approve it (Reviews queue) before it can be filed.';

@Injectable()
export class AlertMemoService {
  private readonly logger = new Logger(AlertMemoService.name);

  constructor(
    private readonly credentials: AiCredentialResolverService,
    private readonly contextCompiler: ContextCompilerService,
    private readonly engagement: EngagementService,
    private readonly prisma: PrismaService,
    private readonly reviews: ReviewsService,
  ) {}

  async generate(
    ctx: TenantContext,
    clientId: string,
    alert: AlertMemoAlertInput,
    clientName: string,
    replaceAttachmentId?: string,
  ): Promise<AlertMemoResult> {
    // Live bill-status re-query (5.2C / RC3 fix): the alert arrives pre-digested
    // from intel-api's Feed, which can go stale between alert time and
    // drafting time. Best-effort — `billTruthBlock` already returns null for a
    // hearing session id (no matching CongressBill row) or any lookup error is
    // swallowed, so a failure here never blocks memo generation.
    // P0-08 / §4.5: a PE alert's sourceRef is a PE CODE and a regulation alert's is a
    // rule document id — neither is a bill id, so billTruthBlock would return null
    // anyway. The explicit skip saves a query and documents the intent.
    const NO_LIVE_BILL = new Set(['hearing', 'program_element', 'regulation']);
    const liveBill =
      !NO_LIVE_BILL.has(alert.sourceType) && alert.sourceRef
        ? await this.engagement.billTruthBlock(alert.sourceRef).catch(() => null)
        : null;
    const { claims, sources } = buildClaims(
      alert,
      liveBill ? { status: liveBill.raw.status, statusAt: liveBill.raw.statusAt } : null,
    );
    const { steering, memoryFilesUsed, contextExcluded } = await this.loadSteering(
      ctx,
      clientId,
      clientName,
    );

    const cred = await this.credentials.resolveProvider(ctx, 'anthropic');
    if (!cred)
      throw new ServiceUnavailableException('No Anthropic credential available for this tenant');

    let sections: GenSection[] = [];
    let lowConfidence = false;
    let rawUsage: unknown = null;
    // §4.7: set when the entailment gate dropped EVERY paragraph under enforce.
    let entailmentHeld = false;
    let entailmentDropped: AlertMemoResult['entailmentDropped'] = [];
    let entailmentUsage: unknown[] = [];
    try {
      const { text, raw } = await this.callAnthropic(
        cred.apiKey,
        cred.model,
        buildUserPrompt(alert, clientName, steering, claims),
        systemPromptFor(alert.sourceType),
      );
      rawUsage = raw;
      sections = verifyGrounded(parseSections(text), claims);
      // §4.7: the SECOND gate, immediately after verifyGrounded and before the scaffold
      // fallback below. verifyGrounded proves a paragraph cites a real claim; this proves
      // the cited claim actually entails it. Default OFF (MERI_ENTAILMENT_MODE), and the
      // whole block sits inside this try/catch, so an entailment throw falls through to
      // the existing scaffold path — the correct fail-open.
      const entail = await applyEntailmentGate({
        sections,
        claims,
        cred: { apiKey: cred.apiKey, model: cred.model },
        logger: this.logger,
      });
      sections = entail.sections;
      entailmentHeld = entail.held;
      entailmentDropped = entail.findings.map((f) => ({
        heading: f.heading,
        text: f.text,
        reason: f.reason,
      }));
      entailmentUsage = entail.usage;
      if (entail.findings.length) {
        this.logger.warn(
          `[meri-entailment] ${entail.findings.length} paragraph(s) failed entailment: ` +
            entail.findings.map((f) => `${f.heading}/${f.verdict}`).join(', '),
        );
      }
    } catch (err) {
      this.logger.warn(`alert-memo generation failed (${(err as Error).message}); using scaffold`);
    }
    if (!sections.length) {
      sections = scaffold(alert, claims);
      lowConfidence = true;
    }

    await recordAiUsageEvent(
      { prisma: this.prisma, logger: this.logger },
      { tenantId: ctx.tenantId, userId: ctx.userId },
      'alert_memo',
      {
        provider: 'anthropic',
        model: cred.model,
        usage: parseProviderUsage(rawUsage),
        usedTenantKey: cred.usedTenantKey,
      },
    );

    // §4.9: the entailment gate is a SECOND outbound LLM call on the tenant's BYOK key.
    // An unmetered LLM call is a billing defect, so it is attributed to its own workflow
    // rather than folded into the memo's. Only fires when the gate actually called out.
    for (const raw of entailmentUsage) {
      await recordAiUsageEvent(
        { prisma: this.prisma, logger: this.logger },
        { tenantId: ctx.tenantId, userId: ctx.userId },
        'alert_memo_entailment',
        {
          provider: 'anthropic',
          model: process.env.MERI_ENTAILMENT_MODEL || cred.model,
          usage: parseProviderUsage(raw),
          usedTenantKey: cred.usedTenantKey,
        },
      );
    }

    // P0-08: a PE alert has neither a billDisplayNum nor a hearingTitle, so the title
    // used to fall all the way back to the raw headline.
    const subject = alert.programElement?.peCode
      ? `${alert.programElement.peCode}${alert.programElement.title ? ` — ${alert.programElement.title}` : ''}`
      : (alert.billDisplayNum ??
        // §4.5: a regulation has no bill number, so it used to fall back to the raw
        // headline; prefer the rule title.
        alert.regulation?.ruleTitle ??
        alert.hearingTitle ??
        alert.title);
    const title = `Client memo — ${subject}`.slice(0, 200);
    let markdown = toMarkdown(title, sections, claims, sources, clientName);

    // Wave-2 post-hoc auditor on the ALERT-MEMO surface — SHADOW by default
    // (MERI_AUDITOR_MODE off = no-op). This surface has its own PRE-EXISTING
    // claim-citation grounding gate (verifyGrounded above) which is the primary
    // defense; the auditor adds a second, independent pass over the assembled
    // markdown for classes that gate doesn't cover (vehicle conflation, reversed
    // funding direction, stale/failed-rule framing, etc). Since 5.2C (2026-07-12)
    // a live `get_bill_status`-shaped ledger entry rides alongside the fact
    // sheet whenever the alert resolves to a real bill (see `liveBill` above),
    // so `checkFailedRuleFraming`/`checkSponsorExistence`/`checkAsOfFreshness`
    // are no longer circular against the frozen Feed snapshot; there is still no
    // PE/procurement data on this surface (the alert Feed is bill/hearing-only),
    // so PE-keyed checks remain inert here. Fully guarded; never breaks memo
    // generation.
    // held: set true only when the auditor returns decision==='hold' — which
    // decisionFor() produces ONLY under mode==='enforce' on this (blocking)
    // surface with a finding. Under shadow/annotate it stays false, so the
    // auto-file below is unchanged by default. When held, the memo is generated
    // and returned for review but NOT auto-filed to the client's Documents
    // (Phase 2.5-1, "hold as draft, block send/file").
    // §4.7: an all-dropped entailment result is a hold in its own right, independent of
    // the auditor. Seeding `held`/`heldReason` here (rather than only inside the auditor
    // block) means Gate A's saveEdited locks and the review_request emission cover it with
    // NO further change — which is why phase g is last.
    let held = entailmentHeld;
    let heldReason = entailmentHeld
      ? 'Entailment gate: every paragraph failed entailment against its cited claims.'
      : '';
    let reviewRequestId: string | null = null;
    // Gate I (CG-01): tracks whether the AUDITOR specifically produced 'hold',
    // as distinct from `held` (which is OR-ed with entailment). Feeds holdSource
    // on the generation record below — 'auditor' | 'entailment' | 'both'.
    let auditorHeld = false;
    const auditorMode = await resolveTenantAuditorMode(this.prisma, ctx.tenantId);
    if (auditorMode !== 'off' && markdown.trim().length > 0) {
      try {
        const ledgerEntries: LedgerEntry[] = [];
        if (claims.length) {
          ledgerEntries.push({
            tool: 'alert_fact_sheet',
            serialized: JSON.stringify(claims),
            result: { claims },
            rowCount: claims.length,
          });
        }
        if (liveBill) {
          const b = liveBill.raw;
          ledgerEntries.push({
            tool: 'get_bill_status',
            serialized: liveBill.text,
            result: {
              billId: b.id,
              status: b.status,
              statusAt: b.statusAt ? new Date(b.statusAt).toISOString() : null,
              ...(b.sponsorName ? { sponsor: { name: b.sponsorName } } : {}),
            },
          });
        }
        let verdict = runAuditor({
          output: markdown,
          ledger: { entries: ledgerEntries },
          surface: 'alert',
          mode: auditorMode,
        });
        // Wave-4 skeptic escalation (MERI_SKEPTIC_MODE, default off): residual
        // claims the deterministic checks couldn't decide are adversarially
        // adjudicated by an LLM skeptic; confident refutations merge into the
        // verdict under enforce (shadow observes only). Fail-open by contract.
        verdict = await applySkepticEscalation({
          verdict,
          output: markdown,
          ledger: { entries: ledgerEntries },
          cred: { apiKey: cred.apiKey, model: cred.model },
          logger: this.logger,
        });
        if (verdict.findings.length > 0) {
          this.logger.warn(
            `[meri-auditor:${auditorMode}] alert memo — ${verdict.findings.length} finding(s), ` +
              `top=${verdict.topSeverity}, decision=${verdict.decision}: ` +
              verdict.findings.map((f) => `${f.check}/${f.severity}`).join(', '),
          );
          await this.prisma.withTenant(ctx.tenantId, (tx) =>
            tx.meriAuditLedger.create({
              data: {
                tenantId: ctx.tenantId,
                surface: 'alert',
                mode: auditorMode,
                // Gate I (CG-01) b-8: lets saveEdited's L0 scope its recent-hold
                // lookup to this client/alert instead of the whole tenant.
                clientId,
                alertId: alert.alertId,
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
              `> ⚠️ **Unverified — ${verdict.findings.length} ${HELD_BANNER_MARKER} ` +
              `(${checks}).** Treat flagged claims as unconfirmed until a reviewer clears them.\n\n` +
              markdown;
          }
          // Enforce = hold: block the auto-file below. decisionFor() returns
          // 'hold' only in enforce mode (annotate → 'deliver_with_flags'), so
          // this is inert under shadow/annotate and never changes today's flow.
          // §4.7: OR-ed with the entailment hold — an auditor 'deliver' must never clear
          // a hold the entailment gate already established.
          held = verdict.decision === 'hold' || entailmentHeld;
          auditorHeld = verdict.decision === 'hold';
          if (verdict.decision === 'hold') {
            heldReason = [
              `Grounding auditor: ${verdict.findings
                .map((f) => `${f.check} (${f.severity}): ${f.detail}`)
                .join('; ')}`,
              entailmentHeld ? 'Entailment gate: every paragraph failed entailment.' : null,
            ]
              .filter(Boolean)
              .join(' | ')
              .slice(0, 2000);
          }
        }
      } catch (err) {
        this.logger.warn(
          `[meri-auditor] alert memo audit failed (memo unaffected): ${(err as Error).message}`,
        );
      }
    }

    // Gate I (CG-01) b-2/b-3: a server-owned record of what governance decided,
    // written BEFORE reviews.createSystem() is attempted and unconditionally for
    // EVERY generation — not only held ones (I_GOVERNANCE.md §1.2/§1.4's S1-S4
    // slip-throughs all share one root cause: filing state was never durably
    // recorded anywhere saveEdited could later check). A record with
    // holdSource:'none' is what lets saveEdited distinguish "not held" from "we
    // have no idea" (edge case 4). Pessimistic by design: a held generation
    // starts 'blocked_pending_review' and only relaxes to 'draft' once
    // createSystem proves a real review row exists below, so a crash between
    // the two writes still leaves a blocking row. Fail-open (try/caught): a
    // failure here must not break generation (edge case 1) — it only means this
    // one generation falls back to the pre-existing L0-L3 checks in saveEdited.
    const holdSource: 'none' | 'entailment' | 'auditor' | 'both' = !held
      ? 'none'
      : entailmentHeld && auditorHeld
        ? 'both'
        : entailmentHeld
          ? 'entailment'
          : 'auditor';
    let generationId: string | null = null;
    try {
      const rec = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.alertGenerationRecord.create({
          data: {
            tenantId: ctx.tenantId,
            clientId,
            alertId: alert.alertId,
            surface: 'alert-memo',
            holdSource,
            holdReason: heldReason || null,
            filingState: held ? 'blocked_pending_review' : 'draft',
            contentHash: contentHashOf(markdown),
            createdBy: ctx.userId,
          },
          select: { id: true },
        }),
      );
      generationId = rec.id;
    } catch (err) {
      this.logger.warn(
        `alert generation record create failed (non-fatal): ${(err as Error).message}`,
      );
    }

    // Render docx + auto-file in the client's Documents — UNLESS the memo is
    // held for review (enforce mode + grounding finding). A held memo is still
    // returned to the composer (markdown carries the Unverified banner) but is
    // deliberately NOT filed into the client's Documents until a reviewer clears
    // it, so a flagged memo can never land in the client record as if approved.
    let document: AlertMemoResult['document'] = null;
    if (held) {
      this.logger.warn(
        `[meri-auditor:enforce] alert memo HELD for review — not auto-filed to client Documents`,
      );
      // G4: a hold is no longer a dead end — it becomes a pending
      // review_request carrying everything approve needs to file the memo
      // (markdown + title + client). Fail-open: emitting the review can never
      // break memo generation.
      reviewRequestId = await this.reviews.createSystem(ctx.tenantId, {
        riskTier: DELIVERABLE_RISK_TIERS.alert_memo ?? 'high',
        surface: 'alert-memo',
        subjectType: 'alert',
        subjectId: alert.alertId,
        clientId,
        title,
        reason: heldReason || 'Grounding auditor held this memo for review.',
        payload: { markdown, title, clientName, clientId, alertId: alert.alertId },
        requestedBy: ctx.userId,
      });
      if (reviewRequestId !== null && generationId) {
        // Relax the pessimistic default now that a real review row exists — L1
        // (hasOpenForSubject) is the backstop for this case; the new lock's job
        // is specifically the null branch below, where L1 has nothing to find.
        const gid = generationId;
        await this.prisma
          .withTenant(ctx.tenantId, (tx) =>
            tx.alertGenerationRecord.update({
              where: { id: gid },
              data: { reviewRequestId, filingState: 'draft' },
            }),
          )
          .catch((e) =>
            this.logger.warn(
              `alert generation record update failed (non-fatal): ${(e as Error).message}`,
            ),
          );
      }
      if (reviewRequestId === null) {
        // createSystem is fail-open (never throws), so a hold can land with NO
        // pending review_request row for a reviewer to see or for saveEdited's
        // L1/L2/L3 locks to catch. CORRECTED (Gate I phase a, CG-01): saveEdited's
        // L0 lock does NOT backstop this for an entailment-only hold. L0 fires
        // only when the HELD_BANNER_MARKER is present in the saved markdown, and
        // that banner is inserted only inside the auditor-finding branch above
        // (auditorMode !== 'off' AND verdict.findings.length > 0, :390/:431). An
        // entailment-only hold — auditor 'off', or auditor on with zero findings
        // on the deterministic scaffold (the common case in prod) — reaches this
        // branch with no banner and no ledger row, so a standard user's later
        // saveEdited call is UNGATED.
        this.logger.error(
          `[meri-auditor:enforce] alert memo HELD but review_request creation FAILED — ` +
            `no reviewer will see this hold (tenant=${ctx.tenantId}, client=${clientId}, alert=${alert.alertId})`,
        );
      }
    } else {
      try {
        const buffer = await renderMemoDocx(toMemoDocInput(clientName, alert, sections, sources));
        const fileName = `${title}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
        const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
          clientId,
          fileName,
          contentType: DOCX_MIME,
          buffer,
          source: 'intel_memo',
        });
        document = { attachmentId: saved.id, fileName: saved.fileName };
        if (generationId) {
          // Best-effort bookkeeping (Gate I): the memo is already filed by this
          // point regardless of whether this update succeeds.
          const gid = generationId;
          await this.prisma
            .withTenant(ctx.tenantId, (tx) =>
              tx.alertGenerationRecord.update({ where: { id: gid }, data: { filingState: 'filed' } }),
            )
            .catch((e) =>
              this.logger.warn(
                `alert generation record filed-update failed (non-fatal): ${(e as Error).message}`,
              ),
            );
        }
        // Gate H a-6: regenerate SUPERSEDES the prior Document rather than
        // deleting it — the client's Documents list still shows only the
        // current version (listAttachments excludes superseded rows), but
        // the old version is never destroyed. deleteAttachment used to run
        // here; that was a real, unrecoverable S3 delete on every regenerate.
        if (replaceAttachmentId) {
          await this.engagement
            .supersedeAttachment(ctx, replaceAttachmentId, saved.id)
            .catch((e) =>
              this.logger.warn(`superseding prior memo doc failed: ${(e as Error).message}`),
            );
        }
      } catch (err) {
        // The memo is still returned for the composer; auto-file can be retried by the client.
        this.logger.error(`alert-memo auto-file to Documents failed: ${(err as Error).message}`);
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
      contextExcluded,
      entailmentDropped,
      held,
      reviewRequestId,
      heldReason,
      generationId,
    };
  }

  /** Re-file an edited memo (markdown from the composer) as a fresh docx in the client's Documents. */
  async saveEdited(
    ctx: TenantContext,
    clientId: string,
    input: {
      title: string;
      markdown: string;
      clientName: string;
      /** REQUIRED (P0-01): keys the review-hold guard. */
      alertId: string;
      actionDate?: string;
      replaceAttachmentId?: string;
      /** Gate I (CG-01): the server-owned record generate() minted. Optional so
       *  an in-flight client that predates this field still gets the L0-L3
       *  compatibility path (b-5) instead of a hard failure. */
      generationId?: string;
    },
  ): Promise<{ document: { attachmentId: string; fileName: string } | null; title: string }> {
    const generationId = input.generationId ?? null;
    // P0-01: a memo the grounding auditor HELD may not be filed around the review
    // gate. Five independent locks (Gate I adds the first), any of which blocks;
    // an admin (who can also decide the review) bypasses, matching
    // reviews.assertMayDecide.
    if (!isTenantAdmin(ctx.role)) {
      // Gate I (CG-01) b-4: the NEW first lock. A server-owned record is
      // authoritative — it does not depend on inferring hold state from content
      // markers the client could omit or fabricate (I_GOVERNANCE.md §1.4's
      // S1-S4 slip-throughs). Absence of a record — no generationId sent, or
      // none found — is NOT held (edge case 4); it falls through to L1-L3/L0,
      // the compatibility path for any in-flight client (b-5).
      if (generationId) {
        const record = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.alertGenerationRecord.findFirst({
            where: { id: generationId, tenantId: ctx.tenantId, clientId, alertId: input.alertId },
            select: { filingState: true },
          }),
        );
        if (record?.filingState === 'blocked_pending_review') {
          throw new ForbiddenException(HELD_MEMO_MESSAGE);
        }
      }
      // L1 — the existing subject guard, now ALWAYS reachable (alertId is required).
      if (await this.reviews.hasOpenForSubject(ctx.tenantId, 'alert', input.alertId)) {
        throw new ForbiddenException(HELD_MEMO_MESSAGE);
      }
      // L2/L3 — anti-spoof: a caller could hand-craft a bogus alertId to dodge L1,
      // so ALSO check this client's pending alert-memo reviews by server-owned data.
      const pending = await this.prisma.withTenant(ctx.tenantId, (tx) =>
        tx.reviewRequest.findMany({
          where: { tenantId: ctx.tenantId, clientId, surface: 'alert-memo', status: 'pending' },
          select: { title: true, subjectId: true },
        }),
      );
      if (pending.length > 0) {
        // L2 — the title is generated server-side and round-tripped verbatim by the
        // composer (no title input exists in the UI), so a match means this IS a held memo.
        if (pending.some((r) => r.title === input.title)) throw new ForbiddenException(HELD_MEMO_MESSAGE);
        // L3 — the held banner survived the edit AND this client has a pending hold.
        // Banner-only is NOT sufficient: annotate mode adds the same banner and files legitimately.
        if (input.markdown.includes(HELD_BANNER_MARKER)) throw new ForbiddenException(HELD_MEMO_MESSAGE);
        // L1 restated against the client-scoped rows, in case subjectType ever drifts.
        if (pending.some((r) => r.subjectId && r.subjectId === input.alertId)) {
          throw new ForbiddenException(HELD_MEMO_MESSAGE);
        }
      }
      // L0 (plan §4.2/§6.5 — required, not optional): closes the hole where
      // reviews.createSystem() failed and returned null, so NO review_request
      // row exists for L1/L2/L3 to find. CORRECTED (Gate I phase a, CG-01): the
      // meri_audit_ledger write is NOT unconditional — it runs only inside BOTH
      // `auditorMode !== 'off'` (:390) AND `verdict.findings.length > 0` (:431).
      // An entailment-only hold under `auditorMode==='off'`, or under auditor-on
      // with zero findings (the common case, since the memo is a deterministic
      // scaffold), produces NO ledger row and NO banner, so L0 cannot fire and
      // is not a backstop for that hold at all.
      // Filtering on decision:'hold' specifically (not just row-exists) means
      // this can never fire for an annotate-mode save, whose ledger rows carry
      // decision:'deliver_with_flags' — annotate keeps filing normally.
      if (input.markdown.includes(HELD_BANNER_MARKER)) {
        // Gate I (CG-01) b-8: scoped to this client/alert — previously any hold
        // anywhere in the tenant in the last 24h blocked every banner-bearing
        // save. clientId/alertId are NULL on ledger rows written before this
        // column existed, so a pre-existing row never matches (fail-safe, not a
        // new hole) — see the migration's comment.
        const recentHold = await this.prisma.withTenant(ctx.tenantId, (tx) =>
          tx.meriAuditLedger.findFirst({
            where: {
              tenantId: ctx.tenantId,
              surface: 'alert',
              clientId,
              alertId: input.alertId,
              decision: 'hold',
              createdAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
            },
            select: { id: true },
          }),
        );
        if (recentHold) throw new ForbiddenException(HELD_MEMO_MESSAGE);
      }
    }
    const buffer = await renderMemoDocx(
      markdownToMemoDocInput(input.markdown, input.clientName, input.title, input.actionDate),
    );
    const fileName = `${input.title}.docx`.replace(/[\\/:*?"<>|]+/g, '-');
    const saved = await this.engagement.createAttachmentFromBuffer(ctx, {
      clientId,
      fileName,
      contentType: DOCX_MIME,
      buffer,
      source: 'intel_memo',
    });
    // Gate H a-6: same supersede-not-delete treatment as the generate path.
    if (input.replaceAttachmentId) {
      await this.engagement
        .supersedeAttachment(ctx, input.replaceAttachmentId, saved.id)
        .catch((e) =>
          this.logger.warn(`superseding prior memo doc failed on save: ${(e as Error).message}`),
        );
    }
    // Gate I (CG-01) b-6: the repair/release path for a 'blocked_pending_review'
    // record IS the admin bypass above — an admin's save reaches here having
    // skipped the lock, and this marks the record filed so it stops reporting a
    // state the save itself just resolved. Best-effort: a failure to update
    // bookkeeping must not undo a save that already succeeded.
    if (generationId) {
      const gid = generationId;
      await this.prisma
        .withTenant(ctx.tenantId, (tx) =>
          tx.alertGenerationRecord.update({ where: { id: gid }, data: { filingState: 'filed' } }),
        )
        .catch((e) =>
          this.logger.warn(
            `alert generation record filed-update failed on save (non-fatal): ${(e as Error).message}`,
          ),
        );
    }
    return { document: { attachmentId: saved.id, fileName: saved.fileName }, title: input.title };
  }

  /** Pull the client's Memory files (voice/priorities/red-lines) + firm playbook as steering text. */
  private async loadSteering(
    ctx: TenantContext,
    clientId: string,
    clientName: string,
  ): Promise<{
    steering: string;
    memoryFilesUsed: string[];
    /**
     * §4.6: the context the compiler SAW and deliberately withheld. The packet has
     * always carried this trace (CompiledContextPacket.exclusions: ContextExclusion[]);
     * loadSteering discarded it, so the composer could show what steered a memo but
     * never what was excluded or why.
     */
    contextExcluded: Array<{ title: string; reason: string }>;
  }> {
    // Context Compiler v1 (G1): loading + governance filtering + the packet
    // trace live in ContextCompilerService. render:'all' keeps this surface's
    // historical full-file steering (every section body, no owner filter);
    // charBudget:8000 replaces the old joined-string slice(0,8000) with
    // whole-item drops RECORDED as 'over-budget' exclusions — no more silent
    // mid-file truncation. Behavior delta, deliberate: superseded files no
    // longer steer memos (the old getByTypeSlug path still returned them);
    // they are now traced as 'superseded' exclusions instead.
    const LABEL_BY_TYPE: Record<string, string> = {
      'client-soul': 'client-soul',
      'client-compass': 'client-compass',
      'client-people': 'client-people',
      playbook: 'firm-playbook',
    };
    const blocks: string[] = [];
    const used: string[] = [];
    const contextExcluded: Array<{ title: string; reason: string }> = [];
    try {
      const packet = await this.contextCompiler.compile({
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        clientId,
        surface: 'memo',
        layers: ['client-steering', 'client-people', 'firm-playbook'],
        render: 'all',
        charBudget: 8000,
        ref: { clientId },
      });
      // Deterministic composition in the historical order (soul, compass,
      // people, playbook) regardless of DB row order.
      for (const type of ['client-soul', 'client-compass', 'client-people', 'playbook']) {
        const r = packet.rendered.find((x) => x.type === type);
        if (!r) continue;
        blocks.push(`## ${r.title ?? type}\n${r.body}`);
        used.push(LABEL_BY_TYPE[type] ?? type);
      }
      // ContextExclusion carries { layer, id, type, slug, reason } — no `title`, so the
      // label comes from the same LABEL_BY_TYPE map memoryFilesUsed uses, falling back
      // to the slug. Reasons are the compiler's own vocabulary: revoked / superseded /
      // expired / empty / over-budget / unauthorized.
      for (const x of packet.exclusions ?? []) {
        // x.type/x.slug are omitted for identity-withheld reasons (unauthorized,
        // wrong-client, sensitivity-denied) so a restricted item's identity can
        // never leak into a client-facing memo — fall back to a generic label.
        contextExcluded.push({
          title: x.type ? LABEL_BY_TYPE[x.type] ?? x.slug ?? x.type : 'Restricted item',
          reason: x.reason,
        });
      }
    } catch (err) {
      this.logger.debug(`steering compile skipped: ${(err as Error).message}`);
    }
    const steering = blocks.length
      ? blocks.join('\n\n')
      : `(No client knowledge files on record for ${clientName}. Write a professional, neutral government-affairs memo.)`;
    return { steering: steering.slice(0, 8000), memoryFilesUsed: used, contextExcluded };
  }

  /** The only network call. Direct Anthropic Messages with the resolved per-tenant key. */
  private async callAnthropic(
    apiKey: string,
    model: string,
    prompt: string,
    /** Per-source system prompt (P0-08). Defaults to the federal-bill prompt. */
    system: string = SYSTEM_PROMPT,
  ): Promise<{ text: string; raw: unknown }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MEMO_TIMEOUT_MS);
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
          // Zero-trust Wave 1 (RC8): memos restate bill numbers/vote counts —
          // low temperature cuts the numeric-scramble sampling variance. PE memos
          // restate MORE figures than bill memos, not fewer, so 0.2 stays.
          temperature: 0.2,
          system,
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

/**
 * BYTE-IDENTICAL to `fmtMillionsShort` (apps/web TrackerFeedPanel.tsx:103-106) for every
 * non-null input, so the memo and the feed card can never disagree on a figure. Do not
 * "improve" one without the other.
 */
function fmtM(m: number | null | undefined): string {
  if (m == null) return 'unknown';
  if (Math.abs(m) >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m % 1 ? m.toFixed(1) : m.toFixed(0)}M`;
}

/** The parenthesised delta on the PE funding claim. A 0 delta is a real fact ("no change
 *  at this stage") and must survive, so the guard is `!= null`, never truthiness. */
function deltaSuffix(pe: AlertMemoProgramElement): string {
  const parts: string[] = [];
  if (pe.deltaMillions != null && Number.isFinite(pe.deltaMillions))
    parts.push(`delta ${fmtM(pe.deltaMillions)}`);
  if (pe.deltaPct != null && Number.isFinite(pe.deltaPct))
    parts.push(`${pe.deltaPct > 0 ? '+' : ''}${pe.deltaPct.toFixed(1)}%`);
  else if (pe.amountFromMillions === 0 && pe.amountToMillions != null && pe.amountToMillions !== 0)
    // A from-zero baseline makes the percentage Infinity (or null upstream). "+Infinity%"
    // in a client memo is worse than naming what actually happened.
    parts.push('new start (no prior baseline)');
  return parts.length ? ` (${parts.join(', ')})` : '';
}

function buildClaims(
  alert: AlertMemoAlertInput,
  /**
   * Live bill status re-query (5.2C / RC3 fix), or null when unavailable/not
   * applicable. When present, added as the LAST (most-recent) status claim so
   * the model states the CURRENT status rather than narrating only from the
   * Feed's frozen alert snapshot, which can go stale between alert time and
   * memo-drafting time (e.g. a rule granted at alert time can fail before the
   * memo is written).
   */
  liveBillStatus?: { status: string | null; statusAt: Date | string | null } | null,
): {
  claims: Claim[];
  sources: AlertMemoResult['sources'];
} {
  const claims: Claim[] = [];
  const push = (text: string | null | undefined, url?: string | null) => {
    const t = (text ?? '').trim();
    if (!t) return;
    claims.push({ id: `c${claims.length + 1}`, text: t, url: url ?? null });
  };
  push(`Alert: ${alert.title}`, alert.url);
  if (alert.actionText)
    push(
      `Official action${alert.actionDate ? ` (${alert.actionDate})` : ''}: ${alert.actionText}`,
      alert.url,
    );
  if (alert.billDisplayNum || alert.billTitle)
    push(`Bill: ${[alert.billDisplayNum, alert.billTitle].filter(Boolean).join(' — ')}`, alert.url);
  if (liveBillStatus?.status) {
    const asOf = liveBillStatus.statusAt
      ? ` (as of ${String(liveBillStatus.statusAt).slice(0, 10)})`
      : '';
    push(
      `CURRENT status as of memo generation, live-checked and superseding any earlier snapshot above${asOf}: ${billStatusLabel(liveBillStatus.status)}`,
    );
  }
  if (alert.committee) push(`Committee: ${alert.committee}`);
  if (alert.hearingTitle) push(`Hearing: ${alert.hearingTitle}`, alert.url);
  // P0-08: Program Element funding facts. EVERY dollar figure must arrive as a claim —
  // the model is explicitly forbidden from computing a delta (PE_SYSTEM_PROMPT), so the
  // arithmetic is pre-computed here, where code can be held to it.
  const pe = alert.programElement;
  if (pe) {
    push(`Program Element: ${pe.peCode}${pe.title ? ` — ${pe.title}` : ''}`, pe.href ?? alert.url);
    if (pe.fiscalYear) push(`Fiscal year: FY${String(pe.fiscalYear).slice(-2)} (FY${pe.fiscalYear})`);
    if (pe.deltaTypeLabel || pe.deltaType)
      push(`Budget-stage movement: ${pe.deltaTypeLabel ?? pe.deltaType}`);
    if (pe.fromRef || pe.toRef)
      push(
        `Source comparison: from ${pe.fromRef ?? 'unknown'} to ${pe.toRef ?? 'unknown'}`,
        pe.href ?? null,
      );
    if (pe.amountFromMillions != null || pe.amountToMillions != null)
      push(`Funding: ${fmtM(pe.amountFromMillions)} → ${fmtM(pe.amountToMillions)}${deltaSuffix(pe)}`, pe.href ?? null);
    if (pe.verification) push(`Verification state of these figures: ${pe.verification}`);
    if (pe.linkedRef) push(`Linked authority: ${pe.linkedRef}`);
  }
  // §4.5: state-bill framing. The jurisdiction claim exists so the model cannot quietly
  // describe a state bill as federal, and the deadline claims are the whole point of a
  // state memo — a cutoff can kill a bill regardless of its merits.
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
  // §4.5: regulation framing. ruleType carries the proposed-vs-final distinction the
  // prompt is required to respect, and the two dates are legally operative.
  const reg = alert.regulation;
  if (reg) {
    if (reg.ruleTitle) push(`Regulatory action: ${reg.ruleTitle}`, reg.url ?? alert.url);
    if (reg.agency) push(`Issuing agency: ${reg.agency}`);
    if (reg.ruleType) push(`Document type: ${reg.ruleType}`);
    if (reg.docketId) push(`Docket: ${reg.docketId}`, reg.url ?? alert.url);
    if (reg.commentEndDate) push(`Public comment period closes: ${reg.commentEndDate}`);
    if (reg.effectiveDate) push(`Effective date: ${reg.effectiveDate}`);
  }
  if (alert.whyItMatters) push(`Relevance to client: ${alert.whyItMatters}`);
  if (alert.matchedTags?.length)
    push(`Matched the client's tracked interests: ${alert.matchedTags.join(', ')}`);
  for (const q of alert.quotes ?? []) {
    const who = q.speaker ? `${q.speaker}: ` : '';
    push(`Hearing statement — ${who}"${q.text}"`, alert.url);
  }
  // §4.6: each source carries WHEN it was pulled and how well it is attested.
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

/**
 * MP-11 (Gate L phase d): delegates to the shared classifier so this memo, the
 * district brief, and intel-api's packet agree. Deliberately NEVER returns
 * 'verified': nothing verifies these claims today, and an inflated
 * verification label is worse than none. An absolute http(s) url is 'official'
 * ONLY on an allowlisted government domain (congress.gov / a .gov committee
 * site / the Federal Register); a relative path is an INTERNAL deep link
 * (e.g. a Program Element dossier), which is extracted data; any other
 * absolute URL is 'unverified', not 'official'. Previously ANY absolute URL —
 * including a firm's own site or a news article — was labelled 'official'.
 */
function verificationFor(url: string | null | undefined): SourceVerification {
  return classifySourceVerification(url);
}

function buildUserPrompt(
  alert: AlertMemoAlertInput,
  clientName: string,
  steering: string,
  claims: Claim[],
): string {
  const sections = sectionOrderFor(alert.sourceType);
  // P0-08: name the Program Element in the ask, so the model anchors on the PE code
  // rather than on a headline that may not repeat it.
  const subject = alert.programElement?.peCode
    ? `Program Element ${alert.programElement.peCode}${alert.programElement.title ? ` (${alert.programElement.title})` : ''}: ${alert.title}`
    : alert.title;
  return [
    `Write the internal memo for client "${clientName}" about: ${subject}`,
    '',
    'ABOUT THE CLIENT (voice/priorities/red lines — steer by this, do not cite as fact):',
    steering,
    '',
    'FACT SHEET (the ONLY material you may assert; cite ids):',
    claims.map((c) => `${c.id}: ${c.text}`).join('\n'),
    '',
    // The requested list is per-source (§4.5), so the JSON example can never ask for
    // bill headings on a PE memo.
    `Return JSON with exactly these sections, in order — ${sections.join(', ')}:`,
    '{"sections":[{"heading":"' +
      sections[0] +
      '","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]}',
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
 * Drop any paragraph that is not fully grounded (grounding gate). W3.3 (D-9):
 * this is PRE-EXISTING federal (production) memo behavior — the fix changes
 * federal memo output, shipping on #377 with the state district-brief twin. A
 * paragraph must cite at least one claim AND every cited id must be a real
 * fact-sheet claim. The old `claimIds.every(...)` was VACUOUSLY TRUE for a
 * zero-citation paragraph (`[].every` === true), so ungrounded model prose
 * sailed into a client-facing memo. Requiring `length > 0` closes it; a
 * fully-uncited generation drops to zero sections → deterministic scaffold with
 * lowConfidence=true.
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

/** Gate I (CG-01): sha256 of the final markdown, snapshotted into the generation
 *  record at write time. Not re-checked on save — the lock keys on the record's
 *  existence + filingState, not hash equality (open decision #2). */
function contentHashOf(markdown: string): string {
  return createHash('sha256').update(markdown).digest('hex');
}

/** Deterministic fallback when generation fails or is fully ungrounded. */
function scaffold(alert: AlertMemoAlertInput, claims: Claim[]): GenSection[] {
  const allIds = claims.map((c) => c.id);
  // P0-08: a failed PE generation used to fall back to bill-shaped headings ("What
  // happened"), which read as a different document than the one that was requested.
  if (alert.sourceType === 'program_element') {
    const pe = alert.programElement;
    return [
      {
        heading: 'Bottom line',
        paragraphs: [{ text: alert.title, claimIds: claims[0] ? [claims[0].id] : [] }],
      },
      {
        heading: 'Budget movement',
        paragraphs: [
          {
            text:
              pe && (pe.amountFromMillions != null || pe.amountToMillions != null)
                ? `${pe.peCode}: ${fmtM(pe.amountFromMillions)} → ${fmtM(pe.amountToMillions)}${deltaSuffix(pe)}.`
                : (alert.actionText || alert.title),
            claimIds: allIds.slice(0, 6),
          },
        ],
      },
      {
        heading: 'Client program alignment',
        paragraphs: alert.whyItMatters ? [{ text: alert.whyItMatters, claimIds: allIds }] : [],
      },
    ].filter((s) => s.paragraphs.length);
  }
  // §4.5: a failed state-bill or regulation generation must not fall back to federal
  // bill headings — the document would claim to be something it is not.
  if (alert.sourceType === 'state_bill') {
    return [
      {
        heading: 'Bottom line',
        paragraphs: [{ text: alert.title, claimIds: claims[0] ? [claims[0].id] : [] }],
      },
      {
        heading: 'State procedural update',
        paragraphs: [{ text: alert.actionText || alert.title, claimIds: allIds.slice(0, 4) }],
      },
      {
        heading: 'Deadline & crossover risk',
        paragraphs: alert.deadline?.cutoffType
          ? [
              {
                text: `${alert.deadline.cutoffType}${alert.deadline.cutoffDate ? ` on ${alert.deadline.cutoffDate}` : ''}${alert.deadline.daysUntil != null ? ` — ${alert.deadline.daysUntil} day(s) remaining as of this alert` : ''}.`,
                claimIds: allIds,
              },
            ]
          : [],
      },
    ].filter((s) => s.paragraphs.length);
  }
  if (alert.sourceType === 'regulation') {
    const reg = alert.regulation;
    return [
      {
        heading: 'Bottom line',
        paragraphs: [{ text: alert.title, claimIds: claims[0] ? [claims[0].id] : [] }],
      },
      {
        heading: 'Rule or action summary',
        paragraphs: [
          {
            text: reg?.ruleTitle || alert.actionText || alert.title,
            claimIds: allIds.slice(0, 4),
          },
        ],
      },
      {
        heading: 'Comment & effective deadlines',
        paragraphs: reg?.commentEndDate || reg?.effectiveDate
          ? [
              {
                text: [
                  reg.commentEndDate ? `Comments close ${reg.commentEndDate}.` : null,
                  reg.effectiveDate ? `Effective ${reg.effectiveDate}.` : null,
                ]
                  .filter(Boolean)
                  .join(' '),
                claimIds: allIds,
              },
            ]
          : [],
      },
    ].filter((s) => s.paragraphs.length);
  }
  return [
    {
      heading: 'Bottom line',
      paragraphs: [{ text: alert.title, claimIds: claims[0] ? [claims[0].id] : [] }],
    },
    {
      heading: 'What happened',
      paragraphs: [{ text: alert.actionText || alert.title, claimIds: allIds.slice(0, 3) }],
    },
    {
      heading: 'Why it matters',
      paragraphs: alert.whyItMatters ? [{ text: alert.whyItMatters, claimIds: allIds }] : [],
    },
  ].filter((s) => s.paragraphs.length);
}

/**
 * P1-15: the structured result carries per-paragraph claimIds, but every DELIVERED
 * surface (markdown, docx, Workspace draft) dropped them — so the memo the client sees
 * was strictly less auditable than the internal object. Render them as trailing inline
 * anchors: "…stalling floor consideration. [c2][c4]"
 *
 * Appended at the END of the paragraph, never mid-sentence, so it cannot corrupt
 * markdown inside a URL or a code span. `[c1]` is left bare on purpose: the Workspace
 * renderer's inline() only linkifies the `[text](url)` form, so a bare bracket pair
 * stays literal text there (verified in richtext.ts, locked by test).
 */
export function withClaimAnchors(text: string, claimIds: string[]): string {
  if (!claimIds.length) return text;
  return `${text} ${claimIds.map((id) => `[${id}]`).join('')}`;
}

function toMarkdown(
  title: string,
  sections: GenSection[],
  claims: Claim[],
  sources: AlertMemoResult['sources'],
  clientName: string,
): string {
  const lines: string[] = [`# ${title}`, `*Prepared for ${clientName}*`, ''];
  for (const s of sections) {
    lines.push(`## ${s.heading}`, '');
    for (const p of s.paragraphs) lines.push(withClaimAnchors(p.text, p.claimIds), '');
  }
  if (sources.length) {
    // §4.6: map each claim id to its label, url, retrieval date, and verification
    // state, so a reader can audit any anchored sentence back to a source.
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

function toMemoDocInput(
  clientName: string,
  alert: AlertMemoAlertInput,
  sections: GenSection[],
  sources: AlertMemoResult['sources'],
): MemoDocInput {
  // P0-08: prefer the PE code on the docx RE: line, same precedence as the memo title.
  const reLine = alert.programElement?.peCode
    ? `${alert.programElement.peCode}${alert.programElement.title ? ` — ${alert.programElement.title}` : ''}`
    : alert.billDisplayNum
      ? `${alert.billDisplayNum}${alert.billTitle ? ` — ${alert.billTitle}` : ''}`
      : (alert.regulation?.ruleTitle ?? alert.hearingTitle ?? alert.title);
  return {
    clientName,
    dateStr: formatMemoDate(alert.actionDate),
    reLine,
    sections: sections.map((s) => ({
      heading: s.heading,
      // P1-15: MemoDocInput.paragraphs is string[], so the anchors ride as plain text
      // at the end of the paragraph — no superscript styling attempted.
      paragraphs: s.paragraphs.map((p) => withClaimAnchors(p.text, p.claimIds)),
    })),
    sources: sources.map((s) => ({ label: s.label, url: s.url })),
  };
}
