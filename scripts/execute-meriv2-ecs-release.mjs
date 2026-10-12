#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=1 helpExit=0 */
const usage = 'Usage: node scripts/execute-meriv2-ecs-release.mjs --help (retired; use scripts/meri-release.mjs)';
if (process.argv.length === 3 && process.argv[2] === '--help') {
  console.log(usage);
  process.exit(0);
}
console.error(usage);
throw new Error('Retired: use scripts/meri-release.mjs and docs/meri/deployment-prerequisite.md; no bundled migration or multi-service deployment is authorized.');
