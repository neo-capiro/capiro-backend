#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let compiler;
const ts = () => (compiler ??= require('typescript'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = 'scripts/registry-ownership.json';
const runtimeSource = /\.(?:ts|tsx|mts|cts)$/;
const testSource = /(?:\.(?:spec|test)\.[cm]?tsx?$|\.d\.[cm]?ts$)/;
const safePath = (value) =>
  typeof value === 'string' && value.length > 0 &&
  !value.includes('\\') && !path.posix.isAbsolute(value) &&
  !value.split('/').some((part) => !part || part === '.' || part === '..');
const digest = (value) => createHash('sha256').update(value).digest('hex');

function declarations(sf) {
  const t = ts();
  const rows = [];
  const add = (node, name, kind) => {
    if (!name || !t.isIdentifier(name)) return;
    rows.push({ node, name: name.text, kind });
  };
  function visit(node) {
    if (t.isVariableDeclaration(node)) add(node, node.name, 'variable');
    else if (t.isFunctionDeclaration(node)) add(node, node.name, 'function');
    else if (t.isMethodDeclaration(node)) add(node, node.name, 'method');
    else if (t.isClassDeclaration(node)) add(node, node.name, 'class');
    else if (t.isInterfaceDeclaration(node)) add(node, node.name, 'interface');
    else if (t.isTypeAliasDeclaration(node)) add(node, node.name, 'type');
    else if (t.isEnumDeclaration(node)) add(node, node.name, 'enum');
    t.forEachChild(node, visit);
  }
  visit(sf);
  return rows;
}

// Printed declaration tokens make whitespace and comments irrelevant while
// keeping literals, operands, modifiers and the surrounding function intact.
export function declarationDigest(source, name, kind) {
  const t = ts();
  const sf = t.createSourceFile('source.ts', source, t.ScriptTarget.Latest, true);
  const rows = declarations(sf).filter((row) => row.name === name && row.kind === kind);
  if (rows.length !== 1) return null;
  const printer = t.createPrinter({ removeComments: true, newLine: t.NewLineKind.LineFeed });
  return digest(printer.printNode(t.EmitHint.Unspecified, rows[0].node, sf));
}

function lexicalChecker(sf) {
  const t = ts();
  return t.createProgram([sf.fileName], { noLib: true, noResolve: true }, {
    getSourceFile: (file) => file === sf.fileName ? sf : undefined,
    getDefaultLibFileName: () => '', writeFile() {}, getCurrentDirectory: () => '',
    getDirectories: () => [], fileExists: (file) => file === sf.fileName,
    readFile: (file) => file === sf.fileName ? sf.text : undefined,
    getCanonicalFileName: (file) => file, useCaseSensitiveFileNames: () => true,
    getNewLine: () => '\n',
  }).getTypeChecker();
}

function canonicalModule(file, module) {
  if (typeof module !== 'string' || !module.startsWith('.')) return null;
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), module));
  if (!safePath(resolved)) return null;
  return resolved.replace(/\.js$/, '.ts');
}

function inspectEdge(sf, file, edge, owner) {
  const t = ts();
  if (canonicalModule(file, edge.module) !== owner) return 'module does not resolve to owner';
  const matches = [];
  for (const statement of sf.statements) {
    if (!t.isImportDeclaration(statement) || statement.moduleSpecifier.text !== edge.module) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly || !clause.namedBindings || !t.isNamedImports(clause.namedBindings)) continue;
    for (const item of clause.namedBindings.elements)
      if (!item.isTypeOnly && (item.propertyName ?? item.name).text === edge.imported)
        matches.push(item);
  }
  if (matches.length !== 1) return `expected one runtime named import, found ${matches.length}`;
  const checker = lexicalChecker(sf);
  const binding = checker.getSymbolAtLocation(matches[0].name);
  let uses = 0;
  function visit(node) {
    if (t.isIdentifier(node) && node !== matches[0].name &&
        checker.getSymbolAtLocation(node) === binding) uses++;
    if (!t.isImportDeclaration(node)) t.forEachChild(node, visit);
  }
  visit(sf);
  if (uses !== edge.uses) return `expected ${edge.uses} bound references, found ${uses}`;
  return null;
}

/** Pure inspection: sources are data; no resolution, emit or evaluation. */
export function inspectRegistryOwnership(files, config) {
  const t = ts();
  const errors = [];
  if (!(files instanceof Map) || !config || config.version !== 1 ||
      !Array.isArray(config.profiles) || config.profiles.length === 0)
    return { errors: ['invalid or empty ownership configuration'], profiles: 0, files: 0 };
  const parsed = new Map();
  for (const [file, source] of files) {
    if (!safePath(file) || typeof source !== 'string') {
      errors.push(`invalid source entry: ${String(file)}`); continue;
    }
    const sf = t.createSourceFile(file, source, t.ScriptTarget.Latest, true);
    if (sf.parseDiagnostics.length) errors.push(`${file}: source syntax error`);
    parsed.set(file, { sf, rows: declarations(sf) });
  }
  const ids = new Set();
  for (const profile of config.profiles) {
    if (!profile || typeof profile.id !== 'string' || !profile.id || ids.has(profile.id) ||
        !safePath(profile.owner) || !Array.isArray(profile.roots) || profile.roots.length === 0 ||
        profile.roots.some((root) => !safePath(root)) ||
        !Array.isArray(profile.symbols) || profile.symbols.length === 0 ||
        !Array.isArray(profile.edges) || profile.edges.length === 0 ||
        !Array.isArray(profile.carriers) || profile.carriers.length === 0) {
      errors.push('invalid or duplicate ownership profile'); continue;
    }
    ids.add(profile.id);
    const scoped = [...parsed].filter(([file]) => profile.roots.some((root) => file.startsWith(`${root}/`)));
    if (!scoped.some(([file]) => file === profile.owner)) errors.push(`${profile.id}: missing owner`);
    for (const symbol of profile.symbols) {
      if (!symbol || !/^[A-Za-z_$][\w$]*$/.test(symbol.name) ||
          !['variable', 'function', 'class', 'interface', 'type', 'enum'].includes(symbol.kind)) {
        errors.push(`${profile.id}: invalid owned symbol`); continue;
      }
      const hits = scoped.flatMap(([file, { rows }]) =>
        rows.filter((row) => row.name === symbol.name).map((row) => ({ file, ...row })));
      if (hits.length !== 1 || hits[0].file !== profile.owner || hits[0].kind !== symbol.kind)
        errors.push(`${profile.id}: ${symbol.name} must have one ${symbol.kind} declaration in ${profile.owner}`);
    }
    for (const edge of profile.edges) {
      if (!edge || !safePath(edge.file) || typeof edge.imported !== 'string' ||
          !Number.isSafeInteger(edge.uses) || edge.uses < 1 || !parsed.has(edge.file)) {
        errors.push(`${profile.id}: invalid or missing consumer edge`); continue;
      }
      const failure = inspectEdge(parsed.get(edge.file).sf, edge.file, edge, profile.owner);
      if (failure) errors.push(`${profile.id}: ${edge.file}/${edge.imported}: ${failure}`);
    }
    for (const carrier of profile.carriers) {
      if (!carrier || !safePath(carrier.file) || typeof carrier.name !== 'string' ||
          !/^[0-9a-f]{64}$/.test(carrier.sha256) || !parsed.has(carrier.file) ||
          declarationDigest(files.get(carrier.file), carrier.name, carrier.kind) !== carrier.sha256)
        errors.push(`${profile.id}: carrier drift or missing declaration: ${carrier?.file}/${carrier?.name}`);
    }
  }
  return { errors, profiles: config.profiles.length, files: parsed.size };
}

function readSources(root, roots) {
  const files = new Map();
  function walk(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      // Symlinks are not followed: an external or hidden source cannot stand in
      // for an owned module. The required owner/edge then fails as missing.
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile() && runtimeSource.test(file) && !testSource.test(file))
        files.set(file, readFileSync(path.join(root, file), 'utf8'));
    }
  }
  for (const relative of new Set(roots)) {
    if (!safePath(relative)) throw new Error('invalid source root');
    walk(relative);
  }
  return files;
}

export function run(root = ROOT) {
  const config = JSON.parse(readFileSync(path.join(root, DATA), 'utf8'));
  if (!Array.isArray(config.profiles)) throw new Error('invalid ownership configuration');
  const files = readSources(root, config.profiles.flatMap((profile) => profile.roots ?? []));
  return inspectRegistryOwnership(files, config);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    process.stdout.write('Usage: node scripts/check-registry-ownership.mjs\nInspect bounded canonical registry owners and reviewed source carriers.\n');
  } else if (args.length) {
    process.stderr.write('Unsupported registry ownership arguments\n'); process.exitCode = 1;
  } else {
    try {
      const result = run();
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      if (result.errors.length) process.exitCode = 1;
    } catch (error) {
      process.stderr.write(`Registry ownership inspection failed: ${error.message}\n`); process.exitCode = 1;
    }
  }
}
