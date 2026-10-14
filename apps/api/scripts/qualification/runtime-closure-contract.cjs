/* Qualification only. Frozen lock graph, physical owners and artifact policy; no package execution. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire, isBuiltin } = require('node:module');
const { createHash } = require('node:crypto');
const CONTRACT_SHA256 = '78dfcb0a438c74df4c0778e1316bef4b15874fedad4e8c4ecbd7ae5361305def';
const vendorWasm = {
  'pdfjs-dist@5.4.296': {
    archiveSHA256: '01f7da2d0983256b7d9f8dde9d99e94479f075e30bc571b69cafc92bf419cee2',
    archiveIntegrity: 'sha512-DlOzet0HO7OEnmUmB6wWGJrrdvbyJKftI1bhMitK7O2N8W2gc757yyYBbINy9IDafXAV9wmKr9t7xsTaNKRG5Q==',
    files: { 'wasm/openjpeg.wasm': [250009, '67b8e2b162da472e98cb48d3d32e3e38fff481b9b32ff4818e78bb248af88ab2'],
      'wasm/qcms_bg.wasm': [94519, '6017eca5939cde1836e88e6d8cd27ae039246f206515ea4487bdfd0e3fb16e26'] },
  },
  '@prisma/client@5.22.0': {
    archiveSHA256: '04eb08d2aa67d73f209cb007ef2020fe51bd923ae9ec2ea9dc49177d1c926fe5',
    archiveIntegrity: 'sha512-M0SVXfyHnQREBKxCgyo7sffrKttwE6R8PMq330MIUF0pTwjUhLbW84pFDlf06B27XyCR++VtjugEnIHdr07SVA==',
    files: { 'runtime/query_engine_bg.mysql.wasm': [2091810, '10c3f1282a79ee74dc15e3746fe717a9e7a91ed642d7f694b32097fd4107d7f3'],
      'runtime/query_engine_bg.postgresql.wasm': [2130325, 'b8c2cab13e50491cec4ca2d16a20cd549f09449736ab2361ad53c0254a08bf91'],
      'runtime/query_engine_bg.sqlite.wasm': [1986352, '40800054ecc6145eb5228015c8c12e8781203e24702520657f0ccc3b90a05f25'] },
  },
};
function lockedWasmEvidence(owner, relative, bytes, sha256) {
  const archive = vendorWasm[`${owner.name}@${owner.version}`], expected = archive?.files[relative];
  return { package: `${owner.name}@${owner.version}`, relative, bytes, sha256,
    verified: !!expected && expected[0] === bytes && expected[1] === sha256,
    archiveSHA256: archive?.archiveSHA256 || null, archiveIntegrity: archive?.archiveIntegrity || null,
    scope: 'NON_NATIVE_FORMAT_ONLY', nativeLoad: 'NOT_APPLICABLE', instantiated: false, codecOperation: 'UNRUN' };
}
const hash = data => createHash('sha256').update(data).digest('hex');
function inside(root, file) {
  const rel = path.relative(root, file);
  return !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`);
}
function object(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function readBounded(file, root, maximum) {
  const real = fs.realpathSync(file); assert(inside(fs.realpathSync(root), real), 'input escapes fixed root');
  const stat = fs.statSync(real); assert(stat.isFile() && stat.size <= maximum, 'bounded regular input required');
  return fs.readFileSync(real);
}
function readPackage(root) {
  const file = fs.realpathSync(path.join(root, 'package.json'));
  assert(inside(root, file) && fs.statSync(file).size <= 1024 * 1024, 'package manifest containment/bound');
  const data = fs.readFileSync(file), metadata = JSON.parse(data);
  assert(object(metadata) && typeof metadata.name === 'string' && typeof metadata.version === 'string');
  for (const field of ['os', 'cpu', 'libc']) if (metadata[field] !== undefined)
    assert(Array.isArray(metadata[field]) && metadata[field].length > 0 && metadata[field].every(v => typeof v === 'string'), 'installed platform metadata shape');
  return { root, manifest: file, metadata, manifestSHA256: hash(data) };
}
function platformAllows(list, value) {
  if (list === null || list === undefined) return true;
  assert(Array.isArray(list) && list.length > 0 && list.every(v => typeof v === 'string'), 'platform metadata shape');
  return !list.includes(`!${value}`) && (!list.some(v => !v.startsWith('!')) || list.includes(value));
}
function compatible(node, target) {
  return ['os', 'cpu', 'libc'].every(k => platformAllows(node[k], target[k]));
}
function readContract({ contractFile = '/qualification/RUNTIME-CLOSURE-CONTRACT.json', expectedSHA256 = CONTRACT_SHA256,
  imageRoot = '/app', qualificationRoot = '/qualification' } = {}) {
  const data = readBounded(contractFile, qualificationRoot, 4 * 1024 * 1024); assert(hash(data) === expectedSHA256, 'frozen contract hash');
  const contract = JSON.parse(data);
  assert(contract.schemaVersion === 1 && contract.unresolvedEdges.length === 0, 'complete versioned contract required');
  assert(contract.roots.length === 5 && contract.nodes.length <= 10000 && contract.edges.length <= 30000, 'bounded closure');
  const nodes = new Map([...contract.roots, ...contract.nodes].map(node => [node.key, node]));
  assert(nodes.size === contract.roots.length + contract.nodes.length, 'duplicate graph node');
  for (const [file, expected] of Object.entries(contract.inputSHA256)) {
    assert(/^[a-f0-9]{64}$/.test(expected) && !file.includes('..') && !path.isAbsolute(file));
    const actual = file === 'package.json' ? path.join(qualificationRoot, 'root-package.json') :
      file === 'pnpm-lock.yaml' ? path.join(qualificationRoot, file) : path.join(imageRoot, file);
    const boundRoot = ['package.json', 'pnpm-lock.yaml'].includes(file) ? qualificationRoot : imageRoot;
    assert(hash(readBounded(actual, boundRoot, 8 * 1024 * 1024)) === expected, `frozen input mismatch: ${file}`);
  }
  assert(Object.keys(contract.inputSHA256).length === 7, 'seven source inputs required');
  const edges = new Map();
  for (const edge of contract.edges) {
    assert(nodes.has(edge.from) && nodes.has(edge.to) && ['dependencies', 'optionalDependencies'].includes(edge.kind), 'unknown graph edge');
    assert(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i.test(edge.dependencyName), 'dependency name');
    const rows = edges.get(edge.from) || []; assert(!rows.some(r => r.dependencyName === edge.dependencyName), 'duplicate graph edge');
    rows.push(edge); edges.set(edge.from, rows);
  }
  return { contract, nodes, edges, contractSHA256: expectedSHA256 };
}
function walkRuntime(imageRoot = '/app') {
  const root = fs.realpathSync(imageRoot), files = [], directories = new Set(), seenFiles = new Set(); let links = 0;
  function walk(input, depth) {
    assert(depth <= 64 && files.length < 200000 && directories.size < 100000, 'runtime traversal bound');
    const info = fs.lstatSync(input); if (info.isSymbolicLink()) links++;
    assert(links <= 200000, 'runtime symlink bound');
    const real = fs.realpathSync(input); assert(inside(root, real), 'runtime symlink escapes image');
    const stat = fs.statSync(real);
    if (stat.isDirectory()) {
      if (directories.has(real)) return; directories.add(real);
      for (const name of fs.readdirSync(real).sort()) walk(path.join(real, name), depth + 1);
    } else {
      assert(stat.isFile(), 'unexpected runtime special file');
      if (!seenFiles.has(real)) { seenFiles.add(real); files.push(real); }
    }
  }
  walk(root, 0); return { files, directories: directories.size, symbolicLinks: links };
}
function diagnosticText(value, maximum = 214) {
  return typeof value === 'string' && value.length <= maximum && /^[A-Za-z0-9@._+!~()=:/-]+$/.test(value) ? value : '<INVALID_OR_OVERSIZED>';
}
function diagnosticPath(root, file) {
  return inside(root, file) ? diagnosticText(path.relative(root, file).split(path.sep).join('/') || '.', 768) : '<OUTSIDE_IMAGE>';
}
function diagnosticPlatform(metadata) {
  return Object.fromEntries(['os', 'cpu', 'libc'].map(field => [field, metadata[field] == null ? null :
    Array.isArray(metadata[field]) && metadata[field].length <= 8 ? metadata[field].map(v => diagnosticText(v, 32)) : '<INVALID_OR_OVERSIZED>']));
}
function diagnosticOwner(owner, imageRoot) {
  return { relativeImagePath: diagnosticPath(imageRoot, owner.root), manifestSHA256: owner.manifestSHA256,
    name: diagnosticText(owner.metadata.name), version: diagnosticText(owner.metadata.version, 128), ...diagnosticPlatform(owner.metadata) };
}
function diagnosticEvidence(diagnostic) {
  const evidence = { scope: 'DIAGNOSTIC_ONLY_NOT_ADMISSION', schemaVersion: 1, ...diagnostic.payload,
    limits: { inventoryRows: 128, physicalSearchRows: 32, serializedBytes: 65536 }, truncated: false };
  evidence.truncated = evidence.physicalOwnerCount > evidence.physicalOwnerInventory.length || evidence.physicalSearchCount > evidence.physicalSearch.length;
  evidence.invalidOrOversizedMetadata = JSON.stringify(evidence).includes('<INVALID_OR_OVERSIZED>');
  while (Buffer.byteLength(JSON.stringify(evidence)) > 65536) {
    evidence.truncated = true;
    if (evidence.physicalOwnerInventory.length) evidence.physicalOwnerInventory.pop();
    else if (evidence.physicalSearch.length) evidence.physicalSearch.pop();
    else break;
  }
  return evidence;
}
function physicalStoreOwners(store, diagnostic) {
  const owners = [];
  for (const entry of fs.readdirSync(store, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === 'node_modules') continue;
    const nodeModules = path.join(store, entry.name, 'node_modules');
    assert(fs.statSync(nodeModules).isDirectory(), 'unexpected physical store directory');
    const append = root => {
      if (diagnostic) {
        diagnostic.payload.observedOwner = null;
        diagnostic.payload.readingPhysicalOwner = diagnosticPath(diagnostic.imageRoot, root);
      }
      const row = readPackage(root);
      if (diagnostic) diagnostic.payload.observedOwner = diagnosticOwner(row, diagnostic.imageRoot);
      assert(path.relative(nodeModules, root).split(path.sep).join('/') === row.metadata.name, 'physical package directory/name mismatch');
      owners.push(row);
      if (diagnostic) {
        diagnostic.payload.physicalOwnerCount++;
        if (diagnostic.payload.physicalOwnerInventory.length < 128) diagnostic.payload.physicalOwnerInventory.push(diagnosticOwner(row, diagnostic.imageRoot));
      }
    };
    for (const child of fs.readdirSync(nodeModules, { withFileTypes: true })) {
      if (!child.isDirectory() || child.name === '.prisma') continue;
      const base = path.join(nodeModules, child.name); assert(inside(store, fs.realpathSync(base)), 'physical store owner escapes store');
      if (child.name.startsWith('@')) {
        for (const scoped of fs.readdirSync(base, { withFileTypes: true })) if (scoped.isDirectory()) {
          const real = fs.realpathSync(path.join(base, scoped.name)); assert(inside(store, real), 'scoped physical owner escapes store'); append(real);
        }
      } else append(fs.realpathSync(base));
    }
  }
  assert(owners.length <= 10000 && new Set(owners.map(o => o.root)).size === owners.length, 'physical owner bound/duplicate');
  return owners;
}
function physicalDependencyLookup(name) {
  assert(typeof name === 'string' && name.length > 0 && name.length <= 214 &&
    /^(?:@[a-z0-9-][a-z0-9._-]*\/)?[a-z0-9-][a-z0-9._-]*$/.test(name) &&
    !['node_modules', 'favicon.ico'].includes(name), 'invalid physical npm dependency identity');
  const builtin = isBuiltin(name);
  return { runtimeSelection: builtin ? 'NODE_BUILTIN' : 'NODE_PACKAGE', runtimeSpecifier: name,
    physicalLookupSpecifier: builtin ? `${name}/package.json` : name, physicalOwnerRequired: true };
}
function resolveDependency(parent, name, imageRoot, diagnostic) {
  if (diagnostic) { diagnostic.payload.observedOwner = null; diagnostic.payload.dependencyMissing = null; delete diagnostic.payload.readingPhysicalOwner; }
  const resolver = createRequire(parent.manifest), dependencyResolution = physicalDependencyLookup(name);
  // Builtins have no package search paths. A locked dependency with the same
  // name still needs its exact physical npm owner admitted into the closure.
  // Asking for package-subpath search paths does not execute the package or
  // change Node's runtime selection of the bare builtin specifier.
  const lookup = dependencyResolution.physicalLookupSpecifier;
  for (const dir of resolver.resolve.paths(lookup) || []) {
    const candidate = path.join(dir, name);
    const exists = fs.existsSync(candidate);
    if (diagnostic) {
      diagnostic.payload.physicalSearchCount++;
      if (diagnostic.payload.physicalSearch.length < 32) diagnostic.payload.physicalSearch.push({ relativeImagePath: diagnosticPath(imageRoot, candidate), exists });
    }
    if (!exists) continue;
    const real = fs.realpathSync(candidate); assert(inside(imageRoot, real), 'resolved dependency escapes image');
    if (diagnostic) diagnostic.payload.readingPhysicalOwner = diagnosticPath(imageRoot, real);
    const observed = readPackage(real);
    if (diagnostic) { diagnostic.payload.observedOwner = diagnosticOwner(observed, imageRoot); delete diagnostic.payload.readingPhysicalOwner; }
    return { ...observed, dependencyResolution };
  }
  return null;
}
function generatedPrismaOwners(owners, imageRoot, diagnostic) {
  const generated = [];
  for (const owner of owners.filter(o => o.metadata.name === '@prisma/client')) {
    if (diagnostic) { diagnostic.payload.observedOwner = null; delete diagnostic.payload.readingPhysicalOwner; }
    const nodeModules = path.dirname(path.dirname(owner.root));
    const location = path.join(nodeModules, '.prisma', 'client');
    assert(owner.metadata.version === '5.22.0' && fs.existsSync(location), 'exact generated Prisma companion required');
    const physical = fs.realpathSync(location);
    assert(physical === path.resolve(location) && inside(nodeModules, physical), 'generated Prisma companion escapes exact store location');
    if (diagnostic) diagnostic.payload.readingPhysicalOwner = diagnosticPath(imageRoot, physical);
    const row = readPackage(physical);
    if (diagnostic) { diagnostic.payload.observedOwner = diagnosticOwner(row, imageRoot); delete diagnostic.payload.readingPhysicalOwner; }
    assert(row.metadata.version === owner.metadata.version && /^prisma-client-[a-f0-9]{64}$/.test(row.metadata.name), 'generated Prisma identity');
    const schema = readBounded(path.join(imageRoot, 'apps/api/prisma/schema.prisma'), imageRoot, 8 * 1024 * 1024);
    assert(hash(schema) === '6b831443a9a1c6a19d39911ecc886bc23d273d99712fb4226ccf5a0735863368', 'canonical image-local musl Prisma schema');
    assert(readBounded(path.join(row.root, 'schema.prisma'), row.root, 8 * 1024 * 1024).equals(schema), 'generated Prisma schema differs');
    generated.push({ ...row, snapshot: owner.snapshot, generatedBy: owner.root, generation: 'PINNED_PRISMA_5_22_CLIENT' });
  }
  return generated;
}
function verifyInstalledClosure(options = {}) {
  const diagnostic = { imageRoot: path.resolve(options.imageRoot || '/app'), payload: { stage: 'INITIAL_VALIDATION', physicalInventoryComplete: false, physicalOwnerCount: 0, physicalOwnerInventory: [], physicalSearchCount: 0, physicalSearch: [] } };
  try { return verifyInstalledClosureWithDiagnostics(options, diagnostic); }
  catch (error) { error.evidence = diagnosticEvidence(diagnostic); throw error; }
}
function verifyInstalledClosureWithDiagnostics({ imageRoot = '/app', target = { os: 'linux', cpu: 'arm64', libc: 'musl' }, resolve = resolveDependency, ...options }, diagnostic) {
  imageRoot = fs.realpathSync(imageRoot); const store = fs.realpathSync(path.join(imageRoot, 'node_modules/.pnpm'));
  diagnostic.imageRoot = imageRoot;
  diagnostic.payload.target = Object.fromEntries(['os', 'cpu', 'libc'].map(field => [field, diagnosticText(target[field], 32)]));
  assert(inside(imageRoot, store), 'physical store escapes image');
  // Validate all links before reading any installed package/source input metadata.
  diagnostic.payload.stage = 'CONTAINMENT_PREWALK'; const traversal = walkRuntime(imageRoot);
  diagnostic.payload.stage = 'FROZEN_CONTRACT'; const graph = readContract({ imageRoot, ...options });
  diagnostic.payload.stage = 'BOUNDED_PHYSICAL_OWNER_READ'; const owners = physicalStoreOwners(store, diagnostic);
  diagnostic.payload.physicalInventoryComplete = true;
  delete diagnostic.payload.readingPhysicalOwner;
  const physical = new Map(owners.map(o => [o.root, o])), assigned = new Map(), queue = [], missingOptional = [], links = [];
  for (const root of graph.contract.roots) {
    diagnostic.payload.stage = 'WORKSPACE_OWNER_READ';
    diagnostic.payload.observedOwner = null; diagnostic.payload.readingPhysicalOwner = diagnosticPath(imageRoot, path.join(imageRoot, root.path));
    assert(root.key === `importer:${root.path}` && !root.path.includes('..') && !path.isAbsolute(root.path));
    const owner = readPackage(fs.realpathSync(path.join(imageRoot, root.path)));
    diagnostic.payload.observedOwner = diagnosticOwner(owner, imageRoot); delete diagnostic.payload.readingPhysicalOwner;
    assert(inside(imageRoot, owner.root)); queue.push({ key: root.key, owner });
  }
  for (let cursor = 0; cursor < queue.length; cursor++) {
    assert(queue.length < 30000, 'installed graph traversal bound'); const { key, owner, relation } = queue[cursor], node = graph.nodes.get(key);
    for (const field of ['parentSnapshot', 'dependencyName', 'dependencyKind', 'dependencyMissing', 'expectedPlatformCompatible']) delete diagnostic.payload[field];
    diagnostic.payload.physicalSearchCount = 0; diagnostic.payload.physicalSearch = [];
    if (relation) Object.assign(diagnostic.payload, relation);
    diagnostic.payload.stage = 'OWNER_ADMISSION'; diagnostic.payload.observedOwner = diagnosticOwner(owner, imageRoot);
    diagnostic.payload.expectedSnapshot = diagnosticText(key, 768);
    diagnostic.payload.expectedOwner = { name: diagnosticText(node.name), version: diagnosticText(node.version, 128), ...diagnosticPlatform(node) };
    assert(owner.metadata.name === node.name && owner.metadata.version === node.version, `resolved exact package mismatch: ${key}`);
    if (assigned.has(owner.root)) { assert(assigned.get(owner.root) === key, 'peer-context/physical owner disagreement'); continue; }
    assigned.set(owner.root, key); owner.snapshot = key;
    if (!key.startsWith('importer:')) {
      assert(physical.has(owner.root), 'resolved package outside physical store owners');
      Object.assign(physical.get(owner.root), { snapshot: key, integrity: node.resolution.integrity, declaredPlatform: { os: node.os, cpu: node.cpu, libc: node.libc } });
      assert(typeof node.resolution.integrity === 'string' && node.resolution.integrity.startsWith('sha512-'), 'source integrity missing');
      for (const field of ['os', 'cpu', 'libc']) assert.deepEqual(owner.metadata[field] ?? null, node[field], `installed ${field} metadata differs`);
      assert(compatible(node, target), `physically installed package is incompatible with target: ${key}`);
    }
    const expectedEdges = graph.edges.get(key) || [];
    const declarations = new Map(Object.keys(owner.metadata.dependencies || {}).map(name => [name, 'dependencies']));
    for (const name of Object.keys(owner.metadata.optionalDependencies || {})) declarations.set(name, 'optionalDependencies');
    for (const [name, kind] of declarations) {
      const edge = expectedEdges.find(e => e.dependencyName === name);
      assert(edge, `unlocked installed dependency: ${key} ${name}`);
      assert(edge.kind === kind, `installed required/optional relation differs: ${key} ${name}`);
    }
    for (const edge of expectedEdges) {
      diagnostic.payload.stage = 'REQUIRED_OR_OPTIONAL_EDGE'; diagnostic.payload.physicalSearchCount = 0; diagnostic.payload.physicalSearch = [];
      diagnostic.payload.observedOwner = null; diagnostic.payload.dependencyMissing = null; delete diagnostic.payload.readingPhysicalOwner;
      const expected = graph.nodes.get(edge.to);
      diagnostic.payload.parentSnapshot = diagnosticText(key, 768);
      diagnostic.payload.dependencyName = diagnosticText(edge.dependencyName); diagnostic.payload.dependencyKind = edge.kind;
      diagnostic.payload.expectedSnapshot = diagnosticText(edge.to, 768);
      diagnostic.payload.expectedOwner = { name: diagnosticText(expected.name), version: diagnosticText(expected.version, 128), ...diagnosticPlatform(expected) };
      const next = resolve(owner, edge.dependencyName, imageRoot, diagnostic);
      diagnostic.payload.dependencyMissing = !next;
      diagnostic.payload.observedOwner = next ? diagnosticOwner(next, imageRoot) : null;
      diagnostic.payload.expectedPlatformCompatible = compatible(expected, target);
      if (!next) {
        assert(edge.kind === 'optionalDependencies' && !compatible(expected, target), `required or unproven missing dependency: ${key} ${edge.dependencyName}`);
        missingOptional.push({ ...edge, reason: 'LOCK_DECLARED_PLATFORM_INCOMPATIBLE', platform: { os: expected.os, cpu: expected.cpu, libc: expected.libc } });
      } else {
        links.push({ ...edge, physicalOwner: next.root, ...(next.dependencyResolution ? { dependencyResolution: next.dependencyResolution } : {}) });
        queue.push({ key: edge.to, owner: next, relation: { parentSnapshot: diagnosticText(key, 768), dependencyName: diagnosticText(edge.dependencyName), dependencyKind: edge.kind, dependencyMissing: false } });
      }
    }
  }
  diagnostic.payload.stage = 'CLOSED_WORLD_PHYSICAL_OWNERS';
  for (const field of ['parentSnapshot', 'dependencyName', 'dependencyKind', 'dependencyMissing', 'expectedPlatformCompatible', 'expectedSnapshot', 'expectedOwner']) delete diagnostic.payload[field];
  diagnostic.payload.observedOwner = null; diagnostic.payload.physicalSearchCount = 0; diagnostic.payload.physicalSearch = [];
  for (const owner of owners) {
    diagnostic.payload.observedOwner = diagnosticOwner(owner, imageRoot);
    assert(assigned.has(owner.root), `unexpected/unreachable physical package owner: ${owner.root}`);
  }
  diagnostic.payload.stage = 'GENERATED_PRISMA_OWNERS'; diagnostic.payload.observedOwner = null;
  const generated = generatedPrismaOwners(owners, imageRoot, diagnostic);
  const knownManifests = new Set([...owners, ...generated].map(o => o.manifest));
  for (const file of traversal.files) {
    const relative = path.relative(imageRoot, file).split(path.sep).join('/');
    if (/(?:^|\/)node_modules\/(?:@[^/]+\/)?[^/]+\/package\.json$/.test(relative) || relative.includes('/node_modules/.prisma/') && relative.endsWith('/package.json'))
      assert(knownManifests.has(file), `unexplained installed/nested package owner: ${relative}`);
  }
  return { status: 'PASS_EXACT_INSTALLED_PRODUCTION_CLOSURE', contractSHA256: graph.contractSHA256, target,
    owners, generated, workspaceRoots: graph.contract.roots, visitedNodes: assigned.size, edges: links, missingOptional,
    traversal,
    integrityScope: 'LOCK_INTEGRITY_AND_FROZEN_INPUT_BINDING; installed vendor byte integrity still requires sealed build/install evidence' };
}
function artifactOwner(file, closure) {
  const real = fs.realpathSync(file), owners = [...closure.owners, ...closure.generated].filter(o => inside(o.root, real)).sort((a, b) => b.root.length - a.root.length);
  assert(owners.length > 0, 'unexpected native artifact outside validated package owners');
  const owner = owners[0], relative = path.relative(owner.root, real).split(path.sep).join('/'), name = owner.metadata.name;
  let fixture = null, expected;
  if (vendorWasm[`${name}@${owner.metadata.version}`]?.files[relative]) {
    const data = readBounded(real, owner.root, 4 * 1024 * 1024), proof = lockedWasmEvidence(owner.metadata, relative, data.length, hash(data));
    assert(proof.verified && owner.integrity === proof.archiveIntegrity, 'unreviewed WASM bytes or lock integrity');
    expected = relative; fixture = 'WASM_VENDOR_FORMAT_VALIDATION_ONLY';
  }
  if (name.startsWith('@napi-rs/canvas-')) { expected = `skia.${name.slice('@napi-rs/canvas-'.length)}.node`; fixture = 'CANVAS_REAL_PIXEL'; }
  if (name.startsWith('@esbuild/')) { expected = 'bin/esbuild'; fixture = 'ESBUILD_REAL_TRANSFORM'; }
  if (name === '@prisma/engines' || owner.generatedBy) {
    assert(owner.metadata.version === '5.22.0', 'unreviewed Prisma native version');
    expected = /^libquery_engine-linux-musl-arm64-openssl-3\.0\.x\.so\.node$|^schema-engine-linux-musl-arm64-openssl-3\.0\.x$/.test(relative) ? relative : null;
    fixture = 'PRISMA_MUSL_ENGINE_AND_ISOLATED_DATABASE_STARTUP';
  }
  assert(expected && relative === expected && fixture, `unreviewed native artifact owner/path: ${name} ${relative}`);
  return { root: owner.root, name, version: owner.metadata.version, snapshot: owner.snapshot, manifestSHA256: owner.manifestSHA256,
    relative, fixture, generatedBy: owner.generatedBy || null, integrity: owner.integrity || null };
}
module.exports = { CONTRACT_SHA256, lockedWasmEvidence, inside, platformAllows, readPackage, readContract, walkRuntime, physicalStoreOwners, physicalDependencyLookup, resolveDependency, verifyInstalledClosure, artifactOwner };
