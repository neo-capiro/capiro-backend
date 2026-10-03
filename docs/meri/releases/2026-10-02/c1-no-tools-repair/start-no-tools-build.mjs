import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { aws, need } from '../meri-fresh-20261003/auth-preflight.mjs';

const [sha, actionRun] = process.argv.slice(2);
need(/^[a-f0-9]{40}$/.test(sha ?? '') && /^\d+$/.test(actionRun ?? ''), 'EXACT_SHA_AND_ACTION_RUN_REQUIRED');
const root = 'C:/dev/main/outputs/meri-c1-20261002/orchestrator-no-tools-build';
const action = JSON.parse(execFileSync('gh', ['run', 'view', actionRun, '--repo', 'neo-capiro/capirov2', '--json', 'status,conclusion,headSha,jobs,url,workflowName'], { encoding: 'utf8', windowsHide: true }));
need(action.headSha === sha && action.status === 'completed' && action.conclusion === 'startup_failure' && action.jobs.length === 0, 'ACTIONS_INFRASTRUCTURE_FAILURE_UNVERIFIED');
need(action.workflowName === 'meriv2-orchestrator-image', 'WRONG_ACTIONS_WORKFLOW');
const identity = aws(['sts', 'get-caller-identity']);
need(identity.Account === '967807252336', 'WRONG_ACCOUNT');
const project = aws(['codebuild', 'batch-get-projects', '--names', 'capiro-build-web-dev']).projects[0];
need(project.source.type === 'GITHUB' && project.source.location === 'https://github.com/neo-capiro/capirov2.git' && project.environment.type === 'ARM_CONTAINER' && project.environment.privilegedMode === true, 'PROJECT_DRIFT');
let buildspec = readFileSync('C:/dev/main/outputs/meri-c1-20261002/orchestrator-mail-defaults-build/orchestrator.buildspec.yml', 'utf8');
const oldCount = "assert result['numPassedTests'] > 0 and result['numTotalTests'] > 0";
need(buildspec.includes(oldCount), 'SOURCE_TEST_GATE_MARKER_MISSING');
buildspec = buildspec.replace(oldCount, "assert result['numPassedTests'] == 1502 and result['numTotalTests'] == 1504 and result['numPendingTests'] == 2 and result['numPassedTestSuites'] == 129");
const packaged = [
  '        docker run --rm -i --network none --entrypoint node "$image" - <<\'DIRECTIVE\'',
  '        const assert = require("node:assert/strict");',
  '        const core = require("@capiro/meriv2-core");',
  '        const plan = request => core.planGovernmentAffairsEvidence({request, frame:core.resolveGovernmentAffairsOperatingFrame({request}), surface:"chat"});',
  '        const concise = "C1 final verification: In exactly three short bullets, describe how you can help with research, drafting, and task organization. Use no tools.";',
  '        assert.deepEqual(plan(concise).requestCategories, ["general_background"]);',
  '        assert.ok(plan("List all awards. Use no tools.").requestCategories.includes("negative_or_exhaustive"));',
  '        assert.ok(plan("Who is the current committee chair? Use no tools.").requestCategories.includes("current_role"));',
  '        const quoted = \'The manual says "For this procedure, use no tools. The installation ends here." Verify that instruction.\';',
  '        assert.ok(plan(quoted).requestCategories.includes("negative_or_exhaustive"));',
  '        console.log("OFFLINE_PACKAGED_NO_TOOLS_DIRECTIVE_PASS");',
  '        DIRECTIVE',
].join('\n') + '\n';
need(buildspec.includes('  post_build:'), 'BUILDSPEC_MARKER_MISSING');
buildspec = buildspec.replace('  post_build:', packaged + '  post_build:');
mkdirSync(root, { recursive: true });
writeFileSync(root + '/orchestrator.buildspec.yml', buildspec, { flag: 'wx' });
const request = { projectName: project.name, sourceVersion: sha, buildspecOverride: buildspec, environmentVariablesOverride: [{ name: 'EXPECTED_SHA', value: sha, type: 'PLAINTEXT' }], idempotencyToken: randomUUID(), timeoutInMinutesOverride: 45 };
writeFileSync(root + '/orchestrator-build-input.json', JSON.stringify(request, null, 2) + '\n', { flag: 'wx' });
const started = aws(['codebuild', 'start-build', '--cli-input-json', 'file://' + root + '/orchestrator-build-input.json']);
need(started.build?.id && started.build.sourceVersion === sha, 'BUILD_START_UNCONFIRMED');
const receipt = { buildId: started.build.id, sourceSha: sha, status: started.build.buildStatus, buildspecSha256: createHash('sha256').update(buildspec).digest('hex'), actionRun: action, callerArn: identity.Arn, startedAt: new Date().toISOString(), scope: 'Immutable orchestrator candidate build and qualification only; no service, database, routing, WAF or provider configuration mutation' };
writeFileSync(root + '/orchestrator-build-start.json', JSON.stringify(receipt, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify(receipt, null, 2));
