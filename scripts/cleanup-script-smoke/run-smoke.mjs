/**
 * CleanUp1 §6.2 — script smoke runner (genuinely isolated + genuinely audited).
 *
 * For every discovered entry point (§6.2 harness) this:
 *   1. stages ONLY tracked source — `git archive HEAD` bytes materialised through
 *      the reviewed validated-archive materialiser (no host `tar`), into a fresh
 *      empty disposable dir, and provisions the explicit safe runtime deps it
 *      needs;
 *   2. runs the entry point inside a container with a hard boundary
 *      (--network none, --read-only, no inherited host env, /tmp tmpfs,
 *      disposable /evidence) — mounting nothing else from the host;
 *   3. invokes it with NO arguments AND `--help` (and an unknown flag) UNDER THE
 *      REAL `strace -f` ATTEMPT AUDIT (attempt-audit.mjs) — the audit is wired
 *      into the ACTUAL invocations, not only the proof boundary, so every run
 *      records attempted-but-denied network/write syscalls even when the script
 *      catches the error;
 *   4. classifies the result FAIL-CLOSED by combining audit completeness
 *      (trace present, definite integer exit, no timeout/setup error, entry
 *      point actually exec'd) with the PER-ENTRYPOINT DOCUMENTED CLI contract
 *      derived from that entrypoint's own source (contract.mjs) — never a
 *      universal exit; persists the raw trace/log per invocation with its sha256.
 *
 * A limited run (`--limit`) is explicitly PARTIAL and can never be recorded as
 * whole-scope acceptance. An EMPTY scope fails closed.
 *
 * Usage:
 *   node scripts/cleanup-script-smoke/run-smoke.mjs --root <repo>
 *        [--subject apps/api/scripts|root/scripts] [--limit N] [--timeout-ms N]
 *        [--out report.json] [--raw-log-dir <dir>] [--self-test]
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { discoverEntrypoints } from './discover.mjs';
import { deriveContract, MISSING_DATABASE_URL_SMOKE_CONTEXT } from './contract.mjs';
import {
  dockerAvailable,
  imagePresent,
  runIsolated,
  sourceIdentity,
  selectSourceAppTsConfig,
  TS_SCRIPT_RE,
  ISOLATION_IMAGE,
} from './isolation.mjs';
import {
  AUDIT_IMAGE,
  classifyAttemptAudit,
  ensureAuditImage,
  runWithAttemptAudit,
} from './attempt-audit.mjs';
import { parseNativeTsxVersion, provisionTsRuntime, TSX_VERSION } from './ts-runtime.mjs';
import { materializeValidatedArchive } from './tar-materialize.mjs';
import { planInvocationContexts, nativeCwdFor, normalizeRel } from './invocation-context.mjs';

const UNHANDLED =
  /UnhandledPromiseRejection|unhandledRejection|ERR_UNHANDLED_REJECTION|Unhandled 'error' event/i;
const USAGE =
  /(?:^|\n)\s*(?:usage|options|commands)\s*[:.\-]|(?:^|\n)\s*usage\b|-h,\s*--help|--help\s+for\b/i;

// Per-entrypoint DOCUMENTED contract (see contract.mjs) replaces the previous
// universal "no-args exit 2 / --help exit 0" policy, which root smoke review
// round 2 rejected: the contract must be derived from each entrypoint's source.
const UNKNOWN_FLAG = '--cleanup-smoke-unknown-flag';

/** MSYS tools (e.g. `cp`) misread `C:\...` as a remote host; use the /c/... form. */
function msysPath(p) {
  const x = String(p).replace(/\\/g, '/');
  const d = /^([A-Za-z]):\//.exec(x);
  return d ? `/${d[1].toLowerCase()}/${x.slice(3)}` : x;
}

/** The committed tsx loader path relative to the `/src`-mounted workspace topology
 *  (identical to isolation.mjs's TSX_CLI_REL and the driver's CLI633_TSX_LOADER_REL). */
export const SMOKE_TSX_LOADER_REL = 'apps/api/node_modules/tsx/dist/cli.mjs';

/** POSIX form of a host path (`C:\x` -> `/c/x`), matching isolation.mjs's `posix`. */
function posixPath(p) {
  let x = String(p).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):\//.exec(x);
  if (drive) x = `/${drive[1].toLowerCase()}/${x.slice(3)}`;
  return x.replace(/\/+$/, '');
}
function joinPosix(...parts) {
  return parts
    .map((p, i) => (i === 0 ? posixPath(p) : String(p).replace(/\\/g, '/').replace(/^\/+/, '')))
    .join('/');
}

/**
 * Independently re-derive the EXPECTED runtime plan for a subject from CURRENT source,
 * using the ONE canonical `selectSourceAppTsConfig` and the SAME controlled loader /
 * config-path topology `runIsolated` binds:
 *   - a subject-deps (frozen `/src` volume) context -> loader `apps/api/.../cli.mjs`
 *     (relative, resolved under the read-only /src volume), config `/src/<configRel>`;
 *   - a native bind + provisioned /tsruntime context -> loader `/tsruntime/<cliRel>`,
 *     config `<native>/<configRel>`;
 *   - no TS plan -> null config + null loader (strict null/null).
 * Returns {ok:false} when the committed config is absent/invalid/escaping (fail closed).
 *
 * Round 35: a CONTEXT-BOUND obligation (`opts.contextBound`) binds the ABSOLUTE
 * read-only `/src/<loader>` volume loader — byte-identical to what the context-bound
 * `isolation.mjs` run actually mounts (`/src/${TSX_CLI_REL}`) — so the independently
 * derived expected plan matches the real executed command. Omitted-context LEGACY
 * helper callers keep the historical RELATIVE frozen loader unchanged.
 */
export function expectedRuntimePlanFor(repoRoot, rel, tsRuntime, subjectDeps, opts = {}) {
  const contextBound = opts.contextBound === true;
  const sel = selectSourceAppTsConfig(repoRoot, rel);
  if (!sel.ok)
    return {
      ok: false,
      applicable: true,
      reason: sel.reason,
      config: null,
      loader: null,
      configRel: null,
      context: 'none',
    };
  if (!sel.applicable)
    return {
      ok: true,
      applicable: false,
      config: null,
      loader: null,
      configRel: null,
      context: 'none',
    };
  const native = posixPath(repoRoot);
  if (subjectDeps && subjectDeps.volume) {
    const loader = contextBound ? `/src/${SMOKE_TSX_LOADER_REL}` : SMOKE_TSX_LOADER_REL;
    return {
      ok: true,
      applicable: true,
      config: `/src/${sel.configRel}`,
      loader,
      configRel: sel.configRel,
      context: 'frozen-volume',
    };
  }
  if (tsRuntime && tsRuntime.cliRel) {
    return {
      ok: true,
      applicable: true,
      config: joinPosix(native, sel.configRel),
      loader: `/tsruntime/${tsRuntime.cliRel}`,
      configRel: sel.configRel,
      context: 'native-bind',
    };
  }
  return {
    ok: true,
    applicable: true,
    config: joinPosix(native, sel.configRel),
    loader: joinPosix(native, SMOKE_TSX_LOADER_REL),
    configRel: sel.configRel,
    context: 'native-bind',
  };
}

/**
 * Explicit, safe runtime deps copied into the owned stage so real TS cases are
 * setup-compatible. Only these named tool packages are ever copied — never a
 * host tree, never ignored .env/credentials. A missing dep is a SETUP failure,
 * recorded honestly, not a passing case and not a reason for a source waiver.
 */
export const STAGE_TOOL_DEPS = ['tsx'];

/**
 * A Windows install tree cannot supply the Linux-native esbuild binary the
 * isolated container needs, so a win32-only `tsx` is NOT Linux-native esbuild
 * evidence. Detect whether the workspace actually carries a linux-x64 esbuild.
 */
export function hasLinuxNativeEsbuild(repoRoot) {
  const marker = join('@esbuild', 'linux-x64');
  const direct = [
    join(repoRoot, 'node_modules', marker),
    join(repoRoot, 'apps', 'api', 'node_modules', marker),
  ];
  for (const c of direct) {
    try {
      if (statSync(c).isDirectory()) return true;
    } catch {
      /* absent */
    }
  }
  try {
    for (const name of readdirSync(join(repoRoot, 'node_modules', '.pnpm'))) {
      if (/^@esbuild\+linux-x64@/.test(name)) return true;
    }
  } catch {
    /* no pnpm store */
  }
  return false;
}

/**
 * Stage ONLY tracked source (no ignored .env/credentials, no build output) into
 * a FRESH EMPTY owned dir; the caller then provisions the explicit runtime tool
 * deps the smoke needs.
 *
 * The archive bytes come STRAIGHT from `git archive --format=tar HEAD` — Git's
 * own tree serialization, read from stdout as bytes. There is NO host `tar -x`
 * and NO MSYS `C:\...`→`/c/...` drive translation (root round 30 reproduced the
 * old staging command failing exactly there: native Windows tar could not open
 * the translated archive path). The bytes are consumed ONLY through the reviewed
 * `materializeValidatedArchive` (./tar-materialize.mjs), which validates the
 * archive with the canonical parser BEFORE writing a single payload byte and
 * refuses unsafe/uncontained/overlapping paths.
 *
 * Fail-closed contract:
 *   - the Git production must SUCCEED, INCLUDING transport status — a spawn
 *     error (git absent/killed/ENOBUFS) is not a produced archive; a valid but
 *     empty tree stages zero files and is allowed;
 *   - the destination must be FRESH/EMPTY (an explicit check here plus the
 *     materialiser's own emptiness guard) — nothing is overlaid;
 *   - any refusal by the materialiser (unsafe entry, truncated archive, colons,
 *     device names, …) throws so the caller records a `stage-failed` result and
 *     the destination is left UNTOUCHED.
 *
 * Only committed, tracked entries are ever written, so ignored files,
 * dependencies and credentials are never staged. No file tree is recursively
 * deleted here — the owned stage is retained as evidence.
 *
 * @returns {string} the owned stage dir (public return value preserved).
 */
export function stageTrackedSource(repoRoot, stageDir) {
  const g = spawnSync(
    'git',
    ['-c', 'core.autocrlf=false', '-C', repoRoot, 'archive', '--format=tar', 'HEAD'],
    {
      maxBuffer: 1024 * 1024 * 1024,
      windowsHide: true,
    },
  );
  // Require a real, successful Git production INCLUDING transport status.
  if (g.error) throw new Error(`git archive failed to run: ${g.error.message}`);
  if (g.status !== 0)
    throw new Error(`git archive failed (exit ${g.status}): ${`${g.stderr ?? ''}`.trim()}`);
  const bytes = g.stdout;
  if (!Buffer.isBuffer(bytes)) throw new Error('git archive produced no archive bytes');

  // A FRESH EMPTY owned destination is required — never overlay an existing tree.
  if (existsSync(stageDir) && readdirSync(stageDir).length !== 0) {
    throw new Error(`staging destination must be empty (refusing to reuse): ${stageDir}`);
  }
  mkdirSync(stageDir, { recursive: true });

  // Validate-then-write, through the ONE reviewed materialiser. A refusal is a
  // clear failure and leaves the destination untouched.
  const res = materializeValidatedArchive(bytes, stageDir);
  if (!res.ok) {
    throw new Error(
      `tracked-source staging refused: ${(res.errors ?? []).join('; ') || 'invalid archive'}`,
    );
  }
  return stageDir;
}

/**
 * Copy the explicit runtime tool deps into the owned stage (Linux-compatible
 * package trees only). Returns { provisioned, missing } — `missing` is a setup
 * signal the caller records, never a silent pass.
 */
export function provisionStageDeps(repoRoot, stageDir) {
  const provisioned = [];
  const missing = [];
  for (const dep of STAGE_TOOL_DEPS) {
    const candidates = [
      join(repoRoot, 'apps', 'api', 'node_modules', dep),
      join(repoRoot, 'node_modules', dep),
    ];
    const src = candidates.find((c) => {
      try {
        return statSync(c).isDirectory();
      } catch {
        return false;
      }
    });
    if (!src) {
      missing.push(dep);
      continue;
    }
    // A named dep whose native helper has no Linux build cannot run in the
    // container. Record it as a SETUP gap — never copy a Windows tree as if it
    // were Linux-native evidence, and never fall back to the whole .pnpm store.
    if (dep === 'tsx' && !hasLinuxNativeEsbuild(repoRoot)) {
      missing.push(`${dep} (no linux-x64 esbuild in the workspace — win32-only install)`);
      continue;
    }
    let version = 'unknown';
    try {
      version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version ?? version;
    } catch {
      /* keep unknown */
    }
    const dest = join(stageDir, 'apps', 'api', 'node_modules', dep);
    mkdirSync(dirname(dest), { recursive: true });
    const cp = spawnSync('cp', ['-r', msysPath(src), msysPath(dest)], { windowsHide: true });
    if (cp.status === 0) provisioned.push(`${dep}@${version}`);
    else missing.push(`${dep}@${version}`);
  }
  return { provisioned, missing };
}

const has = (r, re) => re.test(`${r?.out ?? ''}\n${r?.err ?? ''}`);
const outErr = (r) => `${r?.out ?? ''}${r?.err ?? ''}`.trim();

/**
 * Map three audited invocations (no-args / --help / unknown) to a fail-closed
 * status. Combines audit completeness with the documented native CLI contract.
 * Exported so the adversarial self-test drives the SAME logic the runner uses.
 */
export function classifyRun(entry, noArgs, help, unknown, contract) {
  // A static 'unsafe' label (an unreachable destructive pattern in the source)
  // is a RETAINED discovery warning with UNSAFE-ENTRYPOINT provenance. It is NEVER
  // a substitute for execution, proof or acceptance: a static-flagged subject is
  // executed inside the bounded container (network-none / read-only / strace
  // audited) and is held to EXACTLY the same complete runtime acceptance criteria
  // as an ordinary entrypoint. When every actual criterion holds, the flagged
  // subject qualifies (`ok`) with its warning/provenance carried alongside —
  // a destructive operation that is genuinely unreachable in the tested modes is
  // not, by itself, a failure.
  if (entry.kind === 'undiscovered-declared') {
    return {
      status: 'declaration-discovery-mismatch',
      reasons: [entry.reason],
      packets: ['UNDISCOVERED-DECLARED-COMMAND'],
    };
  }

  const unsafe = entry.kind === 'unsafe';
  const failed = (status, reason) => ({
    status,
    reasons: [reason],
    ...(unsafe ? { packets: ['UNSAFE-ENTRYPOINT'] } : {}),
  });
  const invs = [
    ['no-args', noArgs],
    ['--help', help],
    ['unknown-flag', unknown],
  ];

  // 1. Audit completeness + bounded termination (fail closed on ANY gap).
  for (const [name, r] of invs) {
    if (!r) return failed('missing-invocation', `${name} invocation was not recorded`);
    if (r.auditOk !== true)
      return failed(
        'attempt-audit-unavailable',
        `${name}: no syscall audit (${r.auditReason ?? 'missing'})`,
      );
    if (r.containerResidual)
      return failed('container-residual', `${name} left an owned container alive`);
    if (r.setupError) return failed('setup-incompatibility', `${name}: tool/module unavailable`);
    if (r.spawnError && !r.timedOut) return failed('spawn-error', `${name}: ${r.spawnError}`);
    if (r.timedOut) return failed('timeout', `${name} exceeded timeout (hang / open handle)`);
    if (r.signal) return failed('signalled', `${name} terminated by signal ${r.signal}`);
    // The entry point must have ACTUALLY executed — a loader-only trace, or an
    // absent exec record, is never a completed invocation.
    if (r.entrypointExecuted !== true)
      return failed(
        'entrypoint-not-executed',
        `${name}: the entry point did not execute (no proven exec/loader record)`,
      );
  }

  // 2. Attempted access observed by the REAL audit on ANY invocation.
  for (const [name, r] of invs) {
    if (r.attempts?.network?.length)
      return failed(
        'attempt-audit-network',
        `${name} attempted network access (audited, denied) — NOT a pass`,
      );
    if (r.attempts?.write?.length)
      return failed(
        'attempt-audit-write',
        `${name} attempted a forbidden write (audited, denied) — NOT a pass`,
      );
  }

  // 3. Definite integer termination (a signal/null exit is not a completed run).
  for (const [name, r] of invs) {
    if (!Number.isInteger(r.exit))
      return failed(
        'no-definite-exit',
        `${name} produced no definite integer exit (signal=${JSON.stringify(r.signal)})`,
      );
    if (has(r, UNHANDLED))
      return failed('unhandled-rejection', `${name}: unhandled rejection/exception`);
  }

  // 4. DOCUMENTED no-args contract, derived from THIS entrypoint's source —
  //    never a universal exit. A script with no documented usage branch is a
  //    genuine missing-usage failure; it is never given an invented exit.
  if (!contract || !contract.noArgs)
    return failed('noargs-contract', 'documented contract unavailable (fail closed)');
  const docNoArgsExit = contract.noArgs.exit ?? null;
  if (contract.noArgs.documented !== true)
    return failed(
      'noargs-undocumented',
      `no documented no-args usage branch in current source (${contract.evidence ?? 'no evidence'})`,
    );
  if (!has(noArgs, USAGE))
    return failed('noargs-contract', `no-args must print usage (exit=${noArgs.exit})`);
  if (docNoArgsExit !== null && noArgs.exit !== docNoArgsExit)
    return failed('noargs-contract', `no-args exit ${noArgs.exit} != documented ${docNoArgsExit}`);
  // An unknown source exit is NOT a licence to accept an arbitrary integer.
  if (docNoArgsExit === null)
    return failed(
      'noargs-unresolved-exit',
      'documented no-args usage branch does not name an explicit process.exit(N) — refusing to accept an arbitrary integer exit',
    );

  // 5. --help contract: asserted ONLY when the source has a reachable --help
  //    handler with a documented exit. An entrypoint without one is not forced
  //    into a conventional exit 0.
  if (contract.help && contract.help.supported === true) {
    const docHelpExit = contract.help.exit ?? null;
    if (!has(help, USAGE))
      return failed('help-contract', `--help must print usage (exit=${help.exit})`);
    if (docHelpExit !== null && help.exit !== docHelpExit)
      return failed('help-contract', `--help exit ${help.exit} != documented ${docHelpExit}`);
  }

  // 6. An unknown option must be rejected (usage/fail-fast), never silently accepted.
  if (unknown.exit === 0 && !has(unknown, USAGE))
    return failed('unknown-option-accepted', 'unknown flag accepted without usage/failure');

  // A static-flagged subject that reached here satisfied EVERY actual runtime
  // criterion. It qualifies (`ok`) UNDER THE SAME criteria as an ordinary
  // entrypoint; the retained static warning / destructive findings and their
  // UNSAFE-ENTRYPOINT provenance travel alongside the accepted result, so the
  // discovery finding is never lost merely because the runtime proof is clean.
  if (entry.kind === 'unsafe') {
    return {
      status: 'ok',
      reasons: [],
      packets: ['UNSAFE-ENTRYPOINT'],
      warnings: ['static-unsafe-entrypoint'],
      staticRisk: { kind: 'unsafe', destructive: [...(entry.destructive ?? [])] },
      contract: contract ?? null,
    };
  }
  return { status: 'ok', reasons: [], contract: contract ?? null };
}

/** sha256 of a string (for raw-log identity). */
export function sha256hex(text) {
  return createHash('sha256').update(text).digest('hex');
}

function slugify(rel) {
  return rel.replace(/[^A-Za-z0-9._-]+/g, '__');
}

/**
 * Build the committed raw log for one entrypoint: the audit summary plus the
 * exact captured stdout/stderr of the three invocations. Deterministic so its
 * sha256 is reproducible.
 */
export function rawLogFor(rel, noArgs, help, unknown) {
  // Crash-safe: a missing / not-recorded invocation (an invalid-context or
  // unexecuted obligation) is rendered as an explicit `(not recorded)` block —
  // never a thrown TypeError, so a failed obligation still yields a safe log.
  const block = (name, r) =>
    [
      `### ${name} (args=${JSON.stringify(r?.args ?? [])}) exit=${JSON.stringify(r?.exit ?? null)} signal=${JSON.stringify(r?.signal ?? null)} timedOut=${r?.timedOut === true}`,
      `--- stdout ---`,
      `${r?.out ?? ''}`.trimEnd(),
      `--- stderr ---`,
      `${r?.err ?? ''}`.trimEnd(),
      `--- audit network=${r?.attempts?.network?.length ?? 0} forbiddenWrites=${r?.attempts?.write?.length ?? 0} permittedWrites=${r?.attempts?.permittedWrites?.length ?? 0} ---`,
    ].join('\n');
  return [
    `# smoke raw log: ${rel}`,
    `# container=${noArgs?.containerName ?? 'none'} auditOk=${noArgs?.auditOk === true} entrypointExecuted=${noArgs?.entrypointExecuted === true}`,
    block('no-args', noArgs),
    block('--help', help),
    block('unknown-flag', unknown),
    '',
  ].join('\n');
}

/** The canonical per-physical-subject contexts derived from the CANONICAL context
 *  plan for `root` (the ONE `planInvocationContexts` derivation). One physical
 *  subject keeps EVERY distinct-cwd context (a path declared from two cwds keeps
 *  both); an invalid context is an EXPLICIT failed obligation, never omitted. */
export function smokeSubjectContexts(root, discovery) {
  return planInvocationContexts(root, { discovery });
}

/** The canonical contexts for one physical subject rel (sorted, deterministic). */
function contextsFor(plan, rel) {
  const r = normalizeRel(rel);
  return (plan?.contexts ?? []).filter((c) => normalizeRel(c.rel) === r);
}

/** Statuses that are a NON-failing outcome for a single context. A static-flagged
 *  subject that meets every actual runtime criterion is `ok` (like an ordinary
 *  entrypoint); the sole accepted pass status is therefore `ok`. */
const PASS_STATUSES = new Set(['ok']);

/** The per-mode invocation record threaded to the emitter (carries the exact
 *  context/cwd/native-subject + lifecycle receipt paths the emitter persists). */
function evidenceInvRecord(r, ctx, planContext, traceName) {
  return {
    argv: r.nativeArgv ?? ['node', ctx.rel, ...(r.args ?? [])],
    exit: r.exit ?? null,
    signal: r.signal ?? null,
    spawnError: r.spawnError ?? null,
    timedOut: r.timedOut === true,
    usagePrinted: has(r, USAGE),
    entrypointExecuted: r.entrypointExecuted === true,
    traceName,
    tracePath: r.tracePath ?? null,
    args: r.args ?? [],
    out: r.out ?? '',
    err: r.err ?? '',
    runtimeConfig: r.runtimeConfig ?? null,
    runtimeConfigRel: r.runtimeConfigRel ?? null,
    tsxLoader: r.tsxLoader ?? null,
    runtimeContext: planContext ?? null,
    contextKey: ctx.contextKey,
    cwdRel: ctx.cwdRel,
    nativeCwd: r.nativeCwd ?? null,
    nativeSubject: r.nativeSubject ?? null,
    containerName: r.containerName ?? null,
    containerTerminated: r.containerTerminated === true,
    containerId: r.containerId ?? null,
    prestartReceiptPath: r.prestartReceiptPath ?? null,
    finalReceiptPath: r.finalReceiptPath ?? null,
    workingDirInspect: r.workingDirInspect ?? null,
    auditOk: r.auditOk === true,
    auditReason: r.auditReason ?? null,
    attempts: r.attempts ?? { network: [], write: [], permittedWrites: [] },
    source: r.source ?? null,
    sandbox: r.sandbox ?? null,
    elapsedMs: r.elapsedMs ?? null,
  };
}

/**
 * Execute ONE canonical context obligation: the three EXACT smoke modes
 * (no-args / --help / unknown) on the DECLARED cwd, each supplying an explicit
 * validated `invocationContext` and the independently derived `expectedNativeCwd`
 * to the real audit. A context that cannot be validated, or whose any mode fails,
 * is a FAILED obligation — it is retained explicitly, never dropped. No
 * declaration `--commit`/operational flag is ever replayed.
 */
export function smokeOneContext(
  root,
  entry,
  ctx,
  timeoutMs,
  auditImage,
  ev,
  tsRuntime,
  subjectDeps,
  ctxIndex = 0,
  _inject = null,
) {
  const usingVolume = !!(subjectDeps && subjectDeps.volume);
  const base = {
    contextKey: ctx.contextKey,
    rel: ctx.rel,
    cwdRel: ctx.cwdRel,
    kind: ctx.kind,
    declarationRefs: ctx.declarationRefs,
    declarations: ctx.declarations,
    manifestInputs: ctx.manifestInputs,
    fingerprint: ctx.fingerprint,
  };
  if (!ctx.valid) {
    return {
      ...base,
      status: 'context-invalid',
      reasons: [`invocation context invalid (${(ctx.problems ?? []).join(',') || 'unknown-cwd'})`],
      invalidContext: true,
      invocations: {},
    };
  }
  const expectedNativeCwd = nativeCwdFor(ctx.cwdRel, {
    mountedVolume: usingVolume,
    nativeRoot: root,
  });
  const plan = expectedRuntimePlanFor(root, entry.rel, tsRuntime, subjectDeps, {
    contextBound: true,
  });
  const expect = plan.ok
    ? { expectedRuntimeConfig: plan.config, expectedTsxLoader: plan.loader }
    : {};
  // A DISTINCT, context- and mode-bound trace location per invocation: the shared
  // evidence dir is never reused with a colliding name, so a second context/mode
  // can NEVER overwrite the first context's raw trace before the emitter reads it.
  const traceName = (mode) => `ctx${ctxIndex}.${mode}.trace`;
  const inv = (args, name) => ({
    ...runWithAttemptAudit({
      repoRoot: root,
      rel: entry.rel,
      args,
      timeoutMs,
      evidenceDir: ev,
      traceName: name,
      image: auditImage,
      tsRuntime,
      subjectDeps,
      ...expect,
      invocationContext: ctx,
      expectedNativeCwd,
      _inject,
    }),
    args,
  });
  const noArgs = inv([], traceName('noargs'));
  const help = inv(['--help'], traceName('help'));
  const unknown = inv([UNKNOWN_FLAG], traceName('unknown'));
  let source = '';
  try {
    source = readFileSync(join(root, entry.rel), 'utf8');
  } catch {
    source = '';
  }
  // Every isolated invocation runs with DATABASE_URL absent, so the contract is
  // derived under the ONE named smoke context — the SAME context the CI consumer
  // (`scripts/cleanup-gates/lib/script-contract.mjs`) uses, so producer and
  // verifier derive byte-identical contracts.
  const contract = deriveContract(source, entry.rel, MISSING_DATABASE_URL_SMOKE_CONTEXT);
  const cls = classifyRun(entry, noArgs, help, unknown, contract);
  return {
    ...base,
    status: cls.status,
    reasons: cls.reasons ?? [],
    ...(cls.packets ? { packets: cls.packets } : {}),
    ...(cls.warnings ? { warnings: cls.warnings } : {}),
    ...(cls.staticRisk ? { staticRisk: cls.staticRisk } : {}),
    contract,
    invocations: {
      noArgs: evidenceInvRecord(noArgs, ctx, plan.context, traceName('noargs')),
      help: evidenceInvRecord(help, ctx, plan.context, traceName('help')),
      unknown: evidenceInvRecord(unknown, ctx, plan.context, traceName('unknown')),
    },
  };
}

/** Aggregate per-context results into the ONE canonical physical result identity:
 *  'ok' ONLY when EVERY context passed; a single failing context fails the WHOLE
 *  subject and its status/reasons are the aggregate (failure aggregation — no
 *  omitted obligation). A static-flagged subject that passes EVERY context is
 *  `ok` under the SAME runtime criteria as an ordinary entrypoint, with its
 *  retained warning / destructive findings / UNSAFE-ENTRYPOINT provenance carried
 *  on the accepted result (never dropped, never a substitute for the runtime
 *  proof). Exported so the adversarial controls drive the SAME aggregation the
 *  runner uses. */
export function aggregateContexts(entry, contextResults) {
  const failed = contextResults.find((c) => !PASS_STATUSES.has(c.status));
  if (failed) {
    const packets = failed.packets;
    return {
      status: failed.status,
      reasons: failed.reasons ?? [],
      ...(packets ? { packets } : {}),
    };
  }
  if (entry.kind === 'unsafe') {
    return {
      status: 'ok',
      reasons: [],
      packets: ['UNSAFE-ENTRYPOINT'],
      warnings: ['static-unsafe-entrypoint'],
      staticRisk: { kind: 'unsafe', destructive: [...(entry.destructive ?? [])] },
    };
  }
  return { status: 'ok', reasons: [] };
}

function smokeOne(
  root,
  entry,
  plan,
  timeoutMs,
  auditImage,
  rawLogDir,
  repoRelBase,
  tsRuntime = null,
  subjectDeps = null,
) {
  const ctxs = contextsFor(plan, entry.rel);
  // A declaration/unsafe/discovery failure packet that cannot be executed (a
  // missing/out-of-root declared CLI) stays a NON-executed failure packet, but
  // every canonical context (and therefore every declaration reference) is
  // retained as an explicit failed obligation.
  if (entry.kind === 'undiscovered-declared' || ctxs.length === 0) {
    const base = classifyRun(entry);
    return {
      ...base,
      rel: entry.rel,
      subject: entry.subject,
      source: sourceIdentity(root, entry.rel),
      contextResults: ctxs.map((c) => ({
        contextKey: c.contextKey,
        rel: c.rel,
        cwdRel: c.cwdRel,
        kind: c.kind,
        declarationRefs: c.declarationRefs,
        declarations: c.declarations,
        manifestInputs: c.manifestInputs,
        fingerprint: c.fingerprint,
        status: base.status,
        reasons: base.reasons,
        invocations: {},
      })),
    };
  }
  const ev = mkdtempSync(join(tmpdir(), 'cleanup-smoke-audit-'));
  const contextResults = ctxs.map((c, i) =>
    smokeOneContext(root, entry, c, timeoutMs, auditImage, ev, tsRuntime, subjectDeps, i),
  );
  const agg = aggregateContexts(entry, contextResults);
  // The PRIMARY context (the deterministic first canonical context) anchors the
  // legacy per-result summary fields; the full context set lives in contextResults.
  const primary =
    contextResults.find((c) => c.invocations && c.invocations.noArgs) ?? contextResults[0];
  const pn = primary?.invocations?.noArgs;
  const ph = primary?.invocations?.help;
  const pu = primary?.invocations?.unknown;
  const attempts = (m) => m?.attempts ?? { network: [], write: [], permittedWrites: [] };
  const audit = {
    attemptedNetwork: [...attempts(pn).network, ...attempts(ph).network, ...attempts(pu).network],
    attemptedWrites: [...attempts(pn).write, ...attempts(ph).write, ...attempts(pu).write],
    attemptedOther: [],
    permittedWrites: [
      ...attempts(pn).permittedWrites,
      ...attempts(ph).permittedWrites,
      ...attempts(pu).permittedWrites,
    ],
  };
  const result = {
    ...agg,
    rel: entry.rel,
    subject: entry.subject,
    source: pn?.source ?? sourceIdentity(root, entry.rel),
    sandbox: pn?.sandbox ?? null,
    container: { name: pn?.containerName ?? null, terminated: pn?.containerTerminated ?? null },
    audit,
    noArgs: {
      exit: pn?.exit ?? null,
      timedOut: pn?.timedOut === true,
      elapsedMs: pn?.elapsedMs ?? null,
      usagePrinted: pn?.usagePrinted === true,
    },
    help: {
      exit: ph?.exit ?? null,
      timedOut: ph?.timedOut === true,
      elapsedMs: ph?.elapsedMs ?? null,
      usagePrinted: ph?.usagePrinted === true,
    },
    unknown: {
      exit: pu?.exit ?? null,
      timedOut: pu?.timedOut === true,
      usagePrinted: pu?.usagePrinted === true,
    },
    contract: primary?.contract ?? null,
    invocations: { noArgs: pn, help: ph, unknown: pu },
    contextResults,
    // Aggregate audit completeness: EVERY canonical context AND every one of its
    // three smoke modes must carry a real syscall audit. A passing no-args (or a
    // single passing context) can NEVER mask another mode/context failure.
    auditComplete:
      contextResults.length > 0 &&
      contextResults.every((c) =>
        ['noArgs', 'help', 'unknown'].every((m) => c.invocations?.[m]?.auditOk === true),
      ),
  };

  if (rawLogDir) {
    const rel = `logs/${slugify(entry.rel)}.log`;
    const abs = join(rawLogDir, rel);
    const text = rawLogFor(entry.rel, pn, ph, pu);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, text);
    result.rawLogPath = repoRelBase ? `${repoRelBase.replace(/\/+$/, '')}/${rel}` : rel;
    result.rawLogSha256 = sha256hex(text);
  }
  // Retain the uniquely owned evidence dir (raw syscall traces, stdout/stderr and
  // per-invocation records). No recursive deletion — the artifacts are the proof.
  result.evidenceDir = ev;
  return result;
}

// The native fullgate has already run pnpm install --frozen-lockfile in its owned
// Linux work volume. Select this path only on explicit native-carrier request;
// every other venue retains the separately provisioned TS runtime.
export function probeLockedNativeTsx(
  root,
  {
    ownedRoot = process.env.CLEANUP_SMOKE_NATIVE_LOCKED_TSX ?? null,
    platform = process.platform,
    run = spawnSync,
  } = {},
) {
  if (!ownedRoot) return { selected: false, ok: false, reason: 'not-selected' };
  if (platform !== 'linux') return { selected: true, ok: false, reason: 'linux-required' };
  const cli = join(root, SMOKE_TSX_LOADER_REL);
  try {
    if (realpathSync(root) !== ownedRoot)
      return { selected: true, ok: false, reason: 'owned-root-mismatch' };
    const packageFile = join(root, 'apps/api/node_modules/tsx/package.json');
    for (const [kind, file] of [
      ['loader', cli],
      ['package', packageFile],
    ]) {
      const rel = relative(root, realpathSync(file));
      if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || rel.startsWith(sep)) {
        return { selected: true, ok: false, reason: `${kind}-outside-source` };
      }
    }
    const declared = JSON.parse(readFileSync(join(root, 'apps/api/package.json'), 'utf8'));
    if (
      declared.devDependencies?.tsx !== `^${TSX_VERSION}` &&
      declared.dependencies?.tsx !== `^${TSX_VERSION}`
    ) {
      return { selected: true, ok: false, reason: 'source-tsx-declaration-mismatch' };
    }
    const pkg = JSON.parse(readFileSync(packageFile, 'utf8'));
    if (pkg.version !== TSX_VERSION)
      return { selected: true, ok: false, reason: 'installed-version-mismatch' };
    const r = run(process.execPath, [cli, '--version'], {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 10000,
    });
    if (r.error || r.status !== 0)
      return { selected: true, ok: false, reason: 'native-loader-probe-failed' };
    const version = parseNativeTsxVersion(`VERSION:${r.stdout ?? ''}`);
    if (!version.ok) return { selected: true, ok: false, reason: version.reason };
    const digest = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
    return {
      selected: true,
      ok: true,
      version: version.version,
      loader: cli,
      loaderSha256: digest(cli),
      packageSha256: digest(packageFile),
      lockSha256: digest(join(root, 'pnpm-lock.yaml')),
    };
  } catch (error) {
    return {
      selected: true,
      ok: false,
      reason: `native-loader-unavailable:${error.code ?? error.name}`,
    };
  }
}

// The provisioning result itself is retained on failure, including any container
// stdout/stderr and exact receipt paths. Copy the small immutable receipts into the
// diagnostic before the native carrier can remove its temporary directory.
function snapshotProvisionReceipts(provision) {
  const paths = [
    provision?.container?.prestartReceiptPath,
    provision?.container?.finalReceiptPath,
    provision?.probe?.container?.prestartReceiptPath,
    provision?.probe?.container?.finalReceiptPath,
  ];
  return [...new Set(paths.filter(Boolean))].map((path) => {
    try {
      const st = lstatSync(path);
      if (!st.isFile() || st.nlink !== 1 || st.size > 65536)
        return { path, refused: 'not a single regular receipt <=65536 bytes' };
      const bytes = readFileSync(path);
      return {
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        text: bytes.toString('utf8'),
      };
    } catch (error) {
      return { path, readError: error.code ?? error.name };
    }
  });
}

export function runSmoke(
  root,
  {
    subject,
    limit,
    timeoutMs = 30000,
    auditImage = AUDIT_IMAGE,
    rawLogDir,
    repoRelBase,
    subjectDeps = null,
  } = {},
) {
  if (!dockerAvailable()) {
    return {
      root,
      partial: !!limit,
      counts: { 'isolation-unavailable': 1 },
      results: [
        { status: 'isolation-unavailable', reasons: ['docker server not reachable — fail closed'] },
      ],
    };
  }
  if (!imagePresent()) {
    return {
      root,
      partial: !!limit,
      counts: { 'isolation-image-missing': 1 },
      results: [
        { status: 'isolation-image-missing', reasons: [`image ${ISOLATION_IMAGE} not present`] },
      ],
    };
  }
  const audit = ensureAuditImage(auditImage);
  if (!audit.ok) {
    return {
      root,
      partial: !!limit,
      counts: { 'attempt-audit-unavailable': 1 },
      results: [
        {
          status: 'attempt-audit-unavailable',
          reasons: [`audit image unavailable: ${audit.reason}`],
        },
      ],
    };
  }

  const all = discoverEntrypoints(root);
  // Derive the ONE canonical invocation-context plan from CURRENT discovery. Every
  // physical subject keeps every distinct-cwd context; the plan is the SINGLE
  // source of cwd obligations (never a fixed count/list).
  const plan = smokeSubjectContexts(root, all);
  let targets = all.filter(
    (e) => e.kind === 'entrypoint' || e.kind === 'unsafe' || e.kind === 'undiscovered-declared',
  );
  if (subject) targets = targets.filter((e) => e.subject === subject);
  targets.sort((a, b) => a.rel.localeCompare(b.rel));

  const packets = targets.filter((e) => e.kind !== 'entrypoint');
  let runnable = targets.filter((e) => e.kind === 'entrypoint');
  const partial = !!limit;
  if (limit && limit > 0) runnable = runnable.slice(0, limit);

  // Provision the owned Linux-native TS runtime only when a TS entry point is in
  // scope. A failed provisioning is reported honestly (setup gap), never faked.
  // Static-unsafe packets are still executed under the same audited container.
  // Include them when provisioning the TS runtime, even if no ordinary TS
  // entrypoint remains after a bounded --limit selection.
  const needsTs = [...runnable, ...packets.filter((e) => e.kind === 'unsafe')].some((e) =>
    e.rel.endsWith('.ts'),
  );
  const lockedNative = needsTs ? probeLockedNativeTsx(root) : null;
  const tsRuntime = needsTs && !lockedNative?.selected ? provisionTsRuntime() : null;
  const runtimeSetup = needsTs
    ? lockedNative?.selected
      ? { mode: 'locked-native', readiness: lockedNative }
      : {
          mode: 'isolated-volume',
          provisionResult: tsRuntime,
          receipts: snapshotProvisionReceipts(tsRuntime),
        }
    : null;
  const runtimeError = lockedNative?.selected
    ? lockedNative.ok
      ? null
      : `locked native tsx refused: ${lockedNative.reason}`
    : needsTs && tsRuntime?.ok !== true
      ? `isolated tsx provisioning refused: ${tsRuntime?.reason ?? 'unknown'}`
      : null;
  if (runtimeError) {
    return {
      root,
      partial,
      discovered: all.length,
      targets: targets.length,
      executed: 0,
      runtimeSetup,
      counts: { 'ts-runtime-unavailable': 1 },
      results: [{ status: 'ts-runtime-unavailable', reasons: [runtimeError] }],
    };
  }

  // Fail closed on an EMPTY scope: selecting nothing is not a pass.
  if (runnable.length === 0 && packets.length === 0) {
    return {
      root,
      partial,
      discovered: all.length,
      targets: 0,
      executed: 0,
      counts: { 'empty-scope': 1 },
      results: [
        {
          status: 'empty-scope',
          reasons: ['no entry points matched the selected scope — fail closed'],
        },
      ],
    };
  }

  const results = [];
  for (const e of packets)
    results.push(
      smokeOne(root, e, plan, timeoutMs, audit.image, rawLogDir, repoRelBase, tsRuntime, subjectDeps),
    );
  for (const e of runnable)
    results.push(
      smokeOne(
        root,
        e,
        plan,
        timeoutMs,
        audit.image,
        rawLogDir,
        repoRelBase,
        tsRuntime,
        subjectDeps,
      ),
    );

  const counts = {};
  for (const r of results) counts[r.status] = (counts[r.status] ?? 0) + 1;
  return {
    root,
    generatedAt: new Date().toISOString(),
    partial,
    discovered: all.length,
    targets: targets.length,
    executed: runnable.length,
    auditImage: audit.image,
    runtimeSetup,
    counts,
    results,
  };
}

/** Adversarial, in-memory fixtures for the audited classifier. */
export async function selfTest() {
  const { topLevelExecutable } = await import('./discover.mjs');
  const cases = [];
  const add = (name, ok, detail) => cases.push({ name, ok, detail });

  add(
    'renamed top-level run() is executable',
    topLevelExecutable('async function run() {}\nrun();\n') === true,
    'top-level run() call detected',
  );
  add(
    'declarations-only file is a module',
    topLevelExecutable('export const a = 1;\nexport function b() {}\n') === false,
    'no top-level execution',
  );
  // A const with an initializer CALL is executable, not a pure declaration.
  add(
    'const initializer call is executable',
    topLevelExecutable('const x = run();\n') === true,
    'initializer call detected',
  );
  // A bare assignment call after a declaration is executable.
  add(
    'assignment call is executable',
    topLevelExecutable('let x;\nx = run();\n') === true,
    'assignment call detected',
  );
  // Malformed source is treated as unsupported -> executable (fail closed).
  add(
    'malformed source defaults to executable',
    topLevelExecutable('function ( { ]\n') === true,
    'malformed -> fail closed',
  );

  const ok = (over = {}) => ({
    exit: 2,
    out: '',
    err: 'usage: script --x',
    auditOk: true,
    timedOut: false,
    signal: null,
    entrypointExecuted: true,
    attempts: { network: [], write: [], permittedWrites: [] },
    ...over,
  });
  const helpOk = ok({ exit: 0 });
  const contractOk = {
    noArgs: { documented: true, exit: 2, usagePrinted: true },
    help: { supported: true, exit: 0, usagePrinted: true },
    evidence: 'test',
  };
  const contractNoHelp = {
    noArgs: { documented: true, exit: 2, usagePrinted: true },
    help: { supported: false },
    evidence: 'test',
  };
  const contractUndocumented = {
    noArgs: { documented: false, exit: null, usagePrinted: false },
    help: { supported: false },
    evidence: 'test',
  };
  const contractUnnamedExit = {
    noArgs: { documented: true, exit: null, usagePrinted: true },
    help: { supported: false },
    evidence: 'test',
  };
  const mk = (noArgs, help, unknown = ok(), contract = contractOk) =>
    classifyRun({ kind: 'entrypoint', rel: 'x.ts' }, noArgs, help, unknown, contract);

  add(
    'documented usage/help/unknown contract passes',
    mk(ok(), helpOk, ok()).status === 'ok',
    'ok',
  );
  add(
    'caught network attempt is caught by the audit (not a pass)',
    mk(
      ok({ attempts: { network: ['connect(...) AF_INET'], write: [], permittedWrites: [] } }),
      helpOk,
    ).status === 'attempt-audit-network',
    'attempt-audit-network',
  );
  add(
    'caught forbidden write is caught by the audit (not a pass)',
    mk(
      ok({
        attempts: { network: [], write: ['openat(... O_WRONLY) = -1 EROFS'], permittedWrites: [] },
      }),
      helpOk,
    ).status === 'attempt-audit-write',
    'attempt-audit-write',
  );
  add(
    'permitted disposable write is not a failure',
    mk(
      ok({ attempts: { network: [], write: [], permittedWrites: ['openat(... /tmp/x ...) = 3'] } }),
      helpOk,
    ).status === 'ok',
    'permitted write allowed',
  );
  add(
    'audit unavailable fails closed',
    mk(ok({ auditOk: false, auditReason: 'no trace' }), helpOk).status ===
      'attempt-audit-unavailable',
    'attempt-audit-unavailable',
  );
  add(
    'timeout fails even with a nonempty trace',
    mk(ok({ timedOut: true }), helpOk).status === 'timeout',
    'timeout',
  );
  add(
    'no definitive exit fails',
    mk(ok({ exit: null, signal: null }), helpOk).status === 'no-definite-exit',
    'no-definite-exit',
  );
  add(
    'setup-incompatibility fails',
    mk(ok({ setupError: true }), helpOk).status === 'setup-incompatibility',
    'setup-incompatibility',
  );
  add(
    'no-args nonzero without usage fails',
    mk(ok({ err: 'boom', exit: 1 }), helpOk).status === 'noargs-contract',
    'noargs-contract',
  );
  add(
    'ignored --help fails',
    mk(ok(), ok({ exit: 0, out: 'ran the whole smoke', err: '' })).status === 'help-contract',
    'help-contract',
  );
  add(
    'accepted unknown flag fails',
    mk(ok(), helpOk, ok({ exit: 0, out: '', err: '' })).status === 'unknown-option-accepted',
    'unknown-option-accepted',
  );
  add(
    'undiscovered declared command fails',
    classifyRun(
      { kind: 'undiscovered-declared', rel: 'x.js', reason: 'declared but missing' },
      ok(),
      helpOk,
      ok(),
    ).status === 'declaration-discovery-mismatch',
    'declaration/discovery disagreement',
  );
  add(
    'unsafe entry point executes in isolation and is labelled distinctly',
    (() => {
      const r = classifyRun(
        { kind: 'unsafe', rel: 'y.ts', destructive: ['rmSync'] },
        ok(),
        helpOk,
        ok(),
        contractOk,
      );
      // The obsolete expectation (a bare static label `unsafe-executed-no-attempt`)
      // is DELIBERATELY CHANGED: a static-flagged subject meeting every actual
      // runtime criterion now qualifies `ok` — exactly like an ordinary
      // entrypoint — while its warning / destructive findings / UNSAFE-ENTRYPOINT
      // provenance are RETAINED on the accepted result.
      return (
        r.status === 'ok' &&
        r.packets?.[0] === 'UNSAFE-ENTRYPOINT' &&
        Array.isArray(r.warnings) &&
        r.warnings.includes('static-unsafe-entrypoint') &&
        r.staticRisk?.kind === 'unsafe' &&
        r.staticRisk?.destructive?.includes('rmSync')
      );
    })(),
    'ok + retained UNSAFE-ENTRYPOINT warning/provenance',
  );
  add(
    'unsafe entry point attempting network under isolation fails as an audited attempt',
    classifyRun(
      { kind: 'unsafe', rel: 'y.ts', destructive: ['rmSync'] },
      ok({ attempts: { network: ['connect(...) AF_INET'], write: [], permittedWrites: [] } }),
      helpOk,
      ok(),
      contractOk,
    ).status === 'attempt-audit-network',
    'attempt-audit-network',
  );
  // ---- static-flagged subject held to the SAME runtime criteria as an ordinary
  //      one: a healthy flagged subject qualifies (with provenance retained),
  //      while EVERY actual runtime failure still fails it. ----------------------
  {
    const flag = { kind: 'unsafe', rel: 'y.ts', destructive: ['rmSync'] };
    const uf = (noArgs, help, unknown = ok(), contract = contractOk) =>
      classifyRun(flag, noArgs, help, unknown, contract);
    add(
      'static-flagged: a healthy flagged subject qualifies under the SAME runtime criteria (warning retained)',
      uf(ok(), helpOk, ok()).status === 'ok' &&
        uf(ok(), helpOk, ok()).packets?.[0] === 'UNSAFE-ENTRYPOINT',
      'ok + UNSAFE-ENTRYPOINT retained',
    );
    add(
      'static-flagged: a forbidden write under isolation still fails the flagged subject',
      uf(
        ok({
          attempts: {
            network: [],
            write: ['openat(... O_WRONLY) = -1 EROFS'],
            permittedWrites: [],
          },
        }),
        helpOk,
      ).status === 'attempt-audit-write',
      'attempt-audit-write',
    );
    add(
      'static-flagged: a missing invocation still fails the flagged subject',
      uf(undefined, helpOk, ok()).status === 'missing-invocation',
      'missing-invocation',
    );
    add(
      'static-flagged: a missing syscall audit still fails the flagged subject',
      uf(ok({ auditOk: false, auditReason: 'no trace' }), helpOk).status ===
        'attempt-audit-unavailable',
      'attempt-audit-unavailable',
    );
    add(
      'static-flagged: a non-documented/wrong exit still fails the flagged subject',
      uf(ok({ err: 'boom', exit: 1 }), helpOk).status === 'noargs-contract',
      'noargs-contract',
    );
    add(
      'static-flagged: a timeout still fails the flagged subject',
      uf(ok({ timedOut: true }), helpOk).status === 'timeout',
      'timeout',
    );
    add(
      'static-flagged: a setup/tool incompatibility still fails the flagged subject',
      uf(ok({ setupError: true }), helpOk).status === 'setup-incompatibility',
      'setup-incompatibility',
    );
    add(
      'static-flagged: a silently-accepted unknown option still fails the flagged subject',
      uf(ok(), helpOk, ok({ exit: 0, out: '', err: '' })).status === 'unknown-option-accepted',
      'unknown-option-accepted',
    );
    add(
      'static-flagged: an unexecuted entry point still fails the flagged subject',
      uf(ok({ entrypointExecuted: false }), helpOk).status === 'entrypoint-not-executed',
      'entrypoint-not-executed',
    );
  }
  add(
    'entrypoint with no documented no-args usage branch fails',
    mk(ok(), helpOk, ok(), contractUndocumented).status === 'noargs-undocumented',
    'noargs-undocumented',
  );
  add(
    'entrypoint with no --help handler is not forced to exit 0',
    classifyRun(
      { kind: 'entrypoint', rel: 'x.ts' },
      ok(),
      ok({ exit: 1, out: '', err: '' }),
      ok(),
      contractNoHelp,
    ).status === 'ok',
    'help optional',
  );
  add(
    'documented no-args branch without a named exit fails (no arbitrary integer)',
    mk(ok({ exit: 3 }), ok({ exit: 1, out: '', err: '' }), ok(), contractUnnamedExit).status ===
      'noargs-unresolved-exit',
    'noargs-unresolved-exit',
  );
  add(
    'entry point that did not execute fails (false)',
    mk(ok({ entrypointExecuted: false }), helpOk, ok()).status === 'entrypoint-not-executed',
    'entrypoint-not-executed',
  );
  add(
    'entry point with an absent exec record fails',
    mk(ok({ entrypointExecuted: undefined }), helpOk, ok()).status === 'entrypoint-not-executed',
    'entrypoint-not-executed',
  );
  add(
    'signalled invocation fails',
    mk(ok({ signal: 'SIGKILL' }), helpOk, ok()).status === 'signalled',
    'signalled',
  );

  // Source-derived CONTRACT controls (contract.mjs), driven through the SAME
  // `{ name, ok, detail }` contract as the classifier cases above. They exercise
  // the actual reachable argValue/usage helper shape (a documented no-args branch
  // the earlier deriver missed) and the adverse shapes — unused/foreign helpers,
  // incorrect argv binding, help negation, ambiguous/dynamic exit, helper side
  // effects, nested reachability. The 25 cases above are unchanged.
  {
    const { contractControls } = await import('./contract-controls.mjs');
    for (const c of contractControls()) add(c.name, c.ok, c.detail);
  }

  // Reviewed config-guard codemod + missing-DATABASE_URL smoke-context controls:
  // driven through the SAME `{ name, ok, detail }` contract as the cases above.
  {
    const { configGuardControls } = await import('./config-guard-controls.mjs');
    for (const c of configGuardControls()) add(c.name, c.ok, c.detail);
  }

  const failed = cases.filter((c) => !c.ok);
  return {
    cases,
    passed: cases.length - failed.length,
    total: cases.length,
    ok: failed.length === 0,
  };
}

const USAGE_TEXT = `usage: run-smoke --root <repo> [--subject <s>] [--limit N] [--timeout-ms N] [--out <file>] [--raw-log-dir <dir>] [--self-test]\n`;

/**
 * Fail-closed argument parser: an unknown flag, a missing value, or an invalid
 * bound is a usage error (exit 2) — never silently ignored or accepted.
 */
export function parseArgs(argv) {
  const opts = { root: process.cwd(), timeoutMs: 30000 };
  const needValue = (a, i) => {
    const v = argv[i + 1];
    if (v == null || v.startsWith('--')) throw new UsageError(`${a} requires a value`);
    return v;
  };
  const needInt = (a, i, { min } = {}) => {
    const v = needValue(a, i);
    const n = Number(v);
    if (!Number.isInteger(n) || (min != null && n < min))
      throw new UsageError(`${a} requires an integer >= ${min}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') opts.root = needValue(a, i++);
    else if (a === '--subject') opts.subject = needValue(a, i++);
    else if (a === '--limit') opts.limit = needInt(a, i++, { min: 1 });
    else if (a === '--timeout-ms') opts.timeoutMs = needInt(a, i++, { min: 1 });
    else if (a === '--out') opts.out = needValue(a, i++);
    else if (a === '--raw-log-dir') opts.rawLogDir = needValue(a, i++);
    else if (a === '--self-test') opts.selfTest = true;
    else throw new UsageError(`unknown option: ${a}`);
  }
  return opts;
}

export class UsageError extends Error {}

if (process.argv[1]?.endsWith('run-smoke.mjs')) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`${USAGE_TEXT}error: ${e.message}\n`);
    process.exit(2);
  }
  if (opts.selfTest) {
    const r = await selfTest();
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    process.exitCode = r.ok ? 0 : 1;
  } else {
    // Always run against a disposable staging tree of tracked source only.
    const stage = mkdtempSync(join(tmpdir(), 'cleanup-smoke-stage-'));
    let report;
    const realRoot = opts.root;
    try {
      stageTrackedSource(realRoot, stage);
      const deps = provisionStageDeps(realRoot, stage);
      report = runSmoke(stage, { ...opts, repoRelBase: undefined });
      report.realRoot = realRoot;
      report.staged = true;
      report.stageDir = stage;
      report.stageDeps = deps;
      if (deps.missing.length) report.counts['stage-dep-missing'] = deps.missing.length;
    } catch (e) {
      report = {
        realRoot,
        staged: false,
        counts: { 'stage-failed': 1 },
        results: [{ status: 'stage-failed', reasons: [String(e?.message ?? e)] }],
      };
    } finally {
      // Retain the uniquely owned staging tree (tracked source + provisioned tool
      // deps). No recursive deletion — the artifacts are the evidence.
      report.retainedStage = stage;
    }
    const json = JSON.stringify(report, null, 2);
    if (opts.out) writeFileSync(opts.out, json);
    else process.stdout.write(json);
    const failing = Object.keys(report.counts).some((k) => k !== 'ok');
    process.exitCode = failing ? 1 : 0;
  }
}
