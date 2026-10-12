/**
 * CleanUp1 §6.2 — canonical invocation-context planner.
 *
 * This is a PURE / READ-ONLY planner. It derives, from the CURRENT
 * `discoverEntrypoints` output (and the `declaredContexts` provenance those rows
 * already carry), every APPLICABLE invocation context for every physical smoke
 * subject. It NEVER executes a command, NEVER imports or runs a discovered
 * script, and NEVER replays a declaration flag (`--commit`, …): the smoke modes
 * remain exactly `[]`, `['--help']` and `[<unknown-flag>]`
 * (`SMOKE_MODES`).
 *
 * A physical subject is an `entrypoint`, an `unsafe` subject or an
 * `undiscovered-declared` failure packet — the SAME 602-subject physical scope
 * discovery measures. EVERY physical subject is retained; an `unsafe` subject is
 * never dropped. An UNDECLARED physical subject keeps the HISTORICAL repo-root
 * cwd `'.'` — a guessed owning-package cwd is never invented.
 *
 * For a physical subject declared from several contexts:
 *   - declaration records whose effective `cwdRel` is EQUIVALENT are GROUPED
 *     into ONE canonical context, preserving ALL of the associated declarations
 *     (reference, package, packageDir, script, scriptBody, command, token, role,
 *     runner, cwdSource, resolution, disposition);
 *   - a different effective cwd yields a SEPARATE canonical context — one
 *     physical path declared from two cwds keeps BOTH;
 *   - an UNKNOWN / escaping / dynamic cwd is NEVER guessed and NEVER silently
 *     omitted: it is emitted as an explicit INVALID context carrying the
 *     declarations and the problem, so it fails closed downstream.
 *
 * Each context gets a STABLE key bound to its `rel` + `cwdRel` and a
 * deterministic `fingerprint` over its full provenance — including the OWNING
 * manifest input hashes (`package.json` of each declaration's package). Contexts
 * and their declarations are sorted deterministically, so two independent
 * derivations from the same source are byte-identical.
 *
 * `validateInvocationContext` / `matchInvocationContext` accept a caller-supplied
 * context ONLY when it EXACTLY matches a freshly derived canonical context — a
 * free-form `cwd`/key, a stale fingerprint (a changed manifest or declaration
 * set), a forged key, a wrong subject or a partial reference is REFUSED before
 * any container is created.
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import { discoverEntrypoints } from './discover.mjs';

/** The physical (non-reconciled-failure) subject kinds that carry a smoke obligation. */
export const PHYSICAL_KINDS = Object.freeze(['entrypoint', 'unsafe', 'undiscovered-declared']);

/** The single unknown-flag token the smoke run supplies (mirrors run-smoke.mjs). */
export const SMOKE_UNKNOWN_FLAG = '--cleanup-smoke-unknown-flag';
/** The ONLY mode argv the smoke supplies — no declaration flag is ever replayed. */
export const SMOKE_MODES = Object.freeze([
  Object.freeze([]),
  Object.freeze(['--help']),
  Object.freeze([SMOKE_UNKNOWN_FLAG]),
]);

/** Repo-relative POSIX normalization (drops a leading `./`, backslashes → `/`). */
export function normalizeRel(p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
}

/** POSIX form of a host path (`C:\x` -> `/c/x`), matching isolation.mjs. */
function posixNative(p) {
  let x = String(p).replace(/\\/g, '/');
  const d = /^([A-Za-z]):\//.exec(x);
  if (d) x = `/${d[1].toLowerCase()}/${x.slice(3)}`;
  return x.replace(/\/+$/, '');
}

/**
 * The ABSOLUTE in-container cwd for a repo-relative `cwdRel`:
 *   - a verified subjectDeps `/src` volume → `/src` (or `/src/<cwdRel>`);
 *   - otherwise the contained native-bind equivalent `<native>/<cwdRel>`.
 */
export function nativeCwdFor(cwdRel, { mountedVolume = false, nativeRoot = '' } = {}) {
  const r = cwdRel == null || cwdRel === '' ? '.' : normalizeRel(cwdRel);
  const base = mountedVolume ? '/src' : posixNative(nativeRoot);
  if (r === '.') return base;
  return `${base.replace(/\/+$/, '')}/${r}`;
}

/** True iff a repo-relative cwd is contained (not absolute, no drive, no `..`). */
export function cwdRelContained(cwdRel) {
  const r = normalizeRel(cwdRel);
  if (!r) return false;
  if (r.startsWith('/') || /^[A-Za-z]:/.test(r)) return false;
  return !r.split('/').some((s) => s === '..');
}

/**
 * Validate the selected cwd is an ACTUAL contained regular directory without a
 * symlink escape. `fs` is an injectable seam so pure controls can drive every
 * branch with no disk I/O.
 */
export function validateCwdDirectory(rootDir, cwdRel, fs = {}) {
  const f = { existsSync, lstatSync, realpathSync, ...fs };
  if (cwdRel == null) return { ok: false, reason: 'cwd-unknown' };
  const r = cwdRel === '' ? '.' : normalizeRel(cwdRel);
  if (!cwdRelContained(r)) return { ok: false, reason: 'cwd-escaping' };
  const abs = r === '.' ? rootDir : join(rootDir, ...r.split('/'));
  let rootReal = null;
  try {
    rootReal = f.realpathSync(rootDir);
  } catch {
    rootReal = null;
  }
  if (!f.existsSync(abs)) return { ok: false, reason: 'cwd-missing' };
  let ls;
  try {
    ls = f.lstatSync(abs);
  } catch {
    return { ok: false, reason: 'cwd-unreadable' };
  }
  if (ls.isSymbolicLink()) return { ok: false, reason: 'cwd-symlink' };
  if (!ls.isDirectory()) return { ok: false, reason: 'cwd-not-directory' };
  try {
    const real = f.realpathSync(abs);
    if (rootReal && real !== rootReal && !real.startsWith(rootReal + sep)) {
      return { ok: false, reason: 'cwd-escaping' };
    }
  } catch {
    return { ok: false, reason: 'cwd-unreadable' };
  }
  return { ok: true, reason: null, abs };
}

/** The fixed declaration projection that participates in the fingerprint. */
function pickDecl(d) {
  return {
    reference: d.reference ?? null,
    package: d.package ?? null,
    packageDir: d.packageDir ?? null,
    script: d.script ?? null,
    scriptBody: d.scriptBody ?? null,
    command: d.command ?? null,
    token: d.token ?? null,
    role: d.role ?? null,
    runner: d.runner ?? null,
    cwdRel: d.cwdRel ?? null,
    cwdSource: d.cwdSource ?? null,
    resolution: d.resolution ?? null,
    disposition: d.disposition ?? null,
    manifestRel: d.manifestRel ?? null,
    manifestSha256: d.manifestSha256 ?? null,
  };
}

function cmp(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The owning manifest (`package.json`) repo-relative path + its input sha256. */
function manifestInput(f, rootDir, packageDir) {
  const rel = !packageDir || packageDir === '.' ? 'package.json' : `${normalizeRel(packageDir)}/package.json`;
  const abs = join(rootDir, ...rel.split('/'));
  let sha256 = null;
  try {
    sha256 = createHash('sha256').update(f.readFileSync(abs)).digest('hex');
  } catch {
    sha256 = null;
  }
  return { rel, sha256 };
}

function makeContext({ rootDir, rel, kind, cwdRel, decls, f }) {
  const problems = [];
  let valid = true;
  if (cwdRel == null) {
    valid = false;
    problems.push('cwd-unknown');
  } else {
    const v = validateCwdDirectory(rootDir, cwdRel, f);
    if (!v.ok) {
      valid = false;
      problems.push(v.reason);
    }
  }
  const manCache = new Map();
  const declarations = decls
    .map((d) => {
      const packageDir = d.packageDir === '' || d.packageDir == null ? null : normalizeRel(d.packageDir);
      const cacheKey = packageDir ?? '';
      if (!manCache.has(cacheKey)) manCache.set(cacheKey, manifestInput(f, rootDir, packageDir));
      const man = manCache.get(cacheKey);
      return {
        reference: d.reference ?? null,
        package: d.package ?? null,
        packageDir,
        script: d.script ?? null,
        scriptBody: d.scriptBody ?? null,
        command: d.command ?? null,
        token: d.token ?? null,
        role: d.role ?? null,
        runner: d.runner ?? null,
        cwdRel: cwdRel == null ? null : cwdRel,
        cwdSource: d.cwdSource ?? null,
        resolution: d.resolution ?? null,
        disposition: d.disposition ?? null,
        manifestRel: man.rel,
        manifestSha256: man.sha256,
      };
    })
    .sort((a, b) => cmp(JSON.stringify(pickDecl(a)), JSON.stringify(pickDecl(b))));
  const declarationRefs = [...new Set(declarations.map((d) => d.reference).filter(Boolean))].sort(cmp);
  const manifestInputs = [...new Map([...manCache.values()].map((m) => [m.rel, m])).values()].sort((a, b) => cmp(a.rel, b.rel));
  const subjectAbs = rel ? join(rootDir, ...rel.split('/')) : rel;
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ rel, cwdRel: cwdRel == null ? null : cwdRel, kind, declarations: declarations.map(pickDecl), manifestInputs }))
    .digest('hex');
  const contextKey = `invctx::${rel}::${cwdRel == null ? '?' : cwdRel}`;
  return { contextKey, rel, cwdRel: cwdRel == null ? null : cwdRel, kind, subjectAbs, valid, problems, declarations, declarationRefs, manifestInputs, fingerprint };
}

/**
 * Derive the canonical contexts from an ALREADY-COMPUTED discovery array
 * (pure — no disk discovery beyond the injected fs seam for cwd/manifest
 * validation).
 */
export function deriveCanonicalContexts(entries, rootDir, { fs = null, kinds = PHYSICAL_KINDS } = {}) {
  const f = { existsSync, lstatSync, realpathSync, readFileSync, ...(fs ?? {}) };
  const kindSet = new Set(kinds);
  const contexts = [];
  const subjects = [];
  const list = Array.isArray(entries) ? entries : [];
  for (const e of list) {
    if (!e || !kindSet.has(e.kind)) continue;
    const rel = normalizeRel(e.rel);
    const declsIn = Array.isArray(e.declaredContexts) ? e.declaredContexts : [];
    const groups = new Map(); // cwdKey -> { cwdRel, decls }
    for (const d of declsIn) {
      const rawCwd = d?.cwdRel;
      const cwdRel = rawCwd === '' ? '.' : typeof rawCwd === 'string' ? normalizeRel(rawCwd) : null;
      const gk = cwdRel == null ? '\u0000unknown' : cwdRel;
      if (!groups.has(gk)) groups.set(gk, { cwdRel, decls: [] });
      groups.get(gk).decls.push(d);
    }
    // An UNDECLARED physical subject keeps the HISTORICAL repo-root cwd '.'.
    const declared = groups.size > 0;
    if (!declared) groups.set('.', { cwdRel: '.', decls: [] });
    for (const { cwdRel, decls } of groups.values()) {
      contexts.push(makeContext({ rootDir, rel, kind: e.kind, cwdRel, decls, f }));
    }
    subjects.push({ rel, kind: e.kind, declared, contextKeys: [] });
  }
  contexts.sort((a, b) => cmp(a.rel, b.rel) || cmp(String(a.cwdRel), String(b.cwdRel)) || cmp(a.contextKey, b.contextKey));
  const bySubject = new Map();
  for (const c of contexts) {
    if (!bySubject.has(c.rel)) bySubject.set(c.rel, []);
    bySubject.get(c.rel).push(c.contextKey);
  }
  for (const s of subjects) s.contextKeys = (bySubject.get(s.rel) ?? []).slice().sort(cmp);
  subjects.sort((a, b) => cmp(a.rel, b.rel));
  const invalid = contexts.filter((c) => !c.valid);
  return {
    rootDir,
    contexts,
    subjects,
    counts: {
      physicalSubjects: subjects.length,
      contexts: contexts.length,
      invalidContexts: invalid.length,
      multiCwdPhysical: subjects.filter((s) => s.contextKeys.length > 1).length,
      undeclaredPhysical: subjects.filter((s) => !s.declared).length,
    },
    problems: invalid.map((c) => ({ contextKey: c.contextKey, rel: c.rel, cwdRel: c.cwdRel, problems: c.problems })),
  };
}

/**
 * Derive the canonical plan from the CURRENT discovery of `rootDir`. `opts.discovery`
 * lets a caller reuse an already-computed discovery array.
 */
export function planInvocationContexts(rootDir, opts = {}) {
  const entries = opts.discovery ?? discoverEntrypoints(rootDir);
  return deriveCanonicalContexts(entries, rootDir, opts);
}

/**
 * Match a caller-provided context against a freshly derived plan. The provided
 * context MUST be a COMPLETE canonical record — `rel`, `cwdRel`, `kind`,
 * `contextKey`, `fingerprint`, `declarationRefs`, `declarations` and
 * `manifestInputs` are all REQUIRED. A bare free-form cwd/key, a MISSING key or
 * declaration-ref set, a stale fingerprint, a CHANGED/forged declaration set, a
 * forged key, a wrong subject, a wrong owning-manifest input or ANY supplied
 * caller/manifest contradiction is REFUSED before any container is created — a
 * caller that copies a GENUINE fingerprint but omits or edits the rest is still
 * refused. Returns `{ok, context}` with the FRESH canonical object, or
 * `{ok:false, reason}`.
 */
export function matchInvocationContext(provided, plan) {
  if (!provided || typeof provided !== 'object') return { ok: false, reason: 'context-missing' };
  // A COMPLETE canonical record is required: every provenance field must be present.
  if (typeof provided.rel !== 'string' || !provided.rel) return { ok: false, reason: 'context-partial-reference' };
  if (typeof provided.cwdRel !== 'string') return { ok: false, reason: 'context-partial-reference' };
  if (typeof provided.kind !== 'string' || !provided.kind) return { ok: false, reason: 'context-partial-reference' };
  if (typeof provided.contextKey !== 'string' || !provided.contextKey) return { ok: false, reason: 'context-partial-reference' };
  if (typeof provided.fingerprint !== 'string' || !provided.fingerprint) return { ok: false, reason: 'context-partial-reference' };
  if (!Array.isArray(provided.declarationRefs)) return { ok: false, reason: 'context-partial-reference' };
  if (!Array.isArray(provided.declarations)) return { ok: false, reason: 'context-partial-reference' };
  if (!Array.isArray(provided.manifestInputs)) return { ok: false, reason: 'context-partial-reference' };
  const fresh = plan?.contexts;
  if (!Array.isArray(fresh)) return { ok: false, reason: 'plan-missing' };
  const rel = normalizeRel(provided.rel);
  const cwdRel = provided.cwdRel === '' ? '.' : normalizeRel(provided.cwdRel);
  const cand = fresh.filter((c) => c.rel === rel && c.cwdRel === cwdRel);
  if (cand.length === 0) return { ok: false, reason: 'context-stale-or-unknown' };
  if (cand.length > 1) return { ok: false, reason: 'context-ambiguous' };
  const c = cand[0];
  if (provided.contextKey !== c.contextKey) return { ok: false, reason: 'context-key-forged' };
  if (provided.fingerprint !== c.fingerprint) return { ok: false, reason: 'context-provenance-mismatch' };
  if (provided.kind !== c.kind) return { ok: false, reason: 'context-provenance-mismatch' };
  // The declaration REFERENCE set, the FULL declaration provenance and the owning
  // manifest-input hashes must ALL agree with the fresh canonical record — copying
  // a genuine fingerprint while editing/omitting declarations is a contradiction.
  const aRefs = provided.declarationRefs.map(String).slice().sort(cmp);
  if (JSON.stringify(aRefs) !== JSON.stringify(c.declarationRefs)) return { ok: false, reason: 'context-declarations-mismatch' };
  if (JSON.stringify(provided.declarations.map(pickDecl)) !== JSON.stringify(c.declarations.map(pickDecl))) {
    return { ok: false, reason: 'context-declarations-mismatch' };
  }
  const aInputs = provided.manifestInputs
    .map((m) => ({ rel: m?.rel ?? null, sha256: m?.sha256 ?? null }))
    .sort((x, y) => cmp(String(x.rel), String(y.rel)));
  const cInputs = c.manifestInputs.map((m) => ({ rel: m.rel, sha256: m.sha256 }));
  if (JSON.stringify(aInputs) !== JSON.stringify(cInputs)) return { ok: false, reason: 'context-provenance-mismatch' };
  // A SUPPLIED subject/provenance field with a contradiction is refused, never ignored.
  if (provided.subjectAbs !== undefined && provided.subjectAbs !== c.subjectAbs) {
    return { ok: false, reason: 'context-provenance-mismatch' };
  }
  if (provided.valid !== undefined && provided.valid !== c.valid) {
    return { ok: false, reason: 'context-provenance-mismatch' };
  }
  if (!c.valid) return { ok: false, reason: 'context-invalid', detail: c.problems.join(',') };
  return { ok: true, context: c };
}

/**
 * Re-derive a FRESH canonical plan for `rootDir` and require the provided context
 * to match it EXACTLY. Every failure (stale manifest/declaration set, forged key,
 * wrong subject, partial reference, unknown/escaping cwd) refuses.
 */
export function validateInvocationContext(provided, rootDir, opts = {}) {
  let plan;
  try {
    plan = planInvocationContexts(rootDir, opts);
  } catch (e) {
    return { ok: false, reason: 'plan-derivation-failed', detail: String(e?.message ?? e) };
  }
  return matchInvocationContext(provided, plan);
}
