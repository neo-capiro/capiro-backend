import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { releaseOperator } from '../../../scripts/meri-release.mjs';
import { sha256Bytes, sha256Stable } from './artifact-collector.mjs';

const execute = promisify(execFile);
const READS = new Set([
  'sts get-caller-identity',
  'ecs describe-services',
  'ecs describe-task-definition',
  'ecs list-tasks',
  'ecs describe-tasks',
  'elbv2 describe-target-groups',
  'elbv2 describe-target-health',
  'ecr describe-images',
  'codebuild batch-get-builds',
]);
const need = (ok) => {
  if (!ok) throw new Error('CASE17_IMMUTABLE_BUILD_UNPROVED');
};
const SHA = /^[a-f0-9]{40}$/u;
const HASH = /^[a-f0-9]{64}$/u;

/** Pure account/principal check; only the native STS read below supplies authority. */
export function inspectCase17Caller(caller) {
  need(
    caller?.Account === '967807252336' &&
      caller.Arn === 'arn:aws:iam::967807252336:user/hermes-cli',
  );
  return { account: caller.Account, arn: caller.Arn };
}

/** This read-only UI row has no orchestrator/provider execution. API and Web must both be current.
 * Pure comparison only; the authority factory below supplies actual AWS reads. */
export function inspectCase17Build({ expected, build, snapshot, image }) {
  need(
    ['api', 'web-vnext'].includes(expected?.service) &&
      SHA.test(expected.sourceSha ?? '') &&
      /^sha256:[a-f0-9]{64}$/u.test(expected.imageDigest ?? '') &&
      HASH.test(expected.buildspecSha256 ?? ''),
  );
  need(
    build?.id === expected.buildId &&
      build.buildStatus === 'SUCCEEDED' &&
      build.buildComplete === true &&
      build.resolvedSourceVersion === expected.sourceSha &&
      build.source?.type === 'GITHUB' &&
      /^https:\/\/github\.com\/neo-capiro\/capirov2(?:\.git)?$/u.test(build.source.location) &&
      typeof build.source.buildspec === 'string' &&
      sha256Bytes(build.source.buildspec) === expected.buildspecSha256,
  );
  need(
    Array.isArray(build.phases) &&
      ['PRE_BUILD', 'BUILD', 'POST_BUILD'].every(
        (name) =>
          build.phases.filter(
            (phase) => phase.phaseType === name && phase.phaseStatus === 'SUCCEEDED',
          ).length === 1,
      ),
  );
  need(
    image?.imageDetails?.length === 1 && image.imageDetails[0].imageDigest === expected.imageDigest,
  );
  const containers = snapshot?.task?.containerDefinitions?.filter(
    (row) => row.name === expected.service,
  );
  need(containers?.length === 1 && snapshot.baseline.imageDigest === expected.imageDigest);
  const container = containers[0];
  need(
    container.image ===
      `967807252336.dkr.ecr.us-east-1.amazonaws.com/capiro/dev/${expected.service}@${expected.imageDigest}` &&
      !container.environmentFiles?.length,
  );
  const entries = container.environment ?? [];
  need(new Set(entries.map((row) => row.name)).size === entries.length);
  const env = Object.fromEntries(entries.map((row) => [row.name, row.value]));
  need(env.GIT_SHA === expected.sourceSha && env.RELEASE_SHA === expected.sourceSha);
  const primary = snapshot.service.deployments.filter((row) => row.status === 'PRIMARY');
  need(primary.length === 1 && primary[0].rolloutState === 'COMPLETED');
  return {
    service: expected.service,
    sourceSha: expected.sourceSha,
    imageDigest: expected.imageDigest,
    buildId: expected.buildId,
    buildspecSha256: expected.buildspecSha256,
    taskDefinitionArn: snapshot.baseline.taskDefinitionArn,
    primaryDeploymentId: primary[0].id,
    baselineSha256: sha256Stable(snapshot.baseline),
  };
}

// Deliberately no injectable shell, executable, AWS function, or result argument.
// A scope-file declaration is checked against actual read-only cloud responses.
export async function readCase17BuildAuthority(deployment) {
  need(process.platform === 'win32');
  const aws = async (args) => {
    need(READS.has(args.slice(0, 2).join(' ')));
    try {
      const { stdout } = await execute(
        'C:/Program Files/Amazon/AWSCLIV2/aws.exe',
        [...args, '--region', 'us-east-1', '--output', 'json', '--no-cli-pager'],
        { windowsHide: true, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
      );
      return JSON.parse(stdout);
    } catch {
      throw new Error('CASE17_BUILD_READBACK_FAILED');
    }
  };
  const caller = inspectCase17Caller(await aws(['sts', 'get-caller-identity']));
  const operator = releaseOperator({ aws });
  const services = [];
  for (const service of ['api', 'web-vnext']) {
    const expected = deployment?.builds?.[service];
    need(
      expected?.service === service &&
        expected.sourceSha === deployment[service === 'api' ? 'apiSha' : 'webSha'],
    );
    need(
      typeof expected.buildId === 'string' &&
        /^capiro-build-[a-z0-9-]+:[a-f0-9-]{36}$/u.test(expected.buildId),
    );
    const response = await aws(['codebuild', 'batch-get-builds', '--ids', expected.buildId]);
    need(response.builds?.length === 1 && !response.buildsNotFound?.length);
    const snapshot = await operator.snapshot(service);
    const image = await aws([
      'ecr',
      'describe-images',
      '--repository-name',
      `capiro/dev/${service}`,
      '--image-ids',
      `imageTag=${expected.sourceSha}`,
    ]);
    services.push(inspectCase17Build({ expected, build: response.builds[0], snapshot, image }));
  }
  return { kind: 'meri-case17-current-immutable-builds', observedAt: Date.now(), caller, services };
}
