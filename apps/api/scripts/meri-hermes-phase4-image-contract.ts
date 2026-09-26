/**
 * Opt-in local contract test for the pinned Hermes worker image.
 *
 * Default invocation is inert. `--run` plus MERI_HERMES_PHASE4_IMAGE explicitly
 * opts into starting two disposable containers on a Docker internal network.
 * The test image must already exist; this script never builds or pulls images.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { MeriHermesRuntimeClient } from '../src/meri/hermes/meri-hermes-runtime.client.js';
import { createMeriDispatchRequestIdentityV2 } from '../src/meri/hermes/meri-hermes-dispatch-intent.contract.js';
import {
  mintMeriDispatchGateBearerV1,
  type MeriDispatchGateBearerKeyV1,
} from '../src/meri/hermes/meri-hermes-dispatch-gate-bearer.js';
import {
  matchesMeriHermesRecoveryNativeResponseV1,
  MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
  MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
  mintMeriHermesRecoveryCommandV1,
  verifyMeriHermesRecoveryCommandV1,
  verifyMeriHermesRecoveryReceiptV1,
  type MeriHermesRecoveryActionV1,
  type MeriHermesRecoveryCommandKeyV1,
  type MeriHermesRecoveryReceiptKeyV1,
} from '../src/meri/hermes/meri-hermes-dispatch-recovery.contract.js';
import type { MeriDispatchRequestIdentityV2 } from '../src/meri/hermes/meri-hermes-dispatch-intent.contract.js';
import {
  compileMeriHermesToolViewV1,
  type MeriHermesToolSchemaV1,
} from '../src/meri/hermes/meri-hermes-tool-view.js';

const LABEL = 'ai.capiro.phase4.contract-owner';
const PINNED_UPSTREAM_COMMIT = '7a963716b81be13ba513d4f127633b7da493aff2';
const TOOL_A = 'meri_request_clarification';
const TOOL_B = 'meri_fetch_attachment';
const CASE_A = 'PHASE4_CASE_A_7F2C';
const CASE_B = 'PHASE4_CASE_B_91D4';
const CASE_C = 'PHASE4_CASE_C_UNKNOWN_4A8E';
const CASE_D = 'PHASE4_CASE_D_REJECTED_2B6F';
const CASE_E = 'PHASE4_CASE_E_STOP_RACE_5C3A';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const CONVERSATION_ID = '33333333-3333-4333-8333-333333333333';
const SCOPE_ID = `tenant:${TENANT_ID}:user:${ACTOR_ID}`;
const SESSION_HEADER = `${SCOPE_ID}:conversation:${CONVERSATION_ID}:e3`;
const WORKER_AUDIENCE = 'meri-hermes-scope-worker';
const WORKER_INGRESS_ID = 'phase4-image-contract-ingress';
const WORKER_GENERATION = 'phase4-image-contract-generation-v1';
const WORKER_CREDENTIAL_ID = 'phase4-image-contract-credential-v1';
const TERMINAL = new Set(['completed', 'cancelled', 'failed', 'interrupted', 'expired']);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const execFileAsync = promisify(execFile);

interface FakeState {
  providerCalls: Array<{ marker: string; schemaNames: string[]; sequence: number }>;
  brokerCalls: Array<{ method: string; path: string }>;
  claimCalls: Array<{ marker: string; disposition: string; sequence: number }>;
  memoryCalls: Array<{ marker: string; path: string; sequence: number }>;
  events: Array<{ sequence: number; kind: string; marker: string }>;
  unexpectedNetworkCalls: Array<{ method: string; port: number; path: string }>;
}

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000 }).trim();
}

function dockerMustFail(args: string[], expected: string): void {
  const result = spawnSync('docker', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 20_000,
  });
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert(result.status !== 0 && output.includes(expected),
    `expected Docker failure containing ${expected}, got status=${String(result.status)}: ${output.slice(-500)}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inspectImage(image: string): Record<string, string> {
  const raw = docker(['image', 'inspect', image, '--format', '{{json .Config.Labels}}']);
  return JSON.parse(raw || '{}') as Record<string, string>;
}

/** Docker internal networks cannot publish ports. Execute HTTP from inside the
 * named container, so the worker and fake provider remain without host ingress
 * or external egress for the entire test. */
async function containerFetch(
  container: string,
  port: number,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const body = typeof init.body === 'string' ? init.body : null;
  assert(init.body === undefined || body !== null, 'bridge only accepts string request bodies');
  const headers = Object.fromEntries(new Headers(init.headers).entries());
  const payload = Buffer.from(JSON.stringify({
    url: `http://127.0.0.1:${port}${path}`,
    method: init.method ?? 'GET',
    headers,
    body,
  }), 'utf8').toString('base64url');
  const { stdout } = await execFileAsync(
    'docker', ['exec', container, 'python3', '/tmp/phase4_http_bridge.py', payload],
    { encoding: 'utf8', timeout: 25_000, maxBuffer: 1024 * 1024, signal: init.signal ?? undefined },
  );
  const response = JSON.parse(stdout) as { status: number; headers: Record<string, string>; bodyBase64: string };
  assert(Number.isInteger(response.status) && response.status >= 200 && response.status <= 599,
    'container HTTP bridge returned an invalid status');
  return new Response(Buffer.from(response.bodyBase64, 'base64'), {
    status: response.status,
    headers: response.headers,
  });
}

function cleanupOwned(kind: 'container' | 'network' | 'volume', name: string, owner: string): void {
  try {
    const format = kind === 'container'
      ? `{{index .Config.Labels "${LABEL}"}}`
      : `{{index .Labels "${LABEL}"}}`;
    const actualOwner = docker([kind, 'inspect', name, '--format', format]);
    if (actualOwner !== owner) throw new Error(`refusing to clean unowned ${kind} ${name}`);
    if (kind === 'container') docker(['rm', '-f', name]);
    else if (kind === 'network') docker(['network', 'rm', name]);
    else docker(['volume', 'rm', name]);
  } catch (error) {
    if (String(error).includes('No such')) return;
    throw error;
  }
}

function viewFor(tool: string, catalogTools: readonly MeriHermesToolSchemaV1[]) {
  const catalog = catalogTools.map((schema) => schema.function.name);
  return compileMeriHermesToolViewV1({
    catalogVersion: 'meri-tools.phase4-contract.v1',
    expectedCatalogVersion: 'meri-tools.phase4-contract.v1',
    meriCatalogDigest: 'e'.repeat(64), expectedMeriCatalogDigest: 'e'.repeat(64),
    capabilityMappingVersion: 'phase4-contract-map.v1',
    expectedCapabilityMappingVersion: 'phase4-contract-map.v1',
    capabilityMappingDigest: 'f'.repeat(64),
    expectedCapabilityMappingDigest: 'f'.repeat(64),
    catalogTools,
    deploymentToolNames: catalog,
    authorizedToolNames: [tool],
    availableToolNames: catalog,
    requiredToolNames: [tool],
    relevantToolNames: [],
    runLocalToolNames: [],
  });
}

async function waitForReady(client: MeriHermesRuntimeClient, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'not ready';
  while (Date.now() < deadline) {
    try {
      const capabilities = await client.capabilities();
      const feature = capabilities.features?.meri_request_local_tool_view_v1;
      assert((feature as { supported?: boolean } | undefined)?.supported === true,
        'worker image does not advertise request-local tool view v1; verify overlay image label');
      return;
    } catch (error) {
      lastError = String(error).slice(0, 200);
      await sleep(500);
    }
  }
  throw new Error(`worker readiness deadline exceeded (${lastError})`);
}

async function waitForTerminal(
  client: MeriHermesRuntimeClient,
  runId: string,
  deadline: number,
): Promise<Awaited<ReturnType<MeriHermesRuntimeClient['getRun']>>> {
  while (Date.now() < deadline) {
    const status = await client.getRun(runId);
    if (TERMINAL.has(status.status)) return status;
    if (status.status === 'approval_required' || status.status === 'requires_approval') {
      throw new Error(`synthetic run ${runId} unexpectedly requires approval`);
    }
    await sleep(400);
  }
  throw new Error(`run ${runId} did not reach a terminal state within the bounded deadline`);
}

async function fakeState(container: string): Promise<FakeState> {
  const response = await containerFetch(container, 8002, '/__phase4/state', { signal: AbortSignal.timeout(3000) });
  assert(response.ok, 'fake provider state endpoint was unavailable');
  return await response.json() as FakeState;
}

async function waitForClaim(container: string, marker: string, timeoutMs: number): Promise<FakeState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await fakeState(container);
    if (state.claimCalls.some((call) => call.marker === marker)) return state;
    await sleep(100);
  }
  throw new Error(`claim ${marker} did not begin within the bounded deadline`);
}

async function run(): Promise<void> {
  assert(process.argv.includes('--run') && process.env.MERI_HERMES_PHASE4_RUN === '1',
    'explicit opt-in required: pass --run and set MERI_HERMES_PHASE4_RUN=1');
  const image = process.env.MERI_HERMES_PHASE4_IMAGE?.trim();
  assert(image, 'set MERI_HERMES_PHASE4_IMAGE to an already-built local worker image');
  const labels = inspectImage(image);
  assert(labels['ai.capiro.hermes.upstream_commit'] === PINNED_UPSTREAM_COMMIT,
    'image is not based on the pinned Hermes v2026.9.14 commit');
  assert(labels['ai.capiro.meri.tool_view_v1_overlay'] === '1',
    'image does not prove MERI_HERMES_TOOL_VIEW_V1_OVERLAY=1; build a unique overlay-enabled image first');
  assert(labels['ai.capiro.meri.phase4_claim_v1_overlay'] === '1',
    'image does not prove the Phase 4 claim overlay is installed');
  assert(labels['ai.capiro.meri.phase4_recovery_v1_overlay'] === '1',
    'image does not prove the Phase 4 recovery overlay is installed');

  const owner = randomBytes(16).toString('hex');
  const prefix = `meri-phase4-${owner.slice(0, 10)}`;
  const network = `${prefix}-net`;
  const volume = `${prefix}-data`;
  const certVolume = `${prefix}-certs`;
  const fakeName = `${prefix}-fake`;
  const workerName = `${prefix}-worker`;
  const apiKey = randomBytes(32).toString('hex');
  const toolViewSigningKey = randomBytes(32).toString('hex');
  const claimServiceSecret = randomBytes(32).toString('hex');
  const dispatchBearerSecret = randomBytes(32);
  const attestationSecret = randomBytes(32);
  const recoveryCommandSecret = randomBytes(32);
  const recoveryReceiptSecret = randomBytes(32);
  const sessionHeaderHmacKey = randomBytes(32);
  const keyWindowStart = (BigInt(Date.now()) * 1000n - 60_000_000n).toString();
  const keyWindowEnd = (BigInt(Date.now()) * 1000n + 3_600_000_000n).toString();
  const dispatchBearerKey: MeriDispatchGateBearerKeyV1 = {
    secret: dispatchBearerSecret,
    notBeforeEpochMicros: keyWindowStart,
    notAfterEpochMicros: keyWindowEnd,
  };
  const recoveryCommandKey: MeriHermesRecoveryCommandKeyV1 = {
    purpose: MERI_HERMES_RECOVERY_COMMAND_PURPOSE,
    keyId: 'phase4-image-recovery-command-v1',
    tenantId: TENANT_ID,
    workerAudience: WORKER_AUDIENCE,
    workerIngressId: WORKER_INGRESS_ID,
    workerGeneration: WORKER_GENERATION,
    workerCredentialId: WORKER_CREDENTIAL_ID,
    secret: recoveryCommandSecret,
    notBeforeEpochMicros: keyWindowStart,
    notAfterEpochMicros: keyWindowEnd,
  };
  const recoveryReceiptKey: MeriHermesRecoveryReceiptKeyV1 = {
    purpose: MERI_HERMES_RECOVERY_RECEIPT_PURPOSE,
    keyId: 'phase4-image-recovery-receipt-v1',
    tenantId: TENANT_ID,
    workerAudience: WORKER_AUDIENCE,
    workerIngressId: WORKER_INGRESS_ID,
    workerGeneration: WORKER_GENERATION,
    workerCredentialId: WORKER_CREDENTIAL_ID,
    secret: recoveryReceiptSecret,
    notBeforeEpochMicros: keyWindowStart,
    notAfterEpochMicros: keyWindowEnd,
  };
  const createdRuns: string[] = [];
  let networkCreated = false;
  let volumeCreated = false;
  let certVolumeCreated = false;
  let fakeCreated = false;
  let workerCreated = false;
  let client: MeriHermesRuntimeClient | undefined;
  let successful = false;

  try {
    const labelsArg = ['--label', `${LABEL}=${owner}`];
    docker(['network', 'create', '--internal', ...labelsArg, network]);
    networkCreated = true;
    const networkInfo = JSON.parse(docker(['network', 'inspect', network]))[0] as { Internal?: boolean; Labels?: Record<string, string> };
    assert(networkInfo.Internal === true && networkInfo.Labels?.[LABEL] === owner,
      'created test network is not the expected isolated, owned Docker internal network');
    docker(['volume', 'create', ...labelsArg, volume]);
    volumeCreated = true;
    docker(['volume', 'create', ...labelsArg, certVolume]);
    certVolumeCreated = true;

    const reservationDeadline = '4102444800';
    const storeImport = 'from gateway.platforms.api_server_run_idempotency import RunIdempotencyStore';
    docker([
      'run', '--rm', '--mount', `type=volume,src=${volume},dst=/opt/data`,
      '--env', 'MERI_PHASE4_CLAIM_V1_ENABLED=1', '--entrypoint', 'python', image, '-c',
      `${storeImport};s=RunIdempotencyStore();o,r=s.reserve('phase4-image-scope','phase4-image-key','${'a'.repeat(64)}','run_phase4_image_restart',{'status':'queued'},retention_until=${reservationDeadline});assert o=='created' and r['retention_until']==${reservationDeadline};s.close()`,
    ]);
    docker([
      'run', '--rm', '--mount', `type=volume,src=${volume},dst=/opt/data`,
      '--env', 'MERI_PHASE4_CLAIM_V1_ENABLED=1', '--entrypoint', 'python', image, '-c',
      `${storeImport};s=RunIdempotencyStore();o,r=s.lookup('phase4-image-scope','phase4-image-key','${'a'.repeat(64)}',retention_until=${reservationDeadline});assert o=='reused' and r['run_id']=='run_phase4_image_restart' and r['retention_until']==${reservationDeadline};s.close()`,
    ]);
    docker([
      'run', '--rm', '--mount', `type=volume,src=${volume},dst=/opt/data`,
      '--entrypoint', 'chown', image, '-R', 'hermes:hermes', '/opt/data',
    ]);
    dockerMustFail([
      'run', '--rm', '--env', 'MERI_PHASE4_CLAIM_V1_ENABLED=1',
      '--entrypoint', 'python', image, '-c',
      `${storeImport};RunIdempotencyStore(':memory:')`,
    ], 'phase4_durable_idempotency_store_required');
    dockerMustFail([
      'run', '--rm', '--env', 'MERI_PHASE4_CLAIM_V1_ENABLED=1',
      '--env', 'HERMES_HOME=/proc/phase4-unwritable', '--entrypoint', 'python', image, '-c',
      `${storeImport};RunIdempotencyStore()`,
    ], 'phase4_durable_idempotency_store_unavailable');
    dockerMustFail([
      'run', '--rm', '--env', 'HERMES_HOME=/tmp/phase4-ephemeral',
      '--env', 'MERI_PHASE4_CLAIM_V1_ENABLED=1',
      '--env', 'MERI_HERMES_TOOL_VIEW_V1_ENABLED=1',
      '--env', 'MERI_HERMES_PROVIDER=custom',
      '--env', 'MERI_HERMES_CONTEXT_LENGTH=131072',
      '--entrypoint', '/opt/meri/entrypoint.sh', image,
    ], 'requires mounted HERMES_HOME=/opt/data');

    const fakeScript = resolve(__dirname, '../../../docker/hermes-worker/overlay/phase4_fake_services.py');
    const bridgeScript = resolve(__dirname, '../../../docker/hermes-worker/overlay/phase4_http_bridge.py');
    docker([
      'run', '-d', '--name', fakeName, '--network', network, '--network-alias', 'phase4-fakes',
      ...labelsArg,
      '--mount', `type=bind,source=${decodeURIComponent(fakeScript)},target=/tmp/phase4_fake_services.py,readonly`,
      '--mount', `type=bind,source=${decodeURIComponent(bridgeScript)},target=/tmp/phase4_http_bridge.py,readonly`,
      '--mount', `type=volume,src=${certVolume},dst=/tmp/phase4-certs`,
      '--env', `PHASE4_CLAIM_SERVICE_SECRET=${claimServiceSecret}`,
      '--env', `PHASE4_DISPATCH_BEARER_KEY_B64URL=${dispatchBearerSecret.toString('base64url')}`,
      '--env', `PHASE4_ATTESTATION_KEY_B64URL=${attestationSecret.toString('base64url')}`,
      '--env', `PHASE4_TENANT_ID=${TENANT_ID}`,
      '--env', `PHASE4_SCOPE_ID=${SCOPE_ID}`,
      '--env', `PHASE4_WORKER_AUDIENCE=${WORKER_AUDIENCE}`,
      '--env', `PHASE4_WORKER_INGRESS_ID=${WORKER_INGRESS_ID}`,
      '--env', `PHASE4_WORKER_GENERATION=${WORKER_GENERATION}`,
      '--env', `PHASE4_WORKER_CREDENTIAL_ID=${WORKER_CREDENTIAL_ID}`,
      '--entrypoint', 'python3', image, '/tmp/phase4_fake_services.py',
    ]);
    fakeCreated = true;
    const certDeadline = Date.now() + 15_000;
    while (Date.now() < certDeadline) {
      try {
        docker(['exec', fakeName, 'test', '-s', '/tmp/phase4-certs/server.crt']);
        break;
      } catch {
        await sleep(100);
      }
    }
    docker(['exec', fakeName, 'test', '-s', '/tmp/phase4-certs/server.crt']);

    docker([
      'run', '-d', '--name', workerName, '--network', network, ...labelsArg,
      '--mount', `type=volume,src=${volume},dst=/opt/data`,
      '--mount', `type=volume,src=${certVolume},dst=/tmp/phase4-certs,readonly`,
      '--mount', `type=bind,source=${decodeURIComponent(bridgeScript)},target=/tmp/phase4_http_bridge.py,readonly`,
      '--env', `API_SERVER_KEY=${apiKey}`,
      '--env', `MERI_HERMES_TOOL_VIEW_SIGNING_KEY=${toolViewSigningKey}`,
      '--env', 'MERI_HERMES_TOOL_VIEW_V1_ENABLED=1',
      '--env', 'MERI_PHASE4_CLAIM_V1_ENABLED=1',
      '--env', 'MERI_PHASE4_RECOVERY_V1_ENABLED=1',
      '--env', 'MERI_PHASE4_CLAIM_ORIGIN=https://phase4-fakes:8443',
      '--env', `MERI_PHASE4_CLAIM_SERVICE_SECRET=${claimServiceSecret}`,
      '--env', `MERI_PHASE4_CLAIM_ATTESTATION_KEY_B64URL=${attestationSecret.toString('base64url')}`,
      '--env', `MERI_PHASE4_CLAIM_ATTESTATION_KEY_NOT_BEFORE_EPOCH_MICROS=${keyWindowStart}`,
      '--env', `MERI_PHASE4_CLAIM_ATTESTATION_KEY_NOT_AFTER_EPOCH_MICROS=${keyWindowEnd}`,
      '--env', `MERI_PHASE4_TENANT_ID=${TENANT_ID}`,
      '--env', `MERI_PHASE4_SCOPE_ID=${SCOPE_ID}`,
      '--env', `MERI_PHASE4_WORKER_AUDIENCE=${WORKER_AUDIENCE}`,
      '--env', `MERI_PHASE4_WORKER_INGRESS_ID=${WORKER_INGRESS_ID}`,
      '--env', `MERI_PHASE4_WORKER_GENERATION=${WORKER_GENERATION}`,
      '--env', `MERI_PHASE4_WORKER_CREDENTIAL_ID=${WORKER_CREDENTIAL_ID}`,
      '--env', `MERI_PHASE4_RECOVERY_COMMAND_KEY_B64URL=${recoveryCommandSecret.toString('base64url')}`,
      '--env', `MERI_PHASE4_RECOVERY_COMMAND_KEY_ID=${recoveryCommandKey.keyId}`,
      '--env', `MERI_PHASE4_RECOVERY_COMMAND_KEY_NOT_BEFORE_EPOCH_MICROS=${keyWindowStart}`,
      '--env', `MERI_PHASE4_RECOVERY_COMMAND_KEY_NOT_AFTER_EPOCH_MICROS=${keyWindowEnd}`,
      '--env', `MERI_PHASE4_RECOVERY_RECEIPT_KEY_B64URL=${recoveryReceiptSecret.toString('base64url')}`,
      '--env', `MERI_PHASE4_RECOVERY_RECEIPT_KEY_ID=${recoveryReceiptKey.keyId}`,
      '--env', `MERI_PHASE4_RECOVERY_RECEIPT_KEY_NOT_BEFORE_EPOCH_MICROS=${keyWindowStart}`,
      '--env', `MERI_PHASE4_RECOVERY_RECEIPT_KEY_NOT_AFTER_EPOCH_MICROS=${keyWindowEnd}`,
      '--env', 'SSL_CERT_FILE=/tmp/phase4-certs/server.crt',
      '--env', 'MERI_BROKER_URL=http://phase4-fakes:8001',
      '--env', 'MERI_WORKER_TOKEN=phase4-dummy-worker-token',
      '--env', 'MERI_HERMES_PROVIDER=custom',
      '--env', 'MERI_HERMES_CONTEXT_LENGTH=131072',
      '--env', 'MERI_HERMES_BASE_URL=http://phase4-fakes:8000/v1',
      '--env', 'MERI_HERMES_MODEL=phase4-fake-model',
      '--env', 'MERI_MAX_CONCURRENT_RUNS=2',
      '--env', 'OPENAI_API_KEY=phase4-not-a-secret',
      '--env', 'MERI_EXECUTION_SCOPE_ID=phase4-local-synthetic',
      image,
    ]);
    workerCreated = true;
    const exactDispatches = new Map<string, {
      body: string;
      bearer: string;
      identity: Readonly<MeriDispatchRequestIdentityV2>;
    }>();
    const recoveryIdentities = new Map<string, Readonly<MeriDispatchRequestIdentityV2>>();
    const verifiedRecoveryReceipts: Array<{
      workerRunId: string;
      action: MeriHermesRecoveryActionV1;
      observation: string;
    }> = [];
    const workerFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      assert(url.origin === 'http://127.0.0.1:8642', 'worker client tried an unexpected origin');
      const headers = new Headers(init?.headers);
      let exactBody = typeof init?.body === 'string' ? init.body : undefined;
      let dispatchIdentity: Readonly<MeriDispatchRequestIdentityV2> | undefined;
      if ((init?.method ?? 'GET') === 'POST' && url.pathname === '/v1/runs') {
        const idempotencyKey = headers.get('idempotency-key');
        assert(idempotencyKey && exactBody, 'guarded run requires an exact body and idempotency key');
        const retained = exactDispatches.get(idempotencyKey);
        if (retained) {
          exactBody = retained.body;
          dispatchIdentity = retained.identity;
          headers.set('X-Meri-Dispatch-Gate-Bearer', retained.bearer);
        } else {
          const parsed = JSON.parse(exactBody) as {
            input?: unknown;
            meri_tool_view_v1?: { payload?: unknown };
          };
          const inputText = parsed.input;
          assert(typeof inputText === 'string', 'synthetic run input must be a string');
          const marker = [CASE_A, CASE_B, CASE_C, CASE_D, CASE_E]
            .find((candidate) => inputText.includes(candidate));
          assert(marker, 'synthetic run is missing its fixed case marker');
          const dispatchRunIds: Record<string, string> = {
            [CASE_A]: '55555555-5555-4555-8555-555555555555',
            [CASE_B]: '66666666-6666-4666-8666-666666666666',
            [CASE_C]: '77777777-7777-4777-8777-777777777777',
            [CASE_D]: '88888888-8888-4888-8888-888888888888',
            [CASE_E]: '99999999-9999-4999-8999-999999999999',
          };
          const messageIds: Record<string, string> = {
            [CASE_A]: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            [CASE_B]: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
            [CASE_C]: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
            [CASE_D]: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            [CASE_E]: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
          };
          const viewPayloadValue = parsed.meri_tool_view_v1?.payload;
          assert(typeof viewPayloadValue === 'string', 'synthetic run is missing its signed tool view');
          const viewPayload = JSON.parse(Buffer.from(viewPayloadValue, 'base64url').toString('utf8')) as {
            worker_catalog_sha256?: unknown;
            applied_tool_view_sha256?: unknown;
          };
          assert(typeof viewPayload.worker_catalog_sha256 === 'string' &&
            typeof viewPayload.applied_tool_view_sha256 === 'string',
          'signed tool view is missing its observed digests');
          const now = BigInt(Date.now()) * 1000n;
          const claimDeadline = now + 60_000_000n;
          const deliveryDeadline = now + 120_000_000n;
          const credentialDeadline = now + 120_000_000n;
          const reconciliationDeadline = credentialDeadline + 86_400_000_000n;
          const retainDeadline = reconciliationDeadline + 86_400_000_000n;
          const identity = createMeriDispatchRequestIdentityV2({
            metadata: {
              version: 2, tenantId: TENANT_ID, actorType: 'user', actorId: ACTOR_ID,
              meriAudience: 'private', clientId: null, workspaceId: null,
              scopeId: SCOPE_ID, conversationId: CONVERSATION_ID,
              userMessageId: messageIds[marker]!, runId: dispatchRunIds[marker]!,
              idempotencyKey, conversationEpoch: 3,
              workerAudience: WORKER_AUDIENCE, workerIngressId: WORKER_INGRESS_ID,
              workerGeneration: WORKER_GENERATION, workerCredentialId: WORKER_CREDENTIAL_ID,
              authorizationVersion: 'phase4-image-auth-v1',
              authorizationPolicyVersion: 'phase4-image-policy-v1',
              grantVersion: 'phase4-image-grant-v1',
              catalogDigest: viewPayload.worker_catalog_sha256,
              toolViewDigest: viewPayload.applied_tool_view_sha256,
              sessionHeaderKeyId: 'phase4-image-session-key-v1',
              claimNotAfterEpochMicros: claimDeadline.toString(),
              deliveryNotAfterEpochMicros: deliveryDeadline.toString(),
              workerCredentialNotAfterEpochMicros: credentialDeadline.toString(),
              reconciliationNotAfterEpochMicros: reconciliationDeadline.toString(),
              retainUntilEpochMicros: retainDeadline.toString(),
            },
            sourceMessage: {
              body: inputText,
              metadata: { runtime: 'phase4-image-contract' },
            },
            bodyBytes: Buffer.from(exactBody, 'utf8'),
            sessionKeyHeaderValue: SESSION_HEADER,
            sessionHeaderHmacKey,
          });
          const bearer = mintMeriDispatchGateBearerV1(
            identity, 'phase4-image-dispatch-key-v1', dispatchBearerKey,
            now.toString(), (now + 30_000_000n).toString(),
          );
          dispatchIdentity = identity;
          exactDispatches.set(idempotencyKey, { body: exactBody, bearer, identity });
          headers.set('X-Meri-Dispatch-Gate-Bearer', bearer);
        }
        headers.set('X-Hermes-Session-Key', SESSION_HEADER);
      }
      const recoveryMatch = /^\/v1\/runs\/([^/]+?)(\/stop)?$/.exec(url.pathname);
      let recovery: {
        workerRunId: string;
        action: MeriHermesRecoveryActionV1;
        identity: Readonly<MeriDispatchRequestIdentityV2>;
        commandToken: string;
      } | undefined;
      if (recoveryMatch) {
        const workerRunId = decodeURIComponent(recoveryMatch[1]!);
        const action: MeriHermesRecoveryActionV1 = recoveryMatch[2] ? 'stop' : 'status';
        const identity = recoveryIdentities.get(workerRunId);
        assert(identity, `recovery request is missing the immutable identity for ${workerRunId}`);
        const nativeBodyBytes = Buffer.from(exactBody ?? '', 'utf8');
        const nowEpochMicros = BigInt(Date.now()) * 1000n;
        const commandToken = mintMeriHermesRecoveryCommandV1({
          identity,
          workerRunId,
          action,
          operationId: randomUUID(),
          attemptNonce: randomBytes(16).toString('base64url'),
          nativeBodyBytes,
          notBeforeEpochMicros: (nowEpochMicros - 5_000_000n).toString(),
          notAfterEpochMicros: (nowEpochMicros + 30_000_000n).toString(),
        }, recoveryCommandKey);
        headers.set('X-Meri-Dispatch-Recovery-Command', commandToken);
        recovery = { workerRunId, action, identity, commandToken };
      }
      const response = await containerFetch(workerName, 8642, `${url.pathname}${url.search}`, {
        ...init, headers, body: exactBody,
      });
      if (dispatchIdentity && response.ok) {
        const accepted = await response.clone().json() as { run_id?: unknown };
        assert(typeof accepted.run_id === 'string' && accepted.run_id,
          'native run acceptance omitted its worker run id');
        recoveryIdentities.set(accepted.run_id, dispatchIdentity);
      }
      if (recovery) {
        const receiptToken = response.headers.get('x-meri-dispatch-recovery-receipt');
        assert(receiptToken, `worker omitted the ${recovery.action} recovery receipt`);
        const nativeResponseBodyBytes = Buffer.from(await response.clone().arrayBuffer());
        const verifyAt = (BigInt(Date.now()) * 1000n).toString();
        const command = verifyMeriHermesRecoveryCommandV1(
          recovery.commandToken, recovery.identity, recovery.workerRunId,
          recoveryCommandKey, verifyAt,
        );
        assert(command, 'locally minted recovery command did not verify');
        const receipt = verifyMeriHermesRecoveryReceiptV1(
          receiptToken, recovery.commandToken, recovery.identity, recovery.workerRunId,
          recoveryCommandKey, recoveryReceiptKey, verifyAt,
        );
        assert(receipt && matchesMeriHermesRecoveryNativeResponseV1(
          receipt, response.status, nativeResponseBodyBytes,
        ), `worker returned an invalid ${recovery.action} recovery receipt`);
        verifiedRecoveryReceipts.push({
          workerRunId: recovery.workerRunId,
          action: recovery.action,
          observation: receipt.observation,
        });
      }
      return response;
    };
    client = MeriHermesRuntimeClient.withEnv({
      MERI_HERMES_RUNTIME_URL: 'http://127.0.0.1:8642',
      MERI_HERMES_API_KEY: apiKey,
      MERI_HERMES_TOOL_VIEW_SIGNING_KEY: toolViewSigningKey,
      MERI_HERMES_TOOL_VIEW_V1_CLIENT_ENABLED: '1',
      MERI_HERMES_REQUEST_TIMEOUT_MS: '20000',
    }, workerFetch);
    await waitForReady(client, 90_000);
    const capabilities = await client.capabilities();
    const recoveryCapability = capabilities.features?.meri_phase4_recovery_v1 as {
      supported?: unknown;
      version?: unknown;
    } | undefined;
    assert(recoveryCapability?.supported === true && recoveryCapability.version === 1,
      'worker image does not advertise enabled Phase 4 recovery v1');
    const catalogTools = (capabilities.features?.meri_request_local_tool_view_v1 as {
      worker_catalog_schemas?: unknown;
    } | undefined)?.worker_catalog_schemas;
    assert(Array.isArray(catalogTools),
      'worker capability does not expose the exact raw catalog schemas');

    // Distinct stateless runs are submitted together. The fake provider has a
    // first-turn barrier, so neither provider response is released until both
    // signed /v1/runs requests are executing concurrently.
    const submissions = await Promise.allSettled([
      client.createRunWithToolView({
        input: `Synthetic isolated run ${CASE_A}`, idempotencyKey: `${owner}-${CASE_A}`,
        sessionKey: SESSION_HEADER,
      }, viewFor(TOOL_A, catalogTools as MeriHermesToolSchemaV1[])),
      client.createRunWithToolView({
        input: `Synthetic isolated run ${CASE_B}`, idempotencyKey: `${owner}-${CASE_B}`,
        sessionKey: SESSION_HEADER,
      }, viewFor(TOOL_B, catalogTools as MeriHermesToolSchemaV1[])),
    ]);
    for (const submission of submissions) {
      if (submission.status === 'fulfilled') createdRuns.push(submission.value.runId);
    }
    const rejectedSubmission = submissions.find((submission) => submission.status === 'rejected');
    if (rejectedSubmission?.status === 'rejected') throw rejectedSubmission.reason;
    const [aResult, bResult] = submissions;
    assert(aResult.status === 'fulfilled' && bResult.status === 'fulfilled', 'both synthetic runs must be accepted');
    const a = aResult.value;
    const b = bResult.value;
    assert(a.runId !== b.runId, 'concurrent synthetic runs unexpectedly shared a run id');
    const deadline = Date.now() + 60_000;
    const statuses = await Promise.all([
      waitForTerminal(client, a.runId, deadline),
      waitForTerminal(client, b.runId, deadline),
    ]);
    const state = await fakeState(fakeName);
    assert(statuses.every((status) => status.status === 'completed'),
      `expected both fake runs to complete; observed ${statuses.map((status) => `${status.status}:${(status.error ?? '').slice(0, 220)}`).join(', ')}; ` +
      `fake provider calls=${JSON.stringify(state.providerCalls)} broker calls=${JSON.stringify(state.brokerCalls)}`);
    for (const [marker, expectedTool] of [[CASE_A, TOOL_A], [CASE_B, TOOL_B]] as const) {
      const calls = state.providerCalls.filter((call) => call.marker === marker);
      const claims = state.claimCalls.filter((call) => call.marker === marker);
      assert(claims.length === 1 && claims[0]!.disposition === 'transitioned',
        `${marker} did not make exactly one transitioned claim`);
      assert(calls.length >= 2, `${marker} did not exercise an allowed and a denied tool-call turn`);
      assert(calls.every((call) => claims[0]!.sequence < call.sequence),
        `${marker} reached the provider before its claim transitioned`);
      assert(state.memoryCalls.filter((call) => call.marker === marker)
        .every((call) => claims[0]!.sequence < call.sequence),
      `${marker} reached institutional memory before its claim transitioned`);
      assert(calls.every((call) => call.schemaNames.length === 1 && call.schemaNames[0] === expectedTool),
        `${marker} provider-visible schemas were not exactly its disjoint tool view`);
    }
    const brokerCounts = new Map<string, number>();
    for (const call of state.brokerCalls) brokerCounts.set(`${call.method} ${call.path}`, (brokerCounts.get(`${call.method} ${call.path}`) ?? 0) + 1);
    assert(brokerCounts.get('POST /clarifications') === 1, 'allowed clarification tool did not reach only the fake broker once');
    assert(brokerCounts.get('GET /attachments/phase4-synthetic-attachment') === 1,
      'allowed attachment tool did not reach only the fake broker once');
    assert(!brokerCounts.has('GET /attachments/phase4-cross-view-denial'),
      'run A invoked the other run’s attachment tool outside its view');
    assert(!brokerCounts.has('POST /clarifications') || brokerCounts.get('POST /clarifications') === 1,
      'run B invoked clarification outside its view');
    assert(state.brokerCalls.length === 2, 'unexpected broker side effect occurred');

    const beforeRepeatedStatus = await fakeState(fakeName);
    await client.getRun(a.runId);
    await client.getRun(a.runId);
    const afterRepeatedStatus = await fakeState(fakeName);
    assert(afterRepeatedStatus.providerCalls.length === beforeRepeatedStatus.providerCalls.length &&
      afterRepeatedStatus.brokerCalls.length === beforeRepeatedStatus.brokerCalls.length,
    'repeated signed status observations produced a provider or broker effect');
    assert(verifiedRecoveryReceipts.filter((receipt) =>
      receipt.workerRunId === a.runId && receipt.action === 'status').length >= 2,
    'repeated native status observations were not authenticated by recovery receipts');

    for (const [name, override] of [
      ['provider', { provider: 'lmstudio' }],
      ['model', { model: 'phase4-untrusted-route-alias' }],
      ['model_options', { modelOptions: { service_tier: 'priority' } }],
    ] as const) {
      let rejected = false;
      try {
        await client.createRunWithToolView({
          input: `Synthetic runtime override ${CASE_C}`, sessionKey: SESSION_HEADER,
          idempotencyKey: `${owner}-runtime-override-${name}`, ...override,
        }, viewFor(TOOL_A, catalogTools as MeriHermesToolSchemaV1[]));
      } catch (error) {
        rejected = true;
        assert((error as { status?: unknown }).status === 400 &&
          (error as { code?: unknown }).code === 'noncanonical_phase4_runtime_selection',
        `guarded ${name} override did not return the exact fail-closed error`);
      }
      assert(rejected, `guarded ${name} override was accepted`);
    }
    const overrideState = await fakeState(fakeName);
    assert(overrideState.claimCalls.every((call) => call.marker !== CASE_C),
      'a rejected runtime override reached the claim service');
    assert(overrideState.unexpectedNetworkCalls.length === 0,
      `a rejected runtime override triggered constructor/provider network I/O: ${JSON.stringify(overrideState.unexpectedNetworkCalls)}`);

    for (const [marker, expectedDisposition, tool] of [
      [CASE_C, 'UNKNOWN', TOOL_A], [CASE_D, 'rejected', TOOL_B],
    ] as const) {
      const idempotencyKey = `${owner}-${marker}`;
      const view = viewFor(tool, catalogTools as MeriHermesToolSchemaV1[]);
      const first = await client.createRunWithToolView({
        input: `Synthetic denied run ${marker}`, idempotencyKey, sessionKey: SESSION_HEADER,
      }, view);
      createdRuns.push(first.runId);
      const deniedStatus = await waitForTerminal(client, first.runId, Date.now() + 30_000);
      assert(deniedStatus.status === 'failed',
        `${marker} did not fail closed after ${expectedDisposition}`);
      const replay = await client.createRunWithToolView({
        input: `Synthetic denied run ${marker}`, idempotencyKey, sessionKey: SESSION_HEADER,
      }, view);
      assert(replay.runId === first.runId,
        `${marker} exact retry did not resolve to the retained native run`);
      const deniedState = await fakeState(fakeName);
      const claims = deniedState.claimCalls.filter((call) => call.marker === marker);
      assert(claims.length === 1 && claims[0]!.disposition === expectedDisposition,
        `${marker} claim was retried or returned the wrong disposition`);
      assert(deniedState.providerCalls.every((call) => call.marker !== marker),
        `${marker} reached the provider after a non-transition claim`);
    }

    const stopView = viewFor(TOOL_A, catalogTools as MeriHermesToolSchemaV1[]);
    const stopped = await client.createRunWithToolView({
      input: `Synthetic stop race ${CASE_E}`, idempotencyKey: `${owner}-${CASE_E}`,
      sessionKey: SESSION_HEADER,
    }, stopView);
    createdRuns.push(stopped.runId);
    await waitForClaim(fakeName, CASE_E, 10_000);
    await client.stopRun(stopped.runId);
    await client.stopRun(stopped.runId);
    const stoppedStatus = await waitForTerminal(client, stopped.runId, Date.now() + 30_000);
    assert(stoppedStatus.status === 'cancelled',
      `Stop during the claim wait did not cancel the run (${stoppedStatus.status})`);
    const finalState = await fakeState(fakeName);
    assert(finalState.claimCalls.filter((call) => call.marker === CASE_E).length === 1,
      'Stop-race run did not make exactly one delayed claim');
    assert(finalState.providerCalls.every((call) =>
      call.marker !== CASE_C && call.marker !== CASE_D && call.marker !== CASE_E),
    'denied or stopped run reached the provider');
    assert(finalState.memoryCalls.every((call) =>
      call.marker !== CASE_C && call.marker !== CASE_D && call.marker !== CASE_E),
    'denied or stopped run reached institutional memory');
    assert(finalState.brokerCalls.length === 2,
      'denied or stopped run produced an unexpected broker effect');
    assert(verifiedRecoveryReceipts.filter((receipt) =>
      receipt.workerRunId === stopped.runId && receipt.action === 'stop').length === 2,
    'repeated native Stop requests were not authenticated by recovery receipts');
    assert(finalState.unexpectedNetworkCalls.length === 0,
      `agent construction or runtime used an unexpected pre-claim network path: ${JSON.stringify(finalState.unexpectedNetworkCalls)}`);
    successful = true;
    console.log('PASS: transitioned claims preceded concurrent provider calls; recovery-signed status/Stop observations were exact and replay-safe; UNKNOWN/rejected claims and Stop-during-claim produced zero provider/broker effects and no claim retry.');
  } finally {
    if (!successful && workerCreated) {
      const logs = spawnSync('docker', ['logs', '--tail', '400', workerName], {
        encoding: 'utf8', timeout: 5_000, maxBuffer: 512 * 1024,
      });
      const diagnostic = `${logs.stdout ?? ''}\n${logs.stderr ?? ''}`.split(/\r?\n/)
        .filter((line) => /plugin|meri_tools|meri_fetch|meri_request|loaded.*tools|tool view|error|config-migrate/i.test(line))
        .slice(-12).map((line) => line.slice(0, 240));
      if (diagnostic.length) console.error(`synthetic worker diagnostic: ${JSON.stringify(diagnostic)}`);
    }
    if (!successful && client) {
      await Promise.all(createdRuns.map(async (runId) => {
        try { await client!.stopRun(runId); } catch { /* cleanup continues */ }
      }));
    }
    const cleanupErrors: string[] = [];
    for (const [kind, name, created] of [
      ['container', workerName, workerCreated],
      ['container', fakeName, fakeCreated],
      ['volume', volume, volumeCreated],
      ['volume', certVolume, certVolumeCreated],
      ['network', network, networkCreated],
    ] as const) {
      if (!created) continue;
      try { cleanupOwned(kind, name, owner); }
      catch { cleanupErrors.push(`${kind} ${name}`); }
    }
    if (cleanupErrors.length) throw new Error(`could not clean up owned Phase 4 resources: ${cleanupErrors.join(', ')}`);
  }
}

if (process.argv.includes('--run')) {
  run().catch((error: unknown) => {
    console.error(`FAIL: ${error instanceof Error ? error.message : 'Phase 4 local contract harness failed'}`);
    process.exitCode = 1;
  });
} else {
  console.log('No action. For the local fake-provider contract test, see the Phase 4 commands in docs/meri/hermes/phase-4-tool-view-v1.md.');
}
