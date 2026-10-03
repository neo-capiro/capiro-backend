from pathlib import Path
import difflib

repo = Path('C:/dev/main/meri-c1-20261002')
out = Path(__file__).parent
original = (repo / 'evals/meri/live-v1/run-controlled-read.mjs').read_text(encoding='utf-8')
script = original
def replace(old, new):
    global script
    assert script.count(old) == 1, old[:120]
    script = script.replace(old, new)

replace("  prepareControlledReadLiveCapture,\n  executeControlledReadLiveCapture,\n  inspectControlledReadScope,\n} from './controlled-read-live-capture.mjs';", "  prepareCase01LiveCapture,\n  executeCase01LiveCapture,\n  inspectCase01Scope,\n} from './case01-live-capture.mjs';")
replace("import { gradeControlledReadCapturedOutcome } from './grade-controlled-read-capture.mjs';", "import { gradeCase01CapturedOutcome } from './grade-case01-capture.mjs';")
replace("import { openCaptureSpendAggregate } from './capture-spend-aggregate.mjs';", "import { adoptExistingFreshCaptureSpend, openCaptureSpendAggregate } from './capture-spend-aggregate.mjs';")
replace("import {\n  controlledReadSetupInput,\n  inspectControlledReadSetupReceipt,\n} from './controlled-read-operator-input.mjs';", "import { inspectControlledConversationReadback, controlledReadBrowserRequestAllowed } from './run-controlled-read.mjs';\nimport { sha256Stable } from './artifact-collector.mjs';\nimport { frozenFixture } from './fixture.mjs';")
replace("const repo = fileURLToPath(new URL('../../../', import.meta.url));", "const repo = 'C:/dev/main/meri-c1-20261002';")
replace("const require = createRequire(new URL('../../../apps/api/package.json', import.meta.url));", "const require = createRequire('C:/dev/main/meri-c1-20261002/apps/api/package.json');")
start = script.index('export function inspectControlledConversationReadback(')
end = script.index('function creationTransport(', start)
script = script[:start] + script[end:]
start = script.index('export function controlledReadBrowserRequestAllowed(')
end = script.index('export function assertControlledReadSyntheticIdentity(', start)
script = script[:start] + script[end:]
replace("function creationTransport(config, bearer) {", "function creationTransport(config, bearer, observe) {")
replace("              need(response.statusCode === (post ? 201 : 200), 'CREATION_HTTP_FAILED');", "              const raw = Buffer.concat(chunks);\n              // Save actual response identity/status before rejecting HTTP or JSON.\n              observe({ method: post ? 'POST' : 'GET', path, status: response.statusCode,\n                sourceSha: response.headers['x-capiro-release-sha'] ?? null,\n                bytes: raw.length, bodySha256: hash(raw), observedAt: new Date().toISOString() });\n              need(response.statusCode === (post ? 201 : 200), 'CREATION_HTTP_FAILED');")
replace("                value: JSON.parse(Buffer.concat(chunks).toString('utf8')),", "                value: JSON.parse(raw.toString('utf8')),")
old = """  const input = controlledReadSetupInput(manifest, {
    caseId: config.caseId,
    captureRunId: config.captureRunId,
    clientId: config.scope.clients.ASTER.physicalId,
  });"""
new = """  const input = { ctx: fixedContext };
  need(manifest?.namespace === namespace && manifest.target === 'capiro-dev' &&
    manifest.status === 'ready' && manifest.ids?.tenants?.t1?.tenantId === fixedContext.tenantId &&
    manifest.ids?.users?.pat?.userId === fixedContext.userId &&
    manifest.ids?.users?.pat?.clerkUserId === fixedContext.clerkUserId &&
    config.caseId === '01' && config.captureRunId === fixedRun &&
    config.scope.clients.ASTER.physicalId === fixedClient, 'CASE01_MANIFEST_SCOPE_MISMATCH');"""
replace(old, new)
script = script.replace('assertControlledReadSyntheticIdentity', 'assertCase01SyntheticIdentity')
script = script.replace('runControlledReadOperator', 'runCase01Operator')
script = script.replace('prepareControlledReadLiveCapture', 'prepareCase01LiveCapture')
script = script.replace('executeControlledReadLiveCapture', 'executeCase01LiveCapture')
script = script.replace('gradeControlledReadCapturedOutcome', 'gradeCase01CapturedOutcome')
script = script.replace('inspectControlledReadScope', 'inspectCase01Scope')
script = script.replace('--execute-original-controlled-read-once', '--execute-original-case01-once')
script = script.replace('CONTROLLED_READ_OPERATOR_FAILED', 'CASE01_OPERATOR_FAILED')

replace("  let clerk, browser, createdSessionId, summary, output;\n  const persist = () => {\n    if (summary) writeFileSync(output, JSON.stringify(summary, null, 2) + '\\n', { mode: 0o600 });\n  };", """  let clerk, browser, createdSessionId, summary, output, eventPath, sequence = 0;
  const persist = () => {
    if (!summary) return;
    const bytes = JSON.stringify(summary, null, 2) + '\\n';
    // The append-only fsynced history survives later summary replacement/failure.
    const fd = openSync(eventPath, 'a', 0o600);
    try { writeFileSync(fd, JSON.stringify({ sequence: ++sequence, at: new Date().toISOString(), summary }) + '\\n'); fsyncSync(fd); }
    finally { closeSync(fd); }
    writeFileSync(output, bytes, { mode: 0o600 });
    const current = openSync(output, 'r+');
    try { fsyncSync(current); } finally { closeSync(current); }
  };""")
start = script.index('    const {\n      config,\n      setupReceipt,')
end = script.index("    need(config?.conversationId === null", start)
script = script[:start] + """    const scopeBytes = readFileSync(scopePath);
    const input = JSON.parse(scopeBytes.toString('utf8').replace(/^\\uFEFF/u, ''));
    const { config, expectedWebSha, qualificationExpiresAt, operatorSourceSha, setupProof } = buildCase01Scope(input);
    need(resolve(outRoot) === resolve(fixedOutput), 'EXACT_OWNED_OUTPUT_REQUIRED');
    need(hash(readFileSync(manifestPath)) === input.manifestSha256, 'MANIFEST_BYTES_CHANGED');
""" + script[end:]
start = script.index('    // New operator-only files need not trigger')
end = script.index('    const manifest = read(manifestPath);', start)
script = script[:start] + """    // API source remains fixed. The only later orchestrator delta permitted by
    // this preparation is the known test fixture correction, plus documentation.
    need(config.deployment.apiSha === fixedApiSource, 'API_SOURCE_CHANGED');
    git('merge-base', '--is-ancestor', fixedApiSource, 'HEAD');
    git('merge-base', '--is-ancestor', config.deployment.orchestratorSha, 'HEAD');
    need(git('diff', '--name-only', fixedApiSource + '..HEAD').split('\\n').every(path =>
      !path || path.startsWith('docs/') ||
      path === 'apps/meriv2-orchestrator/src/meri/meriv3/meriv3-governed-artifact-dispatch.spec.ts'),
      'RUNNER_SOURCE_MISMATCH');
""" + script[end:]
start = script.index('    inspectControlledReadSetupReceipt(')
end = script.index("    need(process.platform === 'win32'", start)
script = script[:start] + script[end:]
replace("    output = join(outRoot, 'execution.json');", "    output = join(outRoot, 'execution.json');\n    eventPath = join(outRoot, 'execution-events.jsonl');")
replace("      sourceSha: config.deployment.apiSha,", "      sourceSha: config.deployment.apiSha,\n      orchestratorSha: config.deployment.orchestratorSha,\n      scopeFileSha256: hash(scopeBytes),\n      manifestSha256: input.manifestSha256,\n      setupProof,\n      creationHttpObservations: [],\n      automaticPaidRetryAllowed: false,")
replace("    const spendOwner = openCaptureSpendAggregate(aggregateCheckpoint, {", """    const aggregateCheckpoint = adoptExistingFreshCaptureSpend({ pythonExecutable });
    need(aggregateCheckpoint.kind === 'meri-fresh-capture-spend-checkpoint' &&
      aggregateCheckpoint.snapshot.eventCount === 20 && aggregateCheckpoint.snapshot.activeRun === null &&
      aggregateCheckpoint.snapshot.knownSettledCostMicros === 9841281 &&
      aggregateCheckpoint.snapshot.remainingReservationMicros === 20158719 &&
      aggregateCheckpoint.snapshot.historicalPrefixSha256 === freshPrefix &&
      aggregateCheckpoint.state.files['fresh-spend.jsonl'].sha256 === freshPrefix &&
      aggregateCheckpoint.state.files['run-authorization.json'].sha256 === freshAuthorization,
      'FRESH_HISTORY_CHANGED');
    writeExclusive(join(outRoot, 'aggregate-adopted-checkpoint.json'), aggregateCheckpoint);
    summary.reservationIntent = { caseId: '01', captureRunId: fixedRun, ceilingMicros: 15000000,
      aggregateLimitMicros: 30000000, concurrency: 1, retryAllowed: false };
    persist();
    const spendOwner = openCaptureSpendAggregate(aggregateCheckpoint, {""")
replace("    const transport = creationTransport(config, bearer);", """    const transport = creationTransport(config, bearer, observation => {
      summary.creationHttpObservations.push(observation);
      persist();
    });""")
replace("    saveSpendCheckpoint('aggregate-final-checkpoint.json');\n    summary.outcome = outcome;\n    persist();", """    summary.outcome = outcome;
    persist(); // Preserve failed/uncertain native result before checkpoints/assertions.
    saveSpendCheckpoint('aggregate-final-checkpoint.json');""")
replace("    const signedIn = await page.evaluate(async (token) => {", "    summary.signInAttempted = true;\n    persist();\n    const signedIn = await page.evaluate(async (token) => {")
replace("    summary.capturePrepared = true;\n    persist();", """    summary.capturePrepared = true;
    const admitted = JSON.parse(storage.readBytes('admission.json').toString('utf8')).admission;
    summary.nativeAdmissionReadback = {
      qualificationSha256: admitted?.providerBudget?.qualificationSha256 ?? null,
      currentVerifySha256: admitted?.fixture?.currentVerifySha256 ?? null,
    };
    persist();
    need(summary.nativeAdmissionReadback.qualificationSha256 === setupProof.qualificationSha256 &&
      summary.nativeAdmissionReadback.currentVerifySha256 === setupProof.currentVerifySha256,
      'CASE01_NATIVE_SETUP_CHANGED');
    // execute itself rechecks the exact admission fixture/providerBudget again.
""")
replace("  } finally {\n    if (createdSessionId && clerk) {", """  } finally {
    if (summary?.signInAttempted && !createdSessionId) {
      summary.sessionCleanupUnconfirmed = true;
      summary.verdict = 'BLOCKED';
      summary.cleanupReason = 'SIGN_IN_ACKNOWLEDGEMENT_UNKNOWN_RECONCILIATION_REQUIRED';
    }
    if (createdSessionId && clerk) {""")
replace("      summary.failureCode = error.safeCode || 'CASE01_OPERATOR_FAILED';", "      summary.failureCode = safeFailure(error);")
replace("          code: error.safeCode || 'CASE01_OPERATOR_FAILED',", "          code: safeFailure(error),")
replace("      { flag: 'wx', mode: 0o600 },\n    );\n    output =", "      { flag: 'wx', mode: 0o600 },\n    );\n    const claimFd = openSync(join(claims, `${config.caseId}-${config.captureRunId}.json`), 'r+');\n    try { fsyncSync(claimFd); } finally { closeSync(claimFd); }\n    output =")
replace("kind: 'meri-controlled-read-one-shot-claim'", "kind: 'meri-native-case01-one-shot-claim'")

boundary = script.index('function creationTransport(')
helper = (out / 'scope-helpers.txt').read_text(encoding='utf-8')
script = script[:boundary] + helper + '\n' + script[boundary:]
# Imports use the exact existing module instances, keeping WeakMap authorities shared.
script = script.replace("from './", "from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/")
destination = out / 'run-case01-native.mjs'
with destination.open('x', encoding='utf-8', newline='\n') as handle:
    handle.write(script)
with (out / 'adaptation.diff').open('x', encoding='utf-8', newline='\n') as handle:
    handle.write(''.join(difflib.unified_diff(original.splitlines(True), script.splitlines(True),
      fromfile='source/evals/meri/live-v1/run-controlled-read.mjs', tofile='prepared/run-case01-native.mjs')))
print(f'Prepared {len(script.splitlines())} lines; no runner import or execution')
