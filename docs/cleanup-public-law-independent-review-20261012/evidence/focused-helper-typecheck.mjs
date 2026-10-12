import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ts = createRequire('/workspace/capirov2/apps/api/package.json')('typescript');
const source = process.argv[2]; assert.match(source, /^[a-f0-9]{40}$/);
const relative = 'apps/api/scripts/lib/pe-public-law-facade-containment.ts';
const absolute = path.resolve(root, relative);
const sourceText = execFileSync('git', ['show', `${source}:${relative}`], { cwd: root, encoding: 'utf8' });
const options = { noEmit: true, strict: true, noUncheckedIndexedAccess: true, skipLibCheck: true,
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, moduleResolution: ts.ModuleResolutionKind.Node10,
  lib: ['lib.es2022.d.ts'], types: [], esModuleInterop: true };
const host = ts.createCompilerHost(options);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (filename, languageVersion, onError, shouldCreateNew) => path.resolve(filename) === absolute
  ? ts.createSourceFile(filename, sourceText, languageVersion, true)
  : originalGetSourceFile(filename, languageVersion, onError, shouldCreateNew);
host.resolveModuleNames = names => names.map(name => {
  assert.equal(name, 'typescript', 'helper introduced a different runtime import');
  return ts.resolveModuleName(name, '/workspace/capirov2/apps/api/scripts/lib/scoped-helper-typecheck.ts', options, host).resolvedModule;
});
const program = ts.createProgram([absolute], options, host);
const diagnostics = ts.getPreEmitDiagnostics(program).map(d => ({ code: d.code,
  path: d.file ? path.relative(root, d.file.fileName) : null,
  message: ts.flattenDiagnosticMessageText(d.messageText, '\n') }));
console.log(JSON.stringify({ source, sourceSha256: createHash('sha256').update(sourceText).digest('hex'),
  typescriptVersion: ts.version, rootFiles: [relative], compilerOptions: options, diagnostics,
  librarySourceFiles: program.getSourceFiles().length - 1,
  scope: 'Only new pure AST helper with installed TypeScript declarations; not full Core, native Prisma or DB acceptance.' }, null, 2));
assert.deepEqual(diagnostics, []);
