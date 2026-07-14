import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  recordAiUsageEvent,
  parseProviderUsage,
  billStatusLabel,
  type TenantContext,
} from '@capiro/shared';
import { runAuditor, type LedgerEntry } from '@capiro/meriv2-core';
import { applySkepticEscalation } from './skeptic-escalation.js';
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
import type { AlertMemoAlertInput, AlertMemoResult } from './alert-memo.types.js';

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

const SECTION_ORDER = [
  'Bottom line',
  'What happened',
  'Why it matters',
  'Recommended actions',
  'Talking points',
] as const;

const SYSTEM_PROMPT = `You are a senior federal government-affairs strategist writing a concise internal MEMO for a lobbying firm's account team about a development affecting a specific client.
You are given: (1) an ABOUT-THE-CLIENT brief that sets the voice, priorities, and hard "red lines" you must respect; and (2) a closed, numbered FACT SHEET of claims (c1, c2, ...).
Hard rules:
- Assert ONLY facts drawn from the fact sheet. Never introduce a number, date, name, bill, or quote that is not in a claim.
- Every paragraph MUST cite the claim ids it draws on (claimIds).
- Use the ABOUT-THE-CLIENT brief to shape tone, emphasis, and the recommended actions — but do NOT state it as fact and NEVER contradict a stated red line.
- Keep it tight: ~1 page. "Recommended actions" = 2-4 concrete, client-specific next steps.
Return ONLY JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]} covering, in order: Bottom line, What happened, Why it matters, Recommended actions, Talking points. No prose outside the JSON.`;

interface Claim {
  id: string;
  text: string;
  url?: string | null;
}

interface GenSection {
  heading: string;
  paragraphs: Array<{ text: string; claimIds: string[] }>;
}

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
    const liveBill =
      alert.sourceType !== 'hearing' && alert.sourceRef
        ? await this.engagement.billTruthBlock(alert.sourceRef).catch(() => null)
        : null;
    const { claims, sources } = buildClaims(
      alert,
      liveBill ? { status: liveBill.raw.status, statusAt: liveBill.raw.statusAt } : null,
    );
    const { steering, memoryFilesUsed } = await this.loadSteering(ctx, clientId, clientName);

    const cred = await this.credentials.resolveProvider(ctx, 'anthropic');
    if (!cred)
      throw new ServiceUnavailableException('No Anthropic credential available for this tenant');

    let sections: GenSection[] = [];
    let lowConfidence = false;
    let rawUsage: unknown = null;
    try {
      const { text, raw } = await this.callAnthropic(
        cred.apiKey,
        cred.model,
        buildUserPrompt(alert, clientName, steering, claims),
      );
      rawUsage = raw;
      sections = verifyGrounded(parseSections(text), claims);
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

    const title =
      `Client memo — ${alert.billDisplayNum ?? alert.hearingTitle ?? alert.title}`.slice(0, 200);
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
    let held = false;
    let heldReason = '';
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
          // 'hold' only in enforce mode (annotate → 'deliver_with_flags'), so
          // this is inert under shadow/annotate and never changes today's flow.
          held = verdict.decision === 'hold';
          if (held) {
            heldReason = `Grounding auditor: ${verdict.findings
              .map((f) => `${f.check} (${f.severity}): ${f.detail}`)
              .join('; ')}`.slice(0, 2000);
          }
        }
      } catch (err) {
        this.logger.warn(
          `[meri-auditor] alert memo audit failed (memo unaffected): ${(err as Error).message}`,
        );
      }
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
      await this.reviews.createSystem(ctx.tenantId, {
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
        // Regenerate: replace the prior Document so the client's Documents don't accrue drafts.
        if (replaceAttachmentId) {
          await this.engagement
            .deleteAttachment(ctx, replaceAttachmentId)
            .catch((e) =>
              this.logger.warn(`replace prior memo doc failed: ${(e as Error).message}`),
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
      held,
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
      actionDate?: string;
      replaceAttachmentId?: string;
      /** The alert this memo came from — required for the G4 held-review guard. */
      alertId?: string;
    },
  ): Promise<{ document: { attachmentId: string; fileName: string } | null; title: string }> {
    // G4: a memo with an OPEN review may not be filed around the review by its
    // requester — only through /reviews approve (or by an admin editing, which
    // the reviews service also authorizes). Without this check, the edit-then-
    // save path silently re-filed held memos (audit finding, 2026-07-12).
    if (input.alertId) {
      const open = await this.reviews.hasOpenForSubject(ctx.tenantId, 'alert', input.alertId);
      if (open && !isTenantAdmin(ctx.role)) {
        throw new ForbiddenException(
          'This memo is held for review. An admin or the assigned reviewer must approve it (Reviews queue) before it can be filed.',
        );
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
    if (input.replaceAttachmentId) {
      await this.engagement.deleteAttachment(ctx, input.replaceAttachmentId).catch(() => undefined);
    }
    return { document: { attachmentId: saved.id, fileName: saved.fileName }, title: input.title };
  }

  /** Pull the client's Memory files (voice/priorities/red-lines) + firm playbook as steering text. */
  private async loadSteering(
    ctx: TenantContext,
    clientId: string,
    clientName: string,
  ): Promise<{ steering: string; memoryFilesUsed: string[] }> {
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
    } catch (err) {
      this.logger.debug(`steering compile skipped: ${(err as Error).message}`);
    }
    const steering = blocks.length
      ? blocks.join('\n\n')
      : `(No client knowledge files on record for ${clientName}. Write a professional, neutral government-affairs memo.)`;
    return { steering: steering.slice(0, 8000), memoryFilesUsed: used };
  }

  /** The only network call. Direct Anthropic Messages with the resolved per-tenant key. */
  private async callAnthropic(
    apiKey: string,
    model: string,
    prompt: string,
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
  if (alert.whyItMatters) push(`Relevance to client: ${alert.whyItMatters}`);
  if (alert.matchedTags?.length)
    push(`Matched the client's tracked interests: ${alert.matchedTags.join(', ')}`);
  for (const q of alert.quotes ?? []) {
    const who = q.speaker ? `${q.speaker}: ` : '';
    push(`Hearing statement — ${who}"${q.text}"`, alert.url);
  }
  const sources = claims
    .filter((c) => c.url)
    .map((c) => ({ claimId: c.id, label: c.text.slice(0, 80), url: c.url }));
  return { claims, sources };
}

function buildUserPrompt(
  alert: AlertMemoAlertInput,
  clientName: string,
  steering: string,
  claims: Claim[],
): string {
  return [
    `Write the internal memo for client "${clientName}" about: ${alert.title}`,
    '',
    'ABOUT THE CLIENT (voice/priorities/red lines — steer by this, do not cite as fact):',
    steering,
    '',
    'FACT SHEET (the ONLY material you may assert; cite ids):',
    claims.map((c) => `${c.id}: ${c.text}`).join('\n'),
    '',
    'Return JSON: {"sections":[{"heading":"Bottom line","paragraphs":[{"text":"...","claimIds":["c1"]}]}, ...]}',
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

/** Deterministic fallback when generation fails or is fully ungrounded. */
function scaffold(alert: AlertMemoAlertInput, claims: Claim[]): GenSection[] {
  const allIds = claims.map((c) => c.id);
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
    for (const p of s.paragraphs) lines.push(p.text, '');
  }
  if (sources.length) {
    lines.push('## Sources', '');
    for (const src of sources) lines.push(`- ${src.label}${src.url ? ` — ${src.url}` : ''}`);
  }
  return lines.join('\n').trimEnd() + '\n';
}

function toMemoDocInput(
  clientName: string,
  alert: AlertMemoAlertInput,
  sections: GenSection[],
  sources: AlertMemoResult['sources'],
): MemoDocInput {
  const reLine = alert.billDisplayNum
    ? `${alert.billDisplayNum}${alert.billTitle ? ` — ${alert.billTitle}` : ''}`
    : (alert.hearingTitle ?? alert.title);
  return {
    clientName,
    dateStr: formatMemoDate(alert.actionDate),
    reLine,
    sections: sections.map((s) => ({
      heading: s.heading,
      paragraphs: s.paragraphs.map((p) => p.text),
    })),
    sources: sources.map((s) => ({ label: s.label, url: s.url })),
  };
}
