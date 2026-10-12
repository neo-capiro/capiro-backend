/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { readFile } from 'node:fs/promises';
import { z } from 'zod';
import { isCanonicalDecimalString } from '../src/defense-budget/contracts/decimal-string.js';
import {
  composeExecutionRecordV1,
  composeReprogrammingEventV1,
} from '../src/defense-budget/stages/post-enactment/reprogramming-execution-v1.js';
import type { AlternativeFundingSourceMeasureV1 } from '../src/defense-budget/funding-execution/funding-execution.v1.js';
import { FundingExecutionSourceAdapterService } from '../src/funding-execution/funding-execution-source-adapter.service.js';
import { FundingExecutionStore } from '../src/funding-execution/funding-execution.store.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

const alternativeFundingSchema = z.object({
  id: z.string().trim().min(1),
  measureType: z.enum(['supplemental', 'emergency_supplemental', 'reconciliation', 'continuing_resolution', 'rescission', 'transfer', 'reprogramming']),
  status: z.enum(['introduced', 'draft', 'pending', 'active', 'enacted', 'rejected', 'withdrawn', 'expired']),
  fiscalYear: z.number().int().min(1900).max(2200),
  sourceSystem: z.string().trim().min(1),
  sourceDocumentId: z.string().trim().min(1),
  sourceIdentity: z.string().trim().min(1),
  amountMillions: z.string().refine(isCanonicalDecimalString, 'must be a canonical decimal string'),
  asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amountBasis: z.enum(['snapshot', 'transaction_delta']),
  originalAmount: z.string().refine(isCanonicalDecimalString, 'must be a canonical decimal string'),
  originalUnit: z.enum(['dollars', 'thousands', 'millions']),
  evidenceIds: z.array(z.string().trim().min(1)).min(1),
}).strict();

const inputSchema = z.object({
  schemaVersion: z.literal('funding_execution_source_input_v1'),
  reprogramming: z.array(z.unknown()).default([]),
  execution: z.array(z.object({ profile: z.unknown(), record: z.unknown() }).strict()).default([]),
  alternativeFunding: z.array(alternativeFundingSchema).default([]),
  measureBindings: z.array(z.object({
    kind: z.enum(['alternative_funding', 'reprogramming', 'execution']),
    sourceNativeId: z.string().trim().min(1),
    measureId: z.string().uuid(),
  }).strict()),
}).strict();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const usage = 'Usage: funding-execution-source-adapter --input <source-batch.json> [--commit]';
  if (args.length === 1 && args[0] === '--help') {
    console.log(usage);
    return;
  }
  if (args.length === 0) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  let inputPath: string | undefined;
  let commit = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === '--commit') commit = true;
    else if (arg === '--input') {
      inputPath = args[++index];
      if (!inputPath || inputPath.startsWith('--')) {
        console.error(usage);
        process.exitCode = 2;
        return;
      }
    } else if (arg.startsWith('--input=')) inputPath = arg.slice('--input='.length);
    else {
      console.error(`Unsupported argument: ${arg}`);
      console.error(usage);
      process.exitCode = 2;
      return;
    }
  }
  if (!inputPath) {
    console.error(usage);
    process.exitCode = 2;
    return;
  }
  const raw = inputSchema.parse(JSON.parse(await readFile(inputPath, 'utf8')));
  const reprogramming = raw.reprogramming.map(composeReprogrammingEventV1);
  const execution = raw.execution.map((row) => composeExecutionRecordV1(row.profile, row.record));
  const prisma = new PrismaService();
  await prisma.$connect();
  try {
    const store = new FundingExecutionStore(prisma);
    const service = new FundingExecutionSourceAdapterService(store);
    const result = await service.run({
      reprogramming,
      execution,
      alternativeFunding: raw.alternativeFunding as AlternativeFundingSourceMeasureV1[],
      measureBindings: raw.measureBindings,
    }, { commit });
    console.log(JSON.stringify({
      mode: result.mode,
      factCount: result.factCount,
      sourceEventCount: result.sourceEventCount,
      insertedCount: result.insertedCount,
      findings: result.certificate.findings,
      reconciliationScopes: result.certificate.reconciliation.length,
      canonicalAnnualPromotionAllowed: result.certificate.canonicalAnnualPromotionAllowed,
    }, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/funding-execution-source-adapter.ts')) {
  void main().catch(() => {
    console.error('Funding/execution source adapter failed closed; source details withheld.');
    process.exit(1);
  });
}
