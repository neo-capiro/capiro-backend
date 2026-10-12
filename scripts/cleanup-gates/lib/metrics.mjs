/**
 * Coverage metric readers + validators, shared by the measurement driver
 * (coverage.mjs) and the fail-closed verifier (verify-baseline.mjs).
 *
 * Sharing the readers is deliberate: the verifier RECOMPUTES the summary from
 * the raw report on disk and requires the manifest to match it, so a
 * hand-written or invented metric block cannot pass. A single implementation
 * means "recorded" and "recomputed" can never silently diverge.
 */

import fs from 'node:fs';
import crypto from 'node:crypto';

export function sha256Buffer(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

export function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

/** Normalise an istanbul/coverage-v8 metric node. */
export function normalizeMetric(node) {
  if (!node || typeof node !== 'object') return null;
  return {
    total: node.total ?? null,
    covered: node.covered ?? null,
    skipped: node.skipped ?? null,
    pct: typeof node.pct === 'number' ? node.pct : null,
  };
}

/** Read a jest / vitest v8 `coverage-summary.json` (istanbul total block). */
export function readIstanbulSummary(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = data.total || {};
  if (!t || typeof t !== 'object') throw new Error('istanbul summary has no `total` block');
  return {
    statements: normalizeMetric(t.statements),
    branches: normalizeMetric(t.branches),
    functions: normalizeMetric(t.functions),
    lines: normalizeMetric(t.lines),
  };
}

/** Read a coverage.py `coverage.json` (pytest-cov --cov-report=json). */
export function readPythonCoverage(file) {
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const t = data.totals || {};
  if (!t || typeof t !== 'object') throw new Error('coverage.py json has no `totals` block');
  const pct = (c, n) => (n ? Number(((c / n) * 100).toFixed(2)) : null);
  return {
    statements: {
      total: t.num_statements ?? null,
      covered: t.covered_lines ?? null,
      skipped: null,
      pct: t.percent_statements_covered ?? pct(t.covered_lines, t.num_statements),
    },
    branches:
      t.num_branches == null
        ? null
        : {
            total: t.num_branches,
            covered: t.covered_branches ?? null,
            skipped: null,
            pct: t.percent_branches_covered ?? pct(t.covered_branches, t.num_branches),
          },
    functions: null, // coverage.py JSON has no function-level totals
    lines: {
      total: t.num_statements ?? null,
      covered: t.covered_lines ?? null,
      skipped: null,
      pct: t.percent_statements_covered ?? pct(t.covered_lines, t.num_statements),
    },
    note: 'coverage.py reports statement+line coverage (identical here); functions are not reported at summary level.',
  };
}

/** Read metrics for a runner from its raw report file. */
export function readMetrics(runner, file) {
  if (runner === 'pytest-cov') return readPythonCoverage(file);
  return readIstanbulSummary(file);
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function isNonNegInt(v) {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * Validate one metric block. Returns a list of problems (empty = valid).
 * A metric must be a complete object with finite integer total/covered, a
 * consistent non-negative coverage relationship, and a finite pct within
 * [0,100] consistent with covered/total.
 */
export function validateMetric(tag, m, { required = true } = {}) {
  const problems = [];
  if (m === null || m === undefined) {
    if (required) problems.push(`${tag} is missing`);
    return problems;
  }
  if (typeof m !== 'object') {
    problems.push(`${tag} must be an object`);
    return problems;
  }
  if (!isNonNegInt(m.total)) problems.push(`${tag}.total must be a non-negative integer (got ${JSON.stringify(m.total)})`);
  if (!isNonNegInt(m.covered)) problems.push(`${tag}.covered must be a non-negative integer (got ${JSON.stringify(m.covered)})`);
  if (isNonNegInt(m.total) && isNonNegInt(m.covered) && m.covered > m.total) {
    problems.push(`${tag}.covered ${m.covered} exceeds total ${m.total}`);
  }
  if (m.skipped !== null && m.skipped !== undefined && !isNonNegInt(m.skipped)) {
    problems.push(`${tag}.skipped must be null or a non-negative integer`);
  }
  if (!isFiniteNumber(m.pct) || m.pct < 0 || m.pct > 100) {
    problems.push(`${tag}.pct must be a finite number in [0,100] (got ${JSON.stringify(m.pct)})`);
  } else if (isNonNegInt(m.total) && m.total > 0 && isNonNegInt(m.covered)) {
    const expected = (m.covered / m.total) * 100;
    if (Math.abs(m.pct - expected) > 0.5) {
      problems.push(`${tag}.pct ${m.pct} is inconsistent with covered/total (${expected.toFixed(4)})`);
    }
  }
  return problems;
}

/**
 * Validate the whole metric set for a result.
 *   - statements + lines are always required with total > 0 (an empty
 *     measurement is not evidence);
 *   - branches are required for every target — including Python, whose branch
 *     coverage is explicitly part of the CleanUp1 requirement;
 *   - functions are required for the JS runners (istanbul reports them) and
 *     legitimately absent for coverage.py.
 */
export function validateMetrics(tag, metrics, { runner } = {}) {
  const problems = [];
  if (!metrics || typeof metrics !== 'object') {
    problems.push(`${tag} is missing the complete metric block`);
    return problems;
  }
  const py = runner === 'pytest-cov';
  problems.push(...validateMetric(`${tag}.statements`, metrics.statements, { required: true }));
  problems.push(...validateMetric(`${tag}.lines`, metrics.lines, { required: true }));
  // Python branch coverage is required, not optional.
  problems.push(...validateMetric(`${tag}.branches`, metrics.branches, { required: true }));
  problems.push(...validateMetric(`${tag}.functions`, metrics.functions, { required: !py }));
  for (const key of ['statements', 'lines']) {
    const m = metrics[key];
    if (m && isNonNegInt(m.total) && m.total === 0) problems.push(`${tag}.${key}.total is 0 — an empty coverage measurement is not evidence`);
  }
  const b = metrics.branches;
  if (b && isNonNegInt(b.total) && b.total === 0) problems.push(`${tag}.branches.total is 0 — branch coverage was not measured`);
  return problems;
}
