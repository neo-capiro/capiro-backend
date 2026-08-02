/**
 * Local-only legacy-artifact -> defense_budget_extraction_v1 converter.
 *
 *   pnpm --filter @capiro/api convert:defense-budget-artifact -- \
 *     --manifest <manifest.json> --document <document-key> \
 *     --kind <extraction_result|r1|r2|r3_performer|committee|pdoc> \
 *     --input <legacy-artifact.json> --source-sha256 <pdf-sha256> \
 *     --parser-method <method> --parser-version <version> \
 *     --parser-config-sha256 <sha256> --out <output.extraction-v1.json> [--force]
 *
 * Behavior: validates all arguments, loads the manifest + exact document
 * entry, hashes the legacy input file as the parser output SHA, builds the
 * adapter context, invokes exactly one adapter, finalizes + validates the V1
 * artifact, writes canonical JSON plus one trailing newline, and prints the
 * result summary. Refuses to overwrite an existing output without --force.
 * No network, no database.
 */
import * as fs from 'node:fs';
import {
  canonicalJsonStringify,
  sha256Hex,
} from '../src/defense-budget/contracts/canonical-json.js';
import type {
  DefenseBudgetExtractionArtifactV1,
  ExtractionMethodV1,
} from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { extractionMethodV1Schema } from '../src/defense-budget/contracts/extraction-artifact-v1.js';
import { parseBudgetCycleManifestV1 } from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import type { ExtractionAdapterContextV1 } from '../src/defense-budget/contracts/adapters/adapter-context.js';
import { parseExtractionAdapterContextV1 } from '../src/defense-budget/contracts/adapters/adapter-context.js';
import { adaptExtractionResultToArtifactV1 } from '../src/defense-budget/contracts/adapters/extraction-result-v1.adapter.js';
import { adaptR1ArtifactToArtifactV1 } from '../src/defense-budget/contracts/adapters/r1-artifact-v1.adapter.js';
import { adaptR2ArtifactToArtifactV1 } from '../src/defense-budget/contracts/adapters/r2-artifact-v1.adapter.js';
import { adaptR3PerformerArtifactToArtifactV1 } from '../src/defense-budget/contracts/adapters/r3-performer-artifact-v1.adapter.js';
import {
  adaptCommitteeArtifactToArtifactV1,
  COMMITTEE_ADAPTER_MODE_VALUES,
  type CommitteeAdapterMode,
} from '../src/defense-budget/contracts/adapters/committee-artifact-v1.adapter.js';
import { adaptPdocArtifactToArtifactV1 } from '../src/defense-budget/contracts/adapters/pdoc-artifact-v1.adapter.js';
import type { ExtractionResult } from '../src/defense-budget/extractors/types.js';

export const CONVERTER_KIND_VALUES = [
  'extraction_result',
  'r1',
  'r2',
  'r3_performer',
  'committee',
  'pdoc',
] as const;
export type ConverterKind = (typeof CONVERTER_KIND_VALUES)[number];

export interface ConverterArgs {
  manifest: string;
  document: string;
  kind: ConverterKind;
  input: string;
  sourceSha256: string;
  parserMethod: ExtractionMethodV1;
  parserVersion: string;
  parserConfigSha256: string;
  out: string;
  force: boolean;
  committeeMode?: CommitteeAdapterMode;
  /** Optional declared-unit overrides forwarded to unit-sensitive adapters. */
  r1FundingUnit?: 'dollars' | 'thousands' | 'millions';
  r3CostUnit?: 'dollars' | 'thousands' | 'millions';
  committeeDeclaredUnit?: 'dollars' | 'thousands' | 'millions';
  pdocAccount?: string;
  pdocLineItemDollarsUnit?: 'dollars' | 'thousands' | 'millions';
}

export interface ConverterResult {
  outPath: string;
  artifactId: string;
  contentSha256: string;
  sourceFactCount: number;
  assertionCount: number;
  warningCount: number;
  omissionCount: number;
  completenessStatus: string;
}

const SHA256_RE = /^[a-f0-9]{64}$/;
const UNIT_VALUES = ['dollars', 'thousands', 'millions'] as const;

class ConverterArgError extends Error {}

function requireArg(args: Record<string, string | boolean | undefined>, name: string): string {
  const value = args[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ConverterArgError(`missing required --${name}`);
  }
  return value;
}

function parseUnit(value: string, flag: string): 'dollars' | 'thousands' | 'millions' {
  if ((UNIT_VALUES as readonly string[]).includes(value)) {
    return value as 'dollars' | 'thousands' | 'millions';
  }
  throw new ConverterArgError(`invalid --${flag}: ${value} (expected dollars|thousands|millions)`);
}

/** Parse argv into validated converter args. Throws ConverterArgError. */
export function parseConverterArgs(argv: string[]): ConverterArgs {
  const args: Record<string, string | boolean | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    if (token === '--force') {
      args['force'] = true;
    } else if (token.startsWith('--')) {
      args[token.slice(2)] = argv[i + 1];
      i += 1;
    }
  }

  const kindRaw = requireArg(args, 'kind');
  if (!(CONVERTER_KIND_VALUES as readonly string[]).includes(kindRaw)) {
    throw new ConverterArgError(
      `invalid --kind: ${kindRaw} (expected ${CONVERTER_KIND_VALUES.join('|')})`,
    );
  }

  const sourceSha256 = requireArg(args, 'source-sha256');
  if (!SHA256_RE.test(sourceSha256)) {
    throw new ConverterArgError('--source-sha256 must be a lowercase 64-char hex SHA-256');
  }
  const parserConfigSha256 = requireArg(args, 'parser-config-sha256');
  if (!SHA256_RE.test(parserConfigSha256)) {
    throw new ConverterArgError('--parser-config-sha256 must be a lowercase 64-char hex SHA-256');
  }

  const parserMethodRaw = requireArg(args, 'parser-method');
  const parserMethod = extractionMethodV1Schema.safeParse(parserMethodRaw);
  if (!parserMethod.success) {
    throw new ConverterArgError(`invalid --parser-method: ${parserMethodRaw}`);
  }

  let committeeMode: CommitteeAdapterMode | undefined;
  if (args['committee-mode'] != null) {
    const modeRaw = String(args['committee-mode']);
    if (!(COMMITTEE_ADAPTER_MODE_VALUES as readonly string[]).includes(modeRaw)) {
      throw new ConverterArgError(
        `invalid --committee-mode: ${modeRaw} (expected ${COMMITTEE_ADAPTER_MODE_VALUES.join('|')})`,
      );
    }
    committeeMode = modeRaw as CommitteeAdapterMode;
  }
  if (kindRaw === 'committee' && committeeMode == null) {
    throw new ConverterArgError('--kind committee requires --committee-mode');
  }

  return {
    manifest: requireArg(args, 'manifest'),
    document: requireArg(args, 'document'),
    kind: kindRaw as ConverterKind,
    input: requireArg(args, 'input'),
    sourceSha256,
    parserMethod: parserMethod.data,
    parserVersion: requireArg(args, 'parser-version'),
    parserConfigSha256,
    out: requireArg(args, 'out'),
    force: args['force'] === true,
    ...(committeeMode != null ? { committeeMode } : {}),
    ...(args['r1-funding-unit'] != null
      ? { r1FundingUnit: parseUnit(String(args['r1-funding-unit']), 'r1-funding-unit') }
      : {}),
    ...(args['r3-cost-unit'] != null
      ? { r3CostUnit: parseUnit(String(args['r3-cost-unit']), 'r3-cost-unit') }
      : {}),
    ...(args['committee-declared-unit'] != null
      ? {
          committeeDeclaredUnit: parseUnit(
            String(args['committee-declared-unit']),
            'committee-declared-unit',
          ),
        }
      : {}),
    ...(args['pdoc-account'] != null ? { pdocAccount: String(args['pdoc-account']) } : {}),
    ...(args['pdoc-line-item-dollars-unit'] != null
      ? {
          pdocLineItemDollarsUnit: parseUnit(
            String(args['pdoc-line-item-dollars-unit']),
            'pdoc-line-item-dollars-unit',
          ),
        }
      : {}),
  };
}

/** Run the conversion. Throws ConverterArgError or adapter/build errors. */
export function runConversion(args: ConverterArgs): ConverterResult {
  /* 1. manifest + document entry */
  const manifest = parseBudgetCycleManifestV1(
    JSON.parse(fs.readFileSync(args.manifest, 'utf8')) as unknown,
  );
  const documentEntry = manifest.documents.find((doc) => doc.documentKey === args.document);
  if (documentEntry == null) {
    throw new ConverterArgError(
      `manifest has no document with key "${args.document}" (known: ${manifest.documents.map((d) => d.documentKey).join(', ')})`,
    );
  }
  if (documentEntry.legacyArtifactKind != null && documentEntry.legacyArtifactKind !== args.kind) {
    throw new ConverterArgError(
      `--kind ${args.kind} does not match manifest legacyArtifactKind ${documentEntry.legacyArtifactKind} for document "${args.document}"`,
    );
  }

  /* 2. legacy input + its SHA (parser output SHA) */
  const inputRaw = fs.readFileSync(args.input, 'utf8');
  const outputArtifactSha256 = sha256Hex(inputRaw);
  const legacy = JSON.parse(inputRaw) as unknown;

  /* 3. adapter context */
  const context: ExtractionAdapterContextV1 = parseExtractionAdapterContextV1({
    manifestDocumentKey: documentEntry.documentKey,
    sourcePdfSha256: args.sourceSha256,
    sourceLocator: documentEntry.sourceLocator,
    ...(documentEntry.sourceUrl != null ? { sourceUrl: documentEntry.sourceUrl } : {}),
    fiscalYear: manifest.fiscalYear,
    family: documentEntry.family,
    exhibit: documentEntry.exhibit,
    authority: documentEntry.authority,
    component: documentEntry.component,
    budgetCycle: documentEntry.budgetCycle,
    documentType: documentEntry.documentType,
    ...(documentEntry.title != null ? { title: documentEntry.title } : {}),
    parser: {
      method: args.parserMethod,
      parserVersion: args.parserVersion,
      parserConfigSha256: args.parserConfigSha256,
      outputArtifactSha256,
      pageRanges: [{ startPage: 1, endPage: 10000 }],
    },
  });

  /* 4. exactly one adapter */
  const artifact = invokeAdapter(args, legacy, context);

  /* 5. write canonical JSON + trailing newline, refuse overwrite */
  if (fs.existsSync(args.out) && !args.force) {
    throw new ConverterArgError(`output already exists: ${args.out} (supply --force to replace)`);
  }
  fs.writeFileSync(args.out, canonicalJsonStringify(artifact) + '\n', 'utf8');

  return {
    outPath: args.out,
    artifactId: artifact.artifactId,
    contentSha256: artifact.contentSha256,
    sourceFactCount: artifact.summary.sourceFactCount,
    assertionCount: artifact.summary.assertionCount,
    warningCount: artifact.summary.warningCount,
    omissionCount: artifact.summary.omissionCount,
    completenessStatus: artifact.summary.completenessStatus,
  };
}

function invokeAdapter(
  args: ConverterArgs,
  legacy: unknown,
  context: ExtractionAdapterContextV1,
): DefenseBudgetExtractionArtifactV1 {
  switch (args.kind) {
    case 'extraction_result':
      return adaptExtractionResultToArtifactV1(legacy as ExtractionResult, context);
    case 'r1':
      return adaptR1ArtifactToArtifactV1(legacy as never, context, {
        fundingUnit: args.r1FundingUnit ?? 'thousands',
      });
    case 'r2':
      return adaptR2ArtifactToArtifactV1(legacy as never, context);
    case 'r3_performer':
      return adaptR3PerformerArtifactToArtifactV1(legacy as never, context, {
        ...(args.r3CostUnit != null ? { costUnit: args.r3CostUnit } : {}),
      });
    case 'committee':
      return adaptCommitteeArtifactToArtifactV1(legacy as never, context, {
        mode: args.committeeMode!,
        ...(args.committeeDeclaredUnit != null
          ? { legacyDeclaredUnit: args.committeeDeclaredUnit }
          : {}),
        defaultFiscalYear: context.fiscalYear,
      });
    case 'pdoc':
      if (args.pdocAccount == null) {
        throw new ConverterArgError('--kind pdoc requires --pdoc-account');
      }
      return adaptPdocArtifactToArtifactV1(legacy as never, context, {
        account: args.pdocAccount,
        ...(args.pdocLineItemDollarsUnit != null
          ? { legacyLineItemDollarsUnit: args.pdocLineItemDollarsUnit }
          : {}),
        defaultFiscalYear: context.fiscalYear,
      });
    default: {
      const exhaustive: never = args.kind;
      throw new ConverterArgError(`unimplemented kind: ${String(exhaustive)}`);
    }
  }
}

function main(): void {
  try {
    const args = parseConverterArgs(process.argv.slice(2));
    const result = runConversion(args);
    console.log(JSON.stringify(result, null, 2));
  } catch (cause) {
    console.error(`convert-defense-budget-artifact: ${(cause as Error).message}`);
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] != null && process.argv[1].endsWith('convert-defense-budget-artifact.ts');
if (invokedDirectly) {
  main();
}
