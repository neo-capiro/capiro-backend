import type { PrismaService } from '../prisma/prisma.service.js';
import type {
  BillRegulationRow,
  BillGaoRow,
  BillCrsRow,
  TrackedBillsResult,
  BillEnrichmentPorts,
} from './intelligence-bill-discovery.shared.js';

export class IntelligenceBillEnrichment {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: BillEnrichmentPorts,
  ) {}

  async getBillRegulationLinks(
    clientId: string,
    tenantId: string,
    precomputedTracked?: Promise<TrackedBillsResult> | TrackedBillsResult,
  ) {
    const tracked = await (precomputedTracked ?? this.ports.getTrackedBills(clientId, tenantId));
    if (!tracked.bills.length) {
      return { links: [], totalBills: 0, totalRegulations: 0 };
    }

    // Collect all subjects + identifier search terms across bills.
    const allSubjects = new Set<string>();
    const identifierTerms: string[] = [];
    for (const b of tracked.bills) {
      for (const s of b.subjectNames) allSubjects.add(s);
      // Build identifier variants from "119-hr-1234"
      const parts = b.identifier.split('-');
      if (parts.length === 3 && parts[1] && parts[2]) {
        const upper = parts[1].toUpperCase();
        const billNumber = parts[2];
        identifierTerms.push(`%${upper} ${billNumber}%`);
        identifierTerms.push(`%${upper}${billNumber}%`);
      }
    }
    const subjects = [...allSubjects];

    const regulations = await this.prisma.$queryRaw<BillRegulationRow[]>`
      SELECT id, document_number, type, title, agency_names, topics,
             comment_end_date, publication_date, effective_date, significant_rule, html_url
      FROM federal_register_document
      WHERE topics && ${subjects}::text[]
         OR title ILIKE ANY(${identifierTerms}::text[])
         OR abstract ILIKE ANY(${identifierTerms}::text[])
      ORDER BY publication_date DESC
      LIMIT 200
    `;

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

  private groupRegulationsByBill(tracked: TrackedBillsResult, regulations: BillRegulationRow[]) {
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
