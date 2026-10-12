/** @cleanup-smoke noArgsExit=2 helpExit=0 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const usage =
  'Usage: tsx scripts/jev-shadow-report.ts --out <dir> [--events <jsonl>] [--labels <json>] [--include-fixtures] [--recordings <jsonl>]';

function guardCli(): void {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error(usage);
    process.exit(2);
  }
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage);
    process.exit(0);
  }
  const valued = new Set(['--out', '--events', '--labels', '--recordings']);
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--include-fixtures') continue;
    if (!valued.has(args[index]!) || index + 1 >= args.length) {
      console.error(usage);
      process.exit(2);
    }
    index += 1;
  }
}
import {
  buildClaimSupportQuestion,
  buildEvidenceEnvelope,
  buildShadowReport,
  createReplayDecisionProvider,
  createSkepticDecisionProvider,
  humanLabelsSchema,
  jevClaimEvidenceFixtureSchema,
  readShadowEvents,
  RecordedDecisionStore,
  runPairedEvaluation,
  type ClaimLedger,
  type EvidenceDecision,
  type EvidenceShadowEvent,
  type EvidenceShadowTurnEvent,
  type HumanLabels,
} from '../src';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function logged(decision: EvidenceDecision) {
  return decision.kind === 'outcome'
    ? ({
        kind: decision.kind,
        outcome: decision.outcome,
        confidence: decision.confidence,
        probabilities: decision.probabilities,
        reasonCodes: decision.reasonCodes,
        model: decision.provider.model,
        questionVersion: decision.provider.questionVersion,
        latencyMs: decision.latencyMs,
        inputTokens: decision.usage?.inputTokens ?? 0,
      } as const)
    : ({
        kind: decision.kind,
        state: decision.state,
        confidence: null,
        probabilities: null,
        reasonCodes: decision.reasonCodes,
        model: decision.provider.model,
        questionVersion: decision.provider.questionVersion,
        latencyMs: decision.latencyMs,
        inputTokens: 0,
      } as const);
}

function key(decision: EvidenceDecision): string {
  return decision.kind === 'outcome' ? decision.outcome : `failure:${decision.state}`;
}

async function replayEvents(recordingsPath: string) {
  const fixturePath = path.resolve(
    __dirname,
    '../src/jev/__fixtures__/stage0-claim-evidence-v1.json',
  );
  const fixture = jevClaimEvidenceFixtureSchema.parse(
    JSON.parse(readFileSync(fixturePath, 'utf8')),
  );
  const prepared = fixture.cases.map((item) => {
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
    const built = buildEvidenceEnvelope({
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
    return { item, envelope: built.envelope, envelopeHash: built.hash };
  });
  const output = await runPairedEvaluation({
    cases: prepared.map(({ item, envelope }) => ({
      id: item.id,
      category: item.category,
      claimKind: item.claim.kind,
      expectedOutcome: item.expectedOutcome,
      humanReview: item.humanReview,
      envelope,
    })),
    providers: {
      jev: createReplayDecisionProvider({
        store: new RecordedDecisionStore(recordingsPath),
        model: 'jev-1.13.0',
      }),
      legacy: createSkepticDecisionProvider(async (prompt) => ({
        refuted: !prompt.includes('directly states'),
        confidence: 'high',
        reason: 'Deterministic offline fixture stub.',
      })),
    },
    question: buildClaimSupportQuestion,
  });
  const events: EvidenceShadowEvent[] = output.results.map((result, index) => {
    const source = prepared[index]!;
    return {
      event: 'meri.evidence_shadow',
      conversationId: 'offline-fixture',
      turnId: result.id,
      claimId: source.item.claim.id,
      claimKind: source.item.claim.kind,
      claimCategory: source.item.claim.category,
      envelopeHash: source.envelopeHash,
      eligibility: { eligible: true, reason: 'ok' },
      jev: logged(result.jev),
      legacy: logged(result.legacy),
      agreement: key(result.jev) === key(result.legacy),
      proposedAction: { jev: 'offline-only', legacy: 'offline-only' },
      claimText: source.item.claim.text,
      split: source.item.split,
      source: 'replay',
    };
  });
  const turn: EvidenceShadowTurnEvent = {
    event: 'meri.evidence_shadow.turn',
    conversationId: 'offline-fixture',
    turnId: null,
    selected: events.length,
    skipped: 0,
    budgetExhausted: false,
    durationMs: 0,
    inputTokens: output.summary.totalInputTokens,
    estimatedCostUsd: output.summary.estimatedCostUsd,
    sampled: false,
    source: 'replay',
  };
  return { events: [...events, turn], fixture };
}

async function main(): Promise<void> {
  const out = argument('--out');
  if (!out) throw new Error('--out <dir> is required');
  const eventsPath = argument('--events');
  const read = eventsPath
    ? readShadowEvents(path.resolve(eventsPath))
    : { events: [], rejected: 0, unrelated: 0 };
  const includeFixtures = process.argv.includes('--include-fixtures');
  let replay: Awaited<ReturnType<typeof replayEvents>> | undefined;
  if (includeFixtures) {
    const recordingsPath = path.resolve(
      argument('--recordings') ?? path.join(out, 'empty-recordings.jsonl'),
    );
    if (!argument('--recordings')) {
      mkdirSync(path.dirname(recordingsPath), { recursive: true });
      writeFileSync(recordingsPath, '');
    }
    replay = await replayEvents(recordingsPath);
  }
  let labels: HumanLabels | undefined;
  const labelsPath = argument('--labels');
  if (labelsPath)
    labels = humanLabelsSchema.parse(JSON.parse(readFileSync(path.resolve(labelsPath), 'utf8')));
  const report = buildShadowReport({
    events: [...read.events, ...(replay?.events ?? [])],
    fixtures: replay?.fixture,
    labels,
    split: 'all',
    rejectedLines: read.rejected,
  });
  const outputDir = path.resolve(out);
  mkdirSync(outputDir, { recursive: true });
  const { markdown, ...json } = report;
  writeFileSync(path.join(outputDir, 'shadow-report.json'), `${JSON.stringify(json, null, 2)}\n`);
  writeFileSync(path.join(outputDir, 'shadow-report.md'), markdown);
  console.log(
    `Wrote ${outputDir} (${report.hash}); ${report.counts.liveClaimEvents} live events, ${report.counts.replayMisses} replay misses`,
  );
}

guardCli();
main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
