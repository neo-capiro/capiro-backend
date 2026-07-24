import { describe, expect, it } from '@jest/globals';
import { stampRunMetrics } from './run-metrics.js';

/*
 * Stage H run-metrics stamp (pure). Asserts the merge is ADDITIVE (sibling
 * findings keys the run lifecycle owns survive untouched), that undefined input
 * fields are OMITTED rather than written as null, that a later stamp merges onto
 * the prior metrics instead of replacing them, and that a non-object findings
 * value degrades to an empty base rather than throwing.
 */

describe('stampRunMetrics', () => {
  it('stamps a metrics object with only lastPhase when no optional fields are given', () => {
    const out = stampRunMetrics(null, { phase: 'plan' });
    expect(out).toEqual({ metrics: { lastPhase: 'plan' } });
  });

  it('omits missing optional fields (no null model/promptSpecVersion/latencyMs keys)', () => {
    const out = stampRunMetrics({}, { phase: 'check' });
    expect(out.metrics).toEqual({ lastPhase: 'check' });
    expect(out.metrics).not.toHaveProperty('model');
    expect(out.metrics).not.toHaveProperty('promptSpecVersion');
    expect(out.metrics).not.toHaveProperty('latencyMs');
  });

  it('records the fields that ARE provided', () => {
    const out = stampRunMetrics(
      {},
      { phase: 'execute', model: 'claude-sonnet', promptSpecVersion: 'v3', latencyMs: 1234 },
    );
    expect(out.metrics).toEqual({
      lastPhase: 'execute',
      model: 'claude-sonnet',
      promptSpecVersion: 'v3',
      latencyMs: 1234,
    });
  });

  it('preserves sibling findings keys (execution / tasks / g0 / results) untouched — additive merge', () => {
    const existing = {
      execution: { kind: 'workspace', nodeId: 'N1' },
      tasks: [{ type: 'workspace_draft' }],
      g0: { versionDrift: false },
      results: { 'N1:workspace_draft': { status: 'staged' } },
    };
    const out = stampRunMetrics(existing, { phase: 'execute', latencyMs: 5 });
    expect(out.execution).toEqual({ kind: 'workspace', nodeId: 'N1' });
    expect(out.tasks).toEqual([{ type: 'workspace_draft' }]);
    expect(out.g0).toEqual({ versionDrift: false });
    expect(out.results).toEqual({ 'N1:workspace_draft': { status: 'staged' } });
    expect(out.metrics).toEqual({ lastPhase: 'execute', latencyMs: 5 });
  });

  it('does not mutate the input findings object', () => {
    const existing = { tasks: [1, 2, 3] };
    const snapshot = JSON.parse(JSON.stringify(existing));
    stampRunMetrics(existing, { phase: 'plan' });
    expect(existing).toEqual(snapshot); // no metrics key grafted onto the original
  });

  it('a later stamp MERGES onto prior metrics — an earlier model survives a later latency-only stamp', () => {
    const first = stampRunMetrics({ tasks: [] }, { phase: 'plan', model: 'claude-sonnet' });
    const second = stampRunMetrics(first, { phase: 'execute', latencyMs: 42 });
    expect(second.metrics).toEqual({
      lastPhase: 'execute', // advanced
      model: 'claude-sonnet', // carried forward from the earlier stamp
      latencyMs: 42, // added
    });
    expect(second.tasks).toEqual([]); // still additive
  });

  it('drops a non-finite latency rather than writing NaN/Infinity', () => {
    expect(stampRunMetrics({}, { phase: 'x', latencyMs: NaN }).metrics).toEqual({ lastPhase: 'x' });
    expect(
      stampRunMetrics({}, { phase: 'x', latencyMs: Number.POSITIVE_INFINITY }).metrics,
    ).toEqual({ lastPhase: 'x' });
  });

  it('treats a non-object findings value (array / string / number) as an empty base', () => {
    expect(stampRunMetrics([1, 2], { phase: 'p' })).toEqual({ metrics: { lastPhase: 'p' } });
    expect(stampRunMetrics('nope', { phase: 'p' })).toEqual({ metrics: { lastPhase: 'p' } });
    expect(stampRunMetrics(7, { phase: 'p' })).toEqual({ metrics: { lastPhase: 'p' } });
    expect(stampRunMetrics(undefined, { phase: 'p' })).toEqual({ metrics: { lastPhase: 'p' } });
  });

  it('overwrites a prior metrics value that was NOT an object without throwing', () => {
    const out = stampRunMetrics({ metrics: 'corrupt', tasks: [] }, { phase: 'plan' });
    expect(out.metrics).toEqual({ lastPhase: 'plan' });
    expect(out.tasks).toEqual([]);
  });
});
