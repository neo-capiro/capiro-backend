/* Read-only locked dependency graph; never loads package code or calls a registry. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const yaml = require('/workspace/capirov2/node_modules/.pnpm/yaml@2.9.1/node_modules/yaml');
const lockBytes = fs.readFileSync('pnpm-lock.yaml');
const lock = yaml.parse(lockBytes.toString());
const store = '/workspace/capirov2/node_modules/.pnpm';
const cached = new Map();
for (const bucket of fs.readdirSync(store)) {
  const nm = path.join(store, bucket, 'node_modules');
  if (!fs.existsSync(nm)) continue;
  for (const first of fs.readdirSync(nm)) {
    let names;
    try { names = first.startsWith('@') ? fs.readdirSync(path.join(nm, first)).map(n => first+'/'+n) : [first]; }
    catch { continue; }
    for (const name of names) {
      const file = path.join(nm, name, 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(file));
        const key = pkg.name+'@'+pkg.version;
        const realPackageDir = fs.realpathSync(path.dirname(file));
        if (!cached.has(key)) cached.set(key, new Map());
        cached.get(key).set(realPackageDir, { realPackageDir,
          packageJsonSha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'),
          lifecycleScripts: Object.fromEntries(Object.entries(pkg.scripts || {}).filter(([k]) =>
            ['preinstall', 'install', 'postinstall', 'prepare'].includes(k))) });
      } catch { /* stale/dangling/cache metadata is not availability */ }
    }
  }
}
const root = Object.keys(lock.snapshots).find(key => key.startsWith('@vitest/coverage-v8@2.1.9('));
if (!root) throw Error('Missing locked provider snapshot');
const nodes = new Map();
function visit(key) {
  if (nodes.has(key)) return;
  const m = /^(@[^/]+\/[^@]+|[^@]+)@([^()]+)/.exec(key);
  if (!m) throw Error('Unclassified dependency '+key);
  const name = m[1], version = m[2], packageKey = name+'@'+version;
  const snapshot = lock.snapshots[key] || lock.snapshots[packageKey];
  const pkg = lock.packages[packageKey];
  if (!snapshot || !pkg) throw Error('Missing lock node '+key);
  nodes.set(key, { key, name, version, integrity: pkg.resolution?.integrity,
    cache: [...(cached.get(packageKey)?.values() || [])],
    dependencies: snapshot.dependencies || {}, optionalDependencies: snapshot.optionalDependencies || {} });
  for (const [dependency, resolution] of Object.entries(snapshot.dependencies || {})) {
    if (dependency === 'vitest') continue; // Existing exact consumer peer graph; not a new download.
    visit(Object.hasOwn(lock.snapshots, resolution) ? resolution : dependency+'@'+resolution);
  }
}
visit(root);
const values = [...nodes.values()];
console.log(JSON.stringify({ sourceHead: '277053c8196dc1be4789c42ea304b0de0553fe00',
  lockSha256: crypto.createHash('sha256').update(lockBytes).digest('hex'), root,
  vitestPeer: 'Existing cached consumer version2.1.9; its graph is excluded from new provider retrieval.',
  scope: 'Nonoptional runtime dependency closure; optional edges reported explicitly, not treated as downloaded.',
  nodes: values, missing: values.filter(node => !node.cache.length).map(({name, version, integrity}) =>
    ({name, version, integrity})), noNetwork: true, noInstall: true, noSourceChanges: true }, null, 2));
