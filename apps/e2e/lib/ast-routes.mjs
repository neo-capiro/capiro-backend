/**
 * TypeScript-AST route discovery primitives (CleanUp1 §8.1).
 *
 * These helpers parse the ACTUAL .ts/.tsx sources with the TypeScript compiler
 * API instead of matching raw `path="..."` text, so:
 *
 *   - single-quoted, JSX-expression and template-literal path attributes are
 *     seen (the old regex only matched double quotes and silently dropped them);
 *   - `<Route index>` (no `path` attribute) inherits its parent path;
 *   - relative child routes resolve under their parent; absolute children stay
 *     absolute;
 *   - imported path constants (`${RESEARCH_PORTFOLIOS_ROOT}/:id`) resolve through
 *     the import graph;
 *   - anything that cannot be resolved statically is reported as an UNRESOLVED
 *     entry, never silently omitted — `buildRouteGraph` turns those into failing
 *     obligations.
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const WEB_SRC = path.join(REPO_ROOT, 'apps', 'web', 'src');

let _ts = null;
/** Load the TypeScript compiler from the web app's node_modules (repo dep). */
export function loadTs() {
  if (_ts) return _ts;
  const require = createRequire(path.join(REPO_ROOT, 'apps', 'web', 'package.json'));
  _ts = require('typescript');
  if (!_ts || !_ts.createSourceFile) throw new Error('TypeScript compiler could not be loaded');
  return _ts;
}

/**
 * Parse a source file. `fileName` is repo-relative (drives script kind + errors).
 * Round-3 correction: use the ACTUAL compiler enum values (TS=3, TSX=4), not
 * the historical 0/1 literals — a JS ScriptKind can silently mis-parse JSX.
 */
export function parseSource(relFile, text) {
  const ts = loadTs();
  const kind = relFile.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(relFile, text, ts.ScriptTarget.Latest, /* setParentNodes */ true, kind);
  // Stash the intended kind so a probe can assert it without re-parsing.
  try { Object.defineProperty(sf, 'visualIntendedKind', { value: kind, enumerable: false }); } catch { /* frozen */ }
  return sf;
}

/** Compiler parse diagnostics for a parsed source file. */
export function parseDiagnostics(sf) {
  return sf.parseDiagnostics ?? [];
}

/** True when a source file parsed with zero diagnostics. */
export function isParseClean(sf) {
  return parseDiagnostics(sf).length === 0;
}

/**
 * Fail-closed parse gate. Any parse diagnostic means the AST cannot be trusted
 * to enumerate routes, so the caller (inventory generation) MUST fail rather
 * than accept a partial/false page list. Returns null when clean, else a
 * descriptive obligation string.
 */
export function parseFailure(relFile, sf) {
  const diags = parseDiagnostics(sf);
  if (diags.length === 0) return null;
  const ts = loadTs();
  const msgs = diags.slice(0, 3).map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '));
  return `${relFile}: ${diags.length} parse diagnostic(s) — ${msgs.join('; ')}`;
}

/** Local names bound to react-router `Route`/`Routes` (handles `Route as R`). */
export function routeTagAliases(sf) {
  const ts = loadTs();
  const aliases = new Map();
  const add = (name, tag) => aliases.set(name, tag);
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause) continue;
    const spec = stmt.moduleSpecifier;
    if (!ts.isStringLiteral(spec) || !/(^|\/)react-router(-dom)?$/.test(spec.text)) continue;
    const named = stmt.importClause.namedBindings;
    if (named && ts.isNamedImports(named)) {
      for (const el of named.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (imported === 'Route' || imported === 'Routes') add(el.name.text, imported);
      }
    }
  }
  return aliases;
}

/**
 * Classify a JSX tag as the react-router `Route`/`Routes` (or null). `Route` and
 * `Routes` are always recognised (the probe/JSX tables use the real names even
 * without a visible import); an alias only ever maps to the real name.
 */
export function classifyRouteTag(tagText, aliases) {
  if (tagText === 'Route' || tagText === 'Routes') return tagText;
  if (aliases && aliases.has(tagText)) return aliases.get(tagText);
  return null;
}

/** line (1-based) of a node. */
export function lineOf(sf, node) {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

/** Module-scope `const NAME = "literal"` string table + import map. */
export function moduleContext(sf, fromFile) {
  const ts = loadTs();
  const constStrings = new Map();
  const imports = new Map();
  const from = fromFile ?? sf.fileName;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const spec = stmt.moduleSpecifier;
      if (!ts.isStringLiteral(spec) || !spec.text.startsWith('.')) continue;
      const clause = stmt.importClause;
      if (clause.name) imports.set(clause.name.text, { spec: spec.text, imported: 'default', from });
      const named = clause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) {
          imports.set(el.name.text, { spec: spec.text, imported: (el.propertyName ?? el.name).text, from });
        }
      }
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const v = staticString(decl.initializer);
        if (v !== null) constStrings.set(decl.name.text, v);
      }
    }
  }
  return { sf, constStrings, imports };
}

/**
 * Every module the file references, regardless of construct:
 *   - static `import ... from 'x'` / `export ... from 'x'`
 *   - dynamic `import('x')` (lazy route modules)
 *   - CommonJS `require('x')`
 * Returns [{ spec, kind, node }] in source order. Reviewers flagged that
 * enumerating only ImportDeclarations silently drops lazily-mounted route
 * modules (React.lazy(() => import(...))) and require()-based mounts.
 */
export function collectModuleRefs(sf) {
  const ts = loadTs();
  const out = [];
  const push = (spec, kind, node) => {
    if (typeof spec === 'string' && (spec.startsWith('.') || spec.startsWith('/'))) out.push({ spec, kind, node });
  };
  const visit = (n) => {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const spec = n.moduleSpecifier;
      if (spec && ts.isStringLiteral(spec)) push(spec.text, ts.isImportDeclaration(n) ? 'static' : 'reexport', n);
    } else if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === 'import')) {
        const a = n.arguments[0];
        if (a && ts.isStringLiteral(a)) push(a.text, 'dynamic', n);
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        const a = n.arguments[0];
        if (a && ts.isStringLiteral(a)) push(a.text, 'require', n);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** A pure string-literal / no-substitution-template value, or null. */
function staticString(node) {
  const ts = loadTs();
  if (!node) return null;
  if (ts.isStringLiteral(node)) return node.text;
  if (ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

/**
 * Resolve a `path=`/`to=` expression to a static string, resolving template
 * substitutions and imported constants. Returns { value } or { unresolved }.
 */
export function resolvePathExpression(node, ctx, seen = new Set()) {
  const ts = loadTs();
  if (!node) return { unresolved: 'missing expression' };
  // JSX expression container: { '...' } / { `...` } / { CONST } / { `${X}/y` }
  if (ts.isJsxExpression(node)) {
    if (!node.expression) return { unresolved: 'empty JSX expression' };
    return resolvePathExpression(node.expression, ctx, seen);
  }
  const direct = staticString(node);
  if (direct !== null) return { value: direct };
  if (ts.isIdentifier(node)) {
    if (ctx.constStrings.has(node.text)) return { value: ctx.constStrings.get(node.text) };
    const imp = ctx.imports.get(node.text);
    if (imp) {
      const resolved = resolveImportedConst(imp, seen);
      if (resolved !== null) return { value: resolved };
      return { unresolved: `imported const ${node.text} from ${imp.spec}` };
    }
    return { unresolved: `identifier ${node.text}` };
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const sub = resolvePathExpression(span.expression, ctx, seen);
      if (sub.unresolved !== undefined) return { unresolved: `template span ${span.expression.getText?.() ?? '?'}` };
      out += sub.value + span.literal.text;
    }
    return { value: out };
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = resolvePathExpression(node.left, ctx, seen);
    const r = resolvePathExpression(node.right, ctx, seen);
    if (l.unresolved === undefined && r.unresolved === undefined) return { value: l.value + r.value };
    return { unresolved: 'string concatenation with non-static operand' };
  }
  return { unresolved: `expression ${node.getText?.(ctx.sf) ?? node.kind}` };
}

function resolveImportedConst(imp, seen) {
  const target = resolveSpecifierToFile(imp);
  if (!target) return null;
  const key = `${target}::${imp.imported}`;
  if (seen.has(key)) return null;
  seen.add(key);
  let text;
  try {
    text = readSourceFile(target);
  } catch {
    return null;
  }
  const sf = parseSource(target, text);
  const ctx = moduleContext(sf);
  if (imp.imported === 'default') return null;
  if (ctx.constStrings.has(imp.imported)) return ctx.constStrings.get(imp.imported);
  // function/const forms we cannot statically resolve
  return null;
}

function resolveSpecifierToFile(imp) {
  // imp.localFile is recorded by callers that know the importer path; when the
  // importer is not known we cannot place a relative spec. Callers set
  // `imp.from` (repo-relative importer) so relative resolution works.
  if (!imp.from) return null;
  const dir = path.posix.dirname(imp.from);
  const rel = path.posix.normalize(path.posix.join(dir, imp.spec));
  const base = rel.replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]) {
    if (fileExistsRepo(cand)) return cand;
  }
  return null;
}

// ── fs helpers bound to the repo ────────────────────────────────────────────
import { existsSync, readFileSync } from 'node:fs';
export function readSourceFile(relFile) {
  return readFileSync(path.join(WEB_SRC, relFile), 'utf8');
}
function fileExistsRepo(relFile) {
  return existsSync(path.join(WEB_SRC, relFile));
}

/**
 * Extract `<Route>` entries from a JSX route table with correct nesting.
 * Returns entries: { declaredPath, path, kind, redirectTo, line, unresolved }.
 * `prefix` is applied to relative children (module mounts). `ctx` must carry
 * `sf` (source file), `constStrings`, `imports`, and `from` (repo-relative file)
 * so imported path constants resolve.
 */
export function extractJsxRoutes(sf, ctx, prefix = '') {
  const ts = loadTs();
  const aliases = routeTagAliases(sf);
  const out = [];
  // Fail closed: a source file with parse diagnostics cannot be trusted to
  // enumerate routes. The caller (build-route-inventory) turns the parseFailure
  // obligation into a hard failure; here we emit no false pages.
  if (!isParseClean(sf)) return out;

  const tagOf = (node) => {
    const opening = ts.isJsxElement(node) ? node.openingElement : node;
    return opening.tagName.getText(sf);
  };
  const isRoute = (node) => classifyRouteTag(tagOf(node), aliases) === 'Route';

  // Descend generically to find sibling/descendant <Route> elements, stopping at
  // each Route (routeFromElement owns its subtree). `conditional` records that
  // the Route sits behind a JSX expression / logical / ternary, so we preserve
  // mount-predicate context instead of silently flattening it.
  function scanDescendants(node, conditional, found) {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      if (isRoute(node)) {
        found.push({ el: node, opening: ts.isJsxElement(node) ? node.openingElement : node, conditional });
        return;
      }
    }
    const childConditional =
      conditional || ts.isJsxExpression(node) || ts.isConditionalExpression(node) ||
      (ts.isBinaryExpression(node) &&
        (node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
         node.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
         node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken));
    ts.forEachChild(node, (c) => scanDescendants(c, childConditional, found));
  }

  const walk = (node, parentPath) => {
    ts.forEachChild(node, (child) => {
      if ((ts.isJsxElement(child) || ts.isJsxSelfClosingElement(child)) && isRoute(child)) {
        // routeFromElement recursively handles this route's children with the
        // correct parent path; do NOT also walk them generically (that would
        // re-emit them with an undefined parent).
        out.push(...routeFromElement(child, ts.isJsxElement(child) ? child.openingElement : child, parentPath, false));
        return;
      }
      walk(child, parentPath);
    });
  };

  function routeFromElement(element, opening, parentPath, mountConditional) {
    const entries = [];
    let pathAttr = null;
    let indexAttr = false;
    let redirectTo = null;
    let elementNode = null;
    for (const attr of opening.attributes.properties) {
      if (!ts.isJsxAttribute(attr)) continue;
      const name = attr.name.getText(sf);
      if (name === 'path') pathAttr = attr.initializer;
      else if (name === 'index') indexAttr = true;
      else if (name === 'element') elementNode = attr.initializer;
    }
    // redirect detection: element is <Navigate to=...> directly, or a
    // conditional that includes one (recorded but not treated as a hard redirect).
    const navTo = findNavigateTarget(elementNode, sf, ctx);
    let redirectDirect = false;
    if (navTo) {
      redirectTo = navTo.to ?? (navTo.static === false ? `(expr: ${navTo.expr})` : null);
      redirectDirect = navTo.direct === true;
    }

    // Child routes, traversed through fragments and JSX expressions (round-3).
    const childRoutes = [];
    if (ts.isJsxElement(element)) {
      for (const c of element.children) scanDescendants(c, false, childRoutes);
    }

    let pathValue = null;
    let unresolved = null;
    let isLayout = false;
    if (pathAttr) {
      const r = resolvePathExpression(pathAttr, ctx);
      if (r.unresolved !== undefined) unresolved = r.unresolved;
      else pathValue = r.value;
    } else if (indexAttr) {
      pathValue = parentPath ?? '';
    } else if (childRoutes.length > 0) {
      // Pathless LAYOUT route with children (e.g. the auth/billing gate
      // wrapper). It renders only its <Outlet/>; its children carry the paths.
      isLayout = true;
    } else {
      unresolved = 'route with neither path nor index attribute';
    }

    let concrete = null;
    if (pathValue !== null) {
      if (pathValue.startsWith('/') || pathValue === '*') concrete = pathValue;
      else if (pathValue === '') concrete = parentPath ?? '';
      else concrete = parentPath ? `${parentPath.replace(/\/$/, '')}/${pathValue}` : pathValue;
      // collapse any relative module prefix
      if (prefix && concrete && !concrete.startsWith('/')) concrete = `${prefix}/${concrete}`;
    }

    if (!isLayout) {
      entries.push({
        declaredPath: pathAttr ? `path=${pathValue ?? '(unresolved)'}` : indexAttr ? 'index' : '(unresolved)',
        path: concrete,
        kind: redirectDirect ? 'redirect' : concrete === '*' ? 'not-found' : 'page',
        redirectTo,
        redirectConditional: Boolean(redirectTo) && !redirectDirect,
        mountConditional,
        line: lineOf(sf, opening),
        unresolved,
        isWildcard: typeof concrete === 'string' && concrete.endsWith('/*'),
      });
    }

    // nested child <Route>s (relative) — including those inside fragments and
    // JSX expressions. The parent for a conditional child is still the enclosing
    // route's concrete path; the mount predicate is preserved on the child.
    const childParent = isLayout ? parentPath : concrete ?? parentPath;
    for (const c of childRoutes) {
      entries.push(...routeFromElement(c.el, c.opening, childParent, c.conditional));
    }
    return entries;
  }

  walk(sf, prefix || undefined);
  return out;
}

/** Look for a `<Navigate to="...">` inside an element expr. `direct` is true
 *  only when the Navigate is the root returned element (a hard redirect), not
 *  nested inside a conditional/ternary. */
function findNavigateTarget(node, sf, ctx) {
  const ts = loadTs();
  if (!node) return null;
  const exprRoot = ts.isJsxExpression(node) ? node.expression : node;
  let found = null;
  let direct = false;
  const visit = (n, isRoot) => {
    if (found) return;
    if (ts.isJsxSelfClosingElement(n) || ts.isJsxElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      if (opening.tagName.getText(sf) === 'Navigate') {
        for (const attr of opening.attributes.properties) {
          if (ts.isJsxAttribute(attr) && attr.name.getText(sf) === 'to') {
            const r = resolvePathExpression(attr.initializer, ctx);
            if (r.value !== undefined) found = { to: r.value, static: true, direct: isRoot };
            else found = { to: null, static: false, direct: isRoot, expr: r.unresolved };
          }
        }
      }
    }
    ts.forEachChild(n, (c) => visit(c, false));
  };
  if (exprRoot) visit(exprRoot, true);
  if (found) found.direct = found.direct && exprRoot && (ts.isJsxSelfClosingElement(exprRoot) || ts.isJsxElement(exprRoot));
  return found;
}

/**
 * Imperative dispatchers (WorkspaceVNextRoutes, VNextDirectoryRoutes, …) carry
 * their paths as string literals, `new Set([...])` members, template literals
 * and anchored regexes. Extract every route-shaped literal so a newly added
 * path in ANY of those forms appears — and anything that is not span-extractable
 * (a computed path) is reported unresolved by callers via the module's own
 * reachability note.
 */
export function extractLiteralPaths(sf, ctx) {
  const ts = loadTs();
  const strings = new Set();
  const patterns = [];
  const visit = (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const t = node.text;
      if (isRouteLike(t)) strings.add(t);
    } else if (ts.isTemplateExpression(node)) {
      const r = resolvePathExpression(node, ctx);
      if (r.value !== undefined && isRouteLike(r.value)) strings.add(r.value);
      else patterns.push({ kind: 'template-unresolved', text: node.getText(sf) });
    } else if (ts.isRegularExpressionLiteral(node)) {
      const src = node.getText(sf);
      patterns.push({ kind: 'regex', text: src });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { strings: [...strings], patterns };
}

function isRouteLike(t) {
  return typeof t === 'string' && t.startsWith('/') && /^\/[A-Za-z0-9_:\/?=&.-]*$/.test(t) && t.length > 1;
}

export { isRouteLike };

/**
 * Does this repo-relative module declare a react-router route table?
 *
 * True when the parsed source contains a JSX `<Route>` element carrying a
 * `path`/`index` attribute, or a `<Routes>` element. This REPLACES a filename
 * whitelist (e.g. `/(Routes|routes)\.tsx$/`): any module — however named,
 * statically imported, lazily imported or require()d — that actually declares
 * routes is discovered, and a module that only re-exports routes is followed
 * through the reexport graph by the caller.
 */
export function ownsRouteTable(relFile) {
  const ts = loadTs();
  let text;
  try {
    text = readSourceFile(relFile);
  } catch {
    return false;
  }
  const sf = parseSource(relFile, text);
  let owns = false;
  const visit = (n) => {
    if (owns) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) {
      const opening = ts.isJsxElement(n) ? n.openingElement : n;
      const tag = opening.tagName.getText(sf);
      if (tag === 'Routes') owns = true;
      if (tag === 'Route') {
        for (const attr of opening.attributes.properties) {
          if (ts.isJsxAttribute(attr) && (attr.name.getText(sf) === 'path' || attr.name.getText(sf) === 'index')) { owns = true; break; }
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return owns;
}

/**
 * Imperative route ownership: a module that declares its concrete paths as a
 * `new Set([...])` / array literal of ≥2 route-shaped strings, or as an anchored
 * `^/...` regular expression (the Workspace/Engagement dispatcher pattern).
 * Together with ownsRouteTable() this is what makes discovery content-driven —
 * there is no filename allow-list, so a renamed or newly-added router module is
 * still found, and a module that declares no paths is not credited with any.
 */
export function declaresRouteStructure(relFile) {
  const ts = loadTs();
  let text;
  try {
    text = readSourceFile(relFile);
  } catch {
    return false;
  }
  const sf = parseSource(relFile, text);
  let owns = false;
  const routeStrings = (arr) =>
    arr.elements.length >= 2 &&
    arr.elements.every((el) => ts.isStringLiteral(el) && isRouteLike(el.text));
  const visit = (n) => {
    if (owns) return;
    if (ts.isNewExpression(n)) {
      const a = n.arguments?.[0];
      if (a && ts.isArrayLiteralExpression(a) && routeStrings(a)) owns = true;
    } else if (ts.isArrayLiteralExpression(n) && routeStrings(n)) {
      owns = true;
    } else if (ts.isRegularExpressionLiteral(n)) {
      const src = n.getText(sf).replace(/\\\//g, '/');
      if (/^\/\^\\?\/[A-Za-z]/.test(src)) owns = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return owns;
}

/**
 * Why does this module own routes? Returns a short reason string, or null.
 * The union of signals — no filename allow-list — so a router module is found
 * whether it declares a JSX table, an imperative Set/regex dispatcher, an
 * exported `is*Path`/`match*Route` predicate, or imports a `*routes*.ts`
 * enumerable contract. A plain page component matches none of these and is
 * therefore never credited with routes it does not declare.
 */
export function routeModuleRole(relFile) {
  if (ownsRouteTable(relFile)) return 'jsx-route-table';
  if (declaresRouteStructure(relFile)) return 'imperative-route-structure';
  const ts = loadTs();
  let text;
  try {
    text = readSourceFile(relFile);
  } catch {
    return null;
  }
  const sf = parseSource(relFile, text);
  const hasExportModifier = (node) => {
    const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
    return Boolean(mods && mods.some((m) => m.kind === ts.SyntaxKind.ExportKeyword));
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && hasExportModifier(stmt) && /^(is|match)[A-Z].*(Path|Route|Routes)$/.test(stmt.name.text)) {
      return 'exports-route-predicate';
    }
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && /^(is|match)[A-Z].*(Path|Route|Routes)$/.test(d.name.text)) return 'exports-route-predicate';
      }
    }
    // `export { isXPath } from './pe-routes.js'` — a RE-EXPORTED predicate is
    // still a route-ownership signal (VNextProgramElementsRoutes pattern).
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        const name = (el.propertyName ?? el.name).text;
        if (/^(is|match)[A-Z].*(Path|Route|Routes)$/.test(name)) return 'reexports-route-predicate';
      }
    }
  }
  for (const ref of collectModuleRefs(sf)) {
    if (/(routes?|route-state)\.(ts|tsx|js|jsx)$/.test(ref.spec)) return 'imports-route-contract';
  }
  return null;
}
