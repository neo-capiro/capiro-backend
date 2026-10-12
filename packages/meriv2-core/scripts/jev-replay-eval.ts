/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEvalCli } from './lib/eval-cli';
import type { ClaimLedger } from '../src';

const cli = parseEvalCli({
  usage:
    'Usage: tsx scripts/jev-replay-eval.ts --write [--store FILE] [--output DIR] [--live] (or provide --store/--output explicitly)',
  valueOptions: ['--store', '--output'],
  actionOptions: ['--write', '--live'],
});

async function main(): Promise<void> {
  const {
    buildClaimSupportQuestion,
    buildEvidenceEnvelope,
    createReplayDecisionProvider,
    createSkepticDecisionProvider,
    jevClaimEvidenceFixtureSchema,
    RecordedDecisionStore,
    runPairedEvaluation,
  } = await import('../src');
  const live = cli.actions.has('--live');
  if (live && (!process.env.TYPESAFE_API_KEY || process.env.MERI_JEV_PROVIDER_MODE !== 'shadow')) {
    throw new Error('--live requires TYPESAFE_API_KEY and MERI_JEV_PROVIDER_MODE=shadow');
  }
  if (live)
    throw new Error('--live wiring is intentionally unavailable until an approved recording run');
  const storePath = path.resolve(cli.values.get('--store') ?? 'tmp/jev-recordings.jsonl');
  const outputDir = path.resolve(cli.values.get('--output') ?? 'tmp/jev-replay-eval');
  const fixturePath = path.resolve(
    __dirname,
    '../src/jev/__fixtures__/stage0-claim-evidence-v1.json',
  );
  const fixture = jevClaimEvidenceFixtureSchema.parse(
    JSON.parse(readFileSync(fixturePath, 'utf8')),
  );
  const cases = fixture.cases.map((item) => {
    const claim = {
      ...item.claim,
      type: item.claim.kind,
      sourceIds: item.evidence.map((e) => e.id),
      primarySourcePresent: item.evidence.length > 0,
      confidence: 'unknown' as const,
    };
    const ledger = {
      version: 'ga-claim-ledger-v1',
      claims: [claim],
      evidence: item.evidence.map((e) => ({
        id: e.id,
        sourceType: 'synthetic',
        sourceId: e.id,
        evidenceClass: 'public_primary' as const,
        primary: true,
        authoritative: true,
        requirementIds: [],
        asOf: e.sourceDate,
      })),
      unsupportedClaimIds: [],
      conflictedClaimIds: [],
      highRiskUnsupportedClaimIds: [],
      requiredEvidenceGaps: [],
      hash: 'fixture',
    } satisfies ClaimLedger;
    const { envelope } = buildEvidenceEnvelope({
      claim,
      ledger,
      citations: [],
      passages: Object.fromEntries(
        item.evidence.map((e) => [
          e.id,
          { text: e.text, locator: e.locator, sourceDate: e.sourceDate },
        ]),
      ),
      tenantId: item.tenantId,
      clientId: item.clientId,
    });
    return {
      id: item.id,
      category: item.category,
      claimKind: item.claim.kind,
      expectedOutcome: item.expectedOutcome,
      humanReview: item.humanReview,
      envelope,
    };
  });
  const store = new RecordedDecisionStore(storePath);
  const output = await runPairedEvaluation({
    cases,
    providers: {
      jev: createReplayDecisionProvider({ store, model: 'jev-1.13.0' }),
      legacy: createSkepticDecisionProvider(async (prompt) => ({
        refuted: !prompt.includes('directly states'),
        confidence: 'high',
        reason: 'Deterministic offline fixture stub.',
      })),
    },
    question: buildClaimSupportQuestion,
  });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(path.join(outputDir, 'results.json'), `${JSON.stringify(output, null, 2)}\n`);
  writeFileSync(
    path.join(outputDir, 'summary.md'),
    `# Jev replay evaluation\n\n- Fixture version: ${fixture.version}\n- Cases: ${output.summary.totalCases}\n- Output hash: \`${output.hash}\`\n- Replay store: \`${storePath}\`\n- Jev replay misses: ${output.results.filter((r) => r.jev.kind === 'failure').length}\n- Estimated input cost: $${output.summary.estimatedCostUsd.toFixed(8)}\n`,
  );
  console.log(`Wrote ${outputDir} (${output.hash})`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
