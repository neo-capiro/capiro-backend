import { readFile } from 'node:fs/promises';
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
  console.log(JSON.stringify({ marker: 'MERI_REPAIR_REPLAY_OK', fixtureVersion: 'repair-scenarios-v1', scenarios: scenarios.length, passed: scenarios.length, failed: 0 }));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
