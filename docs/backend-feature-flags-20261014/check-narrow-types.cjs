const path = require('node:path');
const fs = require('node:fs');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const ts = require(require.resolve('typescript', { paths: [path.join(root, 'apps/api')] }));
const configPath = path.join(root, 'apps/api/tsconfig.json');
const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, {
  ...ts.sys, onUnRecoverableConfigFileDiagnostic: (d) => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, '\n')); },
});
if (!parsed || parsed.errors.length) throw new Error('API compiler config failed');
const emit = process.argv.includes('--emit');
const emitDir = path.join(root, '.qualification-cache/feature-flags-emit');
const options = { ...parsed.options, noEmit: !emit, incremental: false,
  ...(emit ? { outDir: emitDir } : {}) };
const program = ts.createProgram([path.join(root, 'apps/api/src/common/meri-feature-flags.module.ts')], options);
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => '\n',
  }));
  process.exitCode = 1;
}
const artifacts = [];
if (emit && !diagnostics.length) {
  const emitted = program.emit(undefined, (file, content) => {
    if (!file.startsWith(emitDir + path.sep)) throw new Error('Emit escaped owned scratch directory');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    if (file.endsWith('.js')) cp.execFileSync(process.execPath, ['--check', file]);
    artifacts.push({ path: path.relative(emitDir, file), bytes: Buffer.byteLength(content),
      sha256: crypto.createHash('sha256').update(content).digest('hex') });
  });
  if (emitted.emitSkipped || emitted.diagnostics.length) throw new Error('Narrow emit failed');
}
const sourceRows = program.getSourceFiles().filter((file) => file.fileName.startsWith(path.join(root, 'apps/api/src/'))).map((file) => ({
  path: path.relative(root, file.fileName),
  sha256: crypto.createHash('sha256').update(fs.readFileSync(file.fileName)).digest('hex'),
}));
console.log(JSON.stringify({ result: diagnostics.length ? 'fail' : 'pass', diagnostics: diagnostics.length,
  head: cp.execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(),
  scope: 'actual narrow feature-flag module/imported API source with existing compiler options; no full API/Nest/native acceptance',
  options: { ...options, configFile: undefined }, sourceRows, artifacts,
}, null, 2));
