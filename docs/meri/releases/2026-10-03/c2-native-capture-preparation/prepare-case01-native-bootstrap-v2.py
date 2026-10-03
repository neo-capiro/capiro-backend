from pathlib import Path
import difflib
import hashlib
import json

ROOT = Path('C:/dev/main/outputs/meri-c2-20261003')
OLD = ROOT / 'case01-native-bootstrap-v1'
OUT = ROOT / 'case01-native-bootstrap-v2'


def render():
    old_bytes = (OLD / 'run-case01-native.mjs').read_bytes()
    assert hashlib.sha256(old_bytes).hexdigest() == '900de5773947e389f25afb50af7b66a2e61cab7a1f360ff5121cf8332dab3485'
    original = old_bytes.decode('utf-8')
    script = original

    def replace(before, after):
        nonlocal script
        assert script.count(before) == 1, before[:100]
        script = script.replace(before, after)

    replace("import { frozenFixture } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/fixture.mjs';",
            "import { frozenFixture } from 'file:///C:/dev/main/meri-c1-20261002/evals/meri/live-v1/fixture.mjs';\nimport { assertCase01PreparedDeployment, case01SubmissionObservation } from './case01-prepared-guards.mjs';")
    replace('export function buildCase01Scope(input) {',
            "export function buildCase01Scope(input) {\n  // Pure exact candidate check precedes receipt/file access and all journal work.\n  assertCase01PreparedDeployment(input?.deployment);")
    replace("    if (!summary) return;\n    const bytes = JSON.stringify(summary, null, 2) + '\\n';",
            "    if (!summary) return;\n    summary.submissionObservation = case01SubmissionObservation(summary);\n    const bytes = JSON.stringify(summary, null, 2) + '\\n';")
    replace('      conversationCreationAttempted: false,',
            '      conversationCreationAttempted: false,\n      executionAttempted: false,')
    replace('    const outcome = await executeCase01LiveCapture(capability);',
            """    // Persist uncertainty before entering the native owner. A thrown error can
    // follow a submitted stream or a failed artifact finalization; never infer zero.
    summary.executionAttempted = true;
    summary.executionIntent = {
      phase: 'EXECUTE_CASE01_LIVE_CAPTURE',
      captureRunId: config.captureRunId,
      conversationId: config.conversationId,
      recordedAt: new Date().toISOString(),
      automaticPaidRetryAllowed: false,
      uncertainReservationRetained: true,
    };
    persist(); // fsync event history and current summary before native dispatch.
    const outcome = await executeCase01LiveCapture(capability);""")
    replace('          turnsSent: summary.outcome?.synthesisSubmissionCount ?? 0,',
            '          ...summary.submissionObservation,')

    deployment = {
        'apiSha': '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642',
        'orchestratorSha': 'fb17c7ebfa010ce964919068f61830cb78ca620d',
        'builds': {
            'api': {
                'service': 'api',
                'sourceSha': '5b086a6b47ffce5aa1b93bfe38f9c7b96e297642',
                'imageDigest': 'sha256:d20110a114ef51a7db3d352321f411a2f51cc8b1877f9ccec6d1f35d7701c8cd',
                'buildId': 'capiro-build-web-dev:01196b56-83c6-47a9-97a1-11004413a7ee',
                'buildspecSha256': 'c92763d03d141e59d18485c4d9f6ac3958392ff18e0bbaf501dd116cc39f4c3c',
            },
            'meriv2-orchestrator': {
                'service': 'meriv2-orchestrator',
                'sourceSha': 'fb17c7ebfa010ce964919068f61830cb78ca620d',
                'imageDigest': 'sha256:2b3ac021d0e5149478bb480c3ed572151bd8b03e08b2a74fd1227af829a06436',
                'buildId': 'capiro-build-web-dev:d6486a5b-9ab2-4410-bba0-3a5afb2f0b2c',
                'buildspecSha256': '330e33036707a5ce89befa560312635f7261a88d6eb18d73e7cb73af9093c332',
            },
        },
    }
    guards = """import { isDeepStrictEqual } from 'node:util';

// This pure comparison is a prepared expectation, never live release authority.
// readCase01BuildAuthority and native admission still reread the actual release.
const exactDeployment = DEPLOYMENT;

export function assertCase01PreparedDeployment(deployment) {
  if (!isDeepStrictEqual(deployment, exactDeployment)) {
    const error = new Error('CASE01_EXACT_DEPLOYMENT_REQUIRED');
    error.safeCode = 'CASE01_EXACT_DEPLOYMENT_REQUIRED';
    throw error;
  }
}

export function case01SubmissionObservation(summary) {
  const count = summary?.outcome?.synthesisSubmissionCount;
  if (Number.isSafeInteger(count) && count >= 0 && count <= 1)
    return { turnsSent: count, turnsSentStatus: 'OBSERVED_NATIVE_OUTCOME' };
  return summary?.executionAttempted === true
    ? { turnsSent: null, turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT' }
    : { turnsSent: 0, turnsSentStatus: 'NOT_ATTEMPTED' };
}
""".replace('DEPLOYMENT', json.dumps(deployment, indent=2), 1)
    template = json.loads((OLD / 'scope-input.template.json').read_text(encoding='utf-8'))
    template['deployment'] = deployment
    tests = """import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assertCase01PreparedDeployment, case01SubmissionObservation } from './case01-prepared-guards.mjs';

const expected = JSON.parse(readFileSync(new URL('./scope-input.template.json', import.meta.url))).deployment;
const rejected = (value) => assert.throws(() => assertCase01PreparedDeployment(value),
  { safeCode: 'CASE01_EXACT_DEPLOYMENT_REQUIRED' });
test('exact prepared pair passes pure comparison only', () => {
  assert.equal(assertCase01PreparedDeployment(structuredClone(expected)), undefined);
});
test('older valid-shaped orchestrator ancestor is refused', () => {
  const old = structuredClone(expected);
  old.orchestratorSha = 'ed44f2c6cfdfda5150f75ab198a6e52d2377880f';
  old.builds['meriv2-orchestrator'].sourceSha = old.orchestratorSha;
  old.builds['meriv2-orchestrator'].imageDigest = 'sha256:53b06f768d8a26a8a5c6124f0f7bb55a0e2117fde050706360c6108c98887faa';
  rejected(old);
});
for (const service of ['api', 'meriv2-orchestrator']) {
  for (const field of ['imageDigest', 'buildId', 'buildspecSha256']) {
    test(`same ${service} source with changed ${field} is refused`, () => {
      const changed = structuredClone(expected);
      changed.builds[service][field] += '-changed';
      rejected(changed);
    });
  }
}
test('additional or missing build fields cannot widen expectation', () => {
  rejected({ ...expected, otherSource: expected.apiSha });
  const missing = structuredClone(expected);
  delete missing.builds.api.imageDigest;
  rejected(missing);
});
test('execution intent without returned outcome preserves unknown submission', () => {
  assert.deepEqual(case01SubmissionObservation({ executionAttempted: true }),
    { turnsSent: null, turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT' });
});
test('no execution attempt truthfully reports zero', () => {
  assert.deepEqual(case01SubmissionObservation({ executionAttempted: false }),
    { turnsSent: 0, turnsSentStatus: 'NOT_ATTEMPTED' });
});
test('actual native count survives attempted execution', () => {
  for (const count of [0, 1]) assert.deepEqual(case01SubmissionObservation({
    executionAttempted: true, outcome: { synthesisSubmissionCount: count } }),
    { turnsSent: count, turnsSentStatus: 'OBSERVED_NATIVE_OUTCOME' });
});
test('invalid or missing native count after intent stays unknown', () => {
  for (const count of [undefined, null, -1, 2, '0']) assert.deepEqual(case01SubmissionObservation({
    executionAttempted: true, outcome: { synthesisSubmissionCount: count } }),
    { turnsSent: null, turnsSentStatus: 'UNKNOWN_AFTER_EXECUTION_INTENT' });
});
"""
    readme = """# Case 01 native bootstrap v2 — prepared, not executed

This preserves the reviewed v1 native composition and fixes its two P2 findings.
The v1 source, checkpoint, review, and evidence remain unchanged. See the v1 README
for canonical scope, original prompt, budget, one-owner settlement, authentication,
storage, and failure handling. No fixture, native owner, production source, rates,
model, configuration, or acceptance standard changes here.

## Exact release requirement

`case01-prepared-guards.mjs` performs a pure equality check against the qualified
API `5b086a6b` / `d20110a1…` and orchestrator `fb17c7eb` / `2b3ac021…`, including each
exact CodeBuild ID and buildspec hash. `buildCase01Scope` calls it before setup
receipt access, journal adoption, reservation, authentication, or conversation
creation. An older valid ancestor cannot satisfy this expectation. Existing live
AWS build/served checks and native admission are still required and grant actual
authority; the pure helper and filled template do not grant it.

The template fills only these now-qualified build expectations. The actual setup
receipt, its hash, private manifest hash, clean operator commit and served web
source still need a new reviewed scope after setup succeeds.

## Truthful uncertain execution

Immediately before entering `executeCase01LiveCapture`, the operator records an
execution intent and fsyncs both its append-only event history and current summary.
After that intent, a missing/invalid returned submission count is recorded as
`turnsSent: null` / `UNKNOWN_AFTER_EXECUTION_INTENT`, including final console output.
An actual native count remains authoritative. Zero is emitted before an attempt
or when the native outcome explicitly observes zero. No automatic retry, refund,
second settlement, or reservation release is added.

## Validation and remaining work

The tests import only the pure guard module and built-in Node modules. They cover
the exact pair, old orchestrator, changed immutable build fields, shape changes,
and known/unknown submission outcomes. Syntax checks and byte-for-byte offline
reproduction cover the complete generated operator. These checks do not import or
execute the operator, authenticate, call an owner, open a journal, create a
conversation, or call any provider. Independent review and actual authorized
release/setup/capture remain separate. Full File 01 acceptance stays NOT_RUN and
requires human adjudication after real evidence exists.

Use v2 explicitly after its review. Both versions retain the same exclusive run
ID/output claim, so they cannot be used to launch duplicate runs. Never run v1.
"""
    diff = ''.join(difflib.unified_diff(original.splitlines(True), script.splitlines(True),
                                     fromfile='v1/run-case01-native.mjs', tofile='v2/run-case01-native.mjs'))
    return {
        'run-case01-native.mjs': script.encode('utf-8'),
        'case01-prepared-guards.mjs': guards.encode('utf-8'),
        'case01-prepared-guards.test.mjs': tests.encode('utf-8'),
        'scope-input.template.json': (json.dumps(template, indent=2) + '\n').encode('utf-8'),
        'v1-to-v2.diff': diff.encode('utf-8'),
        'README.md': readme.encode('utf-8'),
    }


if __name__ == '__main__':
    files = render()
    OUT.mkdir()
    for name, data in files.items():
        with (OUT / name).open('xb') as stream:
            stream.write(data)
    print(json.dumps({'status': 'PREPARED_NOT_EXECUTED', 'files': len(files),
                      'scriptSha256': hashlib.sha256(files['run-case01-native.mjs']).hexdigest()}))
