// Local preparation only; does not import or execute either dispatcher.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const parent = 'C:/dev/main/outputs/meri-c2-20261003';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const prior = readFileSync(parent + '/run-case01-native-setup-v3.mjs');
assert.equal(hash(prior), '39219647361b76d232d2dd4251e9a574277f814a502d601cdc4ca863826cfd43');
const helperHash = hash(readFileSync(parent + '/case01-native-setup-v4-definition.mjs'));
let text = prior.toString('utf8');
function replace(before, after) {
  assert.equal(text.split(before).length, 2, 'Unique source anchor required');
  text = text.replace(before, after);
}
replace("import {awsSingleAttempt} from './aws-single-attempt.mjs';", "import {awsSingleAttempt} from './aws-single-attempt.mjs';\nimport {withExplicitEcsDefaults,normalizeTaskEnvironment} from './case01-native-setup-v4-definition.mjs';");
replace("const root=parent+'/case01-native-setup-'+mode+'-v1';", "const root=parent+'/case01-native-setup-'+mode+'-v2';");
replace("const hash=b=>createHash('sha256').update(b).digest('hex');", "const hash=b=>createHash('sha256').update(b).digest('hex');\nassert.equal(hash(readFileSync(new URL('./case01-native-setup-v4-definition.mjs',import.meta.url))),'" + helperHash + "','Reviewed task normalization drift');");
replace("const packet=read(parent+'/clock-provider-release-packet.json');", `// This new exclusive plan is permitted only after the retained pre-dispatch failure was reconciled.
const reconciliationBytes=readFileSync(parent+'/case01-native-setup-plan-v1-reconciliation.json');
const reconciliationSha256=hash(reconciliationBytes);
assert.equal(reconciliationSha256,'b59923080aace193f676921ff8a449ff62b7e527fda80135ec2080255727e232');
const reconciliation=JSON.parse(reconciliationBytes);
assert.equal(reconciliation.status,'RECONCILED_PRE_RUN_TASK_FAILURE');
assert.equal(reconciliation.definitionStatus,'INACTIVE');
assert.equal(hash(readFileSync(parent+'/case01-native-setup-plan-v1/result.json')),reconciliation.priorResultSha256);
assert.equal(hash(readFileSync(parent+'/run-case01-native-setup-v3.mjs')),reconciliation.priorDispatcherSha256);
assert.equal(existsSync(parent+'/case01-native-setup-plan-v1/task-input.private.json'),false);
const packet=read(parent+'/clock-provider-release-packet.json');`);
replace("mode,sourceSha:source,image,scriptSha256:hash(body),wrapperSha256:hash(wrapper)", "mode,sourceSha:source,image,reconciliationSha256,scriptSha256:hash(body),wrapperSha256:hash(wrapper)");
replace("const prior=read(parent+'/case01-native-setup-plan-v1/result.json');", "const prior=read(parent+'/case01-native-setup-plan-v2/result.json');");
replace('const definition=JSON.parse(templateBytes);', 'const definition=normalizeTaskEnvironment(withExplicitEcsDefaults(JSON.parse(templateBytes)));');
replace('definitionSha256:fingerprint(taskInput(definition))', 'definitionSha256:fingerprint(normalizeTaskEnvironment(taskInput(definition)))');
replace('const registeredHash=fingerprint(taskInput({...registered.taskDefinition,tags:registered.tags}));', 'const registeredHash=fingerprint(normalizeTaskEnvironment(taskInput({...registered.taskDefinition,tags:registered.tags})));');
replace("assert.equal(registeredHash,fingerprint(taskInput(definition)),'Registered task input drift');", "assert.equal(registeredHash,fingerprint(normalizeTaskEnvironment(taskInput(definition))),'Registered task input drift');");
writeFileSync(parent + '/run-case01-native-setup-v4.mjs', text, { flag: 'wx' });
const checker = readFileSync(parent + '/case01-native-setup-v3-review/check-offline.mjs', 'utf8');
writeFileSync(parent + '/case01-native-setup-v4-review/check-offline.mjs', checker.replaceAll('run-case01-native-setup-v3.mjs', 'run-case01-native-setup-v4.mjs').replaceAll('case01-native-setup-v3-review', 'case01-native-setup-v4-review'), { flag: 'wx' });
console.log(JSON.stringify({ status: 'PREPARED_ONLY', dispatcherSha256: hash(text), helperSha256: helperHash, priorPreserved: true }));
