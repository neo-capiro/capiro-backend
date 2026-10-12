/**
 * CleanUp1 §6.2 — per-entrypoint DOCUMENTED CLI contract derivation (strict).
 *
 * ONE source-backed implementation. The CI worker's peer
 * (`scripts/cleanup-gates/lib/script-contract.mjs`) is READ-ONLY and is not
 * touched; this module is the harness's own canonical deriver.
 *
 * Anti-false-positive rules retained (round 7 + execution-78 adverse probes):
 *   - ordinary console output is NOT usage      → usage text must be proven;
 *   - an unrelated `items.length` is NOT argv   → the condition must be bound to
 *                                                  process.argv (directly or via a
 *                                                  local derived from it);
 *   - an unused function's branch is NOT help    → only REACHABLE branches count;
 *   - an unrelated `'--help'` constant is NOT an argument test → the '--help'
 *     literal must be tested against the bound argv;
 *   - `!argv.includes('--help')` is NOT help     → the help test must be positive.
 *
 * Execution-78 repairs (four independently-reproduced false acceptances):
 *   - argv-reading helper returns an UNRELATED constant → a helper merely
 *     REFERENCING argv is NOT proof: the RETURNED VALUE must be data-flowed from
 *     an argv read. (probe: `const i = process.argv.indexOf(flag); return 'always';`)
 *   - argv helper returns `process.argv[0]` (the executable, always present under
 *     no-args) → the returned argv slot must be provably ABSENT under no-args: an
 *     element access at a computed / >=2 index, never a literal 0 or 1.
 *     (probe: `return process.argv[0];`)
 *   - a nested, UNREACHABLE helper shadows the real module helper by global
 *     last-name match → resolution is now LEXICAL/SYMBOL-AWARE: the nearest
 *     enclosing scope wins; an ambiguous same-scope binding is refused (never a
 *     global last-name match). Legitimate nested-reachable local calls preserved.
 *     (probe: `function usage(){...}` + `function unused(){ function usage(){...} }`)
 *   - an exit inside a literal-dead / conditional branch is NOT a guaranteed
 *     exit → literal-dead branches are pruned and an exit in a non-statically-
 *     decided branch is refused (fail closed); only reachable, guaranteed
 *     emission/termination counts.
 *     (probe: `if (false) process.exit(2)`)
 *
 * Execution-83 repairs (TWO independently-reproduced FALSE ACCEPTANCES left by
 * execution-78, both in the value-helper RETURN proof): a helper's returned value
 * must EXPLICITLY prove it is ABSENT under no-args — an argv read SOMEWHERE in
 * the return subtree is not proof:
 *   - a bare COMPUTED index (`return process.argv[process.argv.length - 1]`) is
 *     not a proof: under no-args argv.length-1 is 1 (the script path), a present
 *     slot. Only a LITERAL slot >= 2, or the guarded-ternary shape below, proves
 *     absence. (probe execution-83/1)
 *   - a DEFINED FALLBACK (`return process.argv[2] || 'always'`) is not a proof:
 *     `||` supplies a defined value so the required-value guard can never fire.
 *     Only an explicit absent branch (`undefined`/`null`/`''`) counts.
 *     (probe execution-83/2)
 *   - a helper with more than one REACHABLE return where any one fails to prove
 *     absence is refused as an AMBIGUOUS reachable return path (fail closed).
 *   Allowed return proves-absence dataflow, and ONLY this:
 *     (a) a bare `process.argv[<literal integer >= 2>]` slot; or
 *     (b) `i OP <literal> ? <argv slot at i> : <absent sentinel>` (either branch
 *         order), where `i` is bound in the helper to `process.argv.indexOf(...)`
 *         / `lastIndexOf(...)`, the argv slot's index references `i`, and OP is a
 *         comparison that selects the SENTINEL branch exactly when `i === -1`
 *         (its no-args value). This is the real source shape
 *         `const i = process.argv.indexOf(flag); return i >= 0 ? process.argv[i + 1] : undefined`.
 *     A computed index, a `||`/`??` fallback, an unconditional return, or any
 *     other shape proves nothing and stays UNRESOLVED.
 *
 * SOURCE-DERIVED recognition (conservative by default — an impure / dynamic /
 * ambiguous / unreadable helper stays UNRESOLVED):
 *   - argv-derived locals are bound TRANSITIVELY through a REACHABLE *local*
 *     function that (a) provably reads `process.argv`, (b) is side-effect-free,
 *     and (c) RETURNS a value read from an argv slot that can be absent under
 *     no-args. A helper that is imported (foreign), impure, dynamic, returns a
 *     constant or a guaranteed-present slot (argv[0]/argv[1]) is NOT a proof;
 *   - a REQUIRED-VALUE guard (`if (!loc)`, `if (loc == null)`) on a value-typed
 *     argv-derived local, whose taken branch EMITS usage, is a documented no-args
 *     branch;
 *   - usage text and the exit code are resolved THROUGH a lexically-resolved,
 *     reachable local usage/exit helper (nesting included): the helper must PRINT
 *     a usage-shaped line and name an explicit integer `process.exit(N)` on a
 *     REACHABLE, guaranteed path.
 *
 * Contract1048 source-derived additions (still conservative): a no-args branch is
 * recognized only when the GUARD is provably TRUE under no-args by a proven
 * absent/empty value, never by a mere argv reference:
 *   - ARGV DESTRUCTURING: `const [, , a, b] = process.argv` binds `a`/`b` to
 *     argv slots 2/3, which are ABSENT under no-args (elisions counted). Only a
 *     plain identifier at slot >= 2 qualifies; a slot 0/1 (always present), a
 *     rest element (array, never absent), or a defaulted element (defined) is
 *     NOT a proof, and the initializer must be exactly `process.argv` (a slice
 *     or any other expression is refused).
 *   - COMPOUND REQUIRED-VALUE GUARDS: `!a || !b`, `!a && !b` etc. are decided
 *     SOUNDLY over `||`/`&&` (an OR is true when either side is definitely true;
 *     an AND only when BOTH are). Only proven absent/empty leaves contribute, so
 *     `!a || b` is true (the `!a` disjunct alone suffices) but `!a && b` is
 *     undecided and refused.
 *   - EMPTY-STRING DATAFLOW: `const x = (arg('flag') ?? '').toUpperCase()` — an
 *     ABSENT value from a lexically-resolved, pure local VALUE argv helper,
 *     routed through an exact `?? ''` nullish fallback and then only pure
 *     EMPTY-PRESERVING string methods, is provably `''` (falsy) under no-args.
 *     A bare `.toUpperCase()` on an absent value (throws, not `''`), a defined
 *     non-empty fallback, or a non-empty-preserving method is refused.
 *   The boolean `flag()` helper shape, the multi-return `find`/`indexOf`/`next`
 *     `arg()` helper of the backfill scripts, and any configured-default /
 *     env-based branch remain UNRESOLVED (see the handoff).
 *
 * Contract1051 repairs (six independently-reproduced FALSE ACCEPTANCES in real
 * tiny-Node execution — root-contract1051-probes-result.json). All proofs are
 * now bound to the ACTUAL lexical declaration used by the guard, with the EXACT
 * absent/empty value modelled, the real unshadowed `process` identity required,
 * an unmutated `const` binding required, and genuine JS short-circuit / effect
 * order respected:
 *   - EXACT VALUE: a destructured absent slot is `undefined`, not any falsy
 *     sentinel — `a === null` and `a === ''` are FALSE (probes 1 & 2); only
 *     `!a`, `a == null`, `a === undefined` (and `!==` forms) fire.
 *   - REAL PROCESS IDENTITY: a local/parameter named `process` is NOT
 *     `process.argv` (probe 3).
 *   - LEXICAL BINDING: a guard identifier is resolved to its actual declaration;
 *     a function parameter or inner binding that SHADOWS the absent local makes
 *     the guard unresolved (probe 4).
 *   - NO-MUTATION / NO-SHADOW: the binding must be a `const` (probe 5) and the
 *     name must not be assigned / ++/-- anywhere.
 *   - SHORT-CIRCUIT / EFFECT ORDER: a compound guard is decided only when the
 *     runtime DEFINITELY reaches true without first executing an unknown /
 *     maybe-throwing subexpression: `!file || unknown` is safe, but
 *     `unknown || !file` (e.g. `boom() || !a`) is refused (probe 6).
 *   Destructured/empty names are deliberately NOT placed into the legacy broad
 *   all/value sets, so `requiredValueGuard` can never equate an absent slot with
 *   `null`/`undefined`/`''`. Empty-string transforms unwrap parentheses and
 *   require zero-argument known empty-preserving intrinsics. Run-l2 / env- or
 *   config-based defaults and complex multi-return helpers stay UNRESOLVED.
 *
 * Contract1076 repairs (SIX further independently-reproduced FALSE ACCEPTANCES in
 * real tiny-Node execution — root-contract1074-order-probes-result.json). These
 * repair the underlying PROOF MODEL rather than adding broad text/name
 * exceptions; the separate actual Usage/exit/audit checks remain mandatory:
 *   - CROSS-SCOPE CAPTURE: a guard reading a local captured from a DIFFERENT
 *     function scope is refused — `main(); const[,,a]=process.argv; function
 *     main(){ if(!a)... }` runs `main` in the const's TDZ, so "declaration start
 *     before reference text" does NOT prove runtime initialization across a
 *     function boundary. Same-scope (direct local) initialization still qualifies.
 *   - STATEMENT-ORDER REACHABILITY: `collectBranches`/`resolveEmission` are now
 *     statement-order aware — a guard or usage/exit AFTER an unconditional
 *     return/throw is UNREACHABLE and contributes nothing (probes 2 & 6).
 *   - BOUNDED HELPER BODY GRAMMAR: the permissive method-NAME purity whitelist is
 *     replaced by an explicit argv-reader body grammar (index bindings + a
 *     supported absent-sentinel return). `const x = undefined; x.trim();` throws
 *     before the returned slot, so an unsupported body stays UNRESOLVED (probe 3).
 *   - ARGUMENT-BOUND HELPER PROOF: an index-guarded helper proves absence only
 *     for a flag the controlled no-args argv cannot contain; the ACTUAL call
 *     argument is substituted into the helper's indexOf search string and must be
 *     a literal flag name starting '-' (probe 4). `arg(<execPath literal>)` is a
 *     PRESENT argv[1] and is refused. A literal is never treated as a flag merely
 *     because its parameter/helper is named flag/arg.
 *   - BROAD PROTOTYPE DIRTYING: ANY unshadowed `String.prototype` reference —
 *     direct assignment, `Object.assign(String.prototype, ...)`, computed access
 *     or an alias — disqualifies the modelled empty-preserving methods; arbitrary
 *     prototype metaprogramming is not modelled (probe 5). The real
 *     diag-leg-readpaths pattern (no prototype mutation) is preserved.
 *
 * Exit policy: a documented branch MUST name an explicit `process.exit(N)`
 * reachable and guaranteed from the branch — directly or through a resolved local
 * helper. A branch that prints usage without a single explicit integer exit that
 * is guaranteed resolves to `exit:null`; the harness then FAILS it unresolved. An
 * arbitrary integer is never accepted and a conventional exit is never invented.
 * An AMBIGUOUS exit (two distinct integers, a non-literal exit, or an exit only on
 * a conditional/dead path) also resolves to `exit:null` and is failed closed.
 */
import { createRequire } from 'node:module';
import { proveDirectInvocation } from './invocation-proof.mjs';

let TS = null;
try {
  TS = createRequire(import.meta.url)('typescript');
} catch {
  TS = null;
}

/**
 * The ONE named, immutable smoke-context for the CleanUp1 missing-DATABASE_URL
 * guard recognition.
 *
 * Every isolated smoke invocation runs with `DATABASE_URL` ABSENT (the container
 * inherits no host env). Under exactly THIS context — and only this context — the
 * deriver additionally recognizes the configuration-conditioned no-args contract
 * a product entrypoint carries after the reviewed codemod inserts a main-owned
 * inline guard: a literal, unshadowed global `process.env.DATABASE_URL`
 * missing-value test whose taken branch prints an INLINE Usage line and names a
 * DEFINITE integer `process.exit(N)`.
 *
 * The generic `deriveContract(source, rel)` (context omitted) stays CONSERVATIVE
 * and recognizes none of this: the two contexts are distinct by IDENTITY, so a
 * caller that does not name the smoke context can never accidentally widen the
 * scanner. `Object.freeze` makes the constant immutable (a mutation attempt is a
 * refused no-op in the module scope, and the frozen flag is asserted by controls).
 */
export const MISSING_DATABASE_URL_SMOKE_CONTEXT = Object.freeze({
  id: 'cleanup1.missing-database-url-smoke',
  databaseUrl: 'required-absent',
  description:
    'CleanUp1 smoke context: isolated invocations run with DATABASE_URL absent, so a literal ' +
    'global `!process.env.DATABASE_URL` guard that prints inline Usage and exits with a definite ' +
    'integer is the documented configuration-conditioned no-args contract.',
});

/** Explicit documentation for CLIs whose error handling or configuration
 * branches exceed the conservative source scanner. This declares expected
 * exits only; the smoke runner must still observe usage, matching native exits,
 * termination and a clean syscall audit for every invocation.
 *
 * A leading source comment may contain one line such as:
 *   @cleanup-smoke noArgsExit=2 helpExit=0
 */
function explicitSmokeDocumentation(sf) {
  const source = sf.text;
  const comments = TS.getLeadingCommentRanges(source, 0) ?? [];
  const lines = comments.flatMap(({ pos, end }) => source.slice(pos, end).split(/\r?\n/))
    .map((line) => line.replace(/^\s*(?:\/\*\*?|\*|\/\/)?\s*/, '').replace(/\s*\*\/\s*$/, '').trim())
    .filter((line) => line.startsWith('@cleanup-smoke'));
  if (!lines.length) return null;
  if (lines.length !== 1) return { error: 'duplicate explicit smoke documentation' };
  const match = /^@cleanup-smoke noArgsExit=(0|[1-9]\d{0,2})(?: helpExit=(0|[1-9]\d{0,2}))?$/.exec(lines[0]);
  if (!match || Number(match[1]) > 255 || (match[2] !== undefined && Number(match[2]) > 255)) {
    return { error: 'malformed explicit smoke documentation' };
  }
  return { noArgsExit: Number(match[1]), ...(match[2] === undefined ? {} : { helpExit: Number(match[2]) }) };
}

const USAGE_TEXT = /\busage\b|\boptions\b|\bcommands\b/i;
const PRINT_CALLEE =
  /console\.(log|error|info|warn)|process\.(stdout|stderr)\.write|printUsage|showUsage|printHelp|showHelp/i;

/**
 * contract1076: the former permissive method-NAME purity whitelist
 * (`SAFE_PURE_METHODS` / `SAFE_PURE_FUNCS`) was REMOVED. A whitelisted method
 * name does NOT prove a pure helper — `const x = undefined; x.trim();` throws on
 * the undefined receiver BEFORE any returned slot is reached, yet `trim` is a
 * "pure" name. A value argv helper body is now accepted ONLY by the explicit
 * statement/shape grammar in `helperBodySupported` below (a bounded argv-reader
 * grammar: index bindings + a supported absent-sentinel return), never by the
 * names of methods it happens to call.
 */

/**
 * Pure string methods that PRESERVE the empty string: applied to `''` they
 * return `''` again. Used only for the empty-string dataflow proof below, so a
 * value that is provably `''` under no-args stays provably falsy.
 */
const EMPTY_PRESERVING_METHODS = new Set(['toUpperCase', 'toLowerCase', 'trim', 'trimStart', 'trimEnd']);

/** Assignment tokens (a value helper that assigns is not pure). */
const ASSIGN_TOKENS = new Set(
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
/** Prefix/postfix ++/-- tokens (a value helper that mutates is not pure). */
const UPDATE_TOKENS = new Set(
  (TS ? [TS.SyntaxKind.PlusPlusToken, TS.SyntaxKind.MinusMinusToken] : []).filter(
    (k) => typeof k === 'number',
  ),
);
/** Function-like bodies whose contents are NOT descended into while scanning. */
const DEFERRED_FN = new Set(
  (TS
    ? [
        TS.SyntaxKind.FunctionDeclaration,
        TS.SyntaxKind.FunctionExpression,
        TS.SyntaxKind.ArrowFunction,
        TS.SyntaxKind.MethodDeclaration,
        TS.SyntaxKind.GetAccessor,
        TS.SyntaxKind.SetAccessor,
        TS.SyntaxKind.Constructor,
        TS.SyntaxKind.ConstructorDeclaration,
      ]
    : []
  ).filter((k) => typeof k === 'number'),
);

const DEFERRED = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunction',
  'ClassDeclaration',
  'ClassExpression',
  'MethodDeclaration',
  'GetAccessor',
  'SetAccessor',
]);

/**
 * Source-level argv-mutation flag for the CURRENT derivation (set by
 * deriveContract before any proof runs). A source that assigns / mutates
 * `process.argv` (or an alias of it) invalidates the "noargs argv.length === 2"
 * premise, so NO absence proof may be derived from such a source
 * (contract1062 probe 9). deriveContract is synchronous and never re-entrant,
 * so a per-derivation module flag is safe.
 */
let ARGV_MUTATED = false;

/** Array methods that mutate their receiver in place. */
const MUTATING_ARGV_METHODS = new Set([
  'push', 'pop', 'shift', 'unshift', 'splice', 'sort', 'reverse', 'fill', 'copyWithin',
]);

function scriptKindFor(name) {
  return /\.(ts|mts|cts)$/.test(name) ? TS.ScriptKind.TS : TS.ScriptKind.JS;
}

function text(n) {
  return n && n.getText ? n.getText() : '';
}

/** Does this subtree reference process.argv (directly)? */
function referencesArgv(node) {
  return /\bprocess\.argv\b/.test(text(node));
}

/**
 * If `node` is an element access on `process.argv`, return its index expression
 * node; otherwise null. This is the ONLY argv read that can produce an ABSENT
 * value under no-args (argv[0]/argv[1] are always present).
 */
/** The argv index expression of an element access, but NEVER under a mutated argv. */
function argvElementAccessIndex(node) {
  if (ARGV_MUTATED) return null; // argv was assigned/mutated in source (probe 9)
  if (!node || node.kind !== TS.SyntaxKind.ElementAccessExpression) return null;
  const obj = node.expression;
  if (!obj || obj.kind !== TS.SyntaxKind.PropertyAccessExpression) return null;
  const nm = obj.name;
  if (!nm || nm.text !== 'argv') return null;
  const base = obj.expression;
  if (!base || base.kind !== TS.SyntaxKind.Identifier || base.text !== 'process') return null;
  // The base identifier must be the REAL, UNSHADOWED global `process` — not a
  // local/parameter that merely shares the name (contract1051 probe 3).
  if (nameShadowedAt('process', base)) return null;
  return node.argumentExpression ?? null;
}

/** True iff `idx` is a literal argv slot that is ABSENT under no-args (>= 2). */
function indexIsAbsentLiteral(idx) {
  if (!idx) return false;
  let v = null;
  if (idx.kind === TS.SyntaxKind.NumericLiteral || idx.kind === TS.SyntaxKind.StringLiteral) {
    v = Number(idx.text);
  } else {
    return false;
  }
  return Number.isInteger(v) && v >= 2;
}

/**
 * The exact absent-value sentinel `expr` denotes (contract1062):
 *   'undefined' | 'null' | 'empty' (the empty string) — or null when it is not
 * an explicit absent sentinel. A parameter / local / import shadowing the
 * global `undefined` identifier is NOT the undefined literal (probe 8), so it
 * yields null here.
 */
function sentinelKind(expr) {
  if (!expr) return null;
  if (expr.kind === TS.SyntaxKind.Identifier && expr.text === 'undefined') {
    return nameShadowedAt('undefined', expr) ? null : 'undefined';
  }
  if (expr.kind === TS.SyntaxKind.NullKeyword) return 'null';
  if (expr.kind === TS.SyntaxKind.StringLiteral && expr.text === '') return 'empty';
  return null;
}

/** Literal numeric value of a (possibly sign-prefixed) numeric literal, else null. */
function literalNumber(e) {
  if (!e) return null;
  if (e.kind === TS.SyntaxKind.NumericLiteral) return Number(e.text);
  if (
    e.kind === TS.SyntaxKind.PrefixUnaryExpression &&
    e.operator === TS.SyntaxKind.MinusToken &&
    e.operand &&
    e.operand.kind === TS.SyntaxKind.NumericLiteral
  ) {
    return -Number(e.operand.text);
  }
  return null;
}

/** Comparison operator kinds usable in an argv-index presence/absence guard. */
function isComparisonOp(k) {
  return (
    k === TS.SyntaxKind.LessThanToken ||
    k === TS.SyntaxKind.LessThanEqualsToken ||
    k === TS.SyntaxKind.GreaterThanToken ||
    k === TS.SyntaxKind.GreaterThanEqualsToken ||
    k === TS.SyntaxKind.EqualsEqualsToken ||
    k === TS.SyntaxKind.EqualsEqualsEqualsToken ||
    k === TS.SyntaxKind.ExclamationEqualsToken ||
    k === TS.SyntaxKind.ExclamationEqualsEqualsToken
  );
}

/** Does `expr` reference identifier `name` anywhere? */
function exprReferencesName(expr, name) {
  let found = false;
  const visit = (n) => {
    if (found || !n) return;
    if (n.kind === TS.SyntaxKind.Identifier && n.text === name) {
      found = true;
      return;
    }
    TS.forEachChild(n, visit);
  };
  visit(expr);
  return found;
}

/**
 * Identifiers in `fn` bound to a `process.argv.indexOf(...)` / `lastIndexOf(...)`
 * result. These are the ONLY index values whose runtime value is -1 under
 * no-args (the flag is absent), so a guard on them can establish the absent path.
 */
function indexOfBoundNames(fn) {
  const names = new Set();
  const visit = (n) => {
    if (!n) return;
    if (DEFERRED_FN.has(n.kind)) return;
    if (n.kind === TS.SyntaxKind.VariableDeclaration && TS.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      if (init.kind === TS.SyntaxKind.CallExpression) {
        const callee = init.expression;
        if (callee && callee.kind === TS.SyntaxKind.PropertyAccessExpression) {
          const prop = callee.name && callee.name.text;
          if ((prop === 'indexOf' || prop === 'lastIndexOf') && /\bprocess\.argv\b/.test(text(callee.expression))) {
            names.add(n.name.text);
          }
        }
      }
    }
    TS.forEachChild(n, visit);
  };
  visit(fn.body);
  return names;
}

/**
 * Truth of an `index OP literal` comparison when the index value is -1 (its
 * no-args value), or null when the condition is not such a comparison.
 */
function guardTruthAtIndexMissing(cond, indexNames) {
  if (!cond || cond.kind !== TS.SyntaxKind.BinaryExpression) return null;
  const op = cond.operatorToken && cond.operatorToken.kind;
  if (!isComparisonOp(op)) return null;
  const l = cond.left;
  const r = cond.right;
  const lIdx = l && l.kind === TS.SyntaxKind.Identifier && indexNames.has(l.text);
  const rIdx = r && r.kind === TS.SyntaxKind.Identifier && indexNames.has(r.text);
  let a;
  let b;
  if (lIdx && !rIdx) {
    a = -1;
    b = literalNumber(r);
  } else if (rIdx && !lIdx) {
    a = literalNumber(l);
    b = -1;
  } else {
    return null;
  }
  if (a === null || b === null) return null;
  switch (op) {
    case TS.SyntaxKind.LessThanToken:
      return a < b;
    case TS.SyntaxKind.LessThanEqualsToken:
      return a <= b;
    case TS.SyntaxKind.GreaterThanToken:
      return a > b;
    case TS.SyntaxKind.GreaterThanEqualsToken:
      return a >= b;
    case TS.SyntaxKind.EqualsEqualsToken:
    case TS.SyntaxKind.EqualsEqualsEqualsToken:
      return a === b;
    case TS.SyntaxKind.ExclamationEqualsToken:
    case TS.SyntaxKind.ExclamationEqualsEqualsToken:
      return a !== b;
    default:
      return null;
  }
}

/**
 * If a conditional return `cond ? A : B` EXPLICITLY proves an absent value under
 * no-args, return the exact sentinel it yields ('undefined'|'null'|'empty');
 * otherwise null. Exactly one branch is an absent sentinel and the other reads
 * an argv slot indexed by an indexOf-derived local, with the guard selecting the
 * sentinel branch when that local is -1. This is the real
 * `i >= 0 ? process.argv[i + 1] : undefined` shape — never a bare computed index
 * and never a `||`-fallback (probes execution-83/1 & /2). The sentinel is
 * modelled EXACTLY: a helper that returns `null` / `''` yields that value, never
 * a fabricated `undefined` (contract1062 probes 1 & 2).
 */
function ternaryAbsentSentinel(expr, indexNames) {
  if (!expr || expr.kind !== TS.SyntaxKind.ConditionalExpression) return null;
  const tSent = sentinelKind(expr.whenTrue);
  const fSent = sentinelKind(expr.whenFalse);
  if (!!tSent === !!fSent) return null; // exactly ONE explicitly-absent branch
  const argvBranch = tSent ? expr.whenFalse : expr.whenTrue;
  const idx = argvElementAccessIndex(argvBranch);
  if (!idx) return null; // the other branch must actually read an argv slot
  const guardTruth = guardTruthAtIndexMissing(expr.condition, indexNames);
  if (guardTruth === null) return null;
  const sentinelTakenWhenMissing = tSent ? guardTruth === true : guardTruth === false;
  if (!sentinelTakenWhenMissing) return null;
  for (const nm of indexNames) if (exprReferencesName(idx, nm)) return tSent || fSent;
  return null;
}

/**
 * The exact absent sentinel a returned expression EXPLICITLY proves under
 * no-args (or null). Supported: a bare `process.argv[<literal >= 2>]` slot
 * (⇒ 'undefined'), or the guarded ternary above (⇒ its own sentinel). A bare
 * computed index (`process.argv[process.argv.length - 1]`) and a defined
 * fallback (`process.argv[2] || 'x'`) prove nothing.
 */
function exprAbsentSentinel(expr, indexNames) {
  if (!expr) return null;
  const idx = argvElementAccessIndex(expr);
  if (idx) return indexIsAbsentLiteral(idx) ? 'undefined' : null;
  return ternaryAbsentSentinel(expr, indexNames);
}

/**
 * contract1076: true iff `expr` is a `process.argv.indexOf(...)` /
 * `lastIndexOf(...)` call on the REAL, unmutated argv — the only index binding a
 * supported argv-reader body may declare.
 */
function isSupportedIndexOfInit(expr) {
  const e = unwrapParens(expr);
  if (!e || e.kind !== TS.SyntaxKind.CallExpression) return false;
  const callee = e.expression;
  if (!callee || callee.kind !== TS.SyntaxKind.PropertyAccessExpression) return false;
  const prop = callee.name && callee.name.text;
  if (prop !== 'indexOf' && prop !== 'lastIndexOf') return false;
  return isExactArgvIdentifier(callee.expression);
}

/**
 * The bounded argv-reader BODY grammar (contract1076). A helper body is
 * supported ONLY when every top-level statement is one of:
 *   - a variable statement whose every declarator binds a name to a
 *     `process.argv.indexOf|lastIndexOf(...)` call (an index binding); or
 *   - a `return <supported-absent-sentinel expression>` (see exprAbsentSentinel
 *     — a bare absent argv slot, or the guarded `i >= 0 ? argv[i+1] : sentinel`
 *     ternary); or
 *   - an empty statement.
 * Any other statement (a bare method call such as `x.trim()`, an assignment, a
 * throw, an `if`, a nested block, a dynamic call) makes the body UNSUPPORTED.
 * At least one supported return is required. This replaces the old permissive
 * method-name purity scan, so `const x = undefined; x.trim(); return argv[2]`
 * is refused even though `trim` was formerly "pure".
 */
function helperBodySupported(fn) {
  if (!fn || !fn.body) return false;
  const indexNames = indexOfBoundNames(fn);
  if (fn.body.kind !== TS.SyntaxKind.Block) {
    // Expression-bodied arrow: the body IS the returned expression.
    return exprAbsentSentinel(fn.body, indexNames) !== null;
  }
  let sawReturn = false;
  for (const stmt of fn.body.statements) {
    const k = stmt.kind;
    if (k === TS.SyntaxKind.EmptyStatement) continue;
    if (k === TS.SyntaxKind.VariableStatement) {
      for (const d of stmt.declarationList.declarations) {
        if (!TS.isIdentifier(d.name) || !d.initializer || !isSupportedIndexOfInit(d.initializer)) return false;
      }
      continue;
    }
    if (k === TS.SyntaxKind.ReturnStatement) {
      if (exprAbsentSentinel(stmt.expression, indexNames) === null) return false;
      sawReturn = true;
      continue;
    }
    return false;
  }
  return sawReturn;
}

/**
 * The `process.argv.indexOf|lastIndexOf(<search>)` SEARCH expressions declared in
 * `fn`. These are the flag strings whose absence under no-args the helper relies
 * on; a call site must bind its ACTUAL argument to them (contract1076 case 4).
 */
function indexOfSearchExprs(fn) {
  const out = [];
  const visit = (n) => {
    if (!n) return;
    if (DEFERRED_FN.has(n.kind)) return;
    if (n.kind === TS.SyntaxKind.VariableDeclaration && TS.isIdentifier(n.name) && n.initializer) {
      const init = n.initializer;
      if (init.kind === TS.SyntaxKind.CallExpression) {
        const callee = init.expression;
        if (callee && callee.kind === TS.SyntaxKind.PropertyAccessExpression) {
          const prop = callee.name && callee.name.text;
          if ((prop === 'indexOf' || prop === 'lastIndexOf') && isExactArgvIdentifier(callee.expression)) {
            out.push(init.arguments[0]);
          }
        }
      }
    }
    TS.forEachChild(n, visit);
  };
  visit(fn.body);
  return out;
}

/**
 * The literal string a SEARCH expression denotes once the helper parameters are
 * bound to the ACTUAL call arguments (`paramMap`). Supported: a string literal /
 * no-substitution template; a parameter identifier bound to a literal argument;
 * a template `` `PRE${p}POST` ``; a `+` concatenation of such. Anything else
 * (an unbound identifier, a nested call, a dynamic expression) → null (unproven).
 */
function literalSearchText(expr, paramMap) {
  const e = unwrapParens(expr);
  if (!e) return null;
  if (e.kind === TS.SyntaxKind.StringLiteral || e.kind === TS.SyntaxKind.NoSubstitutionTemplateLiteral) return e.text;
  if (e.kind === TS.SyntaxKind.Identifier) {
    if (!paramMap.has(e.text)) return null;
    const a = unwrapParens(paramMap.get(e.text));
    if (a && (a.kind === TS.SyntaxKind.StringLiteral || a.kind === TS.SyntaxKind.NoSubstitutionTemplateLiteral)) return a.text;
    return null;
  }
  if (e.kind === TS.SyntaxKind.TemplateExpression) {
    if (!e.head || typeof e.head.text !== 'string') return null;
    let s = e.head.text;
    for (const span of e.templateSpans || []) {
      const sub = literalSearchText(span.expression, paramMap);
      if (sub === null) return null;
      s += sub + (span.literal && typeof span.literal.text === 'string' ? span.literal.text : '');
    }
    return s;
  }
  if (e.kind === TS.SyntaxKind.BinaryExpression && e.operatorToken && e.operatorToken.kind === TS.SyntaxKind.PlusToken) {
    const l = literalSearchText(e.left, paramMap);
    const r = literalSearchText(e.right, paramMap);
    return l !== null && r !== null ? l + r : null;
  }
  return null;
}

/**
 * True iff the ACTUAL arguments of `callExpr` prove the helper's searched flag
 * is absent from the controlled no-args argv prefix ([executable, script path]).
 * The effective search string (helper parameters substituted with the literal
 * call arguments) must be a literal starting with '-' — a flag name. A literal
 * equal to the executable / script path does NOT start with '-', so it is
 * refused (contract1076 case 4). An unprovable search string is refused.
 */
function callArgsProveFlagAbsent(fn, callExpr) {
  const searches = indexOfSearchExprs(fn);
  if (searches.length === 0) return false;
  const paramMap = new Map();
  const params = fn.parameters || [];
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p && p.name && TS.isIdentifier(p.name)) paramMap.set(p.name.text, callExpr.arguments[i]);
  }
  for (const se of searches) {
    const s = literalSearchText(se, paramMap);
    if (s === null || !s.startsWith('-')) return false;
  }
  return true;
}

/**
 * The exact absent sentinel ('undefined'|'null'|'empty') that EVERY reachable
 * RETURN path of `fn` EXPLICITLY proves under no-args, or null (execution-83 +
 * contract1062 repair). An argv helper that merely REFERENCES argv but returns
 * an unrelated constant, a guaranteed-present slot (argv[0]/argv[1]), a bare
 * computed index (`process.argv[process.argv.length - 1]`), or a defined
 * fallback (`process.argv[2] || 'x'`) does NOT prove absence. If more than one
 * reachable return exists and any one fails to prove absence — or the returns
 * disagree on their sentinel — the helper is refused (ambiguous, fail closed).
 */
function helperAbsentSentinel(fn) {
  if (!fn || !fn.body) return null;
  const indexNames = indexOfBoundNames(fn);
  if (fn.body.kind !== TS.SyntaxKind.Block) {
    // Expression-bodied arrow: the body IS the returned expression.
    return exprAbsentSentinel(fn.body, indexNames);
  }
  const returns = [];
  const visit = (n) => {
    if (!n) return;
    if (DEFERRED_FN.has(n.kind)) return; // nested function bodies are not our returns
    if (n.kind === TS.SyntaxKind.ReturnStatement) {
      returns.push(n);
      return;
    }
    TS.forEachChild(n, visit);
  };
  TS.forEachChild(fn.body, visit);
  if (returns.length === 0) return null;
  let sentinel = null;
  for (const r of returns) {
    const s = exprAbsentSentinel(r.expression, indexNames);
    if (s === null) return null;
    if (sentinel === null) sentinel = s;
    else if (sentinel !== s) return null; // mixed sentinels → ambiguous
  }
  return sentinel;
}

/**
 * True iff `fn` is a *pure argv reader* whose body matches the explicit, bounded
 * argv-reader grammar (contract1076). It must reference `process.argv` and its
 * body must be accepted by `helperBodySupported` — index bindings plus a
 * supported absent-sentinel return, nothing else. A whitelisted method name is
 * NOT a purity proof (`const x = undefined; x.trim();` throws first).
 */
function helperIsPureArgvReader(fn) {
  if (!fn || !fn.body) return false;
  if (!referencesArgv(fn.body)) return false;
  return helperBodySupported(fn);
}

/**
 * True iff `fn` is a *value argv reader*: a pure argv reader whose RETURN path
 * proves an argv slot that can be absent under no-args. This is the ONLY thing
 * through which a local can be bound to argv transitively.
 */
function helperIsValueArgvReader(fn) {
  return helperIsPureArgvReader(fn) && helperAbsentSentinel(fn) !== null;
}

/* ------------------------------------------------------------------------- *
 * Lexical binding + symbol-aware callee resolution (execution-78 probe 3,
 * contract1062 probe 3).
 *
 * A callee is resolved to the ACTUAL lexical binding its identifier refers to —
 * an exact declaration identity, never a global last-name match. A parameter,
 * import or plain local that merely shares the callee's NAME is a SHADOW and is
 * NOT the outer function, so such a call can never be a value-helper proof. The
 * TypeScript binder's own symbol for the reference (when available) is used as
 * an additional exactness authority over the in-memory source.
 * ------------------------------------------------------------------------- */

/** Sentinel: a name bound more than once in the SAME lexical scope → refuse. */
const AMBIGUOUS = Symbol('ambiguous-binding');

/** Nearest enclosing scope owner (SourceFile or function-like) of `node`. */
function enclosingScopeOwner(node) {
  let p = node;
  while (p) {
    if (p.kind === TS.SyntaxKind.SourceFile || DEFERRED_FN.has(p.kind)) return p;
    p = p.parent;
  }
  return null;
}

/**
 * Build a TypeScript TypeChecker over the in-memory source: NO lib, NO
 * resolution of any imported file, and NO filesystem access (the host serves
 * only this one source string). It is used purely to obtain the compiler's own
 * SYMBOL for a reference so binding IDENTITY — not name equality — is enforced.
 * Returns null (the lexical binding table alone is then authoritative) if the
 * compiler is unavailable or refuses the program.
 */
function buildChecker(sf, source) {
  if (!TS || !TS.createProgram) return null;
  try {
    const host = {
      getSourceFile: (f) => (f === sf.fileName ? sf : undefined),
      getDefaultLibFileName: () => 'lib.d.ts',
      writeFile: () => {},
      getCurrentDirectory: () => '',
      getCanonicalFileName: (f) => f,
      useCaseSensitiveFileNames: () => true,
      getNewLine: () => '\n',
      fileExists: (f) => f === sf.fileName,
      readFile: (f) => (f === sf.fileName ? source : undefined),
      directoryExists: () => false,
      getDirectories: () => [],
      getSourceFileByPath: (p) => (p === sf.fileName || p === sf.path ? sf : undefined),
    };
    const program = TS.createProgram(
      [sf.fileName],
      {
        noResolve: true,
        noLib: true,
        types: [],
        target: TS.ScriptTarget.Latest,
        allowJs: true,
        checkJs: false,
      },
      host,
    );
    return program.getTypeChecker();
  } catch {
    return null;
  }
}

/**
 * True iff the checker binds the callee REFERENCE and the resolved function to
 * the SAME symbol. If either symbol is unavailable the lexical-table result is
 * kept (returns true), so the checker can only ever REINFORCE a shadowing
 * refusal, never drop a legitimate binding.
 */
function checkerSameBinding(name, calleeIdent, fn, lex) {
  if (!lex || !lex.checker) return true;
  try {
    const chk = lex.checker;
    const sRef = chk.getSymbolAtLocation(calleeIdent);
    let sDecl;
    if (fn.name && TS.isIdentifier(fn.name)) sDecl = chk.getSymbolAtLocation(fn.name);
    else {
      const info = resolveLexicalBinding(name, calleeIdent, lex.map);
      if (info && info.decl && info.decl.name && TS.isIdentifier(info.decl.name)) {
        sDecl = chk.getSymbolAtLocation(info.decl.name);
      }
    }
    if (!sRef || !sDecl) return true; // undecided → keep the lexical result
    return sRef === sDecl;
  } catch {
    return true;
  }
}

/**
 * Resolve a callee IDENTIFIER `calleeIdent` to the local function-like node it
 * ACTUALLY binds to, or null. Only a `function` declaration or a function-valued
 * `const`/`let`/`var` initializer qualifies; a parameter, import, plain local or
 * object binding of the same name is a shadow and returns null (probe 3).
 */
function resolveCalleeFunction(name, calleeIdent, lex) {
  const info = resolveLexicalBinding(name, calleeIdent, lex.map);
  if (!info) return null; // unresolved lexically → refuse (conservative)
  let fn = null;
  if (info.kind === 'function') fn = info.node;
  else if (
    info.kind === 'var' &&
    info.init &&
    (info.init.kind === TS.SyntaxKind.ArrowFunction || info.init.kind === TS.SyntaxKind.FunctionExpression)
  ) {
    fn = info.init;
  }
  if (!fn) return null; // param / import / plain var shadow — not the outer function
  if (!checkerSameBinding(name, calleeIdent, fn, lex)) return null;
  return fn;
}

/** A call argument simple enough that evaluating it cannot throw / run effect. */
function isSimpleLiteralArg(a) {
  if (!a) return false;
  return (
    a.kind === TS.SyntaxKind.StringLiteral ||
    a.kind === TS.SyntaxKind.NumericLiteral ||
    a.kind === TS.SyntaxKind.NoSubstitutionTemplateLiteral ||
    a.kind === TS.SyntaxKind.TrueKeyword ||
    a.kind === TS.SyntaxKind.FalseKeyword
  );
}

/**
 * The absent sentinel a helper proves, plus whether that proof DEPENDS on the
 * call argument (true when the helper resolves the flag via indexOf/lastIndexOf,
 * i.e. it carries an index binding). A bare-argv-slot helper is
 * argument-independent — its absent slot holds regardless of the argument.
 */
function helperAbsentInfo(fn) {
  const sentinel = helperAbsentSentinel(fn);
  if (sentinel === null) return null;
  const argDependent = indexOfBoundNames(fn).size > 0;
  return { sentinel, argDependent };
}

/**
 * The exact absent sentinel a call to a lexically-resolved local VALUE argv
 * helper yields under no-args, or null. A pure callee does NOT prove its CALL is
 * pure: `arg(boom())` is refused because the argument runs (and may throw)
 * BEFORE the helper (contract1062 probe 7), so only simple literal flag
 * arguments are accepted — the real known helper calls take literal flag names.
 * contract1076 case 4: an index-guarded helper proves absence ONLY for a flag the
 * controlled no-args argv cannot contain, so the ACTUAL call argument is bound to
 * the helper's indexOf search string and must resolve to a literal flag name
 * starting '-'. `arg(<process.execPath literal>)` returns a PRESENT argv[1] and
 * is refused.
 */
function callValueHelperSentinel(callExpr, lex) {
  if (!callExpr || callExpr.kind !== TS.SyntaxKind.CallExpression) return null;
  const callee = callExpr.expression;
  if (!callee || callee.kind !== TS.SyntaxKind.Identifier) return null;
  const fn = resolveCalleeFunction(callee.text, callee, lex);
  if (!fn || !helperIsValueArgvReader(fn)) return null;
  if (!callExpr.arguments.every(isSimpleLiteralArg)) return null;
  const info = helperAbsentInfo(fn);
  if (!info) return null;
  if (info.argDependent && !callArgsProveFlagAbsent(fn, callExpr)) return null;
  return info.sentinel;
}

/** True iff `init` is a call to a lexically-resolved local VALUE argv helper. */
function callToValueArgvHelper(init, lex) {
  return callValueHelperSentinel(init, lex) !== null;
}

/** True iff `node` is EXACTLY `process.argv` (a plain, non-optional access of the REAL global `process`). */
function isProcessArgvAccess(node) {
  return (
    !!node &&
    node.kind === TS.SyntaxKind.PropertyAccessExpression &&
    !node.questionDotToken &&
    node.name &&
    node.name.text === 'argv' &&
    node.expression &&
    node.expression.kind === TS.SyntaxKind.Identifier &&
    node.expression.text === 'process' &&
    !nameShadowedAt('process', node.expression)
  );
}

/** True iff `node` is an exact argv access on a source with NO argv mutation. */
function isExactArgvIdentifier(node) {
  return isProcessArgvAccess(node) && !ARGV_MUTATED;
}

/** Strip redundant parentheses (contract1051: `(!file)`, `((arg() ?? ''))`). */
function unwrapParens(node) {
  let n = node;
  while (n && n.kind === TS.SyntaxKind.ParenthesizedExpression) n = n.expression;
  return n;
}

/* ------------------------------------------------------------------------- *
 * Lexical BINDING table (variables / params / functions / imports).
 * This single table resolves ANY lexical name — and, together with the
 * TypeScript checker, the exact declaration identity of a callee. An
 * absent-value proof is bound to the ACTUAL declaration used by the guard, and
 * a parameter / local / import shadow is detected (contract1051 probes 3/4,
 * contract1062 probe 3).
 * ------------------------------------------------------------------------- */

const SHADOW_CACHE = new WeakMap();

const addImportNames = (decl, set) => {
  const cl = decl.importClause;
  if (!cl) return;
  if (cl.name && TS.isIdentifier(cl.name)) set.add(cl.name.text);
  const nb = cl.namedBindings;
  if (!nb) return;
  if (nb.kind === TS.SyntaxKind.NamespaceImport) {
    if (nb.name && TS.isIdentifier(nb.name)) set.add(nb.name.text);
  } else if (nb.elements) {
    for (const el of nb.elements) {
      const nm = el && el.name;
      if (nm && TS.isIdentifier(nm)) set.add(nm.text);
    }
  }
};

/** Names bound DIRECTLY in `owner`'s own scope (params + own decls + imports). */
function directBindingNames(owner) {
  if (SHADOW_CACHE.has(owner)) return SHADOW_CACHE.get(owner);
  const set = new Set();
  const addName = (nm) => {
    if (!nm) return;
    if (TS.isIdentifier(nm)) set.add(nm.text);
    else if (nm.kind === TS.SyntaxKind.ArrayBindingPattern || nm.kind === TS.SyntaxKind.ObjectBindingPattern) {
      for (const el of nm.elements) if (el && el.kind !== TS.SyntaxKind.OmittedExpression) addName(el.name);
    }
  };
  if (DEFERRED_FN.has(owner.kind) && owner.parameters) for (const p of owner.parameters) addName(p.name);
  const walk = (n) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.FunctionDeclaration) {
      if (n.name && TS.isIdentifier(n.name)) set.add(n.name.text);
      return;
    }
    if (DEFERRED_FN.has(n.kind)) return;
    if (n.kind === TS.SyntaxKind.VariableDeclaration) addName(n.name);
    if (n.kind === TS.SyntaxKind.ImportDeclaration) addImportNames(n, set);
    TS.forEachChild(n, walk);
  };
  walk(owner.kind === TS.SyntaxKind.SourceFile ? owner : owner.body);
  SHADOW_CACHE.set(owner, set);
  return set;
}

/** True iff identifier `name` used at `node` is shadowed by a lexical binding. */
function nameShadowedAt(name, node) {
  let owner = enclosingScopeOwner(node);
  while (owner) {
    if (directBindingNames(owner).has(name)) return true;
    owner = owner.parent ? enclosingScopeOwner(owner.parent) : null;
  }
  return false;
}

/** Build a lexical binding table over scope owners (SourceFile + function-likes). */
function buildBindingScopes(sf) {
  const map = new Map();
  const add = (m, name, info) => {
    if (!name) return;
    if (m.has(name)) {
      if (m.get(name) !== info) m.set(name, AMBIGUOUS);
    } else m.set(name, info);
  };
  const addPattern = (nm, m, base, index, nested) => {
    if (!nm) return;
    if (TS.isIdentifier(nm)) {
      add(m, nm.text, { ...base, nameNode: nm, elementIndex: index, nested: !!nested });
      return;
    }
    if (nm.kind === TS.SyntaxKind.ArrayBindingPattern) {
      for (let i = 0; i < nm.elements.length; i++) {
        const el = nm.elements[i];
        if (!el || el.kind === TS.SyntaxKind.OmittedExpression) continue;
        // Only a FLAT plain identifier directly in this exact argv array pattern
        // is a real argv slot. A nested pattern is marked `nested` so it can
        // never be flattened into a fake argv position (contract1062 probe 5).
        const childNested = TS.isIdentifier(el.name) ? !!nested : true;
        addPattern(el.name, m, { ...base, pattern: 'array', bindingElement: el }, i, childNested);
      }
      return;
    }
    if (nm.kind === TS.SyntaxKind.ObjectBindingPattern) {
      for (const el of nm.elements) {
        if (!el || el.kind === TS.SyntaxKind.OmittedExpression) continue;
        addPattern(el.name, m, { ...base, pattern: 'object', bindingElement: el }, undefined, true);
      }
    }
  };
  const addImportBindings = (decl, m) => {
    const cl = decl.importClause;
    if (!cl) return;
    const put = (nm) => {
      if (nm && TS.isIdentifier(nm)) add(m, nm.text, { kind: 'import', node: decl });
    };
    put(cl.name);
    const nb = cl.namedBindings;
    if (nb) {
      if (nb.kind === TS.SyntaxKind.NamespaceImport) put(nb.name);
      else if (nb.elements) for (const el of nb.elements) put(el && el.name);
    }
  };
  const collect = (owner, body) => {
    const m = new Map();
    if (DEFERRED_FN.has(owner.kind) && owner.parameters) {
      for (const p of owner.parameters) addPattern(p.name, m, { kind: 'param', owner });
    }
    const walk = (n) => {
      if (!n) return;
      if (n.kind === TS.SyntaxKind.FunctionDeclaration) {
        if (n.name && TS.isIdentifier(n.name)) add(m, n.name.text, { kind: 'function', node: n });
        return;
      }
      if (n.kind === TS.SyntaxKind.ImportDeclaration) {
        addImportBindings(n, m);
        return;
      }
      if (DEFERRED_FN.has(n.kind)) return;
      if (n.kind === TS.SyntaxKind.VariableDeclaration) {
        const list = n.parent;
        const declKind = list && list.flags & TS.NodeFlags.Const
          ? 'const'
          : list && list.flags & TS.NodeFlags.Let
            ? 'let'
            : 'var';
        addPattern(n.name, m, { kind: 'var', decl: n, declKind, init: n.initializer, pattern: 'plain' });
      }
      TS.forEachChild(n, walk);
    };
    walk(body);
    map.set(owner, m);
  };
  collect(sf, sf);
  const visit = (n) => {
    if (!n) return;
    if (DEFERRED_FN.has(n.kind)) collect(n, n.body);
    TS.forEachChild(n, visit);
  };
  visit(sf);
  return map;
}

/** Resolve `name` at `fromNode` by lexical scope; AMBIGUOUS / missing → null. */
function resolveLexicalBinding(name, fromNode, bindingScopes) {
  let owner = enclosingScopeOwner(fromNode);
  while (owner) {
    const m = bindingScopes.get(owner);
    if (m && m.has(name)) {
      const v = m.get(name);
      return v === AMBIGUOUS ? null : v;
    }
    owner = owner.parent ? enclosingScopeOwner(owner.parent) : null;
  }
  return null;
}

/**
 * True iff `name` is assigned / ++/-- anywhere in the file. A conservative
 * no-mutation proof so a `let [,,a] = process.argv; a = 'present'` binding is
 * never treated as still-absent at its later guard (contract1051 probe 5).
 */
function nameIsMutated(name, sf) {
  let mutated = false;
  const visit = (n) => {
    if (mutated || !n) return;
    if (n.kind === TS.SyntaxKind.BinaryExpression && ASSIGN_TOKENS.has(n.operatorToken && n.operatorToken.kind)) {
      const l = n.left;
      if (l && l.kind === TS.SyntaxKind.Identifier && l.text === name) mutated = true;
    }
    if (
      (n.kind === TS.SyntaxKind.PrefixUnaryExpression || n.kind === TS.SyntaxKind.PostfixUnaryExpression) &&
      UPDATE_TOKENS.has(n.operator)
    ) {
      const o = n.operand;
      if (o && o.kind === TS.SyntaxKind.Identifier && o.text === name) mutated = true;
    }
    TS.forEachChild(n, visit);
  };
  visit(sf);
  return mutated;
}

/**
 * True iff the source assigns or mutates `process.argv` — or an alias of it —
 * anywhere. A source-visible argv mutation (e.g. `process.argv.push('present')`
 * BEFORE a destructuring) invalidates the "noargs argv.length === 2" premise, so
 * no absence proof may be derived from that source (contract1062 probe 9). This
 * is conservative: it refuses the whole source, never inventing a proof.
 */
function argvIsMutated(sf) {
  const alias = new Set();
  let mutated = false;
  const touches = (n) => {
    if (!n) return false;
    const t = text(n);
    if (/\bprocess\.argv\b/.test(t)) return true;
    for (const a of alias) if (new RegExp(`\\b${a}\\b`).test(t)) return true;
    return false;
  };
  const visit = (n) => {
    if (mutated || !n) return;
    if (n.kind === TS.SyntaxKind.VariableDeclaration && TS.isIdentifier(n.name) && isProcessArgvAccess(n.initializer)) {
      alias.add(n.name.text);
    }
    if (n.kind === TS.SyntaxKind.BinaryExpression && ASSIGN_TOKENS.has(n.operatorToken && n.operatorToken.kind)) {
      if (touches(n.left)) mutated = true;
    }
    if (
      n.kind === TS.SyntaxKind.CallExpression &&
      n.expression &&
      n.expression.kind === TS.SyntaxKind.PropertyAccessExpression
    ) {
      const prop = n.expression.name && n.expression.name.text;
      if (MUTATING_ARGV_METHODS.has(prop) && touches(n.expression.expression)) mutated = true;
    }
    TS.forEachChild(n, visit);
  };
  visit(sf);
  return mutated;
}

/**
 * The set of EMPTY_PRESERVING intrinsic method names whose `String.prototype`
 * binding the source OVERRIDES, ALIASES or otherwise REFERENCES — e.g.
 * `String.prototype.toUpperCase = () => 'present'`,
 * `Object.assign(String.prototype, { toUpperCase(){ return 'present' } })`,
 * `String.prototype['toUpperCase'] = ...`, or an alias of `String.prototype`.
 * Such a source invalidates the empty-preserving assumption (contract1062 probe
 * 6, contract1076 case 5), so the empty-string dataflow proof is refused. This
 * is deliberately BROAD and conservative: arbitrary prototype metaprogramming is
 * NOT modelled — ANY unshadowed `String.prototype` reference (direct, computed,
 * Object.assign target, or through an alias) disqualifies the modelled methods.
 * The real diag-leg-readpaths pattern has no `String.prototype` reference and is
 * preserved.
 */
function dirtyIntrinsicMethods(sf) {
  const methods = new Set();
  const alias = new Set();
  const markAll = () => {
    for (const m of EMPTY_PRESERVING_METHODS) methods.add(m);
  };
  // `String.prototype` — direct property access OR `String['prototype']`.
  const isStringProto = (e) => {
    if (!e) return false;
    if (e.kind === TS.SyntaxKind.PropertyAccessExpression) {
      return (
        e.name &&
        e.name.text === 'prototype' &&
        e.expression &&
        e.expression.kind === TS.SyntaxKind.Identifier &&
        e.expression.text === 'String' &&
        !nameShadowedAt('String', e.expression)
      );
    }
    if (e.kind === TS.SyntaxKind.ElementAccessExpression) {
      const arg = e.argumentExpression;
      return (
        !!arg &&
        arg.kind === TS.SyntaxKind.StringLiteral &&
        arg.text === 'prototype' &&
        e.expression &&
        e.expression.kind === TS.SyntaxKind.Identifier &&
        e.expression.text === 'String' &&
        !nameShadowedAt('String', e.expression)
      );
    }
    return false;
  };
  const isProtoOrAlias = (e) =>
    isStringProto(e) || (!!e && e.kind === TS.SyntaxKind.Identifier && alias.has(e.text));
  const record = (propAccess) => {
    if (!propAccess) return;
    if (propAccess.kind === TS.SyntaxKind.PropertyAccessExpression) {
      const obj = propAccess.expression;
      const m = propAccess.name && propAccess.name.text;
      if (!m) return;
      if (isProtoOrAlias(obj)) methods.add(m);
    } else if (propAccess.kind === TS.SyntaxKind.ElementAccessExpression) {
      // Computed access `String.prototype[expr]` / alias[expr] — an unknown key,
      // so conservatively disqualify ALL modelled methods.
      if (isProtoOrAlias(propAccess.expression)) markAll();
    }
  };
  const visit = (n) => {
    if (!n) return;
    // ANY reference to `String.prototype` (mutation, Object.assign target,
    // computed access, read) disqualifies the modelled empty-preserving methods.
    if (isStringProto(n)) markAll();
    if (n.kind === TS.SyntaxKind.BinaryExpression && ASSIGN_TOKENS.has(n.operatorToken && n.operatorToken.kind)) {
      record(n.left);
      if (isStringProto(n.right) && n.left && n.left.kind === TS.SyntaxKind.Identifier) {
        alias.add(n.left.text);
      }
    }
    if (n.kind === TS.SyntaxKind.VariableDeclaration && n.name && TS.isIdentifier(n.name) && isStringProto(n.initializer)) {
      alias.add(n.name.text);
    }
    if (
      n.kind === TS.SyntaxKind.CallExpression &&
      n.expression &&
      n.expression.kind === TS.SyntaxKind.PropertyAccessExpression &&
      n.expression.name &&
      n.expression.name.text === 'defineProperty'
    ) {
      const obj = n.arguments[0];
      const key = n.arguments[1];
      if (isProtoOrAlias(obj)) {
        if (key && key.kind === TS.SyntaxKind.StringLiteral) methods.add(key.text);
        else markAll();
      }
    }
    // Object.assign(String.prototype | alias, ...) — a method-name source object
    // literal mutates the intrinsic prototype (contract1076 case 5).
    if (
      n.kind === TS.SyntaxKind.CallExpression &&
      n.expression &&
      n.expression.kind === TS.SyntaxKind.PropertyAccessExpression &&
      n.expression.name &&
      n.expression.name.text === 'assign' &&
      n.expression.expression &&
      n.expression.expression.kind === TS.SyntaxKind.Identifier &&
      n.expression.expression.text === 'Object' &&
      n.arguments.length >= 1 &&
      isProtoOrAlias(n.arguments[0])
    ) {
      for (let i = 1; i < n.arguments.length; i++) {
        const src = n.arguments[i];
        if (src && src.kind === TS.SyntaxKind.ObjectLiteralExpression) {
          for (const prop of src.properties) {
            const nm = prop && prop.name;
            if (nm && (TS.isIdentifier(nm) || nm.kind === TS.SyntaxKind.StringLiteral)) methods.add(nm.text);
            else markAll();
          }
        } else {
          markAll();
        }
      }
    }
    TS.forEachChild(n, visit);
  };
  visit(sf);
  return methods;
}

/* ------------------------------------------------------------------------- *
 * EXACT no-args VALUE model.
 * Two exact values are modelled: 'undefined' (an absent argv slot / value
 * helper result) and 'empty' (the empty string). Equality leaves are decided
 * ONLY against these EXACT values — never by conflating all falsy/nullish
 * sentinels. `a === null` on an absent slot is therefore FALSE (probe 1).
 * ------------------------------------------------------------------------- */

/** Literal identity of a comparison's non-identifier side, else null. */
function literalIdentity(expr) {
  if (!expr) return null;
  if (expr.kind === TS.SyntaxKind.NullKeyword) return { k: 'null' };
  if (expr.kind === TS.SyntaxKind.Identifier && expr.text === 'undefined') {
    // Only the GLOBAL `undefined` literal: a parameter / local / import named
    // `undefined` is a different binding (contract1062 probe 8).
    return nameShadowedAt('undefined', expr) ? null : { k: 'undefined' };
  }
  if (expr.kind === TS.SyntaxKind.StringLiteral) return { k: 'string', v: expr.text };
  if (expr.kind === TS.SyntaxKind.NumericLiteral) return { k: 'number', v: Number(expr.text) };
  if (expr.kind === TS.SyntaxKind.TrueKeyword) return { k: 'boolean', v: true };
  if (expr.kind === TS.SyntaxKind.FalseKeyword) return { k: 'boolean', v: false };
  return null;
}

/** Truth of `exact OP literal` for the three modelled exact values. */
function compareExactToLiteral(exact, op, lit) {
  const loose = op === '==' || op === '!=';
  const neg = op === '!=' || op === '!==';
  let eq;
  if (exact === 'undefined') {
    if (lit.k === 'undefined') eq = true;
    else if (lit.k === 'null') eq = loose; // undefined == null true, === null false
    else eq = false;
  } else if (exact === 'null') {
    // A value helper may return `null` under no-args (contract1062 probes 1/2).
    if (lit.k === 'null') eq = true;
    else if (lit.k === 'undefined') eq = loose; // null == undefined true, === undefined false
    else eq = false;
  } else {
    // exact === 'empty' (the empty string)
    if (lit.k === 'string') eq = lit.v === '';
    else if (lit.k === 'number') eq = loose ? lit.v === 0 : false;
    else if (lit.k === 'boolean') eq = loose ? lit.v === false : false;
    else eq = false;
  }
  return neg ? !eq : eq;
}

/** Exact no-args value ('undefined' | 'null' | 'empty') of an identifier reference, else null. */
function exactValueOfIdentifier(ident, lex, seen) {
  const info = resolveLexicalBinding(ident.text, ident, lex.map);
  if (!info || info.kind !== 'var') return null;
  if (seen.has(info.decl)) return null;
  seen.add(info.decl);
  if (info.declKind !== 'const') return null; // let/var: not provably unmutated
  if (nameIsMutated(ident.text, lex.sf)) return null;
  // contract1076 case 1: a guard that reads a local CAPTURED from a DIFFERENT
  // function scope cannot be justified by textual declaration order — the
  // enclosing function may be INVOKED before the initializer runs (TDZ), as in
  // `main(); const[,,a]=process.argv; function main(){ if(!a)... }`. Declaration
  // START before reference text does NOT prove runtime initialization across a
  // function boundary, so cross-scope capture is refused unless actual
  // invocation ordering is proven (it is not). Same-scope (direct local)
  // initialization is unaffected.
  if (enclosingScopeOwner(ident) !== enclosingScopeOwner(info.decl)) return null;
  // Guaranteed PRIOR initialization: a guard that runs BEFORE its `const`
  // initializer executes in the TDZ and throws, so no absence fact exists there
  // (contract1062 probe 4). Source order is a conservative proxy for execution
  // order; uncertain closure / call order is refused.
  if (
    info.decl &&
    typeof info.decl.getStart === 'function' &&
    typeof ident.getStart === 'function' &&
    info.decl.getStart() >= ident.getStart()
  ) {
    return null;
  }
  if (info.pattern === 'array') {
    if (info.nested) return null; // nested destructuring is NOT a flat argv slot (probe 5)
    if (!(info.elementIndex >= 2)) return null; // slot 0/1 always present
    const el = info.bindingElement;
    if (!el || el.dotDotDotToken || el.initializer) return null; // rest / defaulted
    if (!isExactArgvIdentifier(info.init)) return null; // exact real, unmutated `process.argv`
    return 'undefined';
  }
  if (info.pattern === 'object') return null;
  return exactValueOf(info.init, lex, seen);
}

/** Exact no-args value ('undefined' | 'null' | 'empty') of an expression, else null. */
function exactValueOf(expr, lex, seen) {
  const e = unwrapParens(expr);
  if (!e) return null;
  if (e.kind === TS.SyntaxKind.Identifier) return exactValueOfIdentifier(e, lex, seen);
  if (e.kind === TS.SyntaxKind.CallExpression) {
    const sent = callValueHelperSentinel(e, lex);
    if (sent) return sent; // the helper's OWN sentinel, never a fabricated 'undefined'
    const callee = e.expression;
    if (callee && callee.kind === TS.SyntaxKind.PropertyAccessExpression) {
      const prop = callee.name && callee.name.text;
      // Zero-argument known empty-preserving intrinsic ONLY, and only when the
      // source does not override/alias `String.prototype.<prop>` (probe 6); a
      // side-effecting argument (e.g. `.toUpperCase(boom())`) is refused.
      if (
        prop &&
        EMPTY_PRESERVING_METHODS.has(prop) &&
        e.arguments.length === 0 &&
        !lex.dirty.has(prop)
      ) {
        if (exactValueOf(callee.expression, lex, seen) === 'empty') return 'empty';
      }
    }
    return null;
  }
  if (e.kind === TS.SyntaxKind.BinaryExpression && e.operatorToken && e.operatorToken.kind === TS.SyntaxKind.QuestionQuestionToken) {
    const leftAbsent = exactValueOf(e.left, lex, seen) === 'undefined';
    const rightEmpty = !!e.right && e.right.kind === TS.SyntaxKind.StringLiteral && e.right.text === '';
    return leftAbsent && rightEmpty ? 'empty' : null;
  }
  const idx = argvElementAccessIndex(e);
  if (idx && indexIsAbsentLiteral(idx)) return 'undefined';
  return null;
}

/** A local slice has length zero only when its exact argv origin stays read-only. */
function slicedArgvLengthAtNoArgs(ident, lex) {
  if (!ident || ident.kind !== TS.SyntaxKind.Identifier || ARGV_MUTATED) return null;
  const info = resolveLexicalBinding(ident.text, ident, lex.map);
  if (!info || info.kind !== 'var' || info.declKind !== 'const' || info.pattern !== 'plain') return null;
  if (enclosingScopeOwner(ident) !== enclosingScopeOwner(info.decl)) return null;
  if (info.decl.getStart() >= ident.getStart() || nameIsMutated(ident.text, lex.sf)) return null;
  const init = unwrapParens(info.init);
  if (!init || init.kind !== TS.SyntaxKind.CallExpression || init.questionDotToken || init.arguments.length !== 1) return null;
  const callee = unwrapParens(init.expression);
  if (!callee || callee.kind !== TS.SyntaxKind.PropertyAccessExpression || callee.questionDotToken || callee.name.text !== 'slice') return null;
  if (!isExactArgvIdentifier(unwrapParens(callee.expression))) return null;
  const start = unwrapParens(init.arguments[0]);
  if (!start || start.kind !== TS.SyntaxKind.NumericLiteral || Number(start.text) !== 2) return null;

  // A slice passed elsewhere, captured by a closure, written through a property,
  // or used with a mutating/unknown method no longer has a proven length. Match
  // each reference to THIS declaration so an unrelated shadow cannot affect it.
  let readOnly = true;
  const isWrite = (access) => {
    let current = access;
    while (current.parent?.kind === TS.SyntaxKind.ParenthesizedExpression) current = current.parent;
    const parent = current.parent;
    return !!parent && (
      (parent.kind === TS.SyntaxKind.BinaryExpression && parent.left === current && ASSIGN_TOKENS.has(parent.operatorToken?.kind)) ||
      ((parent.kind === TS.SyntaxKind.PrefixUnaryExpression || parent.kind === TS.SyntaxKind.PostfixUnaryExpression) && UPDATE_TOKENS.has(parent.operator)) ||
      parent.kind === TS.SyntaxKind.DeleteExpression
    );
  };
  const visit = (node) => {
    if (!readOnly || !node) return;
    if (node.kind === TS.SyntaxKind.Identifier && node.text === ident.text && node !== info.nameNode &&
        resolveLexicalBinding(node.text, node, lex.map) === info) {
      if (enclosingScopeOwner(node) !== enclosingScopeOwner(info.decl)) { readOnly = false; return; }
      const access = node.parent;
      if (!access || ![TS.SyntaxKind.PropertyAccessExpression, TS.SyntaxKind.ElementAccessExpression].includes(access.kind) ||
          access.expression !== node || isWrite(access)) { readOnly = false; return; }
      if (access.parent?.kind === TS.SyntaxKind.CallExpression && access.parent.expression === access) {
        if (access.kind !== TS.SyntaxKind.PropertyAccessExpression || access.name.text !== 'includes' ||
            access.parent.arguments.some((arg) => arg.kind !== TS.SyntaxKind.StringLiteral)) {
          readOnly = false;
          return;
        }
      }
    }
    TS.forEachChild(node, visit);
  };
  visit(lex.sf);
  return readOnly ? 0 : null;
}

/** An unmutated real process.argv has two entries; its exact slice(2) has none. */
function argvLengthAtNoArgs(node, lex) {
  const c = unwrapParens(node);
  if (!c || c.kind !== TS.SyntaxKind.PropertyAccessExpression || c.questionDotToken || c.name?.text !== 'length') {
    return null;
  }
  const receiver = unwrapParens(c.expression);
  return isExactArgvIdentifier(receiver) ? 2 : slicedArgvLengthAtNoArgs(receiver, lex);
}

/** Decide an argv-length comparison from its actual no-args value. */
function argvLengthComparisonAtNoArgs(cond, lex) {
  const left = argvLengthAtNoArgs(cond.left, lex);
  const right = argvLengthAtNoArgs(cond.right, lex);
  const leftLiteral = unwrapParens(cond.left);
  const rightLiteral = unwrapParens(cond.right);
  const l = left ?? (leftLiteral?.kind === TS.SyntaxKind.NumericLiteral ? Number(leftLiteral.text) : null);
  const r = right ?? (rightLiteral?.kind === TS.SyntaxKind.NumericLiteral ? Number(rightLiteral.text) : null);
  if ((left === null && right === null) || l === null || r === null || !Number.isFinite(l) || !Number.isFinite(r)) return null;
  switch (cond.operatorToken?.kind) {
    case TS.SyntaxKind.LessThanToken: return l < r;
    case TS.SyntaxKind.LessThanEqualsToken: return l <= r;
    case TS.SyntaxKind.GreaterThanToken: return l > r;
    case TS.SyntaxKind.GreaterThanEqualsToken: return l >= r;
    case TS.SyntaxKind.EqualsEqualsToken:
    case TS.SyntaxKind.EqualsEqualsEqualsToken: return l === r;
    case TS.SyntaxKind.ExclamationEqualsToken:
    case TS.SyntaxKind.ExclamationEqualsEqualsToken: return l !== r;
    default: return null;
  }
}

/** Decidable truth of a guard LEAF: true / false / null (undecided). */
function foldGuardLeaf(cond, lex, seen) {
  const c = unwrapParens(cond);
  if (!c) return null;
  if (c.kind === TS.SyntaxKind.PrefixUnaryExpression && c.operator === TS.SyntaxKind.ExclamationToken) {
    const t = foldGuardLeaf(c.operand, lex, new Set(seen));
    return t === null ? null : !t;
  }
  if (c.kind === TS.SyntaxKind.Identifier) {
    // A bare proven-absent/empty value is (definitely) FALSY.
    return exactValueOfIdentifier(c, lex, new Set(seen)) !== null ? false : null;
  }
  if (c.kind === TS.SyntaxKind.BinaryExpression) {
    const argvLengthTruth = argvLengthComparisonAtNoArgs(c, lex);
    if (argvLengthTruth !== null) return argvLengthTruth;
    const opK = c.operatorToken && c.operatorToken.kind;
    const op =
      opK === TS.SyntaxKind.EqualsEqualsToken
        ? '=='
        : opK === TS.SyntaxKind.EqualsEqualsEqualsToken
          ? '==='
          : opK === TS.SyntaxKind.ExclamationEqualsToken
            ? '!='
            : opK === TS.SyntaxKind.ExclamationEqualsEqualsToken
              ? '!=='
              : null;
    if (op) {
      const l = unwrapParens(c.left);
      const r = unwrapParens(c.right);
      const lv = l && l.kind === TS.SyntaxKind.Identifier ? exactValueOfIdentifier(l, lex, new Set(seen)) : null;
      const rv = r && r.kind === TS.SyntaxKind.Identifier ? exactValueOfIdentifier(r, lex, new Set(seen)) : null;
      const rl = literalIdentity(r);
      const ll = literalIdentity(l);
      if (lv !== null && rl !== null) return compareExactToLiteral(lv, op, rl);
      if (rv !== null && ll !== null) return compareExactToLiteral(rv, op, ll);
    }
  }
  return null;
}

/** A raw-text shape that signals a boolean-producing argv expression. */
function booleanShape(t) {
  return /\.includes\(|\.indexOf\(|===?|!==?|>=?|<=?/.test(t);
}

/**
 * Collect argv-derived locals in three tiers:
 *   all    — any local whose initializer derives from process.argv (directly,
 *            through a value argv helper, or transitively from another bound local);
 *   value  — the subset whose value is a *value* (not a boolean flag): bound via a
 *            value argv helper, via a non-boolean argv read, or transitively from a
 *            value-bound local. ONLY value-bound locals can satisfy a required-value
 *            guard. A boolean flag (`process.argv.includes('--commit')`) never can.
 *   absent — the subset whose no-args value is PROVEN absent or empty: a value
 *            argv helper's result, an argv-destructured slot at index >= 2, or an
 *            empty-string dataflow result. This is the ONLY set a sound compound
 *            no-args guard may lean on (contract1048).
 *
 * The private locals inside a pure argv reader are NOT harvested (they are the
 * helper's own internals), and a function-valued `const` is a definition, not a
 * value binding.
 */
function collectArgvBindings(sf, lex) {
  const all = new Set();
  const value = new Set();
  // Names whose no-args value is PROVEN absent / empty (the only names a sound
  // compound no-args guard may lean on): a value argv helper's result, an
  // argv-destructured slot at index >= 2, or an empty-string dataflow result.
  const absent = new Set();
  const refsAny = (set, node) => {
    const t = text(node);
    for (const id of set) if (new RegExp(`\\b${id}\\b`).test(t)) return true;
    return false;
  };
  const visit = (n) => {
    if (!n) return;
    if (
      (n.kind === TS.SyntaxKind.FunctionDeclaration ||
        n.kind === TS.SyntaxKind.FunctionExpression ||
        n.kind === TS.SyntaxKind.ArrowFunction) &&
      n.body &&
      referencesArgv(n.body)
    ) {
      return; // never harvest any argv-reading helper's private locals
    }
    if (
      n.kind === TS.SyntaxKind.VariableDeclaration &&
      n.name &&
      n.name.kind === TS.SyntaxKind.ArrayBindingPattern &&
      isExactArgvIdentifier(n.initializer)
    ) {
      // Recognized through the EXACT-value lexical model (bound to this very
      // declaration, exact `undefined`, real unshadowed `process`). Deliberately
      // NOT added to the legacy broad all/value sets, which must never conflate
      // null/undefined/'' for requiredValueGuard (contract1051).
    } else if (
      n.kind === TS.SyntaxKind.VariableDeclaration &&
      TS.isIdentifier(n.name) &&
      n.initializer &&
      n.initializer.kind !== TS.SyntaxKind.ArrowFunction &&
      n.initializer.kind !== TS.SyntaxKind.FunctionExpression
    ) {
      const init = n.initializer;
      const id = n.name.text;
      const viaHelper = callToValueArgvHelper(init, lex);
      if (viaHelper || referencesArgv(init) || refsAny(all, init)) {
        all.add(id);
        if (viaHelper || refsAny(value, init) || (referencesArgv(init) && !booleanShape(text(init)))) value.add(id);
      }
    }
    TS.forEachChild(n, visit);
  };
  visit(sf);
  return { all, value, absent };
}

/** True iff the node is an identifier *reference* (not a property name). */
function isIdentifierReference(n) {
  if (!n || n.kind !== TS.SyntaxKind.Identifier) return false;
  const p = n.parent;
  if (p && p.kind === TS.SyntaxKind.PropertyAccessExpression && p.name === n) return false;
  return true;
}

/** True iff `node` reads the actual argv, directly or via a bound local. */
function isArgvExpr(node, allIds) {
  if (referencesArgv(node)) return true;
  let found = false;
  const visit = (n) => {
    if (found || !n) return;
    if (isIdentifierReference(n) && allIds.has(n.text)) {
      found = true;
      return;
    }
    TS.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/**
 * A REQUIRED-VALUE guard on a *value-typed* argv-derived local:
 * `!loc`, `loc == null`, `loc === undefined`, `loc == ''` (either operand order).
 */
function requiredValueGuard(cond, valueIds) {
  if (!cond) return false;
  if (cond.kind === TS.SyntaxKind.PrefixUnaryExpression && cond.operator === TS.SyntaxKind.ExclamationToken) {
    const op = cond.operand;
    return !!op && op.kind === TS.SyntaxKind.Identifier && valueIds.has(op.text);
  }
  if (cond.kind === TS.SyntaxKind.BinaryExpression) {
    const opTok = cond.operatorToken && cond.operatorToken.kind;
    if (opTok !== TS.SyntaxKind.EqualsEqualsToken && opTok !== TS.SyntaxKind.EqualsEqualsEqualsToken) return false;
    const isNullish = (e) =>
      !!e &&
      ((e.kind === TS.SyntaxKind.Identifier && e.text === 'undefined') ||
        e.kind === TS.SyntaxKind.NullKeyword ||
        (e.kind === TS.SyntaxKind.StringLiteral && e.text === ''));
    const left = cond.left;
    const right = cond.right;
    if (left && left.kind === TS.SyntaxKind.Identifier && valueIds.has(left.text) && isNullish(right)) return true;
    if (right && right.kind === TS.SyntaxKind.Identifier && valueIds.has(right.text) && isNullish(left)) return true;
  }
  return false;
}

/**
 * Sound short-circuit evaluation of a guard under no-args. Returns true ONLY
 * when the runtime DEFINITELY evaluates the condition to true WITHOUT first
 * executing an unknown / maybe-throwing subexpression:
 *   - `A || B`: evaluate A; A definitely-true => whole true (B NOT evaluated:
 *     this is why `!file || unknown` and `!file || boom()` are safe); A
 *     definitely-false => evaluate B; A undecided => undecided (refuse).
 *   - `A && B`: A definitely-false => false; A definitely-true => evaluate B;
 *     A undecided => undecided (refuse).
 * A left `unknown || !file` (e.g. `boom() || !a`) is refused because the unknown
 * left is evaluated FIRST and may throw before the true disjunct (probe 6).
 * Only a definite `true` authorizes a documented no-args branch.
 */
function absentGuardTrue(cond, lex) {
  const c = unwrapParens(cond);
  if (!c) return null;
  if (c.kind === TS.SyntaxKind.BinaryExpression) {
    const op = c.operatorToken && c.operatorToken.kind;
    if (op === TS.SyntaxKind.BarBarToken) {
      const l = absentGuardTrue(c.left, lex);
      if (l === true) return true;
      if (l === false) return absentGuardTrue(c.right, lex);
      return null;
    }
    if (op === TS.SyntaxKind.AmpersandAmpersandToken) {
      const l = absentGuardTrue(c.left, lex);
      if (l === false) return false;
      if (l === true) return absentGuardTrue(c.right, lex);
      return null;
    }
  }
  return foldGuardLeaf(c, lex, new Set());
}

/** True iff the condition is a no-arguments / missing-required-value test bound to argv. */
function isNoArgsTest(cond, ctx) {
  if (requiredValueGuard(cond, ctx.value)) return true;
  return absentGuardTrue(cond, ctx.lex) === true;
}

/** True iff the condition is a POSITIVE `--help`/`-h` test bound to the argv. */
function isHelpTest(cond, allIds) {
  // A negated test is the inverse of help support.
  if (cond.kind === TS.SyntaxKind.PrefixUnaryExpression && cond.operator === TS.SyntaxKind.ExclamationToken) {
    return false;
  }
  if (!isArgvExpr(cond, allIds)) return false;
  let hasHelp = false;
  const visit = (n) => {
    if (n.kind === TS.SyntaxKind.StringLiteral && ['--help', '-h'].includes(n.text)) hasHelp = true;
    TS.forEachChild(n, visit);
  };
  visit(cond);
  return hasHelp;
}

/** Statically-decided truth of a literal condition, or null if undecidable. */
function staticTruth(cond) {
  if (!cond) return null;
  if (cond.kind === TS.SyntaxKind.TrueKeyword) return true;
  if (cond.kind === TS.SyntaxKind.FalseKeyword) return false;
  if (cond.kind === TS.SyntaxKind.NumericLiteral) return Number(cond.text) !== 0;
  if (cond.kind === TS.SyntaxKind.StringLiteral) return cond.text.length > 0;
  if (cond.kind === TS.SyntaxKind.NullKeyword) return false;
  if (cond.kind === TS.SyntaxKind.Identifier && cond.text === 'undefined') return false;
  if (cond.kind === TS.SyntaxKind.PrefixUnaryExpression && cond.operator === TS.SyntaxKind.ExclamationToken) {
    const inner = staticTruth(cond.operand);
    return inner === null ? null : !inner;
  }
  return null;
}

/**
 * contract1076 (cases 2 & 6): does a STATEMENT unconditionally transfer control
 * away (return / throw / break / continue)? A statement AFTER such a statement in
 * the same statement list is UNREACHABLE and can contribute no guaranteed branch,
 * usage print or exit. A Block ends abruptly when scanning its statements reaches
 * an abrupt statement; an if/else ends abruptly only when BOTH arms do.
 */
function statementEndsAbruptly(stmt) {
  if (!stmt) return false;
  const k = stmt.kind;
  if (
    k === TS.SyntaxKind.ReturnStatement ||
    k === TS.SyntaxKind.ThrowStatement ||
    k === TS.SyntaxKind.BreakStatement ||
    k === TS.SyntaxKind.ContinueStatement
  ) {
    return true;
  }
  if (k === TS.SyntaxKind.Block) {
    for (const s of stmt.statements) if (statementEndsAbruptly(s)) return true;
    return false;
  }
  if (k === TS.SyntaxKind.IfStatement && stmt.thenStatement && stmt.elseStatement) {
    return statementEndsAbruptly(stmt.thenStatement) && statementEndsAbruptly(stmt.elseStatement);
  }
  return false;
}

/**
 * Resolve what a branch EMITS: whether it prints a usage-shaped line on a
 * REACHABLE path, and the documented exit code — following calls to
 * lexically-resolved REACHABLE local helpers (nesting included, cycle-guarded).
 * A foreign/imported helper is never followed, so its usage/exit cannot be
 * proven.
 *
 * Only REACHABLE, GUARANTEED emission/termination counts (execution-78 probe 4,
 * contract1076 cases 2 & 6): literal-dead branches are pruned, statements after
 * an unconditional return/throw/break/continue are UNREACHABLE and contribute
 * nothing, and an exit located in a branch whose condition is not statically
 * decided contributes NO code (it is not guaranteed for the actual branch). Exit
 * is the single explicit integer named on a guaranteed path; zero distinct
 * integers ⇒ null; two distinct integers, a non-literal exit, or only
 * conditional/dead exits ⇒ null (fail closed).
 */
function resolveEmission(branchNode, ctx, opts = {}) {
  let usagePrinted = false;
  const exits = new Set();
  let dynamicExit = false;
  let conditionalExit = false;
  const visitedFns = new Set();

  // A statement list contributes only its REACHABLE statements (abrupt tail pruned).
  const scanPrintList = (stmts) => {
    for (const s of stmts) {
      scanPrints(s);
      if (statementEndsAbruptly(s)) break;
    }
  };

  const scanPrints = (n) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.Block) {
      scanPrintList(n.statements);
      return;
    }
    if (n.kind === TS.SyntaxKind.IfStatement) {
      const t = staticTruth(n.expression);
      if (t === false) {
        if (n.elseStatement) scanPrints(n.elseStatement);
        return;
      }
      if (t === true) {
        scanPrints(n.thenStatement);
        return;
      }
      scanPrints(n.expression);
      scanPrints(n.thenStatement);
      if (n.elseStatement) scanPrints(n.elseStatement);
      return;
    }
    if (n.kind === TS.SyntaxKind.CallExpression) {
      const callee = text(n.expression);
      if (PRINT_CALLEE.test(callee)) {
        const argText = n.arguments.map((a) => text(a)).join(' ');
        if (USAGE_TEXT.test(argText)) usagePrinted = true;
      }
    }
    if (DEFERRED_FN.has(n.kind)) return; // do not descend into nested function bodies
    TS.forEachChild(n, scanPrints);
  };

  const scanBodyList = (stmts, conditional) => {
    for (const s of stmts) {
      scanBody(s, conditional);
      if (statementEndsAbruptly(s)) break;
    }
  };

  const scanBody = (n, conditional) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.Block) {
      scanBodyList(n.statements, conditional);
      return;
    }
    // Reachable, statically-decided control flow: follow ONLY the live branch.
    if (n.kind === TS.SyntaxKind.IfStatement) {
      const t = staticTruth(n.expression);
      if (t === false) {
        if (n.elseStatement) scanBody(n.elseStatement, conditional);
        return;
      }
      if (t === true) {
        scanBody(n.thenStatement, conditional);
        return;
      }
      // Not statically decided: neither branch is a GUARANTEED exit.
      scanBody(n.thenStatement, true);
      if (n.elseStatement) scanBody(n.elseStatement, true);
      return;
    }
    if (n.kind === TS.SyntaxKind.ConditionalExpression) {
      scanBody(n.whenTrue, true);
      scanBody(n.whenFalse, true);
      return;
    }
    if (n.kind === TS.SyntaxKind.BinaryExpression) {
      const op = n.operatorToken && n.operatorToken.kind;
      if (
        op === TS.SyntaxKind.AmpersandAmpersandToken ||
        op === TS.SyntaxKind.BarBarToken ||
        op === TS.SyntaxKind.QuestionQuestionToken
      ) {
        scanBody(n.left, true);
        scanBody(n.right, true);
        return;
      }
    }
    if (n.kind === TS.SyntaxKind.CallExpression) {
      const calleeText = text(n.expression);
      if (/^process\.exit$/.test(calleeText)) {
        const a0 = n.arguments[0];
        if (n.arguments.length === 1 && a0 && a0.kind === TS.SyntaxKind.NumericLiteral) {
          if (conditional) conditionalExit = true;
          else exits.add(Number(a0.text));
        } else {
          dynamicExit = true;
        }
      } else if (!opts.inlineOnly && n.expression && n.expression.kind === TS.SyntaxKind.Identifier) {
        // Helper indirection is followed ONLY when inline-only resolution is not
        // requested. The configuration-conditioned guard requires the Usage print
        // and the exit to be INLINE in the branch (no helper indirection), so a
        // `{ inlineOnly: true }` caller never resolves through a local helper.
        const fname = n.expression.text;
        const fn = resolveCalleeFunction(fname, n.expression, ctx.lex);
        if (fn && !visitedFns.has(fn)) {
          visitedFns.add(fn);
          scanPrints(fn.body);
          scanBody(fn.body, conditional);
        }
      }
    }
    if (DEFERRED_FN.has(n.kind)) return;
    TS.forEachChild(n, (c) => scanBody(c, conditional));
  };

  scanPrints(branchNode);
  scanBody(branchNode, false);
  const exit = !dynamicExit && !conditionalExit && exits.size === 1 ? [...exits][0] : null;
  return { usagePrinted, exit };
}

/** Identifiers invoked by a top-level (non-deferred) call, so a `main()` body counts. */
function topLevelCalledNames(sf) {
  const called = new Set();
  const visit = (n) => {
    if (!n) return;
    const kindName = TS.SyntaxKind[n.kind];
    if (DEFERRED.has(kindName)) return;
    if (n.kind === TS.SyntaxKind.CallExpression && TS.isIdentifier(n.expression)) called.add(n.expression.text);
    TS.forEachChild(n, visit);
  };
  for (const s of sf.statements) visit(s);
  return called;
}

/**
 * Collect if/ternary branches that are REACHABLE from the module top level:
 * top-level statements plus bodies of functions actually called at top level.
 * Branches inside un-invoked functions/classes are not reachable help/usage.
 *
 * contract1076 (cases 2 & 6): traversal is now STATEMENT-ORDER aware — within any
 * statement list, once an unconditional return/throw/break/continue is reached,
 * the remaining statements are UNREACHABLE and contribute NO branch. An
 * unsupported / uncertain enclosing path therefore stays unresolved rather than
 * crediting an unreachable guard.
 */
function collectBranches(sf, called) {
  const out = [];
  const walkStatements = (stmts) => {
    for (const s of stmts) {
      walk(s);
      if (statementEndsAbruptly(s)) break; // unreachable tail contributes nothing
    }
  };
  const walk = (n) => {
    if (!n) return;
    const kindName = TS.SyntaxKind[n.kind];
    if (DEFERRED.has(kindName)) {
      if (n.kind === TS.SyntaxKind.FunctionDeclaration && n.name && called.has(n.name.text)) {
        if (n.body && n.body.kind === TS.SyntaxKind.Block) walkStatements(n.body.statements);
        else if (n.body) walk(n.body);
      }
      return;
    }
    if (n.kind === TS.SyntaxKind.Block) {
      walkStatements(n.statements);
      return;
    }
    if (n.kind === TS.SyntaxKind.IfStatement) {
      out.push({ cond: n.expression, then: n.thenStatement, else: n.elseStatement });
      walk(n.expression);
      walk(n.thenStatement);
      if (n.elseStatement) walk(n.elseStatement);
      return;
    }
    if (n.kind === TS.SyntaxKind.ConditionalExpression) {
      out.push({ cond: n.condition, then: n.whenTrue, else: n.whenFalse });
      walk(n.condition);
      walk(n.whenTrue);
      walk(n.whenFalse);
      return;
    }
    TS.forEachChild(n, walk);
  };
  walkStatements(sf.statements);
  return out;
}

/**
 * configuration-conditioned recognition (CleanUp1 missing-DATABASE_URL smoke
 * context ONLY). These helpers are strictly bounded: they recognize the single
 * literal, unshadowed global `process.env.DATABASE_URL` access and its
 * missing-value test. They are used ONLY under the named smoke context; the
 * generic deriver never calls them.
 */

/** True iff `node` is the REAL, unshadowed global `process` identifier. */
function isRealGlobalProcessIdent(node) {
  return (
    !!node &&
    node.kind === TS.SyntaxKind.Identifier &&
    node.text === 'process' &&
    !nameShadowedAt('process', node)
  );
}

/** True iff `node` is a plain (non-optional) `process.env` access on real `process`. */
function isExactProcessEnvAccess(node) {
  return (
    !!node &&
    node.kind === TS.SyntaxKind.PropertyAccessExpression &&
    !node.questionDotToken &&
    node.name &&
    node.name.text === 'env' &&
    isRealGlobalProcessIdent(node.expression)
  );
}

/**
 * True iff `node` is EXACTLY a plain access of the global `process.env.DATABASE_URL`
 * slot — dotted (`process.env.DATABASE_URL`) or a string-literal element access
 * (`process.env['DATABASE_URL']`). Optional chaining is refused, and `process`
 * must be the real, unshadowed global (a local/parameter named `process` is a
 * different binding). No other env var is recognized.
 */
function isExactProcessEnvDatabaseUrl(node) {
  if (!node) return false;
  if (node.kind === TS.SyntaxKind.PropertyAccessExpression) {
    return (
      !node.questionDotToken &&
      node.name &&
      node.name.text === 'DATABASE_URL' &&
      isExactProcessEnvAccess(node.expression)
    );
  }
  if (node.kind === TS.SyntaxKind.ElementAccessExpression) {
    const arg = node.argumentExpression;
    return (
      !node.questionDotToken &&
      !!arg &&
      arg.kind === TS.SyntaxKind.StringLiteral &&
      arg.text === 'DATABASE_URL' &&
      isExactProcessEnvAccess(node.expression)
    );
  }
  return false;
}

/**
 * Truth of a missing-value test on `process.env.DATABASE_URL` under the smoke
 * context (`DATABASE_URL` unset ⇒ the value is exactly `undefined`):
 *   - `!process.env.DATABASE_URL`                       ⇒ true;
 *   - `X == null` / `X == undefined`                    ⇒ true (undefined == null);
 *   - `X === undefined`                                 ⇒ true;
 *   - `X === null` / `X !== undefined` / bare `X`       ⇒ NOT a missing test (null).
 * Returns `true` ONLY for a test that is definitely TRUE when the value is
 * `undefined`; anything else (a presence test, a shadowed `undefined`, an
 * unrelated env var, a dynamic operand) yields `null` (unrecognized).
 */
function databaseUrlMissingConditionTruth(cond) {
  const c = unwrapParens(cond);
  if (!c) return null;
  if (c.kind === TS.SyntaxKind.PrefixUnaryExpression && c.operator === TS.SyntaxKind.ExclamationToken) {
    return isExactProcessEnvDatabaseUrl(unwrapParens(c.operand)) ? true : null;
  }
  if (c.kind === TS.SyntaxKind.BinaryExpression) {
    const opK = c.operatorToken && c.operatorToken.kind;
    const op =
      opK === TS.SyntaxKind.EqualsEqualsToken
        ? '=='
        : opK === TS.SyntaxKind.EqualsEqualsEqualsToken
          ? '==='
          : opK === TS.SyntaxKind.ExclamationEqualsToken
            ? '!='
            : opK === TS.SyntaxKind.ExclamationEqualsEqualsToken
              ? '!=='
              : null;
    if (!op) return null;
    const l = unwrapParens(c.left);
    const r = unwrapParens(c.right);
    const lEnv = isExactProcessEnvDatabaseUrl(l);
    const rEnv = isExactProcessEnvDatabaseUrl(r);
    let lit = null;
    if (lEnv && !rEnv) lit = literalIdentity(r);
    else if (rEnv && !lEnv) lit = literalIdentity(l);
    else return null;
    if (!lit) return null;
    // Qualify ONLY when the comparison is TRUE for the exact no-args value
    // `undefined`. A false result means a PRESENCE test (e.g. `X !== undefined`),
    // which is not a missing-value guard.
    return compareExactToLiteral('undefined', op, lit) === true ? true : null;
  }
  return null;
}

/* ------------------------------------------------------------------------- *
 * NARROW, DEDICATED prover for the CleanUp1 missing-DATABASE_URL contract.
 *
 * Used ONLY under the named, immutable `MISSING_DATABASE_URL_SMOKE_CONTEXT`. It
 * is wholly separate from the generic `collectBranches` / `resolveEmission`
 * model, which it does NOT change. It credits a configuration-conditioned
 * no-args contract ONLY when, under the smoke context (DATABASE_URL absent, the
 * module run as the CLI entrypoint), there is a genuinely REACHABLE missing-value
 * guard on the REAL, unshadowed, unmutated global `process.env.DATABASE_URL`
 * whose taken branch DEFINITELY executes an inline literal Usage print through
 * the REAL unshadowed output method and a DEFINITE integer `process.exit` through
 * the REAL unmutated process. Dead / unknown / ambiguous enclosing branches never
 * count; called functions are resolved by LEXICAL BINDING (not by a same-spelling
 * name); direct-run boundaries are only `require.main === module` and its
 * SOURCE-PROVEN aliases (the argv[1] basename test and the typeof-guarded
 * conjunction), plus the actual IIFE `if (!isDirectRun) return;` shape. No bare
 * identifier is credited as a direct-run test, and supported-slot / output-method
 * mutations (and their lexical aliases) fail the whole rule closed.
 * ------------------------------------------------------------------------- */

/** Dotted / bracketed member chain path of an expression, or null. */
function memberChain(node) {
  const parts = [];
  let n = node;
  while (n) {
    if (n.kind === TS.SyntaxKind.PropertyAccessExpression) {
      if (n.questionDotToken || !n.name || !TS.isIdentifier(n.name)) return null;
      parts.unshift(n.name.text);
      n = n.expression;
    } else if (n.kind === TS.SyntaxKind.ElementAccessExpression) {
      if (n.questionDotToken) return null;
      const a = n.argumentExpression;
      if (a && a.kind === TS.SyntaxKind.StringLiteral) parts.unshift(a.text);
      else if (a && a.kind === TS.SyntaxKind.NumericLiteral) parts.unshift(a.text);
      else return null;
      n = n.expression;
    } else if (n.kind === TS.SyntaxKind.Identifier) {
      parts.unshift(n.text);
      n = null;
    } else {
      return null;
    }
  }
  return parts.join('.');
}

/**
 * Mutations that invalidate the config-guard proof, INCLUDING their lexical
 * aliases: an assignment to `process.env` (replacement) or
 * `process.env.DATABASE_URL` (or an alias of `process.env`), to `process.exit`
 * (or `process` itself, or an alias of `process`), to a `console` method (or an
 * alias of `console`), or to `process.stdout`/`process.stderr`. `Object.assign`
 * onto an env/console object/alias counts too. Any hit fails the whole rule
 * closed (conservative — a mutated support slot proves nothing).
 */
function collectConfigGuardMutations(sf) {
  const envAlias = new Set();
  const processAlias = new Set();
  const consoleAlias = new Set();
  const collectAliases = (n) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.VariableDeclaration && TS.isIdentifier(n.name) && n.initializer) {
      const chain = memberChain(unwrapParens(n.initializer));
      if (chain === 'process.env') envAlias.add(n.name.text);
      else if (chain === 'process') processAlias.add(n.name.text);
      else if (chain === 'console') consoleAlias.add(n.name.text);
    }
    TS.forEachChild(n, collectAliases);
  };
  collectAliases(sf);
  const startsWithAny = (c, set) => {
    if (!c) return false;
    for (const a of set) if (c === a || c.startsWith(a + '.')) return true;
    return false;
  };
  const m = { envMutated: false, exitMutated: false, consoleMutated: false, outputStreamMutated: false };
  const isProcessWhole = (c) => c === 'process' || processAlias.has(c);
  const visit = (n) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.BinaryExpression && ASSIGN_TOKENS.has(n.operatorToken && n.operatorToken.kind)) {
      const c = memberChain(unwrapParens(n.left));
      if (c === 'process.env' || c === 'process.env.DATABASE_URL' || startsWithAny(c, envAlias) || isProcessWhole(c)) m.envMutated = true;
      if (c === 'process.exit' || isProcessWhole(c)) m.exitMutated = true;
      if (c === 'console' || (c && (c.startsWith('console.') || startsWithAny(c, consoleAlias)))) m.consoleMutated = true;
      if (c === 'process.stdout' || c === 'process.stderr' || isProcessWhole(c)) m.outputStreamMutated = true;
    }
    if (
      n.kind === TS.SyntaxKind.CallExpression &&
      n.expression &&
      n.expression.kind === TS.SyntaxKind.PropertyAccessExpression &&
      n.expression.name &&
      n.expression.name.text === 'assign' &&
      n.expression.expression &&
      n.expression.expression.kind === TS.SyntaxKind.Identifier &&
      n.expression.expression.text === 'Object'
    ) {
      const target = memberChain(unwrapParens(n.arguments[0]));
      if (target === 'process.env' || startsWithAny(target, envAlias)) m.envMutated = true;
      if (target === 'console' || startsWithAny(target, consoleAlias)) m.consoleMutated = true;
    }
    TS.forEachChild(n, visit);
  };
  visit(sf);
  return m;
}

/** True iff `stmt` is an expression statement that terminates via `process.exit(...)`. */
function isProcessExitStatement(stmt) {
  if (!stmt || stmt.kind !== TS.SyntaxKind.ExpressionStatement) return false;
  let call = unwrapParens(stmt.expression);
  if (call && (call.kind === TS.SyntaxKind.VoidExpression || /^void\b/.test(text(call)))) {
    call = unwrapParens(call.expression);
  }
  return !!call && call.kind === TS.SyntaxKind.CallExpression && /^process\.exit$/.test(text(call.expression));
}

/**
 * Does control DEFINITELY continue past `stmt` on the executed path? An abrupt
 * transfer (return / throw / break / continue), a `process.exit(...)` statement,
 * or an undecidable branch whose either arm may exit, stops it (conservative).
 */
function reachContinues(stmt, lex) {
  if (!stmt) return true;
  const k = stmt.kind;
  if (
    k === TS.SyntaxKind.ReturnStatement ||
    k === TS.SyntaxKind.ThrowStatement ||
    k === TS.SyntaxKind.BreakStatement ||
    k === TS.SyntaxKind.ContinueStatement
  ) {
    return false;
  }
  if (isProcessExitStatement(stmt)) return false;
  if (k === TS.SyntaxKind.Block) {
    for (const s of stmt.statements) if (!reachContinues(s, lex)) return false;
    return true;
  }
  if (k === TS.SyntaxKind.IfStatement) {
    const bt = boundaryTruth(stmt.expression, lex);
    if (bt === true) return reachContinues(stmt.thenStatement, lex);
    if (bt === false) return stmt.elseStatement ? reachContinues(stmt.elseStatement, lex) : true;
    const t = stmt.thenStatement ? reachContinues(stmt.thenStatement, lex) : true;
    const e = stmt.elseStatement ? reachContinues(stmt.elseStatement, lex) : true;
    return t && e;
  }
  if (k === TS.SyntaxKind.TryStatement) {
    return reachContinues(stmt.tryBlock, lex) && (!stmt.finallyBlock || reachContinues(stmt.finallyBlock, lex));
  }
  if (
    k === TS.SyntaxKind.SwitchStatement ||
    k === TS.SyntaxKind.ForStatement ||
    k === TS.SyntaxKind.ForInStatement ||
    k === TS.SyntaxKind.ForOfStatement ||
    k === TS.SyntaxKind.WhileStatement ||
    k === TS.SyntaxKind.DoStatement
  ) {
    return false;
  }
  return true;
}

/**
 * Direct-invocation boundary proof — delegated to the ONE shared bounded proof
 * (`invocation-proof.mjs`). This REPLACES the previous in-module helpers
 * (isTypeofGlobalGuard / isSafeAlwaysTrueGuard / isRequireMainModuleCompare /
 * isScriptBasenameRegex / referencesArgv1Text / argDerivesFromArgv1 /
 * isFalsyLiteral / iifeProvesDirectRun / isDirectRunAlias) whose independently
 * reproduced FALSE ACCEPTANCES (root-review1217) were: any string literal
 * accepted by `.endsWith`, any `(...)?$`-containing regex, a transformed argv
 * subtree accepted by a text-regex reference, any `typeof` shape accepted as
 * always-true, and a direct-run return inside an unknown-conditioned IIFE branch
 * counted as definite. The shared proof compares literals/regexes to the ACTUAL
 * subject basename/stem/extension, requires an identity-preserving argv[1] path
 * derivation, proves `typeof` only for known real Node globals/argv values with
 * the expected type, and requires a DEFINITE terminal IIFE return.
 */
function isDirectRunTest(expr, lex) {
  // A source that assigns/mutates `process.argv` invalidates the argv[1] identity
  // premise (preserved from the pre-delegation deriver).
  if (ARGV_MUTATED) return false;
  return proveDirectInvocation(expr, { rel: lex.rel, sf: lex.sf });
}

/** Definite truth of an enclosing boundary under direct invocation, or null. */
function boundaryTruth(cond, lex) {
  const c = unwrapParens(cond);
  if (!c) return null;
  const st = staticTruth(c);
  if (st !== null) return st;
  if (c.kind === TS.SyntaxKind.PrefixUnaryExpression && c.operator === TS.SyntaxKind.ExclamationToken) {
    const inner = boundaryTruth(c.operand, lex);
    return inner === null ? null : !inner;
  }
  if (isDirectRunTest(c, lex)) return true;
  return null;
}

/**
 * Prove that `branchNode` (the taken branch of a missing-value guard) DEFINITELY
 * executes an inline literal Usage print through a REAL unshadowed output method
 * AND a definite integer `process.exit` through the REAL unmutated process.
 * Unknown-conditioned branches contribute nothing (a conditional usage/exit is
 * not guaranteed), so they are skipped conservatively.
 */
function proveGuardEmission(branchNode, lex) {
  let usage = false;
  const exits = new Set();
  let exitBad = false;

  const outputCalleeKind = (callee) => {
    if (!callee || callee.kind !== TS.SyntaxKind.PropertyAccessExpression || callee.questionDotToken) return null;
    const prop = callee.name && callee.name.text;
    const obj = unwrapParens(callee.expression);
    if (
      obj &&
      obj.kind === TS.SyntaxKind.Identifier &&
      obj.text === 'console' &&
      !nameShadowedAt('console', obj) &&
      ['log', 'error', 'info', 'warn', 'debug'].includes(prop)
    ) {
      return 'console';
    }
    if (
      obj &&
      obj.kind === TS.SyntaxKind.PropertyAccessExpression &&
      obj.name &&
      (obj.name.text === 'stdout' || obj.name.text === 'stderr') &&
      obj.expression &&
      obj.expression.kind === TS.SyntaxKind.Identifier &&
      obj.expression.text === 'process' &&
      !nameShadowedAt('process', obj.expression) &&
      prop === 'write'
    ) {
      return 'stream';
    }
    return null;
  };

  const visitCall = (call) => {
    const callee = call.expression;
    if (outputCalleeKind(callee)) {
      const a0 = call.arguments[0];
      const lit =
        a0 && (a0.kind === TS.SyntaxKind.StringLiteral || a0.kind === TS.SyntaxKind.NoSubstitutionTemplateLiteral) ? a0.text : null;
      if (lit !== null && USAGE_TEXT.test(lit)) usage = true;
      return;
    }
    if (callee && callee.kind === TS.SyntaxKind.PropertyAccessExpression && callee.name && callee.name.text === 'exit') {
      const obj = unwrapParens(callee.expression);
      if (obj && obj.kind === TS.SyntaxKind.Identifier && obj.text === 'process' && !nameShadowedAt('process', obj)) {
        const a0 = call.arguments[0];
        if (call.arguments.length === 1 && a0 && a0.kind === TS.SyntaxKind.NumericLiteral) exits.add(Number(a0.text));
        else exitBad = true;
      }
    }
  };

  const walkExpr = (e) => {
    if (!e) return;
    if (e.kind === TS.SyntaxKind.CallExpression) visitCall(e);
    if (DEFERRED_FN.has(e.kind)) return;
    TS.forEachChild(e, walkExpr);
  };
  const walkStmt = (n) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.Block) {
      walkList(n.statements);
      return;
    }
    if (n.kind === TS.SyntaxKind.IfStatement) {
      const bt = staticTruth(n.expression);
      if (bt === true) {
        walkStmt(n.thenStatement);
        return;
      }
      if (bt === false) {
        if (n.elseStatement) walkStmt(n.elseStatement);
        return;
      }
      return; // unknown condition: no guaranteed emission
    }
    if (n.kind === TS.SyntaxKind.ExpressionStatement) {
      walkExpr(n.expression);
      return;
    }
    if (n.kind === TS.SyntaxKind.VariableStatement) {
      for (const d of n.declarationList.declarations) if (d.initializer) walkExpr(d.initializer);
      return;
    }
    if (n.kind === TS.SyntaxKind.TryStatement) {
      walkStmt(n.tryBlock);
      if (n.finallyBlock) walkStmt(n.finallyBlock);
      return;
    }
  };
  const walkList = (stmts) => {
    for (const s of stmts) {
      walkStmt(s);
      if (!reachContinues(s, lex)) break;
    }
  };

  walkStmt(branchNode);
  const exit = !exitBad && exits.size === 1 ? [...exits][0] : null;
  if (!usage || exit === null) return null;
  return { usagePrinted: true, exit };
}

/**
 * Find a genuinely reachable missing-DATABASE_URL guard and prove its emission.
 * Returns { usagePrinted: true, exit } or null. Called-function bodies are
 * entered ONLY through a lexically-resolved call (require.main boundary, alias,
 * unconditional call, or IIFE) — dead and unknown enclosing branches are never
 * descended, and a same-spelling shadow is never mistaken for the real callee.
 */
function findDatabaseUrlGuard(sf, lex) {
  let result = null;
  const seenFns = new Set();
  const visitFn = (fn) => {
    if (!fn || seenFns.has(fn)) return;
    seenFns.add(fn);
    if (fn.body && fn.body.kind === TS.SyntaxKind.Block) walkList(fn.body.statements);
    else if (fn.body) walkStmt(fn.body);
  };
  const guardCheck = (ifNode) => {
    if (result) return;
    if (databaseUrlMissingConditionTruth(ifNode.expression) !== true) return;
    const em = proveGuardEmission(ifNode.thenStatement, lex);
    if (em && em.usagePrinted && em.exit !== null) result = { usagePrinted: true, exit: em.exit };
  };
  const walkStmt = (n) => {
    if (result || !n) return;
    if (n.kind === TS.SyntaxKind.Block) {
      walkList(n.statements);
      return;
    }
    if (n.kind === TS.SyntaxKind.IfStatement) {
      guardCheck(n);
      if (result) return;
      const bt = boundaryTruth(n.expression, lex);
      if (bt === true) walkStmt(n.thenStatement);
      else if (bt === false && n.elseStatement) walkStmt(n.elseStatement);
      return;
    }
    if (n.kind === TS.SyntaxKind.ExpressionStatement) {
      walkExpr(n.expression);
      return;
    }
    if (n.kind === TS.SyntaxKind.VariableStatement) {
      for (const d of n.declarationList.declarations) if (d.initializer) walkExpr(d.initializer);
      return;
    }
    if (n.kind === TS.SyntaxKind.TryStatement) {
      walkStmt(n.tryBlock);
      if (n.finallyBlock) walkStmt(n.finallyBlock);
      return;
    }
  };
  const walkList = (stmts) => {
    for (const s of stmts) {
      walkStmt(s);
      if (result) return;
      if (!reachContinues(s, lex)) break;
    }
  };
  const walkExpr = (n) => {
    if (result || !n) return;
    if (n.kind === TS.SyntaxKind.CallExpression) {
      const callee = unwrapParens(n.expression);
      if (callee && (callee.kind === TS.SyntaxKind.ArrowFunction || callee.kind === TS.SyntaxKind.FunctionExpression)) {
        walkStmt(callee.body); // a top-level / nested IIFE runs immediately
        for (const a of n.arguments) walkExpr(a);
        return;
      }
      if (callee && callee.kind === TS.SyntaxKind.Identifier) {
        const fn = resolveCalleeFunction(callee.text, callee, lex);
        if (fn) visitFn(fn);
        for (const a of n.arguments) walkExpr(a);
        return;
      }
      walkExpr(n.expression);
      for (const a of n.arguments) walkExpr(a);
      return;
    }
    if (DEFERRED_FN.has(n.kind)) return; // deferred callback body: not executed here
    if (n.kind === TS.SyntaxKind.ParenthesizedExpression) {
      walkExpr(n.expression);
      return;
    }
    TS.forEachChild(n, walkExpr);
  };
  walkList(sf.statements);
  return result;
}

/**
 * Derive the documented contract for one entrypoint from its source text.
 *
 * `context` is OPTIONAL. When it is EXACTLY the named, immutable
 * `MISSING_DATABASE_URL_SMOKE_CONTEXT`, the deriver ALSO recognizes the
 * configuration-conditioned no-args contract (a literal global
 * `process.env.DATABASE_URL` missing-value guard with an inline Usage print and
 * a definite integer exit). For any other value — including the default
 * `undefined` — the deriver stays CONSERVATIVE and recognizes none of it.
 */
export function deriveContract(source, relPath, context = null) {
  const s = typeof source === 'string' ? source : '';
  if (!TS) {
    return {
      noArgs: { documented: false, exit: null, usagePrinted: false },
      help: { supported: false },
      evidence: `derived from ${relPath}: TypeScript parser unavailable — contract cannot be derived (fail closed)`,
    };
  }
  const sf = TS.createSourceFile(relPath, s, TS.ScriptTarget.Latest, true, scriptKindFor(relPath) ?? TS.ScriptKind.TS);
  ARGV_MUTATED = argvIsMutated(sf);
  const bindingScopes = buildBindingScopes(sf);
  const checker = buildChecker(sf, s);
  const dirty = dirtyIntrinsicMethods(sf);
  const lex = { map: bindingScopes, checker, dirty, sf, rel: relPath };
  const bindings = collectArgvBindings(sf, lex);
  const ctx = { all: bindings.all, value: bindings.value, absent: bindings.absent, lex };
  const called = topLevelCalledNames(sf);
  const branches = collectBranches(sf, called);

  let help = { supported: false };
  for (const b of branches) {
    if (!isHelpTest(b.cond, ctx.all)) continue;
    const thenE = resolveEmission(b.then, ctx);
    const elseE = b.else ? resolveEmission(b.else, ctx) : { usagePrinted: false, exit: null };
    if (thenE.usagePrinted || elseE.usagePrinted) {
      const em = thenE.usagePrinted ? thenE : elseE;
      help = { supported: true, exit: em.exit, usagePrinted: true };
      break;
    }
  }

  let noArgs = { documented: false, exit: null, usagePrinted: false };
  for (const b of branches) {
    if (!isNoArgsTest(b.cond, ctx)) continue;
    const em = resolveEmission(b.then, ctx);
    if (em.usagePrinted) {
      noArgs = { documented: true, exit: em.exit, usagePrinted: true };
      break;
    }
  }

  // Configuration-conditioned no-args contract — ONLY under the named, immutable
  // missing-DATABASE_URL smoke context, and ONLY when the source has no ordinary
  // argv-based documented no-args branch (configured behavior is never
  // overridden). Recognition uses the DEDICATED narrow prover: a REACHABLE
  // missing-value guard on the real, unshadowed, unmutated global
  // `process.env.DATABASE_URL` whose taken branch DEFINITELY prints an inline
  // literal Usage line through a real unshadowed output method and names a
  // DEFINITE integer `process.exit(N)` through the real unmutated process. Dead,
  // unknown and ambiguous enclosing branches never count, and supported-slot /
  // output-method mutations (and their lexical aliases) fail the whole rule
  // closed. The generic model above is untouched.
  if (context === MISSING_DATABASE_URL_SMOKE_CONTEXT && noArgs.documented !== true) {
    const mut = collectConfigGuardMutations(sf);
    let proven = null;
    if (!mut.envMutated && !mut.exitMutated && !mut.consoleMutated && !mut.outputStreamMutated) {
      proven = findDatabaseUrlGuard(sf, lex);
    }
    if (proven && proven.usagePrinted && proven.exit !== null) {
      noArgs = {
        documented: true,
        exit: proven.exit,
        usagePrinted: true,
        conditioned: 'missing-database-url',
      };
    }
  }

  let documentationError = null;
  if (context === MISSING_DATABASE_URL_SMOKE_CONTEXT) {
    const documentation = explicitSmokeDocumentation(sf);
    if (documentation) {
      documentationError = documentation.error ?? null;
      if (!documentationError && noArgs.exit !== null && noArgs.exit !== documentation.noArgsExit) {
        documentationError = 'explicit no-args exit conflicts with the source-derived exit';
      }
      if (!documentationError && documentation.helpExit !== undefined && help.exit != null && help.exit !== documentation.helpExit) {
        documentationError = 'explicit help exit conflicts with the source-derived exit';
      }
      if (documentationError) {
        noArgs = { documented: false, exit: null, usagePrinted: false };
      } else {
        noArgs = { documented: true, exit: documentation.noArgsExit, usagePrinted: noArgs.usagePrinted,
          usageRequired: true, documentation: 'leading-source-comment' };
        if (documentation.helpExit !== undefined) {
          help = { supported: true, exit: documentation.helpExit, usageRequired: true, documentation: 'leading-source-comment' };
        }
      }
    }
  }

  return {
    noArgs,
    help,
    evidence:
      `derived from ${relPath}: ${documentationError ? documentationError + '; ' : ''}` +
      `${noArgs.documented ? `documented ${noArgs.conditioned ? `configuration-conditioned (${noArgs.conditioned}) ` : ''}no-args usage branch (exit ${noArgs.exit === null ? 'not named' : noArgs.exit})` : 'NO documented no-args usage branch'}; ` +
      `${help.supported ? `documented --help handler (exit ${help.exit === null ? 'not named' : help.exit})` : 'no --help handler'}`,
  };
}
