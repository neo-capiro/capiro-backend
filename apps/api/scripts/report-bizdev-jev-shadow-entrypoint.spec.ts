import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const dispatcherPath = join(__dirname, 'entrypoint-dispatcher.inc');
const dispatcher = readFileSync(dispatcherPath, 'utf8');
const report = readFileSync(join(__dirname, 'report-bizdev-jev-shadow.ts'), 'utf8');

describe('Business Development Phase 3 shadow report entrypoint', () => {
  test('exposes the read-only report verb and forwards all arguments', () => {
    expect(dispatcher).toContain('report-bizdev-jev-shadow)');
    expect(dispatcher).toContain('scripts/report-bizdev-jev-shadow.ts "$@"');
  });

  test('the report reads only aggregate decision telemetry', () => {
    expect(report).toContain('FROM business_development_jev_decisions');
    expect(report).not.toMatch(/source_ids|subject_id|prospect_id|canonical_entity_id|probabilities_jsonb/);
  });

  test('dispatcher remains valid shell', () => {
    expect(() => execFileSync('sh', ['-n', dispatcherPath], { stdio: 'pipe' })).not.toThrow();
  });
});
