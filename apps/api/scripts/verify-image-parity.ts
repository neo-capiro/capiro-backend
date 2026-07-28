/**
 * Image-parity check — "is the scheduled work running the same code as the services?"
 *
 * Companion to verify-migrations.ts. Both exist because "deployed" is not one
 * fact. A LegiWatch change can be live in three different senses:
 *
 *   1. the schema it needs is applied        -> verify-migrations.ts
 *   2. the long-running service runs it      -> `aws ecs update-service` + digest
 *   3. the SCHEDULED tasks run it            -> this script
 *
 * (3) is the one nobody checks. Every EventBridge-driven task definition in
 * capiro-dev pins `:latest` rather than a SHA — verified live 2026-07-27:
 *
 *   capiro-dev-flush-intel-digests-daily   -> capiro-dev-intel-api-enableflag  (intel-api:latest)
 *   capiro-dev-flush-intel-digests-weekly  -> capiro-dev-intel-api-enableflag  (intel-api:latest)
 *   capiro-dev-detect-bill-changes         -> capiro-dev-intel-api-enableflag  (intel-api:latest)
 *   capiro-dev-poll-senate-hearings        -> capiro-dev-intel-api-poll        (intel-api:latest)
 *   capiro-dev-flush-tracker-digests-daily -> capiro-dev-api-migrate           (api:latest)
 *   capiro-dev-flush-tracker-digests-weekly-> capiro-dev-api-migrate           (api:latest)
 *   capiro-dev-detect-tracker-alerts       -> capiro-dev-api-migrate           (api:latest)
 *
 * So a merge to main goes live for the CRON at the next tick, with no
 * update-service and no digest verification — while the HTTP service keeps
 * serving the older image until someone rolls it. The two drift apart silently,
 * and the window is up to 24h for a daily rule.
 *
 * This script compares the digest `:latest` resolves to in ECR against the
 * digest each service's RUNNING task is actually executing. They must match.
 *
 * Usage
 *   tsx apps/api/scripts/verify-image-parity.ts --profile=capiro-dev
 *   tsx apps/api/scripts/verify-image-parity.ts --profile=capiro-dev --service=capiro-dev-intel-api
 *
 * Exits non-zero on a mismatch.
 */
import { execFileSync } from 'node:child_process';

export interface ServicePair {
  /** ECS service name, e.g. capiro-dev-intel-api */
  service: string;
  /** ECR repository name, e.g. capiro/dev/intel-api */
  repository: string;
}

export interface ParityResult {
  service: string;
  repository: string;
  /** What a scheduled task pulling `:latest` would get right now. */
  latestDigest: string | null;
  /** What the running service task is actually executing. */
  runningDigest: string | null;
  /** Git SHAs tagged on the `:latest` image, for the human reading the output. */
  latestTags: string[];
  match: boolean;
  note: string;
}

export const DEFAULT_PAIRS: ServicePair[] = [
  { service: 'capiro-dev-intel-api', repository: 'capiro/dev/intel-api' },
  { service: 'capiro-dev-api', repository: 'capiro/dev/api' },
  { service: 'capiro-dev-web', repository: 'capiro/dev/web' },
];

export interface Options {
  cluster: string;
  service: string | null;
  profile: string | null;
  region: string;
}

export function parseArgs(argv: string[]): Options {
  const o: Options = { cluster: 'capiro-dev', service: null, profile: null, region: 'us-east-1' };
  for (const arg of argv.slice(2)) {
    if (arg.startsWith('--cluster=')) o.cluster = arg.slice('--cluster='.length);
    else if (arg.startsWith('--service=')) o.service = arg.slice('--service='.length) || null;
    else if (arg.startsWith('--profile=')) o.profile = arg.slice('--profile='.length) || null;
    else if (arg.startsWith('--region=')) o.region = arg.slice('--region='.length);
  }
  return o;
}

export function evaluate(
  service: string,
  repository: string,
  latestDigest: string | null,
  runningDigest: string | null,
  latestTags: string[],
): ParityResult {
  let match: boolean;
  let note: string;
  if (!latestDigest) {
    match = false;
    note = 'no :latest tag in ECR';
  } else if (!runningDigest) {
    // Zero running tasks is not "in parity by default" — it means the service
    // is serving nothing, which is strictly worse than a stale image.
    match = false;
    note = 'service has no RUNNING task';
  } else if (latestDigest === runningDigest) {
    match = true;
    note = 'scheduled tasks and the service run identical code';
  } else {
    match = false;
    note = 'scheduled tasks would run NEWER code than the service — run `aws ecs update-service --force-new-deployment`';
  }
  return { service, repository, latestDigest, runningDigest, latestTags, match, note };
}

export function formatReport(results: ParityResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    const flag = r.match ? 'OK   ' : 'DRIFT';
    const short = (d: string | null) => (d ? d.replace('sha256:', '').slice(0, 12) : '—');
    lines.push(`${flag} ${r.service.padEnd(22)} latest=${short(r.latestDigest)} running=${short(r.runningDigest)}  ${r.note}`);
    if (r.latestTags.length) {
      const sha = r.latestTags.find((t) => /^[0-9a-f]{40}$/.test(t));
      if (sha) lines.push(`        :latest is commit ${sha.slice(0, 8)}`);
    }
  }
  const bad = results.filter((r) => !r.match).length;
  lines.push(
    bad === 0
      ? `\nAll ${results.length} service(s) in parity. Cron-driven tasks pull the same image the services run.`
      : `\n${bad} service(s) out of parity. A scheduled task could run code the service is not serving.`,
  );
  return lines.join('\n');
}

function aws(o: Options, args: string[]): string {
  const full = [...args, '--region', o.region];
  if (o.profile) full.push('--profile', o.profile);
  return execFileSync('aws', full, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    shell: process.platform === 'win32',
  });
}

function jsonAws<T>(o: Options, args: string[]): T | null {
  try {
    return JSON.parse(aws(o, [...args, '--output', 'json'])) as T;
  } catch {
    return null;
  }
}

function main(): void {
  const o = parseArgs(process.argv);
  const pairs = o.service ? DEFAULT_PAIRS.filter((p) => p.service === o.service) : DEFAULT_PAIRS;
  if (pairs.length === 0) {
    process.stderr.write(`unknown service '${o.service}'. Known: ${DEFAULT_PAIRS.map((p) => p.service).join(', ')}\n`);
    process.exit(2);
  }

  const results: ParityResult[] = [];
  for (const p of pairs) {
    const img = jsonAws<{ imageDetails: { imageDigest: string; imageTags?: string[] }[] }>(o, [
      'ecr', 'describe-images', '--repository-name', p.repository, '--image-ids', 'imageTag=latest',
    ]);
    const latestDigest = img?.imageDetails?.[0]?.imageDigest ?? null;
    const latestTags = img?.imageDetails?.[0]?.imageTags ?? [];

    const taskList = jsonAws<{ taskArns: string[] }>(o, [
      'ecs', 'list-tasks', '--cluster', o.cluster, '--service-name', p.service, '--desired-status', 'RUNNING',
    ]);
    let runningDigest: string | null = null;
    const arn = taskList?.taskArns?.[0];
    if (arn) {
      const desc = jsonAws<{ tasks: { containers: { imageDigest?: string }[] }[] }>(o, [
        'ecs', 'describe-tasks', '--cluster', o.cluster, '--tasks', arn,
      ]);
      runningDigest = desc?.tasks?.[0]?.containers?.[0]?.imageDigest ?? null;
    }
    results.push(evaluate(p.service, p.repository, latestDigest, runningDigest, latestTags));
  }

  process.stdout.write(formatReport(results) + '\n');
  process.exit(results.some((r) => !r.match) ? 1 : 0);
}

if (process.argv[1] && /verify-image-parity\.(ts|js)$/.test(process.argv[1])) {
  main();
}
