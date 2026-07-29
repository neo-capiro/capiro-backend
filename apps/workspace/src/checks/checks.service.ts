import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WSC } from '../cascade/cascade.config.js';

export type WsCheckStatus = 'success' | 'notable' | 'critical';
/**
 * Review severity, kept SEPARATE from `status`. `status` is the pass/fail of the
 * rule; severity is how much the finding matters. Grounding findings arrive with a
 * real four-level severity and used to be collapsed into notable/critical, which
 * lost the distinction between "tighten this phrasing" and "this misstates a
 * funding direction".
 */
export type WsCheckSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface WsCheckResult {
  id: string;
  label: string;
  status: WsCheckStatus;
  /** Short evidence line ("$18.0M · +$10.0M", "2 of 3 offices", "9 undefined"). */
  detail: string;
  /** Whether the popover should offer a "Fix" affordance (non-success only). */
  fixable: boolean;
  severity: WsCheckSeverity;
  /** The section this finding is anchored to, when the rule knows it. */
  section?: string | null;
}

/**
 * Verification semantics (Phase 2 Step 6/8). "No issues found" and "we never
 * checked" are different claims and must not render identically.
 *   verified            - the audit ran and every checkable claim was supported
 *   partially_verified  - it ran and some claims were unsupported
 *   not_verified        - it never ran, or ran with nothing verifiable to check
 *   unavailable         - it was attempted and could not complete
 */
export interface WsVerificationSummary {
  ran: boolean;
  state: 'verified' | 'partially_verified' | 'not_verified' | 'unavailable';
  supportedCount: number;
  unsupportedCount: number;
  /** When the evidence behind this verdict was captured (last generation). */
  capturedAt: string | null;
  detail: string;
}

/** Context that grounded the last generation, plus what was left out. */
export interface WsChecksContextSummary {
  capturedAt: string | null;
  itemCount: number;
  memoryFileCount: number;
  linkedPeCount: number;
  exclusions: Array<{ label: string; reason: string }>;
  degraded: boolean;
}

/**
 * Whether the document has moved on since verification/context capture. Exporting
 * stale-verified content is the risk Step 8 requires the UI to gate on.
 */
export interface WsChecksStaleness {
  documentUpdatedAt: string;
  verifiedAt: string | null;
  changedAfterVerification: boolean;
}

export interface WsChecksResponse {
  checks: WsCheckResult[];
  score: { passed: number; total: number };
  verification: WsVerificationSummary;
  context: WsChecksContextSummary | null;
  staleness: WsChecksStaleness;
}

/**
 * Read the Phase 3.1 grounding findings the GenerationService persisted onto
 * `config.groundingFindings`. Defensive parse (no cross-service type import) so
 * an old draft or a partial write never crashes the checks endpoint.
 */
function readGroundingFindings(
  cfg: Record<string, unknown>,
): Array<{ check: string; severity: string; detail: string }> {
  const raw = (cfg as { groundingFindings?: unknown }).groundingFindings;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g): g is Record<string, unknown> => !!g && typeof g === 'object')
    .map((g) => ({
      check: typeof g.check === 'string' ? g.check : 'unknown',
      severity: typeof g.severity === 'string' ? g.severity : 'medium',
      detail: typeof g.detail === 'string' ? g.detail : '',
    }));
}

/**
 * The citation findings the generator emits start with `Section "X":`. Recover
 * that name so a finding can link to the section it belongs to, matched against
 * the document's real section list so a malformed detail cannot invent one.
 */
function sectionFromFindingDetail(detail: string, sections: string[]): string | null {
  const match = /^Section\s+"([^"]+)"/.exec(detail);
  const named = match && match[1];
  if (!named) return null;
  return sections.find((section) => section === named) ?? null;
}

/**
 * Pre-submission checks (Phase 6b — the renamed "lint"). RULE-BASED: no new
 * table. Evaluates the draft's config + documents against ~10 deterministic
 * rules and returns per-check status + a passed/total score.
 *
 * Advisory only — no check here blocks export (Ninja D1, 2026-07-12: Workspace
 * stays gate-less; the old always-on, never-clearable human sign-off `gates`
 * were removed, and this pass removes the vestigial empty `gates` field/type
 * they left behind). Non-success checks carry `fixable: true` so the popover
 * can render a "Fix" jump; Phase 3 claim-level citations surface as additional
 * advisory checks in this same array.
 *
 * Tenant-scoped: the draft is loaded with a mandatory tenantId filter.
 */
@Injectable()
export class ChecksService {
  constructor(private readonly prisma: PrismaService) {}

  async evaluate(tenantId: string, draftId: string): Promise<WsChecksResponse> {
    const draft = await this.prisma.wsDraft.findFirst({
      where: { id: draftId, tenantId },
      include: { documents: { orderBy: { ordinal: 'asc' } } },
    });
    if (!draft) throw new NotFoundException('Draft not found');

    const cfg = (draft.config as Record<string, unknown>) ?? {};
    const product = draft.product ?? (cfg.product as string | null) ?? '';
    const funding = product ? WSC.isFunding(product) : false;
    const sections = (cfg.sections as string[] | undefined) ?? [];
    const sectionContent = (cfg.sectionContent as Record<string, string> | undefined) ?? {};
    const committees = (cfg.committees as string[] | undefined) ?? [];
    const offices = (cfg.offices as string[] | undefined) ?? [];
    const officeAssociated = Boolean(cfg.officeAssociated);
    const personalize = Boolean(cfg.personalize);
    const anonymize = Boolean(cfg.anonymize);
    const pages = (cfg.pages as number | undefined) ?? WSC.suggestedPages(product || 'White paper');
    const ask = this.askOf(draft.ask, cfg);

    // All body text (per-section + packet document section blocks) for prose
    // heuristics (acronyms, federal nexus, length).
    const allText = this.collectText(sectionContent, sections, draft.documents);

    const checks: WsCheckResult[] = [];

    // 1. Title set.
    checks.push(
      this.check(
        'title',
        'Document title set',
        draft.docTitle && draft.docTitle.trim() && !/^untitled/i.test(draft.docTitle)
          ? { status: 'success', detail: draft.docTitle.trim() }
          : { status: 'critical', detail: 'no title' },
      ),
    );

    // 2. Every section has content.
    const emptySections = sections.filter(
      (s) => !(sectionContent[s] ?? '').replace(/<[^>]*>/g, '').trim(),
    );
    checks.push(
      this.check(
        'sections-filled',
        'Every section has content',
        emptySections.length === 0
          ? {
              status: 'success',
              detail: `${sections.length} section${sections.length === 1 ? '' : 's'}`,
            }
          : {
              status: emptySections.length >= sections.length ? 'critical' : 'notable',
              detail: `${emptySections.length} empty`,
            },
      ),
    );

    // 3. Single, clear one-sentence ask (a section named like "the ask" exists
    //    and carries content). For non-funding products this is the request.
    const askSection = sections.find((s) => /\bask\b|request/i.test(s));
    const askFilled = askSection
      ? Boolean((sectionContent[askSection] ?? '').replace(/<[^>]*>/g, '').trim())
      : false;
    checks.push(
      this.check(
        'clear-ask',
        'Single, clear one-sentence ask',
        askSection && askFilled
          ? { status: 'success', detail: 'present' }
          : { status: 'notable', detail: askSection ? 'ask section empty' : 'no ask section' },
      ),
    );

    // 4. Funding products: dollar amount + delta above PB.
    if (funding) {
      const hasAmount = Boolean(ask.amount && ask.amount.trim());
      const hasDelta = Boolean(ask.delta && ask.delta.trim());
      checks.push(
        this.check(
          'dollar-ask',
          'Dollar amount + delta above PB',
          hasAmount && hasDelta
            ? { status: 'success', detail: `${ask.amount} · ${ask.delta}` }
            : hasAmount
              ? { status: 'notable', detail: 'delta missing' }
              : { status: 'critical', detail: 'no amount' },
        ),
      );
    }

    // 5. Committees selected when the product is office-associated.
    if (officeAssociated) {
      checks.push(
        this.check(
          'committees',
          'Committees / pathway selected',
          committees.length > 0
            ? { status: 'success', detail: committees.join(', ') }
            : { status: 'notable', detail: 'none selected' },
        ),
      );
    }

    // 6. District / state nexus — each personalized office has tailored content.
    if (personalize && offices.length > 0) {
      const meta = (cfg.sectionMeta as Record<string, { tailor?: boolean }> | undefined) ?? {};
      const tailored = Object.values(meta).filter((m) => m.tailor).length;
      checks.push(
        this.check(
          'office-nexus',
          'District / state nexus per office',
          tailored >= offices.length
            ? {
                status: 'success',
                detail: `${offices.length} office${offices.length === 1 ? '' : 's'}`,
              }
            : { status: 'notable', detail: `${tailored} of ${offices.length} offices` },
        ),
      );
    }

    // 7. Federal-nexus statement present (mandatory for CDS / Earmark).
    const cds = /cds|earmark/i.test(product);
    const hasNexus =
      sections.some((s) => /federal nexus/i.test(s)) ||
      /\b(10|2)\s*u\.?s\.?c\.?|federal nexus|authorizing/i.test(allText);
    if (cds || hasNexus || funding) {
      checks.push(
        this.check(
          'federal-nexus',
          'Federal nexus citation',
          hasNexus
            ? { status: 'success', detail: 'cited' }
            : { status: cds ? 'critical' : 'notable', detail: 'not found' },
        ),
      );
    }

    // 8. Acronyms expanded (heuristic): count ALL-CAPS tokens (3–6 letters) that
    //    never appear with an expansion in parentheses near a definition.
    const undefinedAcronyms = this.undefinedAcronyms(allText);
    checks.push(
      this.check(
        'acronyms',
        'Acronyms expanded on first use',
        undefinedAcronyms === 0
          ? { status: 'success', detail: 'all defined' }
          : {
              status: undefinedAcronyms > 8 ? 'critical' : 'notable',
              detail: `${undefinedAcronyms} undefined`,
            },
      ),
    );

    // 9. Length vs target pages (~500 words/page).
    const words = this.wordCount(allText);
    const estPages = Math.max(0.1, words / 500);
    checks.push(
      this.check(
        'length',
        `Length ≤ ${pages} page${pages === 1 ? '' : 's'}`,
        estPages <= pages
          ? { status: 'success', detail: `${estPages.toFixed(1)} pp` }
          : {
              status: estPages > pages * 1.5 ? 'critical' : 'notable',
              detail: `${estPages.toFixed(1)} pp`,
            },
      ),
    );

    // 10. Anonymize map complete when anonymize is on.
    if (anonymize) {
      const map = (cfg.anonymizeMap as { redactions?: unknown[] } | undefined) ?? {};
      const redactions = map.redactions ?? [];
      checks.push(
        this.check(
          'anonymize-map',
          'Anonymization map complete',
          redactions.length > 0
            ? { status: 'success', detail: `${redactions.length} masked` }
            : { status: 'critical', detail: 'anonymize on, no map' },
        ),
      );
    }

    // 11. No leftover placeholders (TODO / [brackets] / Lorem).
    const placeholders = (allText.match(/\bTODO\b|\bTBD\b|lorem ipsum|\[[^\]]+\]/gi) ?? []).length;
    checks.push(
      this.check(
        'placeholders',
        'No leftover placeholders',
        placeholders === 0
          ? { status: 'success', detail: 'clean' }
          : { status: 'notable', detail: `${placeholders} found` },
      ),
    );

    // Phase 3.1: fold the claim-level grounding findings the GenerationService
    // captured at generate time (config.groundingFindings, from the shared Phase 2
    // auditor) into the SAME advisory checks list — one entry per finding, so the
    // reviewer sees grounding issues (reversed funding direction, vehicle
    // conflation, LI-as-PE, …) beside the rule-based checks, not in a separate UI.
    // Advisory only (Ninja D1: gate-less) — they lower the score but never block.
    for (const g of readGroundingFindings(cfg)) {
      const status: WsCheckStatus =
        g.severity === 'critical' || g.severity === 'high' ? 'critical' : 'notable';
      const severity: WsCheckSeverity =
        g.severity === 'critical' ||
        g.severity === 'high' ||
        g.severity === 'medium' ||
        g.severity === 'low'
          ? g.severity
          : 'medium';
      checks.push({
        id: `grounding:${g.check}:${checks.length}`,
        label: `Grounding — ${g.check}`,
        status,
        detail: g.detail.slice(0, 200),
        // Grounding findings ARE fixable in the editor via "Fix with Meri". They
        // were marked unfixable, which hid the only route to resolving the most
        // serious class of finding the auditor produces.
        fixable: true,
        severity,
        section: sectionFromFindingDetail(g.detail, sections),
      });
    }

    const passed = checks.filter((c) => c.status === 'success').length;

    return {
      checks,
      score: { passed, total: checks.length },
      verification: this.verificationSummary(cfg),
      context: this.contextSummary(cfg),
      staleness: this.staleness(cfg, draft.updatedAt),
    };
  }

  /**
   * Derive the verification verdict from what the last generation actually
   * captured. A draft that was never generated (or predates the auditor) reports
   * not_verified - never "no issues found", which would imply a passed check.
   */
  private verificationSummary(cfg: Record<string, unknown>): WsVerificationSummary {
    const provenance = cfg.contextProvenance as { generatedAt?: unknown } | undefined;
    const capturedAt =
      provenance && typeof provenance.generatedAt === 'string' && provenance.generatedAt
        ? provenance.generatedAt
        : null;
    const citations = (cfg.sectionCitations as Record<string, unknown[]> | undefined) ?? {};
    const supportedCount = Object.values(citations).reduce(
      (sum, list) => sum + (Array.isArray(list) ? list.length : 0),
      0,
    );
    const unsupportedCount = readGroundingFindings(cfg).length;
    // The auditor's output only exists once a generation ran it. An ABSENT
    // groundingFindings (as opposed to an empty array) means it never ran.
    const ran =
      capturedAt !== null &&
      Array.isArray((cfg as { groundingFindings?: unknown }).groundingFindings);

    if (!ran) {
      return {
        ran: false,
        state: 'not_verified',
        supportedCount: 0,
        unsupportedCount: 0,
        capturedAt,
        detail: 'No verification has run against this document.',
      };
    }
    if (supportedCount === 0 && unsupportedCount === 0) {
      return {
        ran: true,
        state: 'not_verified',
        supportedCount: 0,
        unsupportedCount: 0,
        capturedAt,
        detail: 'Verification ran but found no source-backed claims to check.',
      };
    }
    if (unsupportedCount > 0) {
      return {
        ran: true,
        state: 'partially_verified',
        supportedCount,
        unsupportedCount,
        capturedAt,
        detail: `${supportedCount} cited claim${supportedCount === 1 ? '' : 's'} · ${unsupportedCount} flagged`,
      };
    }
    return {
      ran: true,
      state: 'verified',
      supportedCount,
      unsupportedCount: 0,
      capturedAt,
      detail: `${supportedCount} cited claim${supportedCount === 1 ? '' : 's'} supported by retrieved evidence.`,
    };
  }

  /**
   * What grounded the last generation. Exclusions carry safe reasons only: nothing
   * here can reveal an item the caller was not authorized to see, because
   * generation only ever received rows that already passed tenant scoping.
   */
  private contextSummary(cfg: Record<string, unknown>): WsChecksContextSummary | null {
    const provenance = cfg.contextProvenance as
      | {
          generatedAt?: unknown;
          contextItems?: unknown;
          memoryFiles?: unknown;
          linkedPeCodes?: unknown;
        }
      | undefined;
    if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return null;
    const items = Array.isArray(provenance.contextItems) ? provenance.contextItems : [];
    const memoryFiles = Array.isArray(provenance.memoryFiles) ? provenance.memoryFiles : [];
    const linkedPeCodes = Array.isArray(provenance.linkedPeCodes) ? provenance.linkedPeCodes : [];
    // An attached item that contributed no body never grounded the text. Generation
    // filters those out, so report the shortfall as an exclusion instead of letting
    // it look like it was used.
    const attached =
      typeof cfg.contextItemCount === 'number' ? cfg.contextItemCount : items.length;
    const exclusions: Array<{ label: string; reason: string }> = [];
    const empty = attached - items.length;
    if (empty > 0) {
      exclusions.push({
        label: `${empty} attached item${empty === 1 ? '' : 's'}`,
        reason: 'empty',
      });
    }
    const run = cfg.lastGenerationRun as { contextDegraded?: unknown } | undefined;
    return {
      capturedAt:
        typeof provenance.generatedAt === 'string' && provenance.generatedAt
          ? provenance.generatedAt
          : null,
      itemCount: items.length,
      memoryFileCount: memoryFiles.length,
      linkedPeCount: linkedPeCodes.length,
      exclusions,
      degraded: run?.contextDegraded === true,
    };
  }

  /**
   * Has the document changed since it was verified? `updatedAt` moves on every
   * autosave, so an edit after generation makes the verdict stale - exactly the
   * condition Step 8 gates export on. The 1s tolerance absorbs the write that
   * generation itself performs.
   */
  private staleness(cfg: Record<string, unknown>, documentUpdatedAt: Date): WsChecksStaleness {
    const provenance = cfg.contextProvenance as { generatedAt?: unknown } | undefined;
    const verifiedAt =
      provenance && typeof provenance.generatedAt === 'string' && provenance.generatedAt
        ? provenance.generatedAt
        : null;
    const verifiedMs = verifiedAt ? new Date(verifiedAt).getTime() : Number.NaN;
    return {
      documentUpdatedAt: documentUpdatedAt.toISOString(),
      verifiedAt,
      // Only claim staleness when BOTH timestamps are real. An unverified document
      // is reported through verification.state, not as "stale".
      changedAfterVerification:
        Number.isFinite(verifiedMs) && documentUpdatedAt.getTime() > verifiedMs + 1000,
    };
  }

  private check(
    id: string,
    label: string,
    r: {
      status: WsCheckStatus;
      detail: string;
      /** Explicit override; otherwise derived from status. */
      severity?: WsCheckSeverity;
      section?: string | null;
    },
  ): WsCheckResult {
    return {
      id,
      label,
      status: r.status,
      detail: r.detail,
      fixable: r.status !== 'success',
      severity:
        r.severity ??
        (r.status === 'critical' ? 'critical' : r.status === 'notable' ? 'medium' : 'low'),
      section: r.section ?? null,
    };
  }

  private askOf(askRaw: unknown, cfg: Record<string, unknown>): WsAskShape {
    const fromCfg = (cfg.ask as WsAskShape | undefined) ?? {};
    if (askRaw && typeof askRaw === 'object') {
      return { ...fromCfg, ...(askRaw as WsAskShape) };
    }
    return fromCfg;
  }

  /** Strip HTML to plain text. */
  private strip(html: string): string {
    return html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private collectText(
    sectionContent: Record<string, string>,
    sections: string[],
    documents: Array<{ body: unknown }>,
  ): string {
    const parts: string[] = [];
    for (const s of sections) parts.push(s, this.strip(sectionContent[s] ?? ''));
    for (const doc of documents) {
      const body =
        (doc.body as { blocks?: Array<{ title?: string; content?: string }> } | null) ?? {};
      for (const b of body.blocks ?? []) {
        if (b.title) parts.push(b.title);
        if (b.content) parts.push(this.strip(b.content));
      }
    }
    return parts.join(' ');
  }

  private wordCount(text: string): number {
    const t = text.trim();
    return t ? t.split(/\s+/).length : 0;
  }

  /**
   * Count ALL-CAPS acronyms (2–6 letters) that never appear defined. An acronym
   * is "defined" if the same token appears immediately after a parenthesized or
   * preceding expansion, e.g. "Program Element (PE)" or "(NDS)". Heuristic.
   */
  private undefinedAcronyms(text: string): number {
    const acronyms = new Set<string>();
    const defined = new Set<string>();
    // Tokens like (PE) or (NDS) are treated as definitions.
    for (const m of text.matchAll(/\(([A-Z]{2,6})\)/g)) {
      if (m[1]) defined.add(m[1]);
    }
    for (const m of text.matchAll(/\b([A-Z]{2,6})\b/g)) {
      const tok = m[1]!;
      // Skip common non-acronym caps (single words, roman numerals-ish).
      if (/^(I|II|III|IV|V|VI|VII|A|THE|AND|OR|OF|TO|FY|US|U)$/.test(tok)) continue;
      acronyms.add(tok);
    }
    let count = 0;
    for (const a of acronyms) if (!defined.has(a)) count++;
    return count;
  }
}

interface WsAskShape {
  amount?: string;
  pb?: string;
  delta?: string;
}
