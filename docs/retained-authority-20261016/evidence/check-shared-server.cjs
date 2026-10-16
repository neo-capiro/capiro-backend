'use strict';

// Narrow changed-source semantic check. No tsconfig/project references, emits,
// app imports, shared barrel, Jest types, network or generated source are used.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('../implementation-runtime/workspace/node_modules/typescript/lib/typescript.js');

const taskRoot = path.resolve(__dirname, '..');
const repository = path.join(taskRoot, 'backend-retained-authority');
const sharedRoot = path.join(repository, 'packages/shared/src');
const compilerRoot = path.join(taskRoot, 'implementation-runtime/workspace/node_modules/typescript/lib');
const runtimeRoot = path.join(taskRoot, 'implementation-runtime/workspace/apps/api/node_modules');
const nodeRoot = path.join(runtimeRoot, '@types/node');
// pnpm exposes logical dependency paths and resolves declarations to its existing
// physical store. Admit only the real directories of these installed packages.
const declarationRoots = [
  fs.realpathSync(compilerRoot),
  fs.realpathSync(nodeRoot),
  path.dirname(require.resolve('undici-types/package.json', { paths: [fs.realpathSync(nodeRoot)] })),
  path.dirname(require.resolve('buffer/package.json', { paths: [fs.realpathSync(nodeRoot)] })),
];
const receiptPath = path.join(__dirname, 'shared-server-semantic.receipt.json');
const roots = [
  'core-retained-principal.ts',
  'core-retained-authority-probe.ts',
  'core-retained-read-request.ts',
  'core-retained-authority-http.ts',
].map(name => path.join(sharedRoot, name));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const beforeHashes = Object.fromEntries(roots.map(file => [path.relative(repository, file), hash(file)]));
const options = {
  noEmit: true,
  strict: true,
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.CommonJS,
  moduleResolution: ts.ModuleResolutionKind.Node10,
  lib: ['lib.es2022.d.ts', 'lib.dom.d.ts'],
  types: ['node'],
  typeRoots: [path.join(runtimeRoot, '@types')],
  esModuleInterop: true,
  skipLibCheck: false,
  noResolve: false,
};
const started = performance.now();
const loaded = new Set();
const implementationFiles = new Set();
const isInside = (file, directory) => {
  const relative = path.relative(directory, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
};
const host = ts.createCompilerHost(options);
const originalGetSourceFile = host.getSourceFile.bind(host);
host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
  const file = path.resolve(fileName);
  if (performance.now() - started > 43_000) throw new Error('43-second compiler budget reached');
  if (isInside(file, sharedRoot) && !file.endsWith('.d.ts')) {
    if (path.basename(file) === 'index.ts') throw new Error(`Shared barrel resolution forbidden: ${file}`);
    implementationFiles.add(file);
    if (implementationFiles.size > 10) throw new Error('Shared implementation resolution exceeded 10 files');
  } else if (![compilerRoot, nodeRoot, ...declarationRoots].some(directory => isInside(file, directory))) {
    throw new Error(`Out-of-scope source resolution: ${file}`);
  }
  loaded.add(file);
  return originalGetSourceFile(fileName, languageVersion, onError, shouldCreateNewSourceFile);
};

const receipt = {
  scope: 'Four explicit new shared server modules; actual installed TypeScript and Node declarations',
  node: process.version,
  typescript: ts.version,
  nodeTypesVersion: JSON.parse(fs.readFileSync(path.join(nodeRoot, 'package.json'), 'utf8')).version,
  declarationRoots,
  options,
  files: roots.map(file => path.relative(repository, file)),
  beforeHashes,
  productionEdits: false,
  testsExecuted: false,
};
try {
  const program = ts.createProgram({ rootNames: roots, options, host });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  receipt.diagnostics = diagnostics.map(item => {
    const position = item.file && typeof item.start === 'number'
      ? item.file.getLineAndCharacterOfPosition(item.start) : null;
    return {
      category: ts.DiagnosticCategory[item.category], code: item.code,
      file: item.file ? path.relative(repository, item.file.fileName) : null,
      line: position ? position.line + 1 : null,
      character: position ? position.character + 1 : null,
      message: ts.flattenDiagnosticMessageText(item.messageText, '\n'),
    };
  });
  receipt.afterHashes = Object.fromEntries(roots.map(file => [path.relative(repository, file), hash(file)]));
  receipt.sourcesStable = JSON.stringify(receipt.beforeHashes) === JSON.stringify(receipt.afterHashes);
  receipt.passed = receipt.sourcesStable && !diagnostics.some(item => item.category === ts.DiagnosticCategory.Error);
} catch (error) {
  receipt.passed = false;
  receipt.fatal = error instanceof Error ? error.message : String(error);
} finally {
  receipt.elapsedMs = Math.round(performance.now() - started);
  receipt.loadedFiles = [...loaded].sort();
  receipt.implementationFiles = [...implementationFiles].map(file => path.relative(repository, file)).sort();
  receipt.declarationFileCount = loaded.size - implementationFiles.size;
  receipt.memoryBytes = process.memoryUsage();
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ receiptPath, passed: receipt.passed, fatal: receipt.fatal,
    diagnostics: receipt.diagnostics, elapsedMs: receipt.elapsedMs,
    implementationFiles: receipt.implementationFiles,
    declarationFileCount: receipt.declarationFileCount, sourcesStable: receipt.sourcesStable }));
  if (!receipt.passed) process.exitCode = 1;
}
