/* Source-only lock audit. No install, package loading, native execution or network. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const roots = ['apps/api', 'packages/shared', 'packages/meriv2-core', 'packages/defense-contracts', 'packages/defense-domain'];
const targets = ['promptfoo', '@huggingface/transformers', 'onnxruntime-node', 'onnxruntime-web', '@openai/codex-security', 'sharp', 'libsql', '@libsql/client', '@swc/core'];
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function resolveEdge(lock, parent, name, value) {
  const version = typeof value === 'string' ? value : value.version;
  assert.equal(typeof version, 'string');
  if (version.startsWith('link:')) {
    assert(parent.startsWith('importer:'), 'Unexpected snapshot workspace link');
    const importer = path.posix.normalize(path.posix.join(parent.slice(9), version.slice(5)));
    return Object.hasOwn(lock.importers, importer) ? `importer:${importer}` : null;
  }
  // pnpm aliases name an actual snapshot directly; peer suffixes stay intact.
  return Object.hasOwn(lock.snapshots, `${name}@${version}`) ? `${name}@${version}` :
    Object.hasOwn(lock.snapshots, version) ? version : null;
}
function closure(lock, importerRoots, importerSections) {
  const nodes = new Map(), edges = [], unresolved = [];
  const queue = importerRoots.map(root => ({ key: `importer:${root}`, proof: [] }));
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const { key, proof } = queue[cursor];
    if (nodes.has(key)) continue;
    nodes.set(key, proof);
    const importer = key.startsWith('importer:');
    const record = importer ? lock.importers[key.slice(9)] : lock.snapshots[key];
    assert(record, `Missing node ${key}`);
    for (const kind of importer ? importerSections : ['dependencies', 'optionalDependencies']) {
      for (const [name, reference] of Object.entries(record[kind] || {})) {
        const to = resolveEdge(lock, key, name, reference);
        const edge = { from: key, kind, dependencyName: name, reference, to };
        edges.push(edge);
        if (!to) unresolved.push(edge);
        else queue.push({ key: to, proof: [...proof, edge] });
      }
    }
  }
  return { nodes, edges, unresolved };
}
function sourceAudit(root) {
  const starts = ['apps/api/src', 'apps/api/scripts', ...roots.slice(1).map(r => `${r}/src`)];
  const files = [], literalMatches = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name);
      assert(!entry.isSymbolicLink(), `Source symlink requires review: ${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const bytes = fs.readFileSync(file), relative = path.relative(root, file).split(path.sep).join('/');
        files.push({ path: relative, bytes: bytes.length, sha256: digest(bytes) });
        if (/\.(?:[cm]?[jt]sx?|sh|inc|py|json)$/.test(file)) {
          const lines = bytes.toString('utf8').split(/\r?\n/);
          for (let i = 0; i < lines.length; i++) for (const name of targets.slice(0, 5)) {
            if (lines[i].includes(name)) literalMatches.push({ path: relative, line: i + 1, target: name,
              classification: relative.includes('/qualification/') ? 'QUALIFICATION_SOURCE_REFERENCE_NOT_APPLICATION_ACTIVATION_PROOF' : 'SOURCE_REFERENCE_REQUIRES_REVIEW' });
          }
        }
      }
    }
  }
  for (const start of starts) walk(path.join(root, start));
  return { roots: starts, files, literalMatches, completeness: 'COMPLETE_FILES_IN_LISTED_SOURCE_ROOTS',
    interpretation: 'Literal source inventory only; no AST, arbitrary dynamic loading, compiled-image or product execution proof.' };
}
function audit(root, yaml) {
  const inputSHA256 = {};
  const contractInputs = ['package.json', 'pnpm-lock.yaml', ...roots.map(root => `${root}/package.json`)];
  const read = file => {
    let bytes = fs.readFileSync(path.join(root, file));
    if (contractInputs.includes(file)) {
      // Bind every contract input to immutable Git archive bytes. Windows
      // checkout EOL differences are permitted only after a byte-equivalent
      // text proof; semantic source changes require a new committed source pin.
      const canonical = execFileSync('git', ['show', `HEAD:${file}`], { cwd: root });
      bytes = canonicalInputBytes(bytes, canonical);
    }
    inputSHA256[file] = digest(bytes); return bytes.toString('utf8');
  };
  const lock = yaml.parse(read('pnpm-lock.yaml'));
  read('scripts/qualification/runtime-production-closure.cjs');
  assert.equal(Number(lock.lockfileVersion), 9);
  const rootManifest = JSON.parse(read('package.json'));
  for (const importer of roots) {
    const manifest = JSON.parse(read(`${importer}/package.json`));
    for (const section of ['dependencies', 'optionalDependencies']) {
      assert.deepEqual(Object.keys(manifest[section] || {}).sort(), Object.keys(lock.importers[importer][section] || {}).sort());
      for (const [name, specifier] of Object.entries(manifest[section] || {}))
        assert.equal(lock.importers[importer][section][name].specifier, specifier, `${importer} ${name} manifest/lock drift`);
    }
  }
  assert.equal(rootManifest.devDependencies.promptfoo, '0.123.1');
  const production = closure(lock, roots, ['dependencies', 'optionalDependencies']);
  const development = closure(lock, ['.'], ['devDependencies']);
  assert.equal(production.unresolved.length, 0, 'Incomplete production graph');
  assert.equal(development.unresolved.length, 0, 'Incomplete development graph');
  const snapshots = [...production.nodes].filter(([key]) => !key.startsWith('importer:')).sort(([a], [b]) => a.localeCompare(b));
  const result = { mode: 'SOURCE_ONLY_DECLARED_LOCK_CLOSURE', sourceHead: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    inputSHA256, productionImporterRoots: roots, productionImporters: roots.map(key => ({ key: `importer:${key}`,
      dependencies: lock.importers[key].dependencies || {}, optionalDependencies: lock.importers[key].optionalDependencies || {} })),
    allLockSnapshots: Object.keys(lock.snapshots).length,
    productionSnapshotCount: snapshots.length, productionUnresolvedEdges: [], productionEdges: production.edges,
    productionSnapshots: snapshots.map(([key, proof]) => {
      const packageKey = key.split('(')[0], split = packageKey.lastIndexOf('@');
      const metadata = lock.packages[packageKey];
      assert(metadata, `Missing package metadata ${packageKey}`);
      return { key, snapshotId: key, packageKey, name: packageKey.slice(0, split), version: packageKey.slice(split + 1),
        peerContext: key.slice(packageKey.length), integrity: metadata.resolution?.integrity || null,
        resolution: metadata.resolution || null, os: metadata.os || null, cpu: metadata.cpu || null, libc: metadata.libc || null,
        snapshot: lock.snapshots[key], pathProof: proof };
    }),
    rootDevelopmentSnapshotCount: [...development.nodes.keys()].filter(k => !k.startsWith('importer:')).length,
    rootDevelopmentUnresolvedEdges: [], targets: {}, sourceAudit: sourceAudit(root),
    limits: ['Declared lock closure is not the installed image graph or payload selection proof.',
      'Optional edges are included conservatively; none are removed by platform-name inference.',
      'Fresh production dependency stage still requires Prisma/native/script/full-startup/scan qualification.'] };
  for (const name of targets) {
    const keys = Object.keys(lock.snapshots).filter(key => key.startsWith(`${name}@`));
    const incomingEdges = [];
    for (const [parent, record] of [...Object.entries(lock.importers).map(([k, v]) => [`importer:${k}`, v]), ...Object.entries(lock.snapshots)]) {
      for (const kind of parent.startsWith('importer:') ? ['dependencies', 'optionalDependencies', 'devDependencies'] : ['dependencies', 'optionalDependencies'])
        if (Object.hasOwn(record[kind] || {}, name)) incomingEdges.push({ from: parent, kind, dependencyName: name,
          reference: record[kind][name], to: resolveEdge(lock, parent, name, record[kind][name]) });
    }
    result.targets[name] = { snapshotKeys: keys, productionReachable: keys.some(key => production.nodes.has(key)), incomingEdges,
      rootDevelopmentPathProofs: keys.filter(key => development.nodes.has(key)).map(key => ({ key, pathProof: development.nodes.get(key) })) };
  }
  result.runtimeClosureContract = {
    schemaVersion: 1,
    inputSHA256: Object.fromEntries(contractInputs.map(file => [file, inputSHA256[file]])),
    roots: roots.map(root => {
      const manifest = JSON.parse(fs.readFileSync(path.join(rootPath(root), 'package.json'), 'utf8'));
      return { key: `importer:${root}`, path: root, name: manifest.name, version: manifest.version };
    }),
    nodes: result.productionSnapshots.map(row => {
      const metadata = lock.packages[row.packageKey];
      return { key: row.key, name: row.name, version: row.version, peerContext: row.peerContext,
        resolution: row.resolution, os: row.os, cpu: row.cpu, libc: row.libc,
        hasBin: metadata.hasBin === true, requiresBuild: metadata.requiresBuild === true,
        engines: metadata.engines || null, peerDependencies: metadata.peerDependencies || {},
        peerDependenciesMeta: metadata.peerDependenciesMeta || {} };
    }),
    edges: production.edges.map(({ from, dependencyName, kind, to }) => ({ from, dependencyName, kind, to })),
    unresolvedEdges: [],
  };
  function rootPath(importer) { return path.join(root, importer); }
  return result;
}
function canonicalInputBytes(checkout, canonical) {
  assert(Buffer.isBuffer(checkout) && Buffer.isBuffer(canonical));
  if (checkout.equals(canonical)) return canonical;
  const normalized = [];
  for (let i = 0; i < checkout.length; i++) {
    if (checkout[i] === 13 && checkout[i + 1] === 10) continue;
    normalized.push(checkout[i]);
  }
  assert(Buffer.from(normalized).equals(canonical), 'Contract input checkout/source drift');
  return canonical;
}
function serializeAudit(result, contractOnly = false) {
  return JSON.stringify(contractOnly ? result.runtimeClosureContract : result, null, 2) + '\n';
}
module.exports = { resolveEdge, closure, audit, canonicalInputBytes, serializeAudit };
if (require.main === module) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf('--out');
  let outputPath;
  if (outIndex >= 0) { assert(outIndex + 1 < args.length); outputPath = args[outIndex + 1]; args.splice(outIndex, 2); }
  assert(args.length === 2 || (args.length === 3 && args[2] === '--contract'), 'Usage: node runtime-production-closure.cjs --yaml-module <local-yaml-path> [--contract]');
  assert.equal(args[0], '--yaml-module');
  const root = path.resolve(__dirname, '../..');
  const result = audit(root, require(path.resolve(args[1])));
  const text = serializeAudit(result, args[2] === '--contract');
  if (outputPath) fs.writeFileSync(path.resolve(outputPath), text);
  else process.stdout.write(text);
}
