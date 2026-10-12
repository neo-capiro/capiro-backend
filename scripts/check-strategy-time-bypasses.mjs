#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 helpExit=0 */
import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let compiler;
const ts = () => (compiler ??= require('typescript'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = 'scripts/strategy-time-boundaries.json';

function unwrap(node) {
  const t = ts();
  while (
    t.isParenthesizedExpression(node) ||
    t.isAsExpression(node) ||
    t.isTypeAssertionExpression(node) ||
    t.isNonNullExpression(node)
  )
    node = node.expression;
  return node;
}

function member(node) {
  const t = ts();
  node = unwrap(node);
  if (t.isPropertyAccessExpression(node)) return [unwrap(node.expression), node.name.text];
  if (t.isElementAccessExpression(node) && t.isStringLiteralLike(node.argumentExpression)) {
    return [unwrap(node.expression), node.argumentExpression.text];
  }
  return null;
}

function ambientBase(node) {
  const t = ts();
  node = unwrap(node);
  if (t.isIdentifier(node) && ['Date', 'Math', 'setTimeout'].includes(node.text)) return node.text;
  const m = member(node);
  if (
    m &&
    t.isIdentifier(m[0]) &&
    ['globalThis', 'global', 'window'].includes(m[0].text) &&
    ['Date', 'Math', 'setTimeout'].includes(m[1])
  )
    return m[1];
  return null;
}

function ownerOf(node) {
  const t = ts();
  const names = [];
  for (let p = node.parent; p; p = p.parent) {
    if (
      (t.isFunctionDeclaration(p) || t.isMethodDeclaration(p) || t.isClassDeclaration(p)) &&
      p.name
    ) {
      names.unshift(p.name.getText());
    } else if (
      (t.isArrowFunction(p) || t.isFunctionExpression(p)) &&
      t.isVariableDeclaration(p.parent)
    )
      names.unshift(p.parent.name.getText());
  }
  return names.join('.') || '<module>';
}

function eventKey(node, kind, file) {
  const t = ts();
  // Parent bindings distinguish existing mutation timestamps from a new clock
  // read elsewhere in the same method. Positions and comments are not identity.
  let context = '';
  for (let p = node.parent; p && !t.isStatement(p); p = p.parent) {
    if (t.isPropertyAssignment(p) || t.isVariableDeclaration(p) || t.isParameter(p)) {
      context = `${t.SyntaxKind[p.kind]}:${p.name.getText()}`;
      break;
    }
  }
  return [file, ownerOf(node), context, kind].join('|');
}

export function analyzeTimeSource(file, source) {
  const t = ts();
  const sf = t.createSourceFile(file, source, t.ScriptTarget.Latest, true, t.ScriptKind.TS);
  const events = [];
  const retryCalls = [];
  const retryDefinitions = [];
  const definitions = [];
  const systemHooks = new Set(['systemWallClock', 'systemRandom', 'systemDelay']);
  const problems = sf.parseDiagnostics.map(
    (d) => `${file}: ${t.flattenDiagnosticMessageText(d.messageText, ' ')}`,
  );
  function add(node, kind) {
    events.push(eventKey(node, kind, file));
  }
  function visit(node) {
    if (t.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      const m = member(expression);
      const base = m && ambientBase(m[0]);
      if ((base === 'Date' && m[1] === 'now') || (base === 'Math' && m[1] === 'random')) {
        add(node, `${base}.${m[1]}`);
      } else if (ambientBase(expression) === 'Date') add(node, 'Date()');
      else if (ambientBase(expression) === 'setTimeout') add(node, 'setTimeout');
      if (
        (t.isIdentifier(expression) && systemHooks.has(expression.text)) ||
        (m && systemHooks.has(m[1]))
      )
        add(node, 'system time hook invoked outside its provider');
      if (t.isIdentifier(expression) && expression.text === 'withContextRetry') {
        retryCalls.push({
          file,
          owner: ownerOf(node),
          arguments: node.arguments.length,
          runtime: node.arguments[2]?.getText(sf) ?? null,
        });
      } else if (m?.[1] === 'withContextRetry') {
        problems.push(
          `${file}: retry namespace/member indirection is outside the adopted boundary`,
        );
      }
    }
    if (
      t.isNewExpression(node) &&
      ambientBase(node.expression) === 'Date' &&
      (!node.arguments?.length || node.arguments.some(t.isSpreadElement))
    ) {
      add(node, node.arguments?.length ? 'spread Date constructor' : 'new Date()');
    }
    const base = ambientBase(node);
    if (base) {
      const parent = node.parent;
      const p = member(parent);
      const directConstructor = t.isNewExpression(parent) && parent.expression === node;
      const directCall = t.isCallExpression(parent) && parent.expression === node;
      const typeOnly = t.isTypeReferenceNode(parent) || t.isTypeQueryNode(parent);
      const memberBase = p && p[0] === unwrap(node);
      const nestedGlobal = t.isIdentifier(node) && member(node.parent)?.[1] === base;
      if (!directConstructor && !directCall && !typeOnly && !memberBase && !nestedGlobal) {
        add(node, `${base} value/alias`);
      }
    }
    const m = member(node);
    if (
      m &&
      ((ambientBase(m[0]) === 'Date' && m[1] === 'now') ||
        (ambientBase(m[0]) === 'Math' && m[1] === 'random'))
    ) {
      const parent = node.parent;
      if (!(t.isCallExpression(parent) && unwrap(parent.expression) === node)) {
        add(node, `${ambientBase(m[0])}.${m[1]} reference/alias`);
      }
    }
    if (
      t.isImportSpecifier(node) &&
      (node.propertyName ?? node.name).text === 'withContextRetry' &&
      node.name.text !== 'withContextRetry'
    )
      problems.push(`${file}: retry import alias bypass`);
    if (t.isImportSpecifier(node) && systemHooks.has((node.propertyName ?? node.name).text)) {
      systemHooks.add(node.name.text);
    }
    if (t.isFunctionDeclaration(node) && node.name?.text === 'withContextRetry') {
      retryDefinitions.push({
        file,
        parameters: node.parameters.length,
        runtimeOptional: node.parameters[2]?.questionToken != null,
        runtimeDefaulted: node.parameters[2]?.initializer != null,
      });
    }
    if (
      (t.isFunctionDeclaration(node) ||
        t.isVariableDeclaration(node) ||
        t.isMethodDeclaration(node) ||
        t.isBindingElement(node)) &&
      node.name &&
      t.isIdentifier(node.name)
    ) {
      definitions.push({ file, name: node.name.text });
    }
    t.forEachChild(node, visit);
  }
  visit(sf);
  return { events, retryCalls, retryDefinitions, definitions, problems };
}

export function checkTimeSources(sources, data) {
  const problems = [];
  if (
    data.version !== 1 ||
    !data.requiredFiles?.length ||
    !data.retryConsumers?.length ||
    !Array.isArray(data.existingAmbient)
  )
    return ['missing/invalid time-boundary data'];
  const uniqueAmbient = new Set();
  for (const item of data.existingAmbient) {
    if (
      typeof item.key !== 'string' ||
      item.key.includes('*') ||
      uniqueAmbient.has(item.key) ||
      !Number.isInteger(item.maximum) ||
      item.maximum <= 0 ||
      !item.reason
    ) {
      problems.push('ambient inventory needs unique exact identities, positive counts and reasons');
    }
    uniqueAmbient.add(item.key);
  }
  for (const item of data.retryConsumers)
    if (
      !Number.isInteger(item.calls) ||
      item.calls <= 0 ||
      !/^this\.[A-Za-z_$][\w$]*$/.test(item.runtime)
    )
      problems.push('invalid explicit retry consumer data');
  const counts = new Map();
  const retryCalls = [];
  const retryDefinitions = [];
  const allDefinitions = [];
  for (const [file, source] of sources) {
    const result = analyzeTimeSource(file, source);
    problems.push(...result.problems);
    retryCalls.push(...result.retryCalls);
    retryDefinitions.push(...result.retryDefinitions);
    allDefinitions.push(...result.definitions);
    for (const key of result.events) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const allowed = new Map(data.existingAmbient.map((x) => [x.key, x.maximum]));
  for (const [key, count] of counts)
    if (count > (allowed.get(key) ?? 0)) {
      problems.push(
        `unadopted ambient time/randomness: ${key} (${count} > ${allowed.get(key) ?? 0})`,
      );
    }
  for (const item of data.retryConsumers) {
    const calls = retryCalls.filter((x) => x.file === item.file);
    if (calls.length !== item.calls)
      problems.push(`${item.file}: expected ${item.calls} retry boundaries, saw ${calls.length}`);
    for (const call of calls)
      if (call.arguments !== 3 || call.runtime !== item.runtime) {
        problems.push(`${item.file}: retry must use the explicit injected runtime ${item.runtime}`);
      }
  }
  for (const call of retryCalls)
    if (!data.retryConsumers.some((x) => x.file === call.file)) {
      problems.push(`${call.file}: new retry consumer needs explicit adoption and a data row`);
    }
  const definitions = retryDefinitions.filter((x) => x.file === data.retryDefinition);
  if (
    definitions.length !== 1 ||
    definitions.some((x) => x.parameters !== 3 || x.runtimeOptional || x.runtimeDefaulted)
  )
    problems.push('retry runtime must be a required parameter with no fallback');
  for (const item of data.canonicalDefinitions ?? []) {
    const matches = allDefinitions.filter((x) => x.name === item.name);
    if (matches.length !== 1 || matches[0].file !== item.file) {
      problems.push(`canonical helper ${item.name} must be defined only in ${item.file}`);
    }
  }
  for (const file of data.requiredFiles)
    if (!sources.has(file)) problems.push(`missing required boundary: ${file}`);
  return problems;
}

function sourceFiles(root, directories) {
  const sources = new Map();
  function walk(relative) {
    for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const file = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`source symlink is outside the ratchet inventory: ${file}`);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith('.ts') && !/\.(?:spec|test|d)\.ts$/.test(entry.name)) {
        sources.set(file, readFileSync(path.join(root, file), 'utf8'));
      }
    }
  }
  for (const directory of directories) walk(directory);
  return sources;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 1 && args[0] === '--help')) {
    console.error('Usage: node scripts/check-strategy-time-bypasses.mjs [--help]');
    process.exitCode = 2;
  } else if (args[0] === '--help') {
    console.log('Usage: node scripts/check-strategy-time-bypasses.mjs [--help]');
  } else {
    try {
      const data = JSON.parse(readFileSync(path.join(ROOT, DATA), 'utf8'));
      if (!Array.isArray(data.sourceRoots) || !data.sourceRoots.length)
        throw new Error('missing source roots');
      const sources = sourceFiles(ROOT, data.sourceRoots);
      for (const file of data.extraSourceFiles ?? []) {
        const absolute = path.resolve(ROOT, file);
        if (!absolute.startsWith(ROOT + path.sep))
          throw new Error('source path escapes repository');
        sources.set(file, readFileSync(absolute, 'utf8'));
      }
      const problems = checkTimeSources(sources, data);
      if (problems.length) throw new Error(problems.join('\n'));
      console.log(
        `Strategy time ratchet passed (${sources.size} production files; explicit retry and ambient-read inventory).`,
      );
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
