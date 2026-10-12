const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const ts = require('/workspace/capirov2/node_modules/typescript');
const base = '61e9b467295235829e7d8097368ce41b0434818a';
const source = 'e2f04d1a0d0f035a4f2fbf6e502323915c4240ba';
const packet = 'docs/cleanup-newsletter-mocked-fixture-independent-review-20261012/evidence/';
const git = (...args) => cp.execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const read = (pin, file) => git('show', pin + ':' + file).toString();
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tree = pin => new Map(git('ls-tree', '-r', '-z', pin).toString().split('\0').filter(Boolean).map(row => { const [entry, file] = row.split('\t'); return [file, entry]; }));
const paths = ['apps/workspace/src/newsletters/newsletter-image-revisions.spec.ts', 'apps/workspace/src/newsletters/newsletter-survey.spec.ts', 'apps/workspace/src/newsletters/newsletter-stock-image.spec.ts'];
const before = tree(base), after = tree(source);
const changes = [...new Set([...before.keys(), ...after.keys()])].filter(file => before.get(file) !== after.get(file));
assert.deepEqual(changes.sort(), [...paths].sort());
const expectedEdits = {
  [paths[0]]: [
    ["where.token ? { id: parent, revisionRootId: root } : { folderId: null },", "where.token ? { id: parent, revisionRootId: root, ownerId: ctx.clerkUserId } : { folderId: null },", 1],
    ["findFirst: jest.fn().mockResolvedValue({ config: {}, design: { sections: [] } }),", "findFirst: jest.fn().mockResolvedValue({ ownerId: ctx.clerkUserId, config: {}, design: { sections: [] } }),", 1],
    [".mockResolvedValueOnce({ id: parent, revisionRootId: root } as never)", ".mockResolvedValueOnce({ id: parent, revisionRootId: root, ownerId: ctx.clerkUserId } as never)", 2],
    ["f.asset.findFirst.mockResolvedValue({ id: parent, revisionRootId: root } as never);", "f.asset.findFirst.mockResolvedValue({ id: parent, revisionRootId: root, ownerId: ctx.clerkUserId } as never);", 1],
  ],
  [paths[1]]: [["    ).toContain('draft');", "    ).toBe('Hosted surveys are not enabled for newsletters. Remove this block before staging.');", 1]],
  [paths[2]]: [["    await app.init();", "    await app.listen(0, '127.0.0.1');", 1]],
};
const caseCalls = (file, content) => {
  const ast = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true);
  assert.deepEqual(ast.parseDiagnostics, []);
  const names = [];
  function walk(node) {
    if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const callee = node.expression.getText(ast);
      if (/^(?:describe|it|test)(?:\.|\(|$)/.test(callee)) names.push([callee, node.arguments[0].text]);
    }
    ts.forEachChild(node, walk);
  }
  walk(ast);
  return names;
};
const bindings = paths.map(file => {
  const original = read(base, file), candidate = read(source, file);
  let expected = original, inverse = candidate;
  for (const [old, next, count] of expectedEdits[file]) {
    assert.equal(expected.split(old).length - 1, count);
    expected = expected.split(old).join(next);
    assert.equal(inverse.split(next).length - 1, count);
    inverse = inverse.split(next).join(old);
  }
  assert.equal(candidate, expected, `only seven authorized line edits: ${file}`);
  assert.equal(inverse, original, `full original inverse bytes: ${file}`);
  assert.equal(candidate, fs.readFileSync(file, 'utf8'));
  assert.deepEqual(caseCalls(file, candidate), caseCalls(file, original));
  assert.equal(after.get(file).split(' ')[0], before.get(file).split(' ')[0]);
  return { file, originalSha256: hash(original), candidateSha256: hash(candidate), gitEntry: after.get(file), sourceCaseCalls: caseCalls(file, original), completeInverseOriginalBytesExact: true };
});
for (const [file, entry] of before) if (!paths.includes(file)) assert.equal(after.get(file), entry, file);
git('merge-base', '--is-ancestor', base, source);
const owner = 'apps/workspace/src/newsletters/newsletter.service.ts';
assert.equal(before.get(owner), after.get(owner));
const ownerSource = read(base, owner);
assert(ownerSource.includes('if (source.ownerId !== ctx.clerkUserId) {'));
assert(ownerSource.includes('if (row.ownerId !== ctx.clerkUserId) {'));
assert(ownerSource.includes("'Hosted surveys are not enabled for newsletters. Remove this block before staging.'"));
const images = read(source, paths[0]);
for (const assertion of ["toContain('FOR UPDATE')", 'ctx.tenantId, ctx.clerkUserId', 'expect(f.asset.create).not.toHaveBeenCalled()', 'expect(f.imageEditor.refine).not.toHaveBeenCalled()', "toContain('octet_length(file)')", 'currentRevision: false', 'ConflictException']) assert(images.includes(assertion));
const stock = read(source, paths[2]);
for (const assertion of ['await app.close()', '.expect(403)', '.expect(400)', '.expect(201)', 'expect(stock.get).not.toHaveBeenCalled()', "expect(stock.get).toHaveBeenCalledWith('123')", 'expect(newsletters.importAsset).toHaveBeenCalledWith(']) assert(stock.includes(assertion));
const result = {
  source, tree: git('rev-parse', source + '^{tree}').toString().trim(), base,
  sourcePaths: 3, changedLines: 7, bindings, existingOutsideThreeEntriesExact: before.size - 3,
  allProductionPackageLockSchemaMigrationOwnerEntriesExact: true,
  ownerFileEntry: before.get(owner), fullOriginalAssertionsAndCaseIdentitiesRetainedExceptExactSurveyDetail: true,
  mandatorySameOwnerRowsCorrectedNotAuthorityBypassed: true, surveyBlanketDisabledNoPublishedException: true,
  listener: 'awaited 127.0.0.1 port0 in isolated mock HTTP test; teardown retained',
  originalPaidCallNoWriteTenantOwnerRaceAndHttpAssertionsRetained: true,
  reviewSourceOnlyNoApplicationSqlProviderExecution: true,
};
fs.writeFileSync(packet + 'source-proof.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source, tree: result.tree, changedPaths: 3, changedLines: 7, protectedExistingEntries: result.existingOutsideThreeEntriesExact, inverseAndCaseIdentity: true }));
