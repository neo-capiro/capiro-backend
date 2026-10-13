import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { AGENCY_SECTOR_MAP, normalizeSector, type SectorTag } from '@capiro/shared';
import type { FederalRegisterDocument } from '@prisma/client';
import type { PrismaService } from '../prisma/prisma.service.js';
import { addCapabilityKeywords } from './client-alerts-v1.shared.js';
import type { ClientRegulatoryPorts, RelevantClientRegulation } from './client-alerts-v1.shared.js';

/** Independent client regulatory discovery and the complete regulatory profile read. */
export class ClientRegulatoryV1 {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ports: ClientRegulatoryPorts,
  ) {}

  async getClientRegulatoryProfile(clientId: string, tenantId: string) {
    const client = await this.prisma.withTenant(tenantId, (tx) =>
      tx.client.findFirst({ where: { id: clientId }, select: { id: true, status: true } }),
    );
    if (!client || client.status === 'archived') throw new NotFoundException('Client not found');
    const now = new Date();
    const results = await Promise.allSettled([
      this.ports.withSourceBudget(
        'billRegulationLinks',
        clientId,
        this.ports.getBillRegulationLinks(clientId, tenantId),
      ),
      this.ports.withSourceBudget(
        'clientRelevantRegulations',
        clientId,
        this.ports.getClientRelevantRegulations(clientId, tenantId, now),
      ),
    ] as const);
    const labels = ['Tracked-bill regulations', 'Client-relevant regulations'];
    const sources = results.map((result, index) => {
      if (result.status === 'rejected') {
        this.ports
          .logger()
          .warn(
            `regulatory-profile source ${labels[index]} failed for client ${clientId}: ${String(result.reason)}`,
          );
      }
      return {
        name: labels[index]!,
        status: result.status === 'fulfilled' ? ('available' as const) : ('unavailable' as const),
      };
    });
    if (results.every((result) => result.status === 'rejected')) {
      throw new ServiceUnavailableException('Regulatory sources are unavailable. Please retry.');
    }
    const links =
      results[0].status === 'fulfilled'
        ? results[0].value
        : { links: [], totalBills: 0, totalRegulations: 0 };
    const relevant = results[1].status === 'fulfilled' ? results[1].value : [];
    return {
      clientId,
      generatedAt: now.toISOString(),
      partial: sources.some((source) => source.status === 'unavailable'),
      sources,
      regulatoryLifecycle: this.ports.buildRegulatoryLifecycle(links, relevant, now),
    };
  }

  async findActiveRegulations(issueCodes: string[], fallbackTerms: string[]) {
    const issueNames: string[] = [];
    if (issueCodes.length) {
      const nameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM lda_issue_code WHERE code = ANY(${issueCodes}::text[])
      `;
      issueNames.push(...nameRows.map((r) => r.name));
    }
    const allTerms = [...issueNames, ...fallbackTerms];
    if (!allTerms.length) return { total: 0, documents: [] };

    const lowerTerms = allTerms.map((n) => n.toLowerCase());
    const wordPatterns = lowerTerms.map((n) => `\\m${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\M`);

    // Separate COUNT so total isn't truncated by the LIMIT 50 page.
    const countRows = await this.prisma.$queryRaw<Array<{ total: bigint }>>`
      SELECT COUNT(*)::bigint AS total
      FROM federal_register_document
      WHERE comment_end_date > NOW()
        AND (
          EXISTS (
            SELECT 1 FROM unnest(topics) t
            WHERE LOWER(t) ~ ANY(${wordPatterns}::text[])
          )
          OR LOWER(title) ~ ANY(${wordPatterns}::text[])
        )
    `;

    const docs = await this.prisma.$queryRaw<
      Array<{
        id: string;
        document_number: string;
        type: string;
        title: string;
        agency_names: string[];
        topics: string[];
        comment_end_date: Date | null;
        publication_date: Date;
        significant_rule: boolean;
        html_url: string | null;
      }>
    >`
      SELECT id, document_number, type, title, agency_names, topics,
             comment_end_date, publication_date, significant_rule, html_url
      FROM federal_register_document
      WHERE comment_end_date > NOW()
        AND (
          EXISTS (
            SELECT 1 FROM unnest(topics) t
            WHERE LOWER(t) ~ ANY(${wordPatterns}::text[])
          )
          OR LOWER(title) ~ ANY(${wordPatterns}::text[])
        )
      ORDER BY comment_end_date ASC
      LIMIT 50
    `;

    const documents = docs.map((d) => ({
      id: d.id,
      documentNumber: d.document_number,
      type: d.type,
      title: d.title,
      agencyNames: d.agency_names,
      topics: d.topics,
      commentEndDate: d.comment_end_date,
      publicationDate: d.publication_date,
      significantRule: d.significant_rule,
      htmlUrl: d.html_url,
    }));

    return { total: Number(countRows[0]?.total ?? 0), documents };
  }

  async getClientRelevantRegulations(
    clientId: string,
    tenantId: string,
    now: Date,
  ): Promise<RelevantClientRegulation[]> {
    try {
      const client = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({
          where: { id: clientId },
          select: {
            id: true,
            sectorTag: true,
            capabilities: { select: { sector: true, tags: true, name: true } },
          },
        }),
      );
      if (!client) return [];
      const ninetyDaysAgo = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
      const docs = await this.prisma.federalRegisterDocument.findMany({
        where: {
          type: { in: ['PROPOSED_RULE', 'RULE'] },
          OR: [{ commentEndDate: { gte: now } }, { publicationDate: { gte: ninetyDaysAgo } }],
        },
        orderBy: { publicationDate: 'desc' },
        take: 200,
      });
      if (!docs.length) return [];
      const capKeywords = new Set<string>();
      if (client.sectorTag) capKeywords.add(String(client.sectorTag).toLowerCase());
      addCapabilityKeywords(capKeywords, client.capabilities);
      const normalizedClientSector = normalizeSector(client.sectorTag);
      return this.matchRegulations(docs, capKeywords, normalizedClientSector);
    } catch (err) {
      this.ports
        .logger()
        .warn(
          `getClientRelevantRegulations failed for ${clientId}: ${err instanceof Error ? err.message : String(err)}`,
        );
      throw err;
    }
  }

  private matchRegulations(
    docs: FederalRegisterDocument[],
    capKeywords: Set<string>,
    normalizedClientSector: SectorTag | null,
  ) {
    const matched: typeof docs = [];
    for (const doc of docs) {
      const agencies = (doc.agencyNames as string[]) ?? [];
      const docSectors = new Set<SectorTag>();
      for (const agency of agencies) {
        for (const sector of AGENCY_SECTOR_MAP[agency] ?? []) docSectors.add(sector);
      }
      let relevant = false;
      if (normalizedClientSector && docSectors.has(normalizedClientSector)) relevant = true;
      if (!relevant) {
        const topics = Array.isArray(doc.topics) ? (doc.topics as string[]) : [];
        for (const topic of topics) {
          const tl = topic.toLowerCase();
          for (const kw of capKeywords) {
            if (tl.includes(kw) || kw.includes(tl)) {
              relevant = true;
              break;
            }
          }
          if (relevant) break;
        }
      }
      if (relevant) matched.push(doc);
      if (matched.length >= 20) break;
    }
    return matched.map((doc) => ({
      documentNumber: doc.documentNumber,
      type: doc.type,
      title: doc.title,
      agencyNames: (doc.agencyNames as string[]) ?? [],
      publicationDate: doc.publicationDate,
      commentEndDate: doc.commentEndDate,
      effectiveDate: doc.effectiveDate,
      htmlUrl: doc.htmlUrl,
    }));
  }
}
