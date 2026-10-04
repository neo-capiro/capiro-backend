import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { sha256Stable } from '../../../meri-c1-20261002/evals/meri/live-v1/lib/stable.mjs';
const repo = 'C:/dev/main/meri-c1-20261002/evals/meri/live-v1';
const root = 'C:/dev/main/outputs/meri-c2-20261003';
const run = root + '/case20-native-recovery-v3-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b';
const post = root + '/case20-postdeadline-budget-readback-v2';
const paths = {
  execution: run + '/execution.json', history: run + '/execution-events.jsonl',
  checkpoint: run + '/aggregate-final-checkpoint.json', captured: run + '/artifacts/captured-inputs.json',
  blocked: run + '/artifacts/blocked.json', manifest: run + '/artifacts/capture-manifest.json',
  admission: run + '/artifacts/admission.json', owner: run + '/artifacts/bundle-owner.json',
  builds: run + '/artifacts/immutable-builds.json', intent: run + '/artifacts/submission-intent.json',
  messages: run + '/artifacts/saved-messages-observation.json', stream: run + '/artifacts/stream-response-observation.json',
  readback: post + '/result.json', me: post + '/response-0.json', conversation: post + '/response-1.json',
  earlierConversation: root + '/case20-terminal-budget-readback-v1/response-1.json',
  scope: root + '/case20-live-scope-v1.json',
  originalClaim: 'C:/dev/cap-meri-foundation-evidence/controlled-read-claims/20-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b.json',
  recoveryClaim: root + '/case20-presubmission-recovery-claim-f4bb30bb-ebb4-4fba-89a9-d49aeafefd1b.json',
  reader: root + '/read-case20-postdeadline-budget-v2.mjs',
  operator: root + '/run-case20-native-recovery-v3.mjs',
  authHelper: 'C:/dev/main/outputs/meri-fresh-20261003/auth-preflight.mjs',
  authManifest: root + '/case01-recovered-auth-scope.private.json',
  authorization: 'C:/dev/main/outputs/meri-fresh-20261003/run-authorization.json',
  journal: 'C:/dev/main/outputs/meri-fresh-20261003/fresh-spend.jsonl',
};
const pins = {}, input = {};
for (const [name,path] of Object.entries(paths)) {
  const bytes=readFileSync(path);
  pins[name]={path,bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')};
  if (!['history','reader','operator','authHelper','authManifest','journal'].includes(name)) {
    input[name]=JSON.parse(bytes); pins[name].semanticSha256=sha256Stable(input[name]);
  }
}
if (pins.journal.sha256 !== 'd6213af1fd8330e9e97a688d903a3c1852b5f40265a66eafb6aa2bf1cfa2060b') throw Error('JOURNAL_CHANGED');
writeFileSync(repo+'/case20-terminal-cost-pins.mjs', '// Fixed retained Case20 observations. These pins authorize cost reconciliation only.\nexport const CASE20_TERMINAL_COST_PINS = Object.freeze('+JSON.stringify(pins,null,2)+');\n');
mkdirSync(repo+'/tests/fixtures',{recursive:true});
writeFileSync(repo+'/tests/fixtures/case20-terminal-cost.unit.json',JSON.stringify(input,null,2)+'\n');
writeFileSync(repo+'/tests/fixtures/case20-terminal-cost-journal23.unit.jsonl',readFileSync(paths.journal));
console.log(JSON.stringify({pins:Object.keys(pins).length,journalUnchanged:true}));
