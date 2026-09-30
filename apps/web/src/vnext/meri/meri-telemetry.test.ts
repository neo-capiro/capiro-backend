import { describe, expect, it } from 'vitest';
import { createMeriBrowserTelemetryHeaders } from './meri-telemetry.js';

describe('createMeriBrowserTelemetryHeaders', () => {
  it('creates bounded W3C linkage without actor, tenant or content authority', () => {
    const headers = createMeriBrowserTelemetryHeaders();
    expect(headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(headers['x-capiro-browser-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    expect(JSON.stringify(headers)).not.toMatch(/tenant|actor|body|prompt|content|credential/i);
  });
});
