/**
 * CleanUp1 §6.2 — script entry-point discovery (runtime-generated, no checked-in list).
 *
 * Classifies each script file as:
 *   - "entrypoint": a runnable command — has a top-level executable statement,
 *      OR is a package.json-declared command target.
 *   - "module":     a file whose top level is ONLY declarations/imports/exports.
 *   - "test":       a *.spec.* / *.test.* file (owned by the unit runners).
 *   - "unsafe":     a top-level entry point whose static body performs
 *                   destructive host/cloud mutations; surfaced as an explicit
 *                   failure packet, never silently skipped.
 *   - "undiscovered-declared": a package.json-declared command whose target is
 *                   missing, or resolves outside the walked script scope
 *                   (excluded/build/spec tree). NEVER silently dropped.
 *
 * Fail-closed rules:
 *   - A file is "module" ONLY when proven to have no top-level execution. Any
 *     uncertainty — malformed source, an unsupported construct — is treated as
 *     an entry point (`unsupported` obligation), never as a safe module.
 *   - Literal awareness: comments, string/template literals are stripped BEFORE
 *     brace counting and statement classification, so a `{`/`(` inside a string
 *     cannot hide a later top-level call.
 *   - A `const/let/var` declaration with an initializer that performs a call
 *     (`const x = run()`) is executable — it is not a pure declaration.
 *   - `.js` files are discovered (a package-declared JavaScript command must not
 *     disappear).
 *   - Every package.json-declared script target across the workspace is
 *     resolved; a declared target that is missing or out-of-scope is emitted as
 *     an explicit packet, never dropped.
 */
import { readFileSync, readdirSync, statSync, existsSync, lstatSync } from 'node:fs';
import { join, relative, sep, dirname, resolve, isAbsolute } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

/**
 * Real parser for effect classification. The previous line/regex scanner
 * classified `const x = 1; run();`, `import fs from 'node:fs'; run();`, a
 * template-interpolation initializer and malformed `export const x = ;` as
 * `declarations-only`. Root smoke review round 2 reproduced that; the fix is a
 * genuine parse. We prefer the workspace TypeScript parser (an existing
 * dependency); if it is genuinely unavailable we FAIL CLOSED through a
 * conservative scanner rather than silently classifying as a safe module.
 */
const require = createRequire(import.meta.url);
let TS = null;
try {
  TS = require('typescript');
} catch {
  TS = null;
}
export const astParserAvailable = () => TS != null;

function scriptKindFor(name) {
  return /\.(mjs|cjs|js)$/.test(name) ? TS.ScriptKind.JS : TS.ScriptKind.TS;
}

/**
 * SyntaxKinds whose BODIES are deferred: they are not evaluated merely because
 * the declaration that contains them is. `() => run()`, `function () { run() }`
 * and a method/getter/setter/constructor body are declarations, not
 * definition-time work.
 */
const DEFERRED_BODY_KINDS = new Set(
  (TS
    ? [
        TS.SyntaxKind.FunctionExpression,
        TS.SyntaxKind.ArrowFunction,
        TS.SyntaxKind.FunctionDeclaration,
        TS.SyntaxKind.MethodDeclaration,
        TS.SyntaxKind.GetAccessor,
        TS.SyntaxKind.SetAccessor,
        TS.SyntaxKind.Constructor,
        TS.SyntaxKind.ConstructorDeclaration,
      ]
    : []
  ).filter((k) => typeof k === 'number'),
);

/**
 * Assignment operators. Assigning or mutating is an EVALUATION-TIME effect even
 * when both operands are otherwise pure (`obj.value = 1`, `a ??= b`): it is not
 * a pure declaration and must never yield a `declarations-only` verdict.
 */
const ASSIGN_TOKEN_KINDS = new Set(
  (TS
    ? [
        TS.SyntaxKind.EqualsToken,
        TS.SyntaxKind.PlusEqualsToken,
        TS.SyntaxKind.MinusEqualsToken,
        TS.SyntaxKind.AsteriskEqualsToken,
        TS.SyntaxKind.AsteriskAsteriskEqualsToken,
        TS.SyntaxKind.SlashEqualsToken,
        TS.SyntaxKind.PercentEqualsToken,
        TS.SyntaxKind.LessThanLessThanEqualsToken,
        TS.SyntaxKind.GreaterThanGreaterThanEqualsToken,
        TS.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
        TS.SyntaxKind.AmpersandEqualsToken,
        TS.SyntaxKind.BarEqualsToken,
        TS.SyntaxKind.CaretEqualsToken,
        TS.SyntaxKind.BarBarEqualsToken,
        TS.SyntaxKind.AmpersandAmpersandEqualsToken,
        TS.SyntaxKind.QuestionQuestionEqualsToken,
      ]
    : []
  ).filter((k) => typeof k === 'number'),
);

/** Prefix/postfix `++`/`--`: a mutation effect at evaluation time. */
const UPDATE_TOKEN_KINDS = new Set(
  (TS ? [TS.SyntaxKind.PlusPlusToken, TS.SyntaxKind.MinusMinusToken] : []).filter(
    (k) => typeof k === 'number',
  ),
);

/**
 * Does evaluating `node` (a class DECLARATION or class EXPRESSION) perform work
 * at CLASS-DEFINITION time?
 *
 * Definition-time effects:
 *   - a decorator on the class or on any member;
 *   - an `extends` HERITAGE expression that performs work (`extends factory()`),
 *     which runs while the class definition is evaluated;
 *   - a COMPUTED member name (`[k()]`, `[k()]() {}`, `[k()] = v`) — the key
 *     expression is evaluated while the class is defined, static or instance;
 *   - any `static { ... }` block (it runs at definition);
 *   - a `static` property initializer that performs work.
 *
 * Deferred (NOT definition-time): instance property initializers (they run at
 * construction), and every method/getter/setter/constructor body.
 */
function classDefinitionExecutes(node) {
  const K = TS.SyntaxKind;
  if (!node) return false;
  if ((node.modifiers || []).some((m) => m.kind === K.Decorator)) return true;
  // The class HERITAGE expression is evaluated while the class definition is
  // evaluated: `class C extends factory() {}` CALLS `factory()` at definition
  // time (as does a class expression `const C = class extends factory() {}`).
  // Only `extends` executes — an `implements` clause is type-only/erased.
  for (const h of node.heritageClauses || []) {
    if (!h || h.token !== K.ExtendsKeyword) continue;
    for (const t of h.types || []) {
      if (t && t.expression && expressionPerformsWork(t.expression)) return true;
    }
  }
  for (const m of node.members || []) {
    if (!m) continue;
    if ((m.modifiers || []).some((x) => x.kind === K.Decorator)) return true;
    if (m.name && m.name.kind === K.ComputedPropertyName && expressionPerformsWork(m.name.expression)) return true;
    if (m.kind === K.ClassStaticBlockDeclaration) return true;
    if (m.kind === K.PropertyDeclaration) {
      const isStatic = (m.modifiers || []).some((x) => x.kind === K.StaticKeyword);
      if (isStatic && m.initializer && expressionPerformsWork(m.initializer)) return true;
    }
  }
  return false;
}

/**
 * True iff evaluating `node` performs work at evaluation time — a
 * call/new/await/tagged-template, a definition-time class effect (including an
 * executable `extends` heritage), a mutation effect (assignment / compound
 * assignment / prefix-postfix ++/-- / delete), or any such work inside an
 * object/array/template literal or a computed key.
 *
 * Matching is by NUMERIC SyntaxKind: TypeScript aliases several kinds to the
 * same enum value (e.g. `SyntaxKind.VariableStatement === SyntaxKind.FirstStatement`),
 * and `SyntaxKind[kind]` returns only the FIRST name, so name-string switches
 * silently miss real statements. Compare against the enum constants directly.
 *
 * Deferred bodies (function/arrow/method/get/set) are NOT descended into — but
 * a COMPUTED member name on such a body IS evaluated while the enclosing
 * object/class is defined, so only the name expression is visited. A class
 * delegates to `classDefinitionExecutes`, so a class expression with a static
 * initializer/block (or an executable heritage) is correctly seen as executing —
 * the previous implementation listed ClassExpression as deferred and so HID
 * those effects (e.g. `export default class { static x = work(); }`).
 */
function expressionPerformsWork(node) {
  const K = TS.SyntaxKind;
  let found = false;
  const visit = (n) => {
    if (!n || found) return;
    if (DEFERRED_BODY_KINDS.has(n.kind)) {
      // A deferred BODY (function/arrow/method/get/set/constructor) is not
      // definition-time work — but a COMPUTED member name is evaluated while the
      // enclosing object/class is defined (`{ [key()]() {} }`,
      // `class C { get [key()]() {} }`). Evaluate ONLY the name expression, never
      // the deferred body or its parameter defaults.
      if (n.name && n.name.kind === K.ComputedPropertyName && expressionPerformsWork(n.name.expression)) {
        found = true;
      }
      return;
    }
    if (n.kind === K.ClassExpression || n.kind === K.ClassDeclaration) {
      if (classDefinitionExecutes(n)) found = true;
      return;
    }
    if (
      n.kind === K.CallExpression ||
      n.kind === K.NewExpression ||
      n.kind === K.AwaitExpression ||
      n.kind === K.TaggedTemplateExpression
    ) {
      found = true;
      return;
    }
    // Mutation effects at evaluation time. An assignment / compound assignment
    // (`obj.value = 1`, `a ??= b`), a prefix/postfix update (`++n`, `n--`) or a
    // `delete` is work even when its operands are otherwise pure.
    if (n.kind === K.BinaryExpression && ASSIGN_TOKEN_KINDS.has(n.operatorToken?.kind)) {
      found = true;
      return;
    }
    if (
      (n.kind === K.PrefixUnaryExpression || n.kind === K.PostfixUnaryExpression) &&
      UPDATE_TOKEN_KINDS.has(n.operator)
    ) {
      found = true;
      return;
    }
    if (n.kind === K.DeleteExpression) {
      found = true;
      return;
    }
    TS.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * Classify a (non-ambient) namespace/module body. A `declare namespace` is a
 * pure ambient declaration. Otherwise the body's OWN top-level statements are
 * classified: any execution makes the namespace executing; a body that is
 * declarations only is a helper. An unsupported inner construct fails closed.
 */
function classifyNamespace(node) {
  const K = TS.SyntaxKind;
  if ((node.modifiers || []).some((m) => m.kind === K.DeclareKeyword)) return 'declaration';
  const body = node.body;
  if (!body) return 'declaration';
  const stmts = body.kind === K.ModuleBlock ? body.statements : [body];
  let unsupported = false;
  for (const st of stmts) {
    const r = classifyStatement(st);
    if (r === 'execution') return 'execution';
    if (r === 'unsupported') unsupported = true;
  }
  return unsupported ? 'unsupported' : 'declaration';
}

function classifyStatement(node) {
  const K = TS.SyntaxKind;
  switch (node.kind) {
    case K.ImportDeclaration:
    case K.ImportEqualsDeclaration:
    case K.InterfaceDeclaration:
    case K.TypeAliasDeclaration:
    case K.FunctionDeclaration:
    case K.ExportDeclaration:
      return 'declaration';
    case K.ClassDeclaration:
    case K.ClassExpression:
      // A class can EXECUTE at definition time: a decorator, a computed member
      // name, a static block or a static initializer performs work. Instance
      // field initializers and every method body are deferred. (The previous
      // implementation treated ALL property initializers as executing and
      // missed decorators / computed names.)
      return classDefinitionExecutes(node) ? 'execution' : 'declaration';
    case K.EnumDeclaration: {
      // Enum member initializers can call (`enum E { A = f() }`). A constant
      // initializer (literal / reference) is a pure declaration.
      for (const m of node.members || []) {
        if (m && m.initializer && expressionPerformsWork(m.initializer)) return 'execution';
      }
      return 'declaration';
    }
    case K.ModuleDeclaration:
      // Ambient (declare) namespaces are pure; a non-ambient namespace body is
      // classified by its own statements (pure consts -> helper, execution ->
      // entrypoint). This is NO LONGER blanket-unsupported.
      return classifyNamespace(node);
    case K.ExportAssignment:
      // `export default <expr>` / `export = <expr>`; an executable default
      // (e.g. `run()`, or a class with static effects) runs at load.
      return node.expression && expressionPerformsWork(node.expression) ? 'execution' : 'declaration';
    case K.VariableStatement: {
      for (const decl of node.declarationList.declarations) {
        // Destructuring defaults and computed keys are evaluated when this
        // declaration runs; function parameter defaults remain deferred.
        if (expressionPerformsWork(decl.name)) return 'execution';
        if (decl.initializer && expressionPerformsWork(decl.initializer)) return 'execution';
      }
      return 'declaration';
    }
    case K.ExpressionStatement: {
      const expr = node.expression;
      if (!expr) return 'declaration';
      // A bare literal statement ("use strict";) does nothing.
      if (expr.kind === K.StringLiteral || expr.kind === K.NoSubstitutionTemplateLiteral || expr.kind === K.NumericLiteral) {
        return 'declaration';
      }
      return 'execution';
    }
    default:
      // Return/throw/with/labeled/debugger/etc. at module top level is
      // unexpected — treat as an unsupported construct and fail closed.
      return 'unsupported';
  }
}

function classifyWithTs(text, name) {
  const sf = TS.createSourceFile(name, text, TS.ScriptTarget.Latest, /*setParentNodes*/ true, scriptKindFor(name));
  if ((sf.parseDiagnostics?.length ?? 0) > 0) return { executable: true, certainty: 'unsupported' };
  let sawExecution = false;
  let sawUnsupported = false;
  for (const stmt of sf.statements) {
    const r = classifyStatement(stmt);
    if (r === 'execution') sawExecution = true;
    else if (r === 'unsupported') sawUnsupported = true;
  }
  if (sawExecution) return { executable: true, certainty: 'execution' };
  if (sawUnsupported) return { executable: true, certainty: 'unsupported' };
  return { executable: false, certainty: 'declarations-only' };
}

/** Prefer the real AST parse; fail closed to the conservative scanner. */
export function classifyTopLevel(text, name = 'script.ts') {
  if (TS) {
    try {
      return classifyWithTs(text, name);
    } catch {
      // A parser blow-up is never a safe-module verdict.
      return { executable: true, certainty: 'unsupported' };
    }
  }
  return classifyTopLevelFallback(text);
}

/**
 * Excluded directories. CleanUp1 §6.2 names ONLY `lib`, `__tools__` and
 * `__data__` (plus `*.spec.*`/`*.test.*`, handled separately). `node_modules`,
 * `.git`, `dist` and `generated` are non-source VCS/build trees; `fixtures` is
 * this harness's OWN fixture dir, which must not self-recurse as smoke subjects.
 * Each entry carries a current-source rationale — there is NO blanket
 * `__incoming__`/`__snapshots__` exclusion.
 */
export const EXCLUDED_DIRS = new Set([
  'lib',
  '__tools__',
  '__data__',
  'node_modules',
  '.git',
  'dist',
  'generated',
  'fixtures',
]);

const DESTRUCTIVE_PATTERNS = [
  /\brmSync\b/, /\brmdirSync\b/, /\bunlinkSync\b/, /\brm\s+-rf\b/,
  /\bwriteFileSync\b/, /\bappendFileSync\b/, /\bcreateWriteStream\b/, /\bmkdirSync\b/,
  /\brenameSync\b/, /\bcpSync\b/, /\bexecSync\b/,
  /DROP\s+DATABASE/i, /TRUNCATE\s+TABLE/i, /prisma\s+migrate\s+(deploy|reset|dev)/i,
  /\bdeleteMany\b/, /aws\s+ecs\s+update-service/i, /aws\s+s3\s+(rm|sync)\b/i,
  /\btf\s+(apply|destroy)\b/i, /cdk\s+deploy/i, /stripe\s+.*--live/i, /\bsendMail\b|\bsend-email\b/,
];

/**
 * Fail-closed boundary patterns for the NO-PARSER fallback. `enum`, `namespace`
 * and `module` are deliberately NOT here: unlike a type/interface/ambient
 * `declare`, they CAN execute at load (enum member initializers, a namespace
 * body, a module block). Treating them as blanket-pure was a helper-verdict
 * relaxation; below they fall through to the unrecognised-statement fail-closed
 * branch instead.
 */
const DECL_PURE = /^(?:type|interface|declare|export\s+(?:type|interface|declare))\b/;
const IMPORT = /^(?:import\b|export\s+(?:\*\s*from|\{[^}]*\}\s*from)|export\s*\{[^}]*\}\s*(?:from.*)?;?)/;
const FUNC_DECL = /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\b/;
const VAR_DECL = /^(?:export\s+)?(?:const|let|var)\b/;
const EXEC_START = /^(?:\(|\[|await\b|void\b|if\b|for\b|while\b|switch\b|throw\b|try\b|return\b|do\b|new\b|delete\b|typeof\b|\+\+|--)/;
const IDENT_CALL = /^(?:[A-Za-z_$][\w$]*)(?:\??\.[A-Za-z_$][\w$]*|\[[^\]]*\])*\s*(?:\(|`)/;
const ASSIGN = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\])*\s*(?:[+\-*/%]|&&|\|\||\?\?)?=\s*(?!=)/;

/**
 * Strip comments and string/template literals, replacing their bodies with
 * spaces (newlines preserved) so downstream counting never sees a brace/paren
 * that lives inside a literal. Best-effort, fail-closed: an unterminated literal
 * leaves the source visibly unbalanced, which the caller treats as unsupported.
 */
export function stripLiterals(text) {
  const src = String(text);
  let out = '';
  let i = 0;
  let state = 'code'; // code | line | block | squote | dquote | template
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; out += '  '; i += 2; continue; }
      if (c === '/' && n === '*') { state = 'block'; out += '  '; i += 2; continue; }
      if (c === "'") { state = 'squote'; out += ' '; i++; continue; }
      if (c === '"') { state = 'dquote'; out += ' '; i++; continue; }
      if (c === '`') { state = 'template'; out += ' '; i++; continue; }
      out += c; i++; continue;
    }
    if (state === 'line') {
      if (c === '\n') { state = 'code'; out += '\n'; i++; continue; }
      out += ' '; i++; continue;
    }
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; out += '  '; i += 2; continue; }
      out += c === '\n' ? '\n' : ' '; i++; continue;
    }
    // string states
    if (c === '\\') { out += '  '; i += 2; continue; }
    const closing = state === 'squote' ? "'" : state === 'dquote' ? '"' : '`';
    if (c === closing) { state = 'code'; out += ' '; i++; continue; }
    out += c === '\n' ? '\n' : ' '; i++; continue;
  }
  return out;
}

function updateDepth(line, depth) {
  let d = depth;
  for (const ch of line) {
    if (ch === '{' || ch === '(' || ch === '[') d++;
    else if (ch === '}' || ch === ')' || ch === ']') d = Math.max(0, d - 1);
  }
  return d;
}

/** True if a top-level `const/let/var ...[= init]` initializer performs work. */
function varInitializerExecutes(line) {
  const eq = line.indexOf('=');
  if (eq < 0) return false; // bare declaration, no initializer
  const init = line.slice(eq + 1).trim();
  if (!init) return false;
  // A pure function / arrow literal is a declaration, not execution — UNLESS it
  // is immediately invoked (`(() => {...})()`, `(function(){})()`).
  if (/^(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.test(init)) {
    return /\)\s*\(/.test(init);
  }
  // A class literal may execute at DEFINITION (static block, static
  // initializer, decorator, computed key); from a single line we cannot cheaply
  // prove purity, so fail closed as execution rather than issue a helper
  // verdict.
  if (/^class\b/.test(init)) return true;
  // Any call in the initializer (`run()`, `new Foo()`, `x.map(f)`) is execution.
  if (IDENT_CALL.test(init) || /\bnew\b/.test(init) || /\)\s*\(/.test(init)) return true;
  // A call reachable anywhere in the initializer — a computed object key /
  // method / getter / setter (`{ [key()]() {} }`) — executes while the literal
  // is evaluated.
  if (/[\w$)\]]\s*\(/.test(init)) return true;
  // Mutation effects: `delete`, a ++/-- update, or an assignment / compound
  // assignment (`obj.value = 1`, `a ??= b`) is work even with pure operands.
  if (/\bdelete\b/.test(init)) return true;
  if (/\+\+|--/.test(init)) return true;
  if (/(?:^|[^=!<>+\-*/%&|^?])=(?!=)/.test(init)) return true;
  return false;
}

/**
 * Conservative classification. Returns { executable, certainty } where
 * certainty is 'execution' | 'declarations-only' | 'unsupported'. Unsupported
 * (malformed/unbalanced/unknown) is treated as executable (fail closed).
 */
function classifyTopLevelFallback(text) {
  const s = stripLiterals(text);
  const lines = s.split('\n');
  // Malformed / unbalanced source is unsupported -> fail closed as executable.
  let total = 0;
  for (const l of lines) total = updateDepth(l, total);
  if (total !== 0) return { executable: true, certainty: 'unsupported' };
  if (s.includes('\u0000')) return { executable: true, certainty: 'unsupported' };

  let depth = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (depth === 0 && line) {
      if (IMPORT.test(line)) { depth = updateDepth(raw, depth); continue; }
      if (DECL_PURE.test(line)) { depth = updateDepth(raw, depth); continue; }
      // Functions are genuinely pure. A `class`/`enum`/`namespace` line is NOT
      // assumed pure here — it can execute at definition — so it falls through
      // to the unrecognised-statement fail-closed branch below.
      if (FUNC_DECL.test(line)) { depth = updateDepth(raw, depth); continue; }
      if (VAR_DECL.test(line)) {
        if (varInitializerExecutes(line)) return { executable: true, certainty: 'execution' };
        depth = updateDepth(raw, depth);
        continue;
      }
      if (EXEC_START.test(line)) return { executable: true, certainty: 'execution' };
      if (IDENT_CALL.test(line)) return { executable: true, certainty: 'execution' };
      if (ASSIGN.test(line)) return { executable: true, certainty: 'execution' };
      // An unrecognised top-level statement: do not assume it is a safe module.
      if (/[A-Za-z_$]/.test(line)) return { executable: true, certainty: 'unsupported' };
    }
    depth = updateDepth(raw, depth);
  }
  return { executable: false, certainty: 'declarations-only' };
}

/** Backward-compatible boolean view over classifyTopLevel. */
export function topLevelExecutable(text, name = 'script.ts') {
  return classifyTopLevel(text, name).executable;
}

function isExcludedDir(name) {
  return EXCLUDED_DIRS.has(name);
}

function walk(dir, out = [], opts = {}) {
  const {
    match = (name) => /\.(ts|mjs|cjs|js)$/.test(name) && !/\.d\.ts$/.test(name),
    maxDepth = Infinity,
    depth = 0,
  } = opts;
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (isExcludedDir(name) || depth + 1 > maxDepth) continue;
      walk(p, out, { match, maxDepth, depth: depth + 1 });
    } else if (match(name)) {
      out.push(p);
    }
  }
  return out;
}

function isTestFile(name) {
  return /\.(spec|test)\.(ts|mjs|cjs|js)$/.test(name);
}

/** Scan package manifests without reading their command contents. */
function scannedPackageJsons(rootDir) {
  const files = [];
  const rootPj = join(rootDir, 'package.json');
  if (existsSync(rootPj)) files.push(rootPj);
  const seen = new Set(files);
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (isExcludedDir(name)) continue;
      const p = join(dir, name);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(p);
      else if (name === 'package.json' && !seen.has(p)) {
        seen.add(p);
        files.push(p);
      }
    }
  }
  return files;
}

/** Only committed manifests define canonical source commands. An untracked
 * manifest elsewhere in the worktree is a provenance failure, not a command
 * whose contents may be relabelled as part of HEAD. Synthetic non-Git fixtures
 * retain their existing filesystem-only behavior, except for the Corepack
 * runtime cache that can be generated inside the Gitless archive stage. */
export function packageJsonInventory(rootDir) {
  const files = scannedPackageJsons(rootDir);
  const relOf = (file) => relative(rootDir, file).split(sep).join('/');
  const probe = spawnSync('git', ['-C', rootDir, 'rev-parse', '--is-inside-work-tree'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (probe.status !== 0 || String(probe.stdout).trim() !== 'true') {
    // run-smoke's git-archive stage has no .git, then Corepack may provision
    // its cache under /src. Retain the manifest as an explicit failure packet
    // without reading its commands or pretending its bytes came from HEAD.
    return {
      tracked: files.filter((file) => !relOf(file).startsWith('.corepack-home/')),
      untracked: files.filter((file) => relOf(file).startsWith('.corepack-home/')),
    };
  }
  const listed = spawnSync('git', ['-C', rootDir, 'ls-files', '--cached', '-z'], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
  });
  if (listed.status !== 0 || listed.error) {
    throw new Error(`cannot enumerate tracked manifest inputs: ${listed.error?.message ?? `git exit ${listed.status}`}`);
  }
  const trackedPaths = new Set(String(listed.stdout).split('\0').filter(Boolean));
  const tracked = [];
  const untracked = [];
  for (const file of files) {
    const rel = relOf(file);
    (trackedPaths.has(rel) ? tracked : untracked).push(file);
  }
  return { tracked, untracked };
}

/** Every committed workspace package.json, root first, discovered dynamically. */
export function packageJsons(rootDir) {
  return packageJsonInventory(rootDir).tracked;
}

// ─────────────────────────────────────────────────────────────────────────────
// Command-aware, conservative package-command TARGET resolver (discovery715).
//
// The previous resolver split every script body on whitespace, treated any token
// ending in a source extension as a repo file, and resolved it against the
// package dir with a fallback to the repo ROOT. That produced demonstrably wrong
// accounting (root-cli697 / root-cli696):
//   - `eslint src --ext .ts` yielded a fictitious `apps/api/.ts` file target
//     (a bare extension OPTION VALUE is not a file);
//   - `pnpm --filter @capiro/defense-api exec tsx --test ../../tests/*` resolved
//     the operand against the ROOT, not the filter-selected package cwd;
//   - test globs, `dist/` build outputs, runner configs, node_modules runner
//     binaries and real operational CLIs were all collapsed into one bucket.
//
// This resolver is COMMAND-AWARE and CONSERVATIVE. It NEVER executes a command
// string: it tokenises it (quote-aware), understands value-taking runner
// options, understands pnpm `--filter` / `-C` / `--dir` cwd context, and
// classifies every operand with an explicit source-based disposition. Dynamic /
// glob, escaping, symlinked and ambiguous operands stay explicitly UNRESOLVED.
// There are NO new dependencies and NO fixed package list — packages are
// discovered recursively exactly as before.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A source-ish extension that can denote an executable/config target. `.py` is
 * retained here so a declared Python command still RESOLVES and is dispositioned
 * (see the interpreter-aware `python-script` rule) — the reference is never
 * dropped. The `.py` suffix by itself does NOT put a subject in JS/TS smoke scope.
 */
const SOURCE_TARGET_EXT_RE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|sh|ps1|py)$/i;

/** A bare extension or comma-separated extension list (`.ts`, `.ts,.tsx`): NEVER a file target. */
const BARE_EXT_RE = /^\.[A-Za-z0-9]+(?:\s*,\s*\.[A-Za-z0-9]+)*$/;

/**
 * Recognised ACTUAL Python interpreters. A `.py` SUFFIX ALONE is never enough to
 * leave the JS/TS smoke scope: the operand must also be a RESOLVED regular file
 * launched by one of these (`python`, `python3`, a versioned `python3.11`, …).
 * A non-Python launcher (`tsx foo.py`) or any unknown/missing/dynamic/escaping/
 * symlinked/unresolved-context target stays an unresolved/failing or
 * conservative-operational operand — it is NEVER laundered into `python-script`.
 */
const PYTHON_INTERPRETER_RE = /^python(?:\d+(?:\.\d+)*)?$/;

/** A shell-glob / interpolation / character-class operand the resolver refuses. */
const DYNAMIC_RE = /[*?[\]{}]|\$\{|\$[A-Za-z_(]/;

/**
 * Options that CONSUME the following token as their VALUE — the operand must not
 * be misread as a file target (the demonstrated `eslint src --ext .ts` defect).
 * Options not listed are treated as boolean flags; an unknown operand therefore
 * remains visible rather than being silently consumed. Keys are lowercase.
 */
const VALUE_OPTIONS = new Set([
  '-c', '--config', '--config-file', '--ext', '-e', '--env', '--env-file',
  '-o', '--out', '--out-dir', '--outdir', '--outfile', '--out-file', '--output', '--output-file', '--outputfile',
  '--reporter', '--reporter-options', '--grep', '-t', '--test-name-pattern', '--test-path-pattern',
  '--testpathpattern', '--testpathignorepatterns', '--testnamepattern', '--test-timeout', '--testtimeout',
  '--hook-timeout', '--hooktimeout', '--schema', '--tsconfig', '-p', '--project', '--app', '--chamber', '--fy',
  '--artifact', '--command', '--workspace', '-w', '--filter', '-f', '--dir', '--root', '--cwd', '--prefix',
  '--max-workers', '--maxworkers', '--coverage-reporters', '--coveragereporters', '--coverage-reporter',
  '--coverage-directory', '--coveragedirectory', '--pool', '--pool-options', '--pooloptions', '--log-level',
  '--loglevel', '--mode', '--base', '--base-url', '--baseurl', '--target', '--since', '--port', '--host',
  '--require', '--loader',
]);

/** Test runners (own *.spec/*.test operands). `node-test` is `node/tsx --test`. */
const TEST_RUNNERS = new Set(['jest', 'vitest', 'playwright', 'mocha', 'c8', 'nyc', 'ava', 'tap', 'jasmine', 'node-test']);
/**
 * Build/tooling runners. `ts-node`/`ts-node-esm` are deliberately NOT here: a
 * `ts-node file.ts` operand is a general TS executable, not inherently a build
 * artifact. A build/synth tool that LAUNCHES a ts-node app (e.g. `cdk --app
 * "ts-node ..."`) conveys build ownership through its OUTER command context (see
 * `contextRunner`), never through the ts-node runner alone.
 */
const BUILD_RUNNERS = new Set(['tsc', 'nest', 'vite', 'cdk', 'prisma', 'turbo', 'webpack', 'rollup', 'esbuild', 'tsup', 'swc', 'tsdown']);
/** Shell interpreters. */
const SHELL_RUNNERS = new Set(['bash', 'sh', 'zsh', 'dash', 'pwsh', 'powershell', 'cmd']);
/**
 * JS/TS runtime launchers. A server operand may only be server-owned when it is
 * actually executed by one of these — a build/lint/test tool that operates on a
 * file named main/index/app must NOT hide it as a server.
 */
const RUNTIME_LAUNCHERS = new Set(['node', 'tsx', 'ts-node', 'ts-node-esm', 'bun', 'deno', 'nest']);
/** Package managers that introduce a nested command / cwd context. */
const PKG_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'npx', 'pnpx', 'bun', 'bunx', 'corepack', 'pnpm.cjs']);
/** File extensions that indicate an executable operand (used to record option values that ARE files). */
const EXEC_EXT_RE = SOURCE_TARGET_EXT_RE;

const baseName = (p) => String(p).split(/[\\/]/).pop();

/** Quote-aware shell tokeniser. Returns [{type:'word'|'op', value, quoted}]. No execution. */
export function tokenizeCommand(body) {
  const s = String(body);
  const out = [];
  let cur = '';
  let quoted = false;
  let quote = null;
  const push = () => {
    if (cur !== '' || quoted) out.push({ type: 'word', value: cur, quoted });
    cur = '';
    quoted = false;
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === quote) { quote = null; quoted = true; continue; }
      if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i++; quoted = true; continue; }
      cur += c; quoted = true; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') { push(); continue; }
    if (c === '"' || c === "'") { quote = c; quoted = true; continue; }
    if (c === '\\' && i + 1 < s.length) { cur += s[i + 1]; i++; quoted = true; continue; }
    if (c === '&' && s[i + 1] === '&') { push(); out.push({ type: 'op', value: '&&' }); i++; continue; }
    if (c === '|' && s[i + 1] === '|') { push(); out.push({ type: 'op', value: '||' }); i++; continue; }
    if (c === ';') { push(); out.push({ type: 'op', value: ';' }); continue; }
    if (c === '|') { push(); out.push({ type: 'op', value: '|' }); continue; }
    cur += c;
  }
  push();
  return out;
}

/** Split a script body into command segments (arrays of word tokens), quote-aware. */
export function splitCommandSegments(body) {
  const toks = tokenizeCommand(body);
  const segs = [];
  let cur = [];
  for (const t of toks) {
    if (t.type === 'op') { if (cur.length) segs.push(cur); cur = []; continue; }
    cur.push(t);
  }
  if (cur.length) segs.push(cur);
  return segs;
}

function isConfigRel(rel) {
  const b = baseName(String(rel));
  return /\.config\.(c?[jt]s|mjs|json)$/i.test(b) ||
    /^tsconfig[^/]*\.json$/i.test(b) ||
    /^(jest|vite|vitest|playwright|next|tailwind|postcss|eslint|babel|rollup|webpack)\.[^/]*\.(c?[jt]s|mjs)$/i.test(b);
}

function isTestRel(rel) {
  return /\.(spec|test)\.[cm]?[jt]sx?$/i.test(String(rel));
}

function isServerRel(rel) {
  if (!/\.(ts|tsx|mjs|cjs|js)$/i.test(String(rel))) return false;
  const b = baseName(String(rel));
  return /(^|[-._])(main|server|app|index)(\.[cm]?[jt]s)$/i.test(b) && /(^|\/)src\//.test(String(rel));
}

function isOutputRel(rel) {
  return String(rel).split('/').some((s) => s === 'dist' || s === 'build' || s === 'generated' || s === 'out' || s === '.turbo' || s === '.next');
}

/** §6.2 mandatory in-scope CLI roots: `apps/api/scripts/**` and root `scripts/*.mjs`. */
function isInScopeCliRel(rel) {
  const r = String(rel);
  if (r.startsWith('apps/api/scripts/')) return true;
  if (/^scripts\/[^/]+\.mjs$/.test(r)) return true;
  return false;
}

/** Coarse owner inferred from the package script NAME (build/synth/server/lint/cli). */
function scriptOwner(scriptName) {
  const s = String(scriptName ?? '');
  if (/^lint\b/.test(s)) return 'lint';
  if (/^(build|synth)\b/.test(s) || /:build$/.test(s) || /:synth$/.test(s)) return 'build';
  if (/^(start|dev)\b/.test(s) || /:start$/.test(s)) return 'server';
  return 'cli';
}

/**
 * Classify one positional operand with an explicit source-based disposition.
 * PURE: it uses only path shape + runner + the script NAME (never file contents),
 * so it does not execute command text and does not depend on the filesystem.
 *
 * `contextRunner` is the OUTER tool that launched this operand when it was nested
 * inside another command (e.g. the `cdk` in `cdk --app "ts-node ..."`). A build/
 * test tool context owns the operand it launches, so an inner `ts-node` app is
 * build-owned because `cdk` invoked it — never because every `ts-node` is a build
 * tool. Without an outer context the operand's own runner is authoritative.
 */
export function classifyDisposition({ rel, runner, scriptName, resolution, contextRunner }) {
  const relStr = String(rel ?? '');
  const segs = relStr.split('/').filter(Boolean);
  const run = String(runner ?? '').toLowerCase();
  const ctxRun = String(contextRunner ?? '').toLowerCase();
  const ownerRunner = ctxRun || run;
  // A target that EXISTS but is NOT a regular file (a directory named `*.py`, a
  // fifo/device/socket, ...) is NEVER a resolved source target: fail closed with
  // an explicit non-regular disposition BEFORE any language-owned / static /
  // shell / config classification can launder it (the demonstrated directory
  // `directory-named.py` was wrongly resolved as `python-script`).
  if (resolution === 'not-a-regular-file') {
    return { disposition: 'operational-cli', owner: runner, reason: 'declared target exists but is NOT a regular file (directory/fifo/device) — fail closed, never resolved as a source CLI' };
  }
  if (segs.includes('node_modules')) return { disposition: 'dependency-runner', owner: runner, reason: 'dependency/runner binary inside node_modules — not repository source' };
  if (isOutputRel(relStr)) return { disposition: 'generated-build-output', owner: runner, reason: 'generated build/output tree — requires build/source provenance; outside §6.2' };
  if (isTestRel(relStr) || segs.some((s) => s === 'test' || s === 'tests' || s === '__tests__')) {
    return { disposition: 'test-runner-target', owner: runner ?? 'test-runner', reason: 'spec/test operand owned by a configured native test runner' };
  }
  if (isConfigRel(relStr)) return { disposition: 'runner-config', owner: runner ?? 'runner', reason: 'runner/build config operand — not an executable CLI' };
  // Build/synth ownership comes from an ACTUAL build tool — the operand's own
  // runner, or the OUTER tool that launched it. It is NEVER inferred from a
  // `ts-node` runner or a script-name label (`build:*`).
  if (BUILD_RUNNERS.has(ownerRunner)) return { disposition: 'build-artifact', owner: contextRunner ?? runner ?? 'build', reason: 'build/synth tool operand — outside the §6.2 runtime scope' };
  if (SHELL_RUNNERS.has(run) || /\.(sh|ps1)$/i.test(relStr)) return { disposition: 'shell-script', owner: 'shell', reason: 'shell-script operand — outside the §6.2 TS runtime scope' };
  // A positional operand of an ACTUAL configured test runner is test-owned, even
  // when its filename is not *.spec/*.test: the runner's own configuration decides
  // the pattern, so the operand must not be executed as a standalone CLI.
  if (TEST_RUNNERS.has(ownerRunner)) return { disposition: 'test-runner-target', owner: contextRunner ?? runner ?? 'test-runner', reason: 'positional operand of a configured native test runner — not a standalone CLI' };
  if (scriptOwner(scriptName) === 'lint' || run === 'eslint') return { disposition: 'lint-target', owner: 'eslint', reason: 'lint operand — not an executable CLI' };
  if (segs.some((s) => s === 'lib' || s === '__tools__' || s === '__data__' || s === 'fixtures')) {
    return { disposition: 'excluded-tree', owner: runner, reason: 'designated §6.2 exclusion (lib/__tools__/__data__/fixtures) — outside the walked script scope' };
  }
  // Runtime server: requires a server-shaped OPERAND PATH executed by a JS runtime
  // launcher. A script-name label (`start:*`/`dev:*`) is NOT evidence — an unknown
  // operational CLI under a `start:*` script stays operational (physically
  // required), never suppressed as a server. Gating on a runtime launcher ALSO
  // keeps a non-server file named main/index/app from being hidden as a server when
  // it is actually run by a build/lint/test tool.
  if (isServerRel(relStr) && RUNTIME_LAUNCHERS.has(run)) return { disposition: 'runtime-server', owner: 'server', reason: 'runtime server entrypoint — explicit outside-§6.2 disposition, not smoke-executed' };
  if (resolution === 'missing') {
    return isInScopeCliRel(relStr)
      ? { disposition: 'missing-cli', owner: runner, reason: 'package.json-declared in-scope CLI target does not resolve to a file (§6.2 mandatory)' }
      : { disposition: 'unresolved-missing', owner: runner, reason: 'declared CLI target does not resolve to a file — fail closed regardless of the §6.2 roots' };
  }
  if (resolution === 'unresolved-context') {
    return { disposition: 'operational-cli', owner: runner, reason: 'declared CLI operand under an unresolved command context — fail closed, never resolved against a guessed directory' };
  }
  // Language-owned Python CLI: ONLY a RESOLVED regular `.py` source launched by an
  // ACTUAL recognised Python interpreter is eligible to sit outside the JS/TS
  // runtime scope. A `.py` SUFFIX ALONE is insufficient — `tsx foo.py`, an unknown
  // launcher, or a missing/dynamic/escaping/symlink/unresolved-context target all
  // fall through to the conservative `operational-cli` return below (which fails
  // closed when unresolved), never a laundered `python-script`.
  if (resolution === 'resolved' && /\.py$/i.test(relStr) && PYTHON_INTERPRETER_RE.test(run)) {
    return { disposition: 'python-script', owner: 'python-interpreter', reason: 'resolved Python source launched by an actual recognised Python interpreter — outside CleanUp1 §6.2 JS/TS runtime scope; native Python CLI, not smoke-executed' };
  }
  return { disposition: 'operational-cli', owner: runner, reason: 'package.json-declared executable CLI source' };
}

/** Default filesystem probe: symlinks are refused, an unreadable path is absent. */
function defaultStat(abs) {
  try {
    const ls = lstatSync(abs);
    if (ls.isSymbolicLink()) return { exists: true, isSymlink: true };
    return { exists: true, isFile: ls.isFile(), isDir: ls.isDirectory() };
  } catch {
    return { exists: false };
  }
}

/** Repo-relative path or null when the absolute path escapes the root. */
function safeRelFrom(root, abs) {
  const r = relative(root, abs);
  if (r.startsWith('..') || isAbsolute(r)) return null;
  return r.split(sep).join('/');
}

function looksLikeNestedCommand(s) {
  const w = tokenizeCommand(s).filter((t) => t.type === 'word');
  if (w.length < 2) return false;
  const first = baseName(w[0].value).toLowerCase();
  return PKG_MANAGERS.has(first) || TEST_RUNNERS.has(first) || BUILD_RUNNERS.has(first) || SHELL_RUNNERS.has(first) ||
    first === 'node' || first === 'tsx' || first === 'bun' || first === 'deno' || first === 'ts-node' || first === 'ts-node-esm';
}

function makeTargetRecord({ raw, quoted, role, cwd, cwdSource, runner, scriptName, root, stat, contextRunner = null, contextUnresolved = null }) {
  // The operand's EFFECTIVE invocation cwd, captured HERE where its true cwd is
  // known — never the outer `analyzeCommand.cwdRel`, because a nested
  // `--dir`/`--filter`/`--app`/`cd` command can run THIS operand in a DIFFERENT
  // directory than its parent segment. Repo-normalized slash path; the source
  // root is '.'. An unknown/escaping/dynamic command context is explicit null
  // (the existing `contextUnresolved` evidence is retained), never a guessed
  // directory.
  const cwdRel = contextUnresolved
    ? null
    : (() => {
        const cr = safeRelFrom(root, cwd);
        return cr === '' ? '.' : cr;
      })();
  const base = { token: raw, quoted, role, runner, cwdSource, cwdRel };
  // An operand under an unresolved command context (an unknown pnpm selector, a
  // dynamic/escaping cwd) is NEVER resolved against a guessed directory — it stays
  // an explicit unresolved operational operand and fails closed downstream.
  if (contextUnresolved) {
    return { ...base, resolution: 'unresolved-context', rel: null, contextUnresolved, ...classifyDisposition({ rel: null, runner, scriptName, resolution: 'unresolved-context', contextRunner }) };
  }
  if (DYNAMIC_RE.test(raw)) {
    const guess = safeRelFrom(root, resolve(cwd, raw)) ?? raw;
    return { ...base, resolution: 'dynamic', rel: guess, ...classifyDisposition({ rel: guess, runner, scriptName, resolution: 'dynamic', contextRunner }) };
  }
  const abs = isAbsolute(raw) ? raw : resolve(cwd, raw);
  const rel = safeRelFrom(root, abs);
  if (rel === null) return { ...base, resolution: 'escapes-root', rel: null, ...classifyDisposition({ rel: raw, runner, scriptName, resolution: 'escapes-root', contextRunner }) };
  const st = stat(abs);
  if (st.exists && st.isSymlink) return { ...base, resolution: 'symlink', rel, ...classifyDisposition({ rel, runner, scriptName, resolution: 'symlink', contextRunner }) };
  if (!st.exists) return { ...base, resolution: 'missing', rel, ...classifyDisposition({ rel, runner, scriptName, resolution: 'missing', contextRunner }) };
  // ONLY a regular file may resolve as a source target. A path that exists but is
  // NOT a regular file (a DIRECTORY named `*.py`, a fifo/device/socket) must NEVER
  // resolve — the previous `st.exists && !st.isSymlink` predicate laundered a
  // directory named `directory-named.py` into a resolved `python-script`. Fail
  // closed with an explicit non-regular resolution instead.
  if (st.isFile !== true) return { ...base, resolution: 'not-a-regular-file', rel, ...classifyDisposition({ rel, runner, scriptName, resolution: 'not-a-regular-file', contextRunner }) };
  return { ...base, resolution: 'resolved', rel, ...classifyDisposition({ rel, runner, scriptName, resolution: 'resolved', contextRunner }) };
}

/**
 * Analyse ONE command segment. Returns { runner, cwdRel, cwdSource, targets, ignored }.
 * A `target` is any operand the resolver treats as a file (positional, or a
 * value-taking option whose value is a real file such as a runner config); an
 * `ignored` entry records an operand deliberately NOT treated as a target
 * (`extension-value`, `option-value` non-file, `positional-non-source`).
 * Pure aside from the injected `stat` probe — command text is never executed.
 */
export function analyzeCommand({ command, words: wordsIn, packageName, packageDir, root, cwdDir, cwdSource = 'package', stat = defaultStat, packageDirByName = new Map(), scriptName, contextRunner = null, contextUnresolved: passedContext = null }) {
  const words = (wordsIn ?? tokenizeCommand(command)).filter((t) => t.type === 'word');
  const targets = [];
  const ignored = [];
  let cwd = cwdDir;
  let source = cwdSource;
  // An inherited unresolved context (e.g. a preceding `cd <dynamic>` segment) makes
  // every operand in this segment unresolved, so nothing is resolved against a
  // guessed directory.
  let contextUnresolved = passedContext;
  if (words.length === 0) return { runner: null, cwdRel: safeRelFrom(root, cwd), cwdSource: source, targets, ignored, contextUnresolved };

  let i = 0;
  let runner = words[0].value;
  if (PKG_MANAGERS.has(baseName(runner).toLowerCase())) {
    i = 1;
    let execAt = -1;
    while (i < words.length) {
      const w = words[i].value;
      const lw = w.toLowerCase();
      if (lw === '--filter' || lw === '-f' || lw.startsWith('--filter=')) {
        const val = lw.startsWith('--filter=') ? w.slice(w.indexOf('=') + 1) : (words[i + 1]?.value ?? '');
        // An exact, KNOWN package name selects that package's cwd. A pattern,
        // directory selector, negated selector or unknown name leaves the cwd
        // context explicitly UNRESOLVED (never a silent fall-back to the package
        // dir, which would resolve operands against the wrong directory).
        if (!val || DYNAMIC_RE.test(val) || val.includes('...') || val.startsWith('!')) {
          contextUnresolved = contextUnresolved ?? 'filter-pattern';
        } else {
          const dir = packageDirByName.get(val);
          if (dir) { cwd = dir; source = 'filter'; }
          else contextUnresolved = contextUnresolved ?? 'filter-unknown';
        }
        i += lw.startsWith('--filter=') ? 1 : 2;
        continue;
      }
      // `-C` is pnpm's short directory flag. NOTE: the previous code lowercased the
      // flag to `-c` and then compared it to `-C`, so `pnpm -C <dir> exec ...` was
      // silently ignored and resolved against the package dir. Accept `-C`/`-c`
      // and the long forms (with `=`), and fail the context closed if the directory
      // value is missing, dynamic or escaping.
      if (w === '-C' || lw === '-c' || lw === '--dir' || lw === '--prefix' || lw === '--cwd' || lw.startsWith('--dir=') || lw.startsWith('--prefix=') || lw.startsWith('--cwd=')) {
        const eq = w.indexOf('=');
        const hasEq = eq >= 0;
        const val = hasEq ? w.slice(eq + 1) : (words[i + 1]?.value ?? '');
        if (!val || val.startsWith('-')) {
          contextUnresolved = contextUnresolved ?? 'cwd-missing-value';
        } else if (DYNAMIC_RE.test(val) || safeRelFrom(root, resolve(cwd, val)) === null) {
          contextUnresolved = contextUnresolved ?? 'cwd-unresolved';
        } else {
          cwd = resolve(cwd, val); source = 'dir';
        }
        i += hasEq ? 1 : 2;
        continue;
      }
      if (lw === 'exec' || lw === 'dlx') { execAt = i + 1; break; }
      if (lw === 'run' || !w.startsWith('-')) return { runner: baseName(runner), cwdRel: safeRelFrom(root, cwd), cwdSource: source, targets, ignored, contextUnresolved };
      i++;
    }
    if (execAt < 0 || execAt >= words.length) return { runner: baseName(runner), cwdRel: safeRelFrom(root, cwd), cwdSource: source, targets, ignored, contextUnresolved };
    i = execAt;
    runner = words[i].value;
  }

  const hasTestFlag = words.some((t) => t.value === '--test' || t.value === '--test-only');
  const effRunner = hasTestFlag ? 'node-test' : baseName(runner);
  // A build tool that LAUNCHES a nested command conveys its build ownership to the
  // operand it launches (the `cdk --app "ts-node ..."` case) — without that outer
  // context the nested runner is authoritative.
  const nestedContextRunner = BUILD_RUNNERS.has(effRunner.toLowerCase()) ? effRunner : contextRunner;

  for (i = i + 1; i < words.length; i++) {
    const w = words[i].value;
    if (w.startsWith('-')) {
      if (w.includes('=')) continue;
      if (VALUE_OPTIONS.has(w.toLowerCase())) {
        const nxt = words[i + 1];
        if (nxt && !nxt.value.startsWith('-')) {
          if (nxt.quoted && looksLikeNestedCommand(nxt.value)) {
            const nested = analyzeCommand({ command: nxt.value, packageName, packageDir, root, cwdDir: cwd, cwdSource: source, stat, packageDirByName, scriptName, contextRunner: nestedContextRunner, contextUnresolved });
            targets.push(...nested.targets);
            ignored.push(...nested.ignored);
          } else if (BARE_EXT_RE.test(nxt.value)) {
            ignored.push({ token: nxt.value, quoted: nxt.quoted, role: 'extension-value', option: w });
          } else if (EXEC_EXT_RE.test(nxt.value)) {
            targets.push(makeTargetRecord({ raw: nxt.value, quoted: nxt.quoted, role: 'option-value', cwd, cwdSource: source, runner: effRunner, scriptName, root, stat, contextRunner: nestedContextRunner, contextUnresolved }));
          } else {
            ignored.push({ token: nxt.value, quoted: nxt.quoted, role: 'option-value', option: w });
          }
          i++;
          continue;
        }
      }
      continue;
    }
    if (BARE_EXT_RE.test(w)) { ignored.push({ token: w, role: 'extension-value' }); continue; }
    if (!SOURCE_TARGET_EXT_RE.test(w)) {
      if (words[i].quoted && looksLikeNestedCommand(w)) {
        const nested = analyzeCommand({ command: w, packageName, packageDir, root, cwdDir: cwd, cwdSource: source, stat, packageDirByName, scriptName, contextRunner: nestedContextRunner, contextUnresolved });
        targets.push(...nested.targets);
        ignored.push(...nested.ignored);
        continue;
      }
      ignored.push({ token: w, quoted: words[i].quoted, role: 'positional-non-source' });
      continue;
    }
    targets.push(makeTargetRecord({ raw: w, quoted: words[i].quoted, role: 'positional', cwd, cwdSource: source, runner: effRunner, scriptName, root, stat, contextRunner: nestedContextRunner, contextUnresolved }));
  }
  return { runner: effRunner, cwdRel: safeRelFrom(root, cwd), cwdSource: source, targets, ignored, contextUnresolved };
}

/**
 * Resolve EVERY package.json-declared command target across the workspace into
 * explicit per-operand records. Packages are discovered recursively (never a
 * fixed list). Returns { records, ignored, packageDirByName }.
 *
 * Each record carries: package, packageDir, script, scriptBody, reference,
 * command, token, role, runner, cwdSource, resolution
 * ('resolved'|'missing'|'dynamic'|'escapes-root'|'symlink'|'unresolved-context'|
 * 'not-a-regular-file'),
 * rel, disposition, owner, reason. Callers decide which dispositions are
 * smoke-critical.
 *
 * `ignored` retains the deliberately-NON-target option values (e.g. the bare
 * `--ext .ts` extension fragment, which is not a file) with their command and
 * reference, so option-value accounting is visible in the exported result instead
 * of being silently dropped.
 */
export function resolveDeclaredTargets(rootDir, opts = {}) {
  const stat = opts.stat ?? defaultStat;
  const packageDirByName = new Map();
  const manifests = [];
  const manifestInventory = packageJsonInventory(rootDir);
  for (const pj of manifestInventory.tracked) {
    let pkg;
    try {
      pkg = JSON.parse(readFileSync(pj, 'utf8'));
    } catch {
      continue;
    }
    const pkgDir = dirname(pj);
    manifests.push({ pkg, pkgDir });
    if (pkg.name) packageDirByName.set(pkg.name, pkgDir);
  }
  const records = [];
  const ignored = [];
  for (const pj of manifestInventory.untracked) {
    const rel = relative(rootDir, pj).split(sep).join('/');
    records.push({
      package: rel, packageDir: dirname(pj), script: '[untracked-manifest]',
      scriptBody: '', reference: `untracked-manifest:${rel}`, command: null,
      token: rel, role: 'manifest', runner: 'source-provenance',
      cwdSource: 'package', cwdRel: '.', resolution: 'untracked', rel,
      disposition: 'untracked-manifest', owner: 'source-provenance',
      reason: 'untracked package.json was present in the working tree but is not a committed source input',
    });
  }
  for (const { pkg, pkgDir } of manifests) {
    const packageName = pkg.name ?? relative(rootDir, pkgDir).split(sep).join('/');
    for (const [scriptName, body] of Object.entries(pkg.scripts ?? {})) {
      const reference = `${packageName}#${scriptName}`;
      // Cross-segment cwd context: a `cd <dir>` segment changes the cwd for the
      // FOLLOWING segments. The prior handoff CLAIMED this propagation but did not
      // implement it; here a valid relative `cd` propagates, while a dynamic or
      // root-escaping `cd` target leaves the context explicitly UNRESOLVED so later
      // operands are never silently resolved against the wrong directory.
      let segCwd = pkgDir;
      let segSource = 'package';
      let segContext = null;
      for (const seg of splitCommandSegments(body)) {
        const command = seg.map((t) => t.value).join(' ');
        const first = seg.length ? baseName(seg[0].value).toLowerCase() : '';
        if (first === 'cd') {
          const target = seg[1]?.value ?? '';
          if (!target || target.startsWith('-') || DYNAMIC_RE.test(target)) {
            segContext = segContext ?? 'cd-unresolved';
          } else {
            const abs = resolve(segCwd, target);
            if (safeRelFrom(rootDir, abs) === null) segContext = segContext ?? 'cd-escaping';
            else { segCwd = abs; segSource = 'cd'; }
          }
          continue;
        }
        const res = analyzeCommand({ command, words: seg, packageName, packageDir: pkgDir, root: rootDir, cwdDir: segCwd, cwdSource: segSource, stat, packageDirByName, scriptName, contextUnresolved: segContext });
        for (const t of res.targets) {
          records.push({ package: packageName, packageDir: pkgDir, script: scriptName, scriptBody: String(body), reference, command, ...t });
        }
        for (const ig of res.ignored) {
          ignored.push({ package: packageName, packageDir: pkgDir, script: scriptName, scriptBody: String(body), reference, command, ...ig });
        }
      }
    }
  }
  return { records, ignored, packageDirByName };
}

/**
 * Resolve package.json-declared script targets to repo-relative file paths.
 * Backward-compatible projection retained for existing callers.
 * Returns { declared: Map<rel, refs[]>, missing: [{token, package, script, packageDir}] }.
 * A declared CLI token that resolves to NO file — in-scope (missing-cli) OR
 * out-of-scope (unresolved-missing) — is reported in `missing`; never silently
 * dropped.
 */
export function declaredCommandTargets(rootDir) {
  const declared = new Map();
  const missing = [];
  const { records } = resolveDeclaredTargets(rootDir);
  for (const r of records) {
    if (r.resolution === 'resolved' && r.rel) {
      if (!declared.has(r.rel)) declared.set(r.rel, []);
      declared.get(r.rel).push(r.reference);
    } else if (r.disposition === 'missing-cli' || r.disposition === 'unresolved-missing') {
      missing.push({ token: r.token, package: r.package, script: r.script, packageDir: r.packageDir });
    }
  }
  return { declared, missing };
}

export function discoverEntrypoints(rootDir) {
  // §6.2 MANDATORY runtime roots (unchanged): API `scripts/**/*.ts` (specs
  // excluded separately) and root `scripts/*.mjs` (top-level only). These are
  // the physically-required in-scope CLIs; they are ALWAYS walked — never
  // suppressed by a package declaration.
  //
  // On top of the walk, every package.json-declared command target is
  // reconciled through the command-aware resolver (resolveDeclaredTargets):
  //   - a resolved operational CLI OUTSIDE the walked roots becomes an executed
  //     `entrypoint` subject (nested/out-of-root operational source);
  //   - a target owned by a configured native test runner, a build artifact, a
  //     runtime server, a runner config, a shell script, a dependency runner or a
  //     resolved Python CLI launched by an actual Python interpreter becomes an
  //     explicit `declared-non-smoke` record (exact owner + reason), never
  //     labelled native-verified and never dropped;
  //   - a genuinely missing in-scope CLI target, or an unresolvable
  //     dynamic/escaping/ambiguous CLI operand, stays an `undiscovered-declared`
  //     failure packet.
  const roots = [
    {
      dir: join(rootDir, 'apps', 'api', 'scripts'),
      subject: 'apps/api/scripts',
      match: (name) => /\.ts$/.test(name) && !/\.d\.ts$/.test(name),
    },
    {
      dir: join(rootDir, 'scripts'),
      subject: 'root/scripts',
      match: (name) => /\.mjs$/.test(name),
      maxDepth: 0,
    },
  ];
  const { records } = resolveDeclaredTargets(rootDir);

  // Declared-but-resolved operational CLIs, grouped by repo-relative path so a
  // walked file can carry the packages/scripts that declare it. Alongside the
  // legacy `declaredBy` NAME list we retain the FULL invocation context of every
  // declaration (its exact effective cwd, runner, token, role, command, script
  // and disposition) — a single physical path declared from several contexts
  // (package cwd, `cd`, `--filter`, `-C`/`--dir`, a nested command) must keep ALL
  // of them, never collapse to one.
  const pkgDirRel = (dir) => {
    const cr = safeRelFrom(rootDir, dir);
    return cr === '' ? '.' : cr;
  };
  const contextOf = (r) => ({
    reference: r.reference,
    package: r.package,
    packageDir: pkgDirRel(r.packageDir),
    script: r.script,
    scriptBody: r.scriptBody,
    command: r.command,
    token: r.token,
    role: r.role,
    runner: r.runner,
    cwdRel: r.cwdRel ?? null,
    cwdSource: r.cwdSource,
    resolution: r.resolution,
    disposition: r.disposition,
  });
  const declaredByRel = new Map();
  const declaredContextsByRel = new Map();
  const declaredContextKeys = new Map();
  for (const r of records) {
    if (r.resolution !== 'resolved' || !r.rel || r.disposition !== 'operational-cli') continue;
    if (!declaredByRel.has(r.rel)) {
      declaredByRel.set(r.rel, []);
      declaredContextsByRel.set(r.rel, []);
      declaredContextKeys.set(r.rel, new Set());
    }
    declaredByRel.get(r.rel).push(r.reference);
    // Stable EXACT dedup only: byte-identical context records collapse; a
    // DIFFERENT declaration/context (a different reference, package, command,
    // token, role, runner or cwdRel) stays visible.
    const ctx = contextOf(r);
    const key = JSON.stringify(ctx);
    if (!declaredContextKeys.get(r.rel).has(key)) {
      declaredContextKeys.get(r.rel).add(key);
      declaredContextsByRel.get(r.rel).push(ctx);
    }
  }

  const results = [];
  const seen = new Set();

  for (const { dir, subject, match, maxDepth } of roots) {
    for (const abs of walk(dir, [], { match, maxDepth })) {
      const name = abs.split(sep).pop();
      const rel = relative(rootDir, abs).split(sep).join('/');
      seen.add(rel);
      if (isTestFile(name)) {
        results.push({ path: abs, rel, subject, kind: 'test', reason: 'spec/test file' });
        continue;
      }
      let text;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        results.push({ path: abs, rel, subject, kind: 'entrypoint', reason: 'unreadable (fail-closed)', certainty: 'unsupported' });
        continue;
      }
      const { executable, certainty } = classifyTopLevel(text, name);
      const declaredBy = declaredByRel.get(rel);
      const declaredContexts = declaredContextsByRel.get(rel);
      const destructive = DESTRUCTIVE_PATTERNS.filter((re) => re.test(text)).map((re) => re.source);

      if (!executable && !declaredBy) {
        results.push({ path: abs, rel, subject, kind: 'module', reason: 'top level is declarations only; not declared', certainty });
        continue;
      }
      if (destructive.length > 0) {
        // Classification is UNCHANGED (`unsafe`), but the declaration provenance
        // is retained: an unsafe walked subject declared operational keeps every
        // one of its invocation contexts.
        results.push({
          path: abs, rel, subject, kind: 'unsafe',
          reason: 'destructive static pattern(s); not executed', destructive,
          ...(declaredBy ? { declaredBy } : {}),
          ...(declaredContexts ? { declaredContexts } : {}),
        });
        continue;
      }
      results.push({
        path: abs, rel, subject, kind: 'entrypoint',
        reason: executable ? (certainty === 'unsupported' ? 'unsupported top-level construct (fail closed)' : 'top-level execution') : 'package.json-declared command',
        certainty,
        ...(declaredBy ? { declaredBy } : {}),
        ...(declaredContexts ? { declaredContexts } : {}),
      });
    }
  }

  // Reconcile EVERY declaration record — nothing is silently dropped.
  const emitted = new Set();
  for (const r of records) {
    const rel = r.rel ?? null;
    // A resolved operational CLI inside a walked root is already an entrypoint.
    if (r.disposition === 'operational-cli' && r.resolution === 'resolved') {
      if (rel && seen.has(rel)) continue;
      const key = `entry:${rel}`;
      if (emitted.has(key)) continue;
      emitted.add(key);
      results.push({
        path: rel ? join(rootDir, rel.split('/').join(sep)) : r.token,
        rel: rel ?? r.token,
        subject: `declared:${r.package}#${r.script}`,
        kind: 'entrypoint',
        reason: 'package.json-declared executable source outside the walked §6.2 roots (nested/out-of-root operational CLI)',
        certainty: 'execution',
        declaredBy: declaredByRel.get(rel) ?? [r.reference],
        declaredContexts: declaredContextsByRel.get(rel) ?? [contextOf(r)],
        disposition: r.disposition,
        command: r.command,
      });
      continue;
    }
    // A test operand already represented by a walked `test` file is not duplicated.
    if (r.disposition === 'test-runner-target' && rel && seen.has(rel)) continue;

    // Fail closed on EVERY missing or unresolved declared CLI target, regardless of
    // whether it sits inside the §6.2 mandatory roots: an out-of-root missing CLI
    // (unresolved-missing) and an unresolved dynamic/escaping/symlink/unknown-cwd
    // operational operand are failures, never a silent non-smoke record.
    const failure =
      r.disposition === 'untracked-manifest' ||
      r.disposition === 'missing-cli' ||
      r.disposition === 'unresolved-missing' ||
      (r.disposition === 'operational-cli' && r.resolution !== 'resolved');
    const key = `${failure ? 'pkt' : 'rec'}:${rel ?? r.token}:${r.disposition}:${r.reference}`;
    if (emitted.has(key)) continue;
    emitted.add(key);
    results.push({
      path: rel ? join(rootDir, rel.split('/').join(sep)) : r.token,
      rel: rel ?? r.token,
      subject: r.disposition === 'untracked-manifest' ? 'untracked-input' : failure ? (r.resolution === 'missing' ? 'declared-missing' : 'declared-unresolved') : 'declared-non-smoke',
      kind: failure ? 'undiscovered-declared' : 'declared-non-smoke',
      reason: r.reason,
      disposition: r.disposition,
      owner: r.owner,
      resolution: r.resolution,
      declaredBy: [r.reference],
      command: r.command,
    });
  }
  return results.sort((a, b) => String(a.rel).localeCompare(String(b.rel)));
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('discover.mjs')) {
  const rootDir = process.argv[2] ?? process.cwd();
  const found = discoverEntrypoints(rootDir);
  const byKind = {};
  const byDisposition = {};
  for (const r of found) {
    byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
    if (r.disposition) byDisposition[r.disposition] = (byDisposition[r.disposition] ?? 0) + 1;
  }
  const { ignored } = resolveDeclaredTargets(rootDir);
  process.stdout.write(JSON.stringify({ rootDir, counts: byKind, dispositions: byDisposition, ignoredValues: ignored, findings: found }, null, 2));
}
