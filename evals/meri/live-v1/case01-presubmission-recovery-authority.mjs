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
import { inspectCase01Admission, inspectCase01Scope } from './case01-live-capture.mjs';
import { nativeMeriCaptureHeaders } from './lib/native-http.mjs';
import { sha256Stable } from './artifact-collector.mjs';

// One reviewed pre-submission failure only. This is not a general retry API.
const base = 'C:/dev/main/outputs/meri-c2-20261003';
const run = 'bd35c0f4-1604-4371-b7e9-a1338369e53f';
const conversationId = 'f493355c-ee97-44a1-a0b0-e05e7b104b59';
const reservationId = 'cf7ea1df-6996-4d29-a5d5-b98db9c85c61';
const priorRoot = `${base}/case01-native-${run}`;
const recoveryClaimPath = `${base}/case01-presubmission-recovery-claim-${run}.json`;
const originalClaimPath = `C:/dev/cap-meri-foundation-evidence/controlled-read-claims/01-${run}.json`;
const apiSha = '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642';
const currentVerifySha256 = '227c81e4437276718a0f6dfccb2b883c6d32b266c66b35c79ba26381a1f9c413';
const qualificationSha256 = '6b80b2bcb8da239e6caaed813b87253e51cf1f392f93710ee79d3176a590aede';
const journalSha256 = '7ac5a5d06782d325e0d30327586968aa60233681b7dec2ed98f50285ed6daa60';
const authorities = new WeakMap();
const hash = (value) => createHash('sha256').update(value).digest('hex');
const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = (code) =>
  Object.assign(new Error(`CASE01_PRESUBMISSION_RECOVERY_${code}`), {
    code: `CASE01_PRESUBMISSION_RECOVERY_${code}`,
  });
const need = (condition, code) => {
  if (!condition) throw error(code);
};
const pins = Object.freeze({
  [`${priorRoot}/execution.json`]:
    '091946b7c594ccb4821202b00eaef0d6b4cab89c2bdf4d5ca9708a8ed66c593b',
  [`${priorRoot}/execution-events.jsonl`]:
    'ea6caeeb90d60633b3d99d9014823e4e9d1d0c07239cc1f3a46db90625c4cd75',
  [`${priorRoot}/actual-capture-scope.json`]:
    '0df776432c0915e6f82ea8cfa7025f38aed347f1e7d55b647b0fd7cd83af8cfd',
  [`${priorRoot}/aggregate-reserved-checkpoint.json`]:
    'e871a120672b775379354d414c554381c00e9afcad51aceb8fccfd0b4f1f6d4f',
  [originalClaimPath]: '78737800de6ac6f9f2536e6291d9a6927460c2c2c568a1bccddd597eb7d06721',
  [`${base}/case01-browser-readiness-diagnostic-v1.json`]:
    '68cfb4c38ce44ee95fc09031a53c29e8b47c4207e83864e4dc64162bd551881e',
  [`${base}/case01-native-bootstrap-v2/run-case01-native.mjs`]:
    '655cc278a1a76ff55cf7a0ceae96ccfc325a016e0e3a0d53c21f43f276c171d1',
  [`${base}/case01-native-bootstrap-v2/case01-prepared-guards.mjs`]:
    'f539d2e35a66ec76f1d741d6a8f09d528b400149c346982fd7b0f77f37eb5b7a',
  [`${base}/case01-native-actual-scope-v2.json`]:
    '87b10494d9547a4ec9fb28641271d9cec7fbfa5cd9d3c971c91201400fce4d69',
  [`${base}/case01-native-setup-execute-v3/inner-receipt.jsonl`]:
    '870e3efe65d748058614bd49b7350cad5f8ad6215cf8ab61e2e2b673cc680cb3',
  [`${base}/case01-recovered-auth-scope.private.json`]:
    'ed9c3b1c11014825b29ee2879796e20b3f0023959ed9e478337180b96ed7a062',
  [`${base}/reviewed-rates-c2-v2-20261003.json`]:
    '3531e09dfcce9f66b4ea2b3564db47bd72dc507cdcf1aecdda277b838007704e',
  'C:/dev/main/meri-c1-20261002/evals/meri/live-v1/case01-live-capture.mjs':
    '4136d20e10ec9e0e635fefc0ccf8a4609f12a36a410dba3f3eb4f828469ea029',
  'C:/dev/main/meri-c1-20261002/evals/meri/live-v1/windows-artifact-storage.mjs':
    '8b03eeccad53a92fc4cf7bcf4976522ecf7ed2126591449e28a6a70948ac01c4',
  'C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl': journalSha256,
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
export function inspectCase01PresubmissionRecoveryEvidence({
  execution,
  history,
  scope,
  checkpoint,
  claim,
  diagnostic,
}) {
  need(
    execution?.verdict === 'BLOCKED' &&
      execution.failureCode === 'CASE01_OPERATOR_FAILED' &&
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
      history.length === 13 &&
      isDeepStrictEqual(history.at(-1).summary, execution),
    'HISTORY_UNPROVED',
  );
  for (const [index, event] of history.entries()) {
    need(
      event.sequence === index + 1 &&
        event.summary?.executionAttempted === false &&
        event.summary.executionIntent === undefined &&
        event.summary.capturePrepared === undefined &&
        event.summary.outcome === undefined &&
        event.summary.browserApplicationWrites === 0,
      'PRIOR_SUBMISSION_POSSIBLE',
    );
  }
  need(
    execution.caseId === '01' &&
      execution.captureRunId === run &&
      execution.conversationId === conversationId &&
      execution.sourceSha === apiSha &&
      execution.scriptSha256 === pins[`${base}/case01-native-bootstrap-v2/run-case01-native.mjs`] &&
      scope.captureRunId === run &&
      scope.conversationId === conversationId &&
      scope.deployment?.apiSha === apiSha &&
      scope.deployment.orchestratorSha === 'fb17c7ebfa010ce964919068f61830cb78ca620d',
    'ORIGINAL_SCOPE_CHANGED',
  );
  need(
    claim?.kind === 'meri-native-case01-one-shot-claim' &&
      claim.captureRunId === run &&
      claim.caseId === '01' &&
      claim.operatorSourceSha === 'b7918cd947e6cc7fb8c83ee171e5fa50e483e7aa' &&
      resolve(claim.outRoot) === resolve(priorRoot),
    'ORIGINAL_CLAIM_CHANGED',
  );
  const key = `01:${run}`,
    row = checkpoint?.snapshot?.runs?.[key];
  need(
    checkpoint?.kind === 'meri-fresh-capture-spend-checkpoint' &&
      checkpoint.version === 1 &&
      checkpoint.state?.freshVersion === 1 &&
      resolve(checkpoint.state.root) === resolve('C:/dev/main/outputs/meri-fresh-20261003') &&
      checkpoint.state.files?.['fresh-spend.jsonl']?.sha256 === journalSha256 &&
      checkpoint.snapshot.eventCount === 21 &&
      checkpoint.snapshot.activeRun === key &&
      row?.event === 'reserved' &&
      row.reservationId === reservationId &&
      row.ceilingMicros === 15_000_000 &&
      checkpoint.snapshot.knownSettledCostMicros === 9_841_281 &&
      checkpoint.snapshot.committedCostMicros === 24_841_281 &&
      checkpoint.snapshot.remainingReservationMicros === 5_158_719,
    'RESERVATION_CHANGED',
  );
  need(
    diagnostic?.status === 'READ_ONLY_BROWSER_DIAGNOSTIC_COMPLETE' &&
      diagnostic.failedExecutionSha256 === pins[`${priorRoot}/execution.json`] &&
      diagnostic.journalSha256 === journalSha256 &&
      diagnostic.journalUnchanged === true &&
      diagnostic.sessionRevoked === true &&
      diagnostic.applicationWrites === 0 &&
      diagnostic.providerCalls === 0 &&
      diagnostic.captureEntryCalls === 0 &&
      diagnostic.immediateAfterNavigation?.loaded === false &&
      diagnostic.immediateAfterNavigation.errorClass === 'TypeError' &&
      diagnostic.afterReadinessWait?.tokenAvailable === true,
    'DIAGNOSIS_UNPROVED',
  );
  return {
    caseId: '01',
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
      .get(`${priorRoot}/execution-events.jsonl`)
      .toString('utf8')
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line)),
    scope: json(`${priorRoot}/actual-capture-scope.json`),
    checkpoint: json(`${priorRoot}/aggregate-reserved-checkpoint.json`),
    claim: json(originalClaimPath),
    diagnostic: json(`${base}/case01-browser-readiness-diagnostic-v1.json`),
  };
  inspectCase01PresubmissionRecoveryEvidence(input);
  const rates = json(`${base}/reviewed-rates-c2-v2-20261003.json`);
  if (!previousDescriptors)
    need(Date.parse(rates.expiresAt) > Date.now() + 15 * 60_000, 'RATES_TOO_OLD');
  return { ...input, descriptors };
}

/** Pure validation of response bodies. Only acquisition below performs/authenticates GETs. */
export function inspectCase01PresubmissionRecoveryReadback({
  config,
  me,
  status,
  conversation,
  messages,
  now = Date.now(),
}) {
  const scope = inspectCase01Scope(config, {
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
      conversation.title === `meri-foundation-20260928 case01 ${run}`,
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
  const admission = inspectCase01Admission({
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
  const proof = inspectCase01PresubmissionRecoveryReadback({
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
export async function acquireCase01PresubmissionRecoveryAuthority(input) {
  need(
    arguments.length === 1 &&
      record(input) &&
      isDeepStrictEqual(Object.keys(input).sort(), ['bearer', 'invocation']) &&
      input.invocation === 'QUALIFY_SAME_CASE01_UNSUBMITTED_RESERVATION_ONCE' &&
      process.platform === 'win32',
    'EXACT_INVOCATION_REQUIRED',
  );
  const local = localEvidence();
  need(!existsSync(recoveryClaimPath), 'RECOVERY_ALREADY_CLAIMED');
  const proof = await readCurrent(local.scope, input.bearer);
  localEvidence(local.descriptors);
  const claimDescriptor = writeExclusiveRecoveryClaim(recoveryClaimPath, {
    kind: 'case01-presubmission-recovery-once',
    version: 1,
    captureRunId: run,
    conversationId,
    reservationId,
    ceilingMicros: 15_000_000,
    priorExecutionSha256: pins[`${priorRoot}/execution.json`],
    priorHistorySha256: pins[`${priorRoot}/execution-events.jsonl`],
    priorClaimSha256: pins[originalClaimPath],
    checkpointSha256: pins[`${priorRoot}/aggregate-reserved-checkpoint.json`],
    journalSha256,
    expectedSha256: sha256Stable(proof.expected),
    observations: proof.observations,
    createdAt: Date.now(),
    noAutomaticRetry: true,
    noNewReservation: true,
  });
  const authority = Object.freeze({ kind: 'case01-presubmission-recovery-authority' });
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
export function consumeCase01PresubmissionRecoveryAuthority(authority) {
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
    reservation: { caseId: '01', captureRunId: run, reservationId, ceilingMicros: 15_000_000 },
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
export async function recheckCase01PresubmissionRecoveryAuthority({
  authority,
  bearer,
  invocation,
}) {
  need(invocation === 'RECHECK_SAME_CASE01_BEFORE_FIRST_SUBMISSION_ONCE', 'EXACT_RECHECK_REQUIRED');
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
    return inspectCase01PresubmissionRecoveryAuthority(authority);
  } catch (cause) {
    state.failed = true;
    throw cause;
  }
}

/** Safe observations only; no bearer, HTTP body or callable authority escapes. */
export function inspectCase01PresubmissionRecoveryAuthority(authority) {
  const state = authorities.get(authority);
  need(state, 'OPAQUE_AUTHORITY_REQUIRED');
  return structuredClone({
    kind: 'case01-presubmission-recovery-observation',
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
