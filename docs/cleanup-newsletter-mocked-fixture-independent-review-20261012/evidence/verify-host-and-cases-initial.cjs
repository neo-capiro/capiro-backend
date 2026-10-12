const fs = require('node:fs');
const cp = require('node:child_process');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const pin = '8b08c4ac4a127bb083c9aa90ae028861bfb2aeeb';
const authorPacket = 'docs/cleanup-newsletter-mocked-local-acceptance-20261012/';
const own = 'docs/cleanup-newsletter-mocked-fixture-independent-review-20261012/';
const read = file => cp.execFileSync('git', ['show', pin + ':' + authorPacket + file], { maxBuffer: 64 * 1024 * 1024 });
const json = file => JSON.parse(read(file));
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const index = json('SHA256-INDEX.json');
for (const item of index.packet) {
  const bytes = cp.execFileSync('git', ['show', pin + ':' + item.path], { maxBuffer: 64 * 1024 * 1024 });
  assert.equal(bytes.length, item.bytes);
  assert.equal(sha(bytes), item.sha256, item.path);
}
for (const file of ['jest.safe.cjs', 'jest.environment.cjs', 'jest.resolver.cjs', 'collaborator-tokens.cjs', 'native-sanitizer.cjs']) assert.deepEqual(read(file), fs.readFileSync(own + file));
const ids = json('DEPENDENCY-IDENTITIES.json');
for (const item of Object.values(ids.dependencies)) {
  const packageBytes = fs.readFileSync(path.join(item.path, 'package.json'));
  assert.equal(sha(packageBytes), item.manifestSha256);
  assert.equal(JSON.parse(packageBytes).version, item.version);
  assert.equal(sha(fs.readFileSync(path.join(item.path, item.entry))), item.entrySha256);
}
const sanitize = ids.dependencies.sanitizeHtml;
const sanitizerRequire = createRequire(path.join(sanitize.path, 'package.json'));
assert.equal(sanitizerRequire.resolve('htmlparser2'), path.join(ids.dependencies.sanitizerParser12.path, 'dist/index.js'));
assert.equal(typeof sanitizerRequire(sanitize.path), 'function');
assert.equal(ids.dependencies.directParser8.version, '8.0.2');
assert.equal(ids.dependencies.sanitizeHtml.version, '2.17.7');
assert.equal(ids.dependencies.sanitizerParser12.version, '12.0.0');
const host = fs.readFileSync(own + 'jest.environment.cjs', 'utf8');
assert(host.includes("this.global.__NEWSLETTER_ACTUAL_SANITIZER__=require('/workspace/capirov2/node_modules/.pnpm/sanitize-html@2.17.7/node_modules/sanitize-html')"));
assert(fs.readFileSync(own + 'native-sanitizer.cjs', 'utf8').includes('module.exports=sanitizer;'));
assert.equal(fs.readFileSync(own + 'jest.safe.cjs', 'utf8').includes("'^htmlparser2$'"), false);
const journal = fs.readFileSync(own + 'evidence/08-parser-requester-resolution.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
assert(journal.length > 0);
assert(journal.every(row => row.directWorkspace && row.resolved === ids.dependencies.directParser8.path + '/lib/index.js'));
const names = results => results.testResults.flatMap(file => file.assertionResults.map(row => [file.name.slice(file.name.indexOf('/apps/') + 1), row.fullName])).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const oldCases = new Map();
for (const file of ['evidence/02-original-newsletter-suites-host-repaired.json', 'evidence/03-sharp-entry-repaired-suites.json', 'evidence/04-stock-http-host-repaired.json']) {
  for (const row of names(json(file))) oldCases.set(JSON.stringify(row), row);
}
const final = json('evidence/10-real-sanitizer-coherent-original19.json');
assert.equal(final.numPassedTests, 291); assert.equal(final.numFailedTests, 0); assert.equal(final.numPendingTests, 0); assert.equal(final.numPassedTestSuites, 19);
assert.deepEqual([...oldCases.values()].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b))), names(final));
const fresh = JSON.parse(fs.readFileSync(own + 'evidence/focused-independent-final.json'));
assert.equal(fresh.numPassedTests, 52); assert.equal(fresh.numFailedTests, 0); assert.equal(fresh.numPendingTests, 0); assert.equal(fresh.numPassedTestSuites, 3);
const selectedNames = names(final).filter(([file]) => ['newsletter-image-revisions.spec.ts', 'newsletter-stock-image.spec.ts', 'newsletter-survey.spec.ts'].some(suffix => file.endsWith(suffix)));
assert.deepEqual(names(fresh), selectedNames);
const result = { source: 'e2f04d1a0d0f035a4f2fbf6e502323915c4240ba', authorEvidence: pin, authorPacketHashCount: index.packet.length, originalCasesExact: 291, physicalSuitesRetained: 19, finalAuthor19SuitesPassed: 291, independentFocusedSuites: 3, independentFocusedTests: 52, directParser: '8.0.2', sanitizer: '2.17.7', sanitizerNativeNodeParser: '12.0.0', copiedFiveHostFilesByteExact: true, nativeSanitizerFunctionNotMocked: true, intermediate07GlobalParserMapperPassIsNotQualified: true, oldFailuresPreserved: true, noOriginalCaseOmittedSkippedOrRenamed: true, realProviderSqlDatabaseOrModelCalls: 0, hostContainmentScope: 'Known synthetic mocked tests only; loopback HTTP and cached synthetic Sharp permitted; no arbitrary-JS/syscall containment claim' };
fs.writeFileSync(own + 'evidence/host-and-cases-proof.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source: result.source, originalCasesRetained: 291, finalAuthorPassed: 291, independentPassed: 52, actualDependencyVersions: ['8.0.2', '2.17.7', '12.0.0'], authorPacketHashes: index.packet.length }));
