/**
 * ingest-defense-budget-pdf — PE Watch PDF preflight, extraction and promotion.
 *
 * Safety posture:
 *   no posture flag  -> PREFLIGHT ONLY (local classification/SHA; no network/DB)
 *   --extract-only   -> immutable archive + LlamaParse + derived artifacts; no DB
 *   --dry-run        -> deprecated alias for --extract-only; still external/paid
 *   --commit         -> one PDF, exact approved SHA, archive/parse outside the DB
 *                       transaction, then one all-or-nothing canonical promotion
 *
 * Canonical money is USD millions. The mapper preserves the exact printed value
 * and unit next to each normalized value in the promotion manifest.
 */
import { config as dotenvConfig } from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { PrismaClient, type Prisma } from '@prisma/client';
import { RawArchiveService, type ArchiveDescriptor } from '../src/defense-budget/raw-archive.service.js';
import { makeS3, awsS3Commands, makeCorpusS3 } from '../src/defense-budget/s3-aws-commands.js';
import { parseS3Uri, materializeS3Corpus } from '../src/defense-budget/corpus-source.js';
import { LlamaParseClient, type FetchLike } from '../src/defense-budget/llamaparse.client.js';
import { classifyDocument, type DocClassification } from '../src/defense-budget/document-classifier.js';
import { adaptLlamaParseJson } from '../src/defense-budget/extractors/llamaparse-adapter.js';
import { extractRdte } from '../src/defense-budget/extractors/rdte.extractor.js';
import { extractProcurementOrOm } from '../src/defense-budget/extractors/procurement.extractor.js';
import { isValidPeCode, type ExtractionResult } from '../src/defense-budget/extractors/types.js';
import { mapAssertionsToPeWriter, type MappedPeData } from '../src/defense-budget/assertion-mapper.js';
import { ProgramElementWriterService } from '../src/program-element/program-element-writer.service.js';
import type { PrismaService } from '../src/prisma/prisma.service.js';
import {
  upsertSourceDocument,
  sha256OfBuffer,
  sha256OfFile,
  type SourceDocumentClient,
} from '../src/program-element/source-document/source-document-registry.js';
import { auditRows, type GuardRow } from '../src/program-element/coverage/pe-coverage.js';
import {
  recordIngestRun,
  type IngestRunClient,
  type LoadOutcome,
} from '../src/program-element/coverage/record-ingest-run.js';
import {
  resolveDefenseBudgetIngestPosture,
  usesDeprecatedDryRunAlias,
  type DefenseBudgetIngestPosture,
} from './lib/defense-budget-ingest-mode.js';
import {
  assertApprovedShaMatches,
  buildNormalizedValueManifest,
  requireApprovedSha256,
} from './lib/defense-budget-commit.js';

const ALLOWED_MODES = new Set(['pdf_fast', 'pdf_premium', 'pdf_ocr'] as const);
const ALLOW_VENDOR_PARSE = '--allow-vendor-parse';
const PROVIDER = 'llamaparse';
const CANONICAL_TRANSACTION_TIMEOUT_MS = 120_000;
const CANONICAL_TRANSACTION_MAX_WAIT_MS = 10_000;
type ParseMode = 'pdf_fast' | 'pdf_premium' | 'pdf_ocr';

// Legacy local development support only. Phase E replaces direct key loading
// with runtime AWS Secrets Manager retrieval. This file is read only after an
// explicit vendor-parse authorization and immediately before the vendor call.
const SECRET_FILE = path.join(
  process.env.HOME ?? process.env.USERPROFILE ?? '.',
  '.capiro-pe-secrets.env',
);

interface ArchiveConfig {
  bucket: string;
  kmsKeyArn?: string;
  retentionYears: number;
  region: string;
}

interface VendorConfig extends ArchiveConfig {
  llamaApiKey: string;
  llamaBaseUrl: string;
}

interface MaterializedCorpus {
  files: string[];
  materializedFromS3: boolean;
  skipped: number;
}

interface PreparedParse {
  json: unknown;
  parseJobId: string;
  providerJobId: string | null;
  outputJsonS3Key: string;
  outputJsonSha256: string;
  reusedArtifact: boolean;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
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

function archiveConfigFromEnvironment(): ArchiveConfig {
  const bucket = process.env.DEFENSE_BUDGET_RAW_BUCKET;
  if (!bucket) throw new Error('DEFENSE_BUDGET_RAW_BUCKET is required');
  const retentionYears = Number(process.env.DEFENSE_BUDGET_RETENTION_YEARS ?? '7');
  if (!Number.isFinite(retentionYears) || retentionYears <= 0) {
    throw new Error('DEFENSE_BUDGET_RETENTION_YEARS must be a positive number');
  }
  return {
    bucket,
    kmsKeyArn: process.env.DEFENSE_BUDGET_RAW_KMS_KEY_ARN,
    retentionYears,
    region: process.env.AWS_REGION_DEFAULT ?? 'us-east-1',
  };
}

function loadVendorParseEnvironment(): void {
  if (fs.existsSync(SECRET_FILE)) dotenvConfig({ path: SECRET_FILE });
  dotenvConfig();
}

function loadVendorConfig(): VendorConfig {
  loadVendorParseEnvironment();
  const archive = archiveConfigFromEnvironment();
  const llamaApiKey = process.env.LLAMA_CLOUD_API_KEY;
  if (!llamaApiKey) {
    throw new Error('LLAMA_CLOUD_API_KEY is required (vendor parsing fails closed without it)');
  }
  return {
    ...archive,
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
      'Preflight performs no S3 list/get call. Use --extract-only or an exact-SHA --commit to materialize this S3 corpus.',
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
): Promise<MaterializedCorpus> {
  const loc = parseS3Uri(target);
  if (!loc) {
    return { files: listLocalPdfs(target), materializedFromS3: false, skipped: 0 };
  }
  const mat = await materializeS3Corpus(loc, makeCorpusS3(region));
  return { files: mat.files, materializedFromS3: true, skipped: mat.skipped };
}

function makeArchiveService(config: ArchiveConfig): RawArchiveService {
  return new RawArchiveService(makeS3(config.region), awsS3Commands, {
    bucket: config.bucket,
    kmsKeyArn: config.kmsKeyArn,
    retentionYears: config.retentionYears,
  });
}

function makeLlamaClient(config: VendorConfig): LlamaParseClient {
  const fetchImpl: FetchLike = (url, init) =>
    fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>;
  return new LlamaParseClient(
    { apiKey: config.llamaApiKey, baseUrl: config.llamaBaseUrl },
    fetchImpl,
  );
}

function descriptorFor(
  pdfPath: string,
  cls: DocClassification,
  posture: 'extract_only' | 'commit',
): ArchiveDescriptor {
  return {
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
      posture,
      canonicalMoneyUnit: 'USD millions',
    },
  };
}

async function runExtractOnly(
  target: string,
  mode: ParseMode,
  fyFallback: number | null,
  only: ReadonlySet<string>,
  limit: number,
): Promise<Record<string, unknown>> {
  const cfg = loadVendorConfig();
  const corpus = await materializePdfs(target, cfg.region);
  const archiveSvc = makeArchiveService(cfg);
  const llama = makeLlamaClient(cfg);

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
    const descriptor = descriptorFor(pdfPath, cls, 'extract_only');
    const archive = await archiveSvc.archiveOriginal(descriptor);
    const parsed = await llama.parse({
      file: fs.readFileSync(pdfPath),
      filename: path.basename(pdfPath),
      mode,
      resultType: 'both',
    });
    if (parsed.status !== 'SUCCESS' || parsed.json == null) {
      throw new Error(
        `LlamaParse failed for ${path.basename(pdfPath)} with status ${parsed.status}; JSON output is required`,
      );
    }

    const derived: Array<Record<string, unknown>> = [];
    if (parsed.markdown != null) {
      derived.push(
        await archiveSvc.archiveDerived(
          descriptor,
          sha256,
          'parsed.pages-all.md',
          parsed.markdown,
          'text/markdown',
        ),
      );
    }
    const jsonText = JSON.stringify(parsed.json);
    derived.push(
      await archiveSvc.archiveDerived(
        descriptor,
        sha256,
        'parsed.pages-all.json',
        jsonText,
        'application/json',
      ),
    );

    const pages = adaptLlamaParseJson(parsed.json, {
      markdownFallback: parsed.markdown,
    });
    const extraction = runExtractor(cls, pages);
    const mapped = mapAssertionsToPeWriter(extraction);
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
      outputJsonSha256: sha256OfBuffer(Buffer.from(jsonText)),
      lines: extraction.lineAssertions.length,
      values: extraction.yearValues.length,
      normalizedValues: mapped.sourceValues.map((value) => ({
        peCode: value.peCode,
        fy: value.fy,
        fieldName: value.fieldName,
        originalValue: value.originalValue,
        originalUnit: value.originalUnit,
        canonicalValueM: value.valueM,
        pdfPage: value.provenance.pdfPage,
      })),
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? { ...(value as Record<string, unknown>) }
    : {};
}

async function loadExistingParseArtifact(
  prisma: PrismaClient,
  sourceDocumentId: string,
  inputSha256: string,
  bucket: string,
  region: string,
): Promise<PreparedParse | null> {
  const existing = await prisma.documentParseJob.findFirst({
    where: {
      sourceDocumentId,
      inputSha256,
      provider: PROVIDER,
      pageStart: null,
      pageEnd: null,
      status: 'succeeded',
      outputJsonS3Key: { not: null },
    },
    orderBy: { completedAt: 'desc' },
  });
  if (!existing?.outputJsonS3Key) return null;

  const bytes = await makeCorpusS3(region).getObject(bucket, existing.outputJsonS3Key);
  const jsonText = Buffer.from(bytes).toString('utf8');
  let json: unknown;
  try {
    json = JSON.parse(jsonText);
  } catch {
    throw new Error(
      `Stored parse artifact is not valid JSON: s3://${bucket}/${existing.outputJsonS3Key}`,
    );
  }
  return {
    json,
    parseJobId: existing.id,
    providerJobId: existing.providerJobId,
    outputJsonS3Key: existing.outputJsonS3Key,
    outputJsonSha256: sha256OfBuffer(Buffer.from(jsonText)),
    reusedArtifact: true,
  };
}

async function parseAndRecordOutsideTransaction(input: {
  prisma: PrismaClient;
  sourceDocumentId: string;
  inputSha256: string;
  pdfPath: string;
  descriptor: ArchiveDescriptor;
  archiveSvc: RawArchiveService;
  mode: ParseMode;
  vendorConfig: VendorConfig;
}): Promise<PreparedParse> {
  const existing = await input.prisma.documentParseJob.findFirst({
    where: {
      sourceDocumentId: input.sourceDocumentId,
      inputSha256: input.inputSha256,
      provider: PROVIDER,
      pageStart: null,
      pageEnd: null,
    },
  });

  const job = existing
    ? await input.prisma.documentParseJob.update({
        where: { id: existing.id },
        data: {
          status: 'running',
          error: null,
          mode: input.mode,
          resultType: 'both',
          startedAt: new Date(),
          completedAt: null,
        },
      })
    : await input.prisma.documentParseJob.create({
        data: {
          sourceDocumentId: input.sourceDocumentId,
          provider: PROVIDER,
          mode: input.mode,
          resultType: 'both',
          pageStart: null,
          pageEnd: null,
          inputSha256: input.inputSha256,
          status: 'running',
        },
      });

  try {
    const parsed = await makeLlamaClient(input.vendorConfig).parse({
      file: fs.readFileSync(input.pdfPath),
      filename: path.basename(input.pdfPath),
      mode: input.mode,
      resultType: 'both',
    });
    if (parsed.status !== 'SUCCESS' || parsed.json == null) {
      throw new Error(`LlamaParse returned ${parsed.status}; JSON output is required`);
    }

    let outputMarkdownS3Key: string | null = null;
    if (parsed.markdown != null) {
      outputMarkdownS3Key = (
        await input.archiveSvc.archiveDerived(
          input.descriptor,
          input.inputSha256,
          'parsed.pages-all.md',
          parsed.markdown,
          'text/markdown',
        )
      ).key;
    }
    const jsonText = JSON.stringify(parsed.json);
    const outputJsonS3Key = (
      await input.archiveSvc.archiveDerived(
        input.descriptor,
        input.inputSha256,
        'parsed.pages-all.json',
        jsonText,
        'application/json',
      )
    ).key;
    const outputJsonSha256 = sha256OfBuffer(Buffer.from(jsonText));

    await input.prisma.documentParseJob.update({
      where: { id: job.id },
      data: {
        status: 'succeeded',
        providerJobId: parsed.jobId,
        outputMarkdownS3Key,
        outputJsonS3Key,
        creditsUsed: parsed.creditsUsed ?? null,
        completedAt: new Date(),
        metadata: {
          ...asRecord(existing?.metadata),
          outputJsonSha256,
          canonicalMoneyUnit: 'USD millions',
        },
      },
    });

    return {
      json: parsed.json,
      parseJobId: job.id,
      providerJobId: parsed.jobId,
      outputJsonS3Key,
      outputJsonSha256,
      reusedArtifact: false,
    };
  } catch (error) {
    await input.prisma.documentParseJob.update({
      where: { id: job.id },
      data: {
        status: 'failed',
        error: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
        completedAt: new Date(),
      },
    });
    throw error;
  }
}

function buildGuardRows(mapped: MappedPeData): GuardRow[] {
  const titleByPe = new Map(mapped.records.map((record) => [record.peCode, record.title] as const));
  const markFields = [
    'hascMark',
    'sascMark',
    'hacDMark',
    'sacDMark',
    'conference',
    'ndaaConference',
    'enacted',
  ];
  return mapped.years.map((year) => {
    const obj = year as unknown as Record<string, unknown>;
    const request = typeof obj.request === 'number' ? obj.request : Number(obj.request ?? NaN);
    let mark: number | null = null;
    for (const field of markFields) {
      const value = obj[field];
      if (value == null) continue;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        mark = numeric;
        break;
      }
    }
    return {
      peCode: year.peCode,
      title: titleByPe.get(year.peCode) ?? null,
      request: Number.isFinite(request) ? request : null,
      mark,
    };
  });
}

function validateMappedArtifact(mapped: MappedPeData): void {
  if (mapped.records.length === 0 || mapped.years.length === 0 || mapped.sourceValues.length === 0) {
    throw new Error('Canonical promotion requires at least one RDT&E PE, year, and money assertion');
  }
  const recordCodes = new Set(mapped.records.map((record) => record.peCode));
  for (const record of mapped.records) {
    if (!isValidPeCode(record.peCode)) {
      throw new Error(`Invalid RDT&E PE code in artifact: ${record.peCode}`);
    }
  }
  for (const year of mapped.years) {
    if (!recordCodes.has(year.peCode)) {
      throw new Error(`PE-year ${year.peCode} FY${year.fy} has no catalog assertion`);
    }
    if (!Number.isInteger(year.fy) || year.fy < 1900 || year.fy > 2200) {
      throw new Error(`Invalid fiscal year for ${year.peCode}: ${year.fy}`);
    }
  }
  for (const value of mapped.sourceValues) {
    if (!Number.isFinite(value.valueM)) {
      throw new Error(
        `Non-finite canonical money for ${value.peCode} FY${value.fy} ${String(value.fieldName)}`,
      );
    }
  }
}

async function promoteMappedArtifact(input: {
  prisma: PrismaClient;
  mapped: MappedPeData;
  source: string;
  sourceDocumentId: string;
  sourceSha256: string;
  parse: PreparedParse;
  cls: DocClassification;
  artifactPath: string;
  warnings: string[];
}): Promise<LoadOutcome> {
  const guardRows = buildGuardRows(input.mapped);
  const audit = auditRows(guardRows);
  if (audit.status === 'fail') {
    throw new Error(
      `Quality audit failed before canonical promotion: unitsAnomalies=${audit.unitsAnomalies} titleTruncated=${audit.titleTruncated}`,
    );
  }

  return input.prisma.$transaction(
    async (tx) => {
      const writer = new ProgramElementWriterService(tx as unknown as PrismaService);
      const outcome: LoadOutcome = { upserted: 0, changed: 0, quarantined: 0 };

      for (const record of input.mapped.records) {
        const result = await writer.upsertProgramElement(record, input.source, 0.9);
        if (result.inserted) outcome.upserted += 1;
        else outcome.changed += 1;
      }

      for (const year of input.mapped.years) {
        const baseSource = input.source.replace(/_fy\d+$/i, '');
        const values = input.mapped.sourceValues.filter(
          (value) => value.peCode === year.peCode && value.fy === year.fy,
        );
        const observedFields = [...new Set(values.map((value) => String(value.fieldName)))];
        const preExistingObservationIds = new Set(
          (
            await tx.programElementYearSourceValue.findMany({
              where: {
                peCode: year.peCode,
                fy: year.fy,
                fieldName: { in: [...observedFields, '__row__'] },
                source: { in: [input.source, baseSource] },
              },
              select: { id: true },
            })
          ).map((row) => row.id),
        );

        const result = await writer.upsertProgramElementYear(year, input.source);
        if (result.inserted) outcome.upserted += 1;
        else if (result.changed) outcome.changed += 1;

        for (const value of values) {
          const newObservations = await tx.programElementYearSourceValue.findMany({
            where: {
              peCode: value.peCode,
              fy: value.fy,
              fieldName: String(value.fieldName),
              source: { in: [input.source, baseSource] },
              sourceDocumentId: null,
              id: { notIn: [...preExistingObservationIds] },
            },
            select: { id: true },
          });
          if (newObservations.length !== 1) {
            throw new Error(
              `Expected exactly one new canonical observation for ${value.peCode} FY${value.fy} ${String(value.fieldName)}; found ${newObservations.length}`,
            );
          }
          await tx.programElementYearSourceValue.update({
            where: { id: newObservations[0]!.id },
            data: {
              sourceDocumentId: input.sourceDocumentId,
              valueJsonb: {
                canonicalValueM: value.valueM,
                originalValue: value.originalValue,
                originalUnit: value.originalUnit,
                provenance: value.provenance,
              } as unknown as Prisma.InputJsonValue,
            },
          });
        }

        const newRowObservations = await tx.programElementYearSourceValue.findMany({
          where: {
            peCode: year.peCode,
            fy: year.fy,
            fieldName: '__row__',
            source: input.source,
            sourceDocumentId: null,
            id: { notIn: [...preExistingObservationIds] },
          },
          select: { id: true },
        });
        if (newRowObservations.length !== 1) {
          throw new Error(
            `Expected exactly one new row observation for ${year.peCode} FY${year.fy}; found ${newRowObservations.length}`,
          );
        }
        await tx.programElementYearSourceValue.update({
          where: { id: newRowObservations[0]!.id },
          data: { sourceDocumentId: input.sourceDocumentId },
        });
      }

      await recordIngestRun(tx as unknown as IngestRunClient, {
        source: input.source,
        fy: input.cls.fiscalYear,
        artifactPath: input.artifactPath,
        artifactSha256: input.sourceSha256,
        rows: guardRows,
        outcome,
        metadata: {
          sourceDocumentId: input.sourceDocumentId,
          parseJobId: input.parse.parseJobId,
          providerJobId: input.parse.providerJobId,
          outputJsonS3Key: input.parse.outputJsonS3Key,
          outputJsonSha256: input.parse.outputJsonSha256,
          reusedParseArtifact: input.parse.reusedArtifact,
          family: input.cls.family,
          warnings: input.warnings.slice(0, 20),
          canonicalMoneyUnit: 'USD millions',
        },
      });

      return outcome;
    },
    {
      maxWait: CANONICAL_TRANSACTION_MAX_WAIT_MS,
      timeout: CANONICAL_TRANSACTION_TIMEOUT_MS,
    },
  );
}

async function runCommit(
  target: string,
  approvedSha256: string,
  vendorParseAllowed: boolean,
  mode: ParseMode,
  fyFallback: number | null,
  only: ReadonlySet<string>,
  limit: number,
): Promise<Record<string, unknown>> {
  // Archive/S3 configuration contains no LlamaParse credential. For local files,
  // the source SHA is checked before any network or database call. S3 sources must
  // first be materialized, but still connect to no database before the exact match.
  const archiveConfig = archiveConfigFromEnvironment();
  const corpus = await materializePdfs(target, archiveConfig.region);
  const candidates = corpus.files
    .map((pdfPath) => ({ pdfPath, cls: classificationFor(pdfPath, fyFallback) }))
    .filter(({ cls }) => shouldProcess(cls, only))
    .slice(0, limit);
  if (candidates.length !== 1) {
    throw new Error(
      `--commit promotes exactly one processable PDF; selected ${candidates.length}. Use a single file or filters/--limit 1.`,
    );
  }

  const selected = candidates[0];
  if (!selected) {
    throw new Error('Internal error: one-PDF guard passed without a selected candidate');
  }
  const { pdfPath, cls } = selected;
  const sourceSha256 = sha256OfFile(pdfPath);
  assertApprovedShaMatches(sourceSha256, approvedSha256);

  const archiveSvc = makeArchiveService(archiveConfig);
  const descriptor = descriptorFor(pdfPath, cls, 'commit');
  const archive = await archiveSvc.archiveOriginal(descriptor);
  if (!archive.versionId) {
    throw new Error(
      'Immutable source archive did not return an S3 VersionId; canonical promotion is blocked.',
    );
  }

  const prisma = new PrismaClient();
  await prisma.$connect();
  try {
    const registered = await upsertSourceDocument(prisma as unknown as SourceDocumentClient, {
      sourceKey: cls.sourceKey,
      sha256: sourceSha256,
      fiscalYear: cls.fiscalYear,
      budgetCycle: cls.budgetCycle,
      component: cls.component,
      documentType: cls.documentType,
      title: path.basename(pdfPath),
      sourceUrl: target,
      byteSize: archive.byteSize,
      extractionMethod: PROVIDER,
      archiveBucket: archive.bucket,
      archiveS3Key: archive.key,
      archiveVersionId: archive.versionId,
      archiveKmsKeyArn: archive.kmsKeyArn ?? null,
      retainUntil: archive.retainUntil,
      archivedAt: new Date(),
      metadata: {
        retrievalKey: archive.retrievalKey,
        manifestKey: archive.manifestKey,
        classification: cls,
        canonicalMoneyUnit: 'USD millions',
      },
    });
    if (registered.document.supersededByDocumentId) {
      throw new Error(
        `Approved source document ${registered.document.id} is superseded by ${registered.document.supersededByDocumentId}; promote the current source version instead.`,
      );
    }
    const sourceDocument = await prisma.sourceDocument.update({
      where: { id: registered.document.id },
      data: {
        archiveBucket: archive.bucket,
        archiveS3Key: archive.key,
        archiveVersionId: archive.versionId,
        archiveKmsKeyArn: archive.kmsKeyArn ?? null,
        retainUntil: archive.retainUntil,
        archivedAt: new Date(),
        byteSize: archive.byteSize,
        metadata: {
          ...asRecord(registered.document.metadata),
          retrievalKey: archive.retrievalKey,
          manifestKey: archive.manifestKey,
          classification: cls,
          canonicalMoneyUnit: 'USD millions',
        } as unknown as Prisma.InputJsonValue,
      },
    });
    const sourceDocumentId = sourceDocument.id;

    let prepared = await loadExistingParseArtifact(
      prisma,
      sourceDocumentId,
      sourceSha256,
      archive.bucket,
      archiveConfig.region,
    );
    if (!prepared) {
      if (!vendorParseAllowed) {
        throw new Error(
          'No reusable checksummed parse artifact exists. Pass --allow-vendor-parse to authorize one LlamaParse request, or run --extract-only first.',
        );
      }
      const vendorConfig = loadVendorConfig();
      if (vendorConfig.bucket !== archiveConfig.bucket) {
        throw new Error('Vendor and archive configuration resolved different defense-budget buckets');
      }
      prepared = await parseAndRecordOutsideTransaction({
        prisma,
        sourceDocumentId,
        inputSha256: sourceSha256,
        pdfPath,
        descriptor,
        archiveSvc,
        mode,
        vendorConfig,
      });
    }

    const pages = adaptLlamaParseJson(prepared.json);
    const extraction = runExtractor(cls, pages);
    const mapped = mapAssertionsToPeWriter(extraction);
    validateMappedArtifact(mapped);
    const normalizedValues = buildNormalizedValueManifest(mapped, sourceDocumentId);
    const source = `${PROVIDER}_${cls.sourceKey}`;
    const loadOutcome = await promoteMappedArtifact({
      prisma,
      mapped,
      source,
      sourceDocumentId,
      sourceSha256,
      parse: prepared,
      cls,
      artifactPath: prepared.outputJsonS3Key,
      warnings: extraction.warnings,
    });

    return {
      posture: 'commit',
      externalCalls: true,
      canonicalWrites: true,
      source: {
        file: path.basename(pdfPath),
        sourceKey: cls.sourceKey,
        family: cls.family,
        fiscalYear: cls.fiscalYear,
        approvedSha256,
        actualSha256: sourceSha256,
        sourceDocumentId,
        archive: {
          bucket: archive.bucket,
          key: archive.key,
          versionId: archive.versionId,
          created: archive.created,
        },
      },
      parse: prepared,
      normalizedValues,
      nonPeLinesExcluded: mapped.nonPeLines.length,
      warnings: extraction.warnings,
      loadOutcome,
      transaction: {
        onePdfPerTransaction: true,
        maxWaitMs: CANONICAL_TRANSACTION_MAX_WAIT_MS,
        timeoutMs: CANONICAL_TRANSACTION_TIMEOUT_MS,
      },
      operationalWarning:
        'Do not run generalized --commit in production until Phase D idempotent observation keys are deployed and independently verified.',
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const posture: DefenseBudgetIngestPosture = resolveDefenseBudgetIngestPosture(argv);

  if (usesDeprecatedDryRunAlias(argv)) {
    console.warn(
      '[DEPRECATED] --dry-run is an alias for --extract-only and still performs S3 and LlamaParse external calls when explicitly authorized. Use no posture flag for a no-network preflight.',
    );
  }

  const vendorParseAllowed = argv.includes(ALLOW_VENDOR_PARSE);
  if (posture === 'extract_only' && !vendorParseAllowed) {
    throw new Error(
      '--extract-only requires explicit --allow-vendor-parse authorization before any archive or LlamaParse call.',
    );
  }
  if (posture === 'preflight' && vendorParseAllowed) {
    throw new Error('--allow-vendor-parse is valid only with --extract-only, deprecated --dry-run, or --commit.');
  }

  // Parse the approval before reading a target, configuration, secret, S3 object,
  // or database. The byte comparison itself occurs after local/S3 materialization
  // and still before Prisma is constructed or connected.
  const approvedSha256 =
    posture === 'commit' ? requireApprovedSha256(arg('approved-sha256')) : null;

  const target = arg('path');
  if (!target) {
    throw new Error(
      'Usage: ingest-defense-budget-pdf.ts --path <pdf|dir|s3://bucket/prefix> [--extract-only --allow-vendor-parse | --commit --approved-sha256 <sha> [--allow-vendor-parse]] [--mode pdf_fast|pdf_premium|pdf_ocr] [--fy 2027] [--only rdte,procurement,om] [--limit N]',
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

  const result =
    posture === 'preflight'
      ? runPreflight(target, fyFallback, only, limit)
      : posture === 'extract_only'
        ? await runExtractOnly(target, mode, fyFallback, only, limit)
        : await runCommit(
            target,
            approvedSha256!,
            vendorParseAllowed,
            mode,
            fyFallback,
            only,
            limit,
          );

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
