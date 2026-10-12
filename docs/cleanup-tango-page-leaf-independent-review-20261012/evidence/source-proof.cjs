const assert = require('node:assert/strict');
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const ts = require('typescript');
const base = '802bbd0b2c510a44e46a9952d8127e7edc55aaaa';
const head = '34bd52b6f49393f49732cf1f918002ba0893574d';
const author = '6d243a1393b8736544e1d216cf2bd141595dd315';
const packet = 'docs/cleanup-tango-page-leaf-conversion-20261012/evidence/';
const OUT = 'docs/cleanup-tango-page-leaf-independent-review-20261012/evidence/';
const git = (...args) => cp.execFileSync('git', args);
const rows = [];
for (const owner of ['dibbs', 'sbir', 'subaward']) {
  const file = `apps/api/src/external/tango/tango-${owner}.client.ts`;
  const original = fs.readFileSync(packet + `originals/tango-${owner}.client.ts.txt`, 'utf8');
  assert.equal(original, git('show', `${base}:${file}`).toString());
  const current = fs.readFileSync(file, 'utf8');
  assert.equal(current, git('show', `${head}:${file}`).toString());
  assert.equal(current, git('show', `${author}:${file}`).toString());
  const old = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
  const now = ts.createSourceFile(file, current, ts.ScriptTarget.Latest, true);
  assert.equal(now.parseDiagnostics.length, 0);
  const profile = owner === 'subaward' ? 'captured' : 'interleaved';
  const classes = old.statements.filter(ts.isClassDeclaration);
  for (const before of classes) {
    const after = now.statements.find(n => ts.isClassDeclaration(n) && n.name.text === before.name.text);
    assert(after);
    assert.equal(after.getText(now).replaceAll(`rateOf(response.headers, '${profile}')`, 'rateOf(response.headers)'), before.getText(old));
  }
  const helperNodes = old.statements.filter(n => ts.isFunctionDeclaration(n) && ['asCount', 'nextPageOf', 'rateOf'].includes(n.name?.text));
  assert.equal(helperNodes.length, 3); assert.equal(now.statements.filter(ts.isFunctionDeclaration).length, 0);
  let expected = original;
  for (const n of [...helperNodes].reverse()) expected = expected.slice(0, n.getFullStart()) + expected.slice(n.end);
  const occurrences = expected.split('rateOf(response.headers)').length - 1;
  assert.equal(occurrences, owner === 'subaward' ? 1 : 2);
  expected = expected.replaceAll('rateOf(response.headers)', `rateOf(response.headers, '${profile}')`);
  expected = expected.replace(/\n/, "\nimport { asCount, nextPageOf, rateOf } from './tango-rest-page.js';\n");
  if (owner === 'subaward') expected = expected.replace('import { TangoNotConfiguredError, type TangoRateMetadata }', 'import { TangoNotConfiguredError }');
  assert.equal(current, expected);
  rows.push({ owner, path: file, profile, profileOperands: occurrences, classesByteExactAfterOnlyProfileOperands: classes.map(c => c.name.text),
    originalSha256: crypto.createHash('sha256').update(original).digest('hex'), candidateSha256: crypto.createHash('sha256').update(current).digest('hex') });
}
const paths = [...rows.map(r => r.path), 'apps/api/src/external/tango/tango-rest-page.ts', 'apps/api/src/external/tango/tango-rest-page.spec.ts'];
for (const file of paths) assert(fs.readFileSync(file).equals(git('show', `${author}:${file}`)));
const changed = git('diff', '--name-only', base, head).toString().split('\n').filter(Boolean);
assert.deepEqual(changed.filter(p => p.startsWith('apps/')).sort(), paths.sort());
const originalManifest = JSON.parse(fs.readFileSync('docs/cleanup-tango-page-leaf-conversion-20261012/SHA256.json', 'utf8'));
assert.equal(originalManifest.manifestExcludesSelf, true);
const originalDocs = originalManifest.files;
assert(Array.isArray(originalDocs));
for (const { path: file, sha256: digest } of originalDocs) {
  assert(file.startsWith('docs/cleanup-tango-page-leaf-conversion-20261012/'));
  assert.equal(crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'), digest);
}
const guarded = [
  'apps/api/src/external/tango/tango.errors.ts', 'apps/api/src/external/tango/tango-sbir.client.spec.ts',
  'apps/api/src/external/tango/tango-subaward.client.spec.ts', 'apps/api/src/external/tango/tango-http.ts',
];
const existingGuarded = [];
for (const file of guarded) {
  if (!fs.existsSync(file)) continue;
  assert(fs.readFileSync(file).equals(git('show', `${base}:${file}`))); existingGuarded.push(file);
}
const result = { acceptedApplicationSource: head, tree: git('rev-parse', head + '^{tree}').toString().trim(), originalBase: base,
  exactApplicationAuthorAncestor: author, appPaths: paths, rows,
  completeClassBodiesTransportAuthDeadlineRetryRedactionAndErrorIdentitiesExact: true,
  onlyChangesOutsideClasses: 'Remove nine original pure functions; add three canonical imports; drop unused Subaward rate type',
  exactOriginalErrorsAndExistingTests: existingGuarded,
  authorPacketHashesVerified: originalDocs.length,
  rootNineControlPathsApplicationAcceptance: false, actualProviderOrDatabaseCalls: 0 };
fs.writeFileSync(OUT + 'source-proof.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
