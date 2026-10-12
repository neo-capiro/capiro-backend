/**
 * CleanUp1 — reviewed AST codemod for the missing-DATABASE_URL CLI guard.
 *
 * WHAT THIS DOES (reviewable, bounded, fail-closed)
 *   For each EXPLICITLY SELECTED subject named in the supplied hash manifest, and
 *   ONLY when the current file bytes hash to the manifest's canonical
 *   `sourceSha256`, this inserts a single main-owned INLINE guard at the top of
 *   the declared `main` function body:
 *
 *       if (!process.env.DATABASE_URL) {
 *         console.error('Usage: <rel> requires DATABASE_URL (database configuration is required)');
 *         process.exit(2);
 *       }
 *
 *   placed BEFORE any Prisma/network/operational work, while leaving any
 *   leading dotenv / config-file loading that supplies DB configuration intact.
 *
 *   When the entrypoint's single top-level `main` execution is UNCONDITIONAL (a
 *   direct `main()` / `void main().catch(...)` at module top level), the codemod
 *   wraps the EXACT existing statement — bytes preserved verbatim — in a safe
 *   direct-invocation boundary appropriate to the Node16/CJS configuration:
 *
 *       if (require.main === module) {
 *         <exact existing statement, unchanged>
 *       }
 *
 *   An entrypoint whose `main` is ALREADY behind a direct-invocation boundary
 *   (an enclosing `if (require.main === module)` / regex-`direct` test, or a
 *   `void (async () => { … isDirectRun … await main() … })()` IIFE) keeps its
 *   existing boundary untouched — only the guard is inserted.
 *
 *   NO product file is edited by this module itself. The CLI computes and records
 *   an exact per-file before/after/placement ledger and, with `--apply`, writes
 *   the transformed bytes only after re-verifying the before-hash. Refused /
 *   changed / complicated subjects are RETAINED as `pending` in the ledger and
 *   are never waived.
 *
 * HARD CONSTRAINTS (fail closed, refuse rather than guess)
 *   - only EXPLICIT selected subjects from the manifest, with matching before-hash;
 *     the manifest selection must be NON-EMPTY, UNIQUE, hash-valid and confined to
 *     ordinary source files under the root, and the before-hash is RE-VERIFIED
 *     immediately before any `--apply` write;
 *   - refuse a subject that already contains `DATABASE_URL` text (idempotency);
 *   - refuse a subject with >1 top-level `main` declaration, no `main`, a
 *     non-block `main` body, no direct `new PrismaClient()` inside `main`, a
 *     parse error, an exotic main-execution shape, multiple `main()` call sites,
 *     a `main()` called from a named helper, or a top-level statement with a
 *     trailing line comment (ambiguity);
 *   - an existing conditional boundary is preserved ONLY when its condition is a
 *     SOURCE-PROVEN direct-invocation test (`require.main === module`, its
 *     typeof-guarded conjunction, or the argv[1] basename test / a proven alias
 *     of either); a bare identifier with no such source-proven initializer is
 *     refused, never guessed;
 *   - a leading config load is skipped ONLY when it is a SINGLE real imported
 *     `dotenv` config call (never an arbitrary local `config()`, never a
 *     comma/sequence expression that could perform operational I/O);
 *   - the ONLY bytes changed are the inserted guard + the optional boundary
 *     wrapper. The output is verified to re-parse cleanly, to carry exactly ONE
 *     environment READ of the variable plus exactly ONE diagnostic Usage MENTION,
 *     and to reduce EXACTLY to the original source once the inserted ranges are
 *     removed. The whole file is NEVER reprinted through the TypeScript printer.
 *
 * The pure `analyzePlacement` / `transformConfigGuard` functions carry all logic
 * and are exercised directly by `config-guard-controls.mjs` with in-memory
 * fixtures — the CLI is a thin, bounded wrapper. The CLI body runs ONLY when this
 * exact file is the invoked entrypoint (resolved absolute path identity), so
 * importing it (or a same-basename peer) is import-safe; unknown options are
 * rejected even alongside `--help`. The no-clobber `--out-ledger` is unchanged.
 *
 * Usage:
 *   node scripts/cleanup-script-smoke/config-guard-codemod.mjs \
 *        --root <repo> --manifest <file> --out-ledger <file> \
 *        [--subject <rel>]... [--apply] [--help]
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { proveDirectInvocation } from './invocation-proof.mjs';

let TS = null;
try {
  TS = createRequire(import.meta.url)('typescript');
} catch {
  TS = null;
}

/** The literal environment variable the guard keys on. */
export const GUARD_ENV_VAR = 'DATABASE_URL';
/** The explicit, definite exit code the guard names. */
export const GUARD_EXIT_CODE = 2;
/** The ledger schema id. */
export const LEDGER_SCHEMA = 'capiro.cleanup1-config-guard-codemod-ledger';

const PRISMA_CONSTRUCTOR_RE = /new\s+PrismaClient\s*\(/;
const DATABASE_URL_RE = /\bDATABASE_URL\b/;

/** sha256 hex of a UTF-8 string. */
export function sha256hex(text) {
  return createHash('sha256').update(Buffer.from(String(text), 'utf8')).digest('hex');
}

/**
 * Count ACTUAL environment reads of the guard variable (`process.env.DATABASE_URL`
 * — the dotted form the codemod emits), as distinct from DIAGNOSTIC TEXT that
 * merely MENTIONS the variable name (the Usage message). The generated guard is
 * the ONE code read; its single Usage line is diagnostic text. Failure-1 repair:
 * the old invariant compared the RAW `DATABASE_URL` token count to 1 and so always
 * refused the codemod's own valid output (which necessarily contains one code read
 * AND one diagnostic mention).
 */
export function countEnvReads(textValue) {
  return (String(textValue).match(new RegExp(`process\\s*\\.\\s*env\\s*\\.\\s*${GUARD_ENV_VAR}\\b`, 'g')) || []).length;
}

/** Count raw `DATABASE_URL` word tokens (code reads PLUS diagnostic mentions). */
export function countDatabaseUrlTokens(textValue) {
  return (String(textValue).match(new RegExp(`\\b${GUARD_ENV_VAR}\\b`, 'g')) || []).length;
}

function scriptKindFor(name) {
  return /\.(ts|mts|cts)$/.test(name) ? TS.ScriptKind.TS : TS.ScriptKind.JS;
}

function text(n) {
  return n && n.getText ? n.getText() : '';
}

/** 1-based line number of a character offset. */
function lineOf(source, offset) {
  let line = 1;
  for (let i = 0; i < offset && i < source.length; i++) if (source[i] === '\n') line++;
  return line;
}

/** Leading indentation (whitespace run) of the line containing `offset`. */
function indentAt(source, offset) {
  const nl = source.lastIndexOf('\n', offset - 1);
  const start = nl + 1;
  const lead = source.slice(start, offset);
  return /^[ \t]*$/.test(lead) ? lead : '';
}

/** Strip redundant parentheses. */
function unwrapParens(node) {
  let n = node;
  while (n && n.kind === TS.SyntaxKind.ParenthesizedExpression) n = n.expression;
  return n;
}

/**
 * Classify HOW the `main(...)` call at `call` executes, by ascending the parent
 * chain to the first enclosing construct:
 *   - 'if'       an enclosing IfStatement (a boundary condition) reached before
 *                any enclosing function;
 *   - 'iife'     an enclosing immediately-invoked function expression;
 *   - 'function'  an enclosing NAMED function (complicated — refused);
 *   - 'top'      no enclosing if/function: a direct module-top-level execution.
 */
function callRegion(call) {
  let ifAncestor = null;
  let p = call.parent;
  while (p) {
    if (p.kind === TS.SyntaxKind.IfStatement && !ifAncestor) ifAncestor = p;
    if (p.kind === TS.SyntaxKind.FunctionDeclaration || p.kind === TS.SyntaxKind.FunctionExpression || p.kind === TS.SyntaxKind.ArrowFunction) {
      // Determine whether this function is an immediately-invoked one.
      let outer = p.parent;
      if (outer && outer.kind === TS.SyntaxKind.ParenthesizedExpression) outer = outer.parent;
      if (outer && outer.kind === TS.SyntaxKind.CallExpression && unwrapParens(outer.expression) === unwrapParens(p)) {
        return { region: 'iife', node: p };
      }
      return { region: 'function', node: p };
    }
    if (p.kind === TS.SyntaxKind.SourceFile) break;
    p = p.parent;
  }
  if (ifAncestor) return { region: 'if', node: ifAncestor, cond: ifAncestor.expression };
  return { region: 'top', node: call };
}

/** The statement list element (direct child of a Block/SourceFile) containing `node`. */
function enclosingStatement(node) {
  let n = node;
  while (n && n.parent && n.parent.kind !== TS.SyntaxKind.Block && n.parent.kind !== TS.SyntaxKind.SourceFile) n = n.parent;
  return n;
}

/* ------------------------------------------------------------------------- *
 * Bounded SOURCE-PROVEN predicates shared by the placement analysis: a real
 * imported dotenv config call, and a source-proven direct-invocation test.
 * ------------------------------------------------------------------------- */

/* ------------------------------------------------------------------------- *
 * SOURCE-PROVEN direct-invocation boundary. Delegated to the ONE shared,
 * bounded proof (`invocation-proof.mjs`) so this codemod and the dedicated
 * configuration contract can never diverge. The old per-module last-name / any
 * string-literal / any typeof-shape predicates were REMOVED: they accepted
 * unrelated literals, transformed argv subtrees, unknown typeof symbols and
 * conditional IIFE returns. The shared proof binds every accepted shape to the
 * ACTUAL subject path/basename/extension.
 * ------------------------------------------------------------------------- */

/** True iff the enclosing boundary condition is a source-proven direct-run test. */
function isDirectRunBoundary(cond, sf, rel) {
  return proveDirectInvocation(cond, { rel, sf });
}

/** Local names bound by `import ... from 'dotenv'` (default, namespace, or named). */
function dotenvConfigNames(sf) {
  const names = new Set();
  for (const stmt of sf.statements) {
    if (stmt.kind !== TS.SyntaxKind.ImportDeclaration) continue;
    const spec = stmt.moduleSpecifier && stmt.moduleSpecifier.kind === TS.SyntaxKind.StringLiteral ? stmt.moduleSpecifier.text : null;
    if (spec !== 'dotenv') continue;
    const cl = stmt.importClause;
    if (!cl) continue;
    if (cl.name && TS.isIdentifier(cl.name)) names.add(cl.name.text);
    const nb = cl.namedBindings;
    if (nb) {
      if (nb.kind === TS.SyntaxKind.NamespaceImport && nb.name && TS.isIdentifier(nb.name)) names.add(nb.name.text);
      else if (nb.elements) for (const el of nb.elements) if (el && el.name && TS.isIdentifier(el.name)) names.add(el.name.text);
    }
  }
  return names;
}

/**
 * True iff `stmt` is a SINGLE real imported dotenv config call — an
 * ExpressionStatement whose expression is exactly ONE call to a binding imported
 * from 'dotenv' (`config()`/`configDotenv()` or `<dotenv>.config()`). A comma /
 * sequence expression (which could run operational I/O first) or an arbitrary
 * local `config()` does NOT qualify.
 */
function isDotenvConfigStatement(stmt, names) {
  if (!stmt || stmt.kind !== TS.SyntaxKind.ExpressionStatement) return false;
  const call = stmt.expression;
  if (!call || call.kind !== TS.SyntaxKind.CallExpression) return false;
  const callee = call.expression;
  if (callee.kind === TS.SyntaxKind.Identifier) return names.has(callee.text);
  if (callee.kind === TS.SyntaxKind.PropertyAccessExpression && callee.name && callee.name.text === 'config') {
    const obj = callee.expression;
    return !!obj && obj.kind === TS.SyntaxKind.Identifier && names.has(obj.text);
  }
  return false;
}

/**
 * Analyze one source string's placement for the missing-DATABASE_URL guard.
 * PURE: no filesystem, no process. Returns
 *   { ok: true, placement } or { ok: false, reasons:[...] }.
 */
export function analyzePlacement(source, rel, { mainName = 'main' } = {}) {
  const reasons = [];
  if (!TS) return { ok: false, reasons: ['TypeScript parser unavailable (fail closed)'] };
  if (typeof source !== 'string' || source.length === 0) return { ok: false, reasons: ['empty source'] };
  if (DATABASE_URL_RE.test(source)) return { ok: false, reasons: ['source already references DATABASE_URL (idempotency guard)'] };

  const sf = TS.createSourceFile(rel, source, TS.ScriptTarget.Latest, true, scriptKindFor(rel) ?? TS.ScriptKind.TS);
  if (sf.parseDiagnostics && sf.parseDiagnostics.length) {
    return { ok: false, reasons: [`source does not parse cleanly (${sf.parseDiagnostics.length} diagnostic(s))`] };
  }

  const mains = sf.statements.filter(
    (s) => s.kind === TS.SyntaxKind.FunctionDeclaration && s.name && s.name.text === mainName,
  );
  if (mains.length !== 1) return { ok: false, reasons: [`expected exactly one top-level function '${mainName}' (found ${mains.length})`] };
  const mainDecl = mains[0];
  const exportedMain = mainDecl.modifiers?.some((m) => m.kind === TS.SyntaxKind.ExportKeyword)
    || sf.statements.some((s) =>
      (TS.isExportDeclaration(s) && s.exportClause && TS.isNamedExports(s.exportClause)
        && s.exportClause.elements.some((e) => (e.propertyName ?? e.name).text === mainName))
      || (TS.isExportAssignment(s) && TS.isIdentifier(s.expression) && s.expression.text === mainName));
  if (exportedMain) {
    return { ok: false, reasons: [`'${mainName}' is exported; a CLI guard must stay outside the library function`] };
  }
  if (!mainDecl.body || mainDecl.body.kind !== TS.SyntaxKind.Block) {
    return { ok: false, reasons: [`'${mainName}' body is not a block statement`] };
  }
  const mainBody = mainDecl.body;
  if (!mainBody.statements || mainBody.statements.length === 0) {
    return { ok: false, reasons: [`'${mainName}' body is empty`] };
  }
  if (!PRISMA_CONSTRUCTOR_RE.test(text(mainBody))) {
    return { ok: false, reasons: [`no direct 'new PrismaClient()' inside '${mainName}'`] };
  }

  // Config-loading lead: keep a REAL imported dotenv/config-file load that
  // supplies DB config AHEAD of the guard. Skip a contiguous leading run of such
  // statements. The call must be a single imported dotenv binding (never an
  // arbitrary local `config()`, and never a comma/sequence expression that could
  // perform operational I/O before the guard).
  const dotenvNames = dotenvConfigNames(sf);
  let lead = 0;
  while (lead < mainBody.statements.length && isDotenvConfigStatement(mainBody.statements[lead], dotenvNames)) {
    lead++;
  }
  if (lead >= mainBody.statements.length) {
    return { ok: false, reasons: [`all '${mainName}' statements are config loads — no safe guard placement`] };
  }
  const insertTarget = mainBody.statements[lead];
  const guardOffset = insertTarget.getStart();
  const guardIndent = indentAt(source, guardOffset);
  if (guardIndent === '') reasons.push('could not determine guard indentation');

  // Locate the (single) top-level 'main()' execution site and classify it.
  const calls = [];
  const visit = (n) => {
    if (!n) return;
    if (n.kind === TS.SyntaxKind.CallExpression && n.expression && n.expression.kind === TS.SyntaxKind.Identifier && n.expression.text === mainName) {
      // Exclude the declaration's own name node (not a call) — only real calls.
      calls.push(n);
    }
    TS.forEachChild(n, visit);
  };
  visit(sf);
  if (calls.length !== 1) {
    return { ok: false, reasons: [`expected exactly one '${mainName}()' call site at module top level (found ${calls.length})`] };
  }
  const region = callRegion(calls[0]);

  let boundary;
  const edits = [];
  if (region.region === 'top') {
    const stmt = enclosingStatement(calls[0]);
    if (!stmt || (stmt.parent && stmt.parent.kind !== TS.SyntaxKind.SourceFile)) {
      return { ok: false, reasons: ['unconditional main call is not a direct module-level statement'] };
    }
    // Only an EXPRESSION statement (`void main().catch(...)`, `main();`, …) may be
    // wrapped: a variable/export/import DECLARATION would change scoping or
    // grammar when moved inside the new block, so it is refused.
    if (stmt.kind !== TS.SyntaxKind.ExpressionStatement) {
      return { ok: false, reasons: [`unconditional main call is not a module-level expression statement (kind ${TS.SyntaxKind[stmt.kind]}) — refused`] };
    }
    const stmtStart = stmt.getStart();
    const stmtEnd = stmt.getEnd();
    const tail = source.slice(stmtEnd, source.indexOf('\n', stmtEnd) < 0 ? source.length : source.indexOf('\n', stmtEnd));
    if (tail.includes('//')) return { ok: false, reasons: ['top-level main statement has a trailing line comment (ambiguous wrap)'] };
    const wrapIndent = indentAt(source, stmtStart);
    edits.push({ kind: 'boundary-open', offset: stmtStart, text: `if (require.main === module) {\n${wrapIndent}` });
    edits.push({ kind: 'boundary-close', offset: stmtEnd, text: `\n${wrapIndent}}` });
    boundary = 'wrapped';
  } else if (region.region === 'if') {
    // An existing conditional boundary is preserved ONLY when its condition is a
    // SOURCE-PROVEN direct-invocation test (`require.main === module`, a proven
    // alias of it / of the argv[1] basename test). A bare identifier that does
    // not resolve to such an initializer is REFUSED, never guessed.
    if (!isDirectRunBoundary(region.cond, sf, rel)) {
      return { ok: false, reasons: [`enclosing boundary condition is not a source-proven direct-invocation test: ${JSON.stringify(text(region.cond))}`] };
    }
    boundary = 'existing-conditional';
  } else if (region.region === 'iife') {
    boundary = 'existing-iife';
  } else {
    return { ok: false, reasons: [`'${mainName}' is invoked from a named helper — complicated placement, refused`] };
  }

  // The inline guard text. The leading newline/indent before guardOffset already
  // supplies the first-line indentation, so the inserted text starts at column 0.
  const guard =
    `if (!process.env.${GUARD_ENV_VAR}) {\n` +
    `${guardIndent}  console.error('Usage: ${rel} requires ${GUARD_ENV_VAR} (database configuration is required)');\n` +
    `${guardIndent}  process.exit(${GUARD_EXIT_CODE});\n` +
    `${guardIndent}}\n` +
    `${guardIndent}`;
  edits.push({ kind: 'guard', offset: guardOffset, text: guard });

  return {
    ok: true,
    placement: {
      rel,
      mainName,
      boundary,
      configLeadStatements: lead,
      guardLine: lineOf(source, guardOffset),
      callLine: lineOf(source, calls[0].getStart()),
      edits: edits.map((e) => ({ kind: e.kind, offset: e.offset, length: e.text.length, line: lineOf(source, e.offset) })),
    },
    _edits: edits,
  };
}

/** Apply non-overlapping insert edits to `source` (descending offset). */
export function applyEdits(source, edits) {
  const sorted = [...edits].sort((a, b) => b.offset - a.offset);
  let out = source;
  for (const e of sorted) out = out.slice(0, e.offset) + e.text + out.slice(e.offset);
  return out;
}

/** Remove the inserted ranges from `output`, reconstructing the original source. */
function stripEdits(output, edits) {
  const asc = [...edits].sort((a, b) => a.offset - b.offset);
  let res = '';
  let outPos = 0;
  let srcPos = 0;
  for (const e of asc) {
    const start = e.offset + (outPos - srcPos);
    res += output.slice(outPos, start);
    outPos = start + e.text.length;
    srcPos = e.offset;
  }
  res += output.slice(outPos);
  return res;
}

/**
 * Pure transform. Returns
 *   { ok:true, output, placement, beforeSha256, afterSha256 }
 * or { ok:false, reasons:[...] }. NEVER touches the filesystem.
 */
export function transformConfigGuard(source, rel, opts = {}) {
  const a = analyzePlacement(source, rel, opts);
  if (!a.ok) return { ok: false, reasons: a.reasons };
  const output = applyEdits(source, a._edits);
  // Verify: the output re-parses; it carries EXACTLY ONE environment READ of
  // DATABASE_URL (the inserted guard) plus EXACTLY ONE diagnostic Usage MENTION
  // (distinct from a code read); and removing every inserted range yields the
  // ORIGINAL bytes exactly. Failure-1 repair: the old check compared the raw
  // token count to 1, but the guard's own Usage message legitimately names the
  // variable, so a valid transform always has two tokens.
  const sf2 = TS.createSourceFile(rel, output, TS.ScriptTarget.Latest, true, scriptKindFor(rel) ?? TS.ScriptKind.TS);
  if (sf2.parseDiagnostics && sf2.parseDiagnostics.length) {
    return { ok: false, reasons: [`transformed source does not re-parse (${sf2.parseDiagnostics.length} diagnostic(s))`] };
  }
  const codeReads = countEnvReads(output);
  const diagnosticMentions = countDatabaseUrlTokens(output) - codeReads;
  if (codeReads !== 1 || diagnosticMentions !== 1) {
    return {
      ok: false,
      reasons: [
        `transformed source has ${codeReads} DATABASE_URL code read(s) and ${diagnosticMentions} diagnostic mention(s) (expected 1 and 1)`,
      ],
    };
  }
  if (stripEdits(output, a._edits) !== source) {
    return { ok: false, reasons: ['byte-preservation check failed: output does not reduce to the original source'] };
  }
  return {
    ok: true,
    output,
    placement: a.placement,
    beforeSha256: sha256hex(source),
    afterSha256: sha256hex(output),
  };
}

/* ------------------------------------------------------------------------- *
 * Bounded explicit CLI — a thin wrapper over the pure transform above.
 * ------------------------------------------------------------------------- */

const USAGE =
  'usage: node scripts/cleanup-script-smoke/config-guard-codemod.mjs --root <repo> --manifest <file> --out-ledger <file> [--subject <rel>]... [--apply]';

class UsageError extends Error {}

/** Exported for the controls; throws UsageError on any unknown/missing input. */
export function parseArgs(argv) {
  const opts = { apply: false, subjects: [], help: false };
  const needValue = (a, i) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) throw new UsageError(`${a} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = needValue(a, i++);
    else if (a === '--manifest') opts.manifest = needValue(a, i++);
    else if (a === '--out-ledger') opts.outLedger = needValue(a, i++);
    else if (a === '--subject') opts.subjects.push(needValue(a, i++));
    else if (a === '--help') opts.help = true;
    else if (a === '--apply') opts.apply = true;
    // An UNKNOWN option is rejected even alongside --help: parsing throws BEFORE
    // the --help short-circuit below, so `--help --bogus` is a usage error (exit 2).
    else throw new UsageError(`unknown option: ${a}`);
  }
  if (opts.help) return opts; // --help relaxes the required-value checks only
  if (!opts.root) throw new UsageError('--root is required');
  if (!opts.manifest) throw new UsageError('--manifest is required');
  if (!opts.outLedger) throw new UsageError('--out-ledger is required');
  return opts;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ORDINARY_SOURCE_RE = /\.(?:ts|mts|cts|js|mjs|cjs)$/;

/**
 * Read + validate the selection manifest. Fail closed on any missing shape: it
 * must carry a NON-EMPTY `selected` array of UNIQUE subjects, each an ordinary
 * source file with a well-formed sha256 (confinement to root is re-checked per
 * subject during planning).
 */
export function loadManifest(manifestPath) {
  const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (!Array.isArray(raw.selected) || raw.selected.length === 0) throw new Error('manifest has no non-empty `selected` array');
  const seen = new Set();
  const selected = raw.selected.map((e) => {
    if (!e || typeof e.rel !== 'string' || typeof e.sourceSha256 !== 'string') {
      throw new Error('manifest `selected` entry missing rel/sourceSha256');
    }
    if (!ORDINARY_SOURCE_RE.test(e.rel) || isAbsolute(e.rel) || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(e.rel)) {
      throw new Error(`manifest subject is not a confined ordinary source file: ${e.rel}`);
    }
    if (!SHA256_HEX.test(e.sourceSha256)) throw new Error(`manifest subject has an invalid sha256: ${e.rel}`);
    if (seen.has(e.rel)) throw new Error(`manifest has a duplicate subject: ${e.rel}`);
    seen.add(e.rel);
    return { rel: e.rel, sourceSha256: e.sourceSha256 };
  });
  return { manifestPath, selected };
}

/** Confine a repo-relative subject path inside the root. */
function containedRel(root, rel) {
  const abs = join(root, rel);
  const r = relative(root, abs);
  return r && !r.startsWith('..') && !isAbsolute(r) ? abs : null;
}

/**
 * Plan/apply the codemod over the manifest. Returns the ledger object. PURE of
 * product writes when `apply` is false; with `apply`, writes ONLY subjects whose
 * before-hash matched (re-verified immediately before the write).
 */
export function runCodemod({ root, manifestPath, outLedger, subjects = [], apply = false }) {
  const { selected } = loadManifest(manifestPath);
  const known = new Set(selected.map((s) => s.rel));
  const wanted = new Set(subjects);
  // An UNKNOWN --subject is a usage/selection error, never a silent empty success.
  for (const s of wanted) if (!known.has(s)) throw new Error(`unknown --subject (not in the manifest selection): ${s}`);
  const entries = [];
  for (const subject of selected) {
    if (wanted.size && !wanted.has(subject.rel)) continue;
    const abs = containedRel(root, subject.rel);
    const rec = { rel: subject.rel, status: 'pending', eligible: false, beforeSha256: subject.sourceSha256, afterSha256: null, boundary: null, guardLine: null, edits: [], reasons: [] };
    if (!abs || !existsSync(abs)) {
      rec.reasons.push('subject file not found under root');
      entries.push(rec);
      continue;
    }
    const source = readFileSync(abs, 'utf8');
    const actual = sha256hex(source);
    rec.actualSha256 = actual;
    if (actual !== subject.sourceSha256) {
      rec.reasons.push(`before-hash mismatch: manifest ${subject.sourceSha256} != actual ${actual} (changed placement — refused)`);
      entries.push(rec);
      continue;
    }
    const t = transformConfigGuard(source, subject.rel);
    if (!t.ok) {
      rec.reasons.push(...t.reasons);
      entries.push(rec);
      continue;
    }
    rec.eligible = true;
    rec.afterSha256 = t.afterSha256;
    rec.boundary = t.placement.boundary;
    rec.guardLine = t.placement.guardLine;
    rec.edits = t.placement.edits;
    if (!apply) {
      rec.status = 'planned';
      entries.push(rec);
      continue;
    }
    // Re-verify the before-hash IMMEDIATELY before writing (no TOCTOU drift).
    const recheck = sha256hex(readFileSync(abs, 'utf8'));
    if (recheck !== subject.sourceSha256) {
      rec.reasons.push('before-hash changed between plan and apply — refused write');
      entries.push(rec);
      continue;
    }
    writeFileSync(abs, t.output);
    const written = sha256hex(readFileSync(abs, 'utf8'));
    if (written !== t.afterSha256) {
      rec.reasons.push('post-write hash mismatch — the file did not land as computed');
      entries.push(rec);
      continue;
    }
    rec.status = 'applied';
    entries.push(rec);
  }
  // A request that selects NOTHING (e.g. every requested subject filtered away)
  // is never a silent clean success.
  if (entries.length === 0) throw new Error('no subjects selected for planning (empty ledger refused)');
  const counts = {};
  for (const e of entries) counts[e.status] = (counts[e.status] ?? 0) + 1;
  return {
    schema: LEDGER_SCHEMA,
    generatedAt: new Date().toISOString(),
    root,
    manifest: manifestPath,
    apply,
    subjects: wanted.size ? [...wanted] : 'all-selected',
    entries,
    counts,
  };
}

/**
 * Import safety: the CLI body runs ONLY when THIS exact file is the invoked
 * entrypoint — `process.argv[1]` resolved to an ABSOLUTE path must equal this
 * module's own resolved file path. A same-basename importer/entry (e.g. another
 * `foo-config-guard-codemod.mjs`, or any module that merely IMPORTS this one) is
 * therefore import-safe and never runs the CLI.
 */
const SELF_FILE = (() => {
  try {
    return resolve(fileURLToPath(import.meta.url));
  } catch {
    return null;
  }
})();

function invokedAsEntrypoint() {
  const invoked = process.argv[1];
  if (!invoked || !SELF_FILE) return false;
  try {
    return resolve(invoked) === SELF_FILE;
  } catch {
    return false;
  }
}

if (invokedAsEntrypoint()) {
  const argv = process.argv.slice(2);
  // Bare invocation (no arguments): print Usage and exit with the explicit code 2.
  if (argv.length === 0) {
    process.stderr.write(`${USAGE}\n`);
    process.exit(2);
  }
  // Parse FIRST so an UNKNOWN option is rejected even alongside --help; only a
  // clean parse that names --help prints Usage and exits 0.
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    process.stderr.write(`${USAGE}\nerror: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.help) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  }
  if (existsSync(opts.outLedger)) {
    // No-clobber: never overwrite an existing output ledger.
    process.stderr.write(`refusing to overwrite existing ledger: ${opts.outLedger}\n`);
    process.exit(2);
  }
  let ledger;
  try {
    ledger = runCodemod({ ...opts, manifestPath: opts.manifest });
  } catch (e) {
    process.stderr.write(`${USAGE}\nerror: ${e.message}\n`);
    process.exit(2);
  }
  writeFileSync(opts.outLedger, JSON.stringify(ledger, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ counts: ledger.counts, ledger: opts.outLedger }, null, 2) + '\n');
  // A REFUSED/pending subject is never waived: exit non-zero so the operator
  // notices and reviews the ledger rather than assuming a clean run.
  process.exitCode = ledger.counts.pending ? 1 : 0;
}
