const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const git = (...args) => cp.execFileSync('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 });
const head = git('rev-parse', 'HEAD').toString().trim();
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const files = new Map(git('ls-tree', '-rz', '--full-tree', head).toString().split('\0').filter(Boolean).map((line) => {
  const [info, name] = line.split('\t'); return [name, info.split(' ')[2]];
}));
const content = new Map();
const directories = new Set();
for (const name of files.keys()) for (let directory = path.posix.dirname(name); directory !== '.'; directory = path.posix.dirname(directory)) directories.add(directory);
const relative = (file) => path.relative(root, file).split(path.sep).join('/');
const read = (file) => {
  const name = relative(file);
  if (!files.has(name)) return ts.sys.readFile(file);
  if (!content.has(name)) content.set(name, git('cat-file', 'blob', files.get(name)).toString());
  return content.get(name);
};
const parsed = ts.getParsedCommandLineOfConfigFile(path.join(root, 'apps/api/tsconfig.json'), {}, {
  ...ts.sys, readFile: read, fileExists: (file) => files.has(relative(file)) || ts.sys.fileExists(file),
  onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
});
if (!parsed || parsed.errors.length) throw new Error('SOURCE_CONFIG_FAILED');
const options = { ...parsed.options, strict: true, noUncheckedIndexedAccess: true, noEmit: true, incremental: false, rootDir: root,
  lib: [...new Set([...parsed.options.lib, 'lib.dom.d.ts'])] };
const host = ts.createCompilerHost(options);
host.readFile = read;
host.fileExists = (file) => files.has(relative(file)) || ts.sys.fileExists(file);
host.directoryExists = (directory) => directories.has(relative(directory)) || ts.sys.directoryExists(directory);
host.getSourceFile = (file, languageVersion) => {
  const source = read(file); return source === undefined ? undefined : ts.createSourceFile(file, source, languageVersion, true);
};
const packages = new Map();
for (const name of files.keys()) if (/^packages\/[^/]+\/package.json$/.test(name)) {
  const pkg = JSON.parse(read(path.join(root, name))); packages.set(pkg.name, { pkg, base: path.dirname(name) });
}
host.resolveModuleNames = (names, containingFile) => names.map((name) => {
  if (name.startsWith('@capiro/')) {
    const [scope, packageName, ...sub] = name.split('/'), owner = packages.get(`${scope}/${packageName}`);
    if (!owner) throw new Error(`UNBOUND_WORKSPACE_PACKAGE:${name}`);
    const key = sub.length ? `./${sub.join('/')}` : '.', item = owner.pkg.exports?.[key];
    const target = typeof item === 'string' ? item : item?.types ?? item?.require ?? (key === '.' ? owner.pkg.types : undefined);
    if (!target?.startsWith('./dist/')) throw new Error(`UNBOUND_WORKSPACE_EXPORT:${name}`);
    const source = path.posix.join(owner.base, target.replace('./dist/', './src/').replace(/(?:\.d)?\.ts$|\.js$/, '.ts'));
    if (!files.has(source)) throw new Error(`UNBOUND_WORKSPACE_SOURCE:${source}`);
    return { resolvedFileName: path.join(root, source), extension: ts.Extension.Ts };
  }
  let result = ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  if (!result && containingFile.startsWith(path.join(root, 'packages') + path.sep) && !name.startsWith('.')) {
    const owner = relative(containingFile).split('/')[1];
    result = ts.resolveModuleName(name, path.join('/workspace/capirov2/packages', owner, 'src/__type_probe.ts'), options, host).resolvedModule;
  }
  return result;
});
const entries = ["business-development/bizdev-meri-scope.authorization.ts","business-development/bizdev-meri-scope.authorization.spec.ts","meri/meri-prospect-scope.helpers.ts","meri/meri-prospect-scope.helpers.spec.ts"].map((name) => path.join(root, 'apps/api/src', name));
const program = ts.createProgram(entries, options, host), diagnostics = ts.getPreEmitDiagnostics(program);
const sources = program.getSourceFiles().map((file) => ({ path: file.fileName,
  blob: files.get(relative(file.fileName)) ?? null, sha256: crypto.createHash('sha256').update(file.text).digest('hex') }));
process.stdout.write(JSON.stringify({ head, result: diagnostics.length ? 'held' : 'pass', scope: 'Strict changed-entry closure with all workspace packages bound to exact source; API strict options, rootDir widened for workspace source and DOM added from Shared owner compiler config; cached third-party/Prisma declarations, no full API/native acceptance',
  entries, sources, diagnostics: diagnostics.map((d) => ({ code: d.code, path: d.file?.fileName,
    line: d.file && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : null,
    message: ts.flattenDiagnosticMessageText(d.messageText, '\n') })) }, null, 2) + '\n');
if (diagnostics.length) process.exitCode = 1;
