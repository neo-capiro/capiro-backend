#!/usr/bin/env node
/** @cleanup-smoke noArgsExit=0 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = resolve(dirname(SCRIPT_PATH), '..');

export const TARGETS = [
  { root: 'apps/workspace/src', tsconfig: 'apps/workspace/tsconfig.json' },
  { root: 'apps/api-strategy/src', tsconfig: 'apps/api-strategy/tsconfig.json' },
  { root: 'apps/intel-api/src', tsconfig: 'apps/intel-api/tsconfig.json' },
];

// This guard is deliberately scoped to TypeScript module-reference syntax.
// Comments, descriptions, configuration keys, and the approved narrow HTTP
// gateway may name MeriV3 because they do not link its implementation into an
// adjacent runtime. Allowing those strings is not a new cross-subsystem grant:
// imports, re-exports, import types, dynamic imports, require calls, and import
// equals declarations that reach MeriV3 implementation remain forbidden.
const MERIV3_MODULE_NAME = /(?:^|[/@_-])meri-?v3(?:$|[/_.-])/i;
const MERIV3_ORCHESTRATOR_PACKAGE = /^@capiro\/meriv2-orchestrator(?:\/|$)/;

function normalizedPath(path) {
  return resolve(path).split(sep).join('/').toLowerCase();
}

function isWithin(path, root) {
  return path === root || path.startsWith(`${root}/`);
}

function isForbiddenImplementationPath(path, repositoryRoot) {
  const candidate = normalizedPath(path);
  const root = normalizedPath(repositoryRoot);
  const orchestratorRuntime = `${root}/apps/meriv2-orchestrator/src/meri/meriv3`;
  if (isWithin(candidate, orchestratorRuntime)) {
    return true;
  }

  const apiSourcePrefix = `${root}/apps/api/src/`;
  if (!candidate.startsWith(apiSourcePrefix)) {
    return false;
  }

  const apiRelative = candidate.slice(apiSourcePrefix.length);
  return /^(?:meri\/(?:meriv3|meri-v3)[^/]*|common\/meriv3[^/]*|capiro-admin\/meriv3[^/]*)/.test(
    apiRelative,
  );
}

function createLexicalChecker(sourceFile, compilerOptions) {
  const options = {
    ...compilerOptions,
    noLib: true,
    noResolve: true,
    types: [],
  };
  const sourcePath = normalizedPath(sourceFile.fileName);
  const host = ts.createCompilerHost(options, true);
  host.fileExists = (fileName) => normalizedPath(fileName) === sourcePath;
  host.readFile = (fileName) =>
    normalizedPath(fileName) === sourcePath ? sourceFile.text : undefined;
  host.getSourceFile = (fileName) =>
    normalizedPath(fileName) === sourcePath ? sourceFile : undefined;

  return ts.createProgram([sourceFile.fileName], options, host).getTypeChecker();
}

function collectUniqueConstInitializers(sourceFile, checker) {
  const initializers = new Map();
  const ambiguous = new Set();

  function visit(node) {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const symbol = checker.getSymbolAtLocation(declaration.name);
          if (!symbol) {
            continue;
          }
          if (initializers.has(symbol)) {
            ambiguous.add(symbol);
          } else {
            initializers.set(symbol, declaration.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const symbol of ambiguous) {
    initializers.delete(symbol);
  }
  return initializers;
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isTypeAssertionExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStringEvaluator(initializers, checker) {
  const cache = new Map();

  function evaluate(node, resolving = new Set()) {
    const expression = unwrapExpression(node);
    if (ts.isStringLiteralLike(expression)) {
      return expression.text;
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      const left = evaluate(expression.left, resolving);
      const right = evaluate(expression.right, resolving);
      return left === undefined || right === undefined ? undefined : left + right;
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        const substitution = evaluate(span.expression, resolving);
        if (substitution === undefined) {
          return undefined;
        }
        value += substitution + span.literal.text;
      }
      return value;
    }
    if (ts.isIdentifier(expression)) {
      const symbol = checker.getSymbolAtLocation(expression);
      if (!symbol || !initializers.has(symbol)) {
        return undefined;
      }
      if (cache.has(symbol)) {
        return cache.get(symbol);
      }
      if (resolving.has(symbol)) {
        return undefined;
      }
      const value = evaluate(initializers.get(symbol), new Set(resolving).add(symbol));
      cache.set(symbol, value);
      return value;
    }
    return undefined;
  }

  return evaluate;
}

function pathAliasCandidates(specifier, compilerOptions) {
  if (!compilerOptions?.paths || !compilerOptions.baseUrl) {
    return [];
  }

  const candidates = [];
  for (const [pattern, substitutions] of Object.entries(compilerOptions.paths)) {
    const star = pattern.indexOf('*');
    let matched = '';
    if (star === -1) {
      if (specifier !== pattern) {
        continue;
      }
    } else {
      const prefix = pattern.slice(0, star);
      const suffix = pattern.slice(star + 1);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) {
        continue;
      }
      matched = specifier.slice(prefix.length, specifier.length - suffix.length);
    }

    for (const substitution of substitutions) {
      candidates.push(
        resolve(
          compilerOptions.baseUrl,
          star === -1 ? substitution : substitution.replace('*', matched),
        ),
      );
    }
  }
  return candidates;
}

function resolvedCandidates(specifier, sourceFileName, compilerOptions, repositoryRoot) {
  const candidates = [];
  const resolution = ts.resolveModuleName(
    specifier,
    sourceFileName,
    compilerOptions ?? {},
    ts.sys,
  ).resolvedModule;
  if (resolution) {
    candidates.push(resolution.resolvedFileName);
  }

  candidates.push(...pathAliasCandidates(specifier, compilerOptions));

  if (specifier.startsWith('.') || specifier.startsWith('/')) {
    candidates.push(resolve(dirname(sourceFileName), specifier));
  }

  const orchestratorPackage = '@capiro/meriv2-orchestrator';
  if (specifier === orchestratorPackage || specifier.startsWith(`${orchestratorPackage}/`)) {
    const subpath = specifier.slice(orchestratorPackage.length).replace(/^\//, '');
    candidates.push(resolve(repositoryRoot, 'apps/meriv2-orchestrator', subpath));
  }

  const apiPackage = '@capiro/api';
  if (specifier.startsWith(`${apiPackage}/`)) {
    candidates.push(resolve(repositoryRoot, 'apps/api', specifier.slice(apiPackage.length + 1)));
  }

  return candidates;
}

function syntaxDiagnosticReason(diagnostic) {
  return `syntax error TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`;
}

export function inspectSource(
  source,
  file = 'apps/workspace/src/<source>.ts',
  { repositoryRoot = REPOSITORY_ROOT, compilerOptions = {} } = {},
) {
  const sourceFileName = resolve(repositoryRoot, file);
  const sourceFile = ts.createSourceFile(
    sourceFileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const violations = [];
  const seen = new Set();

  function addViolation(node, reason) {
    const start = node?.getStart?.(sourceFile) ?? node?.start ?? 0;
    const line = sourceFile.getLineAndCharacterOfPosition(Math.max(0, start)).line + 1;
    const key = `${line}:${reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      violations.push({ file, line, reason });
    }
  }

  for (const diagnostic of sourceFile.parseDiagnostics) {
    addViolation({ start: diagnostic.start ?? 0 }, syntaxDiagnosticReason(diagnostic));
  }
  if (sourceFile.parseDiagnostics.length > 0) {
    return violations;
  }

  const checker = createLexicalChecker(sourceFile, compilerOptions);
  const evaluateStaticString = staticStringEvaluator(
    collectUniqueConstInitializers(sourceFile, checker),
    checker,
  );

  function inspectModuleReference(node, expression, kind, { failOnUnknown = false } = {}) {
    const specifier = evaluateStaticString(expression);
    if (specifier === undefined) {
      if (failOnUnknown) {
        addViolation(
          node,
          `unsupported computed ${kind} module reference; MeriV3 boundary cannot be proven`,
        );
      }
      return;
    }

    const normalizedSpecifier = specifier.replaceAll('\\', '/');
    const reachesForbiddenPath = resolvedCandidates(
      normalizedSpecifier,
      sourceFileName,
      compilerOptions,
      repositoryRoot,
    ).some((candidate) => isForbiddenImplementationPath(candidate, repositoryRoot));

    if (
      MERIV3_MODULE_NAME.test(normalizedSpecifier) ||
      MERIV3_ORCHESTRATOR_PACKAGE.test(normalizedSpecifier) ||
      reachesForbiddenPath
    ) {
      addViolation(node, `forbidden MeriV3 implementation ${kind}: ${JSON.stringify(specifier)}`);
    }
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      inspectModuleReference(
        node.moduleSpecifier,
        node.moduleSpecifier,
        ts.isImportDeclaration(node) ? 'import' : 're-export',
      );
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      inspectModuleReference(node, node.moduleReference.expression, 'import equals');
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument) && ts.isStringLiteralLike(node.argument.literal)) {
        inspectModuleReference(node, node.argument.literal, 'type import');
      }
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        if (node.arguments[0]) {
          inspectModuleReference(node, node.arguments[0], 'dynamic import', {
            failOnUnknown: true,
          });
        }
      } else {
        const callee = unwrapExpression(node.expression);
        if (!ts.isIdentifier(callee) || callee.text !== 'require') {
          ts.forEachChild(node, visit);
          return;
        }
        if (node.arguments[0]) {
          inspectModuleReference(node, node.arguments[0], 'require', { failOnUnknown: true });
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function productionSourceFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...productionSourceFiles(path));
    } else if (
      entry.isFile() &&
      /\.(?:ts|tsx)$/.test(entry.name) &&
      !/\.(?:spec|test|d)\.(?:ts|tsx)$/.test(entry.name)
    ) {
      files.push(path);
    }
  }
  return files.sort();
}

function readCompilerOptions(repositoryRoot, configFile) {
  const configPath = resolve(repositoryRoot, configFile);
  const loaded = ts.readConfigFile(configPath, ts.sys.readFile);
  if (loaded.error) {
    return { errors: [loaded.error], options: {} };
  }
  const parsed = ts.parseJsonConfigFileContent(
    loaded.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  return { errors: parsed.errors, options: parsed.options };
}

export function verifyRepository(repositoryRoot = REPOSITORY_ROOT) {
  const files = [];
  const violations = [];

  for (const target of TARGETS) {
    const config = readCompilerOptions(repositoryRoot, target.tsconfig);
    for (const diagnostic of config.errors) {
      violations.push({
        file: target.tsconfig,
        line: 1,
        reason: `tsconfig error TS${diagnostic.code}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ')}`,
      });
    }

    const targetFiles = productionSourceFiles(resolve(repositoryRoot, target.root));
    files.push(...targetFiles);
    for (const absoluteFile of targetFiles) {
      const file = relative(repositoryRoot, absoluteFile).split(sep).join('/');
      violations.push(
        ...inspectSource(readFileSync(absoluteFile, 'utf8'), file, {
          repositoryRoot,
          compilerOptions: config.options,
        }),
      );
    }
  }

  return { files, violations };
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  console.error('Usage: node scripts/verify-meriv3-import-boundary.mjs (no arguments runs the existing verifier)');
  try {
    const { files, violations } = verifyRepository();
    if (violations.length > 0) {
      for (const violation of violations) {
        console.error(`${violation.file}:${violation.line}: ${violation.reason}`);
      }
      console.error(
        'MeriV3 implementation imports are forbidden in Workspace, Strategy, and intel-api.',
      );
      process.exitCode = 1;
    } else {
      console.log(`MeriV3 import boundary guard passed (${files.length} production files).`);
    }
  } catch (error) {
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    process.exitCode = 1;
  }
}
