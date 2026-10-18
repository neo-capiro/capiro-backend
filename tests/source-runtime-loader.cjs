// Read exact candidate source for local DI tests without a second checkout.
const cp = require('node:child_process'), path = require('node:path'), Module = require('node:module');
const root = cp.execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const ref = process.env.CAPIRO_SUCCESSOR_REF || 'HEAD';
const deps = '/workspace/capirov2';
const ts = require(require.resolve('typescript', { paths: [deps] }));
const files = new Set(cp.execFileSync('git', ['ls-tree', '-r', '--name-only', ref, '--',
  'apps/intel-api/src', 'packages/shared/src', 'packages/meriv2-core/src'], { cwd: root, encoding: 'utf8' }).trim().split('\n'));
const previousResolve = Module._resolveFilename, previousTs = Module._extensions['.ts'];
const consumed = new Map();
function install() {
  Module._resolveFilename = function (request, parent, options, extra) {
    if (path.isAbsolute(request) && files.has(path.relative(root, request))) return request;
    if (parent?.filename.startsWith(root + path.sep)) {
      let target;
      if (request.startsWith('.')) target = path.resolve(path.dirname(parent.filename), request).replace(/\.js$/, '.ts');
      if (request === '@capiro/shared') target = path.join(root, 'packages/shared/src/index.ts');
      if (request.startsWith('@capiro/shared/')) target = path.join(root, 'packages/shared/src', request.slice(15) + '.ts');
      if (request === '@capiro/meriv2-core') target = path.join(root, 'packages/meriv2-core/src/index.ts');
      if (target && files.has(path.relative(root, target))) return target;
      if (target?.includes('/generated/prisma-client/'))
        return previousResolve.call(this, target.replace(root, deps).replace(/\.ts$/, '.js'), parent, options, extra);
      const mappedParent = { ...parent, filename: parent.filename.replace(root, deps),
        paths: Module._nodeModulePaths(path.dirname(parent.filename.replace(root, deps))) };
      return previousResolve.call(this, request, mappedParent, options, extra);
    }
    return previousResolve.call(this, request, parent, options, extra);
  };
  Module._extensions['.ts'] = (module, file) => {
    const name = path.relative(root, file);
    if (!files.has(name)) return previousTs ? previousTs(module, file) : require.extensions['.js'](module, file);
    if (name === 'apps/intel-api/src/hearing/recording/recording-storage.service.ts') {
      // Adjacent object-storage dependency stays inert; never construct an AWS client.
      module.exports = { RecordingStorageService: class RecordingStorageService {} }; return;
    }
    const source = cp.execFileSync('git', ['show', `${ref}:${name}`], { cwd: root, encoding: 'utf8' });
    consumed.set(name, cp.execFileSync('git', ['rev-parse', `${ref}:${name}`], { cwd: root, encoding: 'utf8' }).trim());
    const emitted = ts.transpileModule(source, { fileName: file, compilerOptions: {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      experimentalDecorators: true, emitDecoratorMetadata: true, esModuleInterop: true,
    } });
    module._compile(emitted.outputText, file);
  };
}
function restore() { Module._resolveFilename = previousResolve; Module._extensions['.ts'] = previousTs; }
module.exports = { root, ref, deps, install, restore, consumed };
