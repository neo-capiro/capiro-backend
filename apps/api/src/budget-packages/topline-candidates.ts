import {
  BUDGET_VEHICLE_CLASSES,
  FUNDING_SCOPES,
  FUNDING_STAGES,
} from '@capiro/shared';

/**
 * Topline staging candidates from the defense-budget parsers (Release R3, §3.3).
 *
 * The parsers' job has always been PE-level marks. When one of them also sees a
 * package-level TOPLINE on a summary page, that figure is emitted here as a
 * `funding_position` CANDIDATE — never as a verified figure:
 *
 *  - every candidate is written with verificationStatus='extracted', so it can be
 *    stored and reviewed but is visibly not yet trusted;
 *  - an ambiguous scope or unit produces a REVIEW WARNING and NO committed
 *    position (§3.3) — the pipeline never guesses which basis a number is on;
 *  - existing Program Element extraction is untouched: this runs after it and
 *    writes to different tables.
 *
 * The exact source excerpt is retained on the position's `note` when the artifact
 * supplies one, so a reviewer can confirm the figure without reopening the PDF.
 *
 * `buildToplineCandidates` is PURE — no DB, no clock — and is where all the
 * validation lives.
 */

/** What a parser artifact may declare alongside its PE rows. */
export interface ArtifactTopline {
  /** @capiro/shared FUNDING_SCOPES. Required: an unscoped dollar figure is unusable. */
  scope?: string;
  amountMillions?: number;
  /** MUST be the literal 'millions'. Anything else is a units error, not a hint. */
  units?: string;
  /** Overrides the parser default (e.g. a CR figure inside a conference artifact). */
  stage?: string;
  vehicleClass?: string;
  sourcePage?: number | null;
  /** Verbatim line from the summary page, retained for review. */
  excerpt?: string | null;
  note?: string | null;
  effectiveDate?: string | null;
  /** Vehicle label to attach to, when the artifact knows it. */
  vehicleLabel?: string | null;
  billId?: string | null;
}

export interface ToplineDefaults {
  domain: string;
  fiscalYear: number;
  /** Parser-level default stage, e.g. 'house' for a HAC-D artifact. */
  stage: string;
  /** Parser-level default vehicle class, e.g. 'appropriation'. */
  vehicleClass: string;
  /** Where the parser read the figure (URL or artifact filename). */
  sourceUrl: string;
  /** source_document.source_key registered by the parser, when available. */
  sourceKey?: string | null;
  /** Human tag for the emitting parser, recorded in the note. */
  emittedBy: string;
}

export interface ToplineCandidate {
  domain: string;
  fiscalYear: number;
  stage: string;
  vehicleClass: string;
  scope: string;
  amountMillions: number;
  sourceUrl: string;
  sourceKey: string | null;
  sourcePage: number | null;
  effectiveDate: string | null;
  vehicleLabel: string | null;
  billId: string | null;
  /** Always 'extracted' — a parser may never promote its own figure. */
  verificationStatus: 'extracted';
  note: string;
}

export interface ToplineCandidateResult {
  candidates: ToplineCandidate[];
  /** Rejected figures, with the reason. Each one is a REVIEW item, not a write. */
  warnings: string[];
}

const SCOPE_SET = new Set<string>(FUNDING_SCOPES);
const STAGE_SET = new Set<string>(FUNDING_STAGES);
const CLASS_SET = new Set<string>(BUDGET_VEHICLE_CLASSES);

/**
 * Validate parser-supplied toplines into committable candidates. A figure that
 * cannot be pinned to a known scope, stage, vehicle class, and explicit unit is
 * dropped with a warning — it never becomes a row.
 */
export function buildToplineCandidates(
  toplines: ArtifactTopline[] | undefined,
  defaults: ToplineDefaults,
): ToplineCandidateResult {
  const candidates: ToplineCandidate[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (const [i, t] of (toplines ?? []).entries()) {
    const at = `toplines[${i}]`;
    const stage = t.stage ?? defaults.stage;
    const vehicleClass = t.vehicleClass ?? defaults.vehicleClass;

    if (!t.scope || !SCOPE_SET.has(t.scope)) {
      warnings.push(
        `${at}: ambiguous scope ${JSON.stringify(t.scope ?? null)} — no position committed. A topline is only meaningful on a known FUNDING_SCOPES basis.`,
      );
      continue;
    }
    if (t.units !== 'millions') {
      warnings.push(
        `${at}: ambiguous units ${JSON.stringify(t.units ?? null)} — no position committed. Declare units:"millions" with amountMillions already converted.`,
      );
      continue;
    }
    if (typeof t.amountMillions !== 'number' || !Number.isFinite(t.amountMillions) || t.amountMillions < 0) {
      warnings.push(
        `${at}: amountMillions must be a finite number >= 0 (got ${JSON.stringify(t.amountMillions ?? null)}) — no position committed.`,
      );
      continue;
    }
    if (!STAGE_SET.has(stage)) {
      warnings.push(`${at}: unknown stage "${stage}" — no position committed.`);
      continue;
    }
    if (!CLASS_SET.has(vehicleClass)) {
      warnings.push(`${at}: unknown vehicleClass "${vehicleClass}" — no position committed.`);
      continue;
    }
    if (!defaults.sourceUrl && !defaults.sourceKey) {
      warnings.push(`${at}: parser supplied no sourceUrl or sourceKey — no position committed.`);
      continue;
    }

    const key = `${stage}|${vehicleClass}|${t.scope}|${defaults.fiscalYear}`;
    if (seen.has(key)) {
      warnings.push(
        `${at}: duplicate (stage, vehicleClass, scope, FY) within one artifact — only the first was kept.`,
      );
      continue;
    }
    seen.add(key);

    const noteParts = [`Extracted by ${defaults.emittedBy}; awaiting review.`];
    if (t.excerpt) noteParts.push(`Source excerpt: "${t.excerpt}"`);
    if (t.note) noteParts.push(t.note);

    candidates.push({
      domain: defaults.domain,
      fiscalYear: defaults.fiscalYear,
      stage,
      vehicleClass,
      scope: t.scope,
      amountMillions: t.amountMillions,
      sourceUrl: defaults.sourceUrl,
      sourceKey: defaults.sourceKey ?? null,
      sourcePage: t.sourcePage ?? null,
      effectiveDate: t.effectiveDate ?? null,
      vehicleLabel: t.vehicleLabel ?? null,
      billId: t.billId ?? null,
      verificationStatus: 'extracted',
      note: noteParts.join(' '),
    });
  }

  return { candidates, warnings };
}

/** The narrow Prisma surface the writer needs (keeps the parsers loosely coupled). */
export interface ToplineWriterClient {
  budgetPackage: {
    findUnique: (a: unknown) => Promise<{ id: string } | null>;
    create: (a: unknown) => Promise<{ id: string }>;
  };
  budgetPackageVehicle: {
    findFirst: (a: unknown) => Promise<{ id: string; billId: string | null } | null>;
  };
  fundingPosition: {
    findFirst: (a: unknown) => Promise<{ id: string; verificationStatus: string } | null>;
    create: (a: unknown) => Promise<unknown>;
    update: (a: unknown) => Promise<unknown>;
  };
  sourceDocument: {
    findFirst: (a: unknown) => Promise<{ id: string } | null>;
  };
}

export interface ToplineWriteResult {
  inserted: number;
  refreshed: number;
  /** Skipped because a REVIEWED/VERIFIED figure already holds that natural key. */
  skippedReviewed: number;
  warnings: string[];
}

/**
 * Persist candidates as `verification_status='extracted'` positions.
 *
 * Rules:
 *  - an existing 'extracted' row for the same natural key is REFRESHED in place
 *    (re-running a parser is idempotent);
 *  - an existing 'reviewed' or 'verified' row is left ALONE and reported — a
 *    parser must never overwrite a human-reviewed figure;
 *  - the package row is created on demand so a candidate is never dropped for
 *    lack of a curated package.
 */
export async function writeToplineCandidates(
  db: ToplineWriterClient,
  candidates: ToplineCandidate[],
  opts: { packageName?: string } = {},
): Promise<ToplineWriteResult> {
  const out: ToplineWriteResult = {
    inserted: 0,
    refreshed: 0,
    skippedReviewed: 0,
    warnings: [],
  };
  if (!candidates.length) return out;

  const { domain, fiscalYear } = candidates[0]!;
  let pkg = await db.budgetPackage.findUnique({
    where: { domain_fiscalYear: { domain, fiscalYear } },
    select: { id: true },
  });
  if (!pkg) {
    pkg = await db.budgetPackage.create({
      data: {
        domain,
        fiscalYear,
        name: opts.packageName ?? `FY${String(fiscalYear).slice(-2)} ${domain} budget`,
        status: 'open',
      },
      select: { id: true },
    });
  }

  for (const c of candidates) {
    const sourceDocumentId = c.sourceKey
      ? ((await db.sourceDocument.findFirst({ where: { sourceKey: c.sourceKey }, select: { id: true } }))
          ?.id ?? null)
      : null;
    if (c.sourceKey && !sourceDocumentId) {
      out.warnings.push(`source_document.source_key "${c.sourceKey}" is not registered`);
    }

    // Attach to a vehicle when the artifact named one; otherwise the candidate is a
    // package-level topline (vehicle_id NULL is allowed for exactly this case).
    const vehicle = c.vehicleLabel
      ? await db.budgetPackageVehicle.findFirst({
          where: {
            packageId: pkg.id,
            track: c.vehicleClass,
            stage: c.stage,
            label: c.vehicleLabel,
          },
          select: { id: true, billId: true },
        })
      : null;
    if (c.vehicleLabel && !vehicle) {
      out.warnings.push(
        `vehicle "${c.vehicleLabel}" (${c.vehicleClass}/${c.stage}) is not registered in the package — candidate stored at package level`,
      );
    }

    const existing = await db.fundingPosition.findFirst({
      where: {
        packageId: pkg.id,
        vehicleId: vehicle?.id ?? null,
        fiscalYear: c.fiscalYear,
        vehicleClass: c.vehicleClass,
        stage: c.stage,
        scope: c.scope,
        verificationStatus: { not: 'superseded' },
      },
      select: { id: true, verificationStatus: true },
    });

    const data = {
      packageId: pkg.id,
      vehicleId: vehicle?.id ?? null,
      billId: c.billId ?? vehicle?.billId ?? null,
      fiscalYear: c.fiscalYear,
      vehicleClass: c.vehicleClass,
      stage: c.stage,
      scope: c.scope,
      amountMillions: c.amountMillions,
      effectiveDate: c.effectiveDate ? new Date(c.effectiveDate) : null,
      sourceUrl: c.sourceUrl,
      sourcePage: c.sourcePage,
      sourceDocumentId,
      note: c.note,
      verificationStatus: 'extracted' as const,
    };

    if (!existing) {
      await db.fundingPosition.create({ data });
      out.inserted += 1;
      continue;
    }
    if (existing.verificationStatus !== 'extracted') {
      out.skippedReviewed += 1;
      out.warnings.push(
        `a ${existing.verificationStatus} figure already holds (${c.stage}/${c.vehicleClass}/${c.scope}/FY${c.fiscalYear}) — parser candidate NOT applied (row ${existing.id})`,
      );
      continue;
    }
    await db.fundingPosition.update({ where: { id: existing.id }, data });
    out.refreshed += 1;
  }

  return out;
}

/**
 * The one call each parser makes (§3.3). Builds, reports, and — only with
 * `commit` — writes the candidates. Returns a JSON-serializable summary the parser
 * folds into its existing output block, so a run always shows what it saw even when
 * it wrote nothing.
 *
 * DRY BY DEFAULT: without `commit` this reports the plan and writes nothing, so a
 * parser that has no dollar-commit flag today keeps writing no toplines until the
 * operator opts in with --commit.
 */
export async function emitToplineCandidates(
  db: ToplineWriterClient,
  toplines: ArtifactTopline[] | undefined,
  defaults: ToplineDefaults,
  opts: { commit: boolean; packageName?: string; log?: (msg: string) => void },
): Promise<{
  seen: number;
  committed: boolean;
  candidates: number;
  warnings: string[];
  write: ToplineWriteResult | null;
}> {
  const log = opts.log ?? ((m: string) => console.warn(m));
  const { candidates, warnings } = buildToplineCandidates(toplines, defaults);
  const seen = (toplines ?? []).length;
  if (!seen) {
    return { seen: 0, committed: false, candidates: 0, warnings: [], write: null };
  }

  for (const w of warnings) log(`  TOPLINE REVIEW  ${w}`);
  for (const c of candidates) {
    log(
      `  TOPLINE CANDIDATE  FY${c.fiscalYear} ${c.stage}/${c.vehicleClass}/${c.scope} = ${c.amountMillions} $M (extracted; p.${c.sourcePage ?? '?'})`,
    );
  }
  if (!opts.commit) {
    log(
      `  TOPLINE DRY RUN  ${candidates.length}/${seen} topline(s) would be staged as 'extracted'. Re-run with --commit to write them.`,
    );
    return { seen, committed: false, candidates: candidates.length, warnings, write: null };
  }

  const write = await writeToplineCandidates(db, candidates, { packageName: opts.packageName });
  for (const w of write.warnings) log(`  TOPLINE REVIEW  ${w}`);
  return {
    seen,
    committed: true,
    candidates: candidates.length,
    warnings: [...warnings, ...write.warnings],
    write,
  };
}
