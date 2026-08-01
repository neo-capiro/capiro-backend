/**
 * O-1 (Operation & Maintenance) loader. Loads the FY2027 O&M "All Accounts" O-1
 * detail lines as program elements of appropriationType 'OM', keyed by a
 * namespaced pe_code = <account><line> (e.g. 2020A010, 0100D010) — the same
 * Treasury/USAspending budget-line convention used for procurement. O-1 amounts
 * are in THOUSANDS, normalized to the canonical MILLIONS unit here.
 *
 * Exact-SHA contract (Phase E):
 *   default / --inspect  → no writes; prints sha256 + quality
 *   --commit --approved-sha256 <sha> → promote only the inspected bytes
 *
 *   load-om --artifact scripts/__data__/corrected_json/om_fy2027.json
 *   load-om --artifact ... --commit --approved-sha256 <sha>
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import { thousandsToMillions } from '../src/program-element/jbook/jbook-extract.js';
import {
  upsertSourceDocument,
  supersedeSourceDocumentHead,
  sha256OfFile,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
import {
  assertExactShaCommitAllowed,
  auditArtifactQuality,
  buildInspectReport,
  resolvePeDollarLoaderPosture,
  argValue as exactShaArgValue,
} from './lib/pe-exact-sha-loader-contract.js';

dotenvConfig();

interface OmYear {
  fy: number;
  request?: number | null;
  enacted?: number | null;
}
interface OmPe {
  peCode: string;
  title: string;
  appropriationType?: string;
  service?: string | null;
  budgetActivity?: string | null;
  raw?: unknown;
  fyData?: OmYear[];
}
interface Artifact {
  source?: string;
  fy?: number;
  pes?: OmPe[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error(
      'Usage: load-om --artifact <om.json> [--inspect | --commit --approved-sha256 <sha>]',
    );
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const source = artifact.source ?? 'o1_fy27';
  const posture = resolvePeDollarLoaderPosture(process.argv);
  if (posture === 'extract_only') {
    throw new Error(
      'load-om.ts: --extract-only/--dry-run is not valid; use default inspect or --commit --approved-sha256 <sha>.',
    );
  }
  const sha256 = sha256OfFile(artifactPath);
  const quality = auditArtifactQuality({ rowCount: (artifact.pes ?? []).length });
  if (posture === 'inspect') {
    console.log(
      JSON.stringify(
        buildInspectReport({
          loader: 'load-om.ts',
          posture,
          artifactPath,
          sha256,
          byteSize: fs.statSync(artifactPath).size,
          quality,
          extra: { source, fy: artifact.fy ?? 2027 },
        }),
        null,
        2,
      ),
    );
    console.log('INSPECT — no writes. Re-run with --commit --approved-sha256 <sha above> to promote.');
    return;
  }
  assertExactShaCommitAllowed({
    actualSha256: sha256,
    approvedSha256Raw: exactShaArgValue(process.argv, 'approved-sha256'),
    quality: { rowCount: (artifact.pes ?? []).length },
  });

  const prisma = new PrismaService();
  await prisma.$connect();
  const writer = new ProgramElementWriterService(prisma);
  let pes = 0;
  let yearRows = 0;
  let changed = 0;
  let quarantined = 0;
  try {
    // Register with deferred supersede so a failed promotion cannot become the live head.
    const reg = await upsertSourceDocument(
      prisma as unknown as SourceDocumentClient,
      {
        sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
        sha256,
        fiscalYear: artifact.fy ?? 2027,
        budgetCycle: 'pb',
        component: null,
        documentType: 'om_o1',
        title: `O-1 Operation & Maintenance (FY${artifact.fy ?? 2027})`,
        sourceUrl:
          'https://comptroller.war.gov/Portals/45/Documents/defbudget/FY2027/FY2027_o1.pdf',
        byteSize: fs.statSync(artifactPath).size,
        artifactPath: path.relative(process.cwd(), artifactPath),
        extractionMethod: 'deterministic_xlsx',
        extractionToolVersion: null,
        metadata: { sourceTag: source, approvedSha256: sha256 },
      },
      { deferSupersede: true },
    );
    const sourceDocumentId = reg.document.id;

    for (const pe of artifact.pes ?? []) {
      await writer.upsertProgramElement(
        {
          peCode: pe.peCode,
          title: pe.title,
          appropriationType: pe.appropriationType ?? 'OM',
          service: pe.service ?? null,
          budgetActivity: pe.budgetActivity ?? null,
          lineNumber: pe.peCode,
          firstSeenFy: artifact.fy ?? 2027,
          raw: pe.raw,
        },
        source,
        0.7,
      );
      pes += 1;
      for (const y of pe.fyData ?? []) {
        const r = await writer.upsertProgramElementYear(
          {
            peCode: pe.peCode,
            fy: y.fy,
            request: thousandsToMillions(y.request ?? null),
            // O-1 is not the enacted_public_law authority — do not write enacted.
            raw: { source, account: (pe.raw as Record<string, unknown>)?.account },
          },
          source,
          {
            authority: 'presidents_budget_request',
            sourceDocumentId,
            extractorVersion: 'load-om@exact-sha',
            originalValues: {
              ...(y.request != null
                ? { request: { value: y.request, unit: 'thousands' as const } }
                : {}),
            },
          },
        );
        yearRows += 1;
        if (r.changed) changed += 1;
      }
    }
    const retireArg = arg('retire-codes');
    let retired = 0;
    if (retireArg) {
      const codes = retireArg
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter(Boolean);
      const res = await prisma.programElement.updateMany({
        where: { peCode: { in: codes }, retiredAt: null },
        data: { retiredAt: new Date() },
      });
      retired = res.count;
    }

    if (reg.supersededDocument) {
      await supersedeSourceDocumentHead(
        prisma as unknown as SourceDocumentClient,
        reg.supersededDocument.id,
        sourceDocumentId,
      );
    }

    console.log(
      JSON.stringify(
        {
          mode: 'COMMIT',
          artifact: artifactPath,
          sha256,
          source,
          pes,
          yearRows,
          changed,
          quarantined,
          retired,
          sourceDocument: { id: sourceDocumentId, action: reg.created ? 'inserted' : 'deduped' },
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
