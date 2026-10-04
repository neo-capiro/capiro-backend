import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import vm from 'node:vm';
import {
  inspectCase20PresubmissionRecoveryEvidence,
  inspectCase20PresubmissionRecoveryReadback,
  consumeCase20PresubmissionRecoveryAuthority,
  inspectCase20PresubmissionRecoveryAuthority,
  recheckCase20PresubmissionRecoveryAuthority,
} from '../case20-presubmission-recovery-authority.mjs';
import { restoreCase20PresubmissionCaptureSpend } from '../capture-spend-aggregate.mjs';
import { inspectControlledReadAdmission, inspectControlledReadScope } from '../controlled-read-live-capture.mjs';
import { sha256Stable } from '../artifact-collector.mjs';

const base = 'C:/dev/main/outputs/meri-c2-20261003';
const run = 'f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b';
const old = `${base}/case20-native-${run}`;
const read = (name) => JSON.parse(fs.readFileSync(name, 'utf8'));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const authorityUrl = new URL('../case20-presubmission-recovery-authority.mjs', import.meta.url);
const authoritySource = fs.readFileSync(authorityUrl, 'utf8');
const aggregateUrl = new URL('../capture-spend-aggregate.mjs', import.meta.url);
const aggregateSource = fs.readFileSync(aggregateUrl, 'utf8');
const evidence = {"execution":{"schemaVersion":1,"caseId":"20","captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","conversationId":"db0e01ac-60a1-4e3c-b8ba-66748d087a2e","sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","expectedWebSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64","scriptSha256":"d8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83","startedAt":"2026-10-04T00:52:57.644Z","verdict":"BLOCKED","maximumNewTurns":1,"browserApplicationWrites":0,"conversationCreationAttempted":true,"executionAttempted":false,"sessionCreated":true,"sessionRevoked":true,"fullFile01Acceptance":false,"submissionObservation":{"turnsSent":0,"turnsSentStatus":"NOT_ATTEMPTED"},"createdSessionIdSha256":"1ab8e49328fa6c037bda00d520bc9fa5a07b9be295de643066684471786346cb","creationIntent":{"clientId":"41f9ec63-3963-479f-b747-59a3767ef44b","title":"meri-foundation-20260928 case20 f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","createdAt":"2026-10-04T00:53:22.310Z","retryAllowed":false},"conversationReadback":{"status":"EMPTY_OWNED_CONVERSATION_CREATED","createdSha256":"e7b01a255b1d92415529ecbb68ed137729841e453a21e60ddc672654033629e7","currentSha256":"40865de677270b6489ce394b966045243798bcc679d26fa298faeb4be4f8158a","messagesSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","observedAt":"2026-10-04T00:53:22.698Z"},"failureCode":"CONTROLLED_READ_OPERATOR_FAILED","completedAt":"2026-10-04T00:53:23.883Z"},"history":[{"at":"2026-10-04T00:52:57.644Z","summary":{"schemaVersion":1,"caseId":"20","captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","conversationId":null,"sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","expectedWebSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64","scriptSha256":"d8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83","startedAt":"2026-10-04T00:52:57.644Z","verdict":"NOT_RUN","maximumNewTurns":1,"browserApplicationWrites":0,"conversationCreationAttempted":false,"executionAttempted":false,"sessionCreated":false,"sessionRevoked":false,"fullFile01Acceptance":false,"submissionObservation":{"turnsSent":0,"turnsSentStatus":"NOT_ATTEMPTED"}}},{"at":"2026-10-04T00:53:04.421Z","summary":{"schemaVersion":1,"caseId":"20","captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","conversationId":null,"sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","expectedWebSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64","scriptSha256":"d8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83","startedAt":"2026-10-04T00:52:57.644Z","verdict":"NOT_RUN","maximumNewTurns":1,"browserApplicationWrites":0,"conversationCreationAttempted":false,"executionAttempted":false,"sessionCreated":true,"sessionRevoked":false,"fullFile01Acceptance":false,"submissionObservation":{"turnsSent":0,"turnsSentStatus":"NOT_ATTEMPTED"},"createdSessionIdSha256":"1ab8e49328fa6c037bda00d520bc9fa5a07b9be295de643066684471786346cb"}},{"at":"2026-10-04T00:53:22.310Z","summary":{"schemaVersion":1,"caseId":"20","captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","conversationId":null,"sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","expectedWebSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64","scriptSha256":"d8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83","startedAt":"2026-10-04T00:52:57.644Z","verdict":"NOT_RUN","maximumNewTurns":1,"browserApplicationWrites":0,"conversationCreationAttempted":true,"executionAttempted":false,"sessionCreated":true,"sessionRevoked":false,"fullFile01Acceptance":false,"submissionObservation":{"turnsSent":0,"turnsSentStatus":"NOT_ATTEMPTED"},"createdSessionIdSha256":"1ab8e49328fa6c037bda00d520bc9fa5a07b9be295de643066684471786346cb","creationIntent":{"clientId":"41f9ec63-3963-479f-b747-59a3767ef44b","title":"meri-foundation-20260928 case20 f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","createdAt":"2026-10-04T00:53:22.310Z","retryAllowed":false}}},{"at":"2026-10-04T00:53:22.414Z","summary":{"schemaVersion":1,"caseId":"20","captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","conversationId":"db0e01ac-60a1-4e3c-b8ba-66748d087a2e","sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","expectedWebSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64","scriptSha256":"d8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83","startedAt":"2026-10-04T00:52:57.644Z","verdict":"NOT_RUN","maximumNewTurns":1,"browserApplicationWrites":0,"conversationCreationAttempted":true,"executionAttempted":false,"sessionCreated":true,"sessionRevoked":false,"fullFile01Acceptance":false,"submissionObservation":{"turnsSent":0,"turnsSentStatus":"NOT_ATTEMPTED"},"createdSessionIdSha256":"1ab8e49328fa6c037bda00d520bc9fa5a07b9be295de643066684471786346cb","creationIntent":{"clientId":"41f9ec63-3963-479f-b747-59a3767ef44b","title":"meri-foundation-20260928 case20 f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","createdAt":"2026-10-04T00:53:22.310Z","retryAllowed":false}}},{"at":"2026-10-04T00:53:22.699Z","summary":{"schemaVersion":1,"caseId":"20","captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","conversationId":"db0e01ac-60a1-4e3c-b8ba-66748d087a2e","sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","expectedWebSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64","scriptSha256":"d8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83","startedAt":"2026-10-04T00:52:57.644Z","verdict":"NOT_RUN","maximumNewTurns":1,"browserApplicationWrites":0,"conversationCreationAttempted":true,"executionAttempted":false,"sessionCreated":true,"sessionRevoked":false,"fullFile01Acceptance":false,"submissionObservation":{"turnsSent":0,"turnsSentStatus":"NOT_ATTEMPTED"},"createdSessionIdSha256":"1ab8e49328fa6c037bda00d520bc9fa5a07b9be295de643066684471786346cb","creationIntent":{"clientId":"41f9ec63-3963-479f-b747-59a3767ef44b","title":"meri-foundation-20260928 case20 f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","createdAt":"2026-10-04T00:53:22.310Z","retryAllowed":false},"conversationReadback":{"status":"EMPTY_OWNED_CONVERSATION_CREATED","createdSha256":"e7b01a255b1d92415529ecbb68ed137729841e453a21e60ddc672654033629e7","currentSha256":"40865de677270b6489ce394b966045243798bcc679d26fa298faeb4be4f8158a","messagesSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","observedAt":"2026-10-04T00:53:22.698Z"}}},{"at":"2026-10-04T00:53:23.884Z","summary":{"schemaVersion":1,"caseId":"20","captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","conversationId":"db0e01ac-60a1-4e3c-b8ba-66748d087a2e","sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","expectedWebSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64","scriptSha256":"d8d429a7e4e1b5fc5d731e7cb4dee098a3075d4764fa0886c745cace43bf7c83","startedAt":"2026-10-04T00:52:57.644Z","verdict":"BLOCKED","maximumNewTurns":1,"browserApplicationWrites":0,"conversationCreationAttempted":true,"executionAttempted":false,"sessionCreated":true,"sessionRevoked":true,"fullFile01Acceptance":false,"submissionObservation":{"turnsSent":0,"turnsSentStatus":"NOT_ATTEMPTED"},"createdSessionIdSha256":"1ab8e49328fa6c037bda00d520bc9fa5a07b9be295de643066684471786346cb","creationIntent":{"clientId":"41f9ec63-3963-479f-b747-59a3767ef44b","title":"meri-foundation-20260928 case20 f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","createdAt":"2026-10-04T00:53:22.310Z","retryAllowed":false},"conversationReadback":{"status":"EMPTY_OWNED_CONVERSATION_CREATED","createdSha256":"e7b01a255b1d92415529ecbb68ed137729841e453a21e60ddc672654033629e7","currentSha256":"40865de677270b6489ce394b966045243798bcc679d26fa298faeb4be4f8158a","messagesSha256":"4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945","observedAt":"2026-10-04T00:53:22.698Z"},"failureCode":"CONTROLLED_READ_OPERATOR_FAILED","completedAt":"2026-10-04T00:53:23.883Z"}}],"scope":{"schemaVersion":1,"provenance":"LIVE_CAPTURE","caseId":"20","target":{"apiOrigin":"https://os.capiro.ai","environment":"capiro-dev"},"limits":{"concurrency":1,"deadlineMs":600000,"maxSpendUsd":15},"contract":{"fixtureSha256":"2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61","contractSourceSha256":"acd2a1cf766ad6e988025c4c43235213164926e7036cc8361986916d59963b66"},"fixture":{"version":"meri-live-v1-2026-09-26.1","namespace":"meri-foundation-20260928","sha256":"2a8159d45d512f325539eb700907700ecc16cbc2d6536277adf85d8f49368e61","mappingSha256":"929ebb433886c035cfbcbcf8a537acde2157bec86634bfc384b594dfbca05861","seedReceiptId":"meri-synthetic-fixture-seed-receipt:sha256:dbda52dbd9e17320519d4cc40bcd73975fbf0ce0fae21341a1de535644f619e8","resetReceiptId":"meri-synthetic-fixture-reset-receipt:sha256:28630ec9f867373094583e8f16eaf521f8be00508d03b7b713c11784ab214de0"},"scope":{"actors":{"PAT":{"userId":"b1f758fc-17bd-40f8-bef2-fa2d2380300f","clerkUserId":"user_3Jw2FvWZkYGKmxWGx13tNJxFD2A","role":"standard_user","tenantPhysicalId":"f2d6cf8f-057c-479a-8110-62fe5086d43f"}},"tenants":{"T1":{"physicalId":"f2d6cf8f-057c-479a-8110-62fe5086d43f","slug":"meri-foundation-20260928-t1"}},"clients":{"ASTER":{"physicalId":"41f9ec63-3963-479f-b747-59a3767ef44b","tenantPhysicalId":"f2d6cf8f-057c-479a-8110-62fe5086d43f"}},"sources":{"R2-27":{"frozenFixtureId":"R2-27","physicalId":"2d0c016e-8dad-5f6e-80dd-e36740fff7ee","tenantPhysicalId":"f2d6cf8f-057c-479a-8110-62fe5086d43f","clientPhysicalId":null,"kind":"budget_document","version":"v1"}}},"captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","conversationId":"db0e01ac-60a1-4e3c-b8ba-66748d087a2e","deployment":{"apiSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","orchestratorSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","builds":{"api":{"service":"api","sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","imageDigest":"sha256:23f529da3c1c00d401968811575dc075bced6c60669baa9a09e9c23575c9c452","buildId":"capiro-build-web-dev:5ca674e3-f986-46fa-bb05-2ca8e14d1d67","buildspecSha256":"61cc399b632b885b2c17dfb692a536ba493246465573fb83469669c6267e2811"},"meriv2-orchestrator":{"service":"meriv2-orchestrator","sourceSha":"4f0253874357c272fda1ae2a5271ee4af645f0bc","imageDigest":"sha256:1c491a5ac46ea320195fe8ab367322ad2ebbd0949d69530b5ccfba2de84eb491","buildId":"capiro-build-web-dev:1105f91e-3171-41aa-ae00-7f28540caf90","buildspecSha256":"eb741a51f6169fdca94e6a3d69ab5bfa18ef0f22098016518e8dc30120aa8a24"}}}},"checkpoint":{"kind":"meri-fresh-capture-spend-checkpoint","version":1,"state":{"root":"C:\\dev\\main\\outputs\\meri-fresh-20261003","freshVersion":1,"directories":{"C:":"5081a475:50000:5:1da8405:2f19714a","C:/dev":"5081a475:30000:9ca2a:1dd1c57:eded5d59","C:/dev/main":"5081a475:130000:2bb7a0:1dd4485:55c889ba","C:/dev/main/outputs":"5081a475:70000:71d503:1dd471a:fb902f7b","C:/dev/main/outputs/meri-fresh-20261003":"5081a475:80000:11d74b4:1dd52d6:86131ecd"},"files":{"run-authorization.json":{"identity":"5081a475:1f0000:33e3a:1dd52d7:913b0334","sha256":"e07822e83a7c7b531606519ecd4fdf1027f2fa7cbaefd4bad92a2084590262fe","bytes":489},"fresh-spend.jsonl":{"identity":"5081a475:80000:11d75c5:1dd52d7:92f07d2a","sha256":"d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b","bytes":14368}}},"snapshot":{"protocolVersion":3,"eventCount":23,"runs":{"01:cc0d21a5-8981-4fbf-81dc-f2be3a63898c":{"at":"2026-10-03T01:36:12.747Z","caseId":"01","captureRunId":"cc0d21a5-8981-4fbf-81dc-f2be3a63898c","reservationId":"c2cd316e-2d09-4c76-88cf-a9c0ef20e098","event":"reserved","ceilingMicros":15000000,"conversationId":"55452c90-5718-4e0c-9ffd-d9bf2c3439ad","qualificationSha256":"9ded2743ac47c55240e7eae05a7147aab34ff354d014ac39bcdc0528899aa2d9","chargedCostMicros":1490802,"historical":true},"02:62742c07-529c-47c1-aeeb-01474522ccbd":{"at":"2026-10-03T01:43:34.996Z","caseId":"02","captureRunId":"62742c07-529c-47c1-aeeb-01474522ccbd","reservationId":"c4764abd-e3a8-4d6b-819f-77f4e08ee231","event":"reserved","ceilingMicros":15000000,"conversationId":"805cdde4-7cd2-482f-9e53-5b5b7724682e","qualificationSha256":"119ea537cd93a48a3126e5e6c178b63b68afc35132cd968085993e686c2ffe9d","chargedCostMicros":1503301,"historical":true},"03:65c093f9-d7ee-410c-865b-65d3683e9514":{"at":"2026-10-03T01:49:09.943Z","caseId":"03","captureRunId":"65c093f9-d7ee-410c-865b-65d3683e9514","reservationId":"41820c9a-6f51-4062-aad6-d308fadfa7e3","event":"reserved","ceilingMicros":15000000,"conversationId":"2755ade6-35e6-43c1-8b48-bdbff01bd3a5","qualificationSha256":"d238c1c371685e78179b70c2dbe0ef1bb1805b8affb909b88a41cdd8f89db37d","chargedCostMicros":3086726,"historical":true},"04:ce58a8c8-8c5e-439b-b842-dd5aa5a06395":{"at":"2026-10-03T01:54:49.415Z","caseId":"04","captureRunId":"ce58a8c8-8c5e-439b-b842-dd5aa5a06395","reservationId":"0da06107-11b3-4ce4-90bd-67a8f022c369","event":"reserved","ceilingMicros":15000000,"conversationId":"9b70c52b-d537-4347-b6b0-1b005aeb3e3c","qualificationSha256":"fe06d197ad2ad953a8719094af02aaa137b3746df1e90f2b5b70b1e2ec5a40bc","chargedCostMicros":1499326,"historical":true},"05:1008c920-0d14-4110-806e-76399e9e7641":{"at":"2026-10-03T02:00:20.010Z","caseId":"05","captureRunId":"1008c920-0d14-4110-806e-76399e9e7641","reservationId":"8b91b48b-fa26-4395-9cbe-669efd18ab1a","event":"reserved","ceilingMicros":15000000,"conversationId":"1bfb1e6c-2128-4f9d-9fea-3e02a8f1c7b7","qualificationSha256":"def98c7562f7637db8a87aa7beac067a95093144c22bef12acdeee925e210752","chargedCostMicros":2261126,"historical":true},"01:bd35c0f4-1604-4371-b7e9-a1338369e53f":{"atMs":1791064128652,"captureRunId":"bd35c0f4-1604-4371-b7e9-a1338369e53f","caseId":"01","ceilingMicros":15000000,"event":"reserved","nativeCaptureVersion":1,"reservationId":"cf7ea1df-6996-4d29-a5d5-b98db9c85c61","sequence":21,"chargedCostMicros":2292602,"terminalCostReconciled":true,"captureAuthority":false,"captureStatus":"CAPTURE_UNCERTAIN","answerGrade":"NOT_EVALUATED","reconciliationProofSha256":"59b7055d48bb074d13f57eb16c93334b258800107c039667aa445c3bf5e26648"},"20:f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b":{"atMs":1791075178097,"captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","caseId":"20","ceilingMicros":15000000,"event":"reserved","nativeCaptureVersion":1,"reservationId":"7ea73cdc-526e-4b31-8c28-b0636ea8d2ae","sequence":23}},"activeRun":"20:f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","knownSettledCostMicros":12133883,"committedCostMicros":27133883,"remainingReservationMicros":2866117,"perCaseMaxCostMicros":15000000,"historicalPrefixSha256":"abe458973e6998db20586c781ac5a3cbd4ca2fa565425e62722f0eb9c985210b","olderCosts":"UNRESOLVED_SEPARATE_NOT_REPLACED"}},"claim":{"kind":"meri-controlled-read-one-shot-claim","captureRunId":"f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","caseId":"20","operatorSourceSha":"af7aa8aff4777a2d4809e882c2b797fbb2cd51a2","outRoot":"C:\\dev\\main\\outputs\\meri-c2-20261003\\case20-native-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b","createdAt":"2026-10-04T00:52:57.635Z"},"diagnostic":{"status":"READ_ONLY_BROWSER_DIAGNOSTIC_COMPLETE","startedAt":"2026-10-04T00:56:17.800Z","failedExecutionSha256":"e210847d83b7b4998d0e0cc57b51bc7d93b290ab6b5bcddcd5ee9f24fdc1f2c7","journalSha256":"d6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b","conversationId":"db0e01ac-60a1-4e3c-b8ba-66748d087a2e","applicationWrites":0,"providerCalls":0,"journalMutations":0,"captureEntryCalls":0,"blockedRequests":[],"sessionRevoked":true,"beforeNavigation":{"loaded":true,"sessionPresent":true,"releaseSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64"},"immediateAfterNavigation":{"loaded":false,"sessionPresent":false,"releaseSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64","tokenAvailable":false,"errorClass":"TypeError","missingObjectProperty":false,"messageOmitted":true},"afterReadinessWait":{"loaded":true,"sessionPresent":true,"tokenAvailable":true,"releaseSha":"78ad5805679a3045b1fc10fb19beafa7f76e4e64"},"journalUnchanged":true,"completedAt":"2026-10-04T00:56:22.246Z"}};
const originalAuthorization = fs.readFileSync(new URL('./fixtures/case01-failed-receipt-authorization.unit.json', import.meta.url));
const priorJournal = fs.readFileSync(new URL('./fixtures/case01-failed-receipt-journal21.unit.jsonl', import.meta.url));
const terminalProof = read(new URL('./fixtures/case01-failed-receipt-cost-proof.unit.json', import.meta.url));
const terminalEvent = {nativeCaptureVersion:1,sequence:22,atMs:terminalProof.observedAtMs,event:'terminal_cost_reconciled',caseId:'01',captureRunId:terminalProof.captureRunId,reservationId:terminalProof.reservationId,proof:terminalProof};
const reservedEvent = {...evidence.checkpoint.snapshot.runs[`20:${run}`]};
const reservedJournal = Buffer.concat([priorJournal, Buffer.from(JSON.stringify(terminalEvent)+'\n'+JSON.stringify(reservedEvent)+'\n')]);

function fixture() {
  const config = structuredClone(evidence.scope),
    scope = inspectControlledReadScope(config, { MERI_LIVE_BEARER_TOKEN: 'unit-only' });
  const now = Date.now(),
    source = scope.source;
  const admission = {
    ...scope.expected,
    schemaVersion: 1,
    kind: 'meri-controlled-read-authenticated-admission',
    status: 'READY',
    issuedAt: now,
    expiresAt: now + 60_000,
    apiReleaseSha: config.deployment.apiSha,
    toolAuthority: 'shared_static_registry_read_only',
    toolCatalogSha256: 'a'.repeat(64),
    dynamicMcpAllowed: false,
    incidentalWriters: 'suppressed',
    fixture: {
      fixtureNamespace: config.fixture.namespace,
      fixtureVersion: config.fixture.version,
      physicalMapSha256: config.fixture.mappingSha256,
      currentVerifySha256: '925c4735e4d435ab06c40b31ee590b0ce4e7d9220b742155c67e4115b1bc6516',
      seedReceiptId: config.fixture.seedReceiptId,
      resetReceiptId: config.fixture.resetReceiptId,
      sources: [
        {
          logicalId: 'R2-27',
          physicalId: source.physicalId,
          tenantId: source.tenantId,
          clientId: source.clientId,
          sourceVersion: source.version,
          contentSha256: source.contentSha256,
          kind: source.kind,
          sourceStorage: 'immutable_source_owned_controlled_adapter',
        },
      ],
    },
    providerBudget: {
      ready: true,
      coverage: 'case20_controlled_read_turn',
      qualificationSha256: '47d64a19fdf3a718eddefee998247173f98f9b1d3f24703f31d8b4dee779c9af',
      currentVerifySha256: '925c4735e4d435ab06c40b31ee590b0ce4e7d9220b742155c67e4115b1bc6516',
      maxCostMicros: 15_000_000,
    },
  };
  return {
    config,
    now,
    me: {
      tenant: { id: scope.expected.tenantId, slug: scope.tenant.slug },
      user: { id: scope.expected.actorUserId, clerkUserId: scope.actor.clerkUserId },
      role: 'standard_user',
      features: { meriv3Chat: true },
    },
    status: { configured: true, healthy: true },
    messages: [],
    conversation: {
      id: config.conversationId,
      tenantId: scope.expected.tenantId,
      userId: scope.expected.actorUserId,
      clientId: scope.expected.clientId,
      archivedAt: null,
      title: `meri-foundation-20260928 case20 ${run}`,
      metadata: { brand: 'Meri', runtime: 'test', userEmail: 'synthetic@example.com' },
      captureAdmission: admission,
    },
  };
}

test('sanitized stopped pre-submission evidence and fresh READY readback validate without granting authority', () => {
  const inspected = inspectCase20PresubmissionRecoveryEvidence(evidence);
  assert.equal(inspected.captureAuthority, false);
  const readback = inspectCase20PresubmissionRecoveryReadback(fixture());
  assert.equal(readback.captureAuthority, false);
  for (const fake of [
    inspected,
    readback,
    { kind: 'case20-presubmission-recovery-authority' },
    null,
  ]) {
    assert.throws(() => consumeCase20PresubmissionRecoveryAuthority(fake));
    assert.throws(() => inspectCase20PresubmissionRecoveryAuthority(fake));
    assert.throws(() =>
      restoreCase20PresubmissionCaptureSpend(fake, {
        invocation: 'RESTORE_SAME_CASE20_UNSUBMITTED_RESERVATION_ONCE',
        pythonExecutable: 'unused',
      }),
    );
  }
});
for (const [name, mutate] of [
  ['execution intent', (x) => (x.history[0].summary.executionIntent = {})],
  ['execution attempted', (x) => (x.history[0].summary.executionAttempted = true)],
  ['completed preparation', (x) => (x.history[0].summary.capturePrepared = true)],
  ['native outcome', (x) => (x.history[0].summary.outcome = {})],
  ['browser application write', (x) => (x.history[0].summary.browserApplicationWrites = 1)],
  ['missing history', (x) => x.history.pop()],
  ['history reversal', (x) => (x.history[1].at = '2000-01-01T00:00:00Z')],
  ['different conversation', (x) => (x.scope.conversationId = x.scope.captureRunId)],
  ['different claim', (x) => (x.claim.captureRunId = 'bad')],
  ['different reservation', (x) => (x.checkpoint.snapshot.runs[`20:${run}`].reservationId = 'bad')],
  ['changed cost', (x) => (x.checkpoint.snapshot.committedCostMicros = 0)],
  ['additional journal event', (x) => x.checkpoint.snapshot.eventCount++],
  ['active reservation cleared', (x) => (x.checkpoint.snapshot.activeRun = null)],
  [
    'wrong journal hash',
    (x) => (x.checkpoint.state.files['fresh-spend.jsonl'].sha256 = 'f'.repeat(64)),
  ],
  ['diagnostic writes', (x) => (x.diagnostic.applicationWrites = 1)],
])
  test(`rejects local evidence: ${name}`, () => {
    const x = structuredClone(evidence);
    mutate(x);
    assert.throws(() => inspectCase20PresubmissionRecoveryEvidence(x));
  });

for (const [name, mutate] of [
  ['different actor', (x) => (x.me.user.id = x.config.captureRunId)],
  ['administrator', (x) => (x.me.role = 'tenant_admin')],
  ['wrong release', (x) => (x.conversation.captureAdmission.apiReleaseSha = 'f'.repeat(40))],
  ['archived conversation', (x) => (x.conversation.archivedAt = new Date().toISOString())],
  ['different owner', (x) => (x.conversation.userId = x.config.captureRunId)],
  ['different client', (x) => (x.conversation.clientId = x.config.captureRunId)],
  ['messages already present', (x) => x.messages.push({ role: 'user', body: 'anything' })],
  ['malformed messages', (x) => (x.messages = { messages: [] })],
  ['missing metadata', (x) => delete x.conversation.metadata],
  ['null metadata', (x) => (x.conversation.metadata = null)],
  [
    'wrong current fixture',
    (x) => (x.conversation.captureAdmission.fixture.currentVerifySha256 = 'f'.repeat(64)),
  ],
  [
    'wrong qualification',
    (x) => (x.conversation.captureAdmission.providerBudget.qualificationSha256 = 'f'.repeat(64)),
  ],
  ['expired admission', (x) => (x.conversation.captureAdmission.expiresAt = x.now)],
  ['stale admission', (x) => (x.conversation.captureAdmission.issuedAt = x.now - 40_000)],
])
  test(`rejects current readback: ${name}`, () => {
    const x = fixture();
    mutate(x);
    assert.throws(() => inspectCase20PresubmissionRecoveryReadback(x));
  });
for (const key of [
  'serverCaptureProviderBudget',
  'serverReadonlyCapturePolicy',
  'serverCaptureEvidenceReceipt',
  'syntheticReadBudgetQualification',
  'syntheticReadProviderBudget',
  'syntheticReadBudgetTerminal',
  'governedArtifactCapture',
  'governedArtifactCaptureBinding',
  'governedArtifactProviderBudget',
  'unknownScope',
]) {
  test(`present ${key}, even null, is not absence`, () => {
    const x = fixture();
    x.conversation.metadata[key] = null;
    assert.throws(() => inspectCase20PresubmissionRecoveryReadback(x));
  });
}

// Isolated source extraction can expose a test WeakMap but never the live map.
// No real HTTP object or acquisition function is exposed by this harness.
function privateHarness({
  guard = () => {},
  readback = async () => ({
    expected: { marker: 1 },
    observedAt: Date.now(),
    admissionExpiresAt: Date.now() + 60_000,
    observations: [],
  }),
} = {}) {
  const text = authoritySource
    .replace(/^import[\s\S]*?;\r?\n/gm, '')
    .replace(/^export /gm, '')
    .replace('function assertOwnedLocal(state)', 'function disabledAssertOwnedLocal(state)')
    .replace(
      'async function readCurrent(config, bearer)',
      'async function disabledReadCurrent(config, bearer)',
    );
  return vm.runInNewContext(
    `${text}\nconst assertOwnedLocal=__guard, readCurrent=__read;\n({authorities,consumeCase20PresubmissionRecoveryAuthority,recheckCase20PresubmissionRecoveryAuthority,inspectCase20PresubmissionRecoveryAuthority,writeExclusiveRecoveryClaim,readStableFile});`,
    {
      ...fs,
      ...path,
      createHash,
      isDeepStrictEqual,
      sha256Stable,
      inspectControlledReadAdmission,
      inspectControlledReadScope,
      Buffer,
      structuredClone,
      process,
      Date,
      __guard: guard,
      __read: readback,
    },
  );
}
function fakeState() {
  return {
    local: { checkpoint: {}, scope: {}, descriptors: {} },
    proof: { expected: { marker: 1 }, observations: [] },
    claimDescriptor: { sha256: 'a'.repeat(64) },
    restored: false,
    recheckStarted: false,
    rechecked: null,
    submissionConsumed: false,
    failed: false,
  };
}
test('restoration, HTTP recheck and immediate submission fence are independently one-use', async () => {
  const h = privateHarness(),
    cap = Object.freeze({}),
    state = fakeState();
  h.authorities.set(cap, state);
  const p = h.consumeCase20PresubmissionRecoveryAuthority(cap);
  assert.throws(() => h.consumeCase20PresubmissionRecoveryAuthority(cap));
  assert.throws(() => p.assertSubmission());
  await h.recheckCase20PresubmissionRecoveryAuthority({
    authority: cap,
    bearer: 'unit',
    invocation: 'RECHECK_SAME_CASE20_BEFORE_FIRST_SUBMISSION_ONCE',
  });
  await assert.rejects(
    h.recheckCase20PresubmissionRecoveryAuthority({
      authority: cap,
      bearer: 'unit',
      invocation: 'RECHECK_SAME_CASE20_BEFORE_FIRST_SUBMISSION_ONCE',
    }),
  );
  p.assertSubmission();
  assert.throws(() => p.assertSubmission());
  assert.equal(h.inspectCase20PresubmissionRecoveryAuthority(cap).submissionFenceConsumed, true);
});
test('failed recheck poisons authority and cannot be repaired by calling again', async () => {
  const h = privateHarness({
      readback: async () => {
        throw new Error('changed current metadata');
      },
    }),
    cap = {},
    state = fakeState();
  h.authorities.set(cap, state);
  const p = h.consumeCase20PresubmissionRecoveryAuthority(cap);
  await assert.rejects(
    h.recheckCase20PresubmissionRecoveryAuthority({
      authority: cap,
      bearer: 'unit',
      invocation: 'RECHECK_SAME_CASE20_BEFORE_FIRST_SUBMISSION_ONCE',
    }),
  );
  assert.throws(() => p.assertSubmission());
  assert.throws(() => p.assertOwned());
  assert.equal(h.inspectCase20PresubmissionRecoveryAuthority(cap).failed, true);
});
test('changed owned evidence rejects restoration and failed consume is not reusable', () => {
  const h = privateHarness({
      guard: () => {
        throw new Error('changed claim');
      },
    }),
    cap = {};
  h.authorities.set(cap, fakeState());
  assert.throws(() => h.consumeCase20PresubmissionRecoveryAuthority(cap));
  assert.throws(() => h.consumeCase20PresubmissionRecoveryAuthority(cap));
});
test('stale post-prepare HTTP proof refuses the native submission fence', () => {
  const h = privateHarness(),
    cap = {},
    state = fakeState();
  h.authorities.set(cap, state);
  const p = h.consumeCase20PresubmissionRecoveryAuthority(cap);
  state.rechecked = { observedAt: Date.now() - 31_000, admissionExpiresAt: Date.now() + 60_000 };
  assert.throws(() => p.assertSubmission());
});
test('live exported recheck rejects forged JSON before any endpoint call', async () => {
  await assert.rejects(
    recheckCase20PresubmissionRecoveryAuthority({
      authority: {},
      bearer: 'unit',
      invocation: 'RECHECK_SAME_CASE20_BEFORE_FIRST_SUBMISSION_ONCE',
    }),
  );
});

const temp = fs.mkdtempSync(path.join(tmpdir(), 'meri-case20-presubmission-unit-'));
test('exclusive fsynced claim preserves existing evidence and detects same-byte replacement', () => {
  const h = privateHarness(),
    p = path.join(temp, 'claim.json');
  const d = h.writeExclusiveRecoveryClaim(p, { unit: true });
  assert.equal(d.sha256, hash(fs.readFileSync(p)));
  assert.throws(() => h.writeExclusiveRecoveryClaim(p, { unit: false }));
  const bytes = fs.readFileSync(p);
  fs.renameSync(p, path.join(temp, 'retained-claim.json'));
  fs.writeFileSync(p, bytes, { flag: 'wx' });
  assert.notEqual(h.readStableFile(p).descriptor.identity, d.identity);
});
test('two real local processes cannot both acquire the same exclusive recovery claim', async () => {
  const p = path.join(temp, 'concurrent.json');
  const helper = authoritySource.slice(
    authoritySource.indexOf('function identity(stat)'),
    authoritySource.indexOf('/** Pure checks only.'),
  );
  const script = path.join(temp, 'claim-process.mjs');
  fs.writeFileSync(
    script,
    `import {closeSync,lstatSync,openSync,writeFileSync,fsyncSync,fstatSync,readFileSync,realpathSync} from 'node:fs';\nimport {resolve,dirname,parse} from 'node:path';\nimport {createHash} from 'node:crypto';\nimport {isDeepStrictEqual} from 'node:util';\nconst hash=x=>createHash('sha256').update(x).digest('hex'),need=(x)=>{if(!x)throw Error('refused')};\n${helper}\ntry {writeExclusiveRecoveryClaim(process.argv[2],{unit:true});process.exitCode=0;}catch{process.exitCode=1;}\n`,
  );
  const child = () =>
    new Promise((done, reject) => {
      const c = spawn(process.execPath, [script, p], { windowsHide: true, stdio: 'ignore' });
      c.on('error', reject);
      c.on('exit', done);
    });
  assert.deepEqual((await Promise.all([child(), child()])).sort(), [0, 1]);
});

// A test-only copied module cannot create live authority: its root/helper and
// opaque proof/outcome collaborators are replaced, never production exports.
async function nativeFixture() {
  const root = fs.mkdtempSync(path.join(temp, 'native-'));
  fs.writeFileSync(path.join(root, 'fresh-spend.jsonl'), reservedJournal);
  fs.writeFileSync(path.join(root, 'run-authorization.json'), originalAuthorization);
  const wrapper = path.join(root, 'unit-helper.py'),
    helper = fileURLToPath(new URL('../lib/windows-capture-spend.py', import.meta.url));
  fs.writeFileSync(
    wrapper,
    `import json,runpy,sys\nm=runpy.run_path(${JSON.stringify(helper)})\ng=m['execute'].__globals__\ng['FRESH_ROOT']=${JSON.stringify(path.resolve(root))}\nr=json.load(sys.stdin)\nif r.get('op')=='unit_checkpoint':\n r['op']='fresh_adopt'\n old=g['reduce_fresh']\n def initial(w):\n  s=old(w);s['eventCount']=20;s['activeRun']=None;return s\n g['reduce_fresh']=initial\n v=m['execute'](r);g['reduce_fresh']=old;v['snapshot']=old(open(r['root']+'/fresh-spend.jsonl','rb').read())\nelse:\n v=m['execute'](r)\nprint(json.dumps({'ok':True,**v}))\n`,
  );
  const python = 'C:/Users/neoma/AppData/Local/hermes/hermes-agent/venv/Scripts/python.exe';
  const { spawnSync } = await import('node:child_process');
  const result = spawnSync(python, ['-I', wrapper], {
    input: JSON.stringify({ op: 'unit_checkpoint', root: path.resolve(root) }),
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr);
  const actual = JSON.parse(result.stdout),
    checkpoint = {
      kind: 'meri-fresh-capture-spend-checkpoint',
      version: 1,
      state: actual.state,
      snapshot: actual.snapshot,
    };
  const proof = {
    checkpoint,
    expected: inspectControlledReadScope(evidence.scope, { MERI_LIVE_BEARER_TOKEN: 'unit' }).expected,
    reservation: {
      caseId: '20',
      captureRunId: run,
      reservationId: '7ea73cdc-526e-4b31-8c28-b0636ea8d2ae',
      ceilingMicros: 15_000_000,
    },
  };
  const fake = path.join(root, 'unit-authority.mjs');
  fs.writeFileSync(
    fake,
    `export const authority={};let used=false,ready=false,submitted=false;const proof=${JSON.stringify(proof)};export function consumeCase20PresubmissionRecoveryAuthority(x){if(x!==authority||used)throw Error('forged');used=true;return {...proof,assertOwned(){},assertSubmission(){if(!ready||submitted)throw Error('recheck required');submitted=true;}};}export function recheck(){ready=true;}\n`,
  );
  let source = aggregateSource
    .replace(/from '(\.\/[^']+)'/gu, (_m, ref) => `from '${new URL(ref, aggregateUrl).href}'`)
    .replace(
      `from '${new URL('../case20-presubmission-recovery-authority.mjs', import.meta.url).href}'`,
      `from '${pathToFileURL(fake).href}'`,
    )
    .replace(
      "const freshRoot = 'C:/dev/main/outputs/meri-fresh-20261003';",
      `const freshRoot = ${JSON.stringify(path.resolve(root))};`,
    )
    .replace(
      "const helper = fileURLToPath(new URL('./lib/windows-capture-spend.py', import.meta.url));",
      `const helper = ${JSON.stringify(wrapper)};`,
    )
    .replace(
      'currentControlledReadCaptureAuthority }',
      'currentControlledReadCaptureAuthority as unusedActualControlledAuthority }',
    );
  source += '\nfunction currentControlledReadCaptureAuthority(outcome){return outcome.unitAuthority;}\n';
  const modulePath = path.join(root, 'unit-spend.mjs');
  fs.writeFileSync(modulePath, source);
  return {
    root,
    proof,
    python,
    module: await import(pathToFileURL(modulePath).href),
    control: await import(pathToFileURL(fake).href),
  };
}
test('actual native copy restores same reservation without append and existing settlement appends once', async () => {
  const f = await nativeFixture(),
    before = fs.readFileSync(path.join(f.root, 'fresh-spend.jsonl'));
  const { owner, reservation } = f.module.restoreCase20PresubmissionCaptureSpend(
    f.control.authority,
    { pythonExecutable: f.python, invocation: 'RESTORE_SAME_CASE20_UNSUBMITTED_RESERVATION_ONCE' },
  );
  assert.equal(reservation.reservationId, f.proof.reservation.reservationId);
  assert.deepEqual(fs.readFileSync(path.join(f.root, 'fresh-spend.jsonl')), before);
  assert.throws(() =>
    owner.reserve({ caseId: '20', captureRunId: run, ceilingMicros: 15_000_000 }),
  );
  assert.throws(() =>
    f.module.claimCaptureSpendReservation(reservation, {
      ...f.proof.expected,
      conversationId: run,
    }),
  );
  f.module.claimCaptureSpendReservation(reservation, f.proof.expected);
  assert.throws(() => f.module.claimCaptureSpendReservation(reservation, f.proof.expected));
  assert.throws(() => f.module.assertCaptureSpendReservation(reservation, f.proof.expected));
  f.control.recheck();
  f.module.assertCaptureSpendReservation(reservation, f.proof.expected);
  assert.throws(() => f.module.assertCaptureSpendReservation(reservation, f.proof.expected));
  const envelope = {
    receipt: {
      caseId: '20',
      captureRunId: run,
      providerBudget: {
        status: 'SETTLED',
        maxCostMicros: 15_000_000,
        unaccountedBoundaries: [],
        chargedCostMicros: 1234,
        ledgerSha256: 'c'.repeat(64),
      },
    },
  };
  const outcome = {
    unitAuthority: {
      evidence: {
        inputs: { expected: { ...f.proof.expected, assistantMessageId: 'unit' }, envelope },
      },
    },
  };
  owner.settleCaptured(reservation, outcome);
  const after = fs.readFileSync(path.join(f.root, 'fresh-spend.jsonl'));
  assert.deepEqual(after.subarray(0, before.length), before);
  assert.equal(after.toString().trimEnd().split('\n').length, 24);
  assert.equal(owner.checkpoint().snapshot.knownSettledCostMicros, 12_135_117);
  assert.equal(owner.checkpoint().snapshot.activeRun, null);
  assert.throws(() => owner.settleCaptured(reservation, outcome));
});
test('actual native checkpoint drift refuses restore and preserves full original ceiling', async () => {
  const f = await nativeFixture(),
    p = path.join(f.root, 'fresh-spend.jsonl');
  fs.appendFileSync(p, '\n');
  const changed = fs.readFileSync(p);
  assert.throws(() =>
    f.module.restoreCase20PresubmissionCaptureSpend(f.control.authority, {
      pythonExecutable: f.python,
      invocation: 'RESTORE_SAME_CASE20_UNSUBMITTED_RESERVATION_ONCE',
    }),
  );
  assert.throws(() =>
    f.module.restoreCase20PresubmissionCaptureSpend(f.control.authority, {
      pythonExecutable: f.python,
      invocation: 'RESTORE_SAME_CASE20_UNSUBMITTED_RESERVATION_ONCE',
    }),
  );
  assert.deepEqual(fs.readFileSync(p), changed);
  assert.equal(f.proof.checkpoint.snapshot.committedCostMicros, 27_133_883);
});
