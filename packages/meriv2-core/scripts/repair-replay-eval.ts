import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

interface Scenario { id: string; description: string; expected: string }

async function main(): Promise<void> {
  const fixturePath = path.resolve(__dirname, '../src/repair/__fixtures__/repair-scenarios-v1.json');
  const scenarios = JSON.parse(await readFile(fixturePath, 'utf8')) as Scenario[];
  if (scenarios.length !== 8) throw new Error(`Expected 8 repair scenarios, found ${scenarios.length}`);
  const required = new Set([
    'recoverable-factual-error', 'missing-exact-transcript', 'unrelated-source-outage',
    'new-unsupported-fact', 'failed-retrieval-dedupe', 'cancel-mid-repair',
    'budget-exhausted', 'conflicting-sources',
  ]);
  for (const scenario of scenarios) {
    if (!required.delete(scenario.id) || !scenario.description || !scenario.expected) {
      throw new Error(`Invalid repair scenario: ${scenario.id}`);
    }
  }
  if (required.size) throw new Error(`Missing repair scenarios: ${[...required].join(', ')}`);
  const jest = path.resolve(__dirname, '../node_modules/jest/bin/jest.js');
  const replay = spawnSync(process.execPath, [jest, '--runInBand', 'src/repair/repair-loop.spec.ts'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (replay.status !== 0) {
    process.stderr.write(replay.stdout);
    process.stderr.write(replay.stderr);
    throw new Error(`Repair replay behavior spec failed with status ${replay.status ?? 'unknown'}`);
  }
  console.log(JSON.stringify({ marker: 'MERI_REPAIR_REPLAY_OK', fixtureVersion: 'repair-scenarios-v1', scenarios: scenarios.length, passed: scenarios.length, failed: 0 }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
