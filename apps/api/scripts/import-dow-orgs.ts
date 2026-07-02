/**
 * import-dow-orgs.ts — build the acquisition ORG GRAPH from the parsed DoW
 * Directory Update 6 artifacts (the people import only loaded acquisition_personnel;
 * the org/program structure was parsed but never imported).
 *
 *   tsx scripts/import-dow-orgs.ts            # DRY RUN (counts + samples)
 *   tsx scripts/import-dow-orgs.ts --commit   # write
 *
 * Sources (scripts/__data__/dow_directory_v6/):
 *   - dow_v6_people.json  organization / sub_organization / title / role per person —
 *     the CLEAN office signal (roster blocks). dow_v6_orgs.json is NOT imported
 *     wholesale: its 9.5k rows include prose fragments from text segmentation.
 *   - dow_v6_programs.json  126 programs with owner offices.
 *
 * Writes (all rows carry source 'dow_directory_rev6_2026_06' in metadata for a
 * reversible sweep):
 *   - program_office: quality-gated distinct organizations (+ sub-orgs as children,
 *     parentOfficeId set) with officeType classified from the name.
 *   - person_role: person -> office with roleTitle/roleType; the person's OWN
 *     directory entry is deterministic self-assertion -> reviewStatus 'accepted';
 *     contactUse via the compliance policy module. Idempotent per (person, office,
 *     roleTitle, source).
 *   - program + program_alias (canonical) + program_office_program_link
 *     ('manages'; 'accepted' only when the owner exactly matches an imported
 *     office, else skipped — never fuzzy-accepted).
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { normalizeName } from '../src/acquisition-personnel/normalization/name-normalizer.js';
import {
  classifyContactUse,
  type RoleType,
} from '../src/acquisition-personnel/contact-use.policy.js';
import {
  cleanOrgName,
  isCleanOffice,
  classifyOfficeType,
  DOW_ROLE_MAP,
  normalizeDowService,
} from '../src/acquisition-personnel/org-import/dow-org-import.helpers.js';

dotenvConfig();

const COMMIT = process.argv.includes('--commit');
const SOURCE = 'dow_directory_rev6_2026_06';
const DATA_DIR = path.resolve('scripts/__data__/dow_directory_v6');

interface DowPerson {
  full_name: string;
  rank?: string | null;
  title?: string | null;
  organization?: string | null;
  sub_organization?: string | null;
  service?: string | null;
  role?: string | null;
  source_page?: number | null;
  source_pdf_date?: string | null;
  extraction_confidence?: number | null;
  programs_mentioned?: string[] | null;
}
interface DowProgram {
  program: string;
  owners?: string[] | null;
  pages?: number[] | null;
}

// Quality gate + classifiers live in src/acquisition-personnel/org-import/
// dow-org-import.helpers.ts — unit-tested against real directory samples, and
// tunable via scripts/__tools__/eval_dow_org_gate.ts over the full string universe.

async function main(): Promise<void> {
  const people = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'dow_v6_people.json'), 'utf8'),
  ) as DowPerson[];
  const programsRaw = JSON.parse(
    fs.readFileSync(path.join(DATA_DIR, 'dow_v6_programs.json'), 'utf8'),
  ) as DowProgram[];

  // ---- 1. derive office universe from people rows (org + org/sub-org pairs)
  type OfficeSeed = { name: string; parentName: string | null; count: number; services: Map<string, number> };
  const seeds = new Map<string, OfficeSeed>();
  const bump = (name: string, parentName: string | null, svc: string | null) => {
    const key = name.toUpperCase();
    const s = seeds.get(key) ?? { name, parentName, count: 0, services: new Map() };
    s.count += 1;
    if (parentName && !s.parentName) s.parentName = parentName;
    if (svc) s.services.set(svc, (s.services.get(svc) ?? 0) + 1);
    seeds.set(key, s);
  };
  for (const p of people) {
    const org = cleanOrgName(p.organization ?? '');
    const sub = cleanOrgName(p.sub_organization ?? '');
    const svc = normalizeDowService(p.service);
    if (org) bump(org, null, svc);
    if (sub && sub.toUpperCase() !== org.toUpperCase()) bump(sub, org || null, svc);
  }
  const accepted = [...seeds.values()].filter((s) => isCleanOffice(s.name, s.count));
  const rejected = seeds.size - accepted.length;

  // ---- 2. write offices (parent pass then child pass), person roles, programs
  const prisma = new PrismaClient();
  await prisma.$connect();
  let officesCreated = 0;
  let officesExisting = 0;
  let rolesCreated = 0;
  let rolesSkipped = 0;
  let personMiss = 0;
  let programsCreated = 0;
  let linksCreated = 0;
  let linksSkippedNoOffice = 0;
  try {
    const officeIdByName = new Map<string, string>();
    const ensureOffice = async (seed: OfficeSeed): Promise<string | null> => {
      const key = seed.name.toUpperCase();
      const hit = officeIdByName.get(key);
      if (hit) return hit;
      const svc =
        [...seed.services.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      const existing = await prisma.programOffice.findFirst({
        where: { name: { equals: seed.name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (existing) {
        officeIdByName.set(key, existing.id);
        officesExisting += 1;
        return existing.id;
      }
      if (!COMMIT) {
        officesCreated += 1;
        officeIdByName.set(key, `dry-${key}`);
        return null;
      }
      const parentKey = seed.parentName?.toUpperCase();
      const parentId = parentKey ? officeIdByName.get(parentKey) ?? null : null;
      const row = await prisma.programOffice.create({
        data: {
          name: seed.name,
          officeType: classifyOfficeType(seed.name),
          service: svc,
          parentOfficeId: parentId && !parentId.startsWith('dry-') ? parentId : null,
          status: 'active',
          metadata: { source: SOURCE, peopleCount: seed.count },
        },
      });
      officesCreated += 1;
      officeIdByName.set(key, row.id);
      return row.id;
    };
    // parents (no parentName) first so children can reference them
    for (const s of accepted.filter((x) => !x.parentName)) await ensureOffice(s);
    for (const s of accepted.filter((x) => !!x.parentName)) await ensureOffice(s);

    // ---- person -> office roles
    for (const p of people) {
      const orgName = cleanOrgName(p.sub_organization ?? '') || cleanOrgName(p.organization ?? '');
      if (!orgName) continue;
      const officeId = officeIdByName.get(orgName.toUpperCase());
      if (!officeId) {
        rolesSkipped += 1;
        continue;
      }
      const nameKey = normalizeName(p.full_name).nameKey;
      const person = await prisma.acquisitionPersonnel.findFirst({
        where: { nameKey },
        select: { id: true },
      });
      if (!person) {
        personMiss += 1;
        continue;
      }
      if (officeId.startsWith('dry-')) {
        rolesCreated += 1; // dry-run: office would be created; role would follow
        continue;
      }
      const roleType = (DOW_ROLE_MAP[(p.role ?? 'OTHER').toUpperCase()] ?? 'other') as RoleType;
      const roleTitle = (p.title ?? p.role ?? 'listed').slice(0, 200);
      const dup = await prisma.personRole.findFirst({
        where: { personId: person.id, officeId, roleTitle, source: SOURCE },
        select: { id: true },
      });
      if (dup) {
        rolesSkipped += 1;
        continue;
      }
      if (COMMIT) {
        const reviewStatus = 'accepted'; // the person's own directory entry = deterministic self-assertion
        await prisma.personRole.create({
          data: {
            personId: person.id,
            officeId,
            roleTitle,
            roleType,
            source: SOURCE,
            sourceQuote: p.source_page ? `DoW Directory Update 6, p.${p.source_page}` : null,
            observedAt: p.source_pdf_date ? new Date(p.source_pdf_date) : new Date('2026-06-01'),
            confidence: p.extraction_confidence ?? 0.6,
            reviewStatus,
            contactUse: classifyContactUse({ roleType, source: SOURCE, reviewStatus }),
          },
        });
      }
      rolesCreated += 1;
    }

    // ---- programs + owner links
    for (const pr of programsRaw) {
      const name = cleanOrgName(pr.program);
      if (!name || name.length < 3) continue;
      let program = await prisma.program.findFirst({
        where: { canonicalName: { equals: name, mode: 'insensitive' } },
        select: { id: true },
      });
      if (!program && COMMIT) {
        program = await prisma.program.create({
          data: {
            canonicalName: name,
            metadata: { source: SOURCE, pages: pr.pages ?? [] },
            aliases: {
              create: {
                alias: name,
                aliasNormalized: name.toUpperCase().replace(/[^A-Z0-9 ]/g, '').trim(),
                aliasType: 'canonical',
                source: SOURCE,
              },
            },
          },
          select: { id: true },
        });
        programsCreated += 1;
      } else if (!program) {
        programsCreated += 1; // dry-run count
      }
      for (const owner of pr.owners ?? []) {
        const officeId = officeIdByName.get(cleanOrgName(owner).toUpperCase());
        if (!officeId) {
          linksSkippedNoOffice += 1;
          continue;
        }
        if (officeId.startsWith('dry-')) {
          linksCreated += 1; // dry-run: office + link would be created
          continue;
        }
        if (COMMIT && program) {
          await prisma.programOfficeProgramLink.upsert({
            where: { officeId_programId: { officeId, programId: program.id } },
            update: {},
            create: {
              officeId,
              programId: program.id,
              relation: 'manages',
              confidence: 0.8,
              reviewStatus: 'accepted', // exact office-name match only
            },
          });
        }
        linksCreated += 1;
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: COMMIT ? 'COMMIT' : 'DRY_RUN',
          officeSeeds: seeds.size,
          officesAccepted: accepted.length,
          officeSeedsRejectedByQualityGate: rejected,
          officesCreated,
          officesExisting,
          rolesCreated,
          rolesSkipped,
          personMiss,
          programsCreated,
          ownerLinksCreated: linksCreated,
          ownerLinksSkippedNoOffice: linksSkippedNoOffice,
          sampleOffices: accepted.slice(0, 10).map((s) => `${s.name} (${s.count})`),
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
