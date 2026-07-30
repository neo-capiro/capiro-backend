/**
 * OP-5 O&M narrative loader. Enrich-only: NEVER creates a PE.
 *
 * Exact-SHA contract (Phase E): default inspect; --commit requires --approved-sha256.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient, Prisma } from '@prisma/client';
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

interface Op5Detail {
  sag: string | null;
  book: string;
  pageStart: number | null;
  pageEnd: number | null;
}
interface EnrichPe {
  peCode: string;
  description?: string | null;
  op5Detail?: Op5Detail;
}
interface Artifact {
  source?: string;
  fy?: number;
  pes?: EnrichPe[];
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const artifactPath = arg('artifact');
  if (!artifactPath) {
    console.error(
      'Usage: load-om-op5 --artifact <om_op5.json> [--inspect | --commit --approved-sha256 <sha>]',
    );
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as Artifact;
  const posture = resolvePeDollarLoaderPosture(process.argv);
  if (posture === 'extract_only') {
    throw new Error(
      'load-om-op5.ts: --extract-only/--dry-run is not valid; use default inspect or --commit --approved-sha256 <sha>.',
    );
  }
  const sha256 = sha256OfFile(artifactPath);
  const quality = auditArtifactQuality({ rowCount: (artifact.pes ?? []).length });
  if (posture === 'inspect') {
    console.log(
      JSON.stringify(
        buildInspectReport({
          loader: 'load-om-op5.ts',
          posture,
          artifactPath,
          sha256,
          byteSize: fs.statSync(artifactPath).size,
          quality,
          extra: { source: artifact.source ?? 'om_op5', fy: artifact.fy },
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

  const prisma = new PrismaClient();
  await prisma.$connect();
  let seen = 0;
  let updated = 0;
  let skippedMissing = 0;
  let skippedNotOm = 0;
  const missingSamples: string[] = [];
  try {
    const reg = await upsertSourceDocument(
      prisma as unknown as SourceDocumentClient,
      {
        sourceKey: path.basename(artifactPath).replace(/\.json$/i, ''),
        sha256,
        fiscalYear: artifact.fy ?? null,
        budgetCycle: 'pb',
        component: null,
        documentType: 'om_op5',
        title: 'OP-5 O&M narrative enrichment (FY' + String(artifact.fy ?? '?') + ')',
        sourceUrl: path.basename(artifactPath),
        byteSize: fs.statSync(artifactPath).size,
        artifactPath: path.relative(process.cwd(), artifactPath),
        extractionMethod: 'deterministic_pdf',
        extractionToolVersion: null,
        metadata: { sourceTag: artifact.source ?? 'om_op5', approvedSha256: sha256 },
      },
      { deferSupersede: true },
    );

    for (const pe of artifact.pes ?? []) {
      seen += 1;
      const existing = await prisma.programElement.findUnique({ where: { peCode: pe.peCode } });
      if (!existing) {
        skippedMissing += 1;
        if (missingSamples.length < 15) missingSamples.push(pe.peCode);
        continue;
      }
      if (existing.appropriationType !== 'OM') {
        skippedNotOm += 1;
        continue;
      }
      const existingRaw =
        existing.raw && typeof existing.raw === 'object' && !Array.isArray(existing.raw)
          ? (existing.raw as Record<string, unknown>)
          : {};
      const mergedRaw =
        pe.op5Detail !== undefined ? { ...existingRaw, op5Detail: pe.op5Detail } : existingRaw;

      await prisma.programElement.update({
        where: { peCode: pe.peCode },
        data: {
          description: pe.description ?? existing.description ?? null,
          raw: mergedRaw as Prisma.InputJsonValue,
          lastSyncedAt: new Date(),
        },
      });
      updated += 1;
    }

    if (reg.supersededDocument) {
      await supersedeSourceDocumentHead(
        prisma as unknown as SourceDocumentClient,
        reg.supersededDocument.id,
        reg.document.id,
      );
    }

    console.log(
      JSON.stringify(
        {
          mode: 'COMMIT',
          artifact: artifactPath,
          sha256,
          source: artifact.source ?? 'om_op5',
          seen,
          updated,
          skippedMissing,
          skippedNotOm,
          missingSamples,
          sourceDocument: { id: reg.document.id, action: reg.created ? 'inserted' : 'deduped' },
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
