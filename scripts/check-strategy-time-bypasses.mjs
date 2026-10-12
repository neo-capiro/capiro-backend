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
    t.isNonNullExpression(node) ||
    t.isSatisfiesExpression(node)
  )
    node = node.expression;
  return node;
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

// This is a source ratchet, not runtime isolation. Bind only the inspected file:
// no module loading, semantic diagnostics, emit, evaluation or execution.
function lexicalInventory(sf) {
  const t = ts();
  const program = t.createProgram(
    [sf.fileName],
    { noLib: true, noResolve: true },
    {
      getSourceFile: (file) => (file === sf.fileName ? sf : undefined),
      getDefaultLibFileName: () => '',
      writeFile() {},
      getCurrentDirectory: () => '',
      getDirectories: () => [],
      fileExists: (file) => file === sf.fileName,
      readFile: (file) => (file === sf.fileName ? sf.text : undefined),
      getCanonicalFileName: (file) => file,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
    },
  );
  const checker = program.getTypeChecker();
  const bindings = new Map();
  const globals = new Set(['globalThis', 'global', 'window']);
  const hooks = new Set(['systemWallClock', 'systemRandom', 'systemDelay']);
  const timerModules = new Set([
    'timers',
    'node:timers',
    'timers/promises',
    'node:timers/promises',
  ]);
  const sharedModules = new Set(['@capiro/shared', '@capiro/shared/time']);
  const symbol = (node) => checker.getSymbolAtLocation(node);
  function put(name, descriptor) {
    const binding = symbol(name);
    if (!binding) return;
    const rows = bindings.get(binding) ?? [];
    rows.push(descriptor);
    bindings.set(binding, rows);
  }
  function bind(name, expression, keys = []) {
    if (t.isIdentifier(name)) put(name, { expression, keys });
    else if (t.isObjectBindingPattern(name) || t.isArrayBindingPattern(name)) {
      name.elements.forEach((element, index) => {
        if (t.isOmittedExpression(element)) return;
        // Rest can retain any capability of the source; never erase provenance.
        const key = element.dotDotDotToken
          ? '*'
          : t.isArrayBindingPattern(name)
            ? String(index)
            : (element.propertyName ?? element.name);
        bind(element.name, expression, [...keys, key]);
        if (element.initializer) bind(element.name, element.initializer);
      });
    }
  }
  function inventory(node) {
    if (t.isImportDeclaration(node) && node.importClause && !node.importClause.isTypeOnly) {
      const module = node.moduleSpecifier.text;
      const clause = node.importClause;
      if (clause.name && timerModules.has(module)) put(clause.name, { capability: 'timers' });
      const named = clause.namedBindings;
      if (named && t.isNamespaceImport(named)) {
        if (sharedModules.has(module)) put(named.name, { capability: 'shared' });
        else if (timerModules.has(module)) put(named.name, { capability: 'timers' });
      } else if (named)
        for (const item of named.elements) {
          if (item.isTypeOnly) continue;
          const original = (item.propertyName ?? item.name).text;
          if (hooks.has(original)) put(item.name, { capability: `hook:${original}` });
          if (original === 'withContextRetry') put(item.name, { capability: 'retry' });
          if (timerModules.has(module) && original === 'setTimeout')
            put(item.name, { capability: 'setTimeout' });
        }
    }
    if ((t.isVariableDeclaration(node) || t.isParameter(node)) && node.initializer)
      bind(node.name, node.initializer);
    if (t.isPropertyDeclaration(node) && node.initializer)
      put(node.name, { expression: node.initializer, keys: [] });
    if (
      t.isBinaryExpression(node) &&
      node.operatorToken.kind === t.SyntaxKind.EqualsToken &&
      t.isIdentifier(unwrap(node.left))
    )
      put(unwrap(node.left), { expression: node.right, keys: [] });
    t.forEachChild(node, inventory);
  }
  inventory(sf); // Includes hoisted imports and aliases before any reference is checked.
  function constant(node, seen = new Set()) {
    if (typeof node === 'string') return node;
    if (!node) return undefined;
    node = unwrap(node);
    if (t.isComputedPropertyName(node)) return constant(node.expression, seen);
    if (t.isStringLiteralLike(node)) return node.text;
    if (t.isNumericLiteral(node)) return Number(node.text);
    if (t.isIdentifier(node)) {
      const binding = symbol(node);
      if (!binding || seen.has(binding)) return undefined;
      const rows = bindings.get(binding) ?? [];
      // Only unmodified const bindings are static names. A dynamic key on a
      // known time namespace is refused below instead of guessed safe.
      const declaration = binding.valueDeclaration;
      if (
        !declaration ||
        !t.isVariableDeclaration(declaration) ||
        !(declaration.parent.flags & t.NodeFlags.Const) ||
        rows.length !== 1 ||
        rows[0].keys?.length
      )
        return undefined;
      return constant(rows[0].expression, new Set([...seen, binding]));
    }
    if (t.isBinaryExpression(node) && node.operatorToken.kind === t.SyntaxKind.PlusToken) {
      const left = constant(node.left, seen),
        right = constant(node.right, seen);
      if (left !== undefined && right !== undefined) return left + right;
    }
    if (t.isTemplateExpression(node)) {
      let value = node.head.text;
      for (const span of node.templateSpans) {
        const substitution = constant(span.expression, seen);
        if (substitution === undefined) return undefined;
        value += substitution + span.literal.text;
      }
      return value;
    }
    return undefined;
  }
  function nameOf(node) {
    if (!node) return undefined;
    const value = t.isIdentifier(node) || t.isPrivateIdentifier(node) ? node.text : constant(node);
    return value === undefined ? undefined : String(value);
  }
  function property(node) {
    node = unwrap(node);
    if (t.isPropertyAccessExpression(node)) return [unwrap(node.expression), node.name.text];
    if (t.isElementAccessExpression(node)) {
      const key = constant(node.argumentExpression);
      return [unwrap(node.expression), key === undefined ? undefined : String(key)];
    }
    return null;
  }
  const union = (sets) => new Set(sets.flatMap((set) => [...set]));
  function select(capabilities, key) {
    const result = new Set();
    for (const cap of capabilities) {
      if (cap === 'global' && ['Date', 'Math', 'setTimeout'].includes(key)) result.add(key);
      else if (cap === 'Date' && key === 'now') result.add('Date.now');
      else if (cap === 'Math' && key === 'random') result.add('Math.random');
      else if (cap === 'shared' && hooks.has(key)) result.add(`hook:${key}`);
      else if (cap === 'shared' && key === 'withContextRetry') result.add('retry');
      else if (cap === 'timers' && key === 'setTimeout') result.add('setTimeout');
      else if (key === '*' || key === undefined || ['call', 'apply', 'bind'].includes(key)) {
        if (cap !== 'global' || key === '*' || key === undefined) result.add(cap);
        if (key === undefined && ['global', 'Date', 'Math', 'shared', 'timers'].includes(cap))
          result.add('opaque');
      }
    }
    // Reserved canonical names remain owned even on otherwise unknown objects.
    if (hooks.has(key)) result.add(`hook:${key}`);
    if (key === 'withContextRetry') result.add('retry');
    return result;
  }
  function through(expression, keys, seen) {
    expression = unwrap(expression);
    if (!keys.length) return resolve(expression, seen);
    const [raw, ...rest] = keys;
    const key = typeof raw === 'string' ? raw : nameOf(raw);
    if (
      t.isIdentifier(expression) ||
      t.isPropertyAccessExpression(expression) ||
      t.isElementAccessExpression(expression)
    ) {
      const binding = symbol(expression);
      if (binding && !seen.has(binding) && bindings.has(binding))
        return union(
          bindings
            .get(binding)
            .map((row) =>
              row.capability
                ? throughCapabilities(new Set([row.capability]), [key, ...rest])
                : through(row.expression, [...row.keys, ...keys], new Set([...seen, binding])),
            ),
        );
    }
    if (t.isObjectLiteralExpression(expression)) {
      const matches = expression.properties.filter(
        (item) => !t.isSpreadAssignment(item) && (key === '*' || nameOf(item.name) === key),
      );
      const values = matches
        .map((item) => (t.isShorthandPropertyAssignment(item) ? item.name : item.initializer))
        .filter(Boolean);
      const spreads = expression.properties
        .filter(t.isSpreadAssignment)
        .map((item) => through(item.expression, keys, seen));
      return union([...values.map((value) => through(value, rest, seen)), ...spreads]);
    }
    if (t.isArrayLiteralExpression(expression)) {
      const elements = key === '*' ? expression.elements : [expression.elements[Number(key)]];
      return union(
        elements
          .filter(Boolean)
          .map((item) => through(t.isSpreadElement(item) ? item.expression : item, rest, seen)),
      );
    }
    const member = property(expression);
    if (member) return through(member[0], [member[1], ...keys], seen);
    if (t.isConditionalExpression(expression))
      return union([
        through(expression.whenTrue, keys, seen),
        through(expression.whenFalse, keys, seen),
      ]);
    return throughCapabilities(resolve(expression, seen), [key, ...rest]);
  }
  function throughCapabilities(caps, keys) {
    for (const raw of keys) caps = select(caps, typeof raw === 'string' ? raw : nameOf(raw));
    return caps;
  }
  function resolve(node, seen = new Set()) {
    node = unwrap(node);
    if (t.isIdentifier(node)) {
      const binding = symbol(node);
      if (binding && !seen.has(binding) && bindings.has(binding))
        return union(
          bindings
            .get(binding)
            .map((row) =>
              row.capability
                ? new Set([row.capability])
                : through(row.expression, row.keys, new Set([...seen, binding])),
            ),
        );
      if (hooks.has(node.text)) return new Set([`hook:${node.text}`]);
      if (node.text === 'withContextRetry') return new Set(['retry']);
      // A parameter/local object named Date, Math, globalThis or rng has its
      // own lexical binding; it must not inherit an unrelated ambient alias.
      if (!binding?.declarations?.length && globals.has(node.text)) return new Set(['global']);
      if (!binding?.declarations?.length && ['Date', 'Math', 'setTimeout'].includes(node.text))
        return new Set([node.text]);
      return new Set();
    }
    const member = property(node);
    if (member) {
      const binding = symbol(node);
      if (binding && !seen.has(binding) && bindings.has(binding))
        return union(
          bindings
            .get(binding)
            .map((row) => through(row.expression, row.keys, new Set([...seen, binding]))),
        );
      return through(member[0], [member[1]], seen);
    }
    if (t.isConditionalExpression(node))
      return union([resolve(node.whenTrue, seen), resolve(node.whenFalse, seen)]);
    if (
      t.isBinaryExpression(node) &&
      [
        t.SyntaxKind.BarBarToken,
        t.SyntaxKind.QuestionQuestionToken,
        t.SyntaxKind.AmpersandAmpersandToken,
      ].includes(node.operatorToken.kind)
    )
      return union([resolve(node.left, seen), resolve(node.right, seen)]);
    return new Set();
  }
  return { resolve, nameOf, property, hooks };
}

function valueReference(node) {
  const t = ts();
  let current = node;
  for (let parent = node.parent; parent; current = parent, parent = parent.parent) {
    if (
      t.isTypeNode(parent) ||
      t.isImportDeclaration(parent) ||
      t.isImportEqualsDeclaration(parent)
    )
      return false;
    if (t.isExportSpecifier(parent))
      return parent.propertyName === current || (!parent.propertyName && parent.name === current);
    if (parent.name === current && !t.isShorthandPropertyAssignment(parent)) return false;
    if (
      (t.isPropertyAccessExpression(parent) && parent.name === current) ||
      (t.isBindingElement(parent) && parent.propertyName === current)
    )
      return false;
    if (t.isStatement(parent) || t.isExpression(parent)) break;
  }
  return true;
}

function directParent(node) {
  let current = node;
  while (current.parent && unwrap(current.parent) === unwrap(current)) current = current.parent;
  return current.parent;
}

export function analyzeTimeSource(file, source, policy = {}) {
  const t = ts();
  const sf = t.createSourceFile(file, source, t.ScriptTarget.Latest, true, t.ScriptKind.TS);
  const inventory = lexicalInventory(sf);
  const events = [];
  const retryCalls = [];
  const retryDefinitions = [];
  const definitions = [];
  const problems = sf.parseDiagnostics.map(
    (d) => `${file}: ${t.flattenDiagnosticMessageText(d.messageText, ' ')}`,
  );
  const canonicalNames = new Set(['withContextRetry', ...inventory.hooks]);
  function add(node, kind) {
    events.push(eventKey(node, kind, file));
  }
  function providerValue(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (t.isFunctionLike(parent)) return false;
      if (t.isVariableDeclaration(parent))
        return (
          policy.systemHookValueOwners?.some(
            (owner) => owner.file === file && parent.name.getText(sf) === owner.binding,
          ) ?? false
        );
    }
    return false;
  }
  function visit(node) {
    if (t.isCallExpression(node)) {
      const expression = unwrap(node.expression);
      const caps = inventory.resolve(expression);
      for (const kind of ['Date.now', 'Math.random', 'setTimeout'])
        if (caps.has(kind)) add(node, kind);
      if (caps.has('Date')) add(node, 'Date()');
      if ([...caps].some((cap) => cap.startsWith('hook:')))
        add(node, 'system time hook invoked outside its provider');
      if (caps.has('opaque')) add(node, 'dynamic time namespace member');
      if (caps.has('retry')) {
        retryCalls.push({
          file,
          owner: ownerOf(node),
          arguments: node.arguments.length,
          runtime: node.arguments[2]?.getText(sf) ?? null,
        });
        if (!t.isIdentifier(expression) || expression.text !== 'withContextRetry')
          problems.push(
            `${file}: retry alias/namespace/member indirection is outside the adopted boundary`,
          );
      }
    }
    if (
      t.isNewExpression(node) &&
      inventory.resolve(node.expression).has('Date') &&
      (!node.arguments?.length || node.arguments.some(t.isSpreadElement))
    )
      add(node, node.arguments?.length ? 'spread Date constructor' : 'new Date()');
    if (
      (t.isIdentifier(node) ||
        t.isPropertyAccessExpression(node) ||
        t.isElementAccessExpression(node)) &&
      valueReference(node)
    ) {
      const caps = inventory.resolve(node);
      const parent = directParent(node);
      const access = inventory.property(parent);
      const memberBase = access && access[0] === unwrap(node);
      const directCall = t.isCallExpression(parent) && unwrap(parent.expression) === unwrap(node);
      const directConstructor =
        t.isNewExpression(parent) && unwrap(parent.expression) === unwrap(node);
      if (!memberBase && !directCall && !directConstructor) {
        for (const base of ['Date', 'Math', 'setTimeout'])
          if (caps.has(base)) add(node, `${base} value/alias`);
        for (const base of ['Date.now', 'Math.random'])
          if (caps.has(base)) add(node, `${base} reference/alias`);
        if ([...caps].some((cap) => cap.startsWith('hook:')) && !providerValue(node))
          add(node, 'system time hook reference outside its provider');
        if (caps.has('retry'))
          problems.push(`${file}: retry reference/alias is outside the adopted boundary`);
        if (caps.has('opaque')) add(node, 'dynamic time namespace member');
      }
    }
    if (
      t.isImportSpecifier(node) &&
      !node.isTypeOnly &&
      (node.propertyName ?? node.name).text === 'withContextRetry' &&
      node.name.text !== 'withContextRetry'
    )
      problems.push(`${file}: retry import alias bypass`);
    if (t.isFunctionDeclaration(node) && node.name?.text === 'withContextRetry')
      retryDefinitions.push({
        file,
        parameters: node.parameters.length,
        runtimeOptional: node.parameters[2]?.questionToken != null,
        runtimeDefaulted: node.parameters[2]?.initializer != null,
      });
    if (
      node.name &&
      (t.isFunctionDeclaration(node) ||
        t.isVariableDeclaration(node) ||
        t.isMethodDeclaration(node) ||
        t.isBindingElement(node) ||
        t.isGetAccessorDeclaration(node) ||
        t.isSetAccessorDeclaration(node) ||
        ((t.isPropertyAssignment(node) || t.isPropertyDeclaration(node)) &&
          node.initializer &&
          (t.isArrowFunction(unwrap(node.initializer)) ||
            t.isFunctionExpression(unwrap(node.initializer)) ||
            inventory.resolve(node.initializer).size)))
    ) {
      const name = inventory.nameOf(node.name);
      if (name && (t.isIdentifier(node.name) || canonicalNames.has(name)))
        definitions.push({ file, name });
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
    !Array.isArray(data.existingAmbient) ||
    !Array.isArray(data.systemHookValueOwners)
  )
    return ['missing/invalid time-boundary data'];
  const uniqueProviders = new Set();
  for (const owner of data.systemHookValueOwners) {
    const key = `${owner.file}|${owner.binding}`;
    if (
      !data.requiredFiles.includes(owner.file) ||
      !/^[A-Za-z_$][\w$]*$/.test(owner.binding) ||
      !owner.reason ||
      uniqueProviders.has(key)
    )
      problems.push(
        'system hook values need unique exact required-file/provider-binding ownership and reasons',
      );
    uniqueProviders.add(key);
  }
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
    const result = analyzeTimeSource(file, source, data);
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
