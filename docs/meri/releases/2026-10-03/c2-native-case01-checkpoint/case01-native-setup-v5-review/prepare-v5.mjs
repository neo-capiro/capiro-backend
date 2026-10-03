// Local preparation only. Never imports or executes any setup dispatcher/inner.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
const parent = 'C:/dev/main/outputs/meri-c2-20261003';
const packageRoot = parent + '/case01-native-setup-v2';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const oldInner = readFileSync(parent + '/case01-native-setup-v1/case01-native-setup-inner.mjs');
const diagnostic = readFileSync(parent + '/case01-native-setup-diagnostic-v1/case01-native-setup-inner.mjs');
const oldDispatcher = readFileSync(parent + '/run-case01-native-setup-v4.mjs');
assert.equal(hash(oldInner), '632d00e47ec63fb8c0b49cfa0d166760bd16abbf5ded9b572c0a9cf235f9899d');
assert.equal(hash(diagnostic), '2479168248b3f108e012730da1fc1c11f0ba2f87dae707b837eeb282a855f488');
assert.equal(hash(oldDispatcher), '22afe2b7715207693f179cc091d5144bb9a2a9179b70fbe91010d2b4310225ff');
let text = oldInner.toString('utf8');
function replace(before, after) {
  assert.equal(text.split(before).length, 2, 'Unique source anchor required: ' + before);
  text = text.replace(before, after);
}
replace("let factory, output, stage = 'VALIDATING', sequence = 0;", "let factory, output, stage = 'VALIDATING', sequence = 0, diagnosticSubstage = 'START';");
const forwarding = `// Only the binding owner's inspect/bind receives this known-slow transaction budget.
// The actual scoped Prisma method receives the identical callback and owns the tx.
function bindingTransactionScope(prisma) {
  assert.equal(typeof prisma?.withTenantUser, 'function');
  return Object.freeze({
    withTenantUser(tenantId, userId, callback, ...options) {
      assert.equal(arguments.length, 3, 'CASE01_BINDING_TRANSACTION_ARGUMENTS');
      assert.equal(options.length, 0, 'CASE01_BINDING_TRANSACTION_OPTIONS');
      assert.equal(tenantId, CTX.tenantId, 'CASE01_BINDING_TRANSACTION_TENANT');
      assert.equal(userId, CTX.userId, 'CASE01_BINDING_TRANSACTION_ACTOR');
      assert.equal(typeof callback, 'function', 'CASE01_BINDING_TRANSACTION_CALLBACK');
      return prisma.withTenantUser(tenantId, userId, callback, { timeoutMs: 30000 });
    },
  });
}

`;
replace('async function savedState() {', forwarding + 'async function savedState() {');
replace('const owner = createCaptureBindingOwner({ prisma: factory.deps.prisma, sourceAuthority });', 'const owner = createCaptureBindingOwner({ prisma: bindingTransactionScope(factory.deps.prisma), sourceAuthority });');
for (const [line, step] of [
  ['const inventory = await readCase01MemoryCorpusInTx', 'READ_INVENTORY'],
  ['assert.equal(inventory.fixtureReady, true);', 'VERIFY_INVENTORY'],
  ['assert.equal(locator.fixtureNamespace, NAMESPACE);', 'VERIFY_LOCATOR'],
  ['const previousManifest = await buildFixtureManifest', 'BUILD_PREVIOUS_MANIFEST'],
  ['const currentManifest = await buildFixtureManifest', 'BUILD_CURRENT_MANIFEST'],
  ["await previous.hydrateInTx(tx, ctx, { lifecycle: 'retired' });", 'HYDRATE_PREVIOUS'],
  ["await current.hydrateInTx(tx, ctx, { lifecycle: 'current' });", 'HYDRATE_CURRENT'],
  ['actualProof = await current.qualifyInTx(tx, ctx, scope);', 'QUALIFY_CURRENT'],
  ["for (const key of ['fixtureVersion', 'physicalMapSha256', 'seedReceiptId', 'resetReceiptId', 'currentVerifySha256'])", 'COMPARE_CANONICAL_PROOF'],
  ['const bindingPlan = await owner.inspect(request);', 'OWNER_INSPECT'],
  ["assert.equal(bindingPlan.status, 'READY');", 'VERIFY_BINDING_PLAN'],
  ['const before = await savedState();', 'READ_SAVED_STATE'],
  ['assert.equal(before.tenantRowVersion, bindingPlan.expectedTenantRowVersion);', 'VERIFY_SAVED_STATE'],
  ['const qualification = qualificationFor(bindingPlan.currentVerifySha256);', 'BUILD_QUALIFICATION'],
  ['const bound = await owner.bind({ ...request,', 'OWNER_BIND'],
  ['const budgetPlan = await inspectCaptureProviderBudgetInstallation', 'BUDGET_PLAN'],
  ['const middle = await savedState();', 'READ_MIDDLE_STATE'],
  ['const installed = await installCaptureProviderBudgetQualification', 'BUDGET_INSTALL'],
  ['const readback = await inspectCaptureProviderBudgetInstallation', 'BUDGET_READBACK'],
  ['const after = await savedState();', 'READ_FINAL_STATE'],
]) {
  const start = text.indexOf(line);
  const lineStart = text.lastIndexOf('\n', start) + 1;
  const indentation = text.slice(lineStart, start);
  assert.match(indentation, /^ *$/);
  replace(line, `diagnosticSubstage = '${step}';\n${indentation}${line}`);
}
const diagnosticText = diagnostic.toString('utf8');
const diagnosticStart = diagnosticText.indexOf('  const diagnostic = {');
const diagnosticEnd = diagnosticText.indexOf("\n  const failure = { status: 'BLOCKED_OR_UNCERTAIN'", diagnosticStart);
assert.ok(diagnosticStart > 0 && diagnosticEnd > diagnosticStart);
replace("  const failure = { status: 'BLOCKED_OR_UNCERTAIN', code, lastStage: stage,", diagnosticText.slice(diagnosticStart, diagnosticEnd) + "\n  const failure = { status: 'BLOCKED_OR_UNCERTAIN', code, lastStage: stage, diagnostic,");
const inner = text;
assert.ok(inner.includes("assert.ok(['plan', 'execute'].includes(mode));"));
assert.ok(inner.includes('const bound = await owner.bind('));
assert.ok(inner.includes('const installed = await installCaptureProviderBudgetQualification('));
mkdirSync(packageRoot);
writeFileSync(packageRoot + '/case01-native-setup-inner.mjs', inner, { flag: 'wx' });
for (const name of ['case01-reviewed-rates-v2.json', 'plan-input.json']) writeFileSync(packageRoot + '/' + name, readFileSync(parent + '/case01-native-setup-v1/' + name), { flag: 'wx' });
text = oldDispatcher.toString('utf8');
replace("packageRoot=parent+'/case01-native-setup-v1'", "packageRoot=parent+'/case01-native-setup-v2'");
replace("const root=parent+'/case01-native-setup-'+mode+'-v2';", "const root=parent+'/case01-native-setup-'+mode+'-v3';");
replace("const prior=read(parent+'/case01-native-setup-plan-v2/result.json');", "const prior=read(parent+'/case01-native-setup-plan-v3/result.json');");
replace(hash(oldInner), hash(inner));
const diagnosticGuard = `const diagnosticFailureBytes=readFileSync(parent+'/case01-native-setup-diagnostic-result-v1/result.json');
const diagnosticFailureSha256=hash(diagnosticFailureBytes);
assert.equal(diagnosticFailureSha256,'0892b58914b29f3303c02df045894e895778707075922a6888483b33ff8774fd');
const diagnosticReceiptBytes=readFileSync(parent+'/case01-native-setup-diagnostic-result-v1/inner-receipt.jsonl');
const diagnosticReceiptSha256=hash(diagnosticReceiptBytes);
assert.equal(diagnosticReceiptSha256,'0197f21682e6f7297f263018620c6cd4e078b694448f2081eb01b6e0ab28f563');
const diagnosticFailure=JSON.parse(diagnosticFailureBytes);
assert.equal(diagnosticFailure.mode,'plan');assert.equal(diagnosticFailure.exitCode,1);
assert.equal(diagnosticFailure.cleanup.taskStopped,true);
assert.equal(diagnosticFailure.cleanup.taskDefinitionInactive,true);
assert.equal(diagnosticFailure.innerReceipt.sha256,diagnosticReceiptSha256);
assert.deepEqual(diagnosticFailure.events,diagnosticReceiptBytes.toString('utf8').trimEnd().split('\\n').map(line=>JSON.parse(line)));
assert.deepEqual(diagnosticFailure.events.map(e=>[e.stage,e.phase]),[['VALIDATING','START'],['INSPECT','FAILURE']]);
assert.equal(diagnosticFailure.events[1].diagnostic.substage,'HYDRATE_PREVIOUS');
assert.equal(diagnosticFailure.events[1].diagnostic.errorClass,'PrismaClientKnownRequestError');
assert.equal(diagnosticFailure.events[1].diagnostic.errorCode,'P2028');
assert.equal(diagnosticFailure.events[1].diagnostic.timeoutMentioned,true);
`;
replace("const packet=read(parent+'/clock-provider-release-packet.json');", diagnosticGuard + "const packet=read(parent+'/clock-provider-release-packet.json');");
replace('image,reconciliationSha256,scriptSha256:hash(body)', 'image,reconciliationSha256,diagnosticFailureSha256,diagnosticReceiptSha256,scriptSha256:hash(body)');
writeFileSync(parent + '/run-case01-native-setup-v5.mjs', text, { flag: 'wx' });
console.log(JSON.stringify({ status: 'PREPARED_ONLY', innerSha256: hash(inner), dispatcherSha256: hash(text), ratesAndPlanPreserved: true }));
