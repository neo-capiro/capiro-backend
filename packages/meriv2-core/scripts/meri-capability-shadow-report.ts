import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildCapabilityShadowReport, parseCapabilityShadowEvents, verifyCapabilityShadowMembershipManifest } from '../src/jev/evaluation/capability-shadow';

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function usage(): never {
  throw new Error('Usage: pnpm --filter @capiro/meriv2-core eval:meri-capability-shadow-report -- --events <jsonl> --membership <signed.json> --trusted-key <public.pem> --trusted-key-sha256 <fingerprint> --out <new-or-empty-directory> [--split all|exploratory|tuning|heldout]');
}

const eventsPath = arg('--events');
const membershipPath = arg('--membership');
const trustedKeyPath = arg('--trusted-key');
const trustedKeyFingerprint = arg('--trusted-key-sha256');
const outputDirectory = arg('--out');
const splitValue = arg('--split') ?? 'all';
if (!eventsPath || !membershipPath || !trustedKeyPath || !trustedKeyFingerprint || !outputDirectory || !['all', 'exploratory', 'tuning', 'heldout'].includes(splitValue)) usage();

const raw = readFileSync(eventsPath, 'utf8');
const ingestion = parseCapabilityShadowEvents(raw.split(/\r?\n/));
if (ingestion.rejected > 0) throw new Error(`refusing to write report: ${ingestion.rejected} event-shaped or malformed lines were rejected`);
const manifestRaw = readFileSync(membershipPath, 'utf8');
const manifest = verifyCapabilityShadowMembershipManifest(JSON.parse(manifestRaw), readFileSync(trustedKeyPath, 'utf8'), trustedKeyFingerprint);
const split = splitValue as 'all' | 'exploratory' | 'tuning' | 'heldout';
const report = buildCapabilityShadowReport(ingestion.events, manifest, split);
const out = path.resolve(outputDirectory);
if (existsSync(out) && readdirSync(out).length > 0) throw new Error('refusing to overwrite a non-empty report directory');
mkdirSync(out, { recursive: true });
const artifact = {
  reportVersion: 'meri_capability_shadow_artifact_v1',
  sourceFileSha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
  membershipDigest: manifest.digest,
  trustedSigningKeySha256: trustedKeyFingerprint.toLowerCase(),
  ingestion: { accepted: ingestion.events.length, rejected: ingestion.rejected, unrelated: ingestion.unrelated },
  report,
};
writeFileSync(path.join(out, 'capability-shadow-report.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
const markdown = [
  '# Capability routing shadow report',
  '',
  `- Split: ${report.split}`,
  `- Input SHA-256: \`${artifact.sourceFileSha256}\``,
  `- Accepted / rejected / unrelated lines: ${ingestion.events.length} / ${ingestion.rejected} / ${ingestion.unrelated}`,
  `- Eligible representative live turns selected: ${report.sampleFloor.eligibleSelected}`,
  `- Such turns attempted / dispatched / settled: ${report.sampleFloor.attempted} / ${report.sampleFloor.dispatched} / ${report.sampleFloor.settled}`,
  `- Structural 500-turn gate: ${report.sampleFloor.structurallyReady}`,
  `- Live producer evidence verified: ${report.sampleFloor.liveEvidenceVerified}`,
  `- Rollout qualified: ${report.sampleFloor.qualified}`,
  `- Eligible / ineligible: ${report.counts.eligible} / ${report.counts.ineligible}`,
  `- Observed eligible proposals / explicit fallbacks: ${report.counts.candidateProposals} / ${report.counts.eligibleFallbacks}`,
  `- Baseline/candidate route agreement among proposals: ${report.counts.routeAgreement} / ${report.counts.candidateProposals} (${report.counts.candidateBaselineRouteAgreement ?? 'n/a'})`,
  `- Candidate potential tool coverage: ${report.toolCoverage.candidatePotentialCoverage ?? 'n/a'}`,
  `- Baseline p95 / Jev p95 ms: ${report.operations.baselineDurationP95Ms ?? 'n/a'} / ${report.operations.jevDurationP95Ms ?? 'n/a'}`,
  `- Baseline / Jev known-cost subtotals USD: ${report.operations.baselineCostUsdKnownSubtotal ?? 'unknown'} / ${report.operations.jevCostUsdKnownSubtotal ?? 'unknown'}`,
  `- Baseline / Jev dispatched-attempt costs unknown: ${report.operations.baselineUnknownAttemptCosts} / ${report.operations.jevUnknownAttemptCosts}`,
  `- Event payload digest: \`${report.inputDigest}\``,
  `- Tenant strata: ${report.counts.distinctTenantPseudonyms} opaque HMAC pseudonyms (no raw tenant IDs)`,
  '',
  'This offline report measures routing agreement and observed baseline plus Jev overhead. It has no candidate execution or factual-quality verdict. The sample volume floor is necessary only and never grants rollout approval.',
  '',
].join('\n');
writeFileSync(path.join(out, 'capability-shadow-report.md'), markdown, 'utf8');
process.stdout.write(`Wrote ${report.counts.events} events; ${ingestion.rejected} rejected, ${ingestion.unrelated} unrelated. Live-evidence verification and rollout qualification are false.\n`);
