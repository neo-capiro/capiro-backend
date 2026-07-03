/**
 * seed-acq-program-map.ts — curated DoD acquisition (MDAP) program -> Program
 * Element map. Idempotent upserts into program_element_acquisition_program.
 *
 *   tsx scripts/seed-acq-program-map.ts            # dry-run (reports, no writes)
 *   tsx scripts/seed-acq-program-map.ts --commit   # write
 *
 * This is the DEFENSIBLE bridge for the PE->contractor panel. USAspending stamps
 * every contract with a DoD acquisition program code (verified: 198=F-35,
 * 516=SSN 774, 387=KC-46A, ...). We map those codes to the Program Elements they
 * fund. The mapping is CURATED + REVIEWED here (not machine-inferred), so the
 * attribution shown to users is auditable.
 *
 * SAFETY: every (code -> peCode) pair is validated against program_element before
 * insert. PEs that don't exist in this deployment are SKIPPED and reported, never
 * invented. Codes that mean "no program" ('000'/'NONE') are rejected. Re-running
 * is safe (unique on (acq_program_code, pe_code); upsert).
 *
 * Extending the map: add entries to CURATED below (or grow it from
 * report-award-pe-coverage's topUnmappedProgramsByAwardCount). Keep peCodes to
 * real, citable program elements for that weapons system.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient } from '@prisma/client';

dotenvConfig();

interface CuratedEntry {
  code: string;
  name: string;
  /** Program Element codes this acquisition program funds (validated vs DB). */
  peCodes: string[];
}

// Curated seed. Codes are exactly as USAspending emits dod_acquisition_program.
// peCodes are canonical PEs for each system; only those present in this
// deployment's program_element table are inserted (others reported + skipped).
const CURATED: CuratedEntry[] = [
  { code: '198', name: 'F-35', peCodes: ['0604800F', '0604800N', '0207142F', '0207142N'] },
  { code: '516', name: 'SSN 774', peCodes: ['0604558N', '0204163N'] },
  { code: '387', name: 'KC-46A', peCodes: ['0605221F', '0207247F'] },
  { code: '334', name: 'P-8A', peCodes: ['0604407N', '0207236N'] },
  { code: '223', name: 'CVN 78', peCodes: ['0604567N', '0204220N'] },
  { code: '493', name: 'LGM-35A SENTINEL', peCodes: ['0604851F', '0101213F'] },
  { code: '265', name: 'F-22', peCodes: ['0207138F', '0604233F'] },
  { code: '200', name: 'C-17A', peCodes: ['0401130F'] },
  { code: '212', name: 'V-22', peCodes: ['0604262N', '0205456N'] },
  { code: '364', name: 'E-2D AHE', peCodes: ['0604234N', '0204114N'] },
  { code: '176', name: 'NSSL', peCodes: ['0603856F', '0305614F'] },
  // ── Extended coverage (peCodes mined from committed J-book artifacts; every pair
  // is validated against program_element at seed time, so unknown PEs are skipped,
  // never invented). Drawn from report-award-pe-coverage topUnmappedPrograms.
  { code: '178', name: 'TRIDENT II MISSILE', peCodes: ['0603595N', '0604503N', '0101224N'] },
  { code: '220', name: 'C-130J', peCodes: ['0401132F'] },
  { code: '185', name: 'AMRAAM', peCodes: ['0207163F', '0207163N'] },
  { code: '555', name: 'JASSM', peCodes: ['0207325F'] },
  { code: '260', name: 'GMLRS/GMLRS AW', peCodes: ['0205778A'] },
  { code: '106', name: 'PATRIOT', peCodes: ['0607865A'] },
  { code: '279', name: 'JLTV', peCodes: ['0605812A', '0605813M'] },
  { code: '424', name: 'MQ-9 REAPER', peCodes: ['0205219F'] },
  { code: '252', name: 'RQ-4A/B GLOBAL HAWK', peCodes: ['0305220F', '0305421N'] },
  { code: '374', name: 'LCS', peCodes: ['0603581N', '0603596N'] },
  { code: '378', name: 'EA-18G', peCodes: ['0604269N'] },
  { code: '202', name: 'AH-64E REMANUFACTURE', peCodes: ['0607145A'] },
  { code: '289', name: 'TACTOM', peCodes: ['0204229N'] },
  { code: '197', name: 'DDG 1000', peCodes: ['0204202N'] },
  { code: '474', name: 'F-22 INC 3.2B MOD', peCodes: ['0207138F'] },
  // ── 2026-06-05 extension: highest-award topUnmapped programs from
  // report-award-pe-coverage. Every (code -> peCode) is validated against
  // program_element at seed time, so any PE this deployment hasn't loaded yet is
  // SKIPPED + reported, never invented. PATRIOT P3I shares PATRIOT's PE (already
  // mapped, so a guaranteed hit); the rest are citable J-book PEs that land as
  // their program elements get ingested.
  { code: '564', name: 'PATRIOT P3I', peCodes: ['0607865A'] },
  { code: '278', name: 'CH-47F', peCodes: ['0203744A'] },
  { code: '128', name: 'BRADLEY FVS', peCodes: ['0203735A'] },
  { code: '101', name: 'H-1 UPGRADES', peCodes: ['0204136N'] },
  { code: '420', name: 'MQ-1C GRAY EAGLE', peCodes: ['0205228A'] },
  { code: '373', name: 'MQ-4C TRITON', peCodes: ['0305220N', '0204762N'] },
  { code: '390', name: 'CH-53K', peCodes: ['0604262N'] },
  { code: '442', name: 'AIM-9X BLK II', peCodes: ['0207161F', '0207161N'] },
  { code: '166', name: 'NAVSTAR GPS', peCodes: ['1203940SF', '0305265F'] },
  { code: '439', name: 'SDB II', peCodes: ['0604329F'] },
  { code: '503', name: 'JDAM', peCodes: ['0207161F'] },
  { code: '110', name: 'AEGIS', peCodes: ['0204163N', '0603892C'] },
];

function hasFlag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main(): Promise<void> {
  const commit = hasFlag('commit');
  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const pes = await prisma.programElement.findMany({ select: { peCode: true } });
    const known = new Set(pes.map((p) => p.peCode.toUpperCase()));

    let inserted = 0;
    let updated = 0;
    const skipped: Array<{ code: string; peCode: string }> = [];
    const wouldInsert: Array<{ code: string; peCode: string }> = [];

    // P-40 EXHIBIT EVIDENCE (batch-5): each pair below was printed on the line
    // item's own Exhibit P-40 header ("Line Item MDAP/MAIS Code: <code>") in the
    // FY2027 justification books — document-stated, auditable per book, NOT
    // machine-inferred. Same validation as CURATED (PE must exist; '000' = none).
    type EvidencePair = { acqProgramCode: string; peCode: string; title: string; book: string };
    let evidence: EvidencePair[] = [];
    try {
      evidence = JSON.parse(
        fs.readFileSync(path.resolve('scripts/__data__/mdap_evidence_fy2027.json'), 'utf8'),
      ) as EvidencePair[];
    } catch {
      /* artifact optional */
    }
    const evidenceByCode = new Map<string, { name: string; peCodes: string[] }>();
    for (const ev of evidence) {
      if (!ev.acqProgramCode || ev.acqProgramCode === '000') continue;
      const cur = evidenceByCode.get(ev.acqProgramCode) ?? { name: ev.title, peCodes: [] };
      if (!cur.peCodes.includes(ev.peCode)) cur.peCodes.push(ev.peCode);
      evidenceByCode.set(ev.acqProgramCode, cur);
    }
    const combined = [
      ...CURATED,
      ...[...evidenceByCode.entries()].map(([code, v]) => ({ code, name: v.name, peCodes: v.peCodes })),
    ];
    for (const entry of combined) {
      const code = entry.code.trim().toUpperCase();
      if (!code || code === '000' || code === 'NONE') continue;
      for (const rawPe of entry.peCodes) {
        const peCode = rawPe.trim().toUpperCase();
        if (!known.has(peCode)) {
          skipped.push({ code, peCode });
          continue;
        }
        wouldInsert.push({ code, peCode });
        if (commit) {
          const existing = await prisma.programElementAcquisitionProgram.findUnique({
            where: { acqProgramCode_peCode: { acqProgramCode: code, peCode } },
            select: { id: true },
          });
          await prisma.programElementAcquisitionProgram.upsert({
            where: { acqProgramCode_peCode: { acqProgramCode: code, peCode } },
            create: {
              acqProgramCode: code,
              acqProgramName: entry.name,
              peCode,
              source: 'seed_curated_v1',
              confidence: 1.0,
            },
            update: { acqProgramName: entry.name, lastSyncedAt: new Date() },
          });
          if (existing) updated += 1;
          else inserted += 1;
        }
      }
    }

    console.log(
      JSON.stringify(
        {
          mode: commit ? 'COMMIT' : 'DRY_RUN',
          curatedPrograms: CURATED.length,
          evidencePrograms: evidenceByCode.size,
          knownPeCount: known.size,
          inserted,
          updated,
          validPairs: wouldInsert.length,
          skippedUnknownPes: skipped,
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
  console.error('[seed-acq-program-map] FAILED', err);
  process.exit(1);
});
