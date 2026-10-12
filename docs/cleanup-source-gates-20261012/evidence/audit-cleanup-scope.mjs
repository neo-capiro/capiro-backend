import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildScope } from '/workspace/capirov2-cleanup-gate-reference/scripts/cleanup-gates/lib/scope.mjs';
import { discoverStandaloneNodeSuites } from '/workspace/capirov2-cleanup-gate-reference/scripts/cleanup-gates/lib/standalone-node.mjs';
import { resolveRequiredCoverageScope, PLAN_MAPPING, ARCHITECTURE_GUARDS, REQUIRED_EVIDENCE, BASELINE_JSON, BASELINE_VERIFIER, TEST_PROOF_FIXTURES, PINNED_VISUAL_EVIDENCE } from '/workspace/capirov2-cleanup-gate-reference/scripts/cleanup-gates/gate-config.mjs';
const root=process.argv[2];
const git=(...args)=>execFileSync('git',args,{cwd:root}).toString().trim();
const scope=buildScope(root);
const coverage=resolveRequiredCoverageScope(root);
const standalone=discoverStandaloneNodeSuites(root);
const required=['scripts/cleanup-gates/gate.mjs',BASELINE_JSON,BASELINE_VERIFIER,TEST_PROOF_FIXTURES,'scripts/cleanup-gates/pinned-visual-controls.mjs','apps/e2e/lib/render-context-controls.mjs','scripts/cleanup-gates/standalone-node.test.mjs','apps/e2e/package.json','apps/e2e/scripts/guard-route-coverage.mjs','apps/e2e/baselines/manifest.json',PINNED_VISUAL_EVIDENCE,...REQUIRED_EVIDENCE.map(e=>e.path),'.github/workflows/defense-budget-parser-ci.yml'];
const existence=required.map(file=>({path:file,present:fs.existsSync(path.join(root,file))}));
const rootPkg=JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8'));
const ci=fs.readFileSync(path.join(root,'.github/workflows/ci-pr.yml'),'utf8');
const workflows=fs.readdirSync(path.join(root,'.github/workflows')).filter(n=>/\.ya?ml$/.test(n));
const guardCI=ARCHITECTURE_GUARDS.map(guard=>({guard,workflows:workflows.filter(name=>fs.readFileSync(path.join(root,'.github/workflows',name),'utf8').includes(guard))}));
// Read actual YAML run scalars/blocks, excluding comments and other step fields.
const lines=ci.split(/\r?\n/),runBlocks=[];
for(let i=0;i<lines.length;i++){
 const m=lines[i].match(/^(\s*)run:\s*(.*?)\s*$/);if(!m)continue;
 const indent=m[1].length;let body=m[2];
 if(/^[|>][-+]?\s*$/.test(body)){
  const parts=[];for(i++;i<lines.length;i++){
   if(lines[i].trim() && (lines[i].match(/^\s*/)[0].length<=indent)){i--;break;}
   parts.push(lines[i].slice(indent+2));
  }body=parts.join('\n');
 }else if(/^(['"]).*\1$/.test(body))body=body.slice(1,-1);
 runBlocks.push(body);
}
const commands=runBlocks.flatMap(body=>body.split('\n')).map(line=>line.trim()).filter(line=>line&&!line.startsWith('#'));
const ciScopes={
 apiJest:commands.some(c=>/^pnpm\s+(?:--filter\s+@capiro\/api(?:\s+|$)|-C\s+apps\/api(?:\s+|$))(?:run\s+)?(?:test(?:\s|$)|exec\s+jest(?:\s|$))/.test(c)),
 webVitest:commands.some(c=>/^pnpm\s+(?:--filter\s+@capiro\/web(?:\s+|$)|-C\s+apps\/web(?:\s+|$))(?:run\s+)?(?:test(?:\s|$)|exec\s+vitest(?:\s|$))/.test(c)),
 defenseNode:commands.some(c=>/^pnpm\s+(?:--filter\s+@capiro\/defense-api(?:\s+|$)|-C\s+apps\/defense-api(?:\s+|$))(?:run\s+)?(?:test(?:\s|$)|exec\s+tsx\s+--test(?:\s|$))/.test(c)),
};
console.log(JSON.stringify({measuredHead:git('rev-parse','HEAD'),measuredTree:git('rev-parse','HEAD^{tree}'),toolingHead:'03d85a40e390f8f52614aab20427a3a9433786bb',execution:'Pure discovery/source checks using unchanged published functions; no runner commands executed.',rootGateCommands:Object.fromEntries(Object.entries(rootPkg.scripts).filter(([k])=>k.includes('cleanup'))),scope,coverage,standalone,existence,guardCI,ciScopes,ciRunBlocks:runBlocks,ciCommands:commands,ciPredicateCorrection:"Original regex matched @capiro/api-strategy as API. Exact package/path boundaries on run scalars now refuse this false positive; original receipt retained.",planMapping:PLAN_MAPPING,fullAcceptance:false},null,2));
