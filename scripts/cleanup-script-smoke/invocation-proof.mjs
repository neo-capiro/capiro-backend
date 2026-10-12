/**
 * CleanUp1 — ONE bounded SOURCE-PROVEN direct-invocation proof, shared by the
 * reviewed config-guard codemod (`config-guard-codemod.mjs`) and the dedicated
 * configuration-conditioned deriver (`contract.mjs`). This module exists so the
 * boundary proof is not duplicated (and cannot silently diverge) between the two
 * consumers.
 *
 * WHAT IT PROVES
 *   `proveDirectInvocation(expr, { rel, sf })` returns true ONLY when the AST
 *   expression `expr` provably evaluates TRUE exactly when `rel` (the subject's
 *   canonical repo-relative path) is the invoked CLI entrypoint. It is
 *   deliberately fail-closed: any shape it does not recognize returns false.
 *
 * RECOGNIZED SHAPES (each bound to the ACTUAL subject path/basename/extension)
 *   - `require.main === module` (either operand order, `==`/`===`) with the REAL,
 *     unshadowed `require`/`module` globals;
 *   - a conjunction `A && B` where one side proves direct invocation and the
 *     other is provably ALWAYS TRUE under direct invocation (see SAFE GUARDS);
 *   - `A ?? <falsy literal>` where `A` proves direct invocation (the fallback
 *     only fires when argv[1] is nullish, which cannot happen on a real direct
 *     invocation);
 *   - a source-proven local alias `const x = <direct-invocation expr>` resolved
 *     LEXICALLY, declared before the reference, immutable (never assigned);
 *   - an IIFE whose body has at least one DEFINITE (unconditional) terminal
 *     return proving direct invocation and whose every other reachable return is
 *     a falsy literal (the real `isDirectRun`/`invokedDirectly` IIFE shape);
 *   - a regex basename test `/<literal>(ext)?$/.test(<argv[1]-derived>)` — the
 *     regex's BOUNDED grammar is expanded to its finite language and compared to
 *     the subject basename (no constraint is ever dropped);
 *   - `process.argv[1].endsWith(<literal>)` / `.includes(<literal>)` where the
 *     literal identifies the subject under the METHOD's real path semantics and
 *     the receiver derives from the REAL argv[1] by an IDENTITY-PRESERVING
 *     transform. `startsWith(<basename>)` is NOT provable from the basename
 *     (the absolute directory prefix is unknown) and is refused.
 *
 * SAFE GUARDS (always-true under direct invocation; used only as the conjunctive
 * companion of a direct-invocation disjunct)
 *   - bare `process.argv[1]` (present — the script path — under a direct run);
 *   - `typeof <operand> <cmp> '<type>'` for a KNOWN REAL global/argv value with
 *     the PROVED expected type and the exact comparison/type:
 *       `process` (object), `process.argv` (object), any `process.argv[i]`
 *       (string), `require` (function), `module` (object), `console` (object);
 *       `!== 'undefined'` is safe for any of them. An UNKNOWN symbol (e.g.
 *       `typeof unavailable !== 'undefined'`) is NOT a safe guard;
 *   - `Array.isArray(process.argv)` for the REAL argv array;
 *   - a conjunction of the above.
 *   A guard conjunction in the OTHER order (`unknown && <direct-run>`), or a
 *   direct-run-looking disjunct inside an unknown-conditioned branch, is refused.
 *
 * Refused on purpose (nearby mutations): a wrong literal / wrong regex stem, a
 * reaggregated or otherwise transformed argv argument (`.slice`, arbitrary
 * methods), an unknown symbol in a typeof guard, a shadowed
 * `process`/`require`/`module`, a conditional-only / possibly-unreached /
 * `finally`-overridden IIFE return, an assigned (redeclared/reassigned) alias, an
 * unresolved bare identifier, and a `path`/`url` call whose receiver is not the
 * exact imported namespace/member with the supported arity.
 *
 * PATH IDENTITY (transforms allowed only when they preserve the basename)
 *   A value "derives from argv[1]" when it is the REAL `process.argv[1]`, or a
 *   lexically-resolved, IMMUTABLE, source-order-correct local bound to such a
 *   value (optionally through the exact `?? ''` absent fallback), or that value
 *   normalized ONLY by `.replace(/\\/g, '/')` (a separator normalization), or
 *   `path.basename(...)` / `path.resolve(...)` called with EXACTLY ONE argument
 *   on the imported `node:path` NAMESPACE, or `fileURLToPath(import.meta.url)`
 *   from the imported `node:url`. Any OTHER method/transform (e.g. `.slice(0, 1)`)
 *   is refused — a mere subtree argv reference is not identity, and an aliased
 *   named import bound to a `path`-looking local is not the real namespace.
 */
import { createRequire } from 'node:module';

let TS = null;
try {
  TS = createRequire(import.meta.url)('typescript');
} catch {
  TS = null;
}

/** A name bound more than once in the same scope → refuse (ambiguous). */
const SHADOWED = Symbol('shadowed');

/** Function-like nodes that open a lexical scope / are not descended into. */
function isFunctionLike(node) {
  if (!node || !TS) return false;
  const k = node.kind;
  return (
    k === TS.SyntaxKind.FunctionDeclaration ||
    k === TS.SyntaxKind.FunctionExpression ||
    k === TS.SyntaxKind.ArrowFunction ||
    k === TS.SyntaxKind.MethodDeclaration ||
    k === TS.SyntaxKind.GetAccessor ||
    k === TS.SyntaxKind.SetAccessor ||
    k === TS.SyntaxKind.Constructor
  );
}

/** Strip redundant parentheses. */
function unwrap(node) {
  let n = node;
  while (n && n.kind === TS.SyntaxKind.ParenthesizedExpression) n = n.expression;
  return n;
}

/** The nearest enclosing function-like / SourceFile scope owner of `node`. */
function enclosingScopeOwner(node) {
  let p = node;
  while (p) {
    if (p.kind === TS.SyntaxKind.SourceFile || isFunctionLike(p)) return p;
    p = p.parent;
  }
  return null;
}

/** Binding names introduced by a binding pattern. */
function patternNames(name) {
  const out = [];
  if (!name) return out;
  if (TS.isIdentifier(name)) {
    out.push(name.text);
    return out;
  }
  if (name.kind === TS.SyntaxKind.ArrayBindingPattern || name.kind === TS.SyntaxKind.ObjectBindingPattern) {
    for (const el of name.elements) {
      if (el && el.kind !== TS.SyntaxKind.OmittedExpression) out.push(...patternNames(el.name));
    }
  }
  return out;
}

/** Names an import declaration binds. */
function importNames(decl) {
  const out = [];
  const cl = decl.importClause;
  if (!cl) return out;
  if (cl.name && TS.isIdentifier(cl.name)) out.push(cl.name.text);
  const nb = cl.namedBindings;
  if (nb) {
    if (nb.kind === TS.SyntaxKind.NamespaceImport) {
      if (nb.name && TS.isIdentifier(nb.name)) out.push(nb.name.text);
    } else if (nb.elements) {
      for (const el of nb.elements) if (el && el.name && TS.isIdentifier(el.name)) out.push(el.name.text);
    }
  }
  return out;
}

const DECL_CACHE = new WeakMap();

/** Names/declarations bound DIRECTLY in `owner`'s own scope. */
function ownerDeclarations(owner) {
  if (DECL_CACHE.has(owner)) return DECL_CACHE.get(owner);
  const m = new Map();
  const put = (name, info) => {
    if (!name) return;
    if (m.has(name) && m.get(name) !== info) m.set(name, SHADOWED);
    else m.set(name, info);
  };
  if (isFunctionLike(owner) && owner.parameters) {
    for (const p of owner.parameters) for (const nm of patternNames(p.name)) put(nm, SHADOWED);
  }
  const body = owner.kind === TS.SyntaxKind.SourceFile ? owner : owner.body;
  const declKindOf = (vd) => {
    const list = vd.parent;
    if (list && list.flags & TS.NodeFlags.Const) return 'const';
    if (list && list.flags & TS.NodeFlags.Let) return 'let';
    return 'var';
  };
  const walk = (n) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.FunctionDeclaration) {
      if (n.name && TS.isIdentifier(n.name)) put(n.name.text, SHADOWED);
      return;
    }
    if (n.kind === TS.SyntaxKind.ClassDeclaration || n.kind === TS.SyntaxKind.ClassExpression) {
      if (n.name && TS.isIdentifier(n.name)) put(n.name.text, SHADOWED);
      return;
    }
    if (n.kind === TS.SyntaxKind.ImportDeclaration) {
      for (const nm of importNames(n)) put(nm, SHADOWED);
      return;
    }
    if (isFunctionLike(n)) return;
    if (n.kind === TS.SyntaxKind.VariableDeclaration) {
      for (const nm of patternNames(n.name)) {
        put(nm, { kind: 'var', decl: n, init: n.initializer, declKind: declKindOf(n) });
      }
      return;
    }
    TS.forEachChild(n, walk);
  };
  walk(body);
  DECL_CACHE.set(owner, m);
  return m;
}

/** True iff `name` used at `node` is shadowed by ANY enclosing lexical binding. */
function shadowedAt(name, node) {
  let owner = enclosingScopeOwner(node);
  while (owner) {
    const m = ownerDeclarations(owner);
    if (m.has(name)) return true;
    owner = owner.parent ? enclosingScopeOwner(owner.parent) : null;
  }
  return false;
}

/** The nearest lexically-resolved `const`/`let`/`var NAME = <init>` binding, or null. */
function resolveVarBinding(name, node) {
  let owner = enclosingScopeOwner(node);
  while (owner) {
    const m = ownerDeclarations(owner);
    if (m.has(name)) {
      const v = m.get(name);
      return v && v.kind === 'var' ? v : null; // param/function/import/class shadow
    }
    owner = owner.parent ? enclosingScopeOwner(owner.parent) : null;
  }
  return null;
}

/**
 * Every assignment TARGET (identifier node) of `name` in the source: a plain /
 * compound / LOGICAL assignment (`=`,`+=`,…,`&&=`,`||=`,`??=`) target, a
 * destructuring-assignment element, or a `++`/`--` operand. The FULL
 * assignment-operator set is covered, never a five-operator subset.
 */
function assignmentTargets(name, sf) {
  if (!TS) return [];
  const targets = [];
  const assignOps = new Set(
    [
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
    ].filter((k) => typeof k === 'number'),
  );
  const patternTargets = (l) => {
    const found = [];
    const scan = (c) => {
      if (!c) return;
      if (c.kind === TS.SyntaxKind.BinaryExpression) return; // nested assignment, not part of THIS target
      if (c.kind === TS.SyntaxKind.Identifier && c.text === name) found.push(c);
      if (c.kind === TS.SyntaxKind.ShorthandPropertyAssignment && c.name && c.name.text === name) found.push(c.name);
      if (c.kind === TS.SyntaxKind.PropertyAssignment && c.name && c.name.text === name) found.push(c.name);
      TS.forEachChild(c, scan);
    };
    scan(l);
    return found;
  };
  const visit = (n) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.BinaryExpression && assignOps.has(n.operatorToken && n.operatorToken.kind)) {
      const l = n.left;
      if (l && l.kind === TS.SyntaxKind.Identifier && l.text === name) targets.push(l);
      else if (l && (l.kind === TS.SyntaxKind.ArrayLiteralExpression || l.kind === TS.SyntaxKind.ObjectLiteralExpression)) targets.push(...patternTargets(l));
    }
    if (
      (n.kind === TS.SyntaxKind.PrefixUnaryExpression || n.kind === TS.SyntaxKind.PostfixUnaryExpression) &&
      (n.operator === TS.SyntaxKind.PlusPlusToken || n.operator === TS.SyntaxKind.MinusMinusToken)
    ) {
      const o = n.operand;
      if (o && o.kind === TS.SyntaxKind.Identifier && o.text === name) targets.push(o);
    }
    TS.forEachChild(n, visit);
  };
  visit(sf);
  return targets;
}

/** True iff `name` is assigned / ++/-- anywhere in the source (broad). */
function nameIsAssigned(name, sf) {
  return assignmentTargets(name, sf).length > 0;
}

/**
 * True iff the SAME lexical binding `binding` (not merely some other-scope name
 * with the same spelling) is assigned / mutated. An assigned alias is not the
 * argv[1] / direct-invocation value at its use site; an illegal `const`
 * assignment throws at runtime and is likewise not a successful proof.
 */
function bindingAssigned(name, binding, sf) {
  if (!binding || !binding.decl) return false;
  if (!nameIsAssigned(name, sf)) return false;
  return assignmentTargets(name, sf).some((t) => {
    const rb = resolveVarBinding(name, t);
    return !!rb && rb.decl === binding.decl;
  });
}

/* ------------------------------------------------------------------------- *
 * Subject path identity.
 * ------------------------------------------------------------------------- */

/** basename / stem / extension of a repo-relative subject path. */
function subjectParts(rel) {
  const path = String(rel || '').replace(/\\/g, '/');
  const slash = path.lastIndexOf('/');
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  const ext = dot > 0 ? base.slice(dot) : '';
  const stem = ext ? base.slice(0, dot) : base;
  return { base, stem, ext };
}

/**
 * True iff a string-literal argument identifies the subject under the METHOD's
 * REAL path semantics. `process.argv[1]` is the ABSOLUTE invoked script path
 * whose BASENAME is known but whose directory prefix is not:
 *   - `endsWith(lit)` is provably true iff `lit` is a suffix of the basename;
 *   - `includes(lit)` is provably true iff `lit` is a substring of the basename;
 *   - `startsWith(lit)` is NOT provable from the basename (the absolute prefix
 *     is unknown) and is refused — a bare stem is never a full-path prefix.
 */
export function literalIdentifiesSubject(method, literal, rel) {
  if (typeof literal !== 'string' || literal.length === 0) return false;
  const { base } = subjectParts(rel);
  if (method === 'endsWith') return base.endsWith(literal);
  if (method === 'includes') return base.includes(literal);
  return false;
}

/** Split `/body/flags`, honoring escapes and character classes. */
function splitRegexLiteral(raw) {
  if (typeof raw !== 'string' || raw[0] !== '/') return null;
  let i = 1;
  let inClass = false;
  for (; i < raw.length; i++) {
    const c = raw[i];
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '[') inClass = true;
    else if (c === ']') inClass = false;
    else if (c === '/' && !inClass) break;
  }
  if (i >= raw.length) return null;
  return { body: raw.slice(1, i), flags: raw.slice(i + 1) };
}

/** Expand a simple character class `[...]` into its single-character members. */
function expandRegexClass(cls) {
  const out = [];
  for (let i = 0; i < cls.length; i++) {
    const c = cls[i];
    if (c === '\\') {
      const d = cls[i + 1];
      if (d === undefined || /[A-Za-z0-9]/.test(d)) return null; // \d /\w /\b are not literals
      out.push(d);
      i++;
      continue;
    }
    if (cls[i + 1] === '-' && cls[i + 2] !== undefined) {
      const a = c.charCodeAt(0);
      const b = cls[i + 2].charCodeAt(0);
      if (b < a) return null;
      if (b - a + 1 > 256) return null;
      for (let k = a; k <= b; k++) out.push(String.fromCharCode(k));
      i += 2;
      continue;
    }
    out.push(c);
  }
  return out.length ? out : null;
}

/**
 * The FINITE set of strings a BOUNDED regex body can match, or null when the
 * grammar is not a finite literal grammar (unbounded quantifiers, `.`, `\d`,
 * backreferences, …). Supports literal characters, escaped non-alphanumeric
 * literals, `[...]` classes (with optional `?`), `(...)` groups with `|`
 * alternation (with optional `?`), and end/start anchors handled by the caller.
 * It NEVER drops a constraint: EVERY alternative the real regex can match is
 * enumerated, so `/stem(\.wrong)?$/` is proven NOT to match `stem.ts`.
 */
function expandRegexLanguage(body) {
  if (body.length > 512) return null;
  const n = body.length;
  let pos = 0;
  function parseAlt(inGroup) {
    let seq = [''];
    const alts = [];
    const appendPiece = (pieces) => {
      if (seq.length * pieces.length > 256) return false;
      const next = [];
      for (const s of seq) for (const p of pieces) next.push(s + p);
      seq = next;
      return true;
    };
    while (pos < n) {
      const c = body[pos];
      if (c === ')') {
        if (!inGroup) return null;
        break;
      }
      if (c === '|') {
        alts.push(...seq);
        if (alts.length > 256) return null;
        seq = [''];
        pos++;
        continue;
      }
      if (c === '(') {
        pos++;
        const inner = parseAlt(true);
        if (inner === null) return null;
        if (body[pos] !== ')') return null;
        pos++;
        let optional = false;
        if (body[pos] === '?') {
          optional = true;
          pos++;
        }
        if (body[pos] === '*' || body[pos] === '+' || body[pos] === '{') return null;
        if (!appendPiece(optional ? [...inner, ''] : inner)) return null;
        continue;
      }
      if (c === '[') {
        let j = pos + 1;
        let esc = false;
        while (j < n) {
          const d = body[j];
          if (esc) {
            esc = false;
            j++;
            continue;
          }
          if (d === '\\') {
            esc = true;
            j++;
            continue;
          }
          if (d === ']') break;
          j++;
        }
        if (j >= n) return null;
        const cls = body.slice(pos + 1, j);
        if (cls === '' || cls.startsWith('^')) return null;
        const members = expandRegexClass(cls);
        if (!members) return null;
        pos = j + 1;
        let optional = false;
        if (body[pos] === '?') {
          optional = true;
          pos++;
        }
        if (body[pos] === '*' || body[pos] === '+' || body[pos] === '{') return null;
        if (!appendPiece(optional ? [...members, ''] : members)) return null;
        continue;
      }
      if (c === '\\') {
        const d = body[pos + 1];
        if (d === undefined || /[A-Za-z0-9]/.test(d)) return null;
        if (!appendPiece([d])) return null;
        pos += 2;
        continue;
      }
      if ('.*+?{}^$'.includes(c)) return null;
      if (!appendPiece([c])) return null;
      pos++;
    }
    if (inGroup && pos >= n) return null; // unclosed group
    alts.push(...seq);
    if (alts.length > 256) return null;
    return alts;
  }
  const res = parseAlt(false);
  if (res === null || pos !== n) return null;
  return res;
}

/** Parse a regex-literal source into `{ anchoredStart, anchoredEnd, language }`, or null. */
function parseBoundedRegex(regexText) {
  const split = splitRegexLiteral(regexText);
  if (!split || split.flags !== '') return null;
  let body = split.body;
  let anchoredStart = false;
  let anchoredEnd = false;
  if (body.startsWith('^')) {
    anchoredStart = true;
    body = body.slice(1);
  }
  if (body.endsWith('$') && !body.endsWith('\\$')) {
    anchoredEnd = true;
    body = body.slice(0, -1);
  }
  const language = expandRegexLanguage(body);
  if (!language) return null;
  return { anchoredStart, anchoredEnd, language };
}

/**
 * The single literal a regex denotes iff its whole bounded grammar is one fixed
 * string; otherwise null. (Retained export; identification below never drops
 * constraints.)
 */
export function extractRegexLiteral(raw) {
  const parsed = parseBoundedRegex(raw);
  if (!parsed || parsed.language.length !== 1) return null;
  const lit = parsed.language[0];
  if (!lit || !/^[A-Za-z0-9._@-]+$/.test(lit)) return null;
  return lit;
}

/**
 * True iff the bounded regex literal MATCHES the subject's actual invoked path.
 * The path's basename is known (the directory prefix is not): a `…$` pattern
 * matches iff one of its finite alternatives is a SUFFIX of the basename; a
 * `^…$` pattern iff the basename IS one of them; an unanchored pattern iff one
 * is a substring. Every alternative is enumerated — a dropped optional group can
 * never credit a subject its real regex rejects.
 */
export function regexIdentifiesSubject(regexText, rel) {
  const parsed = parseBoundedRegex(regexText);
  if (!parsed) return false;
  // The receiver may be the absolute argv path. A basename alone cannot prove
  // its directory prefix; conservatively refuse start-anchored patterns.
  if (parsed.anchoredStart) return false;
  const { base } = subjectParts(rel);
  for (const s of parsed.language) {
    if (parsed.anchoredStart && parsed.anchoredEnd) {
      if (base === s) return true;
    } else if (parsed.anchoredEnd) {
      if (base.endsWith(s)) return true;
    } else if (parsed.anchoredStart) {
      if (base.startsWith(s)) return true;
    } else if (base.includes(s)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * Real Node globals + argv[1] derivation.
 * ------------------------------------------------------------------------- */

/** True iff `node` is the REAL, unshadowed global identifier `name`. */
function realGlobal(node, name) {
  return !!node && node.kind === TS.SyntaxKind.Identifier && node.text === name && !shadowedAt(name, node);
}

/** True iff `node` is a plain `process.argv` access on the real `process`. */
function realArgvAccess(node) {
  return (
    !!node &&
    node.kind === TS.SyntaxKind.PropertyAccessExpression &&
    !node.questionDotToken &&
    node.name &&
    node.name.text === 'argv' &&
    realGlobal(node.expression, 'process')
  );
}

/** True iff `node` is exactly `process.argv[<literal 0 or 1>]` on the real argv. */
function realArgvSlot(node, expectedIndex) {
  const e = unwrap(node);
  if (!e || e.kind !== TS.SyntaxKind.ElementAccessExpression || e.questionDotToken) return false;
  if (!realArgvAccess(e.expression)) return false;
  const a = e.argumentExpression;
  if (!a) return false;
  const v =
    a.kind === TS.SyntaxKind.NumericLiteral
      ? Number(a.text)
      : a.kind === TS.SyntaxKind.StringLiteral
        ? Number(a.text)
        : NaN;
  return Number.isInteger(v) && (expectedIndex == null || v === expectedIndex);
}

/** A literal whose evaluation is unconditionally falsy (and side-effect free). */
function isFalsyLiteral(node) {
  const e = unwrap(node);
  if (!e) return false;
  if (e.kind === TS.SyntaxKind.FalseKeyword || e.kind === TS.SyntaxKind.NullKeyword) return true;
  if (e.kind === TS.SyntaxKind.NumericLiteral && Number(e.text) === 0) return true;
  if (e.kind === TS.SyntaxKind.StringLiteral && e.text === '') return true;
  if (realGlobal(e, 'undefined')) return true;
  return false;
}

/** True iff `node` is a regex literal that matches only backslash characters. */
function isBackslashRegex(node) {
  if (!node || node.kind !== TS.SyntaxKind.RegularExpressionLiteral) return false;
  const raw = node.getText();
  const last = raw.lastIndexOf('/');
  if (last <= 0) return false;
  const body = raw.slice(1, last).trim();
  const flags = raw.slice(last + 1);
  if (!/^g?$/.test(flags)) return false;
  // `/\\/` (matches one backslash) or `/\\\\/` (two) — a pure separator
  // normalization. Anything else (a character class, an unrelated pattern) is
  // not an identity-preserving basename transform.
  return /^\\{2,4}$/.test(body);
}

/** True iff the call is `.replace(<single-backslash-regex>, '/')`. */
function isBackslashToSlashReplace(call) {
  const callee = unwrap(call.expression);
  if (!callee || callee.kind !== TS.SyntaxKind.PropertyAccessExpression || !callee.name) return false;
  if (callee.name.text !== 'replace') return false;
  if (!isBackslashRegex(call.arguments[0])) return false;
  const rep = call.arguments[1];
  return !!rep && (rep.kind === TS.SyntaxKind.StringLiteral || rep.kind === TS.SyntaxKind.NoSubstitutionTemplateLiteral) && rep.text === '/';
}

/** True iff `text` is `import.meta.url`. */
function isImportMetaUrl(node) {
  const e = unwrap(node);
  if (!e) return false;
  if (e.kind === TS.SyntaxKind.PropertyAccessExpression && !e.questionDotToken) {
    if (e.name && e.name.text === 'url') {
      const obj = unwrap(e.expression);
      return !!obj && obj.kind === TS.SyntaxKind.MetaProperty && /import\s*\.\s*meta/.test(obj.getText());
    }
  }
  return false;
}

/**
 * The lexically-resolved IMPORT binding descriptor for `name` at `node`, or null:
 *   { module, kind: 'namespace'|'named'|'default', imported }.
 * A real local/parameter/function named `name` shadows the import (returns null).
 */
function importBinding(name, node) {
  if (resolveVarBinding(name, node)) return null; // a real local shadows the import
  let owner = enclosingScopeOwner(node);
  while (owner) {
    const stmts = owner.kind === TS.SyntaxKind.SourceFile ? owner.statements : owner.body && owner.body.statements ? owner.body.statements : [];
    for (const stmt of stmts) {
      if (stmt.kind !== TS.SyntaxKind.ImportDeclaration) continue;
      const spec = stmt.moduleSpecifier && stmt.moduleSpecifier.kind === TS.SyntaxKind.StringLiteral ? stmt.moduleSpecifier.text : null;
      if (!spec) continue;
      const cl = stmt.importClause;
      if (!cl) continue;
      const nb = cl.namedBindings;
      if (nb && nb.kind === TS.SyntaxKind.NamespaceImport && nb.name && nb.name.text === name) {
        return { module: spec, kind: 'namespace', imported: null };
      }
      if (nb && nb.elements) {
        for (const el of nb.elements) {
          if (el && el.name && el.name.text === name) {
            const imported = el.propertyName && el.propertyName.text ? el.propertyName.text : el.name.text;
            return { module: spec, kind: 'named', imported };
          }
        }
      }
      if (cl.name && cl.name.text === name) return { module: spec, kind: 'default', imported: 'default' };
    }
    owner = owner.parent ? enclosingScopeOwner(owner.parent) : null;
  }
  return null;
}

/** True iff `name` is a NAMESPACE import of one of `modules`, at `node`. */
function importedNamespaceFrom(name, modules, node) {
  const b = importBinding(name, node);
  return !!b && b.kind === 'namespace' && modules.includes(b.module);
}

/** True iff `e.arguments` is exactly one non-spread argument. */
function oneArgument(e) {
  if (!e.arguments || e.arguments.length !== 1) return false;
  const a = e.arguments[0];
  return !(a && a.kind === TS.SyntaxKind.SpreadElement);
}

/**
 * True iff `node` derives from the REAL `process.argv[1]` by an identity-
 * preserving transform. Only: argv[1] itself; a lexically-resolved, IMMUTABLE,
 * source-order-correct local bound to it through the exact `??` absent fallback;
 * `.replace(/\\/g, '/')`; `path.basename`/`path.resolve` (EXACTLY ONE argument)
 * on the imported `node:path` NAMESPACE; `fileURLToPath(import.meta.url)` on the
 * named `node:url` import.
 */
function derivesFromArgv1(node, rel, sf, seen = new Set()) {
  const e = unwrap(node);
  if (!e) return false;
  if (e.kind === TS.SyntaxKind.ElementAccessExpression) return realArgvSlot(e, 1);
  if (e.kind === TS.SyntaxKind.Identifier) {
    const b = resolveVarBinding(e.text, e);
    if (!b || !b.init || !b.decl) return false;
    if (seen.has(b.decl)) return false;
    // The alias must be IMMUTABLE and declared BEFORE the reference: an assigned
    // (reassigned / compound / logical) name is not the argv[1] value at the use
    // site, and a declaration that does not precede the reference cannot be.
    if (bindingAssigned(e.text, b, sf)) return false;
    if (typeof b.decl.getStart === 'function' && typeof e.getStart === 'function' && b.decl.getStart() >= e.getStart()) return false;
    seen.add(b.decl);
    return derivesFromArgv1(b.init, rel, sf, seen);
  }
  if (e.kind === TS.SyntaxKind.BinaryExpression && e.operatorToken && e.operatorToken.kind === TS.SyntaxKind.QuestionQuestionToken) {
    return derivesFromArgv1(e.left, rel, sf, seen) && isFalsyLiteral(e.right);
  }
  if (e.kind === TS.SyntaxKind.CallExpression) {
    const callee = unwrap(e.expression);
    if (callee && callee.kind === TS.SyntaxKind.PropertyAccessExpression && callee.name) {
      const prop = callee.name.text;
      if (prop === 'replace') return derivesFromArgv1(callee.expression, rel, sf, seen) && isBackslashToSlashReplace(e);
      if (prop === 'basename' || prop === 'resolve') {
        // The receiver must be the REAL `node:path` NAMESPACE — never a named
        // import aliased to a `path`-looking name — with the EXACT arity 1 (an
        // extra argument changes the resolved basename).
        if (!importedNamespaceFrom(text(callee.expression), ['node:path', 'path'], callee.expression)) return false;
        if (!oneArgument(e)) return false;
        return derivesFromArgv1(e.arguments[0], rel, sf, seen);
      }
      return false;
    }
    if (callee && callee.kind === TS.SyntaxKind.Identifier) {
      const b = importBinding(callee.text, callee);
      if (b && b.kind === 'named' && (b.imported === 'basename' || b.imported === 'resolve') && ['node:path', 'path'].includes(b.module)) {
        if (!oneArgument(e)) return false;
        return derivesFromArgv1(e.arguments[0], rel, sf, seen);
      }
      if (b && b.kind === 'named' && b.imported === 'fileURLToPath' && ['node:url', 'url'].includes(b.module)) {
        if (!oneArgument(e)) return false;
        return isImportMetaUrl(e.arguments[0]);
      }
    }
    return false;
  }
  return false;
}

function text(node) {
  return node && node.getText ? node.getText() : '';
}

/* ------------------------------------------------------------------------- *
 * Safe always-true guards under a direct invocation.
 * ------------------------------------------------------------------------- */

/** The proved Node type of a known real global/argv value, or null. */
function knownRealValueType(node) {
  const e = unwrap(node);
  if (!e) return null;
  if (e.kind === TS.SyntaxKind.ElementAccessExpression) return realArgvSlot(e, 1) ? 'string' : null;
  if (realArgvAccess(e)) return 'object';
  if (realGlobal(e, 'process')) return 'object';
  if (realGlobal(e, 'require')) return 'function';
  if (realGlobal(e, 'module')) return 'object';
  if (realGlobal(e, 'console')) return 'object';
  return null;
}

/** True iff `e` is `typeof <known real value> <cmp> '<proved type>'`. */
function typeofGuardSafe(e) {
  if (!e || e.kind !== TS.SyntaxKind.BinaryExpression) return false;
  const op = e.operatorToken && e.operatorToken.kind;
  if (op !== TS.SyntaxKind.EqualsEqualsEqualsToken && op !== TS.SyntaxKind.ExclamationEqualsEqualsToken) return false;
  let operand;
  let other;
  if (e.left && e.left.kind === TS.SyntaxKind.TypeOfExpression) {
    operand = e.left.expression;
    other = e.right;
  } else if (e.right && e.right.kind === TS.SyntaxKind.TypeOfExpression) {
    operand = e.right.expression;
    other = e.left;
  } else {
    return false;
  }
  if (!other || other.kind !== TS.SyntaxKind.StringLiteral) return false;
  const t = knownRealValueType(operand);
  if (!t) return false;
  if (op === TS.SyntaxKind.ExclamationEqualsEqualsToken && other.text === 'undefined') return true;
  if (op === TS.SyntaxKind.EqualsEqualsEqualsToken && other.text === t) return true;
  return false;
}

/** True iff `e` is `Array.isArray(process.argv)` on the real argv array. */
function arrayIsArrayRealArgv(e) {
  if (!e || e.kind !== TS.SyntaxKind.CallExpression) return false;
  const callee = unwrap(e.expression);
  if (!callee || callee.kind !== TS.SyntaxKind.PropertyAccessExpression || !callee.name) return false;
  if (callee.name.text !== 'isArray') return false;
  if (!realGlobal(unwrap(callee.expression), 'Array')) return false;
  return realArgvAccess(unwrap(e.arguments[0]));
}

/** True iff `e` is provably TRUE under a direct invocation. */
function safeDirectContextGuard(e) {
  const x = unwrap(e);
  if (!x) return false;
  if (realArgvSlot(x, 1)) return true; // present under a direct run
  if (typeofGuardSafe(x)) return true;
  if (arrayIsArrayRealArgv(x)) return true;
  if (x.kind === TS.SyntaxKind.BinaryExpression && x.operatorToken && x.operatorToken.kind === TS.SyntaxKind.AmpersandAmpersandToken) {
    return safeDirectContextGuard(x.left) && safeDirectContextGuard(x.right);
  }
  return false;
}

/* ------------------------------------------------------------------------- *
 * require.main === module
 * ------------------------------------------------------------------------- */

/** True iff `a`/`b` are the REAL `require.main` and `module` (either order). */
function requireMainModuleCompare(a, b) {
  const ra = unwrap(a);
  const rb = unwrap(b);
  const isRequireMain = (x) =>
    !!x &&
    x.kind === TS.SyntaxKind.PropertyAccessExpression &&
    !x.questionDotToken &&
    x.name &&
    x.name.text === 'main' &&
    x.expression &&
    realGlobal(x.expression, 'require');
  const isModule = (x) => !!x && x.kind === TS.SyntaxKind.Identifier && x.text === 'module' && !shadowedAt('module', x);
  return (isRequireMain(ra) && isModule(rb)) || (isRequireMain(rb) && isModule(ra));
}

/* ------------------------------------------------------------------------- *
 * IIFE definite-control-flow proof.
 * ------------------------------------------------------------------------- */

/** Statically-decided truth of a literal-ish condition, or null. */
function staticTruth(cond) {
  const c = unwrap(cond);
  if (!c) return null;
  if (c.kind === TS.SyntaxKind.TrueKeyword) return true;
  if (c.kind === TS.SyntaxKind.FalseKeyword) return false;
  if (c.kind === TS.SyntaxKind.NumericLiteral) return Number(c.text) !== 0;
  if (c.kind === TS.SyntaxKind.StringLiteral) return c.text.length > 0;
  if (c.kind === TS.SyntaxKind.NullKeyword) return false;
  if (c.kind === TS.SyntaxKind.PrefixUnaryExpression && c.operator === TS.SyntaxKind.ExclamationToken) {
    const inner = staticTruth(c.operand);
    return inner === null ? null : !inner;
  }
  return null;
}

/** True iff a subtree contains ANY abrupt transfer outside a nested function. */
function containsAbrupt(node) {
  if (!node) return false;
  const k = node.kind;
  if (
    k === TS.SyntaxKind.ReturnStatement ||
    k === TS.SyntaxKind.ThrowStatement ||
    k === TS.SyntaxKind.BreakStatement ||
    k === TS.SyntaxKind.ContinueStatement
  ) {
    return true;
  }
  if (isFunctionLike(node)) return false;
  let found = false;
  TS.forEachChild(node, (c) => {
    if (!found && containsAbrupt(c)) found = true;
  });
  return found;
}

/**
 * True iff evaluating `node` cannot throw and has no observable side effect — the
 * only expressions that may precede a definite IIFE return. `process.argv[i]`
 * reads, literals, safe `??`/`&&`/`||`/comparison operands, `!`/`typeof` and
 * `undefined` are safe; an arbitrary call (`unknownOperation()`), property read,
 * assignment or identifier is NOT (it may throw), so a following return is not
 * definite.
 */
function exprProvablySafe(node) {
  const e = unwrap(node);
  if (!e) return false;
  const k = e.kind;
  if (
    k === TS.SyntaxKind.NumericLiteral ||
    k === TS.SyntaxKind.StringLiteral ||
    k === TS.SyntaxKind.TrueKeyword ||
    k === TS.SyntaxKind.FalseKeyword ||
    k === TS.SyntaxKind.NullKeyword ||
    k === TS.SyntaxKind.RegularExpressionLiteral ||
    k === TS.SyntaxKind.NoSubstitutionTemplateLiteral
  ) {
    return true;
  }
  if (k === TS.SyntaxKind.Identifier) return e.text === 'undefined' && !shadowedAt('undefined', e);
  if (realArgvSlot(e, null)) return true;
  if (realArgvAccess(e)) return true;
  if (k === TS.SyntaxKind.ElementAccessExpression) {
    return !e.questionDotToken && exprProvablySafe(e.expression) && exprProvablySafe(e.argumentExpression);
  }
  if (k === TS.SyntaxKind.TypeOfExpression) {
    const operand = unwrap(e.expression);
    // typeof an unbound identifier is safe; a property access can throw and a
    // lexical identifier can be in its temporal dead zone.
    return !!operand && ((operand.kind === TS.SyntaxKind.Identifier && !shadowedAt(operand.text, operand)) || exprProvablySafe(operand));
  }
  if (k === TS.SyntaxKind.BinaryExpression) {
    const op = e.operatorToken && e.operatorToken.kind;
    const safeOps = [
      TS.SyntaxKind.QuestionQuestionToken,
      TS.SyntaxKind.AmpersandAmpersandToken,
      TS.SyntaxKind.BarBarToken,
      TS.SyntaxKind.EqualsEqualsToken,
      TS.SyntaxKind.EqualsEqualsEqualsToken,
      TS.SyntaxKind.ExclamationEqualsToken,
      TS.SyntaxKind.ExclamationEqualsEqualsToken,
      TS.SyntaxKind.LessThanToken,
      TS.SyntaxKind.LessThanEqualsToken,
      TS.SyntaxKind.GreaterThanToken,
      TS.SyntaxKind.GreaterThanEqualsToken,
    ];
    return safeOps.includes(op) && exprProvablySafe(e.left) && exprProvablySafe(e.right);
  }
  if (k === TS.SyntaxKind.PrefixUnaryExpression) {
    if (e.operator === TS.SyntaxKind.TypeOfKeyword) return true;
    if (e.operator === TS.SyntaxKind.ExclamationToken) return exprProvablySafe(e.operand);
  }
  return false;
}

/** The per-statement control-flow classification consumed by the IIFE proof. */
function analyzeIifeStatement(node, rel, sf, seen, definite, inTryCatch) {
  const res = { foundDirect: false, foundDirectDefinite: false, badReturn: false, mayAbrupt: false, alwaysAbrupt: false };
  if (!node) return res;
  const k = node.kind;
  const inner = { rel, sf, seen };

  const mergeReturn = (retExpr, isDefinite) => {
    if (proveDirectInvocation(retExpr, inner, new Set(seen))) {
      res.foundDirect = true;
      if (isDefinite) res.foundDirectDefinite = true;
    } else if (!isFalsyLiteral(retExpr)) {
      res.badReturn = true;
    }
  };
  const mergeChild = (child) => {
    if (!child) return;
    res.foundDirect = res.foundDirect || child.foundDirect;
    res.foundDirectDefinite = res.foundDirectDefinite || child.foundDirectDefinite;
    res.badReturn = res.badReturn || child.badReturn;
    res.mayAbrupt = res.mayAbrupt || child.mayAbrupt;
    res.alwaysAbrupt = res.alwaysAbrupt || child.alwaysAbrupt;
  };

  if (k === TS.SyntaxKind.ReturnStatement) {
    res.mayAbrupt = true;
    res.alwaysAbrupt = true;
    mergeReturn(node.expression, definite);
    return res;
  }
  if (
    k === TS.SyntaxKind.ThrowStatement ||
    k === TS.SyntaxKind.BreakStatement ||
    k === TS.SyntaxKind.ContinueStatement
  ) {
    res.mayAbrupt = true;
    res.alwaysAbrupt = true;
    return res;
  }
  if (k === TS.SyntaxKind.Block) return analyzeIifeList(node.statements, rel, sf, seen, definite, inTryCatch);
  if (k === TS.SyntaxKind.VariableStatement) {
    for (const d of node.declarationList.declarations) {
      if (d.initializer && !exprProvablySafe(d.initializer)) res.mayAbrupt = true;
    }
    return res;
  }
  if (k === TS.SyntaxKind.ExpressionStatement) {
    if (!exprProvablySafe(node.expression)) res.mayAbrupt = true;
    return res;
  }
  if (k === TS.SyntaxKind.IfStatement) {
    if (!exprProvablySafe(node.expression)) res.mayAbrupt = true;
    const t = staticTruth(node.expression);
    if (t === true) {
      mergeChild(analyzeIifeStatement(node.thenStatement, rel, sf, seen, definite, inTryCatch));
    } else if (t === false) {
      if (node.elseStatement) mergeChild(analyzeIifeStatement(node.elseStatement, rel, sf, seen, definite, inTryCatch));
    } else {
      const a = analyzeIifeStatement(node.thenStatement, rel, sf, seen, false, inTryCatch);
      const b = node.elseStatement ? analyzeIifeStatement(node.elseStatement, rel, sf, seen, false, inTryCatch) : null;
      mergeChild(a);
      if (b) mergeChild(b);
      // An undecided `if` whose then-arm may abandon control can skip later
      // statements, so a following return is no longer definite.
      res.mayAbrupt = res.mayAbrupt || a.mayAbrupt || (b ? b.mayAbrupt : true);
      res.alwaysAbrupt = a.alwaysAbrupt && !!b && b.alwaysAbrupt;
    }
    return res;
  }
  if (k === TS.SyntaxKind.TryStatement) {
    const tryR = analyzeIifeList(node.tryBlock.statements, rel, sf, seen, definite, !!node.catchClause);
    mergeChild(tryR);
    const catchR = node.catchClause ? analyzeIifeList(node.catchClause.block.statements, rel, sf, seen, false, false) : null;
    if (catchR) mergeChild(catchR);
    if (node.finallyBlock) {
      // A `return`/`throw`/`break`/`continue` in `finally` OVERRIDES the try/catch
      // result, so the try's direct return is not the returned value: refuse.
      if (containsAbrupt(node.finallyBlock)) {
        res.foundDirect = false;
        res.foundDirectDefinite = false;
        res.badReturn = true;
      } else {
        mergeChild(analyzeIifeList(node.finallyBlock.statements, rel, sf, seen, definite, false));
      }
    }
    // Any try may throw, so a following sibling is not definite.
    res.mayAbrupt = true;
    res.alwaysAbrupt = tryR.alwaysAbrupt && (!catchR || catchR.alwaysAbrupt);
    return res;
  }
  if (
    k === TS.SyntaxKind.WhileStatement ||
    k === TS.SyntaxKind.DoStatement ||
    k === TS.SyntaxKind.ForStatement ||
    k === TS.SyntaxKind.ForInStatement ||
    k === TS.SyntaxKind.ForOfStatement ||
    k === TS.SyntaxKind.SwitchStatement
  ) {
    // A return inside an iteration/switch is not definitely executed.
    res.mayAbrupt = true;
    res.alwaysAbrupt = false;
    TS.forEachChild(node, (c) => {
      if (isFunctionLike(c)) return;
      const r = analyzeIifeStatement(c, rel, sf, seen, false, inTryCatch);
      res.badReturn = res.badReturn || r.badReturn;
      res.foundDirect = res.foundDirect || r.foundDirect;
      res.foundDirectDefinite = res.foundDirectDefinite || r.foundDirectDefinite;
    });
    return res;
  }
  if (isFunctionLike(node)) return res; // a nested function's returns are not the IIFE's
  // Any other statement is treated conservatively as possibly abrupt.
  res.mayAbrupt = true;
  return res;
}

/** Analyze a statement list with a running "definite" flag. */
function analyzeIifeList(stmts, rel, sf, seen, definite, inTryCatch) {
  const out = { foundDirect: false, foundDirectDefinite: false, badReturn: false, mayAbrupt: false, alwaysAbrupt: false };
  let curDefinite = definite;
  for (const s of stmts) {
    const r = analyzeIifeStatement(s, rel, sf, seen, curDefinite, inTryCatch);
    out.foundDirect = out.foundDirect || r.foundDirect;
    out.foundDirectDefinite = out.foundDirectDefinite || r.foundDirectDefinite;
    out.badReturn = out.badReturn || r.badReturn;
    out.mayAbrupt = out.mayAbrupt || r.mayAbrupt;
    if (r.alwaysAbrupt) {
      if (curDefinite) out.alwaysAbrupt = true;
      break;
    }
    if (r.mayAbrupt) curDefinite = false;
  }
  return out;
}

/**
 * True iff the IIFE `fn` proves direct invocation: a DEFINITE (unconditional,
 * non-unknown-conditioned) terminal return proves direct invocation AND every
 * other reachable return is a falsy literal. A return a preceding possibly-
 * abrupt / possibly-throwing statement can skip, a conditional-only return, a
 * return after an early exit, or a `finally`-overridden return is NOT definite.
 */
function proveIife(fn, rel, sf, seen) {
  if (!fn.body || fn.body.kind !== TS.SyntaxKind.Block) return false; // concise arrows are not proven
  const r = analyzeIifeList(fn.body.statements, rel, sf, seen, true, false);
  return r.foundDirectDefinite && !r.badReturn;
}

/* ------------------------------------------------------------------------- *
 * The proof.
 * ------------------------------------------------------------------------- */

/**
 * True iff `expr` provably denotes "this module is the invoked CLI entrypoint"
 * for the subject path `rel`. Fail-closed: unrecognized shapes return false.
 */
export function proveDirectInvocation(expr, { rel, sf }, seen = new Set()) {
  if (!TS || !sf) return false;
  const e = unwrap(expr);
  if (!e) return false;

  if (e.kind === TS.SyntaxKind.BinaryExpression) {
    const op = e.operatorToken && e.operatorToken.kind;
    if (op === TS.SyntaxKind.EqualsEqualsToken || op === TS.SyntaxKind.EqualsEqualsEqualsToken) {
      return requireMainModuleCompare(e.left, e.right);
    }
    if (op === TS.SyntaxKind.AmpersandAmpersandToken) {
      if (proveDirectInvocation(e.left, { rel, sf }, seen) && safeDirectContextGuard(e.right)) return true;
      if (proveDirectInvocation(e.right, { rel, sf }, seen) && safeDirectContextGuard(e.left)) return true;
      return false;
    }
    if (op === TS.SyntaxKind.QuestionQuestionToken) {
      return proveDirectInvocation(e.left, { rel, sf }, seen) && isFalsyLiteral(e.right);
    }
    return false;
  }

  if (e.kind === TS.SyntaxKind.Identifier) {
    const b = resolveVarBinding(e.text, e);
    if (!b || !b.init || !b.decl) return false;
    if (seen.has(b.decl)) return false;
    // An assigned name (even an illegal const assignment, which throws at runtime
    // before main runs) is NOT a successful runtime proof — but only the SAME
    // lexical binding counts.
    if (bindingAssigned(e.text, b, sf)) return false;
    if (typeof b.decl.getStart === 'function' && typeof e.getStart === 'function' && b.decl.getStart() >= e.getStart()) {
      return false; // declaration must PRECEDE the reference
    }
    seen.add(b.decl);
    return proveDirectInvocation(b.init, { rel, sf }, seen);
  }

  if (e.kind === TS.SyntaxKind.CallExpression) {
    const callee = unwrap(e.expression);
    if (callee && (callee.kind === TS.SyntaxKind.ArrowFunction || callee.kind === TS.SyntaxKind.FunctionExpression)) {
      return proveIife(callee, rel, sf, seen);
    }
    if (callee && callee.kind === TS.SyntaxKind.PropertyAccessExpression && callee.name) {
      const prop = callee.name.text;
      const recv = unwrap(callee.expression);
      if (prop === 'test' && recv && recv.kind === TS.SyntaxKind.RegularExpressionLiteral) {
        if (!regexIdentifiesSubject(recv.getText(), rel)) return false;
        return derivesFromArgv1(e.arguments[0], rel, sf);
      }
      if (prop === 'endsWith' || prop === 'includes' || prop === 'startsWith') {
        if (!oneArgument(e)) return false;
        const arg = e.arguments[0];
        if (!arg || arg.kind !== TS.SyntaxKind.StringLiteral) return false;
        if (!derivesFromArgv1(recv, rel, sf)) return false;
        return literalIdentifiesSubject(prop, arg.text, rel);
      }
    }
    return false;
  }

  return false;
}
