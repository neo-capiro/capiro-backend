import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
    pattern: /\/(?:api\/clio\/v3\/visual-analysis|meri-api\/tools\/run_analysis\/invoke)\b/i,
    reason: 'visual-analysis execution endpoint',
  },
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

function moduleSpecifiers(code) {
  const specifiers = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\b(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) {
      specifiers.push({ value: match[1], index: match.index ?? 0 });
    }
  }
  return specifiers;
}

function lineAt(source, index) {
  return source.slice(0, index).split('\n').length;
}

export function inspectSource(source, file = '<source>') {
  const code = stripComments(source);
  const violations = [];

  for (const specifier of moduleSpecifiers(code)) {
    const normalized = specifier.value.replaceAll('\\', '/');
    for (const rule of FORBIDDEN_MODULES) {
      if (rule.pattern.test(normalized)) {
        violations.push({ file, line: lineAt(code, specifier.index), reason: rule.reason });
      }
    }
  }

  for (const rule of FORBIDDEN_CODE) {
    const match = rule.pattern.exec(code);
    if (match) {
      violations.push({ file, line: lineAt(code, match.index), reason: rule.reason });
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
