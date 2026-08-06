/** Deterministic, read-only Phase 3 parse-plan command. */
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseBudgetCycleManifestV1 } from '../src/defense-budget/contracts/budget-cycle-manifest-v1.js';
import { parseDocumentProfileResultV1 } from '../src/defense-budget/parser-router/page-profiler.js';
import {
  buildInitialParsePlan,
  parseDefenseBudgetParsePlanV1,
} from '../src/defense-budget/parser-router/route-planner.js';

const VALUE_FLAGS = new Set([
  '--manifest',
  '--document',
  '--source',
  '--profile',
  '--out',
  '--max-escalation-rounds',
]);

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]!;
    if (!VALUE_FLAGS.has(flag)) throw new Error(`unknown flag: ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    values.set(flag, value);
  }
  const manifest = values.get('--manifest');
  const document = values.get('--document');
  const source = values.get('--source');
  const profile = values.get('--profile');
  const out = values.get('--out');
  if (!manifest || !document || !source || !profile || !out) {
    throw new Error('--manifest, --document, --source, --profile, and --out are required');
  }
  const maxEscalationRounds = Number(values.get('--max-escalation-rounds') ?? '4');
  if (!Number.isInteger(maxEscalationRounds) || maxEscalationRounds < 1) {
    throw new Error('--max-escalation-rounds must be a positive integer');
  }
  return { manifest, document, source, profile, out, maxEscalationRounds };
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runtimeTarget(engines: readonly string[]): 'table' | 'layout' | 'ocr' {
  return engines.includes('paddleocr') ? 'ocr' : engines.includes('docling') ? 'layout' : 'table';
}

async function main(): Promise<void> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error((error as Error).message);
    process.exit(2);
  }

  let manifest;
  try {
    manifest = parseBudgetCycleManifestV1(
      JSON.parse(fs.readFileSync(path.resolve(args.manifest), 'utf8')),
    );
  } catch (error) {
    console.error(`manifest validation failed: ${(error as Error).message}`);
    process.exit(2);
  }
  const document = manifest.documents.find((entry) => entry.documentKey === args.document);
  if (!document) {
    console.error(`document not found in manifest: ${args.document}`);
    process.exit(2);
  }

  const sourcePath = path.resolve(args.source);
  const profilePath = path.resolve(args.profile);
  const outputPath = path.resolve(args.out);
  if (!fs.existsSync(sourcePath)) {
    console.error(`source file not found: ${sourcePath}`);
    process.exit(3);
  }
  if (!fs.existsSync(profilePath)) {
    console.error(`profile file not found: ${profilePath}`);
    process.exit(3);
  }

  const sourceSha256 = sha256File(sourcePath);
  let profile;
  try {
    profile = parseDocumentProfileResultV1(JSON.parse(fs.readFileSync(profilePath, 'utf8')));
  } catch (error) {
    console.error(`profile validation failed: ${(error as Error).message}`);
    process.exit(3);
  }
  if (profile.sourceSha256 !== sourceSha256) {
    console.error(
      `profile/source SHA mismatch: profile=${profile.sourceSha256} source=${sourceSha256}`,
    );
    process.exit(3);
  }
  if (profile.pages.length === 0) {
    console.error('profile contains zero physical pages');
    process.exit(3);
  }
  if (document.parserPolicy === 'native_structured') {
    console.error(
      'native_structured requires an explicitly supplied structured companion; the PDF parser plan cannot substitute for it',
    );
    process.exit(2);
  }

  const executionId = `plan-${document.documentKey}-${sourceSha256.slice(0, 16)}-${profile.contentSha256.slice(0, 16)}`;
  const plan = parseDefenseBudgetParsePlanV1(
    buildInitialParsePlan({
      executionId,
      cycleId: manifest.cycleId,
      manifestDocumentKey: document.documentKey,
      sourceSha256,
      parserPolicy: document.parserPolicy,
      pageProfiles: profile.pages,
      maxEscalationRounds: args.maxEscalationRounds,
    }),
  );
  if (plan.paidAuthorizationRequired || plan.plannedPaidPages.length > 0) {
    throw new Error('initial plan must be local-only and free');
  }

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
  console.log(
    JSON.stringify(
      {
        documentKey: document.documentKey,
        sourceSha256,
        profileContentSha256: profile.contentSha256,
        planSha256: plan.planSha256,
        executionId: plan.executionId,
        runtimeTarget: runtimeTarget(plan.steps.map((step) => step.engine)),
        steps: plan.steps,
        pagesThatMayRequireOcr: profile.pages
          .filter((page) => page.likelyImageOnly || page.likelyRotated)
          .map((page) => page.page),
        outputPath,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

main().catch((error) => {
  console.error(`internal failure: ${(error as Error).message}`);
  process.exit(9);
});
