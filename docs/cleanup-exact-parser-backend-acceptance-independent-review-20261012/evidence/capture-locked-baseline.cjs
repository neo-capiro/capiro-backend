const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const yaml = require('/workspace/capirov2/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml');
const source = '61e9b467295235829e7d8097368ce41b0434818a';
const packet = 'docs/cleanup-exact-parser-backend-acceptance-independent-review-20261012/';
const read = file => cp.execFileSync('git', ['show', source + ':' + file], { maxBuffer: 64 * 1024 * 1024 });
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const lockBytes = read('pnpm-lock.yaml');
const lock = yaml.parse(lockBytes.toString());
const declared = JSON.parse(read('apps/workspace/package.json'));
assert.equal(declared.dependencies.htmlparser2, '8.0.2');
assert.deepEqual(lock.importers['apps/workspace'].dependencies.htmlparser2, { specifier: '8.0.2', version: '8.0.2' });
assert.equal(lock.packages['htmlparser2@8.0.2'].resolution.integrity, 'sha512-GYdjWKDkbRLkZ5geuHs5NY1puJ+PXwP7+fHPRz06Eirsb9ugf6d8kkXav6ADhcODhFFPMIXyxkxSuMf3D6NCFA==');
assert.deepEqual(lock.snapshots['htmlparser2@8.0.2'].dependencies, { domelementtype: '2.3.0', domhandler: '5.0.3', domutils: '3.2.2', entities: '4.5.0' });
const files = ['pnpm-lock.yaml', 'apps/workspace/package.json', 'apps/workspace/jest.config.cjs', 'apps/workspace/tsconfig.json', 'apps/workspace/tsconfig.build.json', 'apps/workspace/src/newsletters/newsletter-link-preview.service.ts', 'apps/workspace/src/newsletters/newsletter-link-preview.service.spec.ts'];
const result = {
  source, tree: cp.execFileSync('git', ['rev-parse', source + '^{tree}'], { encoding: 'utf8' }).trim(),
  importer: lock.importers['apps/workspace'].dependencies.htmlparser2,
  package: lock.packages['htmlparser2@8.0.2'], snapshot: lock.snapshots['htmlparser2@8.0.2'],
  transitiveSnapshots: Object.fromEntries(['domelementtype@2.3.0', 'domhandler@5.0.3', 'domutils@3.2.2', 'entities@4.5.0', 'dom-serializer@2.0.0'].map(key => [key, { package: lock.packages[key], snapshot: lock.snapshots[key] }])),
  files: files.map(path => { const bytes = read(path); return { path, bytes: bytes.length, sha256: hash(bytes), entry: cp.execFileSync('git', ['ls-tree', source, '--', path], { encoding: 'utf8' }).trim().split('\t')[0] }; }),
  existingJestIgnoredDiagnosticsNotChanged: [151002, 2307, 7006],
  fullWorkspaceTypesAndActualExactParserRuntimeAcceptancePending: true,
  actualApplicationNativeDatabaseSqlProviderParserExecution: false,
};
fs.mkdirSync(packet + 'evidence', { recursive: true });
fs.writeFileSync(packet + 'evidence/locked-baseline.json', JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ source, parser: '8.0.2', lockIntegrity: result.package.resolution.integrity, frozenFiles: files.length, parserExecution: false }));
