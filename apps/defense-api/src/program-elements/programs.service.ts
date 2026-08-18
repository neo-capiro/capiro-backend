import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma-client/index.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  ALIAS_TYPES,
  buildWhyShown,
  confidenceBand,
  isAllowedAliasType,
  isGenericAlias,
  normalizeAlias,
} from '@capiro/defense-domain/pe-read';
import { DefenseTenantContext } from './program-elements.shared.js';

export type ProgramMatchDecision = 'accept' | 'reject' | 'quarantine';

export interface ResolveProgramMatchInput {
  decision: ProgramMatchDecision;
  notes?: string;
}

export interface CreateAliasInput {
  alias: string;
  aliasType: string;
  source?: string;
}

export interface UpdateAliasInput {
  alias?: string;
  aliasType?: string;
}

export interface MergeProgramsInput {
  keepProgramId: string;
  mergeProgramId: string;
}

/** `to_jsonb(program_alias)` — physical snake_case columns, as the function returns them. */
interface AliasRowJson {
  id: string;
  program_id: string;
  alias: string;
  alias_normalized: string;
  alias_type: string;
  source: string;
  source_url: string | null;
  confidence: number;
  created_at: string;
  updated_at: string;
}

/** Shape the governed function's raw row back into the camelCase alias contract. */
function aliasRowToDto(row: AliasRowJson) {
  return {
    id: row.id,
    programId: row.program_id,
    alias: row.alias,
    aliasNormalized: row.alias_normalized,
    aliasType: row.alias_type,
    source: row.source,
    sourceUrl: row.source_url,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Map a governed-mutation database error onto the HTTP contract.
 *
 * The functions raise with deliberate SQLSTATEs so the application does not have
 * to pattern-match prose: 42501 for the in-database capiro_admin recheck, 22023
 * for an invalid argument or a refused transition, P0002 for a missing row. Each
 * maps to the status the equivalent TypeScript guard produced, so routing the
 * write through the database does not change what a client sees.
 *
 * A 42501 specifically means the application believed the caller was an admin and
 * the database disagreed — that is a real authorization failure and is surfaced
 * as 403, never softened.
 */
function translateGovernedAdminError(error: unknown): unknown {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { code?: unknown }).code ?? '')
      : '';
  const message = error instanceof Error ? error.message : String(error);

  if (code === '42501' || /active capiro_admin membership required/i.test(message)) {
    return new ForbiddenException('active capiro_admin membership required');
  }
  // Prisma surfaces the raw PostgreSQL message for $queryRaw failures, so the
  // SQLSTATE is matched in the text as well as on the error object.
  if (code === 'P0002' || /ERRCODE = 'P0002'/.test(message) || /\bnot found\b/i.test(message)) {
    return new NotFoundException(extractPgMessage(message));
  }
  if (code === '22023' || /22023/.test(message)) {
    return new BadRequestException(extractPgMessage(message));
  }
  return error;
}

/** Pull the RAISE message out of a driver error string, else return it unchanged. */
function extractPgMessage(message: string): string {
  const match = /(?:ERROR|error):\s*(.+?)(?:\n|$)/.exec(message);
  return (match?.[1] ?? message).trim();
}

/**
 * Programs read + review API — the `defense-api` implementation of the frozen
 * Session 1 contract, ported field-for-field from
 * `apps/api/src/program-element/programs/programs.service.ts`.
 *
 * The Program graph tables (program, program_alias, pe_program_match) are GLOBAL
 * reference data (no tenant_id / RLS), same as program_element. The review-queue
 * list/resolve and every admin mutation are capiro_admin only (gated at the
 * controller) and write an AuditLog inside a tenant-scoped transaction.
 *
 * Alias normalization and the generic-label stoplist come from
 * `@capiro/defense-domain/pe-read`, which carries apps/api's exact
 * `normalizeAlias` (including the unicode-dash unification) — a divergent
 * normalizer would create aliases the matcher's pg_trgm index never matches.
 */
@Injectable()
export class ProgramsService {
  constructor(private readonly prisma: PrismaService) {}

  /** GET /programs?q= — alias search (trigram), programs ranked by best alias similarity. */
  async searchPrograms(q: string | undefined, limitRaw?: number) {
    const limit = Math.min(Math.max(limitRaw ?? 25, 1), 100);
    const query = (q ?? '').trim();
    if (!query) {
      const rows = await this.prisma.program.findMany({
        orderBy: { canonicalName: 'asc' },
        take: limit,
        select: { id: true, canonicalName: true, component: true, mdapCode: true, status: true },
      });
      return { data: rows, total: rows.length, q: '' };
    }

    // Normalize to the alias_normalized form (upper, punctuation-stripped) so the
    // trigram operators hit the program_alias_normalized_trgm_idx GIN index. Uses
    // the SHARED normalizer, so the query form and the stored form always agree.
    const norm = normalizeAlias(query);

    type Row = {
      id: string;
      canonicalName: string;
      component: string | null;
      mdapCode: string | null;
      status: string;
      bestAlias: string;
      sim: number;
    };
    const rows = await this.prisma.$queryRaw<Row[]>(Prisma.sql`
      SELECT p.id,
             p.canonical_name      AS "canonicalName",
             p.component,
             p.mdap_code           AS "mdapCode",
             p.status,
             a.alias               AS "bestAlias",
             MAX(similarity(a.alias_normalized, ${norm})) AS "sim"
      FROM program p
      JOIN program_alias a ON a.program_id = p.id
      WHERE a.alias_normalized % ${norm}
      GROUP BY p.id, p.canonical_name, p.component, p.mdap_code, p.status, a.alias
      ORDER BY "sim" DESC, p.canonical_name ASC
      LIMIT ${limit}
    `);

    // Collapse to one row per program (best-matching alias wins).
    const byProgram = new Map<string, Row>();
    for (const r of rows) {
      const prev = byProgram.get(r.id);
      if (!prev || r.sim > prev.sim) byProgram.set(r.id, r);
    }
    const data = Array.from(byProgram.values()).sort((x, y) => y.sim - x.sim);
    return { data, total: data.length, q: query };
  }

  /**
   * GET /programs/:id — program profile: aliases, accepted PE matches (+ titles),
   * awards via mdapCode, performers across linked PEs. Candidates are returned in a
   * separate bucket flagged for review; quarantined matches are NEVER surfaced.
   */
  async getProgram(id: string) {
    const program = await this.prisma.program.findUnique({ where: { id } });
    if (!program) throw new NotFoundException(`Program ${id} not found`);

    const [aliases, matches] = await Promise.all([
      this.prisma.programAlias.findMany({
        where: { programId: id },
        orderBy: [{ aliasType: 'asc' }, { confidence: 'desc' }],
        select: {
          id: true,
          alias: true,
          aliasType: true,
          source: true,
          sourceUrl: true,
          confidence: true,
        },
      }),
      this.prisma.peProgramMatch.findMany({
        // Quarantined/rejected are never surfaced on the profile.
        where: { programId: id, status: { in: ['accepted', 'candidate'] } },
        orderBy: [{ status: 'asc' }, { score: 'desc' }],
      }),
    ]);

    const peCodes = Array.from(new Set(matches.map((m) => m.peCode)));
    const pes = await this.prisma.programElement.findMany({
      where: { peCode: { in: peCodes } },
      select: { peCode: true, title: true, service: true },
    });
    const peByCode = new Map(pes.map((p) => [p.peCode, p]));

    const decorate = (m: (typeof matches)[number]) => ({
      id: m.id,
      peCode: m.peCode,
      projectCode: m.projectCode,
      programElement: peByCode.get(m.peCode) ?? null,
      score: m.score,
      confidenceBand: confidenceBand(m.score),
      evidenceTier: m.evidenceTier,
      status: m.status,
      whyShown: buildWhyShown(m.evidence),
      evidence: m.evidence,
      resolvedAt: m.resolvedAt,
    });

    const accepted = matches.filter((m) => m.status === 'accepted').map(decorate);
    const candidates = matches.filter((m) => m.status === 'candidate').map(decorate);

    // Awards via the MDAP code. NATIVE IDENTITY: `dodAcqProgramCode` is the DoD
    // acquisition-program identity the contract record itself carries; joining it to
    // this program's own `mdapCode` is an equality test between two values of the
    // SAME identity kind, not a derivation of one identity from another.
    const awards = program.mdapCode
      ? await this.prisma.federalAward.findMany({
          where: { dodAcqProgramCode: program.mdapCode },
          orderBy: { actionDate: 'desc' },
          take: 50,
          select: {
            id: true,
            contractorName: true,
            amount: true,
            piid: true,
            actionDate: true,
            awardingAgency: true,
            peCode: true,
          },
        })
      : [];

    // Named primes (R-3) across the accepted PEs.
    const acceptedPeCodes = accepted.map((m) => m.peCode);
    const performers = acceptedPeCodes.length
      ? await this.prisma.programElementPerformer.findMany({
          where: { peCode: { in: acceptedPeCodes }, isNamedCompany: true },
          orderBy: { totalCostM: 'desc' },
          take: 50,
          select: {
            id: true,
            peCode: true,
            performer: true,
            totalCostM: true,
            sourceUrl: true,
            pageNumber: true,
          },
        })
      : [];

    return {
      id: program.id,
      canonicalName: program.canonicalName,
      component: program.component,
      capabilityArea: program.capabilityArea,
      acquisitionPathway: program.acquisitionPathway,
      mdapCode: program.mdapCode,
      description: program.description,
      status: program.status,
      aliases,
      acceptedMatches: accepted,
      candidateMatches: candidates,
      awards,
      performers,
    };
  }

  /**
   * Admin review queue: candidate / quarantined PeProgramMatch rows with the PE
   * title + program name decorated for the reviewer, plus the Why-shown evidence
   * line. weakSignal (<0.50) rows are EXCLUDED — they are never surfaced.
   *
   * `status='all'` means "everything a reviewer can act on" (candidate +
   * quarantined, non-weak), NOT literally every status — returning rejected and
   * accepted rows here would put already-decided matches back in the queue.
   */
  async listMatchQueue(statusRaw: string | undefined, pageRaw?: number, limitRaw?: number) {
    const status = statusRaw ?? 'candidate';
    const page = Math.max(pageRaw ?? 1, 1);
    const limit = Math.min(Math.max(limitRaw ?? 50, 1), 200);

    const where: Prisma.PeProgramMatchWhereInput =
      status === 'all'
        ? { status: { in: ['candidate', 'quarantined'] }, weakSignal: false }
        : status === 'quarantined'
          ? { status: 'quarantined', weakSignal: false }
          : { status };

    const [total, rows] = await Promise.all([
      this.prisma.peProgramMatch.count({ where }),
      this.prisma.peProgramMatch.findMany({
        where,
        orderBy: [{ score: 'desc' }, { createdAt: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    const peCodes = Array.from(new Set(rows.map((r) => r.peCode)));
    const programIds = Array.from(new Set(rows.map((r) => r.programId)));
    const [pes, programs] = await Promise.all([
      this.prisma.programElement.findMany({
        where: { peCode: { in: peCodes } },
        select: { peCode: true, title: true, service: true },
      }),
      this.prisma.program.findMany({
        where: { id: { in: programIds } },
        select: { id: true, canonicalName: true, component: true, mdapCode: true },
      }),
    ]);
    const peByCode = new Map(pes.map((p) => [p.peCode, p]));
    const programById = new Map(programs.map((p) => [p.id, p]));

    return {
      data: rows.map((r) => ({
        id: r.id,
        peCode: r.peCode,
        projectCode: r.projectCode,
        programId: r.programId,
        score: r.score,
        confidenceBand: confidenceBand(r.score),
        evidenceTier: r.evidenceTier,
        status: r.status,
        matchBasis: r.matchBasis,
        whyShown: buildWhyShown(r.evidence),
        evidence: r.evidence,
        programElement: peByCode.get(r.peCode) ?? null,
        program: programById.get(r.programId) ?? null,
        createdAt: r.createdAt,
      })),
      total,
      page,
      limit,
    };
  }

  /**
   * Resolve a PeProgramMatch (capiro_admin only — gated at the controller):
   *   - accept     -> 'accepted'
   *   - reject     -> 'rejected'
   *   - quarantine -> 'quarantined'
   *
   * A CURATED SEED row (evidenceTier='mdap_curated') is protected from being
   * rejected or quarantined here — reject the seed via the curation map, not the
   * review queue. Re-resolving to the SAME status is idempotent and allowed: it
   * still records who confirmed it. Refusing that (as the prior implementation did,
   * by requiring status==='candidate') breaks a reviewer re-confirming a decision
   * and makes accept-then-accept a 400.
   */
  async resolveMatch(id: string, input: ResolveProgramMatchInput, ctx: DefenseTenantContext) {
    const match = await this.prisma.peProgramMatch.findUnique({ where: { id } });
    if (!match) throw new NotFoundException(`PeProgramMatch ${id} not found`);

    const nextStatus =
      input.decision === 'accept'
        ? 'accepted'
        : input.decision === 'reject'
          ? 'rejected'
          : 'quarantined';

    if (match.evidenceTier === 'mdap_curated' && nextStatus !== 'accepted') {
      throw new BadRequestException(
        'Curated MDAP seed matches cannot be rejected/quarantined via the review queue; edit the curation map instead.',
      );
    }

    // GOVERNED WRITE. capiro_defense_serve holds no DML on pe_program_match, so
    // the status change and its audit row happen inside
    // capiro_defense_resolve_program_match, which re-checks an active
    // capiro_admin membership in the database. The validation above stays here so
    // the HTTP error semantics remain apps/api's; the function repeats the
    // curated-seed refusal as defence in depth.
    await this.governedMutation<{ resolved: boolean; id: string; status: string; decision: string }>(
      Prisma.sql`
        SELECT public.capiro_defense_resolve_program_match(
          ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${id}::uuid,
          ${input.decision}, ${input.notes ?? null}
        ) AS result
      `,
    );

    return { resolved: true as const, id, status: nextStatus, decision: input.decision };
  }

  /**
   * Invoke one governed SECURITY DEFINER mutation and unwrap its jsonb result.
   *
   * Deliberately NOT wrapped in withTenant/withTenantActor: the function takes
   * tenant and actor as parameters and performs its own authorization, so it needs
   * no tenant GUC — and running it outside a transaction means the
   * `app.bypass_rls` its admin check sets transaction-locally cannot outlive the
   * single statement.
   *
   * ERRCODE 42501 from the in-database admin recheck becomes a 403. That is the
   * case where the application believed the caller was an admin and the database
   * disagreed, so surfacing it as anything softer would hide a real
   * authorization failure.
   */
  private async governedMutation<T>(query: Prisma.Sql): Promise<T> {
    try {
      const rows = await this.prisma.$queryRaw<Array<{ result: T }>>(query);
      const result = rows[0]?.result;
      if (result === undefined || result === null) {
        throw new Error('governed Program mutation returned no result row');
      }
      return result;
    } catch (error) {
      throw translateGovernedAdminError(error);
    }
  }

  // -------------------------------------------------------------------------
  // Analyst console: alias manager + program merge (capiro_admin only, gated at
  // the controller). The program graph tables are GLOBAL reference data;
  // AuditLog is TENANT-SCOPED so it is always written inside a tenant tx.
  // -------------------------------------------------------------------------

  private assertAliasType(aliasType: string): void {
    if (!isAllowedAliasType(aliasType)) {
      throw new BadRequestException(
        `aliasType must be one of: ${ALIAS_TYPES.join(', ')} (got '${aliasType}').`,
      );
    }
  }

  /** GET /programs/admin/:programId/aliases — all aliases for a program. */
  async listAliases(programId: string) {
    const program = await this.prisma.program.findUnique({ where: { id: programId } });
    if (!program) throw new NotFoundException(`Program ${programId} not found`);
    const aliases = await this.prisma.programAlias.findMany({
      where: { programId },
      orderBy: [{ aliasType: 'asc' }, { confidence: 'desc' }, { alias: 'asc' }],
      select: {
        id: true,
        programId: true,
        alias: true,
        aliasNormalized: true,
        aliasType: true,
        source: true,
        sourceUrl: true,
        confidence: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    return { programId, data: aliases, total: aliases.length };
  }

  /**
   * POST /programs/admin/:programId/aliases — create an analyst-entered alias.
   * aliasNormalized is computed exactly the way the matcher does (shared
   * normalizeAlias) so the new alias agrees with the pg_trgm index. A generic
   * accounting label is refused, and a duplicate of the
   * (programId, aliasNormalized, aliasType) unique is rejected with a 400 rather
   * than surfacing a raw P2002.
   */
  async createAlias(programId: string, input: CreateAliasInput, ctx: DefenseTenantContext) {
    const aliasText = (input.alias ?? '').trim();
    if (!aliasText) throw new BadRequestException('alias is required.');
    this.assertAliasType(input.aliasType);

    const program = await this.prisma.program.findUnique({ where: { id: programId } });
    if (!program) throw new NotFoundException(`Program ${programId} not found`);

    const aliasNormalized = normalizeAlias(aliasText);
    if (!aliasNormalized) {
      throw new BadRequestException(
        'alias normalizes to an empty string; provide alphanumeric text.',
      );
    }
    if (isGenericAlias(aliasNormalized)) {
      throw new BadRequestException(
        `'${aliasNormalized}' is a generic accounting category (e.g. Congressional Adds / Program-Wide Support / SBIR) and cannot be a program alias — it would false-match unrelated PEs.`,
      );
    }

    const existing = await this.prisma.programAlias.findFirst({
      where: { programId, aliasNormalized, aliasType: input.aliasType },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException(
        `An alias '${aliasNormalized}' of type '${input.aliasType}' already exists on this program.`,
      );
    }

    const source = (input.source ?? '').trim() || 'analyst_manual';
    // GOVERNED WRITE. `aliasNormalized` is computed above by the SHARED normalizer
    // and passed in, so the matcher's pg_trgm index and this row always agree —
    // the function never re-derives it.
    const row = await this.governedMutation<AliasRowJson>(Prisma.sql`
      SELECT public.capiro_defense_create_program_alias(
        ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${programId}::uuid,
        ${aliasText}, ${aliasNormalized}, ${input.aliasType}, ${source}
      ) AS result
    `);
    return aliasRowToDto(row);
  }

  /**
   * PATCH /programs/admin/aliases/:id — edit an alias text and/or type.
   * aliasNormalized is ALWAYS recomputed from the (new or existing) alias text, so
   * a type-only edit cannot leave a stale normalized form behind. A change that
   * would collide with another existing (programId, aliasNormalized, aliasType) row
   * is rejected with a 400.
   */
  async updateAlias(id: string, input: UpdateAliasInput, ctx: DefenseTenantContext) {
    const alias = await this.prisma.programAlias.findUnique({ where: { id } });
    if (!alias) throw new NotFoundException(`ProgramAlias ${id} not found`);

    const nextAlias = input.alias !== undefined ? input.alias.trim() : alias.alias;
    if (!nextAlias) throw new BadRequestException('alias is required.');
    const nextType = input.aliasType !== undefined ? input.aliasType : alias.aliasType;
    if (input.aliasType !== undefined) this.assertAliasType(input.aliasType);

    const nextNormalized = normalizeAlias(nextAlias);
    if (!nextNormalized) {
      throw new BadRequestException(
        'alias normalizes to an empty string; provide alphanumeric text.',
      );
    }
    if (isGenericAlias(nextNormalized)) {
      throw new BadRequestException(
        `'${nextNormalized}' is a generic accounting category and cannot be a program alias.`,
      );
    }

    // Reject a collision with a DIFFERENT alias row on the same program.
    const collision = await this.prisma.programAlias.findFirst({
      where: {
        programId: alias.programId,
        aliasNormalized: nextNormalized,
        aliasType: nextType,
        id: { not: id },
      },
      select: { id: true },
    });
    if (collision) {
      throw new BadRequestException(
        `An alias '${nextNormalized}' of type '${nextType}' already exists on this program.`,
      );
    }

    // GOVERNED WRITE.
    const row = await this.governedMutation<AliasRowJson>(Prisma.sql`
      SELECT public.capiro_defense_update_program_alias(
        ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${id}::uuid,
        ${nextAlias}, ${nextNormalized}, ${nextType}
      ) AS result
    `);
    return aliasRowToDto(row);
  }

  /**
   * DELETE /programs/admin/aliases/:id — remove an alias. Conservatively REFUSES to
   * delete a program's last remaining 'canonical' alias (which would orphan the
   * program's primary name) with a 400.
   */
  async deleteAlias(id: string, ctx: DefenseTenantContext) {
    const alias = await this.prisma.programAlias.findUnique({ where: { id } });
    if (!alias) throw new NotFoundException(`ProgramAlias ${id} not found`);

    if (alias.aliasType === 'canonical') {
      const remainingCanonical = await this.prisma.programAlias.count({
        where: { programId: alias.programId, aliasType: 'canonical', id: { not: id } },
      });
      if (remainingCanonical === 0) {
        throw new BadRequestException(
          "Refusing to delete a program's last 'canonical' alias (it would orphan the program).",
        );
      }
    }

    // GOVERNED WRITE. The function repeats the last-canonical-alias refusal, so
    // the invariant holds even for a caller that reaches the database another way.
    await this.governedMutation<{ deleted: boolean; id: string }>(Prisma.sql`
      SELECT public.capiro_defense_delete_program_alias(
        ${ctx.tenantId}::uuid, ${ctx.userId}::uuid, ${id}::uuid
      ) AS result
    `);

    return { deleted: true as const, id };
  }

  /**
   * GET /programs/admin/duplicate-aliases — every aliasNormalized that maps to MORE
   * THAN ONE distinct program. Each entry lists the colliding programs
   * (canonicalName + status + the offending aliasId) so the analyst can decide
   * whether they are the same program (-> merge) or a true homonym.
   */
  async listDuplicateAliases() {
    const aliases = await this.prisma.programAlias.findMany({
      select: { id: true, programId: true, aliasNormalized: true },
      orderBy: { aliasNormalized: 'asc' },
    });

    // Group by aliasNormalized -> distinct programs.
    const byNorm = new Map<string, Map<string, string>>(); // norm -> (programId -> aliasId)
    for (const a of aliases) {
      let progs = byNorm.get(a.aliasNormalized);
      if (!progs) {
        progs = new Map();
        byNorm.set(a.aliasNormalized, progs);
      }
      // Keep the first aliasId seen for a (norm, program) pair.
      if (!progs.has(a.programId)) progs.set(a.programId, a.id);
    }

    const dupNorms = Array.from(byNorm.entries()).filter(([, progs]) => progs.size > 1);
    const programIds = Array.from(
      new Set(dupNorms.flatMap(([, progs]) => Array.from(progs.keys()))),
    );
    const programs = programIds.length
      ? await this.prisma.program.findMany({
          where: { id: { in: programIds } },
          select: { id: true, canonicalName: true, status: true },
        })
      : [];
    const programById = new Map(programs.map((p) => [p.id, p]));

    const data = dupNorms.map(([aliasNormalized, progs]) => ({
      aliasNormalized,
      programs: Array.from(progs.entries()).map(([programId, aliasId]) => ({
        programId,
        canonicalName: programById.get(programId)?.canonicalName ?? null,
        status: programById.get(programId)?.status ?? null,
        aliasId,
      })),
    }));

    return { data, total: data.length };
  }

  /**
   * POST /programs/admin/merge — fold mergeProgramId INTO keepProgramId in one
   * transaction. The loser is RETIRED (status='merged', metadata.mergedInto /
   * mergedAt) rather than deleted, preserving its id for audit/back-reference. A
   * hard delete would be permanent data loss and would risk dangling references
   * from rows this curated schema does not model on the shared physical database.
   *
   * Each FK table that references programId is re-pointed loser -> keeper. For the
   * tables with a uniqueness constraint involving programId, a loser row whose
   * re-pointed key already exists on the keeper is DELETED instead of updated (it
   * would otherwise raise P2002):
   *   - pe_program_match            unique (peCode, coalesce(projectCode,''), programId)
   *   - program_office_program_link unique (officeId, programId)
   *   - provision_pe_link           unique (provisionId, coalesce(peCode,''), programId)
   *   - person_role                 NO unique on programId -> straight re-point.
   *
   * Omitting person_role / program_office_program_link / provision_pe_link (as the
   * prior implementation did) leaves those rows pointing at a retired program, so
   * the merged program's people, offices and report language silently disappear
   * from every view that joins through them.
   */
  async mergePrograms(input: MergeProgramsInput, ctx: DefenseTenantContext) {
    const { keepProgramId, mergeProgramId } = input;
    if (!keepProgramId || !mergeProgramId) {
      throw new BadRequestException('keepProgramId and mergeProgramId are both required.');
    }
    if (keepProgramId === mergeProgramId) {
      throw new BadRequestException('keepProgramId and mergeProgramId must differ.');
    }

    const [keep, loser] = await Promise.all([
      this.prisma.program.findUnique({ where: { id: keepProgramId } }),
      this.prisma.program.findUnique({ where: { id: mergeProgramId } }),
    ]);
    if (!keep) throw new NotFoundException(`Program ${keepProgramId} (keep) not found`);
    if (!loser) throw new NotFoundException(`Program ${mergeProgramId} (merge) not found`);
    if (loser.status === 'merged') {
      throw new BadRequestException(`Program ${mergeProgramId} is already merged.`);
    }

    // GOVERNED WRITE. The entire graph-safe merge -- collision-delete then
    // re-point for pe_program_match / program_office_program_link /
    // provision_pe_link, straight re-point for person_role, move only
    // non-colliding aliases, retire (never delete) the loser, and the audit row --
    // executes inside capiro_defense_merge_programs as ONE atomic statement that
    // re-checks capiro_admin in the database.
    //
    // Semantics are identical to the gated TypeScript implementation this
    // replaces, including that a colliding alias STAYS with the retired loser
    // (apps/api's behaviour). The DB-backed regression test in
    // programs.service.integration.spec.ts pins every one of those outcomes, so
    // the move to SQL is proven behaviour-preserving rather than assumed.
    return this.governedMutation<{
      merged: true;
      keepProgramId: string;
      mergeProgramId: string;
      repointed: {
        matches: number;
        roles: number;
        officeLinks: number;
        provisionLinks: number;
      };
      aliasesCopied: number;
    }>(Prisma.sql`
      SELECT public.capiro_defense_merge_programs(
        ${ctx.tenantId}::uuid, ${ctx.userId}::uuid,
        ${keepProgramId}::uuid, ${mergeProgramId}::uuid
      ) AS result
    `);
  }
}
