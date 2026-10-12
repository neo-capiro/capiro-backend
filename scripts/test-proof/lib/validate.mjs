/**
 * Canonical dump validation — the fail-closed front door of the diff.
 *
 * The diff engine must never treat an arbitrary JSON blob as an "empty passing
 * comparison". A dump that is raw unconverted runner JSON, a truncated file, or
 * `{}` is REJECTED with a diagnostic; it is never silently read as zero scope.
 *
 * A deliberately valid ZERO-SCOPE snapshot (a run that genuinely discovered no
 * targets) is still a dump with the canonical schema, a version, AND an explicit
 * `scope` object. That is what lets a real empty run be told apart from
 * malformed input: malformed input is missing the schema/version/scope, an
 * empty run still declares them.
 *
 * This module is pure: no I/O, so the fixture tests can prove the contract.
 */

import { DUMP_SCHEMA, SCHEMA_VERSION, RUNNERS, STATUSES, TARGET_STATUS } from './schema.mjs';

const RUNNER_SET = new Set(RUNNERS);
const STATUS_SET = new Set(STATUSES);
const TARGET_STATUS_SET = new Set(Object.values(TARGET_STATUS));

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {unknown} dump
 * @param {string} [label]  side label used in diagnostics ("before"/"after")
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function validateDump(dump, label = 'dump') {
  const problems = [];

  if (!isPlainObject(dump)) {
    return { ok: false, problems: [`${label}: not a canonical dump object (got ${dump === null ? 'null' : Array.isArray(dump) ? 'array' : typeof dump})`] };
  }

  if (dump.schema !== DUMP_SCHEMA) {
    problems.push(`${label}: schema must be "${DUMP_SCHEMA}" (got ${JSON.stringify(dump.schema)}); raw/unconverted runner JSON is not a dump`);
  }

  if (dump.schemaVersion !== SCHEMA_VERSION) {
    problems.push(`${label}: schemaVersion must be ${SCHEMA_VERSION} (got ${JSON.stringify(dump.schemaVersion)})`);
  }

  if (!Array.isArray(dump.targets)) {
    problems.push(`${label}: targets must be an array (got ${Array.isArray(dump.targets) ? 'array' : typeof dump.targets})`);
  }

  // An explicit scope object is REQUIRED. It is what distinguishes a validated
  // zero-scope snapshot from a malformed empty object.
  if (!isPlainObject(dump.scope)) {
    problems.push(`${label}: scope must be an object; a zero-scope snapshot must still declare explicit scope (got ${Array.isArray(dump.scope) ? 'array' : typeof dump.scope})`);
  }

  if (Array.isArray(dump.targets)) {
    dump.targets.forEach((t, i) => {
      const tag = `${label}: targets[${i}]`;
      if (!isPlainObject(t)) {
        problems.push(`${tag} is not an object`);
        return;
      }
      if (typeof t.package !== 'string' || t.package.length === 0) {
        problems.push(`${tag}.package must be a non-empty string (got ${JSON.stringify(t.package)})`);
      }
      if (!RUNNER_SET.has(t.runner)) {
        problems.push(`${tag}.runner must be one of ${RUNNERS.join(', ')} (got ${JSON.stringify(t.runner)})`);
      }
      if (!TARGET_STATUS_SET.has(t.status)) {
        problems.push(`${tag}.status must be one of ${[...TARGET_STATUS_SET].join(', ')} (got ${JSON.stringify(t.status)})`);
      }
      if (t.tier !== null && t.tier !== undefined && typeof t.tier !== 'string') {
        problems.push(`${tag}.tier must be a string or null (got ${JSON.stringify(t.tier)})`);
      }
      if (!Array.isArray(t.tests)) {
        problems.push(`${tag}.tests must be an array`);
        return;
      }
      t.tests.forEach((test, j) => {
        const ttag = `${tag}.tests[${j}]`;
        if (!isPlainObject(test)) {
          problems.push(`${ttag} is not an object`);
          return;
        }
        if (typeof test.suite !== 'string') {
          problems.push(`${ttag}.suite must be a string (got ${JSON.stringify(test.suite)})`);
        }
        if (typeof test.fullName !== 'string' || test.fullName.length === 0) {
          problems.push(`${ttag}.fullName must be a non-empty string (got ${JSON.stringify(test.fullName)})`);
        }
        if (!STATUS_SET.has(test.status)) {
          problems.push(`${ttag}.status must be one of ${STATUSES.join(', ')} (got ${JSON.stringify(test.status)})`);
        }
      });
    });
  }

  return { ok: problems.length === 0, problems };
}
