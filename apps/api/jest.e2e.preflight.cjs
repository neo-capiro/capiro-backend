/**
 * Prerequisite preflight for the apps/api e2e tier (jest.e2e.config.cjs).
 *
 * Meri/Hermes Phase 1, required fix 6a — "make the e2e spec fail LOUDLY and
 * immediately with an actionable message if its prerequisites are absent,
 * rather than hanging or failing obscurely". This lives outside the spec
 * files deliberately: the specs themselves are owned elsewhere and are not
 * edited by this change.
 *
 * Loaded as `setupFilesAfterEnv`, so it runs once per test FILE, before that
 * file's module body is evaluated. Throwing here makes jest report
 * "Test suite failed to run" with this message and zero tests executed —
 * immediate and unmistakable.
 *
 * SECRET HYGIENE: this file checks only whether a variable is PRESENT on the
 * reference container. It never reads a value into the message, never logs
 * one, and never writes one to a file. `docker inspect --format` output is
 * scanned for `NAME=` prefixes and the remainder is discarded.
 */
const { execFileSync } = require('node:child_process');

const DOCKER_TIMEOUT_MS = 20_000;

/**
 * Per-spec prerequisite declarations, keyed by a path suffix.
 *
 * Adding a new `*.e2e.spec.ts` with infrastructure needs? Add a row. A spec
 * with no row gets the baseline check (a local fixture DATABASE_URL), which
 * every spec in this tier needs.
 */
const SPEC_PREREQUISITES = [
  {
    match: 'meri-hermes-full-application.e2e.spec.ts',
    label: 'Meri⇄Hermes full-application closeout gate',
    needsDocker: true,
    /** Overridable by the spec's own env contract — keep these in sync with it. */
    image: () => process.env.HERMES_IMAGE ?? 'meri-hermes-worker:v2026.9.14-meri',
    referenceContainer: () => process.env.MERI_HERMES_REFERENCE_CONTAINER ?? 'meri-hermes-p0-alice',
    /** Read by the spec at src/meri/hermes/meri-hermes-full-application.e2e.spec.ts:431-435. */
    referenceContainerEnv: [
      'API_SERVER_KEY',
      'OPENAI_API_KEY',
      'MERI_HERMES_MODEL',
      'MERI_HERMES_PROVIDER',
      'MERI_HERMES_BASE_URL',
    ],
    howToProvision: [
      'Locally: start the pinned reference worker and keep it running, e.g.',
      '  docker run -d --name meri-hermes-p0-alice \\',
      '    -e API_SERVER_KEY=... -e OPENAI_API_KEY=... \\',
      '    -e MERI_HERMES_MODEL=... -e MERI_HERMES_PROVIDER=... -e MERI_HERMES_BASE_URL=... \\',
      '    -p 18642:8000 meri-hermes-worker:v2026.9.14-meri',
      'In CI: run the workflow .github/workflows/meri-hermes-e2e-ci.yml, which provisions',
      'Postgres, replays migrations, starts the worker from the pinned image and waits on',
      '/health. That workflow is workflow_dispatch-only until the ECR repository that',
      'meri-hermes-worker-image.yml pushes to actually exists.',
      'Override the defaults with HERMES_IMAGE / MERI_HERMES_REFERENCE_CONTAINER /',
      'MERI_HERMES_CLOSEOUT_PORT if your local names differ.',
    ],
  },
];

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: DOCKER_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
  });
}

function checkDatabaseUrl(problems) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    problems.push(
      'DATABASE_URL is not set. The e2e tier writes and deletes rows and requires a LOCAL fixture Postgres, e.g. ' +
        'DATABASE_URL="postgresql://capiro:capiro@localhost:5432/capiro?schema=public"',
    );
    return;
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    problems.push(`DATABASE_URL is not a parseable URL (${url.replace(/\/\/[^@]*@/, '//***@')}).`);
    return;
  }
  if (!['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    problems.push(
      `DATABASE_URL points at host "${parsed.hostname}". The e2e tier writes and deletes rows and refuses any ` +
        'non-local database. Point it at the local fixture Postgres.',
    );
  }
}

function checkDocker(spec, problems) {
  try {
    docker(['version', '--format', '{{.Server.Version}}']);
  } catch (error) {
    problems.push(
      `docker is not usable (${error.code ?? 'error'}: ${String(error.message).split('\n')[0]}). ` +
        `${spec.label} launches a real worker container and cannot run without a working docker daemon.`,
    );
    // Everything below needs the daemon; stop here rather than pile on.
    return;
  }

  const image = spec.image();
  try {
    docker(['image', 'inspect', image, '--format', '{{.Id}}']);
  } catch {
    problems.push(
      `the pinned worker image "${image}" is not present locally. Build or pull it first ` +
        '(see .github/workflows/meri-hermes-worker-image.yml for the pinned build), or set HERMES_IMAGE.',
    );
  }

  const container = spec.referenceContainer();
  let running = null;
  try {
    running = docker(['inspect', container, '--format', '{{.State.Running}}']).trim();
  } catch {
    problems.push(
      `the reference container "${container}" does not exist. ${spec.label} reads its gateway and model ` +
        'credentials out of that container. Set MERI_HERMES_REFERENCE_CONTAINER if yours is named differently.',
    );
    return;
  }
  if (running !== 'true') {
    problems.push(`the reference container "${container}" exists but is not running (State.Running=${running}).`);
  }

  let envLines = [];
  try {
    envLines = docker(['inspect', container, '--format', '{{range .Config.Env}}{{println .}}{{end}}']).split('\n');
  } catch (error) {
    problems.push(`could not inspect the environment of container "${container}": ${String(error.message).split('\n')[0]}`);
    return;
  }
  // Presence only. Values are never captured, compared or printed.
  const present = new Set(
    envLines.map((line) => line.slice(0, Math.max(line.indexOf('='), 0))).filter((name) => name.length > 0),
  );
  const missing = spec.referenceContainerEnv.filter((name) => !present.has(name));
  if (missing.length > 0) {
    problems.push(
      `the reference container "${container}" is missing required variables: ${missing.join(', ')}. ` +
        '(Only their presence is checked; no value is read or printed.)',
    );
  }
}

function preflight() {
  const testPath = (typeof expect !== 'undefined' && expect.getState && expect.getState().testPath) || '';
  const normalized = testPath.split('\\').join('/');
  const spec = SPEC_PREREQUISITES.find((candidate) => normalized.endsWith(candidate.match));

  const problems = [];
  checkDatabaseUrl(problems);
  if (spec && spec.needsDocker) checkDocker(spec, problems);

  if (problems.length === 0) return;

  const label = spec ? spec.label : 'apps/api e2e tier';
  const lines = [
    '',
    '='.repeat(78),
    `E2E PREREQUISITES NOT MET — ${label}`,
    '='.repeat(78),
    `spec: ${normalized || '(unknown)'}`,
    '',
    'This suite is in the PROVISIONED e2e tier and was deliberately excluded from the',
    'ordinary `pnpm --filter @capiro/api test` / `jest src/meri/hermes` run, so reaching',
    'it means it was requested explicitly. It cannot run because:',
    '',
    ...problems.map((problem, index) => `  ${index + 1}. ${problem}`),
    '',
    'How to provision:',
    ...(spec && spec.howToProvision ? spec.howToProvision.map((line) => `  ${line}`) : ['  (see jest.e2e.config.cjs)']),
    '='.repeat(78),
    '',
  ];
  throw new Error(lines.join('\n'));
}

preflight();
