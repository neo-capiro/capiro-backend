/**
 * Provision loader CORE (Step 2.4 follow-on).
 *
 * Pure-ish, injectable linking logic that turns committee-report provision artifacts
 * into `committee_report_provision` rows + `provision_pe_link` rows. The DB is reached
 * ONLY through an injected, narrow `ProvisionLoaderPrisma` port (a subset of
 * PrismaClient), so the accuracy-critical UPSERT + linking logic is fully unit-testable
 * with a fake — exactly like match-pe-program delegates its logic to a pure matcher.
 *
 * These are GLOBAL tables (no tenant_id / RLS); the caller talks to `this.prisma`
 * directly (raw SQL for the functional-unique upserts) — no withTenant.
 *
 * Linking rules (plan §6 report-language deltas / §7 evidence):
 *   - VERBATIM PE code in heading+text  -> matchBasis='pe_code',      reviewStatus='accepted'  (high confidence, exact)
 *   - project title appears in the text -> matchBasis='project_title', reviewStatus='candidate' (NEVER auto-accept)
 *   - program-alias trigram >= floor    -> matchBasis='program_alias', reviewStatus='candidate' (NEVER auto-accept, capped)
 *
 * Idempotency:
 *   - Provision dedupe key (natural key): (sourceDocumentId-or-'', committee, fy, heading, pageStart-or-null).
 *     Re-running the loader over the same artifact UPDATEs the existing row (text/pageEnd/
 *     actionType) instead of inserting a duplicate.
 *   - Link idempotency key: the DB functional-unique index
 *     (provision_id, COALESCE(pe_code,''), COALESCE(program_id::text,'')) — links upsert
 *     ON CONFLICT DO NOTHING against it, so a re-run produces no duplicate links.
 *     (project_code is intentionally NOT part of the link key, matching the migration.)
 */

import { extractProgramCodes } from '../extractors/bill-pe-extractor.service.js';

/** Trigram floor for a program-alias fuzzy link (candidate-only). */
export const DEFAULT_ALIAS_TRGM_MIN = 0.6;
/** Max number of program-alias candidate links emitted per provision (precision cap). */
export const DEFAULT_MAX_ALIAS_LINKS = 3;
/** Minimum normalized alias length considered for a fuzzy match (precision guard). */
export const DEFAULT_MIN_ALIAS_LEN = 6;

/** One provision as it appears in an artifact. */
export interface ArtifactProvision {
  heading: string;
  text: string;
  pageStart?: number | null;
  pageEnd?: number | null;
}

/** A committee_provisions_<report>_<fy>.json artifact. */
export interface ProvisionArtifact {
  committee: string;
  fy: number;
  sourceDocumentId?: string | null;
  provisions: ArtifactProvision[];
}

/** A program alias (already normalized) to fuzzy-match provision text against. */
export interface ProgramAliasRow {
  programId: string;
  aliasNormalized: string;
}

/** An R-2A project title (verbatim) to substring-match provision text against. */
export interface ProjectTitleRow {
  peCode: string;
  projectCode: string;
  title: string;
}

/** A persisted committee_report_provision (the fields the loader needs back). */
export interface PersistedProvision {
  id: string;
}

/** A link the loader wants to upsert. */
export interface ProvisionLinkRow {
  provisionId: string;
  peCode: string | null;
  projectCode: string | null;
  programId: string | null;
  matchBasis: 'pe_code' | 'project_title' | 'program_alias';
  reviewStatus: 'accepted' | 'candidate';
  confidence: number;
}

/**
 * Narrow DB port the loader needs. A real PrismaClient/PrismaService satisfies this;
 * the spec passes a fake. UPSERTs use raw SQL because both natural keys are functional
 * (COALESCE-based) and Prisma cannot express them.
 */
export interface ProvisionLoaderPrisma {
  /** Existing program aliases (normalized) for fuzzy linking. */
  loadAliases(): Promise<ProgramAliasRow[]>;
  /** Existing R-2A project titles for project-title linking. */
  loadProjectTitles(): Promise<ProjectTitleRow[]>;
  /** Which of these candidate PE codes actually exist in program_element. */
  filterExistingPeCodes(candidates: string[]): Promise<string[]>;
  /**
   * UPSERT a provision on its natural key; returns the row id. Idempotent: a re-run
   * with the same key UPDATEs (no duplicate).
   */
  upsertProvision(input: {
    sourceDocumentId: string | null;
    committee: string;
    fy: number;
    heading: string;
    text: string;
    pageStart: number | null;
    pageEnd: number | null;
    actionType: string | null;
  }): Promise<PersistedProvision>;
  /**
   * Insert a link ON CONFLICT (provision_id, COALESCE(pe_code,''), COALESCE(program_id::text,''))
   * DO NOTHING. Returns the number of rows actually inserted (0 when the link already existed).
   */
  insertLinkIfAbsent(link: ProvisionLinkRow): Promise<number>;
}

export interface LinkOptions {
  aliasTrgmMin?: number;
  maxAliasLinks?: number;
  minAliasLen?: number;
}

/** The three link bases the loader emits. */
export type LinkBasis = 'pe_code' | 'project_title' | 'program_alias';

export interface LoadSummary {
  filesRead: number;
  provisionsUpserted: number;
  linksInsertedByBasis: Record<LinkBasis, number>;
  linksConsideredByBasis: Record<LinkBasis, number>;
}

/** Upper-case, punctuation-stripped, whitespace-collapsed form (mirrors PeProgramMatcherService.normalizeAlias). */
export function normalizeAlias(s: string | null): string {
  return (s ?? '')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** pg_trgm-compatible trigram set (lower-cased internally; pg_trgm is case-insensitive). */
export function trigrams(s: string | null): Set<string> {
  const str = '  ' + normalizeAlias(s).toLowerCase() + ' ';
  const g = new Set<string>();
  for (let i = 0; i < str.length - 2; i++) g.add(str.slice(i, i + 3));
  return g;
}

/**
 * Build the candidate links for ONE persisted provision. PURE — no I/O. Takes the
 * resolved universes (existing PE codes, project titles, alias index) and returns the
 * link rows to upsert. Caller persists them (idempotent at the DB conflict key).
 *
 * Precedence note: a verbatim PE code is the only ACCEPTED basis. project_title and
 * program_alias are always CANDIDATE (human review) and never auto-accepted.
 */
export function buildLinksForProvision(
  provision: { id: string; heading: string; text: string },
  existingPeCodes: Set<string>,
  projectTitles: ProjectTitleRow[],
  aliasIndex: Array<ProgramAliasRow & { tg: Set<string> }>,
  opts: LinkOptions = {},
): ProvisionLinkRow[] {
  const aliasTrgmMin = opts.aliasTrgmMin ?? DEFAULT_ALIAS_TRGM_MIN;
  const maxAliasLinks = opts.maxAliasLinks ?? DEFAULT_MAX_ALIAS_LINKS;
  const minAliasLen = opts.minAliasLen ?? DEFAULT_MIN_ALIAS_LEN;

  const haystack = `${provision.heading}\n${provision.text}`;
  const links: ProvisionLinkRow[] = [];

  // ── 1. Verbatim PE codes / procurement BLINs (reuse the bill extractor's
  // regex) → ACCEPTED. De-duped against the link conflict key (provision,
  // peCode) — extractProgramCodes already returns a de-duplicated set.
  const peCandidates = extractProgramCodes(haystack);
  const existing = peCandidates.filter((c) => existingPeCodes.has(c));
  for (const peCode of existing) {
    links.push({
      provisionId: provision.id,
      peCode,
      projectCode: null,
      programId: null,
      matchBasis: 'pe_code',
      reviewStatus: 'accepted', // verbatim PE number = exact, high confidence
      confidence: 0.99,
    });
  }
  const peLinked = new Set(existing);

  // ── 2. Project-title verbatim substring match → CANDIDATE ──
  // A project's R-2A title appearing in the provision text is a strong-but-reviewable
  // signal (the link conflict key is (provision, peCode); we skip a project whose PE
  // already has a verbatim pe_code link to avoid a redundant lower-status row).
  const normHay = normalizeAlias(haystack);
  for (const proj of projectTitles) {
    const t = proj.title?.trim();
    if (!t || t.length < minAliasLen) continue;
    if (peLinked.has(proj.peCode)) continue;
    const normTitle = normalizeAlias(t);
    if (normTitle.length < minAliasLen) continue;
    if (normHay.includes(normTitle)) {
      links.push({
        provisionId: provision.id,
        peCode: proj.peCode,
        projectCode: proj.projectCode,
        programId: null,
        matchBasis: 'project_title',
        reviewStatus: 'candidate', // NEVER auto-accept a title match
        confidence: 0.7,
      });
      peLinked.add(proj.peCode);
    }
  }

  // ── 3. Program-alias trigram → CANDIDATE (capped) ──
  // Trigram the provision haystack once; score each alias by trigram CONTAINMENT (the
  // fraction of the alias's trigrams present in the haystack), NOT symmetric Jaccard.
  // A provision is a long document, so symmetric Jaccard against a short alias phrase is
  // always tiny (the haystack's trigram count swamps it); containment is the right measure
  // for "does this alias phrase (fuzzily) appear in the text" — the same intuition as
  // pg_trgm word_similarity(). Keep the best `maxAliasLinks` programs above the floor
  // (one link per program; best alias wins).
  const hayTg = trigrams(haystack);
  const bestByProgram = new Map<string, { sim: number }>();
  for (const a of aliasIndex) {
    if (a.aliasNormalized.length < minAliasLen) continue;
    if (!a.tg.size) continue;
    let inter = 0;
    for (const x of Array.from(a.tg)) if (hayTg.has(x)) inter++;
    const sim = inter / a.tg.size; // containment: alias trigrams found in the haystack
    if (sim < aliasTrgmMin) continue;
    const prev = bestByProgram.get(a.programId);
    if (!prev || sim > prev.sim) bestByProgram.set(a.programId, { sim });
  }
  const ranked = Array.from(bestByProgram.entries())
    .sort((x, y) => y[1].sim - x[1].sim)
    .slice(0, maxAliasLinks);
  for (const [programId, { sim }] of ranked) {
    links.push({
      provisionId: provision.id,
      peCode: null,
      projectCode: null,
      programId,
      matchBasis: 'program_alias',
      reviewStatus: 'candidate', // NEVER auto-accept an alias match
      // Cap below the accept band — a fuzzy alias link is corroboration, not proof.
      confidence: Number(Math.min(0.6, sim).toFixed(3)),
    });
  }

  return links;
}

/**
 * Provision loader. Persists provisions + their links idempotently through the injected
 * prisma port. `classify` is injected too (the pure classifyProvisionAction) so the spec
 * can assert classification without importing the live classifier path. No process.exit,
 * no auto-connect — the script wraps this.
 */
export class ProvisionLoader {
  constructor(
    private readonly prisma: ProvisionLoaderPrisma,
    private readonly classify: (text: string) => string | null,
  ) {}

  /**
   * Load a batch of artifacts. `commit=false` (dry run) still runs the full resolution +
   * link computation but performs NO DB write — it counts what WOULD be written.
   */
  async load(
    artifacts: ProvisionArtifact[],
    opts: { commit: boolean } & LinkOptions,
  ): Promise<LoadSummary> {
    const summary: LoadSummary = {
      filesRead: artifacts.length,
      provisionsUpserted: 0,
      linksInsertedByBasis: { pe_code: 0, project_title: 0, program_alias: 0 },
      linksConsideredByBasis: { pe_code: 0, project_title: 0, program_alias: 0 },
    };

    // Resolve the linking universes once.
    const [aliases, projectTitles] = await Promise.all([
      this.prisma.loadAliases(),
      this.prisma.loadProjectTitles(),
    ]);
    const aliasIndex = aliases.map((a) => ({ ...a, tg: trigrams(a.aliasNormalized) }));

    for (const artifact of artifacts) {
      for (const p of artifact.provisions) {
        const actionType = this.classify(p.text);
        const pageStart = p.pageStart ?? null;
        const pageEnd = p.pageEnd ?? null;

        // Resolve which verbatim PE codes / BLINs in this provision actually exist (so
        // a stray number that happens to match the regex doesn't create a phantom link).
        const peCandidates = extractProgramCodes(`${p.heading}\n${p.text}`);
        const existingPeCodes = new Set(
          peCandidates.length ? await this.prisma.filterExistingPeCodes(peCandidates) : [],
        );

        if (!opts.commit) {
          // DRY RUN: still compute the would-be links so the summary is honest, using a
          // synthetic provision id (no row was written).
          const wouldLinks = buildLinksForProvision(
            { id: 'dry-run', heading: p.heading, text: p.text },
            existingPeCodes,
            projectTitles,
            aliasIndex,
            opts,
          );
          summary.provisionsUpserted += 1;
          for (const l of wouldLinks) summary.linksConsideredByBasis[l.matchBasis] += 1;
          continue;
        }

        const persisted = await this.prisma.upsertProvision({
          sourceDocumentId: artifact.sourceDocumentId ?? null,
          committee: artifact.committee,
          fy: artifact.fy,
          heading: p.heading,
          text: p.text,
          pageStart,
          pageEnd,
          actionType,
        });
        summary.provisionsUpserted += 1;

        const links = buildLinksForProvision(
          { id: persisted.id, heading: p.heading, text: p.text },
          existingPeCodes,
          projectTitles,
          aliasIndex,
          opts,
        );
        for (const link of links) {
          summary.linksConsideredByBasis[link.matchBasis] += 1;
          const inserted = await this.prisma.insertLinkIfAbsent(link);
          summary.linksInsertedByBasis[link.matchBasis] += inserted;
        }
      }
    }

    return summary;
  }
}
