/**
 * Stage B — Step B2: Layer 1 deterministic eval.
 *
 * For every golden under `eval/goldens/<strategyType>/*.json`, this runs the
 * REAL `verifyPlan` (from `@capiro/strategy-verifier` — the same "consumer 3"
 * primitive the orchestrator's repair loop and api-strategy's write-gate both
 * call) against the fixture's own concrete `plan.nodes`, and separately checks
 * that those same nodes satisfy the fixture's own `expectedPlanShape`.
 *
 * There is no LLM call and no stubbed-orchestrator round-trip here: the
 * golden's `plan.nodes` field IS the canned "what the orchestrator would have
 * returned" stand-in (see golden.types.ts's doc comment). Zero errors and a
 * shape match are both required for a golden to be considered internally
 * valid — this is the "goldens must pass their own constraints" self-test.
 *
 * Pure, deterministic, no network/DB — safe to run in CI on every PR.
 */
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { verifyPlan, type VerifierNode } from '@capiro/strategy-verifier';
import type { Golden, GoldenStrategyType } from './goldens/golden.types.js';

export interface GoldenFile {
  strategyType: GoldenStrategyType;
  slug: string;
  path: string;
  golden: Golden;
}

/** Walk `eval/goldens/<strategyType>/*.json`, skipping non-JSON files (e.g.
 *  `golden.types.ts`). Directory-driven — new goldens need no harness edit. */
export function loadGoldens(goldensRoot: string = join(__dirname, 'goldens')): GoldenFile[] {
  const out: GoldenFile[] = [];
  for (const entry of readdirSync(goldensRoot)) {
    const dir = join(goldensRoot, entry);
    if (!statSync(dir).isDirectory()) continue;
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const path = join(dir, file);
      const golden = JSON.parse(readFileSync(path, 'utf8')) as Golden;
      out.push({ strategyType: entry as GoldenStrategyType, slug: file.replace(/\.json$/, ''), path, golden });
    }
  }
  return out;
}

export interface ShapeCheckResult {
  ok: boolean;
  failures: string[];
}

/** Checks a concrete node list against a golden's `expectedPlanShape`:
 *  node count in range, every required kind/subject present at least once,
 *  and every ordering assertion holds (before.startsOn <= after.startsOn). */
export function checkShape(nodes: VerifierNode[], shape: Golden['expectedPlanShape']): ShapeCheckResult {
  const failures: string[] = [];
  const [min, max] = shape.nodeCountRange;
  if (nodes.length < min || nodes.length > max) {
    failures.push(`node count ${nodes.length} outside expected range [${min}, ${max}]`);
  }

  const kinds = new Set(nodes.map((n) => n.kind));
  for (const k of shape.requiredKinds) {
    if (!kinds.has(k)) failures.push(`missing required kind "${k}"`);
  }

  const subjects = new Set(nodes.map((n) => n.subject));
  for (const s of shape.requiredSubjects) {
    if (!subjects.has(s)) failures.push(`missing required subject "${s}"`);
  }

  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const a of shape.orderingAssertions) {
    const before = byId.get(a.beforeNodeId);
    const after = byId.get(a.afterNodeId);
    if (!before || !after) {
      failures.push(`orderingAssertion "${a.description}" references an unknown node id`);
      continue;
    }
    if (before.startsOn > after.startsOn) {
      failures.push(
        `orderingAssertion violated: ${a.description} (${a.beforeNodeId}=${before.startsOn} > ${a.afterNodeId}=${after.startsOn})`,
      );
    }
  }

  return { ok: failures.length === 0, failures };
}

export interface L1Result {
  strategyType: string;
  slug: string;
  verifyErrors: string[];
  verifyWarnings: string[];
  shapeFailures: string[];
  ok: boolean;
}

export function runOne(gf: GoldenFile): L1Result {
  const { golden, strategyType } = gf;
  const check = verifyPlan({
    strategyType,
    nodes: golden.plan.nodes,
    fiscal: golden.clientContextFixture.fiscal,
    congress: golden.clientContextFixture.congress ?? [],
    ppbeCurrentPhases: golden.clientContextFixture.ppbeCurrentPhases ?? [],
  });
  const verifyErrors = check.violations
    .filter((v) => v.severity === 'error')
    .map((v) => `[${v.code}] ${v.message}`);
  const verifyWarnings = check.violations
    .filter((v) => v.severity === 'warning')
    .map((v) => `[${v.code}] ${v.message}`);
  const shape = checkShape(golden.plan.nodes, golden.expectedPlanShape);

  return {
    strategyType,
    slug: gf.slug,
    verifyErrors,
    verifyWarnings,
    shapeFailures: shape.failures,
    ok: verifyErrors.length === 0 && shape.ok,
  };
}

export function runL1(goldensRoot?: string): L1Result[] {
  return loadGoldens(goldensRoot).map(runOne);
}

/** Standalone CLI entry (`pnpm eval:l1` also runs this via jest — see the
 *  package.json script — but this lets the report be inspected directly). */
if (require.main === module) {
  const results = runL1();
  let failed = 0;
  for (const r of results) {
    const label = `${r.strategyType}/${r.slug}`;
    if (r.ok) {
      console.log(`PASS  ${label}`);
    } else {
      failed += 1;
      console.log(`FAIL  ${label}`);
      for (const e of r.verifyErrors) console.log(`      verify error: ${e}`);
      for (const f of r.shapeFailures) console.log(`      shape failure: ${f}`);
    }
    for (const w of r.verifyWarnings) console.log(`      verify warning: ${w}`);
  }
  console.log(`\n${results.length - failed}/${results.length} goldens passed.`);
  if (failed > 0) process.exit(1);
}
