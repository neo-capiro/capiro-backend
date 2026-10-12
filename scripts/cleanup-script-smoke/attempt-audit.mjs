/**
 * CleanUp1 §6.2 — genuine denied syscall / attempt audit.
 *
 * isolation.mjs only inspects the container's stdout/stderr for a denial errno.
 * That is a heuristic SIGNAL, not an audit: a script that CATCHES the denial and
 * exits cleanly emits nothing, so the signal reports no attempt. This module
 * observes the SYSCALLS: the entry point runs under `strace -f` inside the SAME
 * kernel boundary (`--network none`, `--read-only`), and the trace is parsed for
 * attempted-but-denied syscalls —
 *
 *   network  — an AF_INET/AF_INET6 socket created and/or connect/send* issued
 *              toward an inet address (loopback included: `--network none` gives
 *              no route, so every reach is an attempt);
 *   write    — an open/openat for write (`O_WRONLY|O_RDWR|O_CREAT|O_TRUNC`) or a
 *              mkdir/rename/unlink/truncate refused by the read-only mount
 *              (EROFS/EACCES/EPERM/EBADF) to a FORBIDDEN path (outside the owned
 *              disposable writable proof area).
 *
 * A caught/suppressed attempt is STILL recorded here, so it cannot pass.
 * `strace -f` follows child processes, so imported modules and child-process
 * attempts are traced too.
 *
 * Precise permitted/forbidden distinction: writes confined to the explicitly
 * owned disposable area (`/tmp` tmpfs, the mounted `/evidence` proof dir, and
 * the kernel `/dev`/`/proc`/`/sys` pseudo-filesystems) are the DOCUMENTED
 * permitted runtime artefacts and are recorded separately (`permittedWrites`),
 * never as failures when they succeed. A refused EROFS/EACCES/EPERM/EBADF
 * write is an attempted forbidden write even if its path starts with /tmp: the
 * read-only tracked-source proof stage can itself be mounted below /tmp.
 * Successful offline writes inside the owned disposable area remain permitted.
 *
 * The `-qq` trace can SPLIT a syscall across two lines
 * (`openat(... <unfinished ...>` / `... <openat resumed> ) = -1 EROFS`); those
 * are rejoined before classification, and an unfinished syscall is never
 * silently dropped.
 *
 * The trace runs with `-s 65535` so LONG arguments (a full TS subject path and
 * its mode argv) are recorded verbatim; strace's default 32-byte string limit
 * truncated them and made the exact subject/argument check unprovable.
 *
 * Linux-only tooling: `strace` is staged in an image built from Dockerfile.audit
 * in THIS directory (build context = this harness only; no host credential or
 * config directory is ever added). If the image or trace is unavailable the
 * audit FAILS CLOSED (`attempt-audit-unavailable`) — it never silently downgrades
 * to the stderr signal.
 *
 * Boundary note: tracing children needs ptrace, so ONLY this audit run relaxes
 * seccomp and adds SYS_PTRACE. Network and filesystem containment stay
 * kernel-enforced via `--network none` / `--read-only`; no host tree is mounted
 * (the audit reuses isolation.mjs's stage-plus-evidence-only mounts).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, openSync, readSync, writeSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runIsolated, dockerAvailable, TSX_TSCONFIG_FLAG } from './isolation.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const AUDIT_IMAGE = process.env.CLEANUP_SMOKE_AUDIT_IMAGE ?? 'cleanup-smoke-audit:local';
export const AUDIT_DOCKERFILE = join(HERE, 'Dockerfile.audit');
export const DEFAULT_TRACE_NAME = 'attempt.trace';

/**
 * The strace wrapper argv used for EVERY audited invocation. `-f` follows child
 * processes, `-yy` decodes fds to paths, `-qq` suppresses startup chatter, and
 * `-s 65535` keeps the FULL execve argv — the long TS subject path and every mode
 * argument — verbatim in the trace (the default 32-byte string limit truncated
 * them and made the exact subject/argument proof impossible).
 */
export function straceAttemptWrapper(traceName = DEFAULT_TRACE_NAME) {
  return [
    'strace',
    '-f',
    '-yy', // decode fd -> path so write(fd</path>, …) carries its file target
    '-qq',
    '-s',
    '65535',
    '-e',
    'trace=%network,%file,%desc',
    '-o',
    `/evidence/${traceName}`,
  ];
}

/** The owned disposable writable area — writes here are the permitted artefacts. */
export const PERMITTED_WRITE_PREFIXES = ['/tmp', '/evidence', '/dev', '/proc', '/sys', '/run'];

export function auditImagePresent(image = AUDIT_IMAGE) {
  const r = spawnSync('docker', ['image', 'inspect', image], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return r.status === 0;
}

/** Ensure the strace-bearing audit image exists; build it from the harness dir. */
export function ensureAuditImage(image = AUDIT_IMAGE) {
  if (!dockerAvailable()) return { ok: false, reason: 'docker-unavailable' };
  if (auditImagePresent(image)) return { ok: true, built: false, image };
  const r = spawnSync('docker', ['build', '-t', image, '-f', AUDIT_DOCKERFILE, HERE], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0) {
    return {
      ok: false,
      reason: 'audit-image-build-failed',
      stderr: `${r.stderr ?? ''}`.slice(0, 400),
    };
  }
  return { ok: true, built: true, image };
}

/**
 * The canonical line-joiner for `strace -qq -f` output. It re-joins syscall lines
 * that were split with `<unfinished ...>` / `<... resumed>` markers, keeping the
 * PENDING syscall state in a Map that MUST persist across line/chunk boundaries (so
 * an unfinished/resumed pair split across two reads is still rejoined). It is the
 * ONE place that owns the join rules; the pure string API and the streaming reader
 * both drive it, so there is no second parser to diverge.
 *
 * `onLine(raw)` returns the joined line to classify, or `null` when the line was a
 * deferred `<unfinished ...>` opener (buffered) — matching the original join where an
 * unfinished line produced no output. `drain()` emits every still-pending unfinished
 * syscall at EOF (never dropped).
 */
function createSyscallLineJoiner() {
  const pending = new Map(); // `${pid}|${syscall}` -> prefix
  const onLine = (raw) => {
    if (!raw) return null;
    const pid = (/^\s*(?:\[pid\s+)?(\d+)/.exec(raw) || [])[1] ?? '0';
    const unfinished = /^(.*)<unfinished \.\.\.\s*>?\s*$/.exec(raw);
    if (unfinished) {
      const sys = /\b([a-z_][a-z0-9_]*)\(/.exec(unfinished[1]);
      pending.set(
        `${pid}|${sys ? sys[1] : '?'}`,
        unfinished[1].replace(/<unfinished \.\.\..*$/, ''),
      );
      return null;
    }
    const resumed = /^(.*)<\.\.\. (\w+) resumed>(.*)$/.exec(raw);
    if (resumed) {
      const key = `${pid}|${resumed[2]}`;
      const pre = pending.get(key);
      if (pre != null) {
        pending.delete(key);
        return `${pre}${resumed[3]}`;
      }
    }
    return raw;
  };
  const drain = () => [...pending.values()].map((v) => `${v}<unfinished ...>`);
  return { onLine, drain };
}

/**
 * Rejoin syscall lines that `strace -qq -f` split with `<unfinished ...>` /
 * `<... resumed>` markers, so no attempt is lost to a line break.
 */
export function joinSplitSyscallLines(traceText) {
  const joiner = createSyscallLineJoiner();
  const out = [];
  for (const raw of String(traceText).split('\n')) {
    const line = joiner.onLine(raw);
    if (line !== null) out.push(line);
  }
  for (const line of joiner.drain()) out.push(line);
  return out;
}

// Only the syscall header and address arguments describe an attempted network
// operation. read/write payloads can contain source text such as socket(AF_INET),
// and even a real AF_UNIX recvfrom can carry that same text as quoted data.
const NET_SYSCALL = /^\s*(?:(?:\d+|\[pid\s+\d+\])\s+)?(?:socket|connect|sendto|sendmsg|recvfrom)\(/;
const NET_ADDRESS = /(?:\bAF_INET6?\b|\binet_addr\(|\bsin6?_addr\b)/;
const TRACE_QUOTED_STRING = /"(?:\\.|[^"\\])*"/g;
function isNetworkAttempt(line) {
  return NET_SYSCALL.test(line) && NET_ADDRESS.test(line.replace(TRACE_QUOTED_STRING, '""'));
}
const OPEN_WRITE = /^\s*(?:\d+\s+)?(openat|open|creat)\(/;
const MODIFY_DENIED =
  /^\s*(?:\d+\s+)?(mkdir|mkdirat|rename|renameat|renameat2|unlink|unlinkat|truncate|ftruncate|chmod|chown|link|linkat|symlink|symlinkat)\([^\n]*\)\s*=\s*-1\s+E(?:ROFS|ACCES|PERM|BADF)/;
const OPEN_WRITE_FLAGS = /O_(?:WRONLY|RDWR|CREAT|TRUNC)/;
const DENIED = /\)\s*=\s*-1\s+E(?:ROFS|ACCES|PERM|BADF)\b/;
const EXECVE = /(?:^|\s)(?:execve|execveat)\(/;

/** First quoted path argument of an open/openat line, or null. */
function openPath(line) {
  const m = /"(\\?[^"]*)"/.exec(line);
  return m ? m[1] : null;
}

/**
 * Lexically canonicalize a POSIX path — resolve `.` and `..` WITHOUT touching
 * the filesystem. `/tmp/../source` -> `/source`. This closes the prefix-traversal
 * escape root smoke review round 2 reproduced: an open of
 * `/tmp/../c/dev/.../stage/blocked.txt` starts with `/tmp/` but actually targets
 * the read-only source stage, so it must NOT be treated as a permitted /tmp write.
 */
export function canonicalizeLexical(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  const abs = p.startsWith('/');
  const out = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  return abs ? `/${joined}` : joined.length ? joined : '.';
}

function isPermittedPath(p, prefixes) {
  if (!p) return false;
  const c = canonicalizeLexical(p);
  return prefixes.some((pre) => c === pre || c.startsWith(pre.endsWith('/') ? pre : `${pre}/`));
}

/** fd-based write syscalls whose target is bound by an fd (or inline `<path>`). */
const WRITE_FD =
  /^\s*(?:\d+\s+)?(?:write|writev|pwrite|pwrite64|pwritev|ftruncate)\((\d+)(?:<([^>]*)>)?/;
/** Any write-family syscall (fd- or path-based); used to skip unbindable writes. */
const WRITE_FAMILY = /^\s*(?:\d+\s+)?(?:write|writev|pwrite|pwrite64|pwritev|ftruncate|truncate)\(/;

/**
 * The ONE canonical classification core. It consumes ALREADY-JOINED syscall lines
 * (via `onLine`) and accumulates attempted network / forbidden-write lines, the
 * permitted disposable-area writes, and execve lines. `finish()` emits every
 * still-pending unfinished syscall and returns the arrays. Because the joiner (and
 * therefore this accumulator) is fed line-by-line, the pending syscall state and the
 * result arrays span arbitrary chunk boundaries: no whole trace is ever held as a
 * string or a single Buffer.
 */
export function createTraceAccumulator({ permittedPrefixes = PERMITTED_WRITE_PREFIXES } = {}) {
  const network = [];
  const write = [];
  const permittedWrites = [];
  const execs = [];
  const record = (list, line) => list.push(line.trim());
  const joiner = createSyscallLineJoiner();

  const classify = (line) => {
    if (!line) return;
    if (EXECVE.test(line)) execs.push(line.trim());
    if (isNetworkAttempt(line)) {
      network.push(line.trim());
      return;
    }
    // open/openat/creat: classify a write-open. A forbidden write-open is an
    // ATTEMPT whether or not the mount denied it.
    if (OPEN_WRITE.test(line)) {
      const path = openPath(line);
      if (OPEN_WRITE_FLAGS.test(line) || /\bcreat\(/.test(line)) {
        // A denied open is not a permitted scratch write. In particular, the
        // read-only proof source is staged beneath /tmp on Linux; its EROFS
        // attempt must remain visible as a forbidden write.
        if (isPermittedPath(path, permittedPrefixes) && !DENIED.test(line))
          record(permittedWrites, line);
        else record(write, line);
      }
      return;
    }
    // mkdir/rename/unlink/truncate/... refused by the read-only mount.
    if (MODIFY_DENIED.test(line)) {
      record(write, line);
      return;
    }
    // write/writev/pwrite/ftruncate: only an fd EXPLICITLY annotated with a file
    // path (`write(20</path>, …)`) is a filesystem write. A bare numeric fd
    // (pipes, IPC, eventfd — e.g. the esbuild service channel) cannot be resolved
    // to a file and MUST NOT be attributed to a path, especially because fd
    // numbers are reused after close. An annotated write to a FORBIDDEN path is a
    // failure even when it fails EBADF/EROFS.
    const wf = WRITE_FD.exec(line);
    if (wf) {
      const inline = wf[2] ?? '';
      if (inline && inline.startsWith('/')) {
        const target = canonicalizeLexical(inline);
        if (isPermittedPath(target, permittedPrefixes) && !DENIED.test(line))
          record(permittedWrites, line);
        else record(write, line);
      }
      return;
    }
    if (WRITE_FAMILY.test(line)) return; // unbindable write (no file path)
  };

  const onLine = (raw) => {
    const line = joiner.onLine(raw);
    if (line !== null) classify(line);
  };
  const finish = () => {
    for (const line of joiner.drain()) classify(line);
    return { network, write, permittedWrites, execs };
  };
  return { onLine, finish };
}

/**
 * Synchronous streaming trace reader. It reads from `readChunk(n)` — a function
 * returning the next Buffer (up to `n` bytes) or a null/empty Buffer at EOF — in
 * FIXED-SIZE buffers, streams the raw SHA256 and byte count chunk-by-chunk WITHOUT
 * ever building a full copy of the file, and incrementally UTF8-decodes with a
 * StringDecoder so a multibyte character split across two reads is decoded exactly
 * as `Buffer.toString('utf8')` would for the complete file. Complete decoded lines
 * are fed to the canonical accumulator; a partial trailing line is buffered until its
 * newline arrives and the final (possibly unterminated) line is processed at EOF.
 *
 * Returns `{ sha256, bytes, network, write, permittedWrites, execs }`. It reads every
 * byte of the stream; an empty stream yields `bytes: 0` with empty arrays, which the
 * callers treat as fail-closed. It never throws on content (only a throwing
 * `readChunk`/producer does).
 */
export function parseSyscallTraceStream(
  readChunk,
  { permittedPrefixes = PERMITTED_WRITE_PREFIXES, chunkSize = 1 << 20, onChunk = null } = {},
) {
  const hash = createHash('sha256');
  const decoder = new StringDecoder('utf8');
  const acc = createTraceAccumulator({ permittedPrefixes });
  let bytes = 0;
  let text = '';
  const feed = (decoded) => {
    if (!decoded) return;
    text += decoded;
    let idx;
    while ((idx = text.indexOf('\n')) !== -1) {
      const line = text.slice(0, idx);
      text = text.slice(idx + 1);
      acc.onLine(line);
    }
  };
  for (;;) {
    const chunk = readChunk(chunkSize);
    if (chunk === null || chunk === undefined) break;
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buf.length === 0) break;
    hash.update(buf);
    bytes += buf.length;
    // An optional per-chunk consumer may stream the RAW bytes elsewhere (a bounded
    // copy) WITHOUT the whole trace ever being materialised as a Buffer/string.
    if (typeof onChunk === 'function') onChunk(buf);
    feed(decoder.write(buf));
  }
  feed(decoder.end());
  if (text.length > 0) acc.onLine(text);
  return { sha256: hash.digest('hex'), bytes, ...acc.finish() };
}

/**
 * Drive the streaming core from an in-memory list of Buffers, so controls can prove
 * parser equivalence under SMALL chunk sizes (multibyte-split, unfinished/resumed
 * split, etc.) without any file I/O. Returns the same shape as
 * `parseSyscallTraceStream`.
 */
export function parseSyscallTraceChunks(chunks, opts = {}) {
  const arr = Array.isArray(chunks) ? chunks : [...chunks];
  let i = 0;
  return parseSyscallTraceStream(() => (i < arr.length ? arr[i++] : null), opts);
}

/**
 * Read a raw strace file END-TO-END in fixed-size buffers and parse it, returning the
 * raw SHA256, the byte count and the parsed arrays. It streams the hash and byte count
 * and NEVER materialises the whole trace as a Buffer or a string — this is the fix for
 * `Cannot create a string longer than 0x1fffffe8 characters` on a hundreds-of-MB
 * trace. A missing/unreadable path throws (from `openSync`), so callers stay
 * fail-closed; an existing-but-empty file returns `bytes: 0`.
 */
export function readAndParseTraceFileSync(
  path,
  { permittedPrefixes = PERMITTED_WRITE_PREFIXES, chunkSize = 1 << 20 } = {},
) {
  const fd = openSync(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(Math.max(1, chunkSize));
    const readChunk = (size) => {
      const want = Math.min(size, buf.length);
      const n = readSync(fd, buf, 0, want, null);
      if (n <= 0) return null;
      return buf.subarray(0, n);
    };
    return parseSyscallTraceStream(readChunk, { permittedPrefixes, chunkSize });
  } finally {
    closeSync(fd);
  }
}

/**
 * Stream a raw strace file into an OWNED destination while SIMULTANEOUSLY hashing
 * its bytes (the EXACT copied bytes) and parsing it through the ONE canonical
 * accumulator — WITHOUT ever materialising the whole trace as a Buffer or a UTF8
 * string. This is the production trace path: a >512MiB trace is copied in bounded
 * chunks, hashed losslessly, and parsed in the SAME single pass (the parsed
 * noargs trace is reused for the result audit rather than re-read; see the
 * emitter). The destination is written with the exclusive `wx` flag so a prior
 * artifact is NEVER overwritten. A missing/unreadable source throws (from
 * `openSync`), so callers stay fail-closed; an existing-but-empty source yields
 * `bytes: 0` (empty arrays) which the callers treat as fail-closed.
 *
 * Returns `{ sha256, bytes, network, write, permittedWrites, execs }` where
 * `sha256`/`bytes` are over the EXACT bytes written to `destPath`.
 */
export function copyAndParseTraceFileSync(
  srcPath,
  destPath,
  { permittedPrefixes = PERMITTED_WRITE_PREFIXES, chunkSize = 1 << 20 } = {},
) {
  const inFd = openSync(srcPath, 'r');
  let outFd = null;
  try {
    outFd = openSync(destPath, 'wx');
    const buf = Buffer.allocUnsafe(Math.max(1, chunkSize));
    const readChunk = (size) => {
      const want = Math.min(size, buf.length);
      const n = readSync(inFd, buf, 0, want, null);
      if (n <= 0) return null;
      return buf.subarray(0, n);
    };
    const res = parseSyscallTraceStream(readChunk, {
      permittedPrefixes,
      chunkSize,
      onChunk: (chunk) => {
        let off = 0;
        while (off < chunk.length) off += writeSync(outFd, chunk, off, chunk.length - off);
      },
    });
    return res;
  } finally {
    if (outFd !== null) closeSync(outFd);
    closeSync(inFd);
  }
}

/**
 * Parse an strace trace (STRING API — preserved unchanged for every existing
 * caller/test) into attempted network / forbidden-write syscall lines, separated
 * from permitted disposable-area writes. Also reports whether the entry point's
 * interpreter actually exec'd (loader-only is not proof). This delegates to the ONE
 * canonical accumulator, so the string and streaming paths can never diverge.
 *
 * Writes are audited across the whole write family — open-for-write, write,
 * writev, pwrite, ftruncate and the refused mkdir/rename/unlink/truncate set —
 * with fd targets bound to their path from the opening syscall (or the inline
 * `fd<path>` strace annotation). A write to a FORBIDDEN target is recorded even
 * when it failed (EROFS for a source open, EBADF for a write to a read-only
 * source fd) — an attempted source write is a failure, not a silent no-op.
 */
export function parseSyscallTrace(
  traceText,
  { permittedPrefixes = PERMITTED_WRITE_PREFIXES } = {},
) {
  const acc = createTraceAccumulator({ permittedPrefixes });
  for (const raw of String(traceText).split('\n')) acc.onLine(raw);
  return acc.finish();
}

/** Tokenize the argv vector inside an strace `execve("…", [ … ], …)` — respecting
 *  double quotes and backslash escapes so commas/spaces INSIDE a string are not
 *  separators. Returns the unquoted tokens. */
function parseStraceArgvVector(inner) {
  const out = [];
  let cur = '';
  let inStr = false;
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inStr) {
      if (ch === '\\') {
        const n = inner[i + 1];
        if (n !== undefined) {
          cur += n;
          i++;
        }
        continue;
      }
      if (ch === '"') {
        inStr = false;
        continue;
      }
      cur += ch;
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === ',') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  out.push(cur.trim());
  return out.filter((x) => x.length > 0);
}

const TS_LOADER = /(^|\/)tsx\/dist\/cli\.mjs$/;

/**
 * True iff the trace shows the SUBJECT actually exec'd with EXACTLY the mode's
 * arguments. Root round-15 hardening:
 *  - the execve must have SUCCEEDED (`= 0`), never a failed `= -1` attempt;
 *  - the argv is parsed with a quote/escape-aware tokenizer (commas or escaped
 *    quotes inside a string are NOT separators);
 *  - the subject invocation's argv suffix must equal `[subject, ...args]` IN ORDER
 *    with EXACT length — `node <subject> --different-mode` cannot prove a no-args
 *    run, and `node --help` (no subject) is never proof;
 *  - the TS loader (`node <tsx cli> <subject> …`) is tolerated;
 *  - the subject is accepted as the repo-relative path or its normalized absolute
 *    container path.
 *
 * Runtime-config binding: the caller MAY supply a `runtimeConfig` and/or a
 * `loader`, which is the "modern" path. The presence of EITHER parameter — even
 * when BOTH are explicitly `null` — selects the STRICT branch. Strict proof
 * requires the argv to be EXACTLY `node <loader?> --tsconfig <runtimeConfig?>
 * <subject> <...args>`:
 *   - the loader token must EQUAL the expected loader (a substituted loader fails),
 *     and when the loader is expected ABSENT an unexpected loader fails;
 *   - when the config is expected, the flag must be the exact `--tsconfig` token
 *     immediately followed by the exact bound config (a missing / wrong / escaping
 *     config, an `=`-form or a DUPLICATE config flag fails); when the config is
 *     expected ABSENT (`null`) an unexpected config token fails;
 *   - no arbitrary prefix flag is tolerated (any leading flag shifts the subject and
 *     fails the exact-length check);
 *   - extra / reordered / absent mode args fail the exact-length / order check.
 * A caller that supplies NEITHER `runtimeConfig` NOR `loader` (both `undefined`,
 * the LEGACY read-only evidence re-parsers) keeps ONLY the ORIGINAL tolerated
 * shape: `node` + an OPTIONAL tsx loader + the exact subject + the exact args.
 * The legacy branch NEVER tolerates or strips an unbound `--tsconfig` (neither the
 * `--tsconfig <cfg>` pair nor the `--tsconfig=<cfg>` form) — an unbound config
 * token is a REFUSAL, so a wrong/unbound config can never be accepted.
 */
export function entrypointExecutedFromTrace(
  parsed,
  {
    subject = null,
    args = [],
    runtimeConfig = undefined,
    loader = undefined,
    nativeSubject = undefined,
  } = {},
) {
  const execs = parsed?.execs ?? [];
  if (!subject) return false; // no subject identity to confirm against ⇒ not proof
  const want = String(subject)
    .split('\\')
    .join('/')
    .replace(/^\.?\//, '');
  if (!want) return false;
  const wantedArgs = (args ?? []).map((a) => String(a));
  const expected = [want, ...wantedArgs];

  const norm = (t) => String(t).split('\\').join('/');
  // An EXPLICITLY BOUND absolute native subject path (context-bound execution):
  // the trace must name that EXACT path — NEVER a suffix-only match, so a
  // wrong-prefix same-suffix path (`/other/<nativeSubject>`) is refused.
  // `undefined` is the ONLY value that preserves the legacy (repo-relative /
  // suffix-tolerant) reparse. An explicitly supplied `null`, empty string,
  // non-string or RELATIVE path is an INVALID bound subject and REFUSES: an
  // invalid explicit option is never silently downgraded to the legacy match.
  const nativeBound = nativeSubject !== undefined;
  const boundNative = nativeBound ? norm(nativeSubject) : null;
  const nativeSubjectValid =
    !nativeBound ||
    (typeof nativeSubject === 'string' &&
      nativeSubject.length > 0 &&
      norm(nativeSubject).startsWith('/'));
  if (nativeBound && !nativeSubjectValid) return false;
  const matchesSubject = (token) => {
    const t = norm(token);
    if (nativeBound) return t === boundNative;
    return t === want || t.endsWith('/' + want);
  };
  // A runtime plan is "supplied" when the caller passed EITHER parameter — even an
  // explicit `null`. Only a caller that passed NEITHER takes the legacy branch.
  const planSupplied = runtimeConfig !== undefined || loader !== undefined;
  const cfg = runtimeConfig == null ? null : norm(runtimeConfig);
  const ld = loader == null ? null : norm(loader);
  const strict = planSupplied;
  const isConfigToken = (t) =>
    t === TSX_TSCONFIG_FLAG || String(t).startsWith(`${TSX_TSCONFIG_FLAG}=`);

  const exactTail = (rest) => {
    if (rest.length !== expected.length) return false; // EXACT length: no extra/absent/prefix flag
    if (!matchesSubject(rest[0])) return false;
    for (let i = 1; i < expected.length; i++) if (rest[i] !== expected[i]) return false;
    return true;
  };

  for (const line of execs) {
    if (!/\)\s*=\s*0\s*$/.test(line)) continue; // successful execve only (not `= -1`)
    const m =
      /execve\([^,]*,\s*\[([\s\S]*?)\]\s*,/.exec(line) ||
      /execve\([^,]*,\s*\[([\s\S]*?)\]/.exec(line);
    if (!m) continue;
    const argv = parseStraceArgvVector(m[1]);
    if (argv.length === 0) continue;
    if (!/(^|\/)node(\.exe)?$/.test(argv[0])) continue; // the interpreter must be node
    let rest = argv.slice(1);

    // A DUPLICATE config flag is never proof, on either path.
    if (rest.filter(isConfigToken).length > 1) continue;

    if (!strict) {
      // LEGACY shape (read-only evidence re-parsers pass NO runtime plan).
      // An UNBOUND --tsconfig (pair or `=`-form) is a REFUSAL — never stripped.
      if (rest.some(isConfigToken)) continue;
      if (rest.length > 0 && TS_LOADER.test(rest[0])) rest = rest.slice(1); // tolerate tsx cli
      if (exactTail(rest)) return true;
      continue;
    }

    // STRICT: the exact bound runtime plan must be present (explicit null selected strict).
    let i = 0;
    if (ld !== null) {
      if (norm(rest[0]) !== ld) continue; // substituted / missing loader is not proof
      i = 1;
    } else if (rest.length > 0 && TS_LOADER.test(rest[0])) {
      continue; // a loader was expected absent but one is present — substituted loader
    }
    if (cfg !== null) {
      if (rest[i] !== TSX_TSCONFIG_FLAG || norm(rest[i + 1]) !== cfg) continue; // missing/wrong/escaping/=-form config
      i += 2;
    } else if (rest.some(isConfigToken)) {
      continue; // no config expected but one is present
    }
    if (exactTail(rest.slice(i))) return true;
  }
  return false;
}

export function classifyAttemptAudit(res) {
  if (!res) {
    return { status: 'attempt-audit-unavailable', reasons: ['no audit result'] };
  }
  if (!res.auditOk) {
    return {
      status: 'attempt-audit-unavailable',
      reasons: [res.auditReason ?? 'audit unavailable'],
    };
  }
  if (res.containerResidual) {
    return {
      status: 'attempt-audit-container-residual',
      reasons: ['owned container was not terminated'],
    };
  }
  if (res.timedOut) {
    return {
      status: 'attempt-audit-timeout',
      reasons: ['entry point did not terminate — audit incomplete'],
    };
  }
  if (res.spawnError) {
    return { status: 'attempt-audit-spawn-error', reasons: [res.spawnError] };
  }
  if (res.setupError) {
    return {
      status: 'setup-incompatibility',
      reasons: ['tool/module unavailable in isolated runtime'],
    };
  }
  if (!Number.isInteger(res.exit)) {
    // A signal/null/partial exit is NOT a completed run — a nonempty trace here
    // is not entrypoint proof.
    return {
      status: 'attempt-audit-no-definite-exit',
      reasons: [
        `no definite integer exit (status=${JSON.stringify(res.exit)} signal=${JSON.stringify(res.signal)})`,
      ],
    };
  }
  if (!res.entrypointExecuted) {
    return {
      status: 'attempt-audit-loader-only',
      reasons: ['trace shows only the loader, not the entry point'],
    };
  }
  if (res.attempts.network.length) {
    return {
      status: 'attempt-audit-network',
      reasons: [`network attempt(s): ${res.attempts.network.length}`],
    };
  }
  if (res.attempts.write.length) {
    return {
      status: 'attempt-audit-write',
      reasons: [`forbidden write attempt(s): ${res.attempts.write.length}`],
    };
  }
  return { status: 'ok', reasons: [] };
}

/**
 * Run one entry point under the strace audit inside the real boundary.
 * Requires `evidenceDir` so the syscall trace can be read back off the host.
 * `traceName` lets a single invocation set (noargs/help/unknown) keep distinct,
 * non-stale traces in one evidence dir.
 *
 * The runtime config the runner actually selected (`runtimeConfig` / `tsxLoader`
 * on the run result) is threaded into the exec proof so the trace must show the
 * EXACT bound command. A caller MAY supply the expected config/loader
 * (`expectedRuntimeConfig` / `expectedTsxLoader`); when supplied they MUST equal
 * the selected values — a mismatch is fail-closed (`runtimeConfigMatch:false`) and
 * never counts as executed proof.
 */
export function runWithAttemptAudit({
  repoRoot,
  rel,
  args = [],
  timeoutMs = 30000,
  evidenceDir,
  image = AUDIT_IMAGE,
  traceName = DEFAULT_TRACE_NAME,
  tsRuntime = null,
  subjectDeps = null,
  expectedRuntimeConfig = undefined,
  expectedTsxLoader = undefined,
  invocationContext = undefined,
  expectedNativeCwd = undefined,
  _inject = null,
} = {}) {
  const wrapper = straceAttemptWrapper(traceName);
  const extraDockerArgs = ['--cap-add', 'SYS_PTRACE', '--security-opt', 'seccomp=unconfined'];
  const run = runIsolated({
    repoRoot,
    rel,
    args,
    timeoutMs,
    evidenceDir,
    image,
    wrapper,
    extraDockerArgs,
    tsRuntime,
    subjectDeps,
    invocationContext,
    _inject,
  });
  let attempts = { network: [], write: [], permittedWrites: [], execs: [] };
  let traceBytes = 0;
  try {
    // Stream the raw trace end-to-end: hash + byte count + parse in fixed-size buffers,
    // never a whole-file Buffer or UTF8 string (a >512MB trace previously threw
    // `Cannot create a string longer than 0x1fffffe8 characters` and was mis-read as
    // an EMPTY trace). A missing/unreadable trace stays fail-closed (auditOk:false).
    const streamed = readAndParseTraceFileSync(join(run.evidenceDir, traceName));
    attempts = {
      network: streamed.network,
      write: streamed.write,
      permittedWrites: streamed.permittedWrites,
      execs: streamed.execs,
    };
    traceBytes = streamed.bytes;
  } catch {
    attempts = { network: [], write: [], permittedWrites: [], execs: [] };
    traceBytes = 0;
  }
  const auditOk = traceBytes > 0; // no trace bytes ⇒ strace never ran ⇒ fail closed
  // The expected config, when the caller supplies one, must equal the config the
  // runner actually selected+bound — otherwise the proof is refused.
  const runtimeConfig = run.runtimeConfig ?? null;
  const tsxLoader = run.tsxLoader ?? null;
  const runtimeConfigMatch =
    (expectedRuntimeConfig === undefined || expectedRuntimeConfig === runtimeConfig) &&
    (expectedTsxLoader === undefined || expectedTsxLoader === tsxLoader);
  // Context-bound execution proof: the exact ABSOLUTE native subject, the
  // selected loader/config, the exact mode args AND the verified actual container
  // WorkingDir must all bind. A supplied `invocationContext` (even explicit null)
  // selects the STRICT context-bound proof below; a caller that supplies NEITHER
  // parameter keeps the legacy (non-context) behavior.
  const nativeCwd = run.nativeCwd ?? null;
  const nativeSubject =
    typeof run.nativeSubject === 'string' && run.nativeSubject ? run.nativeSubject : null;
  const workingDirInspect = run.workingDirInspect ?? null;
  // A supplied `invocationContext` — INCLUDING an explicit `null` — means a
  // CONTEXT-BOUND proof was requested: the exec proof MUST bind a DEFINITE
  // independently expected cwd, the returned native cwd, a REAL ABSOLUTE native
  // subject AND the complete verified WorkingDir inspection (verified + parsed +
  // trimmed raw + transport exit/signal/error + the exact owned CID + this run's
  // context key). Missing ANY of these fails the proof, even when the raw trace
  // shows the subject. A caller that supplies NEITHER parameter keeps the legacy
  // behavior; an explicitly invalid context is NEVER a legacy caller.
  //
  // Follow-on (PR2309 published): the returned run CID is MANDATORY and must
  // EQUAL the inspected exact CID — there is NO missing-returned-CID fallback.
  // The lossless inspection bytes are independently re-hashed/counted (never a
  // Boolean `verified` flag alone) and the transport facts must be a full finite
  // integer exit with a null signal and no spawn error, exactly as the low-level
  // producer captures them.
  const contextBound = invocationContext !== undefined;
  const nativeSubjectAbsolute = !!nativeSubject && nativeSubject.startsWith('/');
  const utf8ByteLength = (s) => Buffer.byteLength(s, 'utf8');
  const sha256Utf8 = (s) => createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
  const isHex64 = (v) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
  let cwdProofOk;
  if (contextBound) {
    const wd = workingDirInspect;
    // The RETURNED run CID must be a real 64-hex id AND equal the inspected exact
    // CID. A null/absent returned CID is REFUSED (no fallback); a mismatched id is
    // REFUSED — neither a Boolean `verified` flag nor an `inspectionCID` without a
    // real matching returned run CID is proof.
    const runCid = typeof run.containerId === 'string' ? run.containerId : null;
    const wdCidValid =
      runCid !== null &&
      isHex64(runCid) &&
      typeof wd?.exactContainerId === 'string' &&
      wd.exactContainerId === runCid;
    // Independently re-hash/count the lossless inspection bytes (do NOT trust the
    // producer-supplied digests/counts) and require the exact transport facts.
    const wdLossless =
      typeof wd?.stdoutRaw === 'string' &&
      isHex64(wd?.stdoutSha256) &&
      wd.stdoutSha256 === sha256Utf8(wd.stdoutRaw) &&
      Number.isInteger(wd?.stdoutBytes) &&
      wd.stdoutBytes === utf8ByteLength(wd.stdoutRaw) &&
      typeof wd?.stderrRaw === 'string' &&
      isHex64(wd?.stderrSha256) &&
      wd.stderrSha256 === sha256Utf8(wd.stderrRaw) &&
      Number.isInteger(wd?.stderrBytes) &&
      wd.stderrBytes === utf8ByteLength(wd.stderrRaw);
    // INDEPENDENTLY parse the retained lossless stdout JSON and require it to name
    // the independently expected native cwd. The producer-supplied `verified`,
    // `parsed` and `expected` fields are NEVER accepted as their own proof: a
    // forged `parsed`/`verified` (with all self-reported fields changed together)
    // cannot make a wrong / malformed stdout pass.
    let wdStdoutParsed = null;
    try {
      const v = JSON.parse(String(wd?.stdoutRaw ?? '').trim());
      if (typeof v === 'string') wdStdoutParsed = v;
    } catch {
      wdStdoutParsed = null;
    }
    const wdRawParseOk = wdStdoutParsed === expectedNativeCwd;
    cwdProofOk =
      typeof expectedNativeCwd === 'string' &&
      expectedNativeCwd.length > 0 &&
      nativeCwd === expectedNativeCwd &&
      nativeSubjectAbsolute &&
      wd?.verified === true &&
      wd?.expected === expectedNativeCwd &&
      wd?.parsed === expectedNativeCwd &&
      Number.isInteger(wd?.inspectExit) &&
      wd.inspectExit === 0 &&
      // Explicit null, NOT undefined: the producer always emits inspectSignal/
      // inspectError; an omitted field is a forged/trimmed receipt, not an honest
      // transport success. This matches the independent verifier and the actual
      // isolation.mjs producer (which sets `inspectError: wdRes.error ? ... : null`).
      wd?.inspectSignal === null &&
      wd?.inspectError === null &&
      wdLossless &&
      wdRawParseOk &&
      typeof wd?.raw === 'string' &&
      wd.raw.length > 0 &&
      typeof wd?.contextKey === 'string' &&
      wd.contextKey === (run.contextKey ?? null) &&
      wdCidValid;
  } else {
    cwdProofOk =
      expectedNativeCwd === undefined
        ? true
        : typeof expectedNativeCwd === 'string' &&
          nativeCwd === expectedNativeCwd &&
          workingDirInspect?.verified === true &&
          workingDirInspect?.expected === expectedNativeCwd;
  }
  return {
    ...run,
    auditOk,
    auditReason: auditOk
      ? null
      : `no syscall trace produced${run.runtimeConfigError ? ` (${run.runtimeConfigError})` : ' (audit tool did not run)'}`,
    traceName,
    // The EXACT owned trace location this invocation wrote (context/mode-bound).
    // The emitter reads THIS path, so a sibling context/mode can never overwrite
    // this invocation's original trace bytes before they are serialised.
    tracePath: join(run.evidenceDir ?? evidenceDir, traceName),
    attempts,
    // Exec proof is bound to the ACTUAL selected runtime config/loader and — for a
    // context-bound invocation — the EXACT absolute native subject + verified cwd.
    entrypointExecuted:
      auditOk &&
      runtimeConfigMatch &&
      cwdProofOk &&
      entrypointExecutedFromTrace(attempts, {
        subject: rel,
        args,
        runtimeConfig,
        loader: tsxLoader,
        ...(contextBound ? { nativeSubject: run.nativeSubject ?? null } : {}),
      }),
    runtimeConfig,
    runtimeConfigRel: run.runtimeConfigRel ?? null,
    tsxLoader,
    runtimeConfigError: run.runtimeConfigError ?? null,
    runtimeConfigMatch,
    invocationContext: run.invocationContext ?? null,
    contextKey: run.contextKey ?? null,
    nativeCwd,
    nativeSubject,
    workingDirInspect,
    cwdProofOk,
    denied: { network: attempts.network.length > 0, write: attempts.write.length > 0 },
  };
}
