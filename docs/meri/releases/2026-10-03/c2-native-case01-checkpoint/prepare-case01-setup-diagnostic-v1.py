from pathlib import Path
import hashlib
import json
import datetime

root = Path('C:/dev/main/outputs/meri-c2-20261003')
dest = root / 'case01-native-setup-diagnostic-v1'
sha = lambda b: hashlib.sha256(b).hexdigest()
dest.mkdir()
def save(path, data):
    with path.open('xb') as stream:
        stream.write(data)
body = (root / 'case01-native-setup-v1/case01-native-setup-inner.mjs').read_bytes()
assert sha(body) == '632d00e47ec63fb8c0b49cfa0d166760bd16abbf5ded9b572c0a9cf235f9899d'
text = body.decode()
def replace(old, new):
    global text
    assert text.count(old) == 1, old
    text = text.replace(old, new)
replace("let factory, output, stage = 'VALIDATING', sequence = 0;", "let factory, output, stage = 'VALIDATING', sequence = 0, diagnosticSubstage = 'START';")
replace("assert.ok(['plan', 'execute'].includes(mode));", "assert.equal(mode, 'plan', 'DIAGNOSTIC_READ_ONLY_PLAN_REQUIRED');")
start = text.index('    assert.equal(input.planSha256, sha256Stable(input.plan));')
end = text.index('\n  });\n  stage = \'COMPLETE\';', start)
text = text[:start] + "    throw new Error('DIAGNOSTIC_EXECUTE_FORBIDDEN');" + text[end:]
assert 'owner.bind(' not in text and 'await installCaptureProviderBudgetQualification(' not in text
for line, step in [
    ('const inventory = await readCase01MemoryCorpusInTx', 'READ_INVENTORY'),
    ('assert.equal(inventory.fixtureReady, true);', 'VERIFY_INVENTORY'),
    ("assert.equal(locator.fixtureNamespace, NAMESPACE);", 'VERIFY_LOCATOR'),
    ('const previousManifest = await buildFixtureManifest', 'BUILD_PREVIOUS_MANIFEST'),
    ('const currentManifest = await buildFixtureManifest', 'BUILD_CURRENT_MANIFEST'),
    ("await previous.hydrateInTx(tx, ctx, { lifecycle: 'retired' });", 'HYDRATE_PREVIOUS'),
    ("await current.hydrateInTx(tx, ctx, { lifecycle: 'current' });", 'HYDRATE_CURRENT'),
    ('actualProof = await current.qualifyInTx(tx, ctx, scope);', 'QUALIFY_CURRENT'),
    ("for (const key of ['fixtureVersion', 'physicalMapSha256', 'seedReceiptId', 'resetReceiptId', 'currentVerifySha256'])", 'COMPARE_CANONICAL_PROOF'),
    ('const bindingPlan = await owner.inspect(request);', 'OWNER_INSPECT'),
    ("assert.equal(bindingPlan.status, 'READY');", 'VERIFY_BINDING_PLAN'),
    ('const before = await savedState();', 'READ_SAVED_STATE'),
    ('assert.equal(before.tenantRowVersion, bindingPlan.expectedTenantRowVersion);', 'VERIFY_SAVED_STATE'),
    ('const qualification = qualificationFor(bindingPlan.currentVerifySha256);', 'BUILD_QUALIFICATION'),
]:
    replace(line, "diagnosticSubstage = '" + step + "';\n      " + line)
replace("const failure = { status: 'BLOCKED_OR_UNCERTAIN', code, lastStage: stage,", """const diagnostic = {
    substage: diagnosticSubstage,
    errorClass: ['AssertionError','Error','PrismaClientKnownRequestError','PrismaClientUnknownRequestError','PrismaClientInitializationError','FixtureProvisioningError','TypeError'].includes(error?.name) ? error.name : 'OTHER_ERROR_CLASS',
    errorCode: /^(?:P[0-9]{4}|ERR_ASSERTION|CASE01_[A-Z0-9_]+|CAPTURE_BINDING_[A-Z0-9_]+)$/u.test(error?.code ?? '') ? error.code : null,
    messageSha256: bytesHash(String(error?.message ?? '')),
    timeoutMentioned: /timeout|timed out|transaction already closed/iu.test(String(error?.message ?? '')),
    frames: String(error?.stack ?? '').split('\\n').slice(1).filter(line => /^\\s+at /u.test(line) && /\\/(?:app|dev\\/shm)\\//u.test(line)).slice(0,12).map(line => line.trim().slice(0,300)),
    assertionOperator: /^[A-Za-z]+$/u.test(error?.operator ?? '') ? error.operator : null,
    assertionActualType: typeof error?.actual,
    assertionExpectedType: typeof error?.expected,
    messageOmitted: true, sqlAndMetaOmitted: true,
  };
  const failure = { status: 'BLOCKED_OR_UNCERTAIN', code, lastStage: stage, diagnostic,""")
inner = text.encode()
save(dest / 'case01-native-setup-inner.mjs', inner)
for name in ['case01-reviewed-rates-v2.json', 'plan-input.json']:
    save(dest / name, (root / 'case01-native-setup-v1' / name).read_bytes())
dispatcher = (root / 'run-case01-native-setup-v4.mjs').read_text()
assert sha((root / 'run-case01-native-setup-v4.mjs').read_bytes()) == '22afe2b7715207693f179cc091d5144bb9a2a9179b70fbe91010d2b4310225ff'
dispatcher = dispatcher.replace("assert.ok(['plan','execute'].includes(mode));", "assert.equal(mode,'plan','DIAGNOSTIC_PLAN_ONLY');")
dispatcher = dispatcher.replace("packageRoot=parent+'/case01-native-setup-v1'", "packageRoot=parent+'/case01-native-setup-diagnostic-v1'")
dispatcher = dispatcher.replace("const root=parent+'/case01-native-setup-'+mode+'-v2';", "const root=parent+'/case01-native-setup-diagnostic-result-v1';")
dispatcher = dispatcher.replace('632d00e47ec63fb8c0b49cfa0d166760bd16abbf5ded9b572c0a9cf235f9899d', sha(inner))
guard = """const priorFailureBytes=readFileSync(parent+'/case01-native-setup-plan-v2/result.json');
assert.equal(hash(priorFailureBytes),'%s');
const priorFailure=JSON.parse(priorFailureBytes);
assert.equal(priorFailure.mode,'plan');
assert.equal(priorFailure.exitCode,1);
assert.equal(priorFailure.cleanup.taskStopped,true);
assert.equal(priorFailure.cleanup.taskDefinitionInactive,true);
assert.deepEqual(priorFailure.events.map(e=>[e.stage,e.phase]),[['VALIDATING','START'],['INSPECT','FAILURE']]);
""" % sha((root / 'case01-native-setup-plan-v2/result.json').read_bytes())
dispatcher = dispatcher.replace("const packet=read(parent+'/clock-provider-release-packet.json');", guard + "const packet=read(parent+'/clock-provider-release-packet.json');")
save(root / 'run-case01-native-setup-diagnostic-v1.mjs', dispatcher.encode())
record = {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'status': 'READ_ONLY_DIAGNOSTIC_PREPARED_NOT_EXECUTED',
          'innerSha256': sha(inner), 'dispatcherSha256': sha(dispatcher.encode()),
          'purpose': 'Locate failed INSPECT without retrying setup mutations or capture.',
          'readOnly': True, 'providerCalls': 0, 'executed': False,
          'retainedFailureSha256': sha((root / 'case01-native-setup-plan-v2/result.json').read_bytes())}
save(dest / 'preparation.json', (json.dumps(record, indent=2) + '\n').encode())
print(json.dumps(record))
