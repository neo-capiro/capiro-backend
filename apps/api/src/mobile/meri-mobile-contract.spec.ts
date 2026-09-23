import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function repoFile(path: string): string {
  return resolve(process.cwd(), '..', '..', path);
}

describe('Meri mobile v1 published contracts', () => {
  const openapi = JSON.parse(
    readFileSync(repoFile('docs/contracts/meri-mobile/v1/openapi.json'), 'utf8'),
  ) as { info: { version: string }; paths: Record<string, unknown> };
  const events = JSON.parse(
    readFileSync(
      repoFile('docs/contracts/meri-mobile/v1/meri-display-events.v1.schema.json'),
      'utf8',
    ),
  ) as { properties: Record<string, unknown>; required: string[] };

  it('publishes bootstrap, durable run, meeting concurrency, file, and token operations', () => {
    expect(openapi.info.version).toBe('1.0.0');
    expect(Object.keys(openapi.paths)).toEqual(
      expect.arrayContaining([
        '/bootstrap',
        '/meri/conversations/{conversationId}/runs',
        '/meri/runs/{runId}',
        '/meri/runs/{runId}/events',
        '/meri/runs/{runId}/stop',
        '/meetings',
        '/meetings/{meetingId}',
        '/files/confirm',
        '/files/{fileId}/status',
        '/devices',
      ]),
    );
    expect(JSON.stringify(openapi)).toContain('Idempotency-Key');
    expect(JSON.stringify(openapi)).toContain('If-Match');
    expect(JSON.stringify(openapi)).toContain('stale_revision');
  });

  it('requires versioned, owner-recoverable event identity', () => {
    expect(events.required).toEqual(
      expect.arrayContaining(['schemaVersion', 'kind', 'runId', 'seq', 'at']),
    );
    expect(JSON.stringify(events.properties)).toContain('1.0.0');
  });

  it('keeps rollout and deferred product claims explicit', () => {
    const rollout = readFileSync(repoFile('docs/meri/mobile/phase1-rollout-rollback.md'), 'utf8');
    const decisions = readFileSync(repoFile('docs/meri/mobile/phase1-decisions.md'), 'utf8');
    expect(rollout).toContain('No queued or active staging disconnect proof has been run');
    expect(rollout).toContain('No APNs key');
    expect(decisions).toContain('Post-creation attendee editing');
    expect(decisions).toContain('Voice memos');
  });
});
