/**
 * TDD tests for MeriOfflineProvider class.
 * Uses node:test (CJS format). Run with: node --test evals/meri/runtime/provider.test.cjs
 *
 * Tests cover: core, GA, plan, sequence, calibration cases; unknown caseId rejection;
 * env scrubbing; provider class interface.
 */
'use strict';

const { test, suite } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const { createHash } = require('node:crypto');

// Workspace from this file's location: evals/meri/runtime/provider.test.cjs -> 3 levels up
const WORKSPACE = path.resolve(__dirname, '..', '..', '..');
const PROVIDER_PATH = path.join(__dirname, 'provider.cjs');
const MeriOfflineProvider = require(PROVIDER_PATH);

// Timeout for provider calls (each runs node subprocess with tsx)
const CALL_TIMEOUT = 90000;

function makeContext(vars) {
  return { vars };
}

function inspectChildBoundary() {
  const captured = {};
  const mockFs = {
    mkdirSync: () => {},
    mkdtempSync: (prefix) => {
      captured.tempPrefix = prefix;
      return path.join(WORKSPACE, '.artifacts', 'meri-promptfoo', 'mock-test');
    },
    rmSync: () => {},
    existsSync: () => false,
    readFileSync: () => { throw Error('No read should occur on spawn failure'); },
  };
  const exported = { exports: {} };
  const isolatedRequire = (name) => {
    if (name === 'fs') return mockFs;
    if (name === 'child_process') return {
      spawnSync: (_node, _args, options) => {
        captured.env = options.env;
        return { error: Error('synthetic no-exec probe') };
      },
    };
    return require(name);
  };
  vm.runInNewContext(fs.readFileSync(PROVIDER_PATH, 'utf8'), {
    require: isolatedRequire, module: exported, exports: exported.exports,
    __dirname, process,
  }, { filename: PROVIDER_PATH });
  return { Provider: exported.exports, captured };
}

suite('Provider – offline process boundary', () => {
  test('arbitrary secrets and Node startup hooks are absent from child environment', async () => {
    const { Provider, captured } = inspectChildBoundary();
    const oldSecret = process.env.MERI_EVAL_ARBITRARY_SECRET;
    const oldOptions = process.env.NODE_OPTIONS;
    process.env.MERI_EVAL_ARBITRARY_SECRET = 'synthetic-sentinel';
    process.env.NODE_OPTIONS = '--import=synthetic-probe';
    try {
      await new Provider().callApi('', makeContext({ caseId: 'core/grounding.claim-evidence' }));
      assert.equal(captured.env.MERI_EVAL_ARBITRARY_SECRET, undefined);
      assert.equal(captured.env.NODE_OPTIONS, undefined);
      assert.equal(captured.env.PROMPTFOO_DISABLE_TELEMETRY, '1');
      assert.equal(captured.env.PROMPTFOO_DISABLE_REMOTE_GENERATION, '1');
    } finally {
      if (oldSecret === undefined) delete process.env.MERI_EVAL_ARBITRARY_SECRET;
      else process.env.MERI_EVAL_ARBITRARY_SECRET = oldSecret;
      if (oldOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = oldOptions;
    }
  });

  test('temporary result files live in the ignored workspace artifacts, not the OS temp folder', async () => {
    const { Provider, captured } = inspectChildBoundary();
    await new Provider().callApi('', makeContext({ caseId: 'core/grounding.claim-evidence' }));
    assert.ok(captured.tempPrefix.startsWith(path.join(WORKSPACE, '.artifacts', 'meri-promptfoo', 'tmp')),
      `Result scratch is outside workspace artifacts: ${captured.tempPrefix}`);
  });
});

// ---- provider interface ----
suite('Provider class interface', { timeout: 10000 }, () => {
  test('exports a class with id() and callApi()', () => {
    const p = new MeriOfflineProvider();
    assert.equal(typeof p.id, 'function');
    assert.equal(typeof p.callApi, 'function');
    assert.equal(p.id(), 'meri-offline-runner');
  });

  test('documented smoke suite cannot silently disappear', () => {
    assert.ok(fs.existsSync(path.join(__dirname, 'smoke.test.cjs')),
      'Missing documented runtime/smoke.test.cjs');
  });

  test('records the evaluated harness file hashes with each result', { timeout: CALL_TIMEOUT }, async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'core/grounding.claim-evidence';
    const response = await p.callApi(caseId, makeContext({ caseId }));
    assert.ok(!response.error, response.error);
    const provenance = JSON.parse(response.output).provenance;
    const paths = {
      config: path.join(WORKSPACE, 'evals', 'meri', 'promptfooconfig.yaml'),
      scorer: path.join(WORKSPACE, 'evals', 'meri', 'scorer.py'),
      provider: PROVIDER_PATH,
      runner: path.join(__dirname, 'runner.mjs'),
      ga_fixture: path.join(WORKSPACE, 'apps', 'api', 'src', 'meri', 'evals', 'government-affairs-fixtures.ts'),
    };
    const expected = Object.fromEntries(Object.entries(paths).map(([name, file]) => [
      name, createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
    ]));
    assert.deepEqual(provenance.inputSha256, expected);
  });
});

// ---- unknown caseId rejection ----
suite('Provider – unknown caseId rejection', { timeout: CALL_TIMEOUT }, () => {
  test('rejects unknown caseId', async () => {
    const p = new MeriOfflineProvider();
    const result = await p.callApi('unknown/does-not-exist', makeContext({ caseId: 'unknown/does-not-exist' }));
    assert.ok(result.error, 'Must return error for unknown caseId');
    assert.ok(result.error.includes('Unknown caseId'), 'Error must mention Unknown caseId');
  });

  test('rejects missing caseId', async () => {
    const p = new MeriOfflineProvider();
    const result = await p.callApi('', makeContext({}));
    assert.ok(result.error, 'Must return error for missing caseId');
  });
});

// ---- core cases ----
suite('Provider – core mechanism cases', { timeout: CALL_TIMEOUT }, () => {
  const CORE_CASES = [
    'core/leakage.cross-tenant.matrix',
    'core/grounding.claim-evidence',
    'core/compliance.gate.enforcement',
    'core/entity.grounding.canonical-ids',
    'core/legislation.bill-status.hr8800-rule-failed',
    'core/legislation.state-bill-status.crossover-dead',
    'core/legislation.state-rule-status.no-fabrication',
    'core/legislation.committee-roster.never-guess',
    'core/legislation.multi-state-comparison.order-independent',
    'core/legislation.federal-state-mixed.no-cross-contamination',
    'core/government-affairs-assurance-ga-goldens-v1.0.0',
  ];

  for (const caseId of CORE_CASES) {
    test('provides result for ' + caseId, { timeout: CALL_TIMEOUT }, async () => {
      const p = new MeriOfflineProvider();
      const result = await p.callApi(caseId, makeContext({ caseId }));
      assert.ok(!result.error, 'Must not return error: ' + (result.error || ''));
      assert.ok(result.output, 'Must return output');
      const record = JSON.parse(result.output);
      assert.equal(record.schemaVersion, 1);
      assert.equal(record.datasetVersion, 'meri-offline-v1');
      assert.equal(record.caseId, caseId);
      assert.equal(record.provenance.model, 'none');
      assert.ok(record.measurement !== undefined && record.measurement !== null);
      assert.ok(record.result !== undefined && record.result !== null);
      assert.equal(typeof record.result.pass, 'boolean');
      assert.ok(record.result.pass === true, 'Core case must pass: ' + record.result.detail);
    });
  }
});

// ---- GA cases ----
suite('Provider – GA human-reference cases', { timeout: CALL_TIMEOUT }, () => {
  const GA_CASES = [
    'ga/ga-budget-stage-and-units',
    'ga/ga-funding-eligibility-and-forecast',
    'ga/ga-meeting-history-and-role',
    'ga/ga-hearing-statement-versus-decision',
    'ga/ga-legislation-current-version',
    'ga/ga-executive-consistent-deliverable',
  ];

  for (const caseId of GA_CASES) {
    test('provides result for ' + caseId, { timeout: CALL_TIMEOUT }, async () => {
      const p = new MeriOfflineProvider();
      const result = await p.callApi(caseId, makeContext({ caseId }));
      assert.ok(!result.error, 'Must not return error: ' + (result.error || ''));
      assert.ok(result.output, 'Must return output');
      const record = JSON.parse(result.output);
      assert.equal(record.schemaVersion, 1);
      assert.equal(record.datasetVersion, 'meri-offline-v1');
      assert.equal(record.caseId, caseId);
      assert.ok(typeof record.answer === 'string' && record.answer.length > 0);
      assert.ok(Array.isArray(record.sources) && record.sources.length > 0);
      assert.equal(record.provenance.model, 'none');
      assert.ok(record.grade !== undefined && record.grade !== null);
      assert.equal(record.grade.pass, true, 'GA reference answer must pass grader');
    });
  }
});

// ---- plan cases ----
suite('Provider – planner inputs (5 plan/*)', { timeout: CALL_TIMEOUT }, () => {
  test('plan/portfolio-changes', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'plan/portfolio-changes';
    const result = await p.callApi(caseId, makeContext({
      caseId,
      request: 'What has changed across my portfolio this week?',
      selectedClientId: null,
    }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.ok(record.plan !== null);
    assert.equal(record.plan.recipeTool, 'query_portfolio_changes');
    assert.equal(record.plan.subjectScope, 'portfolio');
    assert.equal(record.plan.timeWindow.withinDays, 7);
    assert.deepEqual(
      record.plan.activeClients.map((client) => client.name).sort(),
      ['Arbor Sensors', 'Sable Maritime'],
      'The portfolio fixture must enumerate both active clients, not the inactive one',
    );
  });

  test('plan/overland-ai-profile', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'plan/overland-ai-profile';
    const result = await p.callApi(caseId, makeContext({
      caseId,
      request: 'what does overland ai do',
      selectedClientId: null,
    }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.equal(record.plan.recipeTool, 'research_external_company');
    assert.equal(record.plan.subjectScope, 'external_entity');
    assert.equal(record.plan.targetHint, 'overland ai');
  });

  test('plan/c2-strategies-mail-history', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'plan/c2-strategies-mail-history';
    const result = await p.callApi(caseId, makeContext({
      caseId,
      request: 'tell me my email history with c2 strategies',
      selectedClientId: null,
    }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.equal(record.plan.recipeTool, 'query_relationship_brief');
    assert.equal(record.plan.subjectScope, 'external_entity');
    assert.equal(record.plan.targetHint, 'c2 strategies');
  });

  test('plan/kindetic-industries-research', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'plan/kindetic-industries-research';
    const result = await p.callApi(caseId, makeContext({
      caseId,
      request: 'Give me a comprehensive strategy on kindeticindustries.inc',
      selectedClientId: null,
    }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.equal(record.plan.recipeTool, 'research_federal_market_strategy');
    assert.equal(record.plan.subjectScope, 'external_entity');
    assert.equal(record.plan.targetHint, 'kindeticindustries.inc');
  });

  test('plan/selected-client-priorities', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'plan/selected-client-priorities';
    const result = await p.callApi(caseId, makeContext({
      caseId,
      request: "What are this client's current priorities?",
      selectedClientId: '12345',
    }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.equal(record.plan.subjectScope, 'client');
    assert.strictEqual(record.plan.targetHint, null);
  });
});

// ---- sequence cases ----
suite('Provider – sequence planner cases', { timeout: CALL_TIMEOUT }, () => {
  test('sequence/portfolio-overlap-with-target', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'sequence/portfolio-overlap-with-target';
    const result = await p.callApi(caseId, makeContext({
      caseId,
      firstRequest: 'Tell me about Kinetic Industries Inc.',
      request: 'Search across clients',
      selectedClientId: 'eval-client-uuid-001',
    }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.ok(record.plan !== null);
    assert.ok(Array.isArray(record.turns) && record.turns.length === 2);
    assert.equal(record.turns[0].targetHint, 'Kinetic Industries Inc');
    assert.equal(record.plan.recipeTool, 'query_portfolio_overlap');
    assert.equal(record.plan.subjectScope, 'portfolio');
    assert.equal(record.plan.targetHint, record.turns[0].targetHint,
      'The permitted overlap follow-up must carry the actual first-turn target');
  });

  test('sequence/cleared-prior-target', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'sequence/cleared-prior-target';
    const result = await p.callApi(caseId, makeContext({
      caseId,
      firstRequest: 'Tell me about Overland AI.',
      request: "What are this client's current priorities?",
      selectedClientId: '12345',
    }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.equal(record.plan.subjectScope, 'client');
    assert.equal(record.turns[0].targetHint, 'Overland AI');
    assert.equal(record.plan.recipeTool, null);
    assert.strictEqual(record.plan.targetHint, null, 'Client followup must clear prior target');
  });
});

// ---- calibration cases ----
suite('Provider – calibration cases', { timeout: CALL_TIMEOUT }, () => {
  test('calibration/bad-citation must be rejected by GA grader', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'calibration/bad-citation';
    const result = await p.callApi(caseId, makeContext({ caseId }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.ok(record.grade !== null);
    assert.equal(record.grade.pass, false, 'GA grader must reject fabricated citation [999]');
    assert.ok(Array.isArray(record.grade.failures) && record.grade.failures.length > 0);
    assert.ok(record.grade.failures.some((f) => f.includes('[999]')), 'Failure must mention [999]');
  });

  test('calibration/tenant-leak must be rejected by mechanism', async () => {
    const p = new MeriOfflineProvider();
    const caseId = 'calibration/tenant-leak';
    const result = await p.callApi(caseId, makeContext({ caseId }));
    assert.ok(!result.error, result.error);
    const record = JSON.parse(result.output);
    assert.equal(record.caseId, caseId);
    assert.ok(record.result !== null);
    assert.equal(record.result.pass, false, 'Leaky tool must fail tenant isolation check');
    assert.ok(typeof record.result.detail === 'string' && record.result.detail.includes('LEAK'));
  });
});

// ---- env scrubbing ----
suite('Provider – env scrubbing (via core case pass)', { timeout: CALL_TIMEOUT }, () => {
  const SCRUB_CASES = [
    { name: 'DATABASE_URL', value: 'postgresql://user:pass@localhost/db' },
    { name: 'AWS_ACCESS_KEY_ID', value: 'AKIAIOSFODNN7EXAMPLE' },
    { name: 'OPENAI_API_KEY', value: 'sk-proj-test' },
    { name: 'MERIV2_EVAL_SEED_FAILURE', value: '1' },
  ];

  for (const { name, value } of SCRUB_CASES) {
    test('scrubs ' + name, async () => {
      // Set env var before calling provider; provider must scrub it from child
      const old = process.env[name];
      process.env[name] = value;
      try {
        const p = new MeriOfflineProvider();
        const caseId = 'core/grounding.claim-evidence';
        const result = await p.callApi(caseId, makeContext({ caseId }));
        assert.ok(!result.error, 'Provider must still succeed with ' + name + ' set: ' + (result.error || ''));
        const record = JSON.parse(result.output);
        // MERIV2_EVAL_SEED_FAILURE scrubbed: grounding case must still pass
        assert.equal(record.result.pass, true, 'Core case must pass with ' + name + ' scrubbed');
      } finally {
        if (old === undefined) delete process.env[name];
        else process.env[name] = old;
      }
    });
  }
});
