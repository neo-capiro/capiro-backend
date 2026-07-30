import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from '@jest/globals';

const source = readFileSync(resolve(process.cwd(), 'scripts/drain-pe-change-outbox.ts'), 'utf8');

describe('drain-pe-change-outbox command safety', () => {
  test('reports only in the default posture and requires --commit to drain', () => {
    expect(source).toContain("const commit = flag('commit')");
    expect(source).toMatch(/if \(!commit\) return;/);
    expect(source.indexOf('if (!commit) return;')).toBeLessThan(source.indexOf('service.drain(limit)'));
  });

  test('committed runs are bounded and SyncRun-audited', () => {
    expect(source).toContain("runWithSyncRun(client, 'drain-pe-change-outbox'");
    expect(source).toContain('Math.min(500');
    expect(source).not.toMatch(/sendEmail|SES|LlamaParse|SecretString/);
  });
});
