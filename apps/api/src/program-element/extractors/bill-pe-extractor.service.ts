import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import { GovInfoService } from '../../external/govinfo/govinfo.service.js';

/**
 * Bill text program-code extractor (Step 21).
 *
 * Scans each CongressBill's text (title + summary-ish fields + latest action +
 * cached/fetched full text from GovInfo) for Program Element codes AND
 * procurement BLINs (appropriations bills' funding tables carry both), filters
 * to codes that actually exist in program_element, and upserts the set onto the
 * bill. Emits an IntelligenceChange only when the set changed AND a newly-added
 * line is watched by some tenant.
 */

// Program identifiers embedded in legislative text — two shapes, alternated:
//   - PE code: 7 digits starting 0 or 1, then a service letter, word-bounded so
//     we don't catch longer numeric runs.
//     NOTE: the Step-21 spec wrote /\b[01]\d{2}\d{3}[A-Z]\b/ but that is only 6
//     digits and matches no real PE code (which are 7 digits + letter, e.g.
//     0603270A). Using the 7-digit form so the documented test cases
//     ("0603270A", "0603250F") pass and it agrees with the canonical
//     PE_CODE_REGEX in jbook-extract.ts.
//   - Procurement BLIN: <appropriation><line item>, e.g. 1242C93000. Mirrors
//     PROCUREMENT_CODE_REGEX (jbook-extract.ts) minus the anchors, since this
//     scans free text rather than validating a whole string. A BLIN-shaped
//     match is NOT assumed valid on its own — filterToExisting is what actually
//     confirms it against the known program_element universe.
const BILL_PROGRAM_CODE_REGEX = /\b(?:[01]\d{6}[A-Z]|[0-9]{4}[A-Z]{1,2}[0-9A-Z]{2,14})\b/g;

/** Extract candidate PE/BLIN codes from free text: regex, dedupe, uppercase. */
export function extractProgramCodes(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  for (const m of text.toUpperCase().matchAll(BILL_PROGRAM_CODE_REGEX)) {
    out.add(m[0]);
  }
  return Array.from(out);
}

/**
 * Extract program codes WITH evidence (LEG-B): for each code, which source
 * field it appeared in and a snippet around its first occurrence — what the
 * bill_budget_line_link row renders as "why is this bill linked?".
 * Source priority mirrors trust: full bill text (the funding tables) beats the
 * title, beats the latest-action blurb.
 */
export function extractProgramCodeEvidence(
  parts: Array<{ source: string; text: string }>,
): Map<string, { source: string; snippet: string }> {
  const out = new Map<string, { source: string; snippet: string }>();
  for (const part of parts) {
    if (!part.text) continue;
    const upper = part.text.toUpperCase();
    for (const m of upper.matchAll(BILL_PROGRAM_CODE_REGEX)) {
      const code = m[0];
      if (out.has(code)) continue; // first (highest-priority) source wins
      const at = m.index ?? 0;
      const start = Math.max(0, at - 100);
      const end = Math.min(part.text.length, at + code.length + 100);
      const snippet = part.text.slice(start, end).replace(/\s+/g, ' ').trim();
      out.set(code, { source: part.source, snippet });
    }
  }
  return out;
}

export interface BillForExtraction {
  id: string;
  congress: number;
  billType: string;
  billNumber: string;
  title: string | null;
  latestActionText: string | null;
  // Optional extra summary-ish text some callers may carry.
  summary?: string | null;
  peCodes: string[];
}

export interface ProcessResult {
  billId: string;
  peCodes: string[];
  changed: boolean;
  emitted: boolean;
}

@Injectable()
export class BillPeExtractorService {
  private readonly logger = new Logger(BillPeExtractorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly govInfo: GovInfoService,
  ) {}

  /**
   * Process every CongressBill. Returns per-bill results.
   *
   * peBearingOnly (default true): only fetch GovInfo full text for bills that can
   * carry PE-code funding tables (defense-authorization + appropriations). Local
   * metadata is still scanned for EVERY bill; only the rate-limited GovInfo fetch
   * is scoped — the difference between a minutes-long run over ~dozens of bills and
   * a multi-day full-corpus scan that exhausts the shared api.data.gov quota. Pass
   * peBearingOnly:false to force the old fetch-everything behavior.
   */
  async run(
    opts: { fetchFullText?: boolean; peBearingOnly?: boolean } = {},
  ): Promise<ProcessResult[]> {
    const bills = await this.prisma.congressBill.findMany({
      select: {
        id: true,
        congress: true,
        billType: true,
        billNumber: true,
        title: true,
        latestActionText: true,
        peCodes: true,
      },
    });

    const wantFullText = opts.fetchFullText ?? true;
    const peBearingOnly = opts.peBearingOnly ?? true;

    const results: ProcessResult[] = [];
    for (const bill of bills) {
      const fetchFullText = wantFullText && (!peBearingOnly || this.isPeBearingCandidate(bill));
      try {
        results.push(await this.processBill(bill, { fetchFullText }));
      } catch (err) {
        this.logger.warn(
          `Bill ${bill.id} extraction failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return results;
  }

  /**
   * PE-code funding tables only appear in the full text of defense-authorization
   * (NDAA) and appropriations bills. Title-match those so we don't burn a GovInfo
   * fetch on the ~99% of bills that can't carry PE codes.
   */
  isPeBearingCandidate(bill: { title: string | null }): boolean {
    const title = (bill.title ?? '').toLowerCase();
    return /national defense authorization|defense appropriation|department of defense and|military construction|consolidated appropriations|making appropriations|continuing appropriations|further (consolidated |additional )?appropriations|intelligence authorization/.test(
      title,
    );
  }

  /**
   * Extract + persist PE codes for a single bill.
   *
   * fetchFullText (default true): when set, pull and cache the bill's full text
   * from GovInfo (bill_text table) and include it in the scan. The scan always
   * includes the bill's local metadata fields regardless.
   */
  async processBill(
    bill: BillForExtraction,
    opts: { fetchFullText?: boolean } = {},
  ): Promise<ProcessResult> {
    const fetchFullText = opts.fetchFullText ?? true;

    // Ordered most- to least-trusted: the funding tables live in the full text.
    const evidenceParts: Array<{ source: string; text: string }> = [];
    if (fetchFullText) {
      const fullText = await this.ensureFullText(bill);
      if (fullText) evidenceParts.push({ source: 'bill_text', text: fullText });
    }
    evidenceParts.push({ source: 'title', text: bill.title ?? '' });
    if (bill.summary) evidenceParts.push({ source: 'summary', text: bill.summary });
    evidenceParts.push({ source: 'latest_action', text: bill.latestActionText ?? '' });

    const evidenceByCode = extractProgramCodeEvidence(evidenceParts);
    // filterToExisting checks program_element, which carries PE codes AND
    // procurement BLINs, so a BLIN-shaped candidate is validated the same way.
    const filtered = await this.filterToExisting([...evidenceByCode.keys()]);
    const next = filtered.slice().sort();
    const prev = (bill.peCodes ?? []).slice().sort();
    const changed = !this.sameSet(prev, next);

    if (changed) {
      await this.prisma.congressBill.update({
        where: { id: bill.id },
        data: { peCodes: next },
      });
    }
    // Link rows sync even when the SET is unchanged — evidence/snippets can
    // improve (e.g. full text arrives after a title-only pass).
    await this.syncLinkRows(bill.id, next, evidenceByCode);

    if (!changed) {
      return { billId: bill.id, peCodes: next, changed: false, emitted: false };
    }
    const added = next.filter((c) => !prev.includes(c));
    const emitted = await this.maybeEmit(bill, added, next);
    return { billId: bill.id, peCodes: next, changed: true, emitted };
  }

  /**
   * Upsert evidence-bearing bill_budget_line_link rows (LEG-B). A verbatim PE
   * code in official bill text is zero-inference → linkType='explicit_pe_code',
   * accepted, confidence 1.0. This verb owns only its own derivedBy cohort:
   * stale extractor rows for codes no longer present are removed; manual /
   * report-language rows are never touched.
   */
  private async syncLinkRows(
    billId: string,
    codes: string[],
    evidenceByCode: Map<string, { source: string; snippet: string }>,
  ): Promise<void> {
    const SOURCE_LABEL: Record<string, string> = {
      bill_text: 'full bill text',
      title: 'the bill title',
      summary: 'the bill summary',
      latest_action: 'the latest action',
    };
    await this.prisma.billBudgetLineLink.deleteMany({
      where: {
        billId,
        derivedBy: 'bill-pe-extractor@v1',
        peCode: { notIn: codes.length ? codes : ['__none__'] },
      },
    });
    for (const code of codes) {
      const ev = evidenceByCode.get(code);
      const evidence = ev
        ? `${code} appears verbatim in ${SOURCE_LABEL[ev.source] ?? ev.source}: “…${ev.snippet}…”`
        : `${code} appears verbatim in the bill's official text.`;
      await this.prisma.billBudgetLineLink.upsert({
        where: { billId_peCode_linkType: { billId, peCode: code, linkType: 'explicit_pe_code' } },
        create: {
          billId,
          peCode: code,
          linkType: 'explicit_pe_code',
          confidence: 1.0,
          evidence,
          evidenceJson: (ev ?? {}) as object,
          status: 'accepted',
          derivedBy: 'bill-pe-extractor@v1',
        },
        update: { evidence, evidenceJson: (ev ?? {}) as object },
      });
    }
  }

  /** Keep only candidate codes that exist in program_element. */
  private async filterToExisting(candidates: string[]): Promise<string[]> {
    if (candidates.length === 0) return [];
    const rows = await this.prisma.programElement.findMany({
      where: { peCode: { in: candidates } },
      select: { peCode: true },
    });
    const existing = new Set(rows.map((r) => r.peCode));
    return candidates.filter((c) => existing.has(c));
  }

  /**
   * Return cached full text from bill_text, or fetch it from GovInfo and cache it.
   * Returns null when no full text is available (the extractor then relies on the
   * bill's local metadata fields only).
   */
  private async ensureFullText(bill: BillForExtraction): Promise<string | null> {
    const cached = await this.prisma.billText.findUnique({ where: { billId: bill.id } });
    if (cached) return cached.textContent;

    // GovInfo package ids carry a version suffix the bill row doesn't store. The
    // version that carries itemized Program-Element funding tables is the
    // ENROLLED text (enr) for NDAA/appropriations; engrossed/reported come next;
    // the introduced print (ih/is) almost never has PE tables. Try in priority
    // order and cache the first that returns text. (Earlier code only tried
    // ih/is, so e.g. the FY26 NDAA — 706 PE codes in its enrolled text — linked
    // to zero PEs.)
    const candidates = this.govInfoPackageIds(bill);
    for (const packageId of candidates) {
      try {
        const { xml } = await this.govInfo.getBillText(packageId);
        if (!xml) continue;
        await this.prisma.billText.upsert({
          where: { billId: bill.id },
          create: {
            billId: bill.id,
            sourceUrl: `https://www.govinfo.gov/app/details/${packageId}`,
            textContent: xml,
          },
          update: { textContent: xml, fetchedAt: new Date() },
        });
        return xml;
      } catch (err) {
        this.logger.debug(
          `No GovInfo full text for ${bill.id} (${packageId}): ${err instanceof Error ? err.message : String(err)}`,
        );
        // try the next version
      }
    }
    return null;
  }

  /**
   * Build candidate GovInfo BILLS package ids for a bill, ordered most- to
   * least-likely to carry PE funding tables. enr (enrolled) first because that's
   * the final text with the itemized authorization/appropriation tables; then
   * engrossed (es/eh) and reported (rs/rh); introduced (is/ih) last. Returns []
   * when identity is incomplete.
   */
  private govInfoPackageIds(bill: BillForExtraction): string[] {
    if (!bill.congress || !bill.billType || !bill.billNumber) return [];
    const bt = bill.billType.toLowerCase();
    // Only substantive legislation (bills + joint resolutions) ever carries
    // itemized PE funding tables. Simple/concurrent resolutions (hres, sres,
    // hconres, sconres) never do — skip them so we don't burn 6 GovInfo lookups
    // per resolution chasing text that has no PE codes.
    const PE_BEARING_TYPES = new Set(['hr', 's', 'hjres', 'sjres']);
    if (!PE_BEARING_TYPES.has(bt)) return [];
    const stem = `BILLS-${bill.congress}${bt}${bill.billNumber}`;
    const isSenate = bt.startsWith('s');
    const versions = isSenate
      ? ['enr', 'es', 'rs', 'pcs', 'cps', 'is']
      : ['enr', 'eh', 'rh', 'pch', 'cph', 'ih'];
    return versions.map((v) => `${stem}${v}`);
  }

  /**
   * Emit one IntelligenceChange per affected tenant when a newly-added PE is
   * watched. No watched new PE → no emission (set may still have changed).
   */
  private async maybeEmit(
    bill: BillForExtraction,
    addedPeCodes: string[],
    allPeCodes: string[],
  ): Promise<boolean> {
    if (addedPeCodes.length === 0) return false;

    const watches = await this.prisma.programElementWatch.findMany({
      where: { peCode: { in: addedPeCodes } },
      select: { tenantId: true, peCode: true },
    });
    if (watches.length === 0) return false;

    const watchedAdded = Array.from(new Set(watches.map((w) => w.peCode)));
    const byTenant = new Map<string, Set<string>>();
    for (const w of watches) {
      const set = byTenant.get(w.tenantId) ?? new Set<string>();
      set.add(w.peCode);
      byTenant.set(w.tenantId, set);
    }

    const billRef = `${bill.billType.toUpperCase()} ${bill.billNumber} (${bill.congress}th)`;
    await Promise.all(
      Array.from(byTenant.entries()).map(([tenantId, peCodes]) =>
        this.prisma.intelligenceChange
          .create({
            data: {
              source: 'congress_bill',
              changeType: 'bill_pe_linked',
              severity: 'notable',
              title: `${billRef} references a watched Program Element`,
              description: `${bill.title ?? billRef} now references ${Array.from(peCodes).join(', ')}.`,
              relatedClientIds: [],
              relatedIssues: [],
              relatedPeCodes: Array.from(peCodes),
              data: { billId: bill.id, addedPeCodes: watchedAdded, allPeCodes },
            },
          })
          .catch((err: unknown) => {
            this.logger.warn(
              `Failed to emit bill PE change for tenant ${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
            );
          }),
      ),
    );
    return true;
  }

  private sameSet(a: string[], b: string[]): boolean {
    if (a.length !== b.length) return false;
    return a.every((v, i) => v === b[i]);
  }
}
