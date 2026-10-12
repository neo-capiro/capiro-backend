/** @cleanup-smoke noArgsExit=2 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { normalizeName } from '../src/acquisition-personnel/normalization/name-normalizer.js';
import {
  classifyContactUse,
  type ContactUse,
  type RoleType,
} from '../src/acquisition-personnel/contact-use.policy.js';

/**
 * backfill-program-offices.ts
 *
 * Step 2.2 (plan §8/§14): people hang off OFFICES and ROLES, never directly off
 * PEs. This backfill takes the committed Army PEO/CPE org rosters
 * (scripts/__data__/peo_roster_*.json — same artifacts sync-peo-rosters consumes)
 * and materializes the office/role graph that sync-peo-rosters deliberately did
 * NOT build:
 *
 *   - find-or-create a ProgramOffice per distinct roster org (office_type inferred
 *     deterministically; service from the roster);
 *   - for each roster person already in acquisition_personnel (matched by nameKey),
 *     create a PersonRole linking person -> office (and -> program only when a
 *     confident name/alias match exists), with a compliance contactUse set by the
 *     contact-use policy.
 *
 * It does NOT create people: a roster person with no AcquisitionPersonnel row
 * (by nameKey) is collected and reported as unmatched, never inserted. Run
 * sync-peo-rosters --commit first to seed the people.
 *
 * Idempotent:
 *   - offices on the functional-unique key (name, service, coalesce(valid_from,
 *     -infinity)) — find-or-create, NEVER prisma.upsert (Prisma cannot express the
 *     raw COALESCE() expression index);
 *   - roles on (personId, officeId, roleTitle, source) — find existing first.
 *
 * Usage: tsx scripts/backfill-program-offices.ts            # DRY RUN
 *        tsx scripts/backfill-program-offices.ts --commit    # write offices + roles
 */

// ---------------------------------------------------------------------------
// Roster JSON shape (matches scripts/__data__/peo_roster_*.json).
// ---------------------------------------------------------------------------

export interface RosterPerson {
  fullName: string;
  rank?: string | null;
  role?: string | null;
  roleTitle?: string | null;
  programOfRecord?: string | null;
}

export interface Roster {
  org: string;
  formerName?: string | null;
  service?: string | null;
  source?: string | null;
  asOf?: string | null;
  people: RosterPerson[];
}

/** A loaded roster paired with the file it came from (for provenance / reporting). */
interface LoadedRoster {
  file: string;
  roster: Roster;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit testing — no DB, no NestJS).
// ---------------------------------------------------------------------------

/**
 * Deterministically infer a ProgramOffice.officeType from the roster org name and
 * source string. Checks the most specific signals first:
 *   - "PEO"        -> 'peo'
 *   - "CPE"        -> 'cpe'
 *   - "contracting"-> 'contracting_office'
 *   - otherwise    -> 'other'
 *
 * Both name and source are considered (case-insensitively); the org name takes
 * precedence over the source. "CPE" is matched as a whole token (PEO/CPE are the
 * authoritative Army org prefixes) to avoid spurious substring hits.
 */
export function inferOfficeType(name: string, source?: string | null): string {
  const hay = `${name ?? ''} ${source ?? ''}`;
  const upper = hay.toUpperCase();
  // "contracting" is a phrase, matched case-insensitively anywhere.
  const hasContracting = /contracting/i.test(hay);
  // PEO / CPE matched as whole tokens (word boundaries) so e.g. "RECIPE" or a
  // stray substring does not masquerade as a CPE office.
  const hasPeo = /\bPEO\b/.test(upper);
  const hasCpe = /\bCPE\b/.test(upper);

  if (hasPeo) return 'peo';
  if (hasCpe) return 'cpe';
  if (hasContracting) return 'contracting_office';
  return 'other';
}

/**
 * Normalize a roster `role` token (PEO/PM/STAFF/DEPUTY/...) to a PersonRole.roleType.
 * Unknown / missing roles fall back to 'other'. The returned value is always a valid
 * RoleType so the contact-use policy can classify it.
 */
export function normalizeRoleType(role?: string | null): RoleType {
  switch ((role ?? '').trim().toUpperCase()) {
    case 'PEO':
      return 'peo';
    case 'PM':
      return 'pm';
    case 'DEPUTY':
      return 'deputy';
    case 'STAFF':
      return 'staff';
    default:
      return 'other';
  }
}

/** Compute the nameKey the same way sync-peo-rosters / acquisition_personnel does. */
export function rosterNameKey(fullName: string): string {
  return normalizeName(fullName ?? '').nameKey;
}

/**
 * Result of the conservative program lookup for a roster person. `programId` is
 * non-null ONLY when a confident name/alias match exists; otherwise it is null and
 * the role is created office-only (program linkage is proposed separately and
 * review-gated — we do NOT guess).
 */
export interface ProgramLookupResult {
  programId: string | null;
  matchedOn?: string | null;
}

/** Parse a roster asOf string to a Date, falling back to `now` when absent/invalid. */
export function parseObservedAt(asOf: string | null | undefined, now: Date = new Date()): Date {
  if (!asOf) return now;
  const d = new Date(asOf);
  return Number.isNaN(d.getTime()) ? now : d;
}

/** The exact shape written to person_role.create (contactUse is NEVER undefined). */
export interface PersonRoleInput {
  personId: string;
  officeId: string;
  programId: string | null;
  roleTitle: string;
  roleType: RoleType;
  source: string;
  sourceUrl: null;
  observedAt: Date;
  confidence: number;
  reviewStatus: 'candidate';
  contactUse: ContactUse;
}

/**
 * Build the PersonRole input for a roster person at an office. Pure: takes the
 * resolved personId, the office id, the (already-resolved, conservative) program
 * lookup result, and the roster asOf. ALWAYS sets contactUse via the policy — the
 * column is NOT NULL with no DB default, so it must never be left undefined.
 */
export function buildPersonRoleInput(
  person: RosterPerson,
  personId: string,
  officeId: string,
  programLookup: ProgramLookupResult,
  source: string,
  observedAt: Date,
): PersonRoleInput {
  const roleType = normalizeRoleType(person.role);
  const roleTitle = (person.roleTitle ?? person.role ?? 'Member').trim() || 'Member';
  const reviewStatus = 'candidate' as const;
  const contactUse = classifyContactUse({ roleType, source, reviewStatus });

  return {
    personId,
    officeId,
    programId: programLookup.programId ?? null,
    roleTitle,
    roleType,
    source,
    sourceUrl: null,
    observedAt,
    confidence: 0.95,
    reviewStatus,
    contactUse,
  };
}

// ---------------------------------------------------------------------------
// Office find-or-create (takes an injected prisma-like client so it is testable
// without a real DB). MUST NOT use prisma.programOffice.upsert: the functional
// unique key (name, service, coalesce(valid_from,-infinity)) is a raw SQL
// expression index Prisma cannot express. find-or-create is the only safe path.
// ---------------------------------------------------------------------------

export interface OfficeFindOrCreateInput {
  name: string;
  officeType: string;
  service: string | null;
  validFrom: Date | null;
  metadata: Record<string, unknown>;
}

export interface ProgramOfficeRow {
  id: string;
  name: string;
  officeType: string;
  service: string | null;
  validFrom: Date | null;
}

/** Minimal prisma surface this script needs from programOffice — keeps it injectable. */
export interface ProgramOfficeClient {
  programOffice: {
    findFirst(args: {
      where: { name: string; service: string | null; validFrom: Date | null };
    }): Promise<ProgramOfficeRow | null>;
    create(args: { data: Record<string, unknown> }): Promise<ProgramOfficeRow>;
  };
}

export interface OfficeFindOrCreateResult {
  office: ProgramOfficeRow;
  created: boolean;
}

/**
 * Find-or-create a ProgramOffice on the functional-unique key
 * (name, service, coalesce(valid_from,-infinity)). Idempotent: a re-run with the
 * same key returns the existing row (created=false). Because validFrom is null for
 * these GLOBAL org offices, the COALESCE collapses to a plain (name, service, null)
 * match in Prisma — which is exactly what we query.
 */
export async function findOrCreateOffice(
  client: ProgramOfficeClient,
  input: OfficeFindOrCreateInput,
): Promise<OfficeFindOrCreateResult> {
  const existing = await client.programOffice.findFirst({
    where: { name: input.name, service: input.service, validFrom: input.validFrom },
  });
  if (existing) {
    return { office: existing, created: false };
  }
  const office = await client.programOffice.create({
    data: {
      name: input.name,
      officeType: input.officeType,
      service: input.service,
      validFrom: input.validFrom,
      metadata: input.metadata,
    },
  });
  return { office, created: true };
}

// ---------------------------------------------------------------------------
// Roster loading.
// ---------------------------------------------------------------------------

/**
 * Load all peo_roster_*.json artifacts from the data dir. dow_v6_people.json is a
 * flat per-person directory (no { org, people: [...] } roster envelope), so it does
 * NOT carry org rosters and is intentionally not consumed here — its people are
 * loaded by import-dow-directory-v6 and matched by nameKey below.
 */
export function loadRosters(dataDir: string): LoadedRoster[] {
  const files = fs
    .readdirSync(dataDir)
    .filter((f) => f.startsWith('peo_roster_') && f.endsWith('.json'))
    .sort()
    .map((f) => path.join(dataDir, f));

  return files.map((file) => ({
    file,
    roster: JSON.parse(fs.readFileSync(file, 'utf-8')) as Roster,
  }));
}

// ---------------------------------------------------------------------------
// Summary report.
// ---------------------------------------------------------------------------

interface UnmatchedPerson {
  fullName: string;
  nameKey: string;
  org: string;
  reason: string;
}

interface BackfillReport {
  mode: 'COMMIT' | 'DRY_RUN';
  rosters: number;
  offices_created: number;
  offices_existing: number;
  roles_created: number;
  roles_skipped_existing: number;
  people_unmatched: number;
  unmatched: UnmatchedPerson[];
}

// ---------------------------------------------------------------------------
// main() — guarded so importing this module (for tests) never auto-runs it.
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  dotenvConfig();
  if (!process.env.DATABASE_URL) {
    console.error('Usage: backfill-program-offices [--commit] (requires DATABASE_URL)');
    process.exitCode = 2;
    return;
  }
  const commit = process.argv.includes('--commit');
  const dataDir = path.resolve('scripts/__data__');
  const rosters = loadRosters(dataDir);

  const prisma = new PrismaService();
  await prisma.onModuleInit();

  const report: BackfillReport = {
    mode: commit ? 'COMMIT' : 'DRY_RUN',
    rosters: rosters.length,
    offices_created: 0,
    offices_existing: 0,
    roles_created: 0,
    roles_skipped_existing: 0,
    people_unmatched: 0,
    unmatched: [],
  };

  try {
    // Pre-seed people by nameKey for matching (we never CREATE people here).
    // Non-superseded only: never link a role to a person the system has retired
    // (mirrors acquisition-personnel-read.service + reconcile-personnel-supersede).
    const people = await prisma.acquisitionPersonnel.findMany({
      where: { supersededAt: null },
      select: { id: true, nameKey: true },
    });
    const personByNameKey = new Map<string, string>();
    for (const p of people) if (!personByNameKey.has(p.nameKey)) personByNameKey.set(p.nameKey, p.id);

    // Pre-seed program lookup: canonicalName + every alias, normalized to the
    // alias comparison form. Conservative — only an exact normalized match counts.
    const programs = await prisma.program.findMany({ select: { id: true, canonicalName: true } });
    const aliases = await prisma.programAlias.findMany({ select: { programId: true, aliasNormalized: true } });
    const programByNormalized = new Map<string, string>();
    for (const p of programs) {
      const norm = normalizeProgramText(p.canonicalName);
      if (norm && !programByNormalized.has(norm)) programByNormalized.set(norm, p.id);
    }
    for (const a of aliases) {
      if (a.aliasNormalized && !programByNormalized.has(a.aliasNormalized)) {
        programByNormalized.set(a.aliasNormalized, a.programId);
      }
    }

    const lookupProgram = (programOfRecord?: string | null): ProgramLookupResult => {
      const norm = normalizeProgramText(programOfRecord);
      if (!norm) return { programId: null, matchedOn: null };
      const id = programByNormalized.get(norm);
      return id ? { programId: id, matchedOn: norm } : { programId: null, matchedOn: null };
    };

    for (const { roster } of rosters) {
      const service = roster.service ?? null;
      const officeType = inferOfficeType(roster.org, roster.source);
      const observedAt = parseObservedAt(roster.asOf);
      const source = 'army_cpe_roster';

      // --- Office: find-or-create on the functional-unique key. ---
      const officeMeta = {
        formerName: roster.formerName ?? null,
        rosterSource: roster.source ?? null,
        rosterAsOf: roster.asOf ?? null,
      };

      let officeId: string;
      if (commit) {
        const { office, created } = await findOrCreateOffice(prisma, {
          name: roster.org,
          officeType,
          service,
          validFrom: null,
          metadata: officeMeta,
        });
        officeId = office.id;
        if (created) report.offices_created += 1;
        else report.offices_existing += 1;
      } else {
        // DRY RUN: report whether the office already exists, do not write.
        const existing = await prisma.programOffice.findFirst({
          where: { name: roster.org, service, validFrom: null },
          select: { id: true },
        });
        officeId = existing?.id ?? '(dry-run-office)';
        if (existing) report.offices_existing += 1;
        else report.offices_created += 1;
      }

      // --- Roles: one per matched roster person. ---
      for (const person of roster.people) {
        const fullName = (person.fullName ?? '').trim();
        if (!fullName) continue;
        const nameKey = rosterNameKey(fullName);
        const personId = personByNameKey.get(nameKey);

        if (!personId) {
          report.people_unmatched += 1;
          report.unmatched.push({
            fullName,
            nameKey,
            org: roster.org,
            reason: 'no_acquisition_personnel_by_name_key',
          });
          continue;
        }

        const programLookup = lookupProgram(person.programOfRecord);
        const roleInput = buildPersonRoleInput(person, personId, officeId, programLookup, source, observedAt);

        if (!commit) {
          // Read-only idempotency check so the dry-run forecast matches what
          // --commit would actually insert (otherwise roles_created is inflated on
          // an already-backfilled DB and roles_skipped_existing is always 0).
          if (officeId === '(dry-run-office)') {
            // Office doesn't exist yet -> the role can't exist yet either.
            report.roles_created += 1;
          } else {
            const existingDry = await prisma.personRole.findFirst({
              where: {
                personId: roleInput.personId,
                officeId: roleInput.officeId,
                roleTitle: roleInput.roleTitle,
                source: roleInput.source,
              },
              select: { id: true },
            });
            if (existingDry) report.roles_skipped_existing += 1;
            else report.roles_created += 1;
          }
          continue;
        }

        // Idempotent on (personId, officeId, roleTitle, source).
        const existingRole = await prisma.personRole.findFirst({
          where: {
            personId: roleInput.personId,
            officeId: roleInput.officeId,
            roleTitle: roleInput.roleTitle,
            source: roleInput.source,
          },
          select: { id: true },
        });
        if (existingRole) {
          report.roles_skipped_existing += 1;
          continue;
        }

        await prisma.personRole.create({
          data: {
            personId: roleInput.personId,
            officeId: roleInput.officeId,
            programId: roleInput.programId,
            roleTitle: roleInput.roleTitle,
            roleType: roleInput.roleType,
            source: roleInput.source,
            sourceUrl: roleInput.sourceUrl,
            observedAt: roleInput.observedAt,
            confidence: roleInput.confidence,
            reviewStatus: roleInput.reviewStatus,
            contactUse: roleInput.contactUse,
          },
        });
        report.roles_created += 1;
      }
    }

    console.log(JSON.stringify({ ...report, unmatched_count: report.unmatched.length }, null, 2));
    if (report.unmatched.length > 0) {
      console.log('\nUNMATCHED PEOPLE (no acquisition_personnel by nameKey — NOT created):');
      for (const u of report.unmatched) {
        console.log(`  - ${u.fullName} [${u.nameKey}] (${u.org}) — ${u.reason}`);
      }
    }
  } finally {
    await prisma.onModuleDestroy();
  }
}

/** Normalize a program-of-record string to the alias comparison form. */
function normalizeProgramText(s: string | null | undefined): string {
  return (s ?? '')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Only auto-run when invoked directly (tsx scripts/backfill-program-offices.ts),
// never on import (so the .spec.ts can import the pure helpers).
const invokedDirectly =
  typeof process !== 'undefined' &&
  Array.isArray(process.argv) &&
  /backfill-program-offices\.(ts|js)$/.test(process.argv[1] ?? '');
if (invokedDirectly) {
  void main();
}
