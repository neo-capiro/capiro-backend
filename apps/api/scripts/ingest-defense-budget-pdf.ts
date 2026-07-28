/**
 * ingest-defense-budget-pdf — PE Watch PDF preflight and extraction command.
 *
 * Phase-A safety posture:
 *   no posture flag  -> PREFLIGHT ONLY (local classification/SHA; no network/DB)
 *   --extract-only   -> immutable archive + LlamaParse + derived artifacts; no DB
 *   --dry-run        -> deprecated alias for --extract-only; still external/paid
 *   --commit         -> fail closed until Phase B's USD-millions repair is verified
 *
 * This command intentionally has no Prisma or ProgramElementWriterService import.
 * Canonical promotion will return only after the money-unit contract, exact-SHA
 * approval and atomic promotion path are implemented and independently tested.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { RawArchiveService, type ArchiveDescriptor } from '../src/defense-budget/raw-archive.service.js';
import { makeS3, awsS3Commands, makeCorpusS3 } from '../src/defense-budget/s3-aws-commands.js';
import { parseS3Uri, materializeS3Corpus } from '../src/defense-budget/corpus-source.js';
import { LlamaParseClient } from '../src/defense-budget/llamaparse.client.js';
import { classifyDocument, type DocClassification } from '../src/defense-budget/document-classifier.js';
import { adaptLlamaParseJson } from '../src/defense-budget/extractors/llamaparse-adapter.js';
import { extractRdte } from '../src/defense-budget/extractors/rdte.extractor.js';
import { extractProcurementOrOm } from '../src/defense-budget/extractors/procurement.extractor.js';
import { sha256OfFile } from '../src/program-element/source-document/source-document-registry.js';
import type { ExtractionResult } from '../src/defense-budget/extractors/types.js';
import {
  resolveDefenseBudgetIngestPosture,
  usesDeprecatedDryRunAlias,
  type DefenseBudgetIngestPosture,
} from './lib/defense-budget-ingest-mode.js';

const COMMIT_DISABLED_MESSAGE =
  'Canonical generalized defense-budget writes are disabled until the USD-millions migration in Phase b is verified.';
const ALLOWED_MODES = new Set(['pdf_fast', 'pdf_premium', 'pdf_ocr'] as const);
const ALLOW_VENDOR_PARSE = '--allow-vendor-parse';
type ParseMode = 'pdf_fast' | 'pdf_premium' | 'pdf_ocr';

// Legacy local development support only. Phase E replaces direct key loading
// with explicit Secrets Manager retrieval after --allow-vendor-parse validation.
const SECRET_FILE = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '.',
  '.capiro-pe-secrets.env',
);
if (fs.existsSync(SECRET_FILE)) dotenvConfig({ path: SECRET_FILE });
dotenvConfig();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface RunConfig {
  bucket: string;
  kmsKeyArn?: string;
  retentionYears: number;
  region: string;
  llamaApiKey: string;
  llamaBaseUrl: string;
}

function positiveIntegerArg(name: string, fallback: number): number {
  const raw = arg(name);
  if (raw === undefined) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return parsed;
}

function optionalFiscalYear(): number | null {
  const raw = arg('fy');
  if (raw === undefined) return null;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1900 || parsed > 2200) {
    throw new Error('--fy must be a four-digit fiscal year');
  }
  return parsed;
}

function parseMode(): ParseMode {
  const raw = arg('mode') ?? 'pdf_fast';
  if (!ALLOWED_MODES.has(raw as ParseMode)) {
    throw new Error('--mode must be one of pdf_fast, pdf_premium, or pdf_ocr');
  }
  return raw as ParseMode;
}

function loadConfig(): RunConfig {
  const bucket = process.env.DEFENSE_BUDGET_RAW_BUCKET;
  const llamaApiKey = process.env.LLAMA_CLOUD_API_KEY;
  if (!bucket) throw new Error('DEFENSE_BUDGET_RAW_BUCKET is required');
  if (!llamaApiKey) {
    throw new Error('LLAMA_CLOUD_API_KEY is required (ingestion fails closed without it)');
  }
  const retentionYears = Number(process.env.DEFENSE_BUDGET_RETENTION_YEARS ?? '7');
  if (!Number.isFinite(retentionYears) || retentionYears <= 0) {
    throw new Error('DEFENSE_BUDGET_RETENTION_YEARS must be a positive number');
  }
  return {
    bucket,
    kmsKeyArn: process.env.DEFENSE_BUDGET_RAW_KMS_KEY_ARN,
    retentionYears,
    region: process.env.AWS_REGION_DEFAULT ?? 'us-east-1',
    llamaApiKey,
    llamaBaseUrl:
      process.env.LLAMA_CLOUD_BASE_URL ?? 'https://api.cloud.llamaindex.ai',
  };
}

function listLocalPdfs(target: string): string[] {
  const stat = fs.statSync(target);
  if (stat.isFile()) {
    if (!target.toLowerCase().endsWith('.pdf')) {
      throw new Error(`Input file is not a PDF: ${target}`);
    }
    return [target];
  }
  if (!stat.isDirectory()) throw new Error(`Input path is neither a file nor directory: ${target}`);
  return fs
    .readdirSync(target, { withFileTypes: true })
    .flatMap((entry) => {
      const full = path.join(target, entry.name);
      if (entry.isDirectory()) return listLocalPdfs(full);
      return entry.isFile() && entry.name.toLowerCase().endsWith('.pdf') ? [full] : [];
    })
    .sort();
}

function runExtractor(
  cls: DocClassification,
  pages: ReturnType<typeof adaptLlamaParseJson>,
): ExtractionResult {
  const fyColumns = cls.fiscalYear
    ? [cls.fiscalYear - 1, cls.fiscalYear, cls.fiscalYear + 1]
    : [];
  switch (cls.family) {
    case 'rdte':
      return extractRdte({
        exhibit: 'R-2',
        component: cls.component,
        pages,
        fyColumns,
      });
    case 'procurement':
      return extractProcurementOrOm({
        exhibit: 'P-40',
        account: `Procurement, ${cls.component ?? 'DoD'}`,
        component: cls.component,
        pages,
      });
    case 'om':
      return extractProcurementOrOm({
        exhibit: 'OP-5',
        account: `O&M, ${cls.component ?? 'DoD'}`,
        component: cls.component,
        pages,
      });
    default:
      return {
        lineAssertions: [],
        yearValues: [],
        warnings: [`no extractor for family ${cls.family}`],
      };
  }
}

function classificationFor(file: string, fyFallback: number | null): DocClassification {
  const cls = classifyDocument(file);
  if (cls.fiscalYear == null && fyFallback != null) cls.fiscalYear = fyFallback;
  return cls;
}

function shouldProcess(cls: DocClassification, only: ReadonlySet<string>): boolean {
  if (only.size > 0 && !only.has(cls.family)) return false;
  return !['unknown', 'overview', 'milpers', 'bill'].includes(cls.family);
}

function preflightS3Target(
  target: string,
  fyFallback: number | null,
  only: ReadonlySet<string>,
): Record<string, unknown> {
  const loc = parseS3Uri(target);
  if (!loc) throw new Error('Expected an s3:// target');
  const basename = path.posix.basename(loc.prefix) || loc.prefix || loc.bucket;
  const cls = classificationFor(basename, fyFallback);
  return {
    target,
    sourceType: 's3',
    bucket: loc.bucket,
    prefix: loc.prefix,
    classification: cls,
    wouldProcessAfterMaterialization: shouldProcess(cls, only),
    sha256: null,
    materializationRequired: true,
    note:
      'Preflight performs no S3 list/get call. Use --extract-only to materialize and enumerate this S3 corpus.',
  };
}

function runPreflight(
  target: string,
  fyFallback: number | null,
  only: ReadonlySet<string>,
  limit: number,
): Record<string, unknown> {
  if (parseS3Uri(target)) {
    return {
      posture: 'preflight',
      externalCalls: false,
      canonicalWrites: false,
      files: [preflightS3Target(target, fyFallback, only)],
    };
  }

  const files = listLocalPdfs(target)
    .map((file) => {
      const cls = classificationFor(file, fyFallback);
      return {
        file: path.basename(file),
        path: file,
        classification: cls,
        wouldProcess: shouldProcess(cls, only),
        sha256: sha256OfFile(file),
        byteSize: fs.statSync(file).size,
      };
    })
    .slice(0, limit);

  return {
    posture: 'preflight',
    externalCalls: false,
    canonicalWrites: false,
    files,
  };
}

async function materializePdfs(
  target: string,
  region: string,
): Promise<{ files: string[]; materializedFromS3: boolean; skipped: number }> {
  const loc = parseS3Uri(target);
  if (!loc) return { files: listLocalPdfs(target), materializedFromS3: false, skipped: 0 };
  const mat = await materializeS3Corpus(loc, makeCorpusS3(region));
  return { files: mat.files, materializedFromS3: true, skipped: mat.skipped };
}

async function runExtractOnly(
  target: string,
  mode: ParseMode,
  fyFallback: number | null,
  only: ReadonlySet<string>,
  limit: number,
): Promise<Record<string, unknown>> {
  const cfg = loadConfig();
  const corpus = await materializePdfs(target, cfg.region);
  const archiveSvc = new RawArchiveService(makeS3(cfg.region), awsS3Commands, {
    bucket: cfg.bucket,
    kmsKeyArn: cfg.kmsKeyArn,
    retentionYears: cfg.retentionYears,
  });
  const llama = new LlamaParseClient(
    { apiKey: cfg.llamaApiKey, baseUrl: cfg.llamaBaseUrl },
    (url, init) =>
      fetch(url, init as RequestInit) as unknown as ReturnType<
        Parameters<typeof LlamaParseClient>[1]
      >,
  );

  const results: Array<Record<string, unknown>> = [];
  let processed = 0;
  for (const pdfPath of corpus.files) {
    if (processed >= limit) break;
    const cls = classificationFor(pdfPath, fyFallback);
    if (!shouldProcess(cls, only)) {
      results.push({ file: path.basename(pdfPath), skipped: `family=${cls.family}` });
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
      manifest: {
        component: cls.component,
        budgetCycle: cls.budgetCycle,
        documentType: cls.documentType,
        posture: 'extract_only',
      },
    };

    const archive = await archiveSvc.archiveOriginal(descriptor);
    const parsed = await llama.parse({
      file: fs.readFileSync(pdfPath),
      filename: path.basename(pdfPath),
      mode,
      resultType: 'both',
    });
    if (parsed.status !== 'SUCCESS' || (!parsed.json && parsed.markdown == null)) {
      throw new Error(
        `LlamaParse failed for ${path.basename(pdfPath)} with status ${parsed.status}`,
      );
    }

    const derived: Array<Record<string, unknown>> = [];
    if (parsed.markdown != null) {
      derived.push(
        await archiveSvc.archiveDerived(
          descriptor,
          sha256,
          'parsed.md',
          parsed.markdown,
          'text/markdown',
        ),
      );
    }
    if (parsed.json != null) {
      derived.push(
        await archiveSvc.archiveDerived(
          descriptor,
          sha256,
          'parsed.json',
          JSON.stringify(parsed.json, null, 2),
          'application/json',
        ),
      );
    }

    const pages = adaptLlamaParseJson(parsed.json, {
      markdownFallback: parsed.markdown,
    });
    const extraction = runExtractor(cls, pages);
    results.push({
      file: path.basename(pdfPath),
      family: cls.family,
      fiscalYear: cls.fiscalYear,
      sourceKey: cls.sourceKey,
      sha256,
      archived: {
        bucket: archive.bucket,
        key: archive.key,
        versionId: archive.versionId,
        created: archive.created,
      },
      derived,
      providerJobId: parsed.jobId ?? null,
      lines: extraction.lineAssertions.length,
      values: extraction.yearValues.length,
      warnings: extraction.warnings,
      canonicalWrites: false,
    });
  }

  return {
    posture: 'extract_only',
    externalCalls: true,
    canonicalWrites: false,
    materializedFromS3: corpus.materializedFromS3,
    nonPdfObjectsSkipped: corpus.skipped,
    results,
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const posture: DefenseBudgetIngestPosture = resolveDefenseBudgetIngestPosture(argv);

  // This check intentionally precedes target validation and loadConfig(): an
  // attempted canonical run must never retrieve secrets, touch S3, or open a DB.
  if (posture === 'commit') throw new Error(COMMIT_DISABLED_MESSAGE);

  const vendorParseAllowed = argv.includes(ALLOW_VENDOR_PARSE);
  if (posture === 'extract_only' && !vendorParseAllowed) {
    throw new Error(
      '--extract-only requires explicit --allow-vendor-parse authorization before any archive or LlamaParse call.',
    );
  }
  if (posture === 'preflight' && vendorParseAllowed) {
    throw new Error('--allow-vendor-parse is valid only with --extract-only or deprecated --dry-run.');
  }

  const target = arg('path');
  if (!target) {
    throw new Error(
      'Usage: ingest-defense-budget-pdf.ts --path <pdf|dir|s3://bucket/prefix> [--extract-only --allow-vendor-parse] [--mode pdf_fast|pdf_premium|pdf_ocr] [--fy 2027] [--only rdte,procurement,om] [--limit N]',
    );
  }

  const mode = parseMode();
  const fyFallback = optionalFiscalYear();
  const only = new Set(
    (arg('only') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
  );
  const limit = positiveIntegerArg('limit', Number.MAX_SAFE_INTEGER);

  if (usesDeprecatedDryRunAlias(argv)) {
    console.warn(
      '[DEPRECATED] --dry-run is an alias for --extract-only and still performs S3 and LlamaParse external calls. Use no posture flag for a no-network preflight.',
    );
  }

  const result =
    posture === 'preflight'
      ? runPreflight(target, fyFallback, only, limit)
      : await runExtractOnly(target, mode, fyFallback, only, limit);

  console.log(
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        target,
        mode,
        ...result,
      },
      null,
      2,
    ),
  );
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[ingest-defense-budget] ${message}`);
  process.exit(1);
});
