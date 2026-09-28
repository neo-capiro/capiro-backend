import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { inspectSource, verifyRepository } from './verify-meri-visual-isolation.mjs';

const HOSTILE_FIXTURES = [
  {
    name: 'aliased multiline visual service import',
    reason: /direct MeriV3 visual-analysis service import/,
    source: `
      import {
        MeriV3VisualAnalysisService
          as HarmlessReasoner
      } from '../../../api/src/meri/meri-v3-visual-analysis.service.js';
      export const service = new HarmlessReasoner();
    `,
  },
  {
    name: 'aliased multiline visual execution bridge import',
    reason: /visual-analysis execution bridge import/,
    source: `
      import {
        ApiVisualAnalysisRepo
          as SharedGateway
      } from '../../../meriv2-orchestrator/src/meri/meriv3/api-visual-analysis.repo.js';
      export const bridge = new SharedGateway();
    `,
  },
  {
    name: 'multiline run_analysis tool registration',
    reason: /run_analysis tool declaration/,
    source: `
      export const tools = [{
        name:
          'run_analysis',
        execute: (input) => input,
      }];
    `,
  },
  {
    name: 'concrete visual-analysis HTTP bridge',
    reason: /visual-analysis execution endpoint/,
    source: `
      export async function executeVisual(baseUrl, input) {
        return fetch(
          \`\${baseUrl}/api/clio/v3/visual-analysis\`,
          { method: 'POST', body: JSON.stringify(input) },
        );
      }
    `,
  },
  {
    name: 'direct sandbox package import',
    reason: /direct analysis-sandbox import/,
    source: `
      import {
        runSandboxed as executeLocally,
      } from '@capiro/clio-sandbox/src/run.js';
      export { executeLocally };
    `,
  },
];

for (const fixture of HOSTILE_FIXTURES) {
  test(`rejects ${fixture.name}`, () => {
    const violations = inspectSource(fixture.source, `${fixture.name}.ts`);
    assert.ok(
      violations.some((violation) => fixture.reason.test(violation.reason)),
      JSON.stringify(violations),
    );
  });
}

test('allows the legitimate shared MeriV3 reasoning HTTP gateway', () => {
  const source = `
    @Injectable()
    export class WorkspaceReasoningGateway {
      constructor(config: ConfigService) {
        this.baseUrl = config.get<string>('MERIV3_ORCHESTRATOR_URL') ?? '';
      }

      async request(body: unknown) {
        return fetch(\`\${this.baseUrl}/meri-api/reasoning\`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      }
    }
  `;
  assert.deepEqual(inspectSource(source, 'workspace-reasoning.gateway.ts'), []);
});

test('ignores comments that describe forbidden visual-analysis boundaries', () => {
  const source = `
    // Never import MeriV3VisualAnalysisService or expose run_analysis here.
    /*
     * Forbidden examples:
     * import { ApiVisualAnalysisRepo } from './api-visual-analysis.repo.js';
     * fetch('/api/clio/v3/visual-analysis');
     * process.env.CLIO_SANDBOX_URL
     */
    export const policy = 'shared reasoning only';
  `;
  assert.deepEqual(inspectSource(source, 'boundary-policy.ts'), []);
});

test('the current production Workspace, Strategy, and Intel trees satisfy the guard', () => {
  const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const result = verifyRepository(repositoryRoot);
  assert.ok(result.files.length > 0);
  assert.deepEqual(result.violations, []);
});
