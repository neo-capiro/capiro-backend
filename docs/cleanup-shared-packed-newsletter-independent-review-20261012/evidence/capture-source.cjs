const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const source = 'fe50dc1c2de1660a036e338cf81acdcf0f2fb26a';
const frontend = 'b680b65e14134be736942b29d715e49c2c6a8b19';
const files = ['packages/shared/package.json', 'packages/shared/tsconfig.json', ...['newsletter', 'newsletter-render', 'newsletter-fonts', 'newsletter-fonts.catalog', 'newsletter-social-share'].map(name => 'packages/shared/src/' + name + '.ts')];
const git = (...args) => cp.execFileSync('git', args, { maxBuffer: 64 * 1024 * 1024 });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const entries = files.map(path => { const bytes = git('show', source + ':' + path); return { path, bytes: bytes.length, sha256: hash(bytes), entry: git('ls-tree', source, '--', path).toString().trim().split('\t')[0] }; });
const pkg = JSON.parse(git('show', source + ':packages/shared/package.json'));
assert.equal(pkg.name, '@capiro/shared'); assert.equal(pkg.version, '0.0.0'); assert.equal(pkg.private, true);
for (const key of ['newsletter', 'newsletter-render']) {
  assert.deepEqual(pkg.exports['./' + key], { types: './dist/' + key + '.d.ts', require: './dist/' + key + '.js', import: './dist/' + key + '.js', default: './dist/' + key + '.js' });
  assert.deepEqual(pkg.typesVersions['*'][key], ['dist/' + key + '.d.ts']);
}
const handover = cp.execFileSync('git', ['-C', '/workspace/capiro-frontend', 'show', frontend + ':docs/newsletter-port-20261012/HANDOVER.md']);
const result = { source, tree: git('rev-parse', source + '^{tree}').toString().trim(), packageName: pkg.name, version: pkg.version, private: true, exports: { newsletter: pkg.exports['./newsletter'], newsletterRender: pkg.exports['./newsletter-render'] }, sourceEntries: entries, frontendHandoff: { source: frontend, tree: cp.execFileSync('git', ['-C', '/workspace/capiro-frontend', 'rev-parse', frontend + '^{tree}']).toString().trim(), file: 'docs/newsletter-port-20261012/HANDOVER.md', bytes: handover.length, sha256: hash(handover) }, producerArtifactAcceptancePending: true, privateSourceConsumerImports: false };
fs.writeFileSync('docs/cleanup-shared-packed-newsletter-independent-review-20261012/evidence/source-before.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source, package: pkg.name, version: pkg.version, sourceBindings: entries.length, frontendHandoff: frontend, artifactPending: true }));
