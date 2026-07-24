import { describe, expect, it, afterEach } from '@jest/globals';
import { loadConfig, toVerifierNodes, renderMarkdown, type L2Result } from './run-l2.js';

/*
 * run-l2.ts is deliberately NOT wired into jest.config.cjs's testMatch as a
 * whole (it makes real, billed Anthropic + orchestrator network calls). But
 * its config-loading and pure data-shaping logic has zero network dependency
 * and zero prior test coverage — only exercised, by accident, via a scratch
 * smoke script during development that was never committed. This file tests
 * exactly the three network-free exports (loadConfig, toVerifierNodes,
 * renderMarkdown) and nothing that touches fetch.
 */

const ENV_KEYS = ['MERIV2_ORCHESTRATOR_URL', 'EVAL_BEARER_TOKEN', 'EVAL_CLIENT_ID', 'ANTHROPIC_API_KEY'] as const;

describe('loadConfig', () => {
  const saved: Record<string, string | undefined> = {};
  beforeAllSave();
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  function beforeAllSave() {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
  }

  it('returns {missing: [...]} listing every unset var when none are set', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    const result = loadConfig();
    expect('missing' in result && result.missing).toEqual([...ENV_KEYS]);
  });

  it('lists only the specific vars that are missing when some are set', () => {
    for (const k of ENV_KEYS) delete process.env[k];
    process.env.MERIV2_ORCHESTRATOR_URL = 'http://localhost:4300';
    process.env.EVAL_CLIENT_ID = 'client-1';
    const result = loadConfig();
    expect('missing' in result && result.missing).toEqual(['EVAL_BEARER_TOKEN', 'ANTHROPIC_API_KEY']);
  });

  it('returns a full config object when all four are set, stripping a trailing slash from the URL', () => {
    process.env.MERIV2_ORCHESTRATOR_URL = 'http://localhost:4300/';
    process.env.EVAL_BEARER_TOKEN = 'tok';
    process.env.EVAL_CLIENT_ID = 'client-1';
    process.env.ANTHROPIC_API_KEY = 'key';
    const result = loadConfig();
    expect('missing' in result).toBe(false);
    if (!('missing' in result)) {
      expect(result.orchestratorUrl).toBe('http://localhost:4300');
      expect(result.bearerToken).toBe('tok');
      expect(result.clientId).toBe('client-1');
      expect(result.anthropicApiKey).toBe('key');
    }
  });
});

describe('toVerifierNodes', () => {
  it('threads kind/subject/title/dates through and stringifies the positional id', () => {
    const out = toVerifierNodes([
      { kind: 'action', subject: 'deliverable', title: 'Step A', startsOn: '2027-01-01', endsOn: '2027-01-15' },
    ]);
    expect(out).toEqual([
      { id: '0', kind: 'action', subject: 'deliverable', title: 'Step A', startsOn: '2027-01-01', endsOn: '2027-01-15', dependsOnIds: [] },
    ]);
  });

  it('maps a dependsOn index to the stringified id of that position', () => {
    const out = toVerifierNodes([
      { kind: 'action', subject: 'deliverable', title: 'A', startsOn: '2027-01-01' },
      { kind: 'decision', subject: 'ask', title: 'B', startsOn: '2027-01-02', dependsOn: [0] },
    ]);
    expect(out[1]!.dependsOnIds).toEqual(['0']);
  });

  it('drops an out-of-range dependsOn index rather than emitting an invalid id', () => {
    const out = toVerifierNodes([
      { kind: 'action', subject: 'deliverable', title: 'A', startsOn: '2027-01-01', dependsOn: [5] },
    ]);
    expect(out[0]!.dependsOnIds).toEqual([]);
  });

  it('drops a self-referencing dependsOn index', () => {
    const out = toVerifierNodes([
      { kind: 'action', subject: 'deliverable', title: 'A', startsOn: '2027-01-01', dependsOn: [0] },
    ]);
    expect(out[0]!.dependsOnIds).toEqual([]);
  });

  it('treats a missing dependsOn as no edges', () => {
    const out = toVerifierNodes([{ kind: 'action', subject: 'deliverable', title: 'A', startsOn: '2027-01-01' }]);
    expect(out[0]!.dependsOnIds).toEqual([]);
  });

  it('treats a missing or null endsOn as null (never the string "null" or "undefined")', () => {
    const out = toVerifierNodes([
      { kind: 'action', subject: 'deliverable', title: 'A', startsOn: '2027-01-01' },
      { kind: 'action', subject: 'deliverable', title: 'B', startsOn: '2027-01-01', endsOn: null },
    ]);
    expect(out[0]!.endsOn).toBeNull();
    expect(out[1]!.endsOn).toBeNull();
  });
});

describe('renderMarkdown', () => {
  const okResult: L2Result = {
    strategyType: 'appropriations',
    slug: 'example',
    goal: 'g',
    draftSummary: 's',
    nodeCount: 2,
    shapeOk: true,
    shapeFailures: [],
    verifierErrorCount: 0,
    verifierWarningCount: 0,
    judge: { realism: 4, grounding: 3, actionability: 5, calendarFit: 4, rationale: 'Solid.' },
    needsHumanReview: false,
  };
  const erroredResult: L2Result = {
    strategyType: 'earmark',
    slug: 'broken',
    goal: 'g2',
    draftSummary: '',
    nodeCount: 0,
    shapeOk: false,
    shapeFailures: [],
    verifierErrorCount: 0,
    verifierWarningCount: 0,
    judge: { realism: 0, grounding: 0, actionability: 0, calendarFit: 0, rationale: '' },
    needsHumanReview: true,
    error: 'orchestrator strategy-draft failed: 503 Service Unavailable',
  };

  it('renders the scorecard table + rationale for a successful result', () => {
    const md = renderMarkdown([okResult], '2026-07-24');
    expect(md).toContain('appropriations/example');
    expect(md).toContain('Solid.');
    expect(md).toContain('1/1 goldens produced a scored draft.');
  });

  it('renders an ERROR row (not the dummy zero scores) for a failed draft, and never crashes', () => {
    const md = renderMarkdown([erroredResult], '2026-07-24');
    expect(md).toContain('ERROR: orchestrator strategy-draft failed');
    expect(md).not.toContain('earmark/broken | 0 | 0 | 0 | 0');
  });

  it('excludes errored results from the averages and the rationale section', () => {
    const md = renderMarkdown([okResult, erroredResult], '2026-07-24');
    expect(md).toContain('1/2 goldens produced a scored draft.');
    // averages computed over `ok` only (excludes the errored 0-score result) —
    // a naive average-over-all would drag Realism down to 2.
    expect(md).toContain('| Realism | 4 |');
  });

  it('does not crash and reports 0% shape-pass rate when every result errored', () => {
    const md = renderMarkdown([erroredResult], '2026-07-24');
    expect(md).toContain('0/1 goldens produced a scored draft.');
    expect(md).not.toMatch(/NaN/);
  });
});
