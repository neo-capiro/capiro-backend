import { Injectable, Logger } from '@nestjs/common';
import {
  currentCycleFyOf,
  currentFunding,
  FUNDING_STAGE_LABEL,
  FUNDING_STAGE_VEHICLE,
} from '@capiro/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import type { PeRecordForValidation, PeAmountForComparison } from './domain-grounding.helpers.js';

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

/** A program-office person tied to the PE (direct pe_primary/secondary link). */
export interface AuthoritativePePerson {
  fullName: string;
  title: string | null;
  organization: string | null;
  role: string | null;
  /** person_role.contact_use for their top role, when it's a guardrail flag. */
  contactUse: string | null;
}

/** A named prime contractor from the J-book performer tables. */
export interface AuthoritativePeContractor {
  performer: string;
  fy: number | null;
  totalCostM: number | null;
}

/** A bill linked to the PE (accepted bill↔budget-line evidence). */
export interface AuthoritativePeBill {
  ref: string; // e.g. "119-hr-8800"
  title: string | null;
  latestAction: string | null;
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
  // Enrichment blocks (each best-effort; empty if unavailable). Grounds the writer
  // in who runs the program, who builds it, and what's moving it legislatively —
  // the intelligence a government-affairs deliverable actually leans on.
  people: AuthoritativePePerson[];
  contractors: AuthoritativePeContractor[];
  bills: AuthoritativePeBill[];
}

const MAX_PES = 12;
const MAX_PEOPLE = 8;
const MAX_CONTRACTORS = 6;
const MAX_BILLS = 6;
// contact_use values that MUST be surfaced as a guardrail in a lobbying deliverable.
const GUARDRAIL_CONTACT_USE = new Set([
  'official_procurement_poc',
  'do_not_contact_procurement_sensitive',
]);

/** Short, writer-facing label for a person's contact_use — only for guardrail values. */
function contactUseLabel(contactUse: string | null): string | null {
  switch (contactUse) {
    case 'official_procurement_poc':
      return 'procurement POC — do not lobby';
    case 'do_not_contact_procurement_sensitive':
      return 'do not contact — source-selection sensitive';
    default:
      return null;
  }
}

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
        if (!row) continue;
        // Enrichment blocks — each best-effort so one bad block never drops the PE.
        const [people, contractors, bills] = await Promise.all([
          this.fetchPeople(code),
          this.fetchContractors(code),
          this.fetchBills(code),
        ]);
        out.push({ ...row, years: row.years ?? [], people, contractors, bills });
      } catch (err) {
        this.logger.warn(`PE resolve failed for ${code} (skipping): ${(err as Error).message}`);
      }
    }
    return out;
  }

  /** Program-office people directly linked to the PE (pe_primary / pe_secondary),
   *  with their top role's contact_use so the writer respects lobbying guardrails. */
  private async fetchPeople(code: string): Promise<AuthoritativePePerson[]> {
    try {
      return await this.prisma.$queryRaw<AuthoritativePePerson[]>`
        SELECT
          ap.full_name    AS "fullName",
          ap.title        AS "title",
          ap.organization AS "organization",
          ap.role         AS "role",
          (
            SELECT pr.contact_use FROM person_role pr
            WHERE pr.person_id = ap.id AND pr.review_status <> 'quarantined'
            ORDER BY pr.confidence DESC NULLS LAST
            LIMIT 1
          )               AS "contactUse"
        FROM acquisition_personnel ap
        WHERE ap.superseded_at IS NULL
          AND (upper(ap.pe_primary) = ${code} OR ${code} = ANY(SELECT upper(x) FROM unnest(ap.pe_secondary) x))
        ORDER BY ap.confidence DESC NULLS LAST, ap.last_seen_at DESC
        LIMIT ${MAX_PEOPLE}
      `;
    } catch (err) {
      this.logger.warn(`PE people fetch failed for ${code}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Named prime contractors from the J-book performer tables (real companies only). */
  private async fetchContractors(code: string): Promise<AuthoritativePeContractor[]> {
    try {
      const rows = await this.prisma.$queryRaw<
        Array<{ performer: string; fy: number | null; totalCostM: number | null }>
      >`
        SELECT DISTINCT ON (performer_normalized)
          performer            AS "performer",
          fy                   AS "fy",
          total_cost_m::float8 AS "totalCostM"
        FROM program_element_performer
        WHERE upper(pe_code) = ${code} AND is_named_company = true
        ORDER BY performer_normalized, fy DESC, total_cost_m DESC NULLS LAST
      `;
      return rows
        .sort((a, b) => (b.totalCostM ?? 0) - (a.totalCostM ?? 0) || (b.fy ?? 0) - (a.fy ?? 0))
        .slice(0, MAX_CONTRACTORS);
    } catch (err) {
      this.logger.warn(`PE contractors fetch failed for ${code}: ${(err as Error).message}`);
      return [];
    }
  }

  /** Bills with accepted bill↔budget-line evidence for this PE, most-recent action first. */
  private async fetchBills(code: string): Promise<AuthoritativePeBill[]> {
    try {
      return await this.prisma.$queryRaw<AuthoritativePeBill[]>`
        SELECT
          b.id                 AS "ref",
          b.title              AS "title",
          b.latest_action_text AS "latestAction"
        FROM bill_budget_line_link l
        JOIN congress_bill b ON b.id = l.bill_id
        WHERE upper(l.pe_code) = ${code} AND l.status = 'accepted'
        ORDER BY b.latest_action_date DESC NULLS LAST
        LIMIT ${MAX_BILLS}
      `;
    } catch (err) {
      this.logger.warn(`PE bills fetch failed for ${code}: ${(err as Error).message}`);
      return [];
    }
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

    // Program office & people (with lobbying-contact guardrail).
    if (rec.people.length) {
      const who = rec.people
        .map((p) => {
          const roleOrg = [p.role || p.title, p.organization].filter(Boolean).join(', ');
          const guard = contactUseLabel(p.contactUse);
          return `${p.fullName}${roleOrg ? ` (${roleOrg})` : ''}${guard ? ` [${guard}]` : ''}`;
        })
        .join('; ');
      lines.push(`Program office & people: ${who}.`);
      if (rec.people.some((p) => p.contactUse && GUARDRAIL_CONTACT_USE.has(p.contactUse))) {
        lines.push(
          'Contact guardrail: people flagged as procurement POC / do-not-contact are program context only — never address them as lobbying targets.',
        );
      }
    }

    // Named prime contractors (J-book performers).
    if (rec.contractors.length) {
      const c = rec.contractors
        .map((x) => {
          const meta = [
            x.fy ? `FY${x.fy}` : null,
            x.totalCostM != null ? `$${x.totalCostM}M` : null,
          ]
            .filter(Boolean)
            .join(', ');
          return `${x.performer}${meta ? ` (${meta})` : ''}`;
        })
        .join('; ');
      lines.push(`Named contractors: ${c}.`);
    }

    // Bills touching this line.
    if (rec.bills.length) {
      const b = rec.bills
        .map(
          (x) =>
            `${x.ref}${x.title ? ` — ${x.title.slice(0, 80)}` : ''}${x.latestAction ? ` (latest: ${x.latestAction.slice(0, 80)})` : ''}`,
        )
        .join('; ');
      lines.push(`Bills touching this line: ${b}.`);
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

  /**
   * Derive a same-portfolio funding figure for the primary-vehicle-overclaim
   * check (domain-grounding.helpers.ts's Rule 3): pick the PE's current cycle
   * FY (shared canonical rule) and that year's furthest-along authoritative
   * number (shared canonical precedence — enacted > … > request), so the
   * comparison uses the exact same "which number counts" logic as every other
   * funding surface in the product. Returns null when there's no year with a
   * usable figure (nothing to compare, not a warning-worthy state).
   */
  toAmountForComparison(rec: AuthoritativePeRecord): PeAmountForComparison | null {
    const fy = currentCycleFyOf(rec.years);
    if (fy == null) return null;
    const year = rec.years.find((y) => y.fy === fy);
    if (!year) return null;
    const pick = currentFunding({
      request: year.request,
      hascMark: year.hascMark,
      sascMark: year.sascMark,
      // This engine's PE view doesn't carry the appropriations-track marks
      // (see runGroundingAuditor's own comment) — absent, not a false zero.
      hacDMark: null,
      sacDMark: null,
      conference: null,
      enacted: year.enacted,
    });
    if (pick.value == null) return null;
    return {
      peCode: rec.peCode,
      title: rec.title,
      amountM: pick.value,
      fy,
      stageLabel: FUNDING_STAGE_LABEL[pick.stage],
      vehicleLabel: FUNDING_STAGE_VEHICLE[pick.stage],
    };
  }
}
