const fs = require('node:fs'), assert = require('node:assert/strict'), cp = require('node:child_process'), crypto = require('node:crypto');
const dir = 'docs/cleanup-meri-local-dispatch-independent-review-20261012/', evidence = dir + 'evidence/';
const source = '7ea444c74a5637577aa0eb3cb99cb420b5f8223e', author = 'd3e0efacf59fb64361c612c01da5ae8a6f19e426';
const read = name => JSON.parse(fs.readFileSync(evidence + name, 'utf8'));
const wiring = read('adoption-wiring-review.json'), replay = read('independent-replay.json'), proof = read('source-proof.json'), refusals = read('adoption-refusals.json');
assert.equal(wiring.source, source); assert.equal(refusals.source, source);
assert.equal(refusals.refusals, 18); assert.equal(refusals.results.length, 18); assert(refusals.results.every(row => row.errors.length));
assert.equal(replay.source, author); assert.equal(replay.comparisons, 48);
assert.equal(proof.source, author); assert.equal(proof.caseCallbacksExactOriginalExpressionsAndStatements, 134);
for (const log of ['oracle-887.log', 'adopted-alias-direct-node-887.log']) assert(/Tests:\s+887 passed, 887 total/.test(fs.readFileSync(evidence + log, 'utf8')));
assert.equal(fs.readFileSync(evidence + 'focused-strict.log').length, 0); assert.equal(fs.readFileSync(evidence + 'full-core-cached-types.log').length, 0);
const index = JSON.parse(fs.readFileSync('docs/cleanup-meri-local-dispatch-conversion-20261012/SHA256-INDEX.json', 'utf8'));
for (const entry of index.entries) {
  const bytes = fs.readFileSync(entry.path);
  assert.equal(bytes.length, entry.bytes); assert.equal(crypto.createHash('sha256').update(bytes).digest('hex'), entry.sha256);
}
assert.equal(index.entries.length, 42);
const result = {
  disposition: 'ACCEPTED within the Meri application and four adoption-hunk source-only scope', source,
  tree: wiring.tree, authorApplicationPacket: author, authorApplicationSource: index.sourceCommit,
  originalBase: proof.base, originalSwitchSha256: proof.originalSwitchSha256,
  reviewedApplicationPaths: wiring.originalAuthorApplicationBlobsAndModesExact,
  reviewedAdoptionPaths: ['scripts/registry-ownership.json', 'scripts/duplicate-helper-names.txt', 'package.json', '.github/workflows/ci-pr.yml'],
  freshChecks: { inertOracle887: '887/887 PASS at author packet', independentBeforeAfterComparisons: 48, successiveOwnerReplays: 4, concurrentRpActorContexts: 4,
    focusedStrictTypecheck: 'PASS at author packet', fullCoreCachedTypecheck: 'PASS at author packet', adoptedAliasExactJestArgsViaNode: '887/887 PASS at integrated source',
    currentOwnerProfiles: 5, currentSourceFiles: 2199, currentOwnerInspectionErrors: 0, actualCoreMutationSourceFiles: refusals.baseline.files,
    parseOnlyMutationRefusals: 18, inventoryRefusals: 2, helperInventory: 7 },
  applicationCheckCarry: { reason: 'All three application blobs and modes match the original author packet exactly', proof: 'evidence/adoption-wiring-review.json' },
  preservation: { baseline: wiring.base, outsideOverlayPaths: wiring.protectedPaths, outsideOverlayAppPaths: wiring.protectedApps,
    schemaMigrationPaths: wiring.schemasAndMigrations, priorDocumentPaths: wiring.priorDocuments, authorChecksumEntries: index.entries.length,
    otherFourProfilesExact: true, priorSixInventoryRowsByteExact: true, allPriorPackageValuesExact: true, allPriorWorkflowValuesAndTextExact: true },
  correctedReviewerFailures: [
    { source: author, program: 'evidence/source-proof-first.cjs', rawLogs: ['evidence/source-proof-first.log', 'evidence/source-proof.log'], exitCode: 1,
      classification: 'Reviewer layout oracle false positive: printer preserves source line breaks. Corrected to exact scanner tokens; retained original byte-preservation assertions.' },
    { source: author, program: 'evidence/independent-replay-first.cjs', rawLogs: ['evidence/independent-replay-first.log', 'evidence/independent-replay.log'], exitCode: 1,
      classification: 'Reviewer lexical regex false positive: existing in-process comment. Corrected to executable Identifier nodes; no forbidden executable identifiers or resources allowed.' },
  ],
  excludedReviewScopes: ['Generic ownership guard implementation (separate reviewer)', 'Other four application conversions (separate reviewers)', 'Unpublished scoped EngagementService reporting source'],
  limits: ['Bounded declaration/import/carrier grammar; no arbitrary JS or renamed semantic-copy containment',
    'Cancellation and authority retain original behavior; no rollback or new cancellation guarantee',
    'Full Core TSC was run on the author packet; only exact Meri source conclusions are carried to the integrated source',
    'No pnpm alias, package installation, CI invocation, database, SQL, native engine, provider, model, security or deployment operations',
    'Wider cleanup/native gates, historical documentation/manifest gaps and separate production-source reconciliation remain open',
    '123 deferred clock samples and prior native readiness conditions are unchanged'],
  newRuntimeImportsInHelper: 0, routesDtoSchemaFrontendContractChanges: 0, sourceEditsByReviewer: 0, nativeAcceptance: false,
};
fs.writeFileSync(dir + 'ACCEPTANCE.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
