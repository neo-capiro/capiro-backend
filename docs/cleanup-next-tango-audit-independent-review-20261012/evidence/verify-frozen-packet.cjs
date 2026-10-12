// Read-only evidence/source binding check. Git subprocesses only read objects;
// no application module, constructor, entrypoint, transport or provider runs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const ts = require('/workspace/capirov2/node_modules/typescript');
const head = 'ed43dbb5bad37763688a9553680253f9b756fca1';
const tree = 'a11b987ee629d316a7074cd0587716216137599f';
const base = '6a4b48e6286a270ab18c033eb4ccaf6f72f42c70';
const packet = 'docs/cleanup-next-tango-seam-audit-20261012/';
const review = 'docs/cleanup-next-tango-audit-independent-review-20261012/';
const git = (...args) => execFileSync('git', args);
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const read = (file) => fs.readFileSync(file);
const json = (file) => JSON.parse(read(file));
assert.equal(git('rev-parse', head + '^{tree}').toString().trim(), tree);
const changes = git('diff', '--name-status', base, head).toString().trim().split('\n');
assert.equal(changes.length, 17);
assert(changes.every((line) => line.startsWith('A\t' + packet)));
const index = json(packet + 'SHA256.json');
assert.equal(index.files.length, 16);
assert.equal(new Set(index.files.map((r) => r.path)).size, 16);
for (const row of index.files) {
  assert.equal(hash(read(row.path)), row.sha256, row.path);
  assert.deepEqual(read(row.path), git('show', head + ':' + row.path), row.path);
}
assert.deepEqual(read(packet + 'SHA256.json'), git('show', head + ':' + packet + 'SHA256.json'));
const source = json(packet + 'SOURCE-PRESERVATION.json');
assert.equal(source.source, base);
assert.equal(source.files.length, 28);
assert.equal(new Set(source.files.map((r) => r.path)).size, 28);
for (const row of source.files) {
  assert.equal(hash(read(row.path)), row.sha256, row.path);
  assert.deepEqual(read(row.path), git('show', base + ':' + row.path), row.path);
  assert.deepEqual(read(row.path), git('show', head + ':' + row.path), row.path);
  assert.deepEqual(git('ls-tree', base, '--', row.path), git('ls-tree', head, '--', row.path), row.path);
}
for (const name of ['original-leaf-differential', 'original-envelope-profiles']) {
  for (const extension of ['mjs', 'json']) {
    assert.deepEqual(read(review + 'evidence/author-replay/' + name + '.' + extension), read(packet + 'evidence/' + name + '.' + extension));
  }
}
for (const file of ['leaf.stderr.log', 'envelope.stderr.log']) {
  assert.equal(read(review + 'evidence/author-replay/' + file).length, 0);
}
const proof = json(review + 'evidence/independent-leaf-line-and-call-proof.json');
let lines = 0;
for (const row of proof.records) {
  const text = read(row.file).toString();
  const sf = ts.createSourceFile(row.file, text, ts.ScriptTarget.Latest, true);
  for (const expected of row.functions) {
    const declarations = sf.statements.filter((s) => ts.isFunctionDeclaration(s) && s.name?.text === expected.name);
    assert.equal(declarations.length, 1);
    const fn = declarations[0];
    const start = sf.getLineAndCharacterOfPosition(fn.getStart(sf)).line + 1;
    const end = sf.getLineAndCharacterOfPosition(fn.end).line + 1;
    assert.equal(start, expected.startLine);
    assert.equal(end, expected.endLine);
    assert.equal(hash(fn.getText(sf)), expected.sha256);
    lines += end - start + 1;
  }
  const client = sf.statements.find((s) => ts.isClassDeclaration(s) && s.name?.text.endsWith('Client') && s.members.some(ts.isConstructorDeclaration));
  assert.equal(client.members.find(ts.isConstructorDeclaration).getText(sf), row.clientConstructorSource);
  const calls = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ['rateOf', 'this.fetchImpl'].includes(node.expression.getText(sf))) calls.push(node.expression.getText(sf));
    ts.forEachChild(node, visit);
  };
  visit(client);
  assert.equal(calls.filter((c) => c === 'rateOf').length, row.file.includes('subaward') ? 1 : 2);
  assert.equal(calls.filter((c) => c === 'this.fetchImpl').length, 1);
}
assert.equal(lines, 109);
const leaf = json(review + 'evidence/author-replay/original-leaf-differential.json');
assert.equal(leaf.cases, 68);
assert.equal(leaf.results.length, 68);
assert.equal(leaf.originalExecutions, 204);
assert.equal(leaf.profileProbeCases, 3);
assert.equal(leaf.profileProbeExecutions, 9);
assert.equal(leaf.totalOriginalLeafExecutions, 213);
const fields = ['x-ratelimit-remaining', 'x-ratelimit-limit', 'x-ratelimit-reset-in', 'retry-after'];
const interleaved = fields.flatMap((f) => ['get:' + f, 'coerce:' + f]).concat('get:x-ratelimit-type');
const captured = fields.map((f) => 'get:' + f).concat(fields.map((f) => 'coerce:' + f), 'get:x-ratelimit-type');
assert.deepEqual(leaf.outOfContractHeaderTrace.map((r) => r.trace), [interleaved, interleaved, captured]);
assert.deepEqual(leaf.outOfContractThrowTrace.map((r) => r.trace), [interleaved.slice(0, 2), interleaved.slice(0, 2), captured.slice(0, 5)]);
assert.deepEqual(leaf.outOfContractMutationTrace.map((r) => r.rate.limit), [1, 1, 0]);
assert.deepEqual(leaf.results.find((r) => r.name === 'get property getter reads and binds every call').observed.map((r) => r.outcome.returned.reads), [5, 5, 5]);
const envelope = json(review + 'evidence/author-replay/original-envelope-profiles.json');
assert.equal(envelope.results.length, 54);
const coherent = json(review + 'evidence/error-realm-challenge-with-full-profiles.json');
assert.equal(coherent.coherentOriginalResults.length, 54);
assert.equal(coherent.sameResults, 50);
assert.deepEqual(coherent.authoredMessageDifferences.map((r) => [r.client, r.label]), [
  ['dibbs', 'changing results getter'], ['sbir', 'changing results getter'],
  ['subaward', 'null'], ['subaward', 'changing results getter'],
]);
for (const difference of coherent.authoredMessageDifferences) {
  assert.equal(difference.authored.result.threw.message, 'TypeError: ' + difference.coherent.result.threw.message);
  assert.equal(difference.authored.result.threw.status, difference.coherent.result.threw.status);
  assert.equal(difference.authored.result.threw.name, difference.coherent.result.threw.name);
}
const initial = json(review + 'evidence/error-realm-challenge.json');
assert.deepEqual(initial.authoredMessageDifferences, coherent.authoredMessageDifferences);
const capacity = json(packet + 'evidence/independent-review-capacity.json');
assert.equal(capacity.acceptanceProduced, false);
assert.equal(capacity.modelOverride, false);
assert(read(packet + 'evidence/original-envelope-profiles-first-failure.log').length > 0);
console.log(JSON.stringify({
  authorHead: head, authorTree: tree, base,
  node: process.version, cachedTypeScript: ts.version,
  docsOnlyAddedPaths: changes.length, indexedPacketHashesVerified: index.files.length,
  frozenSourceHashesModesAndGitBlobsVerified: source.files.length,
  pureDeclarationAstLines: lines, rateCallSites: [2, 2, 1], originalFetchCallSites: [1, 1, 1],
  authoredFragmentReplayExecutions: 267, authorReplayOutputsByteExact: true,
  explicitStableThrowingAndMutationTracesVerified: true,
  coherentOriginalParserProfiles: 54, unchangedAuthorProfiles: 50,
  qualifiedMalformedEnvelopeMessageProfiles: 4,
  historicalFailureAndCapacityReceiptsUnchanged: true,
  proposedPureLeafDesignAcceptedOnlyWithinDocumentedProfiles: true,
  productionImplementationAccepted: false, nativeOrFullGateAcceptance: false,
}, null, 2));
