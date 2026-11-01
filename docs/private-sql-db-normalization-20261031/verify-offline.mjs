// Source/algorithm verification only. Does NOT parse or execute PostgreSQL.
// Reads the emitted SQL constants, models its two passes, and compares against
// the canonical JavaScript oracle exhaustively over scalars and context classes.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const read = name => fs.readFileSync(path.join(here, name), 'utf8');
const pins = JSON.parse(read('normalization-pins.json'));
const data = JSON.parse(read('unicode17-contact-data.json'));
const sql = read('00-canonical-contact-helper-forward.sql');
const body = sql.split('$normalization$')[1];
assert.equal(createHash('sha256').update(body).digest('hex'), pins.functionBodySha256);
assert.equal(createHash('sha256').update(JSON.stringify(data)).digest('hex'), pins.dataSha256);
const mappings = JSON.parse(body.match(/mappings CONSTANT jsonb := \$case_mappings\$([\s\S]+?)\$case_mappings\$::jsonb/)[1]);
const properties = JSON.parse(body.match(/properties CONSTANT jsonb := \$case_properties\$([\s\S]+?)\$case_properties\$::jsonb/)[1]);
const trim = body.match(/trim_characters CONSTANT text := ([^\n]+);/)[1]
  .match(/pg_catalog\.chr\([0-9]+\)/g).map(value => Number(value.match(/[0-9]+/)[0]));
assert.deepEqual(mappings, data.mapping);
assert.deepEqual(properties, data.properties);
assert.deepEqual(trim, data.trim);
assert.equal(sql.includes('SECURITY DEFINER'), false);
assert.equal(body.includes('pg_catalog.lower'), false);
assert.equal(body.includes('FROM public.'), false);
const trimSet = new Set(trim);
function modeledSql(input) {
  let chars = Array.from(input);
  let first = 0, last = chars.length;
  while (first < last && trimSet.has(chars[first].codePointAt(0))) first++;
  while (last > first && trimSet.has(chars[last - 1].codePointAt(0))) last--;
  chars = chars.slice(first, last);
  const flags = [], following = [];
  let next = false, previous = false, result = '';
  for (let i = chars.length - 1; i >= 0; i--) {
    flags[i] = properties[chars[i].codePointAt(0)] ?? 0;
    following[i] = next;
    if (!(flags[i] & 2)) next = Boolean(flags[i] & 1);
  }
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    result += cp === 931 && previous && !following[i] ? '\u03c2' : mappings[cp] ?? chars[i];
    if (!(flags[i] & 2)) previous = Boolean(flags[i] & 1);
  }
  return result;
}
let scalars = 0, scalarContexts = 0, sequences = 0;
const observed = new Set();
const compare = value => assert.equal(modeledSql(value), value.trim().toLowerCase(),
  'Mismatch at code points: ' + Array.from(value, c => c.codePointAt(0).toString(16)).join(','));
for (let cp = 0; cp < 0x110000; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const c = String.fromCodePoint(cp);
  compare(c);
  scalars++;
  observed.add(properties[cp] ?? 0);
  // Every scalar, including unmapped and property-neither characters, tested
  // in left, right and combined FinalSigma contexts in ORIGINAL input order.
  for (const input of [c+'\u03a3', 'A\u03a3'+c, 'A'+c+'\u03a3'+c+'A']) {
    compare(input); scalarContexts++;
  }
}
assert.deepEqual([...observed].sort(), [0,1,2,3]);
const alphabet = ['#', 'A', '\u0301', '\u0345']; // all four context-property classes
let words = [''];
let layer = [''];
for (let depth = 1; depth <= 3; depth++) {
  layer = layer.flatMap(prefix => alphabet.map(c => prefix + c));
  words.push(...layer);
}
for (const before of words) for (const after of words) {
  for (const input of [before+'\u03a3'+after, before+'\u03a3\u03a3'+after]) {
    compare(input); sequences++;
  }
}
for (const cp of data.trim) {
  const t = String.fromCodePoint(cp);
  for (const input of [t, t+'A\u03a3'+t, 'A'+t+'\u03a3', t.repeat(5)+'\u0130'+t.repeat(3)]) {
    compare(input); sequences++;
  }
}
for (const input of ['\u0130', '\u1c89', '\u{10570}', '\u039f\u03a3',
  'A'+'\u0345'.repeat(5000)+'\u03a3', 'A\u03a3'+'\u0301'.repeat(5000)+'A',
  '\u0085A\u03a3\u0085', '\u180eA\u03a3\u200b']) { compare(input); sequences++; }
assert.equal(scalars, pins.scalarCount);
const corrected = read('01-meeting335-canonical-forward.sql');
assert.equal(corrected.includes('und-x-icu'), false);
assert.equal(corrected.includes('ecmascript_contact_key_u17_v1(raw.email)'), true);
assert.equal(corrected.includes('m.organizer_email OPERATOR(public.=) contact.email::public.citext'), true);
assert.equal(corrected.includes('a.email OPERATOR(public.=) contact.email::public.citext'), true);
console.log(JSON.stringify({ result: 'PASS', scalars, scalarContexts, contextSequences: sequences,
  lowercaseMappings: Object.keys(mappings).length, propertyCodePoints: Object.keys(properties).length,
  allFourContextPropertyClasses: true, functionBodySha256: pins.functionBodySha256,
  caveat: 'Offline model of emitted SQL constants/algorithm; PostgreSQL syntax and actual execution NOT RUN.' }, null, 2));
