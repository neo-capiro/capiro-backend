import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

/**
 * SourceRuleRepository — the rules-rail twin of SourceDataRepository/
 * StateSourceDataRepository (Phase 1 M3.3, PD4). READ-ONLY against
 * apps/api-owned GLOBAL tables (`federal_register_document` + `state_rule`,
 * same no-RLS posture as congress_bill/state_bill), raw SQL since neither
 * table is in intel-api's own Prisma schema.
 */
export interface SourceRule {
  /** `<documentNumber>` for federal, `<state_rule.id>` for state — the sourceRef stored on intel_alert. */
  id: string;
  jurisdiction: 'federal' | 'state';
  /** null for federal. */
  state: string | null;
  title: string;
  abstract: string | null;
  ruleType: string;
  agency: string;
  publicationDate: Date;
  commentEndDate: Date | null;
  sourceUrl: string | null;
}

@Injectable()
export class SourceRuleRepository {
  constructor(private readonly prisma: PrismaService) {}

  /** Rules synced within the last `sinceHours` — the detector's scan window (see rule-change-detector.service.ts for why a rolling window + dedupeKey substitutes for a per-rule watermark cursor). */
  async getRecentlySyncedRules(sinceHours: number): Promise<SourceRule[]> {
    const [federal, state] = await Promise.all([
      this.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          title: string;
          abstract: string | null;
          type: string;
          agencyNames: string[];
          publicationDate: Date;
          commentEndDate: Date | null;
          htmlUrl: string | null;
        }>
      >(
        `SELECT document_number AS id, title, abstract, type, agency_names AS "agencyNames",
                publication_date AS "publicationDate", comment_end_date AS "commentEndDate", html_url AS "htmlUrl"
           FROM federal_register_document
          WHERE synced_at > now() - ($1 * interval '1 hour')
            AND type IN ('RULE', 'PROPOSED_RULE')`,
        sinceHours,
      ),
      this.prisma.$queryRawUnsafe<
        Array<{
          id: string;
          state: string;
          title: string;
          abstract: string | null;
          ruleType: string;
          agency: string;
          publicationDate: Date;
          commentEndDate: Date | null;
          sourceUrl: string;
        }>
      >(
        `SELECT id, state, title, abstract, rule_type AS "ruleType", agency,
                publication_date AS "publicationDate", comment_end_date AS "commentEndDate", source_url AS "sourceUrl"
           FROM state_rule
          WHERE synced_at > now() - ($1 * interval '1 hour')`,
        sinceHours,
      ),
    ]);

    return [
      ...federal.map((f) => ({
        id: f.id,
        jurisdiction: 'federal' as const,
        state: null,
        title: f.title,
        abstract: f.abstract,
        ruleType: f.type,
        agency: (f.agencyNames ?? []).slice(0, 2).join('/'),
        publicationDate: f.publicationDate,
        commentEndDate: f.commentEndDate,
        sourceUrl: f.htmlUrl,
      })),
      ...state.map((s) => ({
        id: s.id,
        jurisdiction: 'state' as const,
        state: s.state,
        title: s.title,
        abstract: s.abstract,
        ruleType: s.ruleType,
        agency: s.agency,
        publicationDate: s.publicationDate,
        commentEndDate: s.commentEndDate,
        sourceUrl: s.sourceUrl,
      })),
    ];
  }
}
