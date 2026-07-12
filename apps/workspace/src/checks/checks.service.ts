import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { WSC } from '../cascade/cascade.config.js';

export type WsCheckStatus = 'success' | 'notable' | 'critical';

export interface WsCheckResult {
  id: string;
  label: string;
  status: WsCheckStatus;
  /** Short evidence line ("$18.0M · +$10.0M", "2 of 3 offices", "9 undefined"). */
  detail: string;
  /** Whether the popover should offer a "Fix" affordance (non-success only). */
  fixable: boolean;
}

export interface WsChecksResponse {
  checks: WsCheckResult[];
  score: { passed: number; total: number };
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

    const passed = checks.filter((c) => c.status === 'success').length;

    return {
      checks,
      score: { passed, total: checks.length },
    };
  }

  private check(
    id: string,
    label: string,
    r: { status: WsCheckStatus; detail: string },
  ): WsCheckResult {
    return { id, label, status: r.status, detail: r.detail, fixable: r.status !== 'success' };
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
