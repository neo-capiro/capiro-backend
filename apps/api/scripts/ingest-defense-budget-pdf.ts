/**
 * ingest-defense-budget-pdf — PE Watch end-to-end ingestion CLI.
 *
 * For each local PDF (or every PDF in a directory):
 *   1. classify (family/exhibit/authority/component/FY) from the filename
 *   2. archive the ORIGINAL bytes to the Object-Lock raw bucket (idempotent, SHA-addressed)
 *   3. register/​version the SourceDocument carrying the S3 VersionId (archival-before-registration)
 *   4. LlamaParse the PDF (never TXT) -> markdown + json, archived to the derived prefix
 *   5. record an immutable DocumentParseJob (the "parse job" half of the record requirement)
 *   6. extract INDEPENDENT page-cited assertions, map RDT&E -> PE writer, load
 *   7. stamp per-field source values with the SourceDocument id + write a ProgramElementIngestRun
 *
 * Usage:
 *   tsx scripts/ingest-defense-budget-pdf.ts --path "<pdf|dir|s3://bucket/prefix>" [--dry-run] [--mode pdf_fast|pdf_premium|pdf_ocr]
 *       [--fy 2027] [--only rdte,procurement,om,committee,public_law] [--limit N]
 *
 * Secrets/config come from the environment (LLAMA_CLOUD_API_KEY, DEFENSE_BUDGET_RAW_BUCKET,
 * DEFENSE_BUDGET_RAW_KMS_KEY_ARN, AWS_REGION_DEFAULT). --dry-run archives + parses but skips
 * all DB entity writes.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaService } from '../src/prisma/prisma.service.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import {
  upsertSourceDocument,
  sha256OfFile,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
import { recordIngestRun, type IngestRunClient } from '../src/program-element/coverage/record-ingest-run.js';
import { RawArchiveService, type ArchiveDescriptor } from '../src/defense-budget/raw-archive.service.js';
import { makeS3, awsS3Commands, makeCorpusS3 } from '../src/defense-budget/s3-aws-commands.js';
import { parseS3Uri, materializeS3Corpus } from '../src/defense-budget/corpus-source.js';
import { LlamaParseClient } from '../src/defense-budget/llamaparse.client.js';
import { ParseRunner, type ParseJobClient } from '../src/defense-budget/parse-runner.js';
import { classifyDocument, type DocClassification } from '../src/defense-budget/document-classifier.js';
import { adaptLlamaParseJson } from '../src/defense-budget/extractors/llamaparse-adapter.js';
import { extractRdte } from '../src/defense-budget/extractors/rdte.extractor.js';
import { extractProcurementOrOm } from '../src/defense-budget/extractors/procurement.extractor.js';
import { mapAssertionsToPeWriter } from '../src/defense-budget/assertion-mapper.js';
import type { ExtractionResult, ExhibitType } from '../src/defense-budget/extractors/types.js';

// Load the local secret env file if present, then process env wins.
const SECRET_FILE = path.join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.capiro-pe-secrets.env');
if (fs.existsSync(SECRET_FILE)) dotenvConfig({ path: SECRET_FILE });
dotenvConfig();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(flag: string): boolean {
  return process.argv.includes(`--${flag}`);
}

interface RunConfig {
  bucket: string;
  kmsKeyArn?: string;
  retentionYears: number;
  region: string;
  llamaApiKey: string;
  llamaBaseUrl: string;
}

function loadConfig(): RunConfig {
  const bucket = process.env.DEFENSE_BUDGET_RAW_BUCKET;
  const llamaApiKey = process.env.LLAMA_CLOUD_API_KEY;
  if (!bucket) throw new Error('DEFENSE_BUDGET_RAW_BUCKET is required');
  if (!llamaApiKey) throw new Error('LLAMA_CLOUD_API_KEY is required (ingestion fails closed without it)');
  return {
    bucket,
    kmsKeyArn: process.env.DEFENSE_BUDGET_RAW_KMS_KEY_ARN,
    retentionYears: Number(process.env.DEFENSE_BUDGET_RETENTION_YEARS ?? '7'),
    region: process.env.AWS_REGION_DEFAULT ?? 'us-east-1',
    llamaApiKey,
    llamaBaseUrl: process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai',
  };
}

function listPdfs(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  return fs
    .readdirSync(target)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))
    .map((f) => path.join(target, f));
}

/** Route a classification to the right extractor over the adapted pages. */
function runExtractor(cls: DocClassification, pages: ReturnType<typeof adaptLlamaParseJson>): ExtractionResult {
  const fyColumns = cls.fiscalYear ? [cls.fiscalYear - 1, cls.fiscalYear, cls.fiscalYear + 1] : [];
  switch (cls.family) {
    case 'rdte':
      return extractRdte({ exhibit: 'R-2', component: cls.component, pages, fyColumns });
    case 'procurement':
      return extractProcurementOrOm({ exhibit: 'P-40', account: `Procurement, ${cls.component ?? 'DoD'}`, component: cls.component, pages });
    case 'om':
      return extractProcurementOrOm({ exhibit: 'OP-5', account: `O&M, ${cls.component ?? 'DoD'}`, component: cls.component, pages });
    default:
      return { lineAssertions: [], yearValues: [], warnings: [`no extractor for family ${cls.family}`] };
  }
}

async function main(): Promise<void> {
  const target = arg('path');
  if (!target) {
    console.error('Usage: ingest-defense-budget-pdf.ts --path <pdf|dir> [--dry-run] [--mode ...] [--only ...] [--limit N]');
    process.exit(1);
  }
  const dryRun = has('dry-run');
  const mode = (arg('mode') as 'pdf_fast' | 'pdf_premium' | 'pdf_ocr') ?? 'pdf_fast';
  const only = (arg('only') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = arg('limit') ? Number(arg('limit')) : Infinity;
  const fyArg = arg('fy') ? Number(arg('fy')) : null;
  const cfg = loadConfig();

  // Resolve the corpus source. Local path/dir works as before; an s3://bucket/prefix
  // target is materialized into a local scratch dir so the batch can run on a
  // private-subnet Fargate task with no access to the operator's workstation.
  let corpusDir = target;
  const s3Loc = parseS3Uri(target);
  if (s3Loc) {
    const corpusS3 = makeCorpusS3(cfg.region);
    const mat = await materializeS3Corpus(s3Loc, corpusS3);
    corpusDir = mat.dir;
    console.log(
      `Materialized s3://${s3Loc.bucket}/${s3Loc.prefix} -> ${mat.dir} (${mat.files.length} pdf, ${mat.skipped} non-pdf skipped)`,
    );
  }

  const s3 = makeS3(cfg.region);
  const archiveSvc = new RawArchiveService(s3, awsS3Commands, {
    bucket: cfg.bucket,
    kmsKeyArn: cfg.kmsKeyArn,
    retentionYears: cfg.retentionYears,
  });
  const llama = new LlamaParseClient({ apiKey: cfg.llamaApiKey, baseUrl: cfg.llamaBaseUrl }, (url, init) =>
    fetch(url, init as RequestInit) as unknown as ReturnType<Parameters<typeof LlamaParseClient>[1]>,
  );

  const prisma = dryRun ? null : new PrismaService();
  if (prisma) await prisma.$connect();

  const summary: Array<Record<string, unknown>> = [];
  try {
    const parseRunner = prisma
      ? new ParseRunner(llama, archiveSvc, prisma as unknown as ParseJobClient)
      : null;
    const writer = prisma ? new ProgramElementWriterService(prisma) : null;

    let processed = 0;
    for (const pdfPath of listPdfs(corpusDir)) {
      if (processed >= limit) break;
      const cls = classifyDocument(pdfPath);
      // --fy is the scope default: J-book filenames often omit the FY, but this pass is
      // FY2027 PB. Apply it as a fallback so FY-column mapping (and value extraction) works.
      if (cls.fiscalYear == null && fyArg != null) cls.fiscalYear = fyArg;
      if (only.length > 0 && !only.includes(cls.family)) continue;
      if (
        cls.family === 'unknown' ||
        cls.family === 'overview' ||
        cls.family === 'milpers' ||
        cls.family === 'bill'
      ) {
        summary.push({ file: path.basename(pdfPath), skipped: `family=${cls.family}` });
        continue;
      }
      processed += 1;

      const sha256 = sha256OfFile(pdfPath);
      const descriptor: ArchiveDescriptor = {
        documentId: cls.sourceKey,
        fiscalYear: cls.fiscalYear,
        sourceAuthority: cls.authority,
        family: cls.family,
        localPath: pdfPath,
        retrievalAliases: [pdfPath],
        manifest: { component: cls.component, budgetCycle: cls.budgetCycle, documentType: cls.documentType },
      };

      // 2. Archive original FIRST (idempotent).
      const archive = await archiveSvc.archiveOriginal(descriptor);

      // 3. Register the SourceDocument with the verified S3 VersionId.
      let sourceDocumentId: string | null = null;
      if (prisma) {
        const reg = await upsertSourceDocument(prisma as unknown as SourceDocumentClient, {
          sourceKey: cls.sourceKey,
          sha256,
          fiscalYear: cls.fiscalYear,
          budgetCycle: cls.budgetCycle,
          component: cls.component,
          documentType: cls.documentType,
          title: path.basename(pdfPath),
          sourceUrl: pdfPath,
          byteSize: archive.byteSize,
          extractionMethod: 'llamaparse',
          archiveBucket: archive.bucket,
          archiveS3Key: archive.key,
          archiveVersionId: archive.versionId,
          archiveKmsKeyArn: archive.kmsKeyArn ?? null,
          retainUntil: archive.retainUntil,
          archivedAt: new Date(),
          metadata: { retrievalKey: archive.retrievalKey, manifestKey: archive.manifestKey, classification: cls },
        });
        sourceDocumentId = reg.document.id;
      }

      // 4/5. Parse the PDF + record the parse job.
      const fileBytes = fs.readFileSync(pdfPath);
      let extraction: ExtractionResult = { lineAssertions: [], yearValues: [], warnings: [] };
      let parseJobId: string | null = null;
      if (parseRunner && sourceDocumentId) {
        const parsed = await parseRunner.run({
          sourceDocumentId,
          file: fileBytes,
          filename: path.basename(pdfPath),
          inputSha256: sha256,
          archiveDescriptor: descriptor,
          mode,
          resultType: 'both',
        });
        parseJobId = parsed.parseJob.id;
        if (parsed.json || parsed.markdown) {
          const pages = adaptLlamaParseJson(parsed.json, { markdownFallback: parsed.markdown });
          extraction = runExtractor(cls, pages);
        }
      } else if (dryRun) {
        // Dry-run still archives (above) AND parses via LlamaParse; only DB writes are skipped.
        const parsed = await llama.parse({
          file: fileBytes,
          filename: path.basename(pdfPath),
          mode,
          resultType: 'both',
        });
        if (parsed.status === 'SUCCESS' && (parsed.json || parsed.markdown)) {
          const pages = adaptLlamaParseJson(parsed.json, { markdownFallback: parsed.markdown });
          extraction = runExtractor(cls, pages);
          // Archive derived outputs even in dry-run so the parse is reproducible.
          if (parsed.markdown != null) {
            await archiveSvc.archiveDerived(descriptor, sha256, 'parsed.dryrun.md', parsed.markdown, 'text/markdown');
          }
        } else {
          extraction.warnings.push(`llamaparse status ${parsed.status}`);
        }
      }

      // 6/7. Load RDT&E into the PE writer + ingest-run ledger.
      let loadOutcome = { upserted: 0, changed: 0, quarantined: 0 };
      if (writer && extraction.lineAssertions.length > 0) {
        const mapped = mapAssertionsToPeWriter(extraction);
        const source = `llamaparse_${cls.sourceKey}`;
        for (const record of mapped.records) {
          try {
            const r = await writer.upsertProgramElement(record, source, 0.9);
            if (r.inserted) loadOutcome.upserted += 1;
            else loadOutcome.changed += 1;
          } catch {
            loadOutcome.quarantined += 1;
          }
        }
        for (const year of mapped.years) {
          try {
            await writer.upsertProgramElementYear(year, source);
          } catch {
            loadOutcome.quarantined += 1;
          }
        }
        // Stamp the per-field source values written this run with the SourceDocument id.
        if (sourceDocumentId) {
          await prisma!.programElementYearSourceValue.updateMany({
            where: { source, sourceDocumentId: null },
            data: { sourceDocumentId },
          });
        }
      }
      if (prisma) {
        await recordIngestRun(prisma as unknown as IngestRunClient, {
          source: `llamaparse_${cls.sourceKey}`,
          fy: cls.fiscalYear,
          artifactSha256: sha256,
          rows: extraction.yearValues.map((v) => ({
            peCode: v.lineKind === 'RDTE_PE' ? v.code : null,
            request: v.money?.value ?? null,
            mark: null,
            explanation: null,
          })),
          outcome: loadOutcome,
          metadata: { sourceDocumentId, parseJobId, family: cls.family, warnings: extraction.warnings.slice(0, 20) },
        });
      }

      summary.push({
        file: path.basename(pdfPath),
        family: cls.family,
        sha256: sha256.slice(0, 12),
        archived: { key: archive.key, versionId: archive.versionId, created: archive.created },
        sourceDocumentId,
        parseJobId,
        lines: extraction.lineAssertions.length,
        values: extraction.yearValues.length,
        warnings: extraction.warnings.length,
        loadOutcome,
        dryRun,
      });
      console.error(`[ingest] ${path.basename(pdfPath)} -> archived(${archive.created ? 'new' : 'dedup'}) lines=${extraction.lineAssertions.length}`);
    }
  } finally {
    if (prisma) await prisma.$disconnect();
  }

  console.log(JSON.stringify({ target, count: summary.length, results: summary }, null, 2));
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
