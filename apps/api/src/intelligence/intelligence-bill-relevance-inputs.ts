import type { PrismaService } from '../prisma/prisma.service.js';
import type { BillRelevanceTerms } from './intelligence-bill-discovery.shared.js';
import { expandTerms, isKnownAcronym, MIN_KEYWORD_TOKEN_LENGTH } from './term-expansion.js';

export class IntelligenceBillRelevanceInputs {
  constructor(private readonly prisma: PrismaService) {}

  async capabilityFallbackTerms(tenantId: string, clientId: string): Promise<string[]> {
    const terms: string[] = [];
    const caps = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientCapability.findMany({
        where: { clientId },
        select: { sector: true, name: true, tags: true },
      }),
    );
    for (const cap of caps) {
      if (cap.sector) terms.push(cap.sector);
      if (cap.name) {
        cap.name
          .split(/\s+/)
          .filter((w) => w.length > 3)
          .forEach((w) => terms.push(w));
      }
      const tags = Array.isArray(cap.tags) ? (cap.tags as unknown[]) : [];
      for (const t of tags) {
        if (typeof t === 'string' && t.length > 3) terms.push(t);
      }
    }
    return terms;
  }

  async getIssueCodeSignal(clientId: string, tenantId: string) {
    const ldaMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true, externalName: true },
      }),
    );
    const ldaIds = ldaMappings.map((m) => Number(m.externalId)).filter((n) => Number.isFinite(n));

    const ldaCodes: string[] = [];
    if (ldaIds.length) {
      const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
        SELECT DISTINCT unnest(issue_codes) AS code
        FROM lda_client
        WHERE id = ANY(${ldaIds}::int[]) AND issue_codes IS NOT NULL
      `;
      ldaCodes.push(
        ...codeRows.map((r) => r.code).filter((c) => typeof c === 'string' && c.length > 0),
      );
    }

    let overrideCodes: string[] = [];
    let capabilityTagCount = 0;
    let capabilityDescCount = 0;
    try {
      const [client, caps] = await this.prisma.withTenant(tenantId, (tx) =>
        Promise.all([
          tx.client.findFirst({ where: { id: clientId }, select: { issueCodes: true } }),
          tx.clientCapability.findMany({
            where: { clientId },
            select: { tags: true, description: true },
          }),
        ]),
      );
      if (Array.isArray(client?.issueCodes)) {
        overrideCodes = client!.issueCodes.filter((c): c is string => typeof c === 'string');
      }
      capabilityTagCount = caps.reduce(
        (s, c) => s + (Array.isArray(c.tags) ? (c.tags as unknown[]).length : 0),
        0,
      );
      capabilityDescCount = caps.filter(
        (c) => typeof c.description === 'string' && c.description.trim().length > 0,
      ).length;
    } catch {
      // tenant reads unavailable (e.g. mocked tx) — fall back to LDA-only signal.
    }

    const ldaSet = new Set(ldaCodes.map((c) => c.trim()).filter(Boolean));
    const overrideSet = new Set(overrideCodes.map((c) => c.trim()).filter(Boolean));
    const allCodes = Array.from(new Set([...ldaSet, ...overrideSet])).sort();

    const names: Record<string, string> = {};
    if (allCodes.length) {
      const nameRows = await this.prisma.$queryRaw<Array<{ code: string; name: string }>>`
        SELECT code, name FROM lda_issue_code WHERE code = ANY(${allCodes}::text[])
      `;
      for (const r of nameRows) names[r.code] = r.name;
    }

    return {
      clientId,
      ldaRegistrantCount: ldaIds.length,
      ldaRegistrants: ldaMappings.map((m) => m.externalName),
      codes: allCodes.map((code) => ({
        code,
        name: names[code] ?? null,
        source:
          ldaSet.has(code) && overrideSet.has(code) ? 'both' : ldaSet.has(code) ? 'lda' : 'manual',
      })),
      overrideCodeCount: overrideSet.size,
      capabilityTagCount,
      capabilityDescCount,
    };
  }

  async getClientRelevanceTerms(clientId: string, tenantId: string): Promise<BillRelevanceTerms> {
    // Union across ALL confirmed LDA registrants, not just one (a large client
    // files under several registrant-name variants, each a distinct lda_client).
    const { issueCodes, issueNames } = await this.readRelevanceIssueInputs(clientId, tenantId);

    // Build two term sets from the client's capabilities (combined with LDA issue
    // names): keywordTerms (short precise tokens, acronym-expanded) for the
    // whole-word matcher, and embeddingParts (richer prose) for the semantic one.
    const keywordTerms: string[] = [...issueNames];
    const embeddingParts: string[] = [...issueNames];
    let hasCapabilitySignal = false;
    const caps = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientCapability.findMany({
        where: { clientId },
        select: {
          sector: true,
          name: true,
          tags: true,
          description: true,
          justification: true,
          districtNexus: true,
        },
      }),
    );
    hasCapabilitySignal = caps.length > 0;
    for (const cap of caps) {
      if (cap.sector) {
        keywordTerms.push(cap.sector);
        embeddingParts.push(cap.sector);
      }
      if (cap.name) {
        embeddingParts.push(cap.name);
        cap.name
          .split(/\s+/)
          .filter((w) => w.length >= MIN_KEYWORD_TOKEN_LENGTH)
          .forEach((w) => keywordTerms.push(w));
      }
      const tags = Array.isArray(cap.tags)
        ? (cap.tags as unknown[]).filter((t): t is string => typeof t === 'string')
        : [];
      for (const t of tags) {
        embeddingParts.push(t); // any length — the embedding query is cosine-floored
        if (t.trim().length >= MIN_KEYWORD_TOKEN_LENGTH || isKnownAcronym(t)) {
          keywordTerms.push(t);
        }
      }
      for (const rich of [cap.description, cap.justification, cap.districtNexus]) {
        if (rich) embeddingParts.push(rich);
      }
    }

    // Acronym-expand the keyword tokens (EW → electronic warfare, etc.) so short
    // client tags reach the full-phrase vocabulary used by bill subjects.
    const keywordTermsExpanded = expandTerms(keywordTerms)
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    const embeddingPartsClean = embeddingParts
      .map((n) => (typeof n === 'string' ? n.trim() : ''))
      .filter((n) => n.length > 0);

    return {
      issueCodes,
      issueNames,
      keywordTermsExpanded,
      embeddingPartsClean,
      hasCapabilitySignal,
    };
  }

  private async readRelevanceIssueInputs(clientId: string, tenantId: string) {
    const ldaMappings = await this.prisma.withTenant(tenantId, (tx) =>
      tx.clientIntelMapping.findMany({
        where: { clientId, source: 'lda', confirmed: true },
        select: { externalId: true },
      }),
    );

    let issueCodes: string[] = [];
    let issueNames: string[] = [];

    const ldaCodes: string[] = [];
    if (ldaMappings.length) {
      const ldaIds = ldaMappings.map((m) => Number(m.externalId)).filter((n) => Number.isFinite(n));
      if (ldaIds.length) {
        // DISTINCT unnest = the union of issue codes across every confirmed
        // registrant variant for this client.
        const codeRows = await this.prisma.$queryRaw<Array<{ code: string }>>`
          SELECT DISTINCT unnest(issue_codes) AS code
          FROM lda_client
          WHERE id = ANY(${ldaIds}::int[]) AND issue_codes IS NOT NULL
        `;
        ldaCodes.push(
          ...codeRows.map((r) => r.code).filter((c) => typeof c === 'string' && c.length > 0),
        );
      }
    }

    // Client-level manual override (the "LDA Issue Codes" control). Unioned with
    // the auto codes, applied even with NO LDA mapping so a thin-LDA client can
    // still drive matching by hand. Defensive: a mocked tx may not stub client.
    const overrideCodes: string[] = [];
    try {
      const c = await this.prisma.withTenant(tenantId, (tx) =>
        tx.client.findFirst({ where: { id: clientId }, select: { issueCodes: true } }),
      );
      if (Array.isArray(c?.issueCodes)) overrideCodes.push(...c!.issueCodes);
    } catch {
      // tenant client read unavailable (e.g. mocked tx) — no override applied.
    }

    issueCodes = Array.from(
      new Set([...ldaCodes, ...overrideCodes].map((c) => c.trim()).filter(Boolean)),
    );
    if (issueCodes.length) {
      const nameRows = await this.prisma.$queryRaw<Array<{ name: string }>>`
        SELECT name FROM lda_issue_code WHERE code = ANY(${issueCodes}::text[])
      `;
      issueNames = nameRows.map((r) => r.name);
    }
    return { issueCodes, issueNames };
  }
}
