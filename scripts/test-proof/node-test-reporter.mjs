/**
 * node:test structured reporter for the test-name proof.
 *
 * WHY THIS EXISTS: a naive `ok N - name` regex over TAP cannot reconstruct
 * nested `describe` suites, cannot tell a suite container from a leaf test, and
 * cannot preserve two identical test names. This module consumes Node's
 * official test-runner EVENT STREAM (the same events the built-in reporters
 * use) and reconstructs a definite full name and status for every leaf test.
 *
 * It is importable and pure from the transform's point of view: `eventsToTests`
 * takes an array of `{type, data}` events and returns canonical records, so a
 * fixture test can prove nested-suite reconstruction without invoking a runner.
 *
 * Invoked by Node as `--test-reporter=<this file>`; the default export is the
 * stream consumer, and it writes JSON to `process.env.TEST_PROOF_OUT_FILE`
 * (a file — not stdout — so any test-code stdout cannot contaminate the report).
 */

import fs from 'node:fs';

function keyOf(nesting, name) {
  return `${nesting}\u0000${name}`;
}

/**
 * Serialize a runner error (and its `cause` chain) into plain, JSON-safe data so
 * the real failure detail survives into the owned report area. This is
 * ADDITIVE diagnostics only: it never changes the canonical name/status/ancestor
 * mapping, and it must NEVER throw — the report writer calls JSON.stringify on
 * the whole payload, so an unhandled BigInt / circular `actual`/`expected` would
 * otherwise erase the ENTIRE structured report. Every value (including
 * `actual`/`expected`/`cause`, arrays, nested objects, BigInt, symbols,
 * functions, Date, RegExp and primitives thrown directly) is converted to a
 * JSON-safe representation rather than dropped or faked as success.
 */
export function serializeError(err) {
  const seen = new WeakSet();
  const safe = (v) => {
    if (v === null || v === undefined) return null;
    const t = typeof v;
    if (t === 'bigint') return { bigint: v.toString() };
    if (t === 'string' || t === 'boolean') return v;
    if (t === 'number') return Number.isFinite(v) ? v : String(v);
    if (t === 'symbol') return { symbol: String(v) };
    if (t === 'function') return { function: v.name || 'anonymous' };
    if (t !== 'object') return String(v);
    // Leaf object types never need cycle bookkeeping.
    if (v instanceof Date) return v.toISOString();
    if (v instanceof RegExp) return String(v);
    // Error ownership belongs to `one()`: do NOT pre-mark an Error as `seen`
    // here, or a nested Error (e.g. an assertion `actual` that itself holds an
    // Error) would be wrongly reported as {circular:true} and lose its message.
    if (v instanceof Error) return one(v);
    if (seen.has(v)) return { circular: true };
    seen.add(v);
    if (Array.isArray(v)) return v.map(safe);
    const out = {};
    for (const k of Object.keys(v)) {
      try {
        out[k] = safe(v[k]);
      } catch {
        out[k] = { unreadable: true };
      }
    }
    return out;
  };
  const one = (e) => {
    if (e === null || e === undefined) return null;
    const t = typeof e;
    if (t !== 'object') {
      // A thrown primitive (string/number/symbol/…) is preserved faithfully.
      return { thrown: t, value: safe(e) };
    }
    if (seen.has(e)) return { circular: true };
    seen.add(e);
    const out = {};
    // Every error field is converted through `safe` so a BigInt `code` (or any
    // non-standard field) can never make JSON.stringify throw and erase the
    // whole structured report.  Fields that are absent are not invented.
    for (const k of ['name', 'message', 'code', 'failureType', 'operator']) {
      if (e[k] !== undefined) out[k] = safe(e[k]);
    }
    out.actual = safe(e.actual);
    out.expected = safe(e.expected);
    if (typeof e.stack === 'string') out.stack = e.stack;
    if (e.cause !== undefined && e.cause !== null) out.cause = one(e.cause);
    // Retain any additional own fields (syscall/errno/custom diagnostics) safely.
    for (const k of Object.keys(e)) {
      if (k === 'name' || k === 'message' || k === 'code' || k === 'failureType'
          || k === 'operator' || k === 'actual' || k === 'expected' || k === 'stack' || k === 'cause') continue;
      try {
        out[k] = safe(e[k]);
      } catch {
        out[k] = { unreadable: true };
      }
    }
    return out;
  };
  try {
    return one(err);
  } catch (e) {
    return { name: 'Error', message: `error serialization failed: ${e && e.message}` };
  }
}

/**
 * @param {Array<{type:string,data:object}>} events
 * @returns {Array<{fullName:string,status:string,ancestors:string[],error?:object}>}
 */
export function eventsToTests(events) {
  const tests = [];
  const stack = []; // open nodes: { name, nesting }
  const started = new Set();

  const truncate = (nesting) => {
    while (stack.length > 0 && stack[stack.length - 1].nesting >= nesting) stack.pop();
  };

  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue;
    const data = ev.data || {};
    const nesting = typeof data.nesting === 'number' ? data.nesting : 0;
    const name = data.name;

    if (ev.type === 'test:start') {
      if (name == null) continue;
      truncate(nesting);
      stack.push({ name, nesting });
      started.add(keyOf(nesting, name));
      continue;
    }

    if (ev.type === 'test:pass' || ev.type === 'test:fail') {
      const detailsType = data.details && data.details.type;
      if (detailsType === 'suite') {
        // Suite container — never a test occurrence.
        truncate(nesting);
        continue;
      }
      const key = keyOf(nesting, name);
      if (!started.has(key)) {
        // The root "file" node (or an aborted node) never emitted a start.
        continue;
      }
      const ancestors = stack.filter((n) => n.nesting < nesting).map((n) => n.name);
      const fullName = [...ancestors, name].filter(Boolean).join(' > ');
      let status;
      if (ev.type === 'test:fail') status = 'failed';
      else if (data.skip) status = 'skipped';
      else if (data.todo) status = 'todo';
      else status = 'passed';
      const record = { fullName, status, ancestors };
      // Additive only: retain the real failure error (with cause/assertion
      // detail) on a failed occurrence. The canonical mapping above
      // (fullName/status/ancestors) is unchanged.
      if (ev.type === 'test:fail' && data.details && data.details.error) {
        record.error = serializeError(data.details.error);
      }
      tests.push(record);
    }
  }
  return tests;
}

export default async function* reporter(source) {
  const events = [];
  for await (const ev of source) {
    if (ev && typeof ev.type === 'string' && ev.type.startsWith('test:')) {
      events.push({ type: ev.type, data: pick(ev.data) });
    }
  }
  const outFile = process.env.TEST_PROOF_OUT_FILE;
  const tests = eventsToTests(events);
  const failures = events
    .filter((ev) => ev.type === 'test:fail' && ev.data && ev.data.details && ev.data.details.error)
    .map((ev) => ({ name: ev.data.name, error: serializeError(ev.data.details.error) }));
  const payload = { tests, diagnostics: { failures } };
  if (outFile) {
    fs.writeFileSync(outFile, JSON.stringify(payload));
  } else {
    process.stdout.write(JSON.stringify(payload));
  }
}

function pick(data = {}) {
  const d = data.details || {};
  return {
    name: data.name,
    nesting: data.nesting,
    testNumber: data.testNumber,
    skip: data.skip,
    todo: data.todo,
    details: { type: d.type, file: d.file, error: d.error },
  };
}
