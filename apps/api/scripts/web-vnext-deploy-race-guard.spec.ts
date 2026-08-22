import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * District Nexus Release 3 closeout (2026-08-22): a concurrent web-vnext
 * deploy briefly overwrote the R3-approved task-definition digest with an
 * older pre-R3 image, because the workflow's rollback-anchor "previous task
 * definition" was captured once at job start and never re-checked before the
 * final `update-service` mutation -- even though the build+push step in
 * between can take 20-30+ minutes, plenty of time for another run to land.
 *
 * This spec asserts the deployment-race guard exists, runs BEFORE the
 * mutating update-service call, and fails closed (non-zero exit) when the
 * live task definition has moved since job start.
 */
const WORKFLOW_PATH = join(
  __dirname,
  '../../../.github/workflows/web-vnext-deploy.yml',
);
const workflow = readFileSync(WORKFLOW_PATH, 'utf8');

describe('web-vnext-deploy.yml deployment-race guard', () => {
  test('re-reads the live task definition immediately before update-service', () => {
    expect(workflow).toMatch(
      /LIVE_TASK_DEFINITION="\$\(aws ecs describe-services[\s\S]*?--output text\)"/,
    );
  });

  test('aborts (non-zero exit) when the live task definition no longer matches the one observed at job start', () => {
    expect(workflow).toMatch(
      /if \[\[ "\$LIVE_TASK_DEFINITION" != "\$PREVIOUS_TASK_DEFINITION" \]\]; then/,
    );
    // The guard branch must exit non-zero, not merely warn.
    const guardBlockMatch = workflow.match(
      /if \[\[ "\$LIVE_TASK_DEFINITION" != "\$PREVIOUS_TASK_DEFINITION" \]\]; then([\s\S]*?)\n( {10}fi)/,
    );
    expect(guardBlockMatch).not.toBeNull();
    expect(guardBlockMatch?.[1]).toMatch(/exit 1/);
  });

  test('the guard check appears before the mutating update-service call in the deploy step', () => {
    const guardIndex = workflow.indexOf('LIVE_TASK_DEFINITION=');
    const updateServiceIndex = workflow.indexOf('aws ecs update-service', guardIndex);
    expect(guardIndex).toBeGreaterThan(-1);
    expect(updateServiceIndex).toBeGreaterThan(guardIndex);
  });

  test('the guard compares against the task definition captured in the "Verify exact vNext deployment target" step', () => {
    // steps.target.outputs.previous_task_definition is set from the
    // service's taskDefinition read at job start (before the long build).
    expect(workflow).toContain(
      "PREVIOUS_TASK_DEFINITION: ${{ steps.target.outputs.previous_task_definition }}",
    );
    expect(workflow).toContain('previous_task_definition=$CURRENT_TASK_DEFINITION');
  });
});
