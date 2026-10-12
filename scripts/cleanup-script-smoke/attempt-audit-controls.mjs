/**
 * CleanUp1 §6.2 — ATTEMPT-AUDIT controls for the exact subject/mode-argv proof.
 *
 * These are executable controls (root runs them; NO Docker, NO application
 * subject). They drive the ACTUAL exported parser + exec proof from
 * attempt-audit.mjs (`parseSyscallTrace`, `entrypointExecutedFromTrace`,
 * `straceAttemptWrapper`) over synthetic strace `execve` lines:
 *
 *   - a LONG TS subject path, invoked through the `tsx` loader AND directly, with
 *     a long mode argv is PROVEN executed;
 *   - the full (untruncated) long subject/arguments survive parsing;
 *   - a TRUNCATED subject/argv (strace's default 32-byte string limit) is
 *     REJECTED — proving root round 30's truncation cannot slip through as a
 *     substring/length-agnostic match;
 *   - a WRONG subject, EXTRA / MISSING / REORDERED mode arguments, an
 *     UNSUCCESSFUL exec (`= -1`), and a token that merely CONTAINS the subject
 *     (not equal, not a `/`-suffixed path) are each REJECTED;
 *   - the audit wrapper actually requests the long string limit (`-s 65535`).
 *
 * These supplement a real Docker matrix that root runs; they are NOT physical
 * execution evidence. Usage:
 *   node scripts/cleanup-script-smoke/attempt-audit-controls.mjs
 */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseSyscallTrace,
  parseSyscallTraceChunks,
  entrypointExecutedFromTrace,
  straceAttemptWrapper,
  runWithAttemptAudit,
  classifyAttemptAudit,
} from './attempt-audit.mjs';
import { classifyRun } from './run-smoke.mjs';
import { planInvocationContexts, nativeCwdFor } from './invocation-context.mjs';

const TS_LOADER = '/tsruntime/node_modules/tsx/dist/cli.mjs';
/** A subject path far longer than strace's default 32-byte string limit. */
const SUBJECT =
  'apps/api/scripts/cleanup/' + 'nested-segment/'.repeat(8) + 'cleanup-audit-mode-runner.ts';
/** A long mode argv (each token also longer than the default string limit). */
const ARGS = ['--mode', 'assert-no-side-effects', '--subject', `subject-token-${'x'.repeat(40)}`];
const WRONG_SUBJECT = 'apps/api/scripts/other/cleanup-runner.ts';

/** Quote one argv token the way strace renders a C string. */
function quote(a) {
  return `"${String(a).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** One synthetic strace `execve` line (successful by default). */
function execLine(argv, { pid = '1234', ok = true } = {}) {
  const tail = ok ? '= 0' : '= -1 ENOENT (No such file or directory)';
  return `${pid}  execve("/usr/local/bin/node", [${argv.map(quote).join(', ')}], 0x7ffd3a2b1c40) ${tail}`;
}

/** Prove exec against SUBJECT + ARGS for one synthetic argv. */
function proven(argv, { ok = true } = {}) {
  return entrypointExecutedFromTrace(parseSyscallTrace(execLine(argv, { ok })), {
    subject: SUBJECT,
    args: ARGS,
  });
}

function runControls() {
  const checks = [];
  const add = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });

  // ---- 1. long TS subject + mode argv, via the tsx loader ⇒ proven ----------
  add(
    'a long TS subject + long mode argv executed via the tsx loader is proven',
    proven(['node', TS_LOADER, SUBJECT, ...ARGS]) === true,
    JSON.stringify({ subjectLen: SUBJECT.length }),
  );

  // ---- 2. same subject, direct node (no loader) ⇒ proven -------------------
  add(
    'a long subject executed directly by node (no loader) is proven',
    proven(['node', SUBJECT, ...ARGS]) === true,
    'direct node argv',
  );

  // ---- 3. no-args mode (empty argv) proven; an extra arg is NOT ------------
  add(
    'the no-args mode (exact empty argv) is proven',
    entrypointExecutedFromTrace(parseSyscallTrace(execLine(['node', TS_LOADER, SUBJECT])), {
      subject: SUBJECT,
      args: [],
    }) === true,
    'empty mode argv',
  );
  add(
    'a no-args expectation is NOT satisfied by an extra `--help` argument',
    entrypointExecutedFromTrace(
      parseSyscallTrace(execLine(['node', TS_LOADER, SUBJECT, '--help'])),
      { subject: SUBJECT, args: [] },
    ) === false,
    'length mismatch rejected',
  );

  // ---- 4. the parser preserves the FULL long tokens (no truncation) --------
  {
    const parsed = parseSyscallTrace(execLine(['node', TS_LOADER, SUBJECT, ...ARGS]));
    add(
      'the trace parser preserves the full untruncated subject and every mode argument',
      parsed.execs.length === 1 &&
        parsed.execs[0].includes(SUBJECT) &&
        ARGS.every((a) => parsed.execs[0].includes(a)),
      JSON.stringify({
        execs: parsed.execs.length,
        hasSubject: parsed.execs[0]?.includes(SUBJECT),
      }),
    );
  }

  // ---- 5. TRUNCATED subject/argv (default strace limit) ⇒ NOT proven -------
  {
    const trunc = (s) => (String(s).length > 29 ? `${String(s).slice(0, 29)}...` : String(s));
    const truncatedArgv = ['node', TS_LOADER, trunc(SUBJECT), ...ARGS.map(trunc)];
    add(
      'a TRUNCATED subject/argv (strace default limit) is REJECTED, never substring-matched',
      proven(truncatedArgv) === false,
      JSON.stringify({ truncatedSubject: trunc(SUBJECT) }),
    );
  }

  // ---- 6. WRONG subject ⇒ rejected -----------------------------------------
  add(
    'a different subject is rejected',
    proven(['node', TS_LOADER, WRONG_SUBJECT, ...ARGS]) === false,
    'wrong subject',
  );

  // ---- 7. EXTRA / MISSING / REORDERED mode arguments ⇒ rejected ------------
  add(
    'an EXTRA mode argument is rejected (exact length enforced)',
    proven(['node', TS_LOADER, SUBJECT, ...ARGS, '--extra']) === false,
    'extra mode arg',
  );
  add(
    'a MISSING mode argument is rejected (exact length enforced)',
    proven(['node', TS_LOADER, SUBJECT, ...ARGS.slice(0, -1)]) === false,
    'missing mode arg',
  );
  add(
    'REORDERED mode arguments are rejected (order enforced, not a set match)',
    proven(['node', TS_LOADER, SUBJECT, ARGS[2], ARGS[3], ARGS[0], ARGS[1]]) === false,
    JSON.stringify({ reordered: [ARGS[2], ARGS[3], ARGS[0], ARGS[1]] }),
  );

  // ---- 8. UNSUCCESSFUL exec ⇒ rejected (not proof) -------------------------
  add(
    'an UNSUCCESSFUL execve (= -1) is rejected even with an exact argv',
    proven(['node', TS_LOADER, SUBJECT, ...ARGS], { ok: false }) === false,
    'failed execve is not proof',
  );

  // ---- 9. subject token that merely CONTAINS the subject ⇒ rejected --------
  add(
    'a subject token that only CONTAINS the subject (substring) is rejected',
    proven(['node', TS_LOADER, `/other/${SUBJECT}x`, ...ARGS]) === false,
    'substring-only subject token',
  );

  // ---- 9b. STRICT runtime-config binding (the NEW committed-tsconfig flag) ----
  // The subject is invoked as `node <tsx cli> --tsconfig <cfg> <subject> <args>`
  // and the proof is bound to the EXACT expected config + loader. Each negative
  // case is REJECTED (never substring/suffix-matched, never prefix-stripped).
  {
    const CFG = 'apps/api/tsconfig.json';
    const OTHER_CFG = 'apps/web/tsconfig.json';
    const OTHER_LOADER = '/tsruntime/node_modules/tsx/dist/cli.js';
    const strictArgv = (argv) =>
      entrypointExecutedFromTrace(parseSyscallTrace(execLine(argv)), {
        subject: SUBJECT,
        args: ARGS,
        runtimeConfig: CFG,
        loader: TS_LOADER,
      });
    add(
      'strict: the exact `node <loader> --tsconfig <cfg> <subject> <args>` command is PROVEN',
      strictArgv(['node', TS_LOADER, '--tsconfig', CFG, SUBJECT, ...ARGS]) === true,
      'exact bound config+loader',
    );
    add(
      'strict: a MISSING --tsconfig flag is REJECTED',
      strictArgv(['node', TS_LOADER, SUBJECT, ...ARGS]) === false,
      'no config flag',
    );
    add(
      'strict: a WRONG (different) --tsconfig value is REJECTED',
      strictArgv(['node', TS_LOADER, '--tsconfig', OTHER_CFG, SUBJECT, ...ARGS]) === false,
      'wrong config value',
    );
    add(
      'strict: the `--tsconfig=<cfg>` equals-form is REJECTED (must be the exact `--tsconfig <cfg>` pair)',
      strictArgv(['node', TS_LOADER, `--tsconfig=${CFG}`, SUBJECT, ...ARGS]) === false,
      'equals form',
    );
    add(
      'strict: a DUPLICATE --tsconfig flag is REJECTED',
      strictArgv(['node', TS_LOADER, '--tsconfig', CFG, '--tsconfig', CFG, SUBJECT, ...ARGS]) ===
        false,
      'duplicate config',
    );
    add(
      'strict: a SUBSTITUTED loader is REJECTED',
      strictArgv(['node', OTHER_LOADER, '--tsconfig', CFG, SUBJECT, ...ARGS]) === false,
      'substituted loader',
    );
    add(
      'strict: an ARBITRARY PREFIX flag before the loader is REJECTED (no prefix stripping)',
      strictArgv(['node', '--inspect', TS_LOADER, '--tsconfig', CFG, SUBJECT, ...ARGS]) === false,
      'prefix flag',
    );
    add(
      'strict: EXTRA / REORDERED mode args are REJECTED with a bound config present',
      strictArgv(['node', TS_LOADER, '--tsconfig', CFG, SUBJECT, ...ARGS, '--extra']) === false &&
        strictArgv([
          'node',
          TS_LOADER,
          '--tsconfig',
          CFG,
          SUBJECT,
          ARGS[2],
          ARGS[3],
          ARGS[0],
          ARGS[1],
        ]) === false,
      'extra/reordered args',
    );
    add(
      'strict: a config that ESCAPES the expected value is REJECTED',
      strictArgv([
        'node',
        TS_LOADER,
        '--tsconfig',
        '../outside/tsconfig.json',
        SUBJECT,
        ...ARGS,
      ]) === false,
      'escaping config',
    );
    add(
      'strict: a no-config direct-node run is PROVEN with an explicit null config',
      entrypointExecutedFromTrace(parseSyscallTrace(execLine(['node', SUBJECT, ...ARGS])), {
        subject: SUBJECT,
        args: ARGS,
        runtimeConfig: null,
        loader: null,
      }) === true,
      'null config direct node',
    );
  }

  // ---- 9c. LEGACY refusal (read-only evidence re-parsers pass NO runtime plan):
  //          a tsx run that carries an UNBOUND --tsconfig (pair OR `=`-form) is now
  //          REFUSED — legacy keeps ONLY node + optional tsx + subject + exact args.
  //          A wrong / unbound config can therefore never be accepted.
  {
    const CFG = 'apps/api/tsconfig.json';
    const WRONG_CFG = '/wrong/tsconfig.json';
    add(
      'legacy (no plan threaded): a tsx run carrying an unbound `--tsconfig <cfg>` pair is REFUSED',
      entrypointExecutedFromTrace(
        parseSyscallTrace(execLine(['node', TS_LOADER, '--tsconfig', CFG, SUBJECT, ...ARGS])),
        { subject: SUBJECT, args: ARGS },
      ) === false,
      'legacy refuses the unbound config pair',
    );
    add(
      'legacy: a WRONG `/wrong/tsconfig.json` value is REFUSED (never accepted without an expected config)',
      entrypointExecutedFromTrace(
        parseSyscallTrace(execLine(['node', TS_LOADER, '--tsconfig', WRONG_CFG, SUBJECT, ...ARGS])),
        { subject: SUBJECT, args: ARGS },
      ) === false,
      'legacy refuses a wrong config value',
    );
    add(
      'legacy: the `--tsconfig=<cfg>` equals-form is REFUSED (never stripped)',
      entrypointExecutedFromTrace(
        parseSyscallTrace(execLine(['node', TS_LOADER, `--tsconfig=${CFG}`, SUBJECT, ...ARGS])),
        { subject: SUBJECT, args: ARGS },
      ) === false,
      'legacy refuses the equals form',
    );
    add(
      'legacy: a DUPLICATE `--tsconfig` pair is still REJECTED',
      entrypointExecutedFromTrace(
        parseSyscallTrace(
          execLine(['node', TS_LOADER, '--tsconfig', CFG, '--tsconfig', CFG, SUBJECT, ...ARGS]),
        ),
        { subject: SUBJECT, args: ARGS },
      ) === false,
      'legacy duplicate config rejected',
    );
    add(
      'legacy: the ORIGINAL tolerant shape (node + optional tsx + subject + args, NO config) is still PROVEN',
      entrypointExecutedFromTrace(
        parseSyscallTrace(execLine(['node', TS_LOADER, SUBJECT, ...ARGS])),
        { subject: SUBJECT, args: ARGS },
      ) === true &&
        entrypointExecutedFromTrace(parseSyscallTrace(execLine(['node', SUBJECT, ...ARGS])), {
          subject: SUBJECT,
          args: ARGS,
        }) === true,
      'legacy tolerant shape retained',
    );
  }

  // ---- 9d. MODERN explicit null/null selects STRICT: a direct-node run is proven,
  //          but an UNEXPECTED loader or config is REJECTED (both explicit null is
  //          a modern plan, never the legacy tolerant branch).
  {
    const CFG = 'apps/api/tsconfig.json';
    const strictNull = (argv) =>
      entrypointExecutedFromTrace(parseSyscallTrace(execLine(argv)), {
        subject: SUBJECT,
        args: ARGS,
        runtimeConfig: null,
        loader: null,
      });
    add(
      'explicit null/null: the exact direct-node run `node <subject> <args>` is PROVEN',
      strictNull(['node', SUBJECT, ...ARGS]) === true,
      'explicit null/null direct node',
    );
    add(
      'explicit null/null: an UNEXPECTED tsx loader is REJECTED',
      strictNull(['node', TS_LOADER, SUBJECT, ...ARGS]) === false,
      'unexpected loader rejected',
    );
    add(
      'explicit null/null: an UNEXPECTED --tsconfig is REJECTED',
      strictNull(['node', '--tsconfig', CFG, SUBJECT, ...ARGS]) === false,
      'unexpected config rejected',
    );
    add(
      'explicit null/null: an UNEXPECTED `--tsconfig=<cfg>` equals-form is REJECTED',
      strictNull(['node', `--tsconfig=${CFG}`, SUBJECT, ...ARGS]) === false,
      'unexpected equals config rejected',
    );
  }

  // ---- 9e. context-bound exec proof: EXACT ABSOLUTE native subject binding ----
  // A context-bound invocation binds the trace to the EXACT absolute native
  // subject path — a wrong-prefix SAME-SUFFIX path is refused. `nativeSubject:
  // undefined` (legacy) preserves the original suffix-tolerant reparse.
  {
    const NATIVE = `/src/${SUBJECT}`;
    const bind = (argv) =>
      entrypointExecutedFromTrace(parseSyscallTrace(execLine(argv)), {
        subject: SUBJECT,
        args: ARGS,
        nativeSubject: NATIVE,
      });
    add(
      'native-bound: the exact ABSOLUTE native subject is PROVEN',
      bind(['node', NATIVE, ...ARGS]) === true,
      'exact absolute',
    );
    add(
      'native-bound: the exact absolute subject via the tsx loader is PROVEN',
      bind(['node', TS_LOADER, NATIVE, ...ARGS]) === true,
      'absolute via loader',
    );
    add(
      'native-bound: a wrong-prefix SAME-SUFFIX path is REJECTED (never suffix-only matched)',
      bind(['node', `/other${NATIVE}`, ...ARGS]) === false,
      JSON.stringify({ foreign: `/other${NATIVE}` }),
    );
    add(
      'native-bound: the legacy repo-relative subject is REJECTED when an absolute native subject is bound',
      bind(['node', SUBJECT, ...ARGS]) === false,
      'relative is not the bound absolute',
    );
    add(
      'native-bound: EXTRA mode args are still REJECTED',
      bind(['node', NATIVE, ...ARGS, '--extra']) === false,
      'extra args',
    );
    add(
      'native-bound: undefined nativeSubject preserves the legacy suffix-tolerant match',
      entrypointExecutedFromTrace(
        parseSyscallTrace(execLine(['node', TS_LOADER, SUBJECT, ...ARGS])),
        { subject: SUBJECT, args: ARGS },
      ) === true,
      'legacy preserved',
    );
  }

  // ---- 9f. EXPLICIT INVALID nativeSubject options REFUSE (never downgraded) ----
  // ONLY `undefined` may use the legacy suffix match. An explicitly supplied
  // `null`, empty string, non-string or RELATIVE path is an INVALID bound subject
  // and is REFUSED — even when the raw trace shows the targeted subject — so an
  // invalid explicit option is never silently downgraded to the tolerant branch.
  {
    const traceRel = parseSyscallTrace(execLine(['node', SUBJECT, ...ARGS]));
    const traceForeign = parseSyscallTrace(execLine(['node', `/other/${SUBJECT}`, ...ARGS]));
    const base = { subject: SUBJECT, args: ARGS };
    for (const [label, supplied] of [
      ['null', null],
      ['empty string', ''],
      ['non-string', 42],
      ['relative path', SUBJECT],
    ]) {
      add(
        `explicit ${label} nativeSubject is REFUSED even when the trace shows the exact subject`,
        entrypointExecutedFromTrace(traceRel, { ...base, nativeSubject: supplied }) === false,
        JSON.stringify({ supplied }),
      );
    }
    add(
      'explicit null nativeSubject is REFUSED even against a foreign same-suffix trace',
      entrypointExecutedFromTrace(traceForeign, { ...base, nativeSubject: null }) === false,
      'null refused',
    );
    add(
      'an ABSOLUTE nativeSubject differing only by PREFIX is REFUSED (never suffix-matched)',
      entrypointExecutedFromTrace(traceForeign, { ...base, nativeSubject: `/src/${SUBJECT}` }) ===
        false,
      JSON.stringify({ trace: `/other/${SUBJECT}`, bound: `/src/${SUBJECT}` }),
    );
    add(
      'undefined nativeSubject (option OMITTED) still keeps the legacy suffix-tolerant match',
      entrypointExecutedFromTrace(traceRel, { ...base }) === true,
      'legacy preserved',
    );
  }

  // ---- 10. the audit wrapper requests the long string limit ----------------
  {
    const w = straceAttemptWrapper('noargs.trace');
    const i = w.indexOf('-s');
    add(
      'the strace audit wrapper requests the long string limit (-s 65535)',
      i >= 0 && w[i + 1] === '65535' && w.includes('-f') && w.includes('-yy'),
      JSON.stringify(w),
    );
  }

  // ---- 11. STREAMING parser equivalence across SMALL chunk sizes -----------
  // The streaming reader must reproduce the pure-string parser EXACTLY, including
  // unfinished/resumed rejoining ACROSS buffer/newline boundaries (the pending
  // syscall state spans chunks), incremental UTF8 decoding of a multibyte character
  // SPLIT across reads, interleaved PIDs, a still-pending unfinished syscall at EOF,
  // allowed vs forbidden writes, a network attempt and the exact exec proof.
  add(
    'streaming parser exposes the shared chunk API (parseSyscallTraceChunks)',
    typeof parseSyscallTraceChunks === 'function',
    'chunk API present',
  );
  {
    const chunkBytes = (buf, size) => {
      const out = [];
      for (let i = 0; i < buf.length; i += size)
        out.push(buf.subarray(i, Math.min(i + size, buf.length)));
      return out;
    };
    const exec = execLine(['node', TS_LOADER, SUBJECT, ...ARGS]);
    const lines = [
      exec,
      '1234  socket(AF_INET, SOCK_STREAM, IPPROTO_IP) = 3',
      '1235  openat(AT_FDCWD, "/tmp/ok-é.txt", O_WRONLY|O_CREAT, 0644) = 4',
      '1235  openat(AT_FDCWD, "/src/forbidden.txt", O_WRONLY, 0644) = -1 EROFS (Read-only file system)',
      '7777  openat(AT_FDCWD, "/tmp/split-é.txt", O_WRONLY <unfinished ...>',
      '8888  write(20</tmp/other.txt>, "data", 4) = 4',
      '7777  <... openat resumed>) = 5',
      '2222  openat(AT_FDCWD, "/src/leak-é.txt", O_WRONLY <unfinished ...>',
    ];
    const trace = lines.join('\n') + '\n';
    const bytes = Buffer.from(trace, 'utf8');
    const baseline = parseSyscallTrace(trace);
    const baselineJson = JSON.stringify(baseline);
    const sizes = [1, 2, 3, 4, 5, 7, 13, 64, 257, bytes.length, bytes.length + 10];
    const mismatched = [];
    for (const size of sizes) {
      const p = parseSyscallTraceChunks(chunkBytes(bytes, size));
      const pj = JSON.stringify({
        network: p.network,
        write: p.write,
        permittedWrites: p.permittedWrites,
        execs: p.execs,
      });
      if (pj !== baselineJson) mismatched.push(size);
    }
    add(
      'streaming parser: chunked parse at every small chunk size equals the pure-string parse (all arrays, order, duplicates)',
      mismatched.length === 0,
      JSON.stringify({ sizes, mismatched }),
    );
    add(
      'streaming parser: the streamed raw sha256 + byte count match the whole-buffer hash/length',
      (() => {
        const p = parseSyscallTraceChunks(chunkBytes(bytes, 3));
        return (
          p.sha256 === createHash('sha256').update(bytes).digest('hex') && p.bytes === bytes.length
        );
      })(),
      'sha/bytes',
    );
    const one = parseSyscallTraceChunks(chunkBytes(bytes, 1)); // 1-byte chunks: every boundary is split
    add(
      'streaming parser: a multibyte UTF8 char split across a read boundary is decoded intact (allowed "/tmp/ok-é.txt")',
      one.permittedWrites.some((l) => l.includes('/tmp/ok-é.txt')),
      JSON.stringify(one.permittedWrites),
    );
    add(
      'streaming parser: an unfinished/resumed pair split across reads is rejoined (allowed "/tmp/split-é.txt")',
      one.permittedWrites.some((l) => l.includes('/tmp/split-é.txt')),
      'rejoined across chunks',
    );
    add(
      'streaming parser: interleaved PIDs do not collide (annotated write "/tmp/other.txt" captured)',
      one.permittedWrites.some((l) => l.includes('/tmp/other.txt')),
      'interleaved PIDs',
    );
    add(
      'streaming parser: a pending unfinished syscall is emitted at EOF as a forbidden write ("/src/leak-é.txt")',
      one.write.some((l) => l.includes('/src/leak-é.txt')),
      JSON.stringify(one.write),
    );
    add(
      'streaming parser: allowed and forbidden writes are classified identically under 1-byte chunks',
      one.write.some((l) => l.includes('/src/forbidden.txt')) &&
        !one.write.some((l) => l.includes('/tmp/ok-é.txt')),
      JSON.stringify(one.write),
    );
    add(
      'streaming parser: the network attempt is captured under 1-byte chunks',
      one.network.length === 1 && one.network[0].includes('AF_INET'),
      JSON.stringify(one.network),
    );
    add(
      'streaming parser: the exact exec proof is re-derived from the 1-byte-chunked parse',
      entrypointExecutedFromTrace(one, { subject: SUBJECT, args: ARGS }) === true,
      'exec proof across chunks',
    );
  }

  // ---- 12. denied writes inside /tmp are not disposable scratch writes ----
  // The boundary proof stages its read-only source below the Linux /tmp. The
  // mount refuses this fixture's write; path-prefix permission alone must not
  // hide the denial from the syscall audit or the proof classification.
  {
    const stage = '/tmp/cleanup-smoke-proof-abc123/scripts/cleanup-script-smoke/fixtures';
    const trace = [
      `1234  openat(AT_FDCWD, "${stage}/attack.txt", O_WRONLY|O_CREAT|O_TRUNC|O_CLOEXEC, 0666) = -1 EROFS (Read-only file system)`,
      '1234  openat(AT_FDCWD, "/tmp/scratch.txt", O_WRONLY|O_CREAT|O_TRUNC, 0666) = 4',
      '1234  openat(AT_FDCWD, "/evidence/attempt.trace", O_WRONLY|O_CREAT, 0666) = 5',
      '1234  openat(AT_FDCWD, "/tmp/denied-acces.txt", O_WRONLY|O_CREAT, 0666) = -1 EACCES (Permission denied)',
      '1234  mkdir("/tmp/denied-dir", 0777) = -1 EROFS (Read-only file system)',
      '1234  write(20</tmp/denied-fd.txt>, "x", 1) = -1 EACCES (Permission denied)',
    ].join('\n');
    const parsed = parseSyscallTrace(trace);
    const streamed = parseSyscallTraceChunks(
      [...Buffer.from(trace, 'utf8')].map((byte) => Buffer.from([byte])),
    );
    add(
      'streamed native-trace path also retains the denied staged write under /tmp',
      JSON.stringify({
        network: streamed.network,
        write: streamed.write,
        permittedWrites: streamed.permittedWrites,
        execs: streamed.execs,
      }) === JSON.stringify(parsed),
      JSON.stringify({ streamedWrites: streamed.write.length, pureWrites: parsed.write.length }),
    );
    add(
      'read-only staged fixture beneath /tmp retains its denied EROFS write attempt',
      parsed.write.some((line) => line.includes(`${stage}/attack.txt`)) &&
        !parsed.permittedWrites.some((line) => line.includes(`${stage}/attack.txt`)),
      JSON.stringify({ forbidden: parsed.write.length, permitted: parsed.permittedWrites.length }),
    );
    add(
      'denied EACCES open, denied mkdir and denied fd write beneath /tmp are forbidden',
      ['/tmp/denied-acces.txt', '/tmp/denied-dir', '/tmp/denied-fd.txt'].every((path) =>
        parsed.write.some((line) => line.includes(path)),
      ),
      JSON.stringify(parsed.write),
    );
    add(
      'successful /tmp scratch and /evidence trace writes remain permitted',
      ['/tmp/scratch.txt', '/evidence/attempt.trace'].every((path) =>
        parsed.permittedWrites.some((line) => line.includes(path)),
      ) && parsed.permittedWrites.length === 2,
      JSON.stringify(parsed.permittedWrites),
    );
    const classified = classifyAttemptAudit({
      auditOk: true,
      containerResidual: false,
      timedOut: false,
      setupError: false,
      spawnError: null,
      exit: 5,
      entrypointExecuted: true,
      attempts: parsed,
    });
    add(
      'complete audited fixture run with the denied staged write is classified as attempt-audit-write',
      classified.status === 'attempt-audit-write',
      classified.status,
    );
    const noArgs = {
      auditOk: true,
      containerResidual: false,
      timedOut: false,
      setupError: false,
      spawnError: null,
      signal: null,
      exit: 5,
      entrypointExecuted: true,
      attempts: parsed,
    };
    const otherMode = {
      ...noArgs,
      attempts: { network: [], write: [], permittedWrites: [], execs: [] },
    };
    const proofRun = classifyRun(
      { kind: 'entrypoint', rel: 'scripts/cleanup-script-smoke/fixtures/write-attempt.mjs' },
      noArgs,
      otherMode,
      otherMode,
    );
    add(
      'boundary proof classification surfaces the denied staged write through the real smoke classifier',
      proofRun.status === 'attempt-audit-write' && parsed.write.length > 0,
      proofRun.status,
    );
  }

  // ---- 13. context-bound runWithAttemptAudit: verified WorkingDir required ----
  // Drives the ACTUAL runWithAttemptAudit through the own injectable Docker seam
  // (no daemon contacted) and reads a real trace written into the owned evidence
  // dir. The exec proof binds the EXACT absolute native subject AND the INSPECTED
  // actual WorkingDir — an argv/trace claim alone is not proof of `chdir`.
  {
    const fixture = mkdtempSync(join(tmpdir(), 'cleanup-audit-ctx-'));
    mkdirSync(join(fixture, 'apps', 'api', 'scripts'), { recursive: true });
    writeFileSync(
      join(fixture, 'package.json'),
      JSON.stringify({ name: '@probe/root', scripts: { run: 'node apps/api/scripts/tool.mjs' } }),
    );
    writeFileSync(
      join(fixture, 'apps', 'api', 'package.json'),
      JSON.stringify({ name: '@probe/api', scripts: { local: 'node scripts/tool.mjs' } }),
    );
    writeFileSync(join(fixture, 'apps', 'api', 'scripts', 'tool.mjs'), 'process.exit(2);\n');
    const plan = planInvocationContexts(fixture);
    const ctx = plan.contexts.find(
      (c) => c.rel === 'apps/api/scripts/tool.mjs' && c.cwdRel === 'apps/api',
    );
    const subjectDeps = { volume: 'v', completed: true, verifiedLabel: true };
    const expectedCwd = nativeCwdFor('apps/api', { mountedVolume: true, nativeRoot: fixture });
    const nativeSubject = '/src/apps/api/scripts/tool.mjs';

    const spawnFake = (workingDir) => {
      const calls = [];
      let label = '';
      const fn = (cmd, args = []) => {
        calls.push(args[0]);
        if (cmd !== 'docker') return { status: 1, stdout: '', stderr: '' };
        const sub = args[0];
        if (sub === 'create') {
          const ci = args.indexOf('--cidfile');
          if (ci >= 0) {
            try {
              writeFileSync(args[ci + 1], 'a'.repeat(64));
            } catch {
              /* ignore */
            }
          }
          const hit = args.find((x) => String(x).startsWith('cleanup-smoke.run='));
          if (hit) label = String(hit).slice('cleanup-smoke.run='.length);
          return { status: 0, stdout: '', stderr: '' };
        }
        if (sub === 'inspect') {
          const fmt = args[2] ?? '';
          const id = args[args.length - 1];
          if (/Labels/.test(fmt)) return { status: 0, stdout: `${id}|${label}`, stderr: '' };
          if (/WorkingDir/.test(fmt))
            return { status: 0, stdout: JSON.stringify(workingDir), stderr: '' };
          return { status: 1, stdout: '', stderr: `Error: No such container: ${id}` };
        }
        if (sub === 'start' || sub === 'rm') return { status: 0, stdout: '', stderr: '' };
        if (sub === 'wait') return { status: 0, stdout: '2', stderr: '' };
        if (sub === 'logs') return { status: 0, stdout: '', stderr: '' };
        return { status: 1, stdout: '', stderr: '' };
      };
      return { calls, fn };
    };

    const evDir = mkdtempSync(join(tmpdir(), 'cleanup-audit-ev-'));
    writeFileSync(join(evDir, 'noargs.trace'), `${execLine(['node', nativeSubject])}\n`);
    const okFake = spawnFake(expectedCwd);
    const ok = runWithAttemptAudit({
      repoRoot: fixture,
      rel: 'apps/api/scripts/tool.mjs',
      args: [],
      evidenceDir: evDir,
      traceName: 'noargs.trace',
      subjectDeps,
      invocationContext: ctx,
      expectedNativeCwd: expectedCwd,
      _inject: { spawn: okFake.fn, writePrestart: () => {} },
    });
    add(
      'context-bound audit: the exec proof binds the exact absolute native subject and a verified cwd',
      ok.auditOk === true &&
        ok.cwdProofOk === true &&
        ok.entrypointExecuted === true &&
        ok.nativeSubject === nativeSubject,
      JSON.stringify({
        auditOk: ok.auditOk,
        cwdProofOk: ok.cwdProofOk,
        exec: ok.entrypointExecuted,
        nativeSubject: ok.nativeSubject,
      }),
    );

    // A context-bound audit WITHOUT a definite expected cwd is REFUSED even when
    // the raw trace shows the exact absolute subject — it never falls back to the
    // legacy proof. A MISSING or a FAILED WorkingDir proof is likewise refused.
    {
      const evNo = mkdtempSync(join(tmpdir(), 'cleanup-audit-noexpected-'));
      writeFileSync(join(evNo, 'noargs.trace'), `${execLine(['node', nativeSubject])}\n`);

      const noExpectedFake = spawnFake(expectedCwd); // a *correct* inspected cwd, but no expected cwd supplied
      const noExpected = runWithAttemptAudit({
        repoRoot: fixture,
        rel: 'apps/api/scripts/tool.mjs',
        args: [],
        evidenceDir: evNo,
        traceName: 'noargs.trace',
        subjectDeps,
        invocationContext: ctx,
        _inject: { spawn: noExpectedFake.fn, writePrestart: () => {} },
      });
      add(
        'context-bound audit: a MISSING definite expected cwd is REFUSED even though the raw trace shows the subject',
        noExpected.cwdProofOk === false && noExpected.entrypointExecuted === false,
        JSON.stringify({ cwdProofOk: noExpected.cwdProofOk, exec: noExpected.entrypointExecuted }),
      );

      const wrongInspectFake = spawnFake('/src/apps/defense-api'); // a FAILED cwd proof
      const noExpectedFailed = runWithAttemptAudit({
        repoRoot: fixture,
        rel: 'apps/api/scripts/tool.mjs',
        args: [],
        evidenceDir: evNo,
        traceName: 'noargs.trace',
        subjectDeps,
        invocationContext: ctx,
        _inject: { spawn: wrongInspectFake.fn, writePrestart: () => {} },
      });
      add(
        'context-bound audit: a MISSING expected cwd WITH a FAILED inspect proof is REFUSED even though the raw trace shows the subject',
        noExpectedFailed.cwdProofOk === false && noExpectedFailed.entrypointExecuted === false,
        JSON.stringify({
          cwdProofOk: noExpectedFailed.cwdProofOk,
          exec: noExpectedFailed.entrypointExecuted,
        }),
      );

      // A DEFINITE expected cwd but a FAILED WorkingDir proof is likewise refused.
      const badExpectedFake = spawnFake('/src/apps/defense-api');
      const badExpected = runWithAttemptAudit({
        repoRoot: fixture,
        rel: 'apps/api/scripts/tool.mjs',
        args: [],
        evidenceDir: evNo,
        traceName: 'noargs.trace',
        subjectDeps,
        invocationContext: ctx,
        expectedNativeCwd: expectedCwd,
        _inject: { spawn: badExpectedFake.fn, writePrestart: () => {} },
      });
      add(
        'context-bound audit: a DEFINITE expected cwd with a FAILED inspect proof is REFUSED',
        badExpected.cwdProofOk === false && badExpected.entrypointExecuted === false,
        JSON.stringify({
          cwdProofOk: badExpected.cwdProofOk,
          exec: badExpected.entrypointExecuted,
        }),
      );
    }

    const badFake = spawnFake('/src/apps/defense-api');
    const bad = runWithAttemptAudit({
      repoRoot: fixture,
      rel: 'apps/api/scripts/tool.mjs',
      args: [],
      evidenceDir: evDir,
      traceName: 'noargs.trace',
      subjectDeps,
      invocationContext: ctx,
      expectedNativeCwd: expectedCwd,
      _inject: { spawn: badFake.fn, writePrestart: () => {} },
    });
    add(
      'context-bound audit: a MISSING/mismatched WorkingDir proof fails the exec proof',
      bad.cwdProofOk === false && bad.entrypointExecuted === false,
      JSON.stringify({ cwdProofOk: bad.cwdProofOk, exec: bad.entrypointExecuted }),
    );

    writeFileSync(
      join(evDir, 'foreign.trace'),
      `${execLine(['node', `/other${nativeSubject}`])}\n`,
    );
    const foreignFake = spawnFake(expectedCwd);
    const foreign = runWithAttemptAudit({
      repoRoot: fixture,
      rel: 'apps/api/scripts/tool.mjs',
      args: [],
      evidenceDir: evDir,
      traceName: 'foreign.trace',
      subjectDeps,
      invocationContext: ctx,
      expectedNativeCwd: expectedCwd,
      _inject: { spawn: foreignFake.fn, writePrestart: () => {} },
    });
    add(
      'context-bound audit: a same-suffix FOREIGN-prefix subject in the trace is REJECTED',
      foreign.cwdProofOk === true && foreign.entrypointExecuted === false,
      JSON.stringify({ exec: foreign.entrypointExecuted, nativeSubject: foreign.nativeSubject }),
    );

    const nullFake = spawnFake(expectedCwd);
    const refused = runWithAttemptAudit({
      repoRoot: fixture,
      rel: 'apps/api/scripts/tool.mjs',
      args: [],
      evidenceDir: evDir,
      traceName: 'noargs.trace',
      subjectDeps,
      invocationContext: null,
      expectedNativeCwd: expectedCwd,
      _inject: { spawn: nullFake.fn, writePrestart: () => {} },
    });
    add(
      'context-bound audit: an explicitly NULL context is refused and never executed',
      refused.invocationContextRejected === true &&
        refused.entrypointExecuted === false &&
        refused.cwdProofOk === false,
      JSON.stringify({
        rejected: refused.invocationContextRejected,
        exec: refused.entrypointExecuted,
      }),
    );
  }

  // ---- 14. syscall data is not a network operation -------------------------
  // Native6278 read verifier fixtures and transported git diff text over UNIX
  // pipes. The quoted contents included socket/connect examples; those bytes
  // must remain hashed without becoming an invented network syscall.
  {
    const payload = quote(
      'socket(AF_INET, SOCK_STREAM, IPPROTO_IP); connect(3, {sa_family=AF_INET, sin_addr=inet_addr("127.0.0.1")}, 16)',
    );
    const dataLines = [
      `10 read(18</source/attempt-audit-controls.mjs>, ${payload}, 8192) = 200`,
      `22 write(1<UNIX:[3232544->3232543]>, ${payload}, 200) = 200`,
      `10 <... read resumed>${payload}, 8192) = 200`,
      `recvfrom(3<UNIX:[1234]>, ${payload}, 8192, 0, NULL, NULL) = 200`,
      `sendto(3<UNIX:[1234]>, ${payload}, 200, 0, NULL, 0) = 200`,
      `77 read(18</source/test.mjs>, ${payload}, 8192 <unfinished ...>`,
      '77 <... read resumed>) = 200',
    ];
    const trace = dataLines.join('\n') + '\n';
    const bytes = Buffer.from(trace);
    const parsed = parseSyscallTraceChunks([...bytes].map((b) => Buffer.from([b])));
    add(
      'network audit ignores source and UNIX payload examples, including resumed reads',
      parsed.network.length === 0,
      JSON.stringify(parsed.network),
    );
    add(
      'payload classification retains the exact streamed raw hash and bytes',
      parsed.bytes === bytes.length &&
        parsed.sha256 === createHash('sha256').update(bytes).digest('hex'),
      'all original bytes retained',
    );

    const actualLines = [
      'socket(AF_INET, SOCK_STREAM, IPPROTO_IP) = 3',
      '42 socket(AF_INET6, SOCK_STREAM, IPPROTO_IP) = -1 EACCES (Permission denied)',
      '[pid 43] connect(3, {sa_family=AF_INET, sin_port=htons(80), sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ENETUNREACH (Network is unreachable)',
      `44 sendto(3, ${payload}, 200, 0, {sa_family=AF_INET, sin_addr=inet_addr("127.0.0.1")}, 16) = -1 ENETUNREACH (Network is unreachable)`,
      '45 sendmsg(3, {msg_name={sa_family=AF_INET6, sin6_addr=inet_pton(AF_INET6, "::1")}}, 0) = -1 EACCES (Permission denied)',
      `46 recvfrom(3, ${payload}, 200, 0, {sa_family=AF_INET, sin_addr=inet_addr("127.0.0.1")}, [16]) = 200`,
      '[pid 47] connect(3, {sa_family=AF_INET6, sin6_addr=inet_pton(AF_INET6, "::1")}, 28 <unfinished ...>',
      '[pid 47] <... connect resumed>) = -1 ENETUNREACH (Network is unreachable)',
      '48 socket(AF_INET, SOCK_DGRAM, IPPROTO_IP <unfinished ...>',
    ];
    const actualBytes = Buffer.from(actualLines.join('\n') + '\n');
    for (const size of [1, 3, 13, 257, actualBytes.length]) {
      const chunks = [];
      for (let i = 0; i < actualBytes.length; i += size)
        chunks.push(actualBytes.subarray(i, i + size));
      const actual = parseSyscallTraceChunks(chunks);
      add(
        `genuine network attempts survive syscall header formats, quoted data, resumed calls and EOF (chunk ${size})`,
        actual.network.length === 8,
        JSON.stringify({ count: actual.network.length }),
      );
    }
  }

  const failed = checks.filter((c) => !c.ok);
  return {
    module: 'attempt-audit-controls',
    checks,
    passed: checks.length - failed.length,
    total: checks.length,
    ok: failed.length === 0,
  };
}

export { runControls as runAttemptAuditControls };

if (process.argv[1]?.endsWith('attempt-audit-controls.mjs')) {
  const r = runControls();
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
