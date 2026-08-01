/**
 * attach-pe-legacy-documents.ts — C2.5 legacy observation attach (gated).
 *
 * Registers stub SourceDocument rows ONLY for sources whose backing artifact
 * exists in the repo (provenance-honest), then attaches matching orphan
 * observations (source_document_id IS NULL) to the registered document.
 *
 * Artifact-backed stubs (C2.5 decision 2026-08-01):
 *   stanford_pe_directory_jan2026 → apps/api/scripts/__data__/dow_directory_v6/dow_v6_directory.csv
 *   p_doc_army_fy27               → corrected_json/pdoc_army_*_fy2027_corrected.json (set)
 *   p_doc_dw_fy27                 → corrected_json/pdoc_dw_fy2027_corrected.json
 *
 * NOT stubbed (no artifact): p_doc_army (pre-fy27 base source), p_doc_dw, fixture
 * — those remain null and are carried on the Neo-waived residual list in HYGIENE.md.
 *
 *   tsx scripts/attach-pe-legacy-documents.ts                              # DRY-RUN
 *   tsx scripts/attach-pe-legacy-documents.ts --commit --approved-count N  # attach N obs
 *
 * Never touches program_element_year canonical rows.
 */
import { config as dotenvConfig } from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as fs from 'node:fs';
import * as path from 'node:path';

dotenvConfig();

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface StubSpec {
  source: string;
  sourceKey: string;
  budgetCycle: string;
  component: string | null;
  documentType: string;
  title: string;
  artifactPath: string;
  fiscalYear: number | null;
}

/**
 * Script lives at apps/api/scripts/ in both the monorepo and the runtime image
 * (/app/apps/api/scripts). Resolve fixtures from __dirname so image pathing works
 * without depending on process.cwd() or a monorepo-root-relative prefix.
 */
const SCRIPTS_DIR = __dirname;

const STUBS: StubSpec[] = [
  {
    source: 'stanford_pe_directory_jan2026',
    sourceKey: 'stanford_pe_directory_jan2026',
    budgetCycle: 'pb',
    component: null,
    documentType: 'other',
    title: 'DoW Acquisition Directory (Stanford mirror, Jan 2026)',
    artifactPath: path.join(SCRIPTS_DIR, '__data__/dow_directory_v6/dow_v6_directory.csv'),
    fiscalYear: 2026,
  },
  {
    source: 'p_doc_army_fy27',
    sourceKey: 'p_doc_army_fy27',
    budgetCycle: 'pb',
    component: 'ARMY',
    documentType: 'p40',
    title: 'Army P-doc FY2027 corrected JSON set (aircraft/ammo/missile/op_ba1/op_ba2/op_ba3_4/wtcv)',
    artifactPath: path.join(SCRIPTS_DIR, '__data__/corrected_json/pdoc_army_missile_fy2027_corrected.json'),
    fiscalYear: 2027,
  },
  {
    source: 'p_doc_dw_fy27',
    sourceKey: 'p_doc_dw_fy27',
    budgetCycle: 'pb',
    component: 'DW',
    documentType: 'p40',
    title: 'Defense-Wide P-doc FY2027 corrected JSON',
    artifactPath: path.join(SCRIPTS_DIR, '__data__/corrected_json/pdoc_dw_fy2027_corrected.json'),
    fiscalYear: 2027,
  },
];

function artifactRelLabel(absPath: string): string {
  // Stable label for logs / SourceDocument.sourceUrl (posix-ish relative to scripts/)
  return path.relative(SCRIPTS_DIR, absPath).split(path.sep).join('/');
}

async function main(): Promise<void> {
  const commit = flag('commit');
  const approvedRaw = arg('approved-count');
  const approvedCount = approvedRaw == null ? null : Number(approvedRaw);
  if (commit && (!Number.isSafeInteger(approvedCount) || (approvedCount ?? -1) < 0)) {
    throw new Error('--commit requires --approved-count <non-negative integer>');
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    // Verify artifacts exist before claiming provenance.
    const artifactCheck = STUBS.map((s) => ({
      source: s.source,
      artifactPath: artifactRelLabel(s.artifactPath),
      absPath: s.artifactPath,
      exists: fs.existsSync(s.artifactPath),
    }));
    const missing = artifactCheck.filter((a) => !a.exists);
    if (missing.length > 0) {
      throw new Error(`refusing to stub without artifact: ${missing.map((m) => m.artifactPath).join(', ')}`);
    }

    // Orphan counts per stub source.
    const plan: Array<{ source: string; orphans: number; docId: string | null }> = [];
    for (const s of STUBS) {
      const orphans = await prisma.programElementYearSourceValue.count({
        where: { source: s.source, sourceDocumentId: null },
      });
      const existing = await prisma.sourceDocument.findFirst({
        where: { sourceKey: s.sourceKey, supersededByDocumentId: null },
        select: { id: true },
      });
      plan.push({ source: s.source, orphans, docId: existing?.id ?? null });
    }

    const totalOrphans = plan.reduce((a, p) => a + p.orphans, 0);
    console.log(JSON.stringify({
      mode: commit ? 'COMMIT' : 'DRY-RUN',
      artifactCheck,
      plan,
      totalOrphansAttachable: totalOrphans,
    }, null, 2));

    if (!commit) return;
    if (approvedCount !== totalOrphans) {
      throw new Error(
        `--approved-count ${approvedCount} does not match attachable orphan count ${totalOrphans}; rerun dry-run and review`,
      );
    }

    let attached = 0;
    for (const s of STUBS) {
      // Register stub (idempotent on sourceKey head).
      let doc = await prisma.sourceDocument.findFirst({
        where: { sourceKey: s.sourceKey, supersededByDocumentId: null },
      });
      if (!doc) {
        doc = await prisma.sourceDocument.create({
          data: {
            sourceKey: s.sourceKey,
            fiscalYear: s.fiscalYear,
            budgetCycle: s.budgetCycle,
            component: s.component,
            documentType: s.documentType,
            title: s.title,
            sourceUrl: artifactRelLabel(s.artifactPath),
            artifactPath: artifactRelLabel(s.artifactPath),
            extractionMethod: 'structured_import',
            metadata: { stubRegisteredFor: 'C2.5 legacy observation attach', stub: true },
          },
        });
      }
      const res = await prisma.programElementYearSourceValue.updateMany({
        where: { source: s.source, sourceDocumentId: null },
        data: { sourceDocumentId: doc.id },
      });
      attached += res.count;
    }
    console.log(JSON.stringify({ status: 'attached', attached }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  void main().catch((error) => {
    console.error('[attach-pe-legacy-documents] FAILED', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
