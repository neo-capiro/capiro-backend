import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// Source contract only: never invoke pnpm, package scripts, Docker or runtime code.
// Discovery/frozen validation rationale is pinned to pnpm v9.12.0:
// https://github.com/pnpm/pnpm/blob/v9.12.0/workspace/find-packages/src/index.ts
// https://github.com/pnpm/pnpm/blob/v9.12.0/pkg-manager/core/src/install/index.ts
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const members = [
  'apps/defense-api',
  'packages/auth',
  'packages/defense-client',
  'packages/defense-contracts',
  'packages/defense-domain',
  'packages/shared',
];
const groups = ['dependencies', 'devDependencies', 'optionalDependencies'];
const hash = (text) => createHash('sha256').update(text).digest('hex');
const input = {
  docker: readFileSync(resolve(root, 'apps/defense-api/Dockerfile'), 'utf8'),
  workspace: readFileSync(resolve(root, 'apps/defense-api/pnpm-workspace.build.yaml'), 'utf8'),
  lock: readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8'),
  manifests: Object.fromEntries(['.', ...members].map((path) => [path,
    JSON.parse(readFileSync(resolve(root, path, 'package.json'), 'utf8'))])),
};

function scalar(value) {
  if (value.startsWith("'")) {
    assert.ok(value.endsWith("'"), `unclosed quoted scalar: ${value}`);
    return value.slice(1, -1).replaceAll("''", "'");
  }
  if (value.startsWith('"')) return JSON.parse(value);
  assert.ok(value && !/^[{[&*!]|\s#/.test(value), `unsupported YAML scalar: ${value}`);
  return value;
}

function workspaceMembers(text) {
  const lines = text.split('\n').filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  assert.equal(lines.shift(), 'packages:');
  const paths = lines.map((line) => {
    const match = /^  - (.+)$/.exec(line);
    assert.ok(match, `unsupported workspace entry: ${line}`);
    const path = scalar(match[1]);
    assert.match(path, /^(apps|packages)\/[a-z0-9-]+$/);
    return path;
  });
  assert.equal(new Set(paths).size, paths.length, 'duplicate workspace member');
  return paths;
}

// Deliberately bounded parser for the emitted lock v9 importer mapping. It
// rejects unsupported fields/syntax in the admitted importers rather than
// silently treating new metadata as proof of frozen compatibility.
function selectedImporters(text) {
  assert.match(text, /^lockfileVersion: '9\.0'\n/);
  assert.match(text, /\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n/);
  const section = /\nimporters:\n([\s\S]*?)\npackages:\n/.exec(text)?.[1];
  assert.ok(section, 'missing importer mapping');
  const blocks = [...section.matchAll(/^  ([^\n]+?):(?: (\{\}))?\n([\s\S]*?)(?=^  \S|$(?![\s\S]))/gm)];
  const result = new Map();
  for (const [, rawPath, empty, body] of blocks) {
    const path = scalar(rawPath);
    if (!['.', ...members].includes(path)) continue;
    assert.ok(!result.has(path), `duplicate importer: ${path}`);
    const importer = {};
    let group;
    let dependency;
    for (const line of body.split('\n').filter((line) => line.trim())) {
      assert.ok(!empty, `nonempty flow importer: ${path}`);
      let match;
      if ((match = /^    (dependencies|devDependencies|optionalDependencies):$/.exec(line))) {
        group = match[1]; dependency = undefined;
        assert.ok(!Object.hasOwn(importer, group), `duplicate dependency group: ${path}`);
        importer[group] = {};
      } else if ((match = /^      (.+):$/.exec(line))) {
        assert.ok(group, `dependency without group: ${path}`);
        dependency = scalar(match[1]);
        assert.ok(!Object.hasOwn(importer[group], dependency), `duplicate dependency: ${path}/${dependency}`);
        importer[group][dependency] = {};
      } else if ((match = /^        (specifier|version): (.+)$/.exec(line))) {
        assert.ok(dependency, `value without dependency: ${path}`);
        assert.ok(!Object.hasOwn(importer[group][dependency], match[1]), `duplicate value: ${path}/${dependency}`);
        importer[group][dependency][match[1]] = scalar(match[2]);
      } else {
        assert.fail(`unsupported admitted importer syntax: ${path}: ${line}`);
      }
    }
    result.set(path, importer);
  }
  return result;
}

function validate(value) {
  assert.deepEqual(workspaceMembers(value.workspace), members, 'image workspace must be exactly the backend closure');
  assert.equal(value.manifests['.'].packageManager, 'pnpm@9.12.0');
  const byName = new Map(members.map((path) => [value.manifests[path].name, path]));
  assert.equal(byName.size, members.length, 'duplicate package name');
  assert.equal(byName.get('@capiro/defense-api'), 'apps/defense-api');
  const reached = new Set();
  const visit = (path) => {
    if (reached.has(path)) return;
    reached.add(path);
    const pkg = value.manifests[path];
    for (const [name, specifier] of Object.entries(Object.assign({}, ...groups.map((field) => pkg[field])))) {
      if (!specifier.startsWith('workspace:')) continue;
      assert.equal(specifier, 'workspace:*', `unsupported workspace protocol: ${path}/${name}`);
      const dependencyPath = byName.get(name);
      assert.ok(dependencyPath, `workspace dependency outside image: ${path}/${name}`);
      visit(dependencyPath);
    }
  };
  visit('apps/defense-api');
  assert.deepEqual([...reached].sort(), [...members].sort(), 'workspace dependency graph must close exactly');

  const importers = selectedImporters(value.lock);
  const snapshots = /\nsnapshots:\n([\s\S]*)$/.exec(value.lock)?.[1];
  assert.ok(snapshots, 'missing frozen snapshots');
  const snapshotKeys = new Set([...snapshots.matchAll(/^  (.+):(?: \{\})?\n/gm)].map((match) => scalar(match[1])));
  let dependencyCount = 0;
  for (const path of ['.', ...members]) {
    const pkg = value.manifests[path];
    const importer = importers.get(path);
    assert.ok(importer, `missing frozen importer: ${path}`);
    assert.ok(!pkg.peerDependencies && !pkg.dependenciesMeta && !pkg.publishConfig,
      `new manifest metadata needs frozen validation qualification: ${path}`);
    for (const field of groups) {
      const declared = Object.fromEntries(Object.entries(pkg[field] ?? {}).filter(([name]) =>
        field === 'optionalDependencies' || (field === 'dependencies' ? !pkg.optionalDependencies?.[name]
          : !pkg.optionalDependencies?.[name] && !pkg.dependencies?.[name])));
      const locked = importer[field] ?? {};
      assert.deepEqual(Object.keys(locked).sort(), Object.keys(declared).sort(), `frozen dependency field: ${path}/${field}`);
      for (const [name, specifier] of Object.entries(declared)) {
        dependencyCount++;
        const dependency = locked[name];
        assert.equal(dependency.specifier, specifier, `frozen specifier: ${path}/${name}`);
        assert.ok(dependency.version, `frozen resolution missing: ${path}/${name}`);
        if (specifier.startsWith('workspace:')) {
          assert.equal(dependency.version, `link:${posix.relative(path, byName.get(name))}`,
            `frozen workspace link: ${path}/${name}`);
        } else {
          assert.ok(snapshotKeys.has(`${name}@${dependency.version}`), `frozen snapshot missing: ${path}/${name}`);
        }
      }
    }
  }

  const start = value.docker.indexOf('# Image-owned workspace:');
  const end = value.docker.indexOf('# Isolated cache mount id', start);
  assert.ok(start >= 0 && end > start, 'bounded Docker manifest window missing');
  assert.equal(hash(value.docker.slice(0, start)), 'e5b61177aee2042a97bb7c08ed41a0e07803b1b03b08d308f4866f568244d425',
    'base image/toolchain/security prefix changed');
  assert.equal(hash(value.docker.slice(end)), '5e6d5452ce83d7ca36f8421acc83fba7c77a1c78ab939f079f29dda4a9e86019',
    'install/build/source/schema/migration/runtime/entrypoint suffix changed');
  const instructions = value.docker.slice(start, end).split('\n')
    .filter((line) => line.trim() && !line.startsWith('#'));
  assert.deepEqual(instructions, [
    'COPY apps/defense-api/pnpm-workspace.build.yaml ./pnpm-workspace.yaml',
    'COPY package.json pnpm-lock.yaml* tsconfig.base.json ./',
    ...members.map((path) => `COPY ${path}/package.json ${path}/package.json`),
  ], 'Docker discovery inputs must contain only the root and backend closure');
  return { members: reached.size, importers: importers.size, dependencyCount };
}

test('Defense image workspace closes over exactly six backend members and seven frozen importers', () => {
  const result = validate(input);
  assert.equal(result.members, 6);
  assert.equal(result.importers, 7);
  assert.ok(result.dependencyCount > 30);
});

test('the Defense guard reads only image-owned manifests; unrelated/frontend inputs can be absent', () => {
  assert.deepEqual(Object.keys(input.manifests), ['.', ...members]);
  assert.equal(validate(structuredClone(input)).members, 6);
});

for (const [name, mutate, message] of [
  ['frontend member admission', (value) => { value.workspace += '  - "apps/web"\n'; }, /exactly the backend closure/],
  ['workspace wildcard', (value) => { value.workspace = value.workspace.replace('apps/defense-api', 'apps/*'); }, /match the regular expression/],
  ['frontend manifest COPY', (value) => { value.docker = value.docker.replace('COPY packages/auth/package.json', 'COPY apps/web/package.json apps/web/package.json\nCOPY packages/auth/package.json'); }, /only the root and backend closure/],
  ['missing backend manifest COPY', (value) => { value.docker = value.docker.replace('COPY packages/shared/package.json packages/shared/package.json\n', ''); }, /only the root and backend closure/],
  ['new undeclared workspace dependency', (value) => { value.manifests['packages/defense-domain'].dependencies['@capiro/web'] = 'workspace:*'; }, /workspace dependency outside image/],
  ['manifest/lockfile specifier drift', (value) => { value.manifests['packages/shared'].devDependencies.typescript = '^99.0.0'; }, /frozen specifier/],
  ['missing frozen importer', (value) => { value.lock = value.lock.replace('  packages/defense-client: {}', '  packages/unused-client: {}'); }, /missing frozen importer/],
  ['wrong transitive workspace link', (value) => { value.lock = value.lock.replace('version: link:../shared', 'version: link:../web'); }, /frozen workspace link/],
  ['missing external frozen snapshot', (value) => { value.lock = value.lock.replace('  simple-statistics@7.12.0: {}', '  simple-statistics@0.0.0: {}'); }, /frozen snapshot missing/],
  ['unqualified manifest peer metadata', (value) => { value.manifests['packages/shared'].peerDependencies = { react: '*' }; }, /new manifest metadata/],
  ['weakened frozen install', (value) => { value.docker = value.docker.replace('pnpm install --frozen-lockfile', 'pnpm install --no-frozen-lockfile'); }, /suffix changed/],
  ['lost runtime/schema/client artifact', (value) => { value.docker = value.docker.replace('COPY --chown=capiro:capiro --from=build /workspace/apps/defense-api/generated /app/apps/defense-api/generated\n', ''); }, /suffix changed/],
  ['changed build ordering', (value) => { value.docker = value.docker.replace('RUN pnpm --filter @capiro/shared build', 'RUN pnpm --filter @capiro/defense-domain build'); }, /suffix changed/],
  ['changed runtime security', (value) => { value.docker = value.docker.replace('USER capiro', 'USER root'); }, /suffix changed/],
  ['changed pinned toolchain', (value) => { value.docker = value.docker.replace('pnpm@9.12.0', 'pnpm@11.25.0'); }, /prefix changed/],
]) {
  test(`rejects ${name}`, () => {
    const value = structuredClone(input);
    mutate(value);
    assert.throws(() => validate(value), message);
  });
}
