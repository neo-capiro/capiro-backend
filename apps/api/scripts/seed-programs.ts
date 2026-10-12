/**
 * seed-programs.ts — Step 2.1 — seed the Program graph from the curated MDAP map.
 *
 *   tsx scripts/seed-programs.ts            # dry-run (reports counts, no writes)
 *   tsx scripts/seed-programs.ts --commit   # write
 *
 * What it does (idempotent):
 *   a. One Program per DISTINCT MDAP code in program_element_acquisition_program
 *      (canonicalName = acqProgramName, mdapCode = code, component inferred from the
 *      first PE's service designator). Re-running upserts on mdapCode.
 *   b. Migrates that table's PE links into PeProgramMatch rows
 *      (evidenceTier='mdap_curated', score=1.0, status='accepted', evidence carries
 *      source 'seed_curated_v1'). PeProgramMatch is the graph's source of truth going
 *      forward; program_element_acquisition_program is kept AS-IS (award attribution
 *      still reads it).
 *   c. Aliases from: the MDAP name, and the PE titles of matched PEs (alias types
 *      'mdap_name' / 'pe_title'). R-2A project titles + P-1 line names are added when
 *      a matched PE has them (alias types 'project_title' / 'p1_line_name').
 *
 * SAFETY: purely additive + idempotent. Upserts keyed by natural keys
 * (program.mdapCode, program_alias unique, pe_program_match unique). NEVER auto-accepts
 * a fuzzy match — only the curated seed lands as 'accepted' here. Default DRY RUN.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { isGenericAlias } from '../src/program-element/matching/alias-stoplist.js';

dotenvConfig();

const SEED_SOURCE = 'seed_curated_v1';

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** Upper-case, punctuation-stripped form — must match PeProgramMatcherService.normalizeAlias. */
function normalizeAlias(s: string | null | undefined): string {
  return (s ?? '')
    .toUpperCase()
    .replace(/[‐-―−]/g, '-')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Component implied by a PE code's trailing designator (mirrors the matcher). */
const SUFFIX_COMPONENT: Array<[string, string]> = [
  ['SF', 'SF'], ['SE', 'OSD'], ['D8Z', 'OSD'], ['DHA', 'OSD'], ['JCY', 'CYBER'], ['KA', 'SOCOM'],
  ['BB', 'NAVY'], ['BR', 'NAVY'], ['BP', 'NAVY'], ['BL', 'NAVY'], ['OTE', 'OSD'],
  ['A', 'ARMY'], ['F', 'AF'], ['N', 'NAVY'], ['M', 'USMC'], ['E', 'DARPA'], ['K', 'SOCOM'],
  ['C', 'OSD'], ['J', 'JOINT'], ['S', 'SOCOM'], ['V', 'OSD'], ['D', 'OSD'], ['X', 'OSD'], ['T', 'OSD'], ['R', 'OSD'],
];
function peComponent(peCode: string): string | null {
  const m = peCode.match(/^[0-9]{7}(.+)$/);
  if (!m) return null;
  const suf = m[1]!.toUpperCase();
  for (const [k, v] of SUFFIX_COMPONENT) if (suf === k) return v;
  for (const [k, v] of SUFFIX_COMPONENT) if (suf.startsWith(k)) return v;
  return null;
}

interface AliasDraft {
  alias: string;
  aliasType: string;
  source: string;
}

async function main(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    console.error('Usage: apps/api/scripts/seed-programs.ts requires DATABASE_URL (database configuration is required)');
    process.exit(2);
  }
  const commit = hasFlag('commit');
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    // 1. Read the curated MDAP -> PE map.
    const links = await prisma.programElementAcquisitionProgram.findMany({
      select: { acqProgramCode: true, acqProgramName: true, peCode: true, confidence: true, source: true },
    });

    // Group by distinct MDAP code.
    const byCode = new Map<string, { name: string | null; peCodes: string[] }>();
    for (const l of links) {
      const code = l.acqProgramCode.trim();
      if (!code || code === '000' || code === 'NONE') continue;
      const g = byCode.get(code) ?? { name: l.acqProgramName ?? null, peCodes: [] };
      if (!g.name && l.acqProgramName) g.name = l.acqProgramName;
      g.peCodes.push(l.peCode.trim().toUpperCase());
      byCode.set(code, g);
    }

    // PE titles + projects for matched PEs (for aliases).
    const allPeCodes = Array.from(new Set(links.map((l) => l.peCode.trim().toUpperCase())));
    const pes = await prisma.programElement.findMany({
      where: { peCode: { in: allPeCodes } },
      select: { peCode: true, title: true },
    });
    const peTitle = new Map(pes.map((p) => [p.peCode.toUpperCase(), p.title]));
    const projects = await prisma.programElementProject.findMany({
      where: { peCode: { in: allPeCodes } },
      select: { peCode: true, title: true },
    });
    const projTitlesByPe = new Map<string, string[]>();
    for (const p of projects) {
      const arr = projTitlesByPe.get(p.peCode.toUpperCase()) ?? [];
      if (p.title?.trim()) arr.push(p.title);
      projTitlesByPe.set(p.peCode.toUpperCase(), arr);
    }

    let programsUpserted = 0;
    let matchesUpserted = 0;
    let aliasesUpserted = 0;
    const samples: Array<{ code: string; name: string | null; peCodes: number; component: string | null }> = [];

    for (const [code, g] of Array.from(byCode.entries())) {
      const canonicalName = g.name ?? code;
      // Component: the dominant PE component among matched PEs (first non-null wins).
      let component: string | null = null;
      for (const pe of g.peCodes) {
        const c = peComponent(pe);
        if (c) { component = c; break; }
      }

      if (samples.length < 25) samples.push({ code, name: g.name, peCodes: g.peCodes.length, component });

      if (!commit) {
        programsUpserted += 1;
        matchesUpserted += g.peCodes.length;
        // alias count estimate: mdap_name + one pe_title per matched PE present + project titles
        const aliasDrafts = collectAliases(canonicalName, g.peCodes, peTitle, projTitlesByPe);
        aliasesUpserted += aliasDrafts.length;
        continue;
      }

      // Upsert the Program (keyed on mdapCode — re-runnable).
      const existing = await prisma.program.findFirst({ where: { mdapCode: code }, select: { id: true } });
      const program = existing
        ? await prisma.program.update({
            where: { id: existing.id },
            data: { canonicalName, component: component ?? undefined },
          })
        : await prisma.program.create({
            data: {
              canonicalName,
              component,
              mdapCode: code,
              status: 'active',
              metadata: { seededFrom: SEED_SOURCE },
            },
          });
      programsUpserted += 1;

      // Migrate each PE link into an accepted PeProgramMatch (curated, score 1.0).
      // The unique key is the functional index (pe_code, coalesce(project_code,''),
      // program_id) which Prisma can't target by name, so do findFirst + update/create.
      for (const peCode of g.peCodes) {
        const evidence = [
          { kind: 'mdap_curated', quote: `MDAP ${code} '${canonicalName}' -> PE ${peCode}`, source: SEED_SOURCE },
        ];
        const existingMatch = await prisma.peProgramMatch.findFirst({
          where: { peCode, projectCode: null, programId: program.id },
          select: { id: true },
        });
        if (existingMatch) {
          // Keep curated rows curated; refresh basis/evidence but never clobber a
          // human decision (resolvedByUserId / status stay as-is).
          await prisma.peProgramMatch.update({
            where: { id: existingMatch.id },
            data: {
              score: 1.0,
              evidenceTier: 'mdap_curated',
              matchBasis: `curated MDAP seed (${code} '${canonicalName}')`,
              evidence,
            },
          });
        } else {
          await prisma.peProgramMatch.create({
            data: {
              peCode,
              projectCode: null,
              programId: program.id,
              score: 1.0,
              evidenceTier: 'mdap_curated',
              status: 'accepted',
              weakSignal: false,
              matchBasis: `curated MDAP seed (${code} '${canonicalName}')`,
              evidence,
            },
          });
        }
        matchesUpserted += 1;
      }

      // Aliases.
      const aliasDrafts = collectAliases(canonicalName, g.peCodes, peTitle, projTitlesByPe);
      for (const d of aliasDrafts) {
        const aliasNormalized = normalizeAlias(d.alias);
        if (!aliasNormalized) continue;
        // Never seed a generic accounting category as an alias (would false-match PEs).
        if (isGenericAlias(aliasNormalized)) continue;
        await prisma.programAlias.upsert({
          where: {
            programId_aliasNormalized_aliasType: {
              programId: program.id,
              aliasNormalized,
              aliasType: d.aliasType,
            },
          },
          create: {
            programId: program.id,
            alias: d.alias,
            aliasNormalized,
            aliasType: d.aliasType,
            source: d.source,
            confidence: d.aliasType === 'canonical' || d.aliasType === 'mdap_name' ? 1.0 : 0.9,
          },
          update: { alias: d.alias, source: d.source },
        });
        aliasesUpserted += 1;
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: commit ? 'COMMIT' : 'DRY_RUN',
          distinctMdapCodes: byCode.size,
          curatedLinks: links.length,
          knownPeTitles: peTitle.size,
          programsUpserted,
          peProgramMatchesUpserted: matchesUpserted,
          aliasesUpserted,
          sample: samples,
        },
        null,
        2,
      ),
    );
  } finally {
    await prisma.$disconnect();
  }
}

function collectAliases(
  canonicalName: string,
  peCodes: string[],
  peTitle: Map<string, string>,
  projTitlesByPe: Map<string, string[]>,
): AliasDraft[] {
  const out: AliasDraft[] = [];
  const seen = new Set<string>();
  const push = (alias: string, aliasType: string, source: string): void => {
    const norm = normalizeAlias(alias);
    const key = `${norm}::${aliasType}`;
    if (!norm || seen.has(key)) return;
    seen.add(key);
    out.push({ alias, aliasType, source });
  };

  push(canonicalName, 'canonical', SEED_SOURCE);
  push(canonicalName, 'mdap_name', SEED_SOURCE);
  for (const peCode of peCodes) {
    const t = peTitle.get(peCode.toUpperCase());
    if (t) push(t, 'pe_title', 'program_element');
    for (const pt of projTitlesByPe.get(peCode.toUpperCase()) ?? []) {
      push(pt, 'project_title', 'program_element_project');
    }
  }
  return out;
}

if (require.main === module) {
void main().catch((err) => {
  console.error('[seed-programs] FAILED', err);
  process.exit(1);
});
}
