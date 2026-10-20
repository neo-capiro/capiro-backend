// Full configured compiler programs from one Git tree; outputs stay in memory.
// No dependency install, provider import, schema/database operation or native load.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const repositoryRoot = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const source = process.env.CAPIRO_SUCCESSOR_REF || 'HEAD';
const dependencyRoot = process.env.CAPIRO_SUCCESSOR_DEPENDENCY_ROOT || '/workspace/capirov2';
// Use the cache's normal absolute package namespace without reading its private source.
// Every selected application/library source read is still overridden by exact Git blobs.
const root = dependencyRoot;
const ts = require(require.resolve('typescript', { paths: [dependencyRoot] }));
const git = (...args) => cp.execFileSync('git', args, { cwd: repositoryRoot, maxBuffer: 256 * 1024 * 1024 });
const owners = ['packages/shared', 'packages/auth', 'packages/meriv2-core',
  'packages/defense-contracts', 'packages/defense-domain', 'packages/strategy-verifier',
  'apps/api', 'apps/workspace', 'apps/api-strategy', 'apps/intel-api'];
const entries = new Map(git('ls-tree', '-rz', source, '--', 'tsconfig.base.json', ...owners)
  .toString().split('\0').filter(Boolean).map((row) => {
    const [meta, file] = row.split('\t'); return [file, meta.split(' ')[2]];
  }).filter(([file]) => /\.(?:ts|json)$/.test(file)));
const blobs = [...new Set(entries.values())];
const batch = cp.spawnSync('git', ['cat-file', '--batch'], { cwd: repositoryRoot,
  input: blobs.join('\n') + '\n', maxBuffer: 256 * 1024 * 1024 });
if (batch.status !== 0) throw new Error('Git source batch failed');
const texts = new Map(); let cursor = 0;
for (const expected of blobs) {
  const end = batch.stdout.indexOf(10, cursor);
  const [sha, type, size] = batch.stdout.subarray(cursor, end).toString().split(' ');
  if (sha !== expected || type !== 'blob') throw new Error('Source identity mismatch');
  cursor = end + 1; texts.set(sha, batch.stdout.subarray(cursor, cursor + Number(size)).toString());
  cursor += Number(size) + 1;
}
const relative = (file) => path.relative(root, file).split(path.sep).join('/');
const outputs = new Map(), consumed = new Set(), fallback = new Map(), directories = new Set();
const generated = new Map([
  ['apps/api/node_modules/@prisma/client/', '/tmp/capirov2-local-native-prerequisite-20261012/core-client/'],
  ['apps/workspace/generated/prisma-client/', '/tmp/capirov2-local-native-prerequisite-20261012/workspace-client/'],
  ['apps/api-strategy/generated/prisma-client/', dependencyRoot + '/apps/api-strategy/generated/prisma-client/'],
  ['apps/intel-api/generated/prisma-client/', dependencyRoot + '/apps/intel-api/generated/prisma-client/'],
]);
for (const file of entries.keys()) for (let dir = path.posix.dirname(file); dir !== '.'; dir = path.posix.dirname(dir)) directories.add(dir);
function physical(file) {
  const name = relative(file);
  for (const [prefix, target] of generated) if (name.startsWith(prefix))
    return path.join(target, name.slice(prefix.length));
  return !name.startsWith('../') && (name.startsWith('node_modules/') || name.includes('/node_modules/'))
    ? path.join(dependencyRoot, name) : file;
}
function read(file) {
  const name = relative(file);
  if (outputs.has(name)) return outputs.get(name);
  const sha = entries.get(name);
  if (sha) { consumed.add(name); return texts.get(sha); }
  if ((name.startsWith('apps/') || name.startsWith('packages/')) &&
      !name.includes('/node_modules/') &&
      ![...generated.keys()].some((prefix) => name.startsWith(prefix))) return undefined;
  const target = physical(file), text = ts.sys.readFile(target);
  if (text !== undefined) fallback.set(target, crypto.createHash('sha256').update(text).digest('hex'));
  return text;
}
const exists = (file) => read(file) !== undefined;
const directoryExists = (file) => directories.has(relative(file)) || ts.sys.directoryExists(physical(file));
function fileSystemEntries(directory) {
  const name = relative(directory), prefix = name === '.' ? '' : name + '/';
  const files = new Set(), dirs = new Set();
  for (const file of [...entries.keys(), ...outputs.keys()]) if (file.startsWith(prefix)) {
    const tail = file.slice(prefix.length), index = tail.indexOf('/');
    (index < 0 ? files : dirs).add(index < 0 ? tail : tail.slice(0, index));
  }
  return { files: [...files], directories: [...dirs] };
}
const packages = new Map(owners.filter((owner) => owner.startsWith('packages/')).map((owner) => {
  const pkg = JSON.parse(read(path.join(root, owner, 'package.json'))); return [pkg.name, { pkg, owner }];
}));
const receipts = [];
for (const owner of owners.filter((item) => !process.env.CAPIRO_SUCCESSOR_OWNER ||
    item.startsWith('packages/') || item === process.env.CAPIRO_SUCCESSOR_OWNER)) {
  const configName = owner + (owner.startsWith('apps/') ? '/tsconfig.build.json' : '/tsconfig.json');
  const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, configName), {}, {
    ...ts.sys, readFile: read, fileExists: exists, directoryExists,
    readDirectory: (dir, extensions, excludes, includes, depth) => ts.matchFiles(dir, extensions,
      excludes, includes, true, root, depth, fileSystemEntries, (value) => value),
    onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
  });
  if (!parsed || parsed.errors.length) throw new Error('Compiler config failed: ' + owner);
  const host = ts.createCompilerHost(parsed.options);
  host.readFile = read; host.fileExists = exists; host.directoryExists = directoryExists;
  host.realpath = (file) => {
    if (entries.has(relative(file)) || outputs.has(relative(file))) return file;
    const target = ts.sys.realpath?.(physical(file)) || physical(file);
    return target.startsWith(dependencyRoot + path.sep)
      ? path.join(root, path.relative(dependencyRoot, target)) : target;
  };
  host.getDirectories = (directory) => ts.sys.getDirectories(physical(directory)).map((target) =>
    target.startsWith(dependencyRoot + path.sep)
      ? path.join(root, path.relative(dependencyRoot, target)) : target);
  host.getSourceFile = (file, languageVersion) => {
    const text = read(file); return text === undefined ? undefined : ts.createSourceFile(file, text, languageVersion, true);
  };
  host.resolveModuleNames = (names, containingFile) => names.map((name) => {
    if (name === '@prisma/client' && relative(containingFile).startsWith('apps/api/'))
      return { resolvedFileName: path.join(root, 'apps/api/node_modules/@prisma/client/index.d.ts'),
        extension: ts.Extension.Dts, isExternalLibraryImport: true };
    if (name.startsWith('@capiro/')) {
      const [scope, pkgName, ...sub] = name.split('/'), item = packages.get(`${scope}/${pkgName}`);
      if (item) {
        const key = sub.length ? './' + sub.join('/') : '.', exported = item.pkg.exports?.[key];
        const target = typeof exported === 'string' ? exported : exported?.types || (key === '.' ? item.pkg.types : undefined);
        if (target) return { resolvedFileName: path.join(root, item.owner, target), extension: ts.Extension.Dts };
      }
    }
    const virtual = ts.resolveModuleName(name, containingFile, parsed.options, host).resolvedModule;
    if (virtual) return virtual;
    const mapped = path.join(dependencyRoot, relative(containingFile));
    const cached = ts.resolveModuleName(name, mapped, parsed.options, ts.sys).resolvedModule;
    if (!cached) return undefined;
    if (cached.resolvedFileName.startsWith(dependencyRoot + path.sep) &&
        !cached.resolvedFileName.includes('/node_modules/') &&
        !(cached.resolvedFileName.includes('/generated/') && cached.resolvedFileName.endsWith('.d.ts')))
      return undefined;
    return cached.resolvedFileName.startsWith(dependencyRoot + path.sep)
      ? { ...cached, resolvedFileName: path.join(root, path.relative(dependencyRoot, cached.resolvedFileName)) }
      : cached;
  });
  const written = [];
  host.writeFile = (file, text) => {
    const name = relative(file); outputs.set(name, text); directories.add(path.posix.dirname(name));
    written.push({ path: name, bytes: Buffer.byteLength(text), sha256: crypto.createHash('sha256').update(text).digest('hex') });
  };
  process.stderr.write(`Compiling complete ${owner} (${parsed.fileNames.length} configured roots)\n`);
  const started = Date.now(), program = ts.createProgram(parsed.fileNames, parsed.options, host);
  const diagnostics = ts.getPreEmitDiagnostics(program), emitted = program.emit();
  const all = [...diagnostics, ...emitted.diagnostics];
  const result = { owner, config: configName, configuredRoots: parsed.fileNames.length,
    programFiles: program.getSourceFiles().length, elapsedMs: Date.now() - started,
    emitSkipped: emitted.emitSkipped, outputFiles: written.length, outputBytes: written.reduce((n, row) => n + row.bytes, 0),
    outputManifestSha256: crypto.createHash('sha256').update(JSON.stringify(written)).digest('hex'),
    diagnostics: all.map((d) => ({ code: d.code, file: d.file ? relative(d.file.fileName) : null,
      line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,
      message: ts.flattenDiagnosticMessageText(d.messageText, '\n') })) };
  receipts.push(result); process.stderr.write(`${owner}: ${all.length} diagnostics, ${written.length} outputs\n`);
}
const receipt = { source, tree: git('rev-parse', source + '^{tree}').toString().trim(), typescript: ts.version,
  node: process.version, dependencyRoot, programs: receipts,
  sourceFilesConsumed: consumed.size, sourceManifestSha256: crypto.createHash('sha256')
    .update(JSON.stringify([...consumed].sort().map((file) => [file, entries.get(file)]))).digest('hex'),
  cachedFilesConsumed: fallback.size, cachedManifestSha256: crypto.createHash('sha256')
    .update(JSON.stringify([...fallback].sort())).digest('hex'),
  scope: 'Complete configured TypeScript programs using existing build configs, exact Git source and memory emission; cached dependency/generated-client declarations are explicit inputs. Not Nest CLI/container/native/DI/database/provider/startup acceptance.' };
process.stdout.write(JSON.stringify(receipt) + '\n');
if (receipts.some((r) => r.diagnostics.length || r.emitSkipped)) process.exitCode = 1;
