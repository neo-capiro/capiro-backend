// Read-only original Cleanup discovery/contract inspection; no subject executes.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { discoverEntrypoints } from '/workspace/capirov2-cleanup-gate-reference/scripts/cleanup-script-smoke/discover.mjs';
import { contractFor } from '/workspace/capirov2-cleanup-gate-reference/scripts/cleanup-gates/lib/script-contract.mjs';
const root=process.argv[2];
const subjects=discoverEntrypoints(root);
const contracts=subjects.map(subject=>({subject,contract:contractFor(root,subject.rel)}));
console.log(JSON.stringify({source:execFileSync('git',['rev-parse','HEAD'],{cwd:root}).toString().trim(),toolingHead:'03d85a40e390f8f52614aab20427a3a9433786bb',mode:'Static inspection only; no entrypoint/no-args/help execution, no native or provider acceptance',subjects:contracts.length,contracts},null,2));
