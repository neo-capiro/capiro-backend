import { Prisma } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { withBillKeywordSqlDeadline } from './bill-keyword-deadline.js';
import { ClientReadCache } from './client-read-cache.js';
import type {
  BillRegulationLink,
  BillRegulationLinksResult,
  BillRegulationRow,
  BillGaoRow,
  BillCrsRow,
  TrackedBillsResult,
  BillEnrichmentPorts,
} from './intelligence-bill-discovery.shared.js';

/**
 * The identifier side of the regulation match, derived from tracked bill ids
 * of the form "119-hr-1234".
 *
 *  - `pattern` is ONE case-insensitive alternation ("HR ?1234|S ?55") that
 *    matches exactly what the former per-bill `ILIKE ANY` list matched
 *    ("HR 1234" and "HR1234" as substrings), evaluated once per row instead of
 *    up to 100 ILIKE passes over every title and abstract.
 *  - `publishedSince` bounds the identifier branch to documents published on
 *    or after the first day of the earliest tracked Congress. A bill number is
 *    only unique within its Congress, so a regulation that cited "HR 1234"
 *    before that Congress was seated referred to a different bill; the bound
 *    is also what lets the planner use the publication-date index instead of
 *    scanning every Federal Register document.
 * Returns null when no identifier parses; the topics branch still runs.
 */
export function billIdentifierSearch(
  bills: ReadonlyArray<{ identifier: string }>,
): { pattern: string; publishedSince: Date } | null {
  const alternatives: string[] = [];
  let earliestCongress = Number.POSITIVE_INFINITY;
  for (const bill of bills) {
    const parts = bill.identifier.split('-');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) continue;
    if (!/^[A-Za-z]+$/.test(parts[1]) || !/^[0-9]+$/.test(parts[2])) continue;
    const congress = Number(parts[0]);
    if (!Number.isSafeInteger(congress) || congress < 1) continue;
    alternatives.push(`${parts[1].toUpperCase()} ?${parts[2]}`);
    earliestCongress = Math.min(earliestCongress, congress);
  }
  if (!alternatives.length) return null;
  // The Nth Congress is seated on January 3 of 1789 + 2(N - 1) (U.S. Const.
  // amend. XX, s. 2, for every Congress this will be asked about).
  const publishedSince = new Date(Date.UTC(1789 + 2 * (earliestCongress - 1), 0, 3));
  return { pattern: `(${[...new Set(alternatives)].join('|')})`, publishedSince };
}

export class IntelligenceBillEnrichment {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: BillEnrichmentPorts,
  ) {}

  /** Reused per (tenant, client) with the tracked bills it derives from; see getTrackedBills. */
  async getBillRegulationLinks(
    clientId: string,
    tenantId: string,
    precomputedTracked?: Promise<TrackedBillsResult> | TrackedBillsResult,
  ): Promise<BillRegulationLinksResult> {
    return this.ports.clientReads().regulationLinks.remember(
      ClientReadCache.key(tenantId, clientId),
      () => this.readBillRegulationLinks(clientId, tenantId, precomputedTracked),
    );
  }

  private async readBillRegulationLinks(
    clientId: string,
    tenantId: string,
    precomputedTracked?: Promise<TrackedBillsResult> | TrackedBillsResult,
  ): Promise<BillRegulationLinksResult> {
    const tracked = await (precomputedTracked ?? this.ports.getTrackedBills(clientId, tenantId));
    if (!tracked.bills.length) {
      return { links: [], totalBills: 0, totalRegulations: 0 };
    }

    // Collect all subjects across bills; identifiers become one bounded regex.
    const allSubjects = new Set<string>();
    for (const b of tracked.bills) for (const s of b.subjectNames) allSubjects.add(s);
    const subjects = [...allSubjects];
    const identifiers = billIdentifierSearch(tracked.bills);

    // Topic overlap is served by the GIN index on topics; the identifier
    // branch is bounded to the tracked Congresses' publication window. Both
    // run under the shared bill-read statement deadline so a slow scan is
    // cancelled server-side instead of holding a pooled connection past the
    // profile's budget.
    const identifierBranch = identifiers
      ? Prisma.sql`OR (publication_date >= ${identifiers.publishedSince}::date
             AND (title ~* ${identifiers.pattern} OR abstract ~* ${identifiers.pattern}))`
      : Prisma.empty;
    const regulations = await withBillKeywordSqlDeadline(this.prisma, (query) =>
      query<BillRegulationRow[]>(Prisma.sql`
      SELECT id, document_number, type, title, agency_names, topics,
             comment_end_date, publication_date, effective_date, significant_rule, html_url
      FROM federal_register_document
      WHERE topics && ${subjects}::text[]
         ${identifierBranch}
      ORDER BY publication_date DESC
      LIMIT 200
    `));

    // Group regulations back to bills by topic overlap or identifier mention.
    const links = this.groupRegulationsByBill(tracked, regulations);

    return {
      links,
      totalBills: tracked.bills.length,
      totalRegulations: regulations.length,
    };
  }

  async getBillResearchAttachments(clientId: string, tenantId: string) {
    const tracked = await this.ports.getTrackedBills(clientId, tenantId);
    if (!tracked.bills.length) {
      return { attachments: [], totalBills: 0, totalReports: 0 };
    }

    const allSubjects = new Set<string>();
    for (const b of tracked.bills) for (const s of b.subjectNames) allSubjects.add(s);
    const subjects = [...allSubjects];
    if (!subjects.length) {
      return { attachments: [], totalBills: tracked.bills.length, totalReports: 0 };
    }

    const [gaoRows, crsRows] = await Promise.all([
      this.prisma.$queryRaw<BillGaoRow[]>`
        SELECT id, title, publish_date, topics, report_type, recommendations, url
        FROM gao_report
        WHERE topics && ${subjects}::text[]
        ORDER BY publish_date DESC NULLS LAST
        LIMIT 150
      `,
      this.prisma.$queryRaw<BillCrsRow[]>`
        SELECT id, title, date, topics, authors, html_url
        FROM crs_report
        WHERE topics && ${subjects}::text[]
          AND active = true
        ORDER BY date DESC NULLS LAST
        LIMIT 150
      `,
    ]);

    const attachments = tracked.bills
      .map((bill) => {
        const billSubjects = new Set(bill.subjectNames);
        const gao = gaoRows
          .filter((r) => r.topics.some((t) => billSubjects.has(t)))
          .slice(0, 8)
          .map((r) => ({
            id: r.id,
            title: r.title,
            publishDate: r.publish_date,
            topics: r.topics.filter((t) => billSubjects.has(t)),
            reportType: r.report_type,
            recommendations: r.recommendations,
            url: r.url,
          }));
        const crs = crsRows
          .filter((r) => r.topics.some((t) => billSubjects.has(t)))
          .slice(0, 8)
          .map((r) => ({
            id: r.id,
            title: r.title,
            date: r.date,
            topics: r.topics.filter((t) => billSubjects.has(t)),
            authors: r.authors,
            htmlUrl: r.html_url,
          }));
        return {
          bill: {
            identifier: bill.identifier,
            title: bill.title,
            latestActionDate: bill.latestActionDate,
          },
          gao,
          crs,
        };
      })
      .filter((a) => a.gao.length > 0 || a.crs.length > 0);

    return {
      attachments,
      totalBills: tracked.bills.length,
      totalReports: gaoRows.length + crsRows.length,
    };
  }

  private groupRegulationsByBill(tracked: TrackedBillsResult, regulations: BillRegulationRow[]): BillRegulationLink[] {
    const links = tracked.bills
      .map((bill) => {
        const billSubjects = new Set(bill.subjectNames);
        const billIdentVariants = (() => {
          const parts = bill.identifier.split('-');
          if (parts.length !== 3 || !parts[1] || !parts[2]) return [];
          const upper = parts[1].toUpperCase();
          const num = parts[2];
          return [`${upper} ${num}`, `${upper}${num}`];
        })().map((s) => s.toLowerCase());

        const matched = regulations.filter((r) => {
          if (r.topics.some((t) => billSubjects.has(t))) return true;
          const haystack = r.title.toLowerCase();
          return billIdentVariants.some((v) => haystack.includes(v));
        });

        return {
          bill: {
            identifier: bill.identifier,
            title: bill.title,
            latestActionDate: bill.latestActionDate,
          },
          regulations: matched.slice(0, 10).map((r) => ({
            documentNumber: r.document_number,
            type: r.type,
            title: r.title,
            agencyNames: r.agency_names,
            publicationDate: r.publication_date,
            commentEndDate: r.comment_end_date,
            effectiveDate: r.effective_date,
            significantRule: r.significant_rule,
            htmlUrl: r.html_url,
            matchedTopics: r.topics.filter((t) => billSubjects.has(t)),
          })),
        };
      })
      .filter((l) => l.regulations.length > 0);
    return links;
  }
}
