import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { verifyCapabilityShadowMembershipManifest } from '../src/jev/evaluation/capability-shadow';
import { buildCapabilityShadowSignedReport, MAX_SIGNED_CAPABILITY_SHADOW_ROWS, parseCapabilityShadowUniqueJson } from '../src/jev/evaluation/capability-shadow-signed-ingest';

const usage = 'Usage: pnpm --filter @capiro/meriv2-core eval:meri-capability-shadow-signed-report -- --signed-events <jsonl> --public-registry <public.json> --public-registry-sha256 <pinned-file-sha256> --membership <signed.json> --trusted-key <public.pem> --trusted-key-sha256 <pinned-spki-sha256> --out <new-or-empty-directory> [--split all|exploratory|tuning|heldout]';
const required = ['--signed-events', '--public-registry', '--public-registry-sha256', '--membership', '--trusted-key', '--trusted-key-sha256', '--out'];
const allowed = new Set([...required, '--split']);
const args = new Map<string, string>();
// pnpm may forward the documented separator; direct tsx invocation need not.
const cliArgs = process.argv.slice(process.argv[2] === '--' ? 3 : 2);
if (cliArgs.length % 2 !== 0) throw new Error(usage);
for (let index = 0; index < cliArgs.length; index += 2) {
  const name = cliArgs[index];
  const value = cliArgs[index + 1];
  if (!name || !allowed.has(name) || args.has(name) || !value || value.startsWith('--')) throw new Error(usage);
  args.set(name, value);
}
if (required.some((name) => !args.has(name))) throw new Error(usage);
const split = args.get('--split') ?? 'all';
if (!['all', 'exploratory', 'tuning', 'heldout'].includes(split)) throw new Error(usage);

function readBounded(name: string, bytes: number): string {
  const file = args.get(name)!;
  const before = statSync(file);
  if (!before.isFile() || before.size > bytes) throw new Error(`${name} exceeds byte limit or is not a file`);
  const input = readFileSync(file);
  const after = statSync(file);
  if (!after.isFile() || input.byteLength > bytes || before.size !== input.byteLength || after.size !== input.byteLength) {
    throw new Error(`${name} changed while reading or exceeds byte limit`);
  }
  const decoded = input.toString('utf8');
  // Invalid UTF-8 would otherwise be replaced, changing the bytes covered by SHA-256.
  if (!Buffer.from(decoded, 'utf8').equals(input)) throw new Error(`${name} contains malformed UTF-8`);
  return decoded;
}

const rawEvents = readBounded('--signed-events', 32 * 1024 * 1024);
const rawRegistry = readBounded('--public-registry', 128 * 1024);
const rawMembership = parseCapabilityShadowUniqueJson(readBounded('--membership', 32 * 1024 * 1024), 32 * 1024 * 1024);
const assignments = (rawMembership as { payload?: { assignments?: unknown } } | null)?.payload?.assignments;
if (Array.isArray(assignments) && assignments.length > MAX_SIGNED_CAPABILITY_SHADOW_ROWS) throw new Error('signed membership exceeds 2000 assignments');
const manifest = verifyCapabilityShadowMembershipManifest(
  rawMembership,
  readBounded('--trusted-key', 4096),
  args.get('--trusted-key-sha256')!,
);
const { ingestion, report } = buildCapabilityShadowSignedReport(
  rawEvents,
  rawRegistry,
  args.get('--public-registry-sha256')!,
  manifest,
  split as 'all' | 'exploratory' | 'tuning' | 'heldout',
);
const out = path.resolve(args.get('--out')!);
if (existsSync(out) && readdirSync(out).length > 0) throw new Error('refusing to overwrite a non-empty report directory');
mkdirSync(out, { recursive: true });
const artifact = {
  reportVersion: 'meri_capability_shadow_signed_artifact_v1',
  verification: {
    scope: 'individual Ed25519 event signatures under caller-pinned public registry; offline structural audit only',
    sourceFileSha256: ingestion.sourceSha256,
    publicRegistrySha256: ingestion.publicRegistrySha256,
    membershipDigest: manifest.digest,
    membershipSigningKeySha256: args.get('--trusted-key-sha256')!.toLowerCase(),
    signedEventsVerified: ingestion.verifiedEvents,
  },
  report,
};
writeFileSync(path.join(out, 'capability-shadow-signed-report.json'), `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
writeFileSync(path.join(out, 'capability-shadow-signed-report.md'), [
  '# Signed capability routing shadow report',
  '',
  `- Split: ${report.split}`,
  `- Individually verified signed events: ${ingestion.verifiedEvents}`,
  `- Event input SHA-256: \`${ingestion.sourceSha256}\``,
  `- Pinned public registry SHA-256: \`${ingestion.publicRegistrySha256}\``,
  `- Membership digest: \`${manifest.digest}\``,
  `- Structural 500-turn gate: ${report.sampleFloor.structurallyReady}`,
  `- Live producer evidence verified: ${report.sampleFloor.liveEvidenceVerified}`,
  `- Rollout qualified: ${report.sampleFloor.qualified}`,
  '',
  'Signatures authenticate event bytes only under the caller-pinned registry. They do not establish live provenance, truthful timestamps, pseudonym derivation, representative sampling, or rollout qualification.',
  '',
].join('\n'), 'utf8');
process.stdout.write(`Verified ${ingestion.verifiedEvents} signed events. Live-evidence verification and rollout qualification are false.\n`);
