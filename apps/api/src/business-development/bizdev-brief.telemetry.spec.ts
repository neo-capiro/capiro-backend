import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { BizDevBriefService } from './bizdev-brief.service.js';
import {
  bizdevBriefMetric,
  bizdevBriefMetricSummary,
  classifyBriefError,
  type BizDevBriefMetric,
  type BizDevBriefOperation,
  type BizDevBriefOutcome,
} from './bizdev-brief.telemetry.js';

/**
 * Phase 4 telemetry contract tests (telemetry-01):
 *  1. The EMF payload carries ONLY low-cardinality
 *     operation/outcome/latency/count fields — never ids, names, or content.
 *  2. Error classification uses the stable public error shape, never the
 *     message.
 *  3. The service emits exactly one metric per operation attempt, on both
 *     the success and the throw path, and telemetry never alters the result
 *     or the thrown error.
 *  4. No provider/Jev cost metric exists — BD-CLAIM Jev stays DARK (the
 *     source-scan test pins that the telemetry module never references Jev).
 */

describe('bizdev brief telemetry — pure helpers', () => {
  test('EMF payload is single-metric with fixed safe fields', () => {
    const m = bizdevBriefMetric('brief.create', 'created', 1234, '2026-09-25T00:00:00Z');
    expect(m.MetricName).toBe('bizdev.brief.latency_ms');
    expect(m.Value).toBe(1234);
    expect(m.Unit).toBe('Milliseconds');
    expect(m.operation).toBe('brief.create');
    expect(m.outcome).toBe('created');
    expect(m.latency_ms).toBe(1234);
    expect(m.count).toBe(1);
    expect(m.Timestamp).toBe('2026-09-25T00:00:00Z');
    expect(m._aws.CloudWatchMetrics[0]!.Namespace).toBe('Capiro/BizDevBrief');
    expect(m._aws.CloudWatchMetrics[0]!.Dimensions).toEqual([
      ['operation'],
      ['operation', 'outcome'],
    ]);
    // Fixed field set — the privacy contract. Anything new must be argued
    // here, in review.
    expect(Object.keys(m).sort()).toEqual(
      [
        'MetricName',
        'Timestamp',
        'Unit',
        'Value',
        '_aws',
        'count',
        'latency_ms',
        'operation',
        'outcome',
      ].sort(),
    );
  });

  test('payload serializes to one line and carries no content anywhere', () => {
    const json = JSON.stringify(
      bizdevBriefMetric('brief.claim_check', 'unsupported', 42, '2026-09-25T00:00:00Z'),
    );
    expect(json).not.toContain('\n');
    expect(json).not.toMatch(/prospectId|tenantId|userId|canonical/i);
  });

  test('summary line is one line, low-cardinality only', () => {
    const s = bizdevBriefMetricSummary('brief.edit', 'version_conflict', 7);
    expect(s).toBe('bizdev.brief operation=brief.edit outcome=version_conflict ms=7');
    expect(s.split('\n')).toHaveLength(1);
  });

  test('error classification uses the stable public code, not the message', () => {
    const versionConflict = new ConflictException({
      code: 'BIZDEV_BRIEF_VERSION_CONFLICT',
      message: 'SECRET USER CONTENT IN HERE',
      latestVersion: { id: 'leaky' },
    });
    expect(classifyBriefError(versionConflict)).toBe('version_conflict');

    const idempotency = new ConflictException({
      code: 'BIZDEV_BRIEF_IDEMPOTENCY_MISMATCH',
      message: 'x',
    });
    expect(classifyBriefError(idempotency)).toBe('idempotency_conflict');

    const already = new ConflictException({ code: 'BIZDEV_BRIEF_ALREADY_EXISTS', message: 'x' });
    expect(classifyBriefError(already)).toBe('already_exists');

    // A ConflictException without a known code still maps to the closed
    // vocabulary — never the message.
    expect(classifyBriefError(new ConflictException('raw tenant text'))).toBe('conflict');
    expect(classifyBriefError(new NotFoundException('Prospect not found'))).toBe('not_found');
    expect(classifyBriefError(new BadRequestException('bad sections'))).toBe('bad_request');
    expect(classifyBriefError(new Error('internal db detail'))).toBe('error');
  });
});

describe('bizdev brief telemetry — service wrapper', () => {
  interface ObservedFn {
    <R>(
      operation: BizDevBriefOperation,
      run: () => Promise<R>,
      outcomeOf: (result: R) => BizDevBriefOutcome,
    ): Promise<R>;
  }

  function harness() {
    const logged: string[] = [];
    // The wrapper under test never touches the service's injected deps, so
    // two bare objects suffice; the private logger is swapped for a spy via
    // the same runtime shape the service exposes.
    const service = new BizDevBriefService({} as never, {} as never);
    const internals = service as unknown as {
      logger: { log: (m: string) => void; debug: (m: string) => void };
      observed: ObservedFn;
    };
    internals.logger = {
      log: (m: string) => logged.push(m),
      debug: () => {},
    };
    return { observed: internals.observed.bind(service), logged };
  }

  test('success path emits exactly one EMF metric and passes the result through', async () => {
    const { observed, logged } = harness();
    const result = await observed(
      'brief.create',
      async () => ({ created: true }),
      (r) => (r.created ? 'created' : 'replay'),
    );
    expect(result).toEqual({ created: true });
    expect(logged).toHaveLength(1);
    const parsed = JSON.parse(logged[0]!) as BizDevBriefMetric;
    expect(parsed.operation).toBe('brief.create');
    expect(parsed.outcome).toBe('created');
    expect(typeof parsed.latency_ms).toBe('number');
  });

  test('throw path emits one classified metric and rethrows the original error untouched', async () => {
    const { observed, logged } = harness();
    const boom = new ConflictException({
      code: 'BIZDEV_BRIEF_VERSION_CONFLICT',
      message: 'secret',
    });
    await expect(
      observed(
        'brief.edit',
        async () => {
          throw boom;
        },
        () => 'saved',
      ),
    ).rejects.toBe(boom);
    expect(logged).toHaveLength(1);
    const parsed = JSON.parse(logged[0]!) as BizDevBriefMetric;
    expect(parsed.operation).toBe('brief.edit');
    expect(parsed.outcome).toBe('version_conflict');
    // The error message (potential content) never reached the log.
    expect(logged[0]).not.toContain('secret');
  });
});

describe('bizdev brief telemetry — privacy and scope invariants (source scan)', () => {
  const read = (p: string) => readFileSync(join(__dirname, p), 'utf8');

  test('telemetry module references no Jev/provider/cost metrics', () => {
    const source = read('bizdev-brief.telemetry.ts')
      // Strip doc/block and line comments first — the privacy CONTRACT in
      // the header legitimately names what is forbidden; only executable
      // identifiers must stay free of Jev/provider/cost references.
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(source).not.toMatch(/jev|provider|cost|token|llm/i);
  });

  test('the wrapper signature admits only fixed, low-cardinality inputs', () => {
    const source = read('bizdev-brief.service.ts');
    const observed = source.match(/private async observed[\s\S]*?\n  }/)?.[0] ?? '';
    expect(observed).not.toBe('');
    // The wrapper flows ONLY (operation, outcome, latency) to the emitter —
    // never a request-derived value.
    expect(observed).toContain('this.emitBriefMetric(operation, outcomeOf(result)');
    expect(observed).toContain('classifyBriefError(error)');
    // No raw interpolation of request-derived data into the metric log.
    expect(observed).not.toMatch(/\$\{/);
    // The emit site takes exactly three primitive parameters.
    const emit = source.match(/private emitBriefMetric[\s\S]*?\n  }/)?.[0] ?? '';
    expect(emit).toContain('operation: BizDevBriefOperation');
    expect(emit).toContain('outcome: BizDevBriefOutcome');
    expect(emit).toContain('latencyMs: number');
  });
});
