/**
 * STATIC route-contract derivation (CleanUp1 §8.1) — round-4 correction.
 *
 * Round-3 shipped `importPureContract`, which transpiled a repository module's
 * relative-import closure and `await import(...)`-ed it on the HOST, then
 * `enumerateContract` INVOKED its exported functions. That is real host
 * execution of repository source and a purity blacklist is not proof of safety
 * (initializer assignments, getters, namespace side effects and invoked export
 * effects all escape a naive check). The report claiming "static analysis only /
 * no host execution" was therefore inaccurate.
 *
 * This module now does the derivation WITHOUT executing anything:
 *
 *   - `analyzePurity` classifies a single source text for MODULE-LOAD effects,
 *     statically (never executed). It is exported only so adversarial fixtures
 *     can be validated in memory.
 *   - `deriveContractModule` statically evaluates a contract module's exported
 *     const/array/object/template values and function *templates* from the AST.
 *     Any construct it cannot resolve statically is an explicit obligation —
 *     never an executed guess. No dynamic import, no transpile, no temp files,
 *     no exported-function invocation.
 */
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadTs, readSourceFile, WEB_SRC, parseFailure } from './ast-routes.mjs';

const PURE_REL_RE = /^\.{1,2}\//;

/** Names whose MUTATION/call in an evaluated expression is a global effect. */
const GLOBAL_MUTATORS = new Set([
  'globalThis', 'window', 'global', 'process', 'document', 'localStorage',
  'sessionStorage', 'navigator', 'location', 'eval', 'require', 'fetch',
  'XMLHttpRequest', 'WebSocket', 'EventSource',
]);

/** `new` constructors that cannot perform I/O or mutate globals at load time. */
const SAFE_NEW = new Set(['Set', 'Map', 'RegExp', 'URL', 'Array', 'Date', 'Error', 'TypeError', 'Promise']);

/**
 * Assignment operator kinds, compared NUMERICALLY. `ts.SyntaxKind[kind]`
 * returns the alias `FirstAssignment` for `=` (not `EqualsToken`), so a
 * name-string match silently misses plain assignment — the exact round-4
 * false-green. Build the set from the compiler's own constants instead.
 */
let _assignKinds = null;
function assignmentKinds(ts) {
  if (!_assignKinds) {
    _assignKinds = new Set([
      ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
      ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
      ts.SyntaxKind.PercentEqualsToken, ts.SyntaxKind.LessThanLessThanEqualsToken,
      ts.SyntaxKind.GreaterThanGreaterThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
      ts.SyntaxKind.AmpersandEqualsToken, ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
      ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
      ts.SyntaxKind.QuestionQuestionEqualsToken,
    ]);
  }
  return _assignKinds;
}

function isAssignmentOperator(ts, kind) {
  return assignmentKinds(ts).has(kind);
}

/** Root identifier of an assignment/mutation target (`globalThis.x` → globalThis). */
function globalRoot(ts, node) {
  let n = node;
  while (n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) || ts.isTypeAssertionExpression(n))) n = n.expression;
  if (!n) return null;
  if (ts.isIdentifier(n)) return n.text;
  if (ts.isPropertyAccessExpression(n)) return globalRoot(ts, n.expression);
  if (ts.isElementAccessExpression(n)) return globalRoot(ts, n.expression);
  if (ts.isThis(n)) return 'this';
  return null;
}

/**
 * A mutation is only an *effect* when it writes a GLOBAL (`globalThis.x = …`,
 * `process.env.x = …`, `this.y = …`). Local assignments (`segment = decode(x)`,
 * `changed = true`) are ordinary, side-effect-free builder code and must NOT
 * make a legitimate contract module non-pure.
 */
function isGlobalMutation(ts, node) {
  const root = globalRoot(ts, node);
  return Boolean(root && (GLOBAL_MUTATORS.has(root) || root === 'this'));
}

/**
 * Static MODULE-LOAD purity analysis over provided source text — nothing is
 * executed. `resolveImport(spec)` maps a relative specifier to a repo-relative
 * module (or null). Exported so adversarial fixtures can be validated IN MEMORY.
 */
export function analyzePurity(relFile, text, resolveImport) {
  const ts = loadTs();
  const sf = ts.createSourceFile(
    relFile, text, ts.ScriptTarget.Latest, true,
    relFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  // Round-6: fail closed on parse diagnostics. A source file that does not parse
  // cleanly cannot be trusted for a purity verdict (or a route list), so it is an
  // explicit failure rather than a silently-accepted partial AST.
  const parseErr = parseFailure(relFile, sf);
  if (parseErr) return { ok: false, reason: `parse failure: ${parseErr}` };
  const relImports = [];
  const isAllowedDecl = (stmt) =>
    ts.isImportDeclaration(stmt) || ts.isExportDeclaration(stmt) || ts.isVariableStatement(stmt) ||
    ts.isFunctionDeclaration(stmt) || ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt) ||
    ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt);

  const decoratorsOf = (n) => (ts.canHaveDecorators && ts.canHaveDecorators(n) ? ts.getDecorators(n) ?? [] : []);
  const modsOf = (n) => (ts.canHaveModifiers && ts.canHaveModifiers(n) ? ts.getModifiers(n) ?? [] : []);
  const isExported = (n) => modsOf(n).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);

  /**
   * Deep scan of an arbitrarily nested expression for an effect that executes at
   * MODULE DEFINITION time. Plain function/arrow bodies are skipped (they are not
   * invoked by the declaration) — BUT accessor (get/set) bodies are scanned,
   * because a getter runs the moment the property is read during initialization.
   * Assignments, comma/sequence operators, `++`/`--`, decorators, nested calls,
   * awaits, tagged templates and disallowed `new` are all caught anywhere in the
   * evaluated expression (round-4: a bare top-level call check let `(x = 1, v)`
   * and object-literal getters escape).
   */
  const effectIn = (node) => {
    let found = null;
    const scan = (n) => {
      if (found || !n) return;
      if (ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) {
        if (n.body) ts.forEachChild(n.body, scan);
        return;
      }
      if (ts.isFunctionLike(n)) return; // body not executed by the declaration
      if (decoratorsOf(n).length) { found = `decorator on ${ts.SyntaxKind[n.kind]}`; return; }
      if (ts.isCallExpression(n) || ts.isAwaitExpression(n) || ts.isTaggedTemplateExpression(n)) {
        found = `nested call ${String(n.getText(sf)).slice(0, 48)}`; return;
      }
      if (ts.isNewExpression(n)) {
        const callee = n.expression;
        const name = ts.isIdentifier(callee) ? callee.text : null;
        if (!name || !SAFE_NEW.has(name)) { found = `new ${name ?? '?'}()`; return; }
      }
      if (ts.isBinaryExpression(n)) {
        const k = n.operatorToken.kind;
        if (k === ts.SyntaxKind.CommaToken) { found = 'comma/sequence expression'; return; }
        if (isAssignmentOperator(ts, k) && isGlobalMutation(ts, n.left)) { found = `global assignment ${String(n.getText(sf)).slice(0, 48)}`; return; }
      }
      if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
        const k = n.operator;
        if ((k === ts.SyntaxKind.PlusPlusToken || k === ts.SyntaxKind.MinusMinusToken) && isGlobalMutation(ts, n.operand)) { found = 'global increment/decrement'; return; }
      }
      ts.forEachChild(n, scan);
    };
    scan(node);
    return found;
  };

  /**
   * Effects that the body of an EXPORTED function/arrow would run if a caller
   * INVOKED it. We never invoke exports (see deriveContractModule), but a
   * function that mutates a global is not a pure value builder either, so the
   * module is reported non-pure rather than silently trusted. Benign calls
   * (`encodeURIComponent`, `String`, method calls on locals) are not effects —
   * only writes/mutations/global-name calls are.
   */
  const bodyEffect = (fnLike) => {
    let found = null;
    const scan = (n) => {
      if (found || !n) return;
      if (ts.isFunctionLike(n) && n !== fnLike) return; // nested closures are not run here
      if (ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)) { if (n.body) ts.forEachChild(n.body, scan); return; }
      if (ts.isBinaryExpression(n) && isAssignmentOperator(ts, n.operatorToken.kind) && isGlobalMutation(ts, n.left)) {
        found = `global assignment in exported function body (${String(n.getText(sf)).slice(0, 48)})`; return;
      }
      if (ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n)) {
        const k = n.operator;
        if ((k === ts.SyntaxKind.PlusPlusToken || k === ts.SyntaxKind.MinusMinusToken) && isGlobalMutation(ts, n.operand)) { found = 'global mutation in exported function body'; return; }
      }
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        const name = ts.isIdentifier(c) ? c.text
          : (ts.isPropertyAccessExpression(c) && ts.isIdentifier(c.expression) ? c.expression.text : null);
        if (name && GLOBAL_MUTATORS.has(name)) { found = `global call ${name}() in exported function body`; return; }
      }
      ts.forEachChild(n, scan);
    };
    scan(fnLike);
    return found;
  };

  /** Effects a class introduces at load time: decorators, static blocks and
   *  static/computed member initializers (getters/constructors run later). */
  const classEffect = (cls) => {
    if (decoratorsOf(cls).length) return 'class decorator';
    for (const m of cls.members) {
      if (decoratorsOf(m).length) return `member decorator (${ts.SyntaxKind[m.kind]})`;
      if (ts.isClassStaticBlockDeclaration(m)) return 'class static block';
      const isStatic = modsOf(m).some((mod) => mod.kind === ts.SyntaxKind.StaticKeyword);
      if (m.name && ts.isComputedPropertyName(m.name)) {
        const e = effectIn(m.name.expression);
        if (e) return `computed member name: ${e}`;
      }
      if (isStatic && m.initializer) {
        const e = effectIn(m.initializer);
        if (e) return `static initializer: ${e}`;
      }
    }
    return null;
  };

  const scanStatements = (statements, where) => {
    for (const stmt of statements) {
      if (!isAllowedDecl(stmt)) return `top-level side effect (${ts.SyntaxKind[stmt.kind]}) in ${where}`;
      if (ts.isVariableStatement(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          if (!d.initializer) continue;
          const eff = effectIn(d.initializer);
          if (eff) return `top-level effect in initializer of ${where}: ${eff}`;
        }
      }
      if (ts.isClassDeclaration(stmt)) {
        const eff = classEffect(stmt);
        if (eff) return `class effect in ${where}: ${eff}`;
      }
      // Namespace / module declarations: a body statement that is not a
      // declaration executes at load time (round-4 `namespace-initialization`).
      if (ts.isModuleDeclaration(stmt) && stmt.body && ts.isModuleBlock(stmt.body)) {
        const inner = scanStatements(stmt.body.statements, `${where} (namespace ${stmt.name.getText(sf)})`);
        if (inner) return inner;
      }
      // Exported function/arrow bodies that mutate globals (round-4
      // `invoked-export-function`).
      if (ts.isFunctionDeclaration(stmt) && stmt.name && isExported(stmt) && stmt.body) {
        const eff = bodyEffect(stmt);
        if (eff) return `${eff} in ${where}`;
      }
      if (ts.isVariableStatement(stmt) && isExported(stmt)) {
        for (const d of stmt.declarationList.declarations) {
          const init = d.initializer;
          if (!init) continue;
          for (const fn of collectFunctionLike(ts, init)) {
            const eff = bodyEffect(fn);
            if (eff) return `${eff} in ${where}`;
          }
        }
      }
    }
    return null;
  };

  const topEffect = scanStatements(sf.statements, relFile);
  if (topEffect) return { ok: false, reason: topEffect };

  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) {
      const spec = stmt.moduleSpecifier;
      if (!ts.isStringLiteral(spec)) return { ok: false, reason: `non-literal import specifier in ${relFile}` };
      const s = spec.text;
      if (!PURE_REL_RE.test(s)) return { ok: false, reason: `non-pure import '${s}' in ${relFile}` };
      const target = resolveImport(s);
      if (!target) return { ok: false, reason: `unresolved import '${s}' in ${relFile}` };
      relImports.push({ spec: s, target });
    } else if (ts.isExportDeclaration(stmt) && stmt.moduleSpecifier) {
      if (!ts.isStringLiteral(stmt.moduleSpecifier) || !PURE_REL_RE.test(stmt.moduleSpecifier.text)) {
        return { ok: false, reason: `non-relative reexport in ${relFile}` };
      }
      const target = resolveImport(stmt.moduleSpecifier.text);
      if (!target) return { ok: false, reason: `unresolved reexport '${stmt.moduleSpecifier.text}' in ${relFile}` };
      relImports.push({ spec: stmt.moduleSpecifier.text, target });
    }
  }

  // Dynamic import()/require()/eval() anywhere is an execution escape hatch.
  let escape = null;
  const scanEsc = (n) => {
    if (escape || !n) return;
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (c.kind === ts.SyntaxKind.ImportKeyword) escape = 'dynamic import()';
      else if (ts.isIdentifier(c) && (c.text === 'require' || c.text === 'import' || c.text === 'eval')) escape = `${c.text}()`;
    }
    ts.forEachChild(n, scanEsc);
  };
  scanEsc(sf);
  if (escape) return { ok: false, reason: `${escape} in ${relFile}` };
  return { ok: true, relImports };
}

/** Every arrow/function expression reachable inside an initializer expression. */
function collectFunctionLike(ts, node, out = []) {
  if (!node) return out;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) out.push(node);
  ts.forEachChild(node, (c) => collectFunctionLike(ts, c, out));
  return out;
}

function resolveRel(fromRel, spec) {
  const dir = path.posix.dirname(fromRel);
  const rel = path.posix.normalize(path.posix.join(dir, spec));
  const base = rel.replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (existsSync(path.join(WEB_SRC, cand))) return cand;
  }
  return null;
}

export function modulePurity(relFile) {
  let text;
  try {
    text = readSourceFile(relFile);
  } catch {
    return { ok: false, reason: `missing ${relFile}` };
  }
  return analyzePurity(relFile, text, (spec) => resolveRel(relFile, spec));
}

// ── static value evaluation ────────────────────────────────────────────────
//
// Round-4 correction: a template is derived as an ordered list of PARTS, never
// as occurrence-ordered placeholders. The previous `evalStatic` threw away
// every span expression, numbered placeholders in occurrence order and
// `applyFnTemplate` assumed occurrence==argument index with unconditional
// encodeURIComponent — three silent mis-derivations (reordered/encoded spans,
// literal spans, raw segments) root proved on 2026-10-08. Parts instead record
// the ACTUAL span expression, its parameter binding and its actual encoding:
//
//   { t: 'lit', text }                 literal text, contributed verbatim
//   { t: 'param', name, encoded }      a parameter reference; `encoded` records
//                                      whether the source wrapped it in
//                                      encodeURIComponent (raw otherwise)
//
// Anything outside this conservative grammar returns null, which the caller
// turns into an explicit obligation — never a guessed value. No import, no
// transpile, no temp file, no function invocation: static AST only.

function litPart(text) { return { t: 'lit', text }; }
/**
 * A parameter reference. `encoder` records the ACTUAL encoding operation the
 * source applied — `'encodeURIComponent'`, `'encodeURI'` or `null` (raw).
 * Round-5 collapsed both encoders into a bare `encoded:true`, so `encodeURI(id)`
 * was applied as `encodeURIComponent(id)` (`A/value?x=1` → `A%2Fvalue%3Fx%3D1`
 * instead of the source's `A/value?x=1`). `encoded` is retained as a derived
 * boolean for report compatibility only; the value applied is always `encoder`.
 */
function paramPart(name, encoder) {
  const enc = typeof encoder === 'string' ? encoder : null;
  return { t: 'param', name, encoded: enc != null, encoder: enc };
}

/** Strip parentheses / as / satisfies / type-assertion wrappers. */
function unwrapExpr(ts, node) {
  let n = node;
  while (
    n && (ts.isParenthesizedExpression(n) || ts.isAsExpression(n) ||
      ts.isTypeAssertionExpression(n) || (ts.isSatisfiesExpression && ts.isSatisfiesExpression(n)))
  ) n = n.expression;
  return n;
}

/** Resolve an identifier to a static string via local consts, else imports. */
function staticStringValue(ts, node, ctx) {
  if (!ts.isIdentifier(node)) return null;
  const v = ctx.consts.get(node.text);
  if (v && v.kind === 'string') return v.value;
  if (typeof ctx.resolveImport === 'function') {
    const s = ctx.resolveImport(node.text);
    if (typeof s === 'string') return s;
  }
  return null;
}

/**
 * Ordered parts of a template / string-concatenation expression, or null when
 * the expression is outside the supported grammar. Static only.
 */
function deriveTemplateParts(ts, node, ctx, sf) {
  if (!node) return null;
  node = unwrapExpr(ts, node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [litPart(node.text)];
  if (ts.isTemplateExpression(node)) {
    const parts = [litPart(node.head.text)];
    for (const span of node.templateSpans) {
      const sub = deriveSpanParts(ts, span.expression, ctx, sf);
      if (!sub) return null;
      parts.push(...sub);
      parts.push(litPart(span.literal.text));
    }
    return parts;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = deriveTemplateParts(ts, node.left, ctx, sf) ?? deriveSpanParts(ts, node.left, ctx, sf);
    if (!l) return null;
    const r = deriveTemplateParts(ts, node.right, ctx, sf) ?? deriveSpanParts(ts, node.right, ctx, sf);
    if (!r) return null;
    return [...l, ...r];
  }
  // A non-template operand (identifier parameter/const, encodeURIComponent call,
  // …) contributes its own span parts — so `'/a/' + encodeURIComponent(id)` is
  // a supported concatenation, while anything outside the grammar yields null.
  return deriveSpanParts(ts, node, ctx, sf);
}

/** Parts contributed by a single `${…}` span expression, or null. */
function deriveSpanParts(ts, node, ctx, sf) {
  if (!node) return null;
  node = unwrapExpr(ts, node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return [litPart(node.text)];
  if (ts.isTemplateExpression(node)) return deriveTemplateParts(ts, node, ctx, sf);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return deriveTemplateParts(ts, node, ctx, sf);
  }
  if (ts.isCallExpression(node)) {
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : null;
    // Only the exact `encodeURIComponent(<param>)` / `encodeURI(<param>)` forms
    // are encoding-bearing parameter references. Anything else is unsupported.
    if ((name === 'encodeURIComponent' || name === 'encodeURI') && node.arguments.length === 1) {
      const arg = unwrapExpr(ts, node.arguments[0]);
      if (ts.isIdentifier(arg) && ctx.params.has(arg.text)) return [paramPart(arg.text, name)];
      const lit = ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg) ? arg.text : null;
      const s = lit !== null ? lit : staticStringValue(ts, arg, ctx);
      if (s !== null) return [litPart(name === 'encodeURI' ? encodeURI(s) : encodeURIComponent(s))];
    }
    return null;
  }
  if (ts.isIdentifier(node)) {
    if (ctx.params.has(node.text)) return [paramPart(node.text, false)];
    const s = staticStringValue(ts, node, ctx);
    if (s !== null) return [litPart(s)];
    return null;
  }
  return null;
}

/**
 * Statically evaluate an exported expression to a JSON-ish value, a `template`
 * (parts), or a `fn` (parts + parameter names). Returns null when it cannot be
 * resolved statically (the caller turns that into an explicit obligation).
 * NEVER executes anything.
 */
function evalStatic(ts, node, ctx, sf) {
  if (!node) return null;
  node = unwrapExpr(ts, node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return { kind: 'string', value: node.text };
  if (ts.isNumericLiteral(node)) return { kind: 'number', value: Number(node.text) };
  if (ts.isTemplateExpression(node) || (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)) {
    const parts = deriveTemplateParts(ts, node, ctx, sf);
    if (!parts) return null;
    if (parts.every((p) => p.t === 'lit')) return { kind: 'string', value: parts.map((p) => p.text).join('') };
    return { kind: 'template', parts };
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items = [];
    for (const el of node.elements) {
      const v = evalStatic(ts, el, ctx, sf);
      if (v === null) return null;
      items.push(v);
    }
    return { kind: 'array', items };
  }
  if (ts.isObjectLiteralExpression(node)) {
    const props = {};
    for (const p of node.properties) {
      if (!ts.isPropertyAssignment(p) || !p.name) return null;
      const key = ts.isIdentifier(p.name) ? p.name.text
        : ts.isStringLiteral(p.name) ? p.name.text
        : null;
      if (key === null) return null;
      const v = evalStatic(ts, p.initializer, ctx, sf);
      if (v === null) return null;
      props[key] = v;
    }
    return { kind: 'object', props };
  }
  // Arrow / function-expression / function-declaration route builders. The
  // parameter list is captured faithfully and each span is bound BY NAME, so
  // reordered/repeated/unused parameters resolve correctly.
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) {
    const info = functionBody(ts, node.body, ctx, sf);
    if (!info) return null;
    const paramNames = node.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
    // Local lexical bindings shadow both module consts (via info.consts) and
    // parameters of the same name (removed from the param set), matching the
    // real JS/TS scoping.
    const fnCtx = {
      consts: info.consts,
      params: new Set(paramNames.filter(Boolean).filter((n) => !info.shadowed.has(n))),
      resolveImport: ctx.resolveImport,
    };
    const v = evalStatic(ts, info.expr, fnCtx, sf);
    if (!v) return null;
    const parts = v.kind === 'template' ? v.parts : v.kind === 'string' ? [litPart(v.value)] : null;
    if (!parts) return null;
    return { kind: 'fn', parts, params: paramNames };
  }
  if (ts.isIdentifier(node)) {
    if (node.text === 'undefined') return { kind: 'undefined' };
    const v = ctx.consts.get(node.text);
    if (v) return v;
    if (typeof ctx.resolveImport === 'function') {
      const s = ctx.resolveImport(node.text);
      if (typeof s === 'string') return { kind: 'string', value: s };
    }
    return null;
  }
  return null;
}

/**
 * The single returned expression of a concise/block-bodied function plus the
 * function-local lexical bindings it declares, or null.
 *
 * Round-6 correction: round-5 `returnExpression` accepted local declarations
 * but DISCARDED them, so a builder body's `const segment='inner'` silently fell
 * back to the module-level `const segment='outer'` (root proved `/route/outer`
 * contrary to `/route/inner`). Local `const`/`let` bindings are now derived
 * faithfully in source order, shadowing module consts and parameters of the same
 * name. A local binding that is NOT statically derivable (destructuring, a call
 * result, reassignment, forward reference) makes the whole block unresolved —
 * never a guessed module value. Static AST only; nothing executed.
 */
function functionBody(ts, body, ctx, sf) {
  if (!body) return null;
  if (!ts.isBlock(body)) return { expr: body, consts: ctx.consts, shadowed: new Set() }; // concise arrow body
  const returns = body.statements.filter((s) => ts.isReturnStatement(s));
  if (returns.length !== 1 || !returns[0].expression) return null;
  // Any other non-declaration statement means the body is more than a value
  // builder (e.g. reassignment) — resolve as an explicit obligation instead.
  const others = body.statements.filter((s) => !ts.isReturnStatement(s) && !ts.isVariableStatement(s) && !ts.isEmptyStatement(s));
  if (others.length) return null;
  const consts = new Map(ctx.consts);
  const shadowed = new Set();
  for (const s of body.statements) {
    if (!ts.isVariableStatement(s)) continue;
    for (const d of s.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) return null; // pattern/complex → obligation
      const v = evalStatic(ts, d.initializer, { consts, params: ctx.params, resolveImport: ctx.resolveImport }, sf);
      if (v === null) return null; // not faithfully derivable → obligation
      consts.set(d.name.text, v); // shadows a module const
      shadowed.add(d.name.text);  // shadows a parameter of the same name
    }
  }
  return { expr: returns[0].expression, consts, shadowed };
}

/**
 * One-hop, cycle-guarded resolver mapping an imported local name → its static
 * string value, read from the imported module's exported const. Only static
 * string consts resolve; a default import or a non-const export returns null
 * (an explicit obligation at the call site). Static AST + source read only —
 * never executed.
 */
function importConstResolver(ts, sf, fromRel, guard) {
  const imports = new Map();
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec)) continue;
    const clause = stmt.importClause;
    if (clause.name) imports.set(clause.name.text, { spec: spec.text, imported: 'default' });
    const named = clause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) imports.set(el.name.text, { spec: spec.text, imported: (el.propertyName ?? el.name).text });
    }
  }
  return (name) => {
    const imp = imports.get(name);
    if (!imp || imp.imported === 'default') return null;
    const target = resolveRel(fromRel, imp.spec);
    if (!target) return null;
    const key = `${target}::${imp.imported}`;
    if (guard.has(key)) return null;
    guard.add(key);
    let text;
    try { text = readSourceFile(target); } catch { return null; }
    const tsf = ts.createSourceFile(target, text, ts.ScriptTarget.Latest, true,
      target.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const inner = importConstResolver(ts, tsf, target, guard);
    for (const st of tsf.statements) {
      if (!ts.isVariableStatement(st)) continue;
      const exported = (ts.getModifiers(st) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.name.text !== imp.imported || !d.initializer) continue;
        const v = evalStatic(ts, d.initializer, { consts: new Map(), params: new Set(), resolveImport: inner }, tsf);
        if (v && v.kind === 'string') return v.value;
        return null;
      }
    }
    return null;
  };
}

/**
 * Statically derive a contract module's exported route values from in-memory
 * source text. `opts.resolveImport(name)` optionally resolves an imported
 * local name to a static string. Returns { ok:true, exports, unresolvedExports }.
 * No import, no transpile, no temp file, no function invocation — pure AST.
 */
export function deriveContractSource(relFile, text, opts = {}) {
  const ts = loadTs();
  const sf = ts.createSourceFile(relFile, text, ts.ScriptTarget.Latest, true,
    relFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  // Round-6: the public module path (deriveContractModule→modulePurity) parsed
  // without checking diagnostics, so `export const route = …; export const
  // broken = ;` returned ok:true and resolved the (still-valid) route. A parse
  // diagnostic now fails the whole contract derivation closed — a malformed
  // module is an explicit obligation, never a partial result.
  const parseErr = parseFailure(relFile, sf);
  if (parseErr) return { ok: false, reason: `parse failure: ${parseErr}`, exports: {}, unresolvedExports: [] };
  const resolveImport = typeof opts.resolveImport === 'function'
    ? opts.resolveImport
    : importConstResolver(ts, sf, relFile, new Set());
  const consts = new Map();
  const exports = {};
  const unresolvedExports = [];
  const ctx = { consts, params: new Set(), resolveImport };

  // Pass 1: local (non-exported and exported) const values, in source order.
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || !d.initializer) continue;
      const v = evalStatic(ts, d.initializer, ctx, sf);
      if (v !== null) consts.set(d.name.text, v);
    }
  }

  // Pass 2: exported bindings.
  for (const stmt of sf.statements) {
    if (ts.isVariableStatement(stmt)) {
      const exported = (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue;
        const v = consts.get(d.name.text) ?? (d.initializer ? evalStatic(ts, d.initializer, ctx, sf) : null);
        if (v === null) { unresolvedExports.push(d.name.text); continue; }
        exports[d.name.text] = v;
      }
    } else if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      const exported = (ts.getModifiers(stmt) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
      if (!exported) continue;
      const v = evalStatic(ts, stmt, ctx, sf);
      if (v === null) { unresolvedExports.push(stmt.name.text); } else exports[stmt.name.text] = v;
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier) {
      // `export { A, B }` — surface already-collected consts by their export name.
      const clause = stmt.exportClause;
      if (clause && ts.isNamedExports(clause)) {
        for (const el of clause.elements) {
          const local = (el.propertyName ?? el.name).text;
          const name = el.name.text;
          const v = consts.get(local);
          if (v !== undefined) exports[name] = v;
        }
      }
    }
  }
  return { ok: true, exports, unresolvedExports };
}

/**
 * Statically derive a repository contract module's exported route values.
 * Returns { ok:true, exports, unresolvedExports } | { ok:false, reason }.
 * No import, no transpile, no temp file, no function invocation.
 */
export function deriveContractModule(relFile) {
  const purity = modulePurity(relFile);
  if (!purity.ok) return { ok: false, reason: purity.reason };
  let text;
  try { text = readSourceFile(relFile); } catch { return { ok: false, reason: `missing ${relFile}` }; }
  return deriveContractSource(relFile, text);
}

/**
 * Apply a statically-derived `fn` to concrete argument values. Each part is
 * bound to the PARAMETER it actually references (never to occurrence order),
 * and encoding is applied only where the source encoded it. Returns
 * { value } | { reason }.
 */
export function applyFnTemplate(fn, args, label) {
  if (!fn || fn.kind !== 'fn' || !Array.isArray(fn.parts)) {
    return { reason: `${label ?? 'fn'}: not a statically resolvable route builder` };
  }
  const params = Array.isArray(fn.params) ? fn.params : [];
  const bind = new Map();
  for (let i = 0; i < params.length; i++) if (params[i]) bind.set(params[i], args[i]);
  let out = '';
  const missing = new Set();
  for (const p of fn.parts) {
    if (p.t === 'lit') { out += p.text; continue; }
    if (!bind.has(p.name) || bind.get(p.name) === undefined) { missing.add(p.name); continue; }
    const raw = String(bind.get(p.name));
    if (p.encoder === 'encodeURIComponent') out += encodeURIComponent(raw);
    else if (p.encoder === 'encodeURI') out += encodeURI(raw);
    else if (p.encoded) out += encodeURIComponent(raw); // pre-encoder parts: preserve legacy behavior
    else out += raw;
  }
  if (missing.size) return { reason: `${label ?? 'fn'}: no bound argument for parameter(s) ${[...missing].join(', ')}` };
  if (!out.startsWith('/')) return { reason: `${label ?? 'fn'}: resolved '${out}' is not an absolute route` };
  return { value: out };
}

/** Kept for API compatibility; static derivation creates no temp files. */
export function cleanupContractTmp() {}
