import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export const TARGET_ROOTS = ['apps/workspace/src', 'apps/api-strategy/src', 'apps/intel-api/src'];

const FORBIDDEN_MODULES = [
  {
    pattern: /(?:^|\/)meri-v3-visual-analysis\.service(?:\.[cm]?[jt]s)?$/i,
    reason: 'direct MeriV3 visual-analysis service import',
  },
  {
    pattern: /(?:^|\/)api-visual-analysis\.repo(?:\.[cm]?[jt]s)?$/i,
    reason: 'direct MeriV3 visual-analysis execution bridge import',
  },
  {
    pattern: /(?:^|\/)clio-sandbox(?:\/|$)/i,
    reason: 'direct analysis-sandbox import',
  },
];

const FORBIDDEN_CODE = [
  {
    pattern: /\bCLIO_SANDBOX_(?:URL|TOKEN)\b/,
    reason: 'analysis-sandbox connection configuration',
  },
  {
    pattern: /\brunSandboxed\s*\(/,
    reason: 'direct analysis-sandbox execution',
  },
  {
    pattern: /\b(?:name|tool|toolName)\s*:\s*['"]run_analysis['"]/i,
    reason: 'run_analysis tool declaration',
  },
  {
    pattern:
      /\b(?:allowedTools|exposedTools|tools|toolNames|capabilities|registry)\b\s*[:=][\s\S]{0,600}?['"]run_analysis['"]/i,
    reason: 'run_analysis tool-surface registration',
  },
  {
    pattern: /\b(?:execute|invoke|callTool|runTool)\s*\([\s\S]{0,300}?['"]run_analysis['"]/i,
    reason: 'run_analysis tool execution',
  },
  {
    pattern: /\bcase\s*['"]run_analysis['"]\s*:/i,
    reason: 'run_analysis dispatch branch',
  },
];

const FORBIDDEN_ENDPOINT =
  /\/(?:api\/clio\/v3\/visual-analysis|meri-api\/tools\/run_analysis\/invoke)\b/i;

/**
 * Remove JavaScript/TypeScript comments without changing strings or line
 * positions. The guard therefore ignores policy prose while still inspecting
 * URLs and module specifiers inside string and template literals.
 */
export function stripComments(source) {
  let output = '';
  let state = 'code';
  let quote = '';

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      if (char === '\n') {
        output += '\n';
        state = 'code';
      } else {
        output += ' ';
      }
      continue;
    }

    if (state === 'block-comment') {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        state = 'code';
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }

    if (state === 'string') {
      output += char;
      if (char === '\\' && index + 1 < source.length) {
        output += source[index + 1];
        index += 1;
      } else if (char === quote) {
        state = 'code';
        quote = '';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      output += '  ';
      index += 1;
      state = 'line-comment';
    } else if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      state = 'block-comment';
    } else {
      output += char;
      if (char === "'" || char === '"' || char === '`') {
        state = 'string';
        quote = char;
      }
    }
  }

  return output;
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

function collectUniqueConstInitializers(sourceFile) {
  const initializers = new Map();
  const ambiguous = new Set();

  function visit(node) {
    if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Const) !== 0) {
      for (const declaration of node.declarations) {
        if (ts.isIdentifier(declaration.name) && declaration.initializer) {
          const name = declaration.name.text;
          if (initializers.has(name)) {
            ambiguous.add(name);
          } else {
            initializers.set(name, declaration.initializer);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  for (const name of ambiguous) {
    initializers.delete(name);
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

function staticStringEvaluator(initializers) {
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
    if (ts.isIdentifier(expression) && initializers.has(expression.text)) {
      const name = expression.text;
      if (cache.has(name)) {
        return cache.get(name);
      }
      if (resolving.has(name)) {
        return undefined;
      }
      const value = evaluate(initializers.get(name), new Set(resolving).add(name));
      cache.set(name, value);
      return value;
    }
    return undefined;
  }

  return evaluate;
}

function staticTextEvaluator(initializers) {
  const unknown = '\0';

  function evaluate(node, resolving = new Set()) {
    const expression = unwrapExpression(node);
    if (ts.isStringLiteralLike(expression)) {
      return expression.text;
    }
    if (
      ts.isBinaryExpression(expression) &&
      expression.operatorToken.kind === ts.SyntaxKind.PlusToken
    ) {
      return evaluate(expression.left, resolving) + evaluate(expression.right, resolving);
    }
    if (ts.isTemplateExpression(expression)) {
      let value = expression.head.text;
      for (const span of expression.templateSpans) {
        value += evaluate(span.expression, resolving) + span.literal.text;
      }
      return value;
    }
    if (ts.isIdentifier(expression) && initializers.has(expression.text)) {
      if (resolving.has(expression.text)) {
        return unknown;
      }
      return evaluate(initializers.get(expression.text), new Set(resolving).add(expression.text));
    }
    return unknown;
  }

  return evaluate;
}

function isImportCall(node) {
  return (
    node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    (ts.isIdentifier(node.expression) && node.expression.text === 'require')
  );
}

function isKnownMap(node, initializers, resolving = new Set()) {
  const expression = unwrapExpression(node);
  if (
    ts.isNewExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'Map'
  ) {
    return true;
  }
  if (ts.isIdentifier(expression) && initializers.has(expression.text)) {
    if (resolving.has(expression.text)) {
      return false;
    }
    return isKnownMap(
      initializers.get(expression.text),
      initializers,
      new Set(resolving).add(expression.text),
    );
  }
  return false;
}

function terminalPropertyName(node) {
  const expression = unwrapExpression(node);
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return expression.name.text;
  }
  return undefined;
}

export function inspectSource(source, file = '<source>') {
  const code = stripComments(source);
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const initializers = collectUniqueConstInitializers(sourceFile);
  const evaluateStaticString = staticStringEvaluator(initializers);
  const evaluateStaticText = staticTextEvaluator(initializers);
  const violations = [];
  const seen = new Set();

  function addViolation(node, reason) {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
    const key = `${line}:${reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      violations.push({ file, line, reason });
    }
  }

  function inspectModuleSpecifier(node, expression) {
    const value = evaluateStaticString(expression);
    if (value === undefined) {
      return;
    }
    const normalized = value.replaceAll('\\', '/');
    for (const rule of FORBIDDEN_MODULES) {
      if (rule.pattern.test(normalized)) {
        addViolation(node, rule.reason);
      }
    }
  }

  function visit(node) {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      inspectModuleSpecifier(node.moduleSpecifier, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression
    ) {
      inspectModuleSpecifier(node, node.moduleReference.expression);
    } else if (ts.isCallExpression(node) && isImportCall(node) && node.arguments[0]) {
      inspectModuleSpecifier(node, node.arguments[0]);
    }

    if (ts.isExpression(node)) {
      if (FORBIDDEN_ENDPOINT.test(evaluateStaticText(node))) {
        addViolation(node, 'visual-analysis execution endpoint');
      }
    }

    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'set' &&
      node.arguments[0] &&
      evaluateStaticString(node.arguments[0])?.toLowerCase() === 'run_analysis'
    ) {
      const registry = node.expression.expression;
      if (
        terminalPropertyName(registry)?.toLowerCase() === 'registry' ||
        isKnownMap(registry, initializers)
      ) {
        addViolation(node, 'run_analysis tool-surface registration');
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);

  for (const rule of FORBIDDEN_CODE) {
    const match = rule.pattern.exec(code);
    if (match) {
      const line = lineAt(code, match.index);
      const key = `${line}:${rule.reason}`;
      if (!seen.has(key)) {
        seen.add(key);
        violations.push({ file, line, reason: rule.reason });
      }
    }
  }

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
  return files;
}

export function verifyRepository(repositoryRoot) {
  const files = TARGET_ROOTS.flatMap((root) =>
    productionSourceFiles(resolve(repositoryRoot, root)),
  );
  const violations = files.flatMap((file) =>
    inspectSource(readFileSync(file, 'utf8'), relative(repositoryRoot, file).split(sep).join('/')),
  );
  return { files, violations };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  const repositoryRoot = resolve(dirname(scriptPath), '..', '..');
  const { files, violations } = verifyRepository(repositoryRoot);
  if (violations.length > 0) {
    for (const violation of violations) {
      console.error(`${violation.file}:${violation.line}: ${violation.reason}`);
    }
    console.error(
      'MeriV3 visual-analysis service, tool, and sandbox execution must remain isolated from Workspace, Strategy, and Intel.',
    );
    process.exitCode = 1;
  } else {
    console.log(
      `MeriV3 visual-analysis isolation guard passed (${files.length} production files).`,
    );
  }
}
