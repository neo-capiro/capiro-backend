import https from 'node:https';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { dirname, parse, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  inspectControlledReadAdmission,
  inspectControlledReadScope,
} from './controlled-read-live-capture.mjs';
import { nativeMeriCaptureHeaders } from './lib/native-http.mjs';
import { sha256Stable } from './artifact-collector.mjs';

// One reviewed pre-submission failure only. This is not a general retry API.
const base = 'C:/dev/main/outputs/meri-c2-20261003';
const run = 'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b';
const conversationId = 'db0e01ac-60a1-4e3c-b8ba-66748d087a2e';
const reservationId = '7ea73cdc-526e-4b31-8c28-b0636ea8d2ae';
const priorRoot = `${base}/case20-native-${run}`;
const recoveryClaimPath = `${base}/case20-presubmission-recovery-claim-${run}.json`;
const originalClaimPath = `C:/dev/cap-meri-foundation-evidence/controlled-read-claims/20-${run}.json`;
const apiSha = '4f0253874357c272fda1ae2a5271ee4af645f0bc';
const currentVerifySha256 = '925c4735e4d435ab06c40b31ee590b0ce4e7d9220b742155c67e4115b1bc6516';
const qualificationSha256 = '47d64a19fdf3a718eddefee998247173f98f9b1d3f24703f31d8b4dee779c9af';
const journalSha256 = 'd6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b';
const authorities = new WeakMap();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code) =>
  Object.assign(new Error(`CASE20_PRESUBMISSION_RECOVERY_${code}`), {
    code: `CASE20_PRESUBMISSION_RECOVERY_${code}`,
  });
const need = (condition, code) => {
  if (!condition) throw error(code);
};
const originalRunnerPath =
  'C:/dev/main/outputs/meri-c2-20261003/controlled-read-execution-intent-v1/source/evals/meri/live-v1/run-controlled-read.mjs';
const pins = Object.freeze({
  'C:/dev/main/outputs/meri-c2-20261003/case20-native-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b/execution.json':
    'e210847d83b7b4998d0e0cc57b51bc7d93b290ab6b5bcddcd5ee9f24fdc1f2c7',
  'C:/dev/main/outputs/meri-c2-20261003/case20-native-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b/execution.json.events.jsonl':
    '7675b0e47b1faa78bb288e8f4eeb463da72a64153ed792ef388beecae078c2f5',
  'C:/dev/main/outputs/meri-c2-20261003/case20-native-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b/actual-capture-scope.json':
    '1eb14db7d3b74cc7594366e2695542ef1d280cc6940a79348a8f1bf215ab2496',
  'C:/dev/main/outputs/meri-c2-20261003/case20-native-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b/aggregate-reserved-checkpoint.json':
    'bc3a5a601507ad987c637cfe7b9da08a9fbaae576548977ca989158481c052a7',
  'C:/dev/cap-meri-foundation-evidence/controlled-read-claims/20-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b.json':
    '3a7c2bfe69f17785e74752d7c0ba64753d91818bd6965fdfdf192f59896478f3',
  'C:/dev/main/outputs/meri-c2-20261003/case20-browser-readiness-diagnostic-v1.json':
    'ba3d94226245e8d6c84e3e42ed6434dc9ec398fb6478bb8ae87a5f86426786c2',
  'C:/dev/main/outputs/meri-c2-20261003/controlled-read-execution-intent-v1/source/evals/meri/live-v1/run-controlled-read.mjs':
    'd8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83',
  'C:/dev/main/outputs/meri-c2-20261003/launch-case20-controlled-read-v1-once.mjs':
    'd8c09bc7bd943fbb010533011daac5cfd00047243c7afb09688d87aa27e1015e',
  'C:/dev/main/outputs/meri-c2-20261003/case20-live-scope-v1.json':
    'ff11e6de4f6f89ed4314dda96a11bec7ccf724dc35d0520fdbefe33155266e0c',
  'C:/dev/main/outputs/meri-c2-20261003/case20-native-setup-execute-v1/inner-owner-receipt.json':
    '9ac732d7a5d4b066cea584804218f2f68083a445c016092b4f72d8f8a92f2cfd',
  'C:/dev/main/outputs/meri-c2-20261003/case20-native-budget-install-v1/inner-owner-receipt.json':
    '35b2f3342781c9352fce0daed5ad502087b776b336d6203af592e5fd4cb0b3c0',
  'C:/dev/main/outputs/meri-c2-20261003/reviewed-rates-c2-v2-20261003.json':
    '3531e09dfcce9f66b4ea2b3564db47bd72dc507cdcf1aecdda277b838007704e',
  'C:/dev/main/meri-c1-20261002/evals/meri/live-v1/controlled-read-live-capture.mjs':
    'e22e8d6022053a685276468710bb8521ae516ac21b7fabf995cc60b07e04ca63',
  'C:/dev/main/meri-c1-20261002/evals/meri/live-v1/windows-artifact-storage.mjs':
    '8b03eeccad53a92fc4cf7bcf4976522ecf7ed2126591449e28a6a70948ac01c4',
  'C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl':
    'd6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b',
  'C:/dev/main/outputs/meri-fresh-20261003/run-authorization.json':
    'e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe',
});

function identity(stat) {
  return [stat.dev, stat.ino, stat.birthtimeNs].map(String).join(':');
}
function directoryChain(path) {
  const absolute = resolve(path),
    root = parse(absolute).root;
  const paths = [];
  for (let next = dirname(absolute); ; next = dirname(next)) {
    paths.unshift(next);
    if (next === root) break;
  }
  return paths.map((next) => {
    const stat = lstatSync(next, { bigint: true });
    need(stat.isDirectory() && !stat.isSymbolicLink(), 'DIRECTORY_CHANGED');
    need(realpathSync(next).toLowerCase() === resolve(next).toLowerCase(), 'DIRECTORY_REDIRECTED');
    return [next, identity(stat)];
  });
}
function readStableFile(path) {
  const chain = directoryChain(path),
    initial = lstatSync(path, { bigint: true });
  need(
    initial.isFile() &&
      !initial.isSymbolicLink() &&
      initial.nlink === 1n &&
      initial.size <= 2_000_000n,
    'FILE_UNSAFE',
  );
  const fd = openSync(path, 'r');
  try {
    const before = fstatSync(fd, { bigint: true });
    need(identity(before) === identity(initial), 'FILE_REPLACED');
    const bytes = readFileSync(fd),
      after = fstatSync(fd, { bigint: true });
    need(
      identity(after) === identity(before) &&
        after.size === before.size &&
        after.mtimeNs === before.mtimeNs,
      'FILE_CHANGED',
    );
    need(
      identity(lstatSync(path, { bigint: true })) === identity(before) &&
        isDeepStrictEqual(chain, directoryChain(path)),
      'PATH_CHANGED',
    );
    return {
      bytes,
      descriptor: {
        identity: identity(after),
        sha256: hash(bytes),
        bytes: bytes.length,
        directories: chain,
      },
    };
  } finally {
    closeSync(fd);
  }
}

// Extracted by filesystem tests on disposable paths. It cannot mint authority.
function writeExclusiveRecoveryClaim(path, value) {
  const chain = directoryChain(path),
    bytes = Buffer.from(`${JSON.stringify(value)}\n`);
  const fd = openSync(path, 'wx', 0o600);
  let descriptor;
  try {
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    descriptor = {
      identity: identity(fstatSync(fd, { bigint: true })),
      sha256: hash(bytes),
      bytes: bytes.length,
      directories: chain,
    };
  } finally {
    closeSync(fd);
  }
  need(
    isDeepStrictEqual(readStableFile(path).descriptor, descriptor),
    'CLAIM_PERSISTENCE_UNCONFIRMED',
  );
  return descriptor;
}

/** Pure checks only. A successful result never creates a recovery capability. */
export function inspectCase20PresubmissionRecoveryEvidence({
  execution,
  history,
  scope,
  checkpoint,
  claim,
  diagnostic,
}) {
  need(
    execution?.verdict === 'BLOCKED' &&
      execution.failureCode === 'CONTROLLED_READ_OPERATOR_FAILED' &&
      execution.executionAttempted === false &&
      execution.sessionCreated === true &&
      execution.sessionRevoked === true &&
      execution.sessionCleanupUnconfirmed === undefined &&
      execution.submissionObservation?.turnsSent === 0 &&
      execution.submissionObservation.turnsSentStatus === 'NOT_ATTEMPTED' &&
      execution.conversationReadback?.status === 'EMPTY_OWNED_CONVERSATION_CREATED' &&
      execution.capturePrepared === undefined &&
      execution.executionIntent === undefined &&
      execution.outcome === undefined &&
      Number.isFinite(Date.parse(execution.completedAt)),
    'PRIOR_EXECUTION_UNPROVED',
  );
  need(
    Array.isArray(history) &&
      history.length === 6 &&
      isDeepStrictEqual(history.at(-1).summary, execution),
    'HISTORY_UNPROVED',
  );
  for (const [index, event] of history.entries()) {
    need(
      isDeepStrictEqual(Object.keys(event).sort(), ['at', 'summary']) &&
        Number.isFinite(Date.parse(event.at)) &&
        (index === 0 || Date.parse(event.at) >= Date.parse(history[index - 1].at)) &&
        event.summary?.executionAttempted === false &&
        event.summary.executionIntent === undefined &&
        event.summary.capturePrepared === undefined &&
        event.summary.outcome === undefined &&
        event.summary.browserApplicationWrites === 0,
      'PRIOR_SUBMISSION_POSSIBLE',
    );
  }
  need(
    execution.caseId === '20' &&
      execution.captureRunId === run &&
      execution.conversationId === conversationId &&
      execution.sourceSha === apiSha &&
      execution.scriptSha256 === pins[originalRunnerPath] &&
      scope.captureRunId === run &&
      scope.conversationId === conversationId &&
      scope.deployment?.apiSha === apiSha &&
      scope.deployment.orchestratorSha === '4f0253874357c272fda1ae2a5271ee4af645f0bc',
    'ORIGINAL_SCOPE_CHANGED',
  );
  need(
    claim?.kind === 'meri-controlled-read-one-shot-claim' &&
      claim.captureRunId === run &&
      claim.caseId === '20' &&
      claim.operatorSourceSha === 'af7aa8aff4777a2d4809e882c2b797fbb2cd51a2' &&
      resolve(claim.outRoot) === resolve(priorRoot),
    'ORIGINAL_CLAIM_CHANGED',
  );
  const key = `20:${run}`,
    row = checkpoint?.snapshot?.runs?.[key];
  need(
    checkpoint?.kind === 'meri-fresh-capture-spend-checkpoint' &&
      checkpoint.version === 1 &&
      checkpoint.state?.freshVersion === 1 &&
      resolve(checkpoint.state.root) === resolve('C:/dev/main/outputs/meri-fresh-20261003') &&
      checkpoint.state.files?.['fresh-spend.jsonl']?.sha256 === journalSha256 &&
      checkpoint.snapshot.eventCount === 23 &&
      checkpoint.snapshot.activeRun === key &&
      row?.event === 'reserved' &&
      row.reservationId === reservationId &&
      row.ceilingMicros === 15_000_000 &&
      row.sequence === 23 &&
      row.nativeCaptureVersion === 1 &&
      row.chargedCostMicros === undefined &&
      checkpoint.snapshot.protocolVersion === 3 &&
      checkpoint.snapshot.olderCosts === 'UNRESOLVED_SEPARATE_NOT_REPLACED' &&
      checkpoint.snapshot.knownSettledCostMicros === 12_133_883 &&
      checkpoint.snapshot.committedCostMicros === 27_133_883 &&
      checkpoint.snapshot.remainingReservationMicros === 2_866_117,
    'RESERVATION_CHANGED',
  );
  need(
    diagnostic?.status === 'READ_ONLY_BROWSER_DIAGNOSTIC_COMPLETE' &&
      diagnostic.failedExecutionSha256 === pins[`${priorRoot}/execution.json`] &&
      diagnostic.journalSha256 === journalSha256 &&
      diagnostic.journalUnchanged === true &&
      diagnostic.journalMutations === 0 &&
      diagnostic.conversationId === conversationId &&
      diagnostic.blockedRequests?.length === 0 &&
      diagnostic.sessionRevoked === true &&
      diagnostic.applicationWrites === 0 &&
      diagnostic.providerCalls === 0 &&
      diagnostic.captureEntryCalls === 0 &&
      diagnostic.immediateAfterNavigation?.loaded === false &&
      diagnostic.immediateAfterNavigation.errorClass === 'TypeError' &&
      diagnostic.afterReadinessWait?.tokenAvailable === true &&
      diagnostic.afterReadinessWait.loaded === true &&
      diagnostic.afterReadinessWait.sessionPresent === true,
    'DIAGNOSIS_UNPROVED',
  );
  return {
    caseId: '20',
    captureRunId: run,
    conversationId,
    reservationId,
    ceilingMicros: 15_000_000,
    captureAuthority: false,
  };
}

function localEvidence(previousDescriptors) {
  const files = new Map(),
    descriptors = {};
  for (const [path, expected] of Object.entries(pins)) {
    const actual = readStableFile(path);
    need(actual.descriptor.sha256 === expected, 'PINNED_BYTES_CHANGED');
    if (previousDescriptors)
      need(
        isDeepStrictEqual(actual.descriptor, previousDescriptors[path]),
        'PINNED_IDENTITY_CHANGED',
      );
    files.set(path, actual.bytes);
    descriptors[path] = actual.descriptor;
  }
  need(!existsSync(`${priorRoot}/artifacts`), 'PRIOR_ARTIFACTS_EXIST');
  const json = (path) => JSON.parse(files.get(path).toString('utf8'));
  const input = {
    execution: json(`${priorRoot}/execution.json`),
    history: files
      .get(`${priorRoot}/execution.json.events.jsonl`)
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line)),
    scope: json(`${priorRoot}/actual-capture-scope.json`),
    checkpoint: json(`${priorRoot}/aggregate-reserved-checkpoint.json`),
    claim: json(originalClaimPath),
    diagnostic: json(`${base}/case20-browser-readiness-diagnostic-v1.json`),
  };
  inspectCase20PresubmissionRecoveryEvidence(input);
  const rates = json(`${base}/reviewed-rates-c2-v2-20261003.json`);
  if (!previousDescriptors)
    need(Date.parse(rates.expiresAt) > Date.now() + 15 * 60_000, 'RATES_TOO_OLD');
  return { ...input, descriptors };
}

/** Pure validation of response bodies. Only acquisition below performs/authenticates GETs. */
export function inspectCase20PresubmissionRecoveryReadback({
  config,
  me,
  status,
  conversation,
  messages,
  now = Date.now(),
}) {
  const scope = inspectControlledReadScope(config, {
    MERI_LIVE_BEARER_TOKEN: 'pure-inspection-no-live-authority',
  });
  need(
    scope.expected.captureRunId === run &&
      scope.expected.conversationId === conversationId &&
      scope.expected.apiSha === apiSha &&
      scope.expected.tenantId === 'f2d6cf8f-057c-479a-8110-62fe5086d43f' &&
      scope.expected.actorUserId === 'b1f758fc-17bd-40f8-bef2-fa2d2380300f' &&
      scope.expected.clientId === '41f9ec63-3963-479f-b747-59a3767ef44b' &&
      scope.expected.maxSpendMicros === 15_000_000,
    'RECOVERY_SCOPE_CHANGED',
  );
  need(
    conversation?.id === conversationId &&
      conversation.tenantId === scope.expected.tenantId &&
      conversation.userId === scope.expected.actorUserId &&
      conversation.clientId === scope.expected.clientId &&
      conversation.archivedAt === null &&
      conversation.title === `meri-foundation-20260928 case20 ${run}`,
    'CURRENT_CONVERSATION_CHANGED',
  );
  need(Array.isArray(messages) && messages.length === 0, 'CURRENT_MESSAGES_EXIST');
  // Original creation supplies exactly these ordinary keys. Even a null-valued
  // admission/budget key or an unknown mode is ambiguous and must refuse.
  need(
    record(conversation.metadata) &&
      isDeepStrictEqual(Object.keys(conversation.metadata).sort(), [
        'brand',
        'runtime',
        'userEmail',
      ]) &&
      Object.values(conversation.metadata).every(
        (value) => typeof value === 'string' && value.length > 0,
      ),
    'DURABLE_METADATA_NOT_PRISTINE',
  );
  const admission = inspectControlledReadAdmission({
    scope,
    me,
    status,
    conversation,
    admission: conversation.captureAdmission,
    apiReleaseSha: apiSha,
    now,
  });
  need(
    admission.fixture.currentVerifySha256 === currentVerifySha256 &&
      admission.providerBudget.qualificationSha256 === qualificationSha256 &&
      admission.issuedAt >= now - 30_000 &&
      admission.expiresAt > now + 5_000,
    'READINESS_CHANGED',
  );
  return {
    expected: scope.expected,
    admissionExpiresAt: admission.expiresAt,
    currentVerifySha256,
    qualificationSha256,
    captureAuthority: false,
  };
}

function ownedGet(path, bearer) {
  const paths = [
    '/api/me',
    '/api/clio/status',
    `/api/clio/conversations/${conversationId}`,
    `/api/clio/conversations/${conversationId}/messages`,
  ];
  need(paths.includes(path), 'HTTP_PATH_FORBIDDEN');
  const headers = nativeMeriCaptureHeaders(bearer, 'meri-foundation-20260928-t1');
  return new Promise((resolveResult, reject) => {
    let finished = false;
    const fail = () => {
      if (!finished) {
        finished = true;
        reject(error('HTTPS_READ_FAILED'));
      }
    };
    const req = https.request(
      new URL(path, 'https://os.capiro.ai'),
      {
        method: 'GET',
        rejectUnauthorized: true,
        agent: false,
        headers: { ...headers, accept: 'application/json' },
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1_000_000) {
            req.destroy();
            fail();
          } else chunks.push(chunk);
        });
        response.on('error', fail);
        response.on('end', () => {
          if (finished) return;
          try {
            need(
              response.statusCode === 200 &&
                response.headers['x-capiro-release-sha'] === apiSha &&
                /^application\/json(?:;|$)/iu.test(response.headers['content-type'] ?? ''),
              'HTTP_RESPONSE_UNPROVED',
            );
            const bytes = Buffer.concat(chunks),
              value = JSON.parse(bytes.toString('utf8'));
            finished = true;
            resolveResult({
              value,
              observation: {
                method: 'GET',
                path,
                status: 200,
                apiSourceSha: apiSha,
                bodySha256: hash(bytes),
                bytes: bytes.length,
                observedAt: Date.now(),
              },
            });
          } catch {
            fail();
          }
        });
      },
    );
    const timer = setTimeout(() => {
      req.destroy();
      fail();
    }, 10_000);
    req.once('close', () => clearTimeout(timer));
    req.once('error', fail);
    req.end();
  });
}
async function readCurrent(config, bearer) {
  need(
    typeof bearer === 'string' && bearer.length > 0 && !/[\r\n]/u.test(bearer),
    'BEARER_REQUIRED',
  );
  const paths = [
    '/api/me',
    '/api/clio/status',
    `/api/clio/conversations/${conversationId}`,
    `/api/clio/conversations/${conversationId}/messages`,
  ];
  const rows = [];
  for (const path of paths) rows.push(await ownedGet(path, bearer));
  const proof = inspectCase20PresubmissionRecoveryReadback({
    config,
    me: rows[0].value,
    status: rows[1].value,
    conversation: rows[2].value,
    messages: rows[3].value,
  });
  return { ...proof, observations: rows.map((row) => row.observation), observedAt: Date.now() };
}

function assertOwnedLocal(state) {
  localEvidence(state.local.descriptors);
  need(
    isDeepStrictEqual(readStableFile(recoveryClaimPath).descriptor, state.claimDescriptor),
    'RECOVERY_CLAIM_CHANGED',
  );
}
function current(authority) {
  const state = authorities.get(authority);
  need(state && !state.failed, 'OPAQUE_AUTHORITY_REQUIRED');
  return state;
}

/** No HTTP adapter, local proof, scope or path injection is accepted. */
export async function acquireCase20PresubmissionRecoveryAuthority(input) {
  need(
    arguments.length === 1 &&
      record(input) &&
      isDeepStrictEqual(Object.keys(input).sort(), ['bearer', 'invocation']) &&
      input.invocation === 'QUALIFY_SAME_CASE20_UNSUBMITTED_RESERVATION_ONCE' &&
      process.platform === 'win32',
    'EXACT_INVOCATION_REQUIRED',
  );
  const local = localEvidence();
  need(!existsSync(recoveryClaimPath), 'RECOVERY_ALREADY_CLAIMED');
  const proof = await readCurrent(local.scope, input.bearer);
  localEvidence(local.descriptors);
  const claimDescriptor = writeExclusiveRecoveryClaim(recoveryClaimPath, {
    kind: 'case20-presubmission-recovery-once',
    version: 1,
    captureRunId: run,
    conversationId,
    reservationId,
    ceilingMicros: 15_000_000,
    priorExecutionSha256: pins[`${priorRoot}/execution.json`],
    priorHistorySha256: pins[`${priorRoot}/execution.json.events.jsonl`],
    priorClaimSha256: pins[originalClaimPath],
    checkpointSha256: pins[`${priorRoot}/aggregate-reserved-checkpoint.json`],
    journalSha256,
    expectedSha256: sha256Stable(proof.expected),
    observations: proof.observations,
    createdAt: Date.now(),
    noAutomaticRetry: true,
    noNewReservation: true,
  });
  const authority = Object.freeze({ kind: 'case20-presubmission-recovery-authority' });
  authorities.set(authority, {
    local,
    proof,
    claimDescriptor,
    restored: false,
    recheckStarted: false,
    rechecked: null,
    submissionConsumed: false,
    failed: false,
  });
  return authority;
}

/** Only the spend owner uses this one-use capability. JSON lookalikes refuse. */
export function consumeCase20PresubmissionRecoveryAuthority(authority) {
  const state = current(authority);
  need(!state.restored, 'RESTORATION_ALREADY_CONSUMED');
  state.restored = true;
  try {
    assertOwnedLocal(state);
  } catch (cause) {
    state.failed = true;
    throw cause;
  }
  return {
    checkpoint: structuredClone(state.local.checkpoint),
    expected: structuredClone(state.proof.expected),
    reservation: { caseId: '20', captureRunId: run, reservationId, ceilingMicros: 15_000_000 },
    assertOwned() {
      assertOwnedLocal(current(authority));
    },
    assertSubmission() {
      const value = current(authority);
      need(
        value.restored &&
          value.rechecked &&
          !value.submissionConsumed &&
          Date.now() - value.rechecked.observedAt <= 30_000 &&
          value.rechecked.admissionExpiresAt > Date.now(),
        'FRESH_RECHECK_REQUIRED',
      );
      value.submissionConsumed = true;
    },
  };
}

/** Additional GET-only absence check after native prepare, before execute. */
export async function recheckCase20PresubmissionRecoveryAuthority({
  authority,
  bearer,
  invocation,
}) {
  need(invocation === 'RECHECK_SAME_CASE20_BEFORE_FIRST_SUBMISSION_ONCE', 'EXACT_RECHECK_REQUIRED');
  const state = current(authority);
  need(
    state.restored && !state.recheckStarted && !state.submissionConsumed,
    'RECHECK_ALREADY_CONSUMED',
  );
  state.recheckStarted = true;
  try {
    assertOwnedLocal(state);
    const proof = await readCurrent(state.local.scope, bearer);
    need(isDeepStrictEqual(proof.expected, state.proof.expected), 'RECHECK_SCOPE_CHANGED');
    assertOwnedLocal(state);
    state.rechecked = proof;
    return inspectCase20PresubmissionRecoveryAuthority(authority);
  } catch (cause) {
    state.failed = true;
    throw cause;
  }
}

/** Safe observations only; no bearer, HTTP body or callable authority escapes. */
export function inspectCase20PresubmissionRecoveryAuthority(authority) {
  const state = authorities.get(authority);
  need(state, 'OPAQUE_AUTHORITY_REQUIRED');
  return structuredClone({
    kind: 'case20-presubmission-recovery-observation',
    captureRunId: run,
    conversationId,
    reservationId,
    ceilingMicros: 15_000_000,
    journalSha256,
    claimPath: recoveryClaimPath,
    claimSha256: state.claimDescriptor.sha256,
    restored: state.restored,
    recheckStarted: state.recheckStarted,
    rechecked: !!state.rechecked,
    submissionFenceConsumed: state.submissionConsumed,
    failed: state.failed,
    initialReads: state.proof.observations,
    preSubmissionReads: state.rechecked?.observations ?? [],
    currentVerifySha256,
    qualificationSha256,
    humanAcceptance: false,
  });
}
