// Offline generator. No network, driver or database. Supply the three pinned UCD
// source files explicitly; generation refuses any byte/version/semantic mismatch.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const ucdDirectory = process.argv[2];
if (!ucdDirectory) throw new Error('Usage: node generate.mjs <offline Unicode17 UCD directory>');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const sources = {
  'UnicodeData.txt': '2e1efc1dcb59c575eedf5ccae60f95229f706ee6d031835247d843c11d96470c',
  'SpecialCasing.txt': 'efc25faf19de21b92c1194c111c932e03d2a5eaf18194e33f1156e96de4c9588',
  'DerivedCoreProperties.txt': '24c7fed1195c482faaefd5c1e7eb821c5ee1fb6de07ecdbaa64b56a99da22c08',
};
const text = {};
for (const [name, expected] of Object.entries(sources)) {
  const bytes = fs.readFileSync(path.join(ucdDirectory, name));
  assert.equal(sha(bytes), expected, name + ' source identity');
  text[name] = bytes.toString('utf8');
}
const versions = { node: '24.22.1', v8: '13.6.233.17-node.58', icu: '78.3', unicode: '17.0' };
for (const [key, value] of Object.entries(versions)) assert.equal(process.versions[key], value, key);
const scalarCount = 0x110000 - 0x800;
const lower = new Map();
for (const line of text['UnicodeData.txt'].split('\n')) {
  if (!line) continue;
  const fields = line.split(';');
  if (fields[13]) lower.set(parseInt(fields[0], 16), String.fromCodePoint(parseInt(fields[13], 16)));
}
const neutralContexts = [];
for (const line of text['SpecialCasing.txt'].split('\n')) {
  const source = line.split('#')[0].trim();
  if (!source) continue;
  const fields = source.split(';').map(x => x.trim());
  const cp = parseInt(fields[0], 16);
  const value = String.fromCodePoint(...fields[1].split(/\s+/).filter(Boolean).map(x => parseInt(x, 16)));
  if (!fields[4]) lower.set(cp, value);
  else if (!/\b(?:tr|az|lt)\b/i.test(fields[4])) neutralContexts.push({ cp, value, condition: fields[4] });
}
assert.deepEqual(neutralContexts, [{ cp: 0x3a3, value: '\u03c2', condition: 'Final_Sigma' }]);
const flags = new Uint8Array(0x110000);
for (const line of text['DerivedCoreProperties.txt'].split('\n')) {
  const source = line.split('#')[0].trim();
  if (!source) continue;
  const [range, property] = source.split(';').map(x => x.trim());
  const mask = property === 'Cased' ? 1 : property === 'Case_Ignorable' ? 2 : 0;
  if (!mask) continue;
  const [first, last = first] = range.split('..').map(x => parseInt(x, 16));
  for (let cp = first; cp <= last; cp++) flags[cp] |= mask;
}
const trim = [9,10,11,12,13,32,160,5760,8192,8193,8194,8195,8196,8197,8198,8199,8200,8201,8202,8232,8233,8239,8287,12288,65279];
const trimSet = new Set(trim);
const mapping = {}, properties = {}, sparse = [];
const behaviorHash = createHash('sha256').update('meri-js-contact-normalization-v1\n');
const hexes = value => Array.from(value, c => c.codePointAt(0).toString(16)).join(',');
for (let cp = 0; cp < 0x110000; cp++) {
  if (cp >= 0xd800 && cp <= 0xdfff) continue;
  const value = String.fromCodePoint(cp);
  const expected = lower.get(cp) ?? value;
  assert.equal(value.toLowerCase(), expected, 'UCD lowercase U+' + cp.toString(16));
  const actualFlags = (/\p{Cased}/u.test(value) ? 1 : 0) | (/\p{Case_Ignorable}/u.test(value) ? 2 : 0);
  assert.equal(actualFlags, flags[cp], 'UCD properties U+' + cp.toString(16));
  assert.equal(value.trim() === '', trimSet.has(cp), 'ECMAScript trim U+' + cp.toString(16));
  if (expected !== value) mapping[cp] = expected;
  if (flags[cp]) properties[cp] = flags[cp];
  if (expected !== value || flags[cp] || trimSet.has(cp)) {
    sparse.push(cp);
    behaviorHash.update(cp + ':' + hexes(expected) + ':' + flags[cp] + ':' + Number(trimSet.has(cp)) + '\n');
  }
}
// Binding includes all relevant mapping/property/trim code points in both
// FinalSigma contexts, including Cased intersect Case_Ignorable and sequences.
for (const cp of [35, ...sparse]) {
  const c = String.fromCodePoint(cp);
  const contexts = [c+'\u03a3', 'A'+c+'\u03a3', 'A\u03a3'+c, 'A\u03a3'+c+'A',
    'A'+c+'\u03a3A', 'A'+c+'\u03a3'+c, 'A\u03a3'+c+'\u03a3', 'A'+c+c+'\u03a3'+c+c+'A'];
  contexts.forEach((input, i) => behaviorHash.update(cp + '/' + i + ':' + hexes(input.trim().toLowerCase()) + '\n'));
}
const data = { unicode: '17.0.0', algorithm: 'ECMAScript-trim-default-lowercase-FinalSigma-v1', mapping, properties, trim };
const dataJson = JSON.stringify(data);
const dataSha256 = sha(dataJson);
const asciiJson = object => JSON.stringify(object).replace(/[\u007f-\uffff]/g, c => '\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'));
const body = [
  '\n-- ' + data.algorithm + '; Unicode ' + data.unicode,
  '-- Data SHA256 ' + dataSha256 + '; no server case/locale operations.',
  'DECLARE',
  "  mappings CONSTANT jsonb := $case_mappings$"+asciiJson(mapping)+"$case_mappings$::jsonb;",
  "  properties CONSTANT jsonb := $case_properties$"+asciiJson(properties)+"$case_properties$::jsonb;",
  '  trim_characters CONSTANT text := '+trim.map(cp => 'pg_catalog.chr('+cp+')').join(' || ')+';',
  '  characters text[] := pg_catalog.string_to_array(pg_catalog.btrim(input, trim_characters), NULL);',
  '  size integer := coalesce(pg_catalog.cardinality(characters), 0);',
  '  character_flags integer[] := pg_catalog.array_fill(0, ARRAY[size]);',
  '  following_cased boolean[] := pg_catalog.array_fill(false, ARRAY[size]);',
  '  next_cased boolean := false;',
  '  previous_cased boolean := false;',
  '  result text := \'\';',
  '  i integer;',
  '  code integer;',
  'BEGIN',
  "  IF size = 0 THEN RETURN ''; END IF;",
  '  FOR i IN REVERSE size..1 LOOP',
  '    code := pg_catalog.ascii(characters[i]);',
  '    character_flags[i] := coalesce((properties ->> code::text)::integer, 0);',
  '    following_cased[i] := next_cased;',
  '    -- Case_Ignorable wins even when a character is also Cased.',
  '    IF (character_flags[i] & 2) = 0 THEN',
  '      next_cased := (character_flags[i] & 1) <> 0;',
  '    END IF;',
  '  END LOOP;',
  '  FOR i IN 1..size LOOP',
  '    code := pg_catalog.ascii(characters[i]);',
  '    IF code = 931 AND previous_cased AND NOT following_cased[i] THEN',
  '      result := result || pg_catalog.chr(962);',
  '    ELSE',
  '      result := result || coalesce(mappings ->> code::text, characters[i]);',
  '    END IF;',
  '    IF (character_flags[i] & 2) = 0 THEN',
  '      previous_cased := (character_flags[i] & 1) <> 0;',
  '    END IF;',
  '  END LOOP;',
  '  RETURN result;',
  'END\n',
].join('\n');
const bodySha256 = sha(body);
const pins = { algorithm: data.algorithm, unicode: data.unicode, versions, scalarCount,
  lowercaseMappings: Object.keys(mapping).length, propertyCodePoints: Object.keys(properties).length,
  trimCodePoints: trim.length, neutralContexts, dataSha256, behaviorSha256: behaviorHash.digest('hex'),
  functionBodySha256: bodySha256, sources };
const helper = 'meri_private.ecmascript_contact_key_u17_v1';
const sql = [
  '-- SOURCE ONLY successor normalization prerequisite. No existing view or migration is replaced.',
  '-- Generated offline by generate.mjs from pinned Unicode17 data and canonical Node behavior.',
  'BEGIN;', 'SET LOCAL search_path = pg_catalog;',
  "DO $precondition$ BEGIN IF pg_catalog.current_setting('server_encoding') <> 'UTF8' THEN",
  "  RAISE EXCEPTION 'Canonical contact normalization requires existing UTF8 storage';",
  'END IF; END $precondition$;',
  'SET LOCAL ROLE capiro_private_projection_owner;',
  'CREATE FUNCTION '+helper+'(input text) RETURNS text',
  'LANGUAGE plpgsql IMMUTABLE STRICT SECURITY INVOKER PARALLEL SAFE',
  'SET search_path = pg_catalog', 'AS $normalization$'+body+'$normalization$;',
  'REVOKE ALL ON FUNCTION '+helper+'(text) FROM PUBLIC;',
  '-- View callers require EXECUTE; this pure function has no data or definer authority.',
  'GRANT EXECUTE ON FUNCTION '+helper+'(text) TO capiro_private_query_ro;',
  'RESET ROLE;', 'COMMIT;', '',
].join('\n');
fs.writeFileSync(path.join(here,'unicode17-contact-data.json'), JSON.stringify(data,null,2)+'\n');
fs.writeFileSync(path.join(here,'normalization-pins.json'), JSON.stringify(pins,null,2)+'\n');
fs.writeFileSync(path.join(here,'00-canonical-contact-helper-forward.sql'), sql);
fs.writeFileSync(path.join(root,'apps/api/src/meri/analytics/private-sql-normalization-pins.ts'),
  '// Generated by docs/private-sql-db-normalization-20261031/generate.mjs; do not hand-edit.\n'+
  'export const PRIVATE_SQL_NORMALIZATION_PINS = '+JSON.stringify(pins,null,2)+' as const;\n');

const oldMeeting = fs.readFileSync(path.join(root, 'docs/private-sql-db-domains-20261031/01-meeting335-forward.sql'), 'utf8').replace(/\r\n/g, '\n');
assert.equal(sha(oldMeeting), '5f023d62330c1217e98c442b76bee68dfbe374b997a5a6522429a643c5a1bb19');
const prerequisiteStart = oldMeeting.indexOf('  -- Locale-independent');
const prerequisiteEnd = oldMeeting.indexOf('  IF (SELECT count(*)', prerequisiteStart);
const prerequisite = [
  '  IF NOT EXISTS (',
  '    SELECT 1 FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace',
  "    WHERE n.nspname = 'meri_private' AND p.proname = 'ecmascript_contact_key_u17_v1'",
  "      AND p.proargtypes = '25'::pg_catalog.oidvector AND p.prorettype = 25",
  "      AND p.proowner = 'capiro_private_projection_owner'::regrole",
  "      AND NOT p.prosecdef AND p.proisstrict AND p.provolatile = 'i'",
  "      AND p.proconfig = ARRAY['search_path=pg_catalog']::text[]",
  "      AND pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p.prosrc, 'UTF8')), 'hex') = '"+bodySha256+"'",
  "  ) THEN RAISE EXCEPTION 'Pinned canonical ECMAScript contact helper required'; END IF;",
  '',
].join('\n');
let meeting = oldMeeting.slice(0, prerequisiteStart)+prerequisite+oldMeeting.slice(prerequisiteEnd);
const contactStart = meeting.indexOf('        -- ECMAScript trim');
const contactEnd = meeting.indexOf('\n      ) contact',contactStart);
meeting = meeting.slice(0,contactStart)+[
  '        -- Exact pinned JS contact transform; no meeting-side normalization.',
  '        -- Keep database-default collation for the unchanged actual citext comparison.',
  '        SELECT meri_private.ecmascript_contact_key_u17_v1(raw.email)',
  '          COLLATE pg_catalog."default" AS email',
].join('\n')+meeting.slice(contactEnd);
meeting = meeting.replace('-- SOURCE ONLY: newly authored missing meeting335 predecessor. Not previously qualified/applied.',
  '-- SOURCE ONLY: corrected successor to the frozen ICU-based meeting proposal.\n'+
  '-- Requires 00-canonical-contact-helper-forward.sql; old proposal is preserved, never applied.\n'+
  '-- All ownership/association/citext predicates below remain unchanged.');
fs.writeFileSync(path.join(here,'01-meeting335-canonical-forward.sql'),meeting);

console.log(JSON.stringify(pins,null,2));
