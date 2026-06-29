import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PeRecordForValidation } from './domain-grounding.helpers.js';

/**
 * Retrieve-before-write PE resolution for the Workspace generation engine.
 *
 * The engine is a separate deployable whose own Prisma schema only covers the
 * Ws* draft/document tables — it does NOT own the Program Element tables. But it
 * reads the SAME Postgres, and the PE tables are GLOBAL (no tenant_id / RLS:
 * public-domain J-book data), so we read them directly via a parameterized raw
 * query — exactly the pattern AiCredentialService already uses for
 * tenant_ai_credentials.
 *
 * Why this exists: initial generation previously trusted ONLY the thin PE
 * context the user attached in the Context Builder (cfg.linkedProgramElements:
 * peCode/title/context). If that context was thin or wrong, the writer drafted
 * confidently wrong, and the structural validator only had a bare code to check.
 * The in-editor Meri assistant, by contrast, RETRIEVES the full PE record (real
 * mission, appropriation type, budget activity, budget figures) before drafting.
 * This service closes that asymmetry for the one-shot generation path: it
 * re-resolves each linked PE code to the authoritative DB record so the writer
 * is grounded in real data and the structural checks run against the real
 * appropriation type / budget activity — not whatever was attached.
 */
export interface AuthoritativePeYear {
  fy: number;
  request: number | null;
  enacted: number | null;
  hascMark: number | null;
  sascMark: number | null;
}

export interface AuthoritativePeRecord {
  peCode: string;
  title: string | null;
  description: string | null;
  service: string | null;
  appropriationType: string | null;
  budgetActivity: string | null;
  budgetActivityName: string | null;
  status: string | null;
  years: AuthoritativePeYear[];
}

const MAX_PES = 12;

@Injectable()
export class PeResolverService {
  private readonly logger = new Logger(PeResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a set of PE codes to their authoritative DB records (base row +
   * up to 4 most-recent budget years). Best-effort: a missing/failed code is
   * skipped (never throws) so generation degrades to the attached context
   * rather than failing the draft. Codes are de-duped and capped.
   */
  async resolve(peCodes: Array<string | null | undefined>): Promise<AuthoritativePeRecord[]> {
    const codes = Array.from(
      new Set(
        (peCodes ?? [])
          .filter((c): c is string => typeof c === 'string' && c.trim().length > 0)
          .map((c) => c.trim().toUpperCase()),
      ),
    ).slice(0, MAX_PES);
    if (!codes.length) return [];

    const out: AuthoritativePeRecord[] = [];
    for (const code of codes) {
      try {
        const rows = await this.prisma.$queryRaw<
          Array<{
            peCode: string;
            title: string | null;
            description: string | null;
            service: string | null;
            appropriationType: string | null;
            budgetActivity: string | null;
            budgetActivityName: string | null;
            status: string | null;
            years: AuthoritativePeYear[] | null;
          }>
        >`
          SELECT
            pe.pe_code                AS "peCode",
            pe.title                  AS "title",
            pe.description            AS "description",
            pe.service                AS "service",
            pe.appropriation_type     AS "appropriationType",
            pe.budget_activity        AS "budgetActivity",
            pe.budget_activity_name   AS "budgetActivityName",
            pe.status                 AS "status",
            COALESCE((
              SELECT json_agg(y)
              FROM (
                SELECT
                  fy,
                  request::float8   AS request,
                  enacted::float8   AS enacted,
                  hasc_mark::float8 AS "hascMark",
                  sasc_mark::float8 AS "sascMark"
                FROM program_element_year
                WHERE pe_code = pe.pe_code
                ORDER BY fy DESC
                LIMIT 4
              ) y
            ), '[]'::json) AS "years"
          FROM program_element pe
          WHERE upper(pe.pe_code) = ${code}
          LIMIT 1
        `;
        const row = rows[0];
        if (row) out.push({ ...row, years: row.years ?? [] });
      } catch (err) {
        this.logger.warn(`PE resolve failed for ${code} (skipping): ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * A compact, factual grounding block for one authoritative PE record, to feed
   * the generation prompt. States mission (title/description), appropriation
   * type + budget activity (so the writer matches RDT&E vs procurement framing),
   * and the most-recent budget figures with their fiscal years.
   */
  groundingText(rec: AuthoritativePeRecord): string {
    const head = [`PE ${rec.peCode}`, rec.title].filter(Boolean).join(' — ');
    const lines: string[] = [head];
    if (rec.appropriationType || rec.budgetActivity) {
      const appro = rec.appropriationType ?? 'unknown appropriation';
      const ba = rec.budgetActivity
        ? ` (Budget Activity ${rec.budgetActivity}${
            rec.budgetActivityName ? ` — ${rec.budgetActivityName}` : ''
          })`
        : '';
      lines.push(`Appropriation: ${appro}${ba}.`);
    }
    if (rec.service) lines.push(`Service: ${rec.service}.`);
    if (rec.status) lines.push(`Status: ${rec.status}.`);
    if (rec.description) lines.push(`Mission: ${rec.description.slice(0, 600)}`);
    if (rec.years.length) {
      const fy = rec.years
        .slice(0, 4)
        .map((y) => {
          const parts = [
            y.request != null ? `request $${y.request}M` : null,
            y.enacted != null ? `enacted $${y.enacted}M` : null,
            y.hascMark != null ? `HASC $${y.hascMark}M` : null,
            y.sascMark != null ? `SASC $${y.sascMark}M` : null,
          ].filter(Boolean);
          return parts.length ? `FY${y.fy}: ${parts.join(', ')}` : null;
        })
        .filter(Boolean);
      if (fy.length) lines.push(`Budget: ${fy.join('; ')}.`);
    }
    return lines.join('\n');
  }

  /** Project an authoritative record into the structural-validation shape. */
  toValidationRecord(rec: AuthoritativePeRecord): PeRecordForValidation {
    return {
      peCode: rec.peCode,
      title: rec.title,
      service: rec.service,
      appropriationType: rec.appropriationType,
      budgetActivity: rec.budgetActivity,
      budgetActivityName: rec.budgetActivityName,
    };
  }
}
