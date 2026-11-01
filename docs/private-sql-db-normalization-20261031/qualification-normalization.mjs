/** SOURCE ONLY. No driver, credentials, connection, environment or CLI.
 * Parent may compose this into its existing bounded actual-role harness.
 * query is its already-authenticated ordinary dedicated-reader adapter, with
 * production READ ONLY/timeout/search_path/bypass context and rollback handling.
 * assertActive enforces the parent's explicit qualification deadline/cancel.
 */
import assert from 'node:assert/strict';
import pins from './normalization-pins.json' with { type: 'json' };
import data from './unicode17-contact-data.json' with { type: 'json' };

export function* canonicalNormalizationCorpus() {
  // PostgreSQL UTF8 text cannot contain U+0000 or surrogate code points; this
  // is its existing storage domain, not a new input/alphabet restriction.
  for (let cp = 1; cp < 0x110000; cp++) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue;
    const c = String.fromCodePoint(cp);
    yield c;
    yield c + '\u03a3';
    yield 'A\u03a3' + c;
    yield 'A' + c + '\u03a3' + c + 'A';
  }
  const alphabet = ['#', 'A', '\u0301', '\u0345'];
  const words = [''];
  let layer = [''];
  for (let depth = 1; depth <= 3; depth++) {
    layer = layer.flatMap(prefix => alphabet.map(c => prefix + c));
    words.push(...layer);
  }
  for (const before of words) for (const after of words) {
    yield before + '\u03a3' + after;
    yield before + '\u03a3\u03a3' + after;
  }
  for (const cp of data.trim) {
    const t = String.fromCodePoint(cp);
    yield t;
    yield t + 'A\u03a3' + t;
    yield 'A' + t + '\u03a3';
    yield t.repeat(5) + '\u0130' + t.repeat(3);
  }
  yield 'A' + '\u0345'.repeat(5000) + '\u03a3';
  yield 'A\u03a3' + '\u0301'.repeat(5000) + 'A';
}

export async function qualifyCanonicalNormalization({ query, assertActive }, batchSize = 1024) {
  assert.ok(Number.isSafeInteger(batchSize) && batchSize >= 1 && batchSize <= 4096);
  assert.equal(typeof assertActive, 'function');
  for (const [key, value] of Object.entries(pins.versions)) assert.equal(process.versions[key], value, key);
  assertActive();
  assert.deepEqual(await query(
    'SELECT current_user::text AS current_role, session_user::text AS login_role', []),
  [{ current_role: 'capiro_private_query_ro', login_role: 'capiro_private_query_ro' }]);
  assert.deepEqual(await query(
    'SELECT meri_private.ecmascript_contact_key_u17_v1(NULL::text) AS value', []), [{ value: null }]);
  let cases = 0, batches = 0, batch = [];
  const flush = async () => {
    assertActive();
    const actual = await query(
      'SELECT meri_private.ecmascript_contact_key_u17_v1(x.value) AS value ' +
      'FROM pg_catalog.unnest($1::text[]) WITH ORDINALITY AS x(value, n) ORDER BY x.n', [batch]);
    assert.equal(actual.length, batch.length);
    batch.forEach((input, i) => assert.equal(actual[i].value, input.trim().toLowerCase(),
      'Canonical normalization mismatch at case ' + (cases + i)));
    cases += batch.length;
    batches++;
    batch = [];
    assertActive();
  };
  for (const input of canonicalNormalizationCorpus()) {
    batch.push(input);
    if (batch.length === batchSize) await flush();
  }
  if (batch.length) await flush();
  return { cases, batches, scalarDomain: pins.scalarCount - 1, complete: true };
}
