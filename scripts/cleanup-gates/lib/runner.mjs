/**
 * Cross-platform process runner for the CleanUp1 gate.
 *
 * The gate is a Node driver (not a long `&&` chain) so it behaves identically
 * on Windows (MSYS git-bash), macOS and Linux, and so a missing result or a
 * setup error is a hard, structured failure rather than a silently-skipped
 * clause. It never swallows a non-zero exit code.
 *
 * Two spawn paths:
 *   - runArgv(file, args)  — argv spawning with NO shell, used for every
 *     invocation that carries a reviewer- or environment-supplied value
 *     (notably the diff `--base` ref). Nothing is ever interpolated into a
 *     shell string, so a ref like `origin/main; rm -rf /` cannot execute.
 *   - run(cmd)             — a constant command string resolved through the
 *     shell, kept only for `pnpm`/`uv` where Windows shim resolution requires
 *     it. The string is always built from constant config, never user input.
 */

import { spawnSync } from 'node:child_process';

/**
 * Run a program with an explicit argv array (shell = false). Returns the
 * numeric exit code. This is the interpolation-safe path.
 */
export function runArgv(file, args = [], { cwd, env, label, shell = false } = {}) {
  if (label) process.stdout.write(`\n[gate] $ ${file} ${args.join(' ')}\n`);
  const res = spawnSync(file, args, {
    cwd,
    shell,
    stdio: 'inherit',
    env: { ...process.env, ...(env || {}) },
  });
  if (res.error) {
    process.stderr.write(`[gate] failed to spawn: ${file} ${args.join(' ')}\n${res.error.stack || res.error.message}\n`);
    return 127;
  }
  return typeof res.status === 'number' ? res.status : 1;
}

/**
 * Run a command string with inherited stdio (so CI logs stream). Returns the
 * numeric exit code. `shell` defaults to true so `pnpm` resolves to `pnpm.cmd`
 * on Windows and `pnpm` on POSIX. Only ever call with a constant command.
 */
export function run(cmd, { cwd, env, shell = true, label } = {}) {
  if (label) process.stdout.write(`\n[gate] $ ${cmd}\n`);
  const res = spawnSync(cmd, {
    cwd,
    shell,
    stdio: 'inherit',
    env: { ...process.env, ...(env || {}) },
  });
  if (res.error) {
    process.stderr.write(`[gate] failed to spawn: ${cmd}\n${res.error.stack || res.error.message}\n`);
    return 127;
  }
  return typeof res.status === 'number' ? res.status : 1;
}

/** Capture stdout of a command (used for read-only git probes). */
export function capture(cmd, { cwd } = {}) {
  const res = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8' });
  if (res.status !== 0) return { ok: false, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
  return { ok: true, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}

/**
 * Capture stdout of a program via argv (shell = false). Used for the reviewed
 * multiset/name proof and for validating baselines, where the argument list is
 * built from source-derived values.
 *
 * `stdoutRaw` preserves the EXACT bytes (no trim): the NUL-delimited
 * `git status --porcelain -z` protocol carries a leading status-column space on
 * the first record (e.g. ` M path`), and a whole-output `.trim()` silently
 * corrupts it — the first record loses its space so `parsePorcelainZ` reads the
 * status column shifted and truncates the path. Callers that parse a
 * machine-readable byte protocol MUST use `stdoutRaw`, never the trimmed
 * `stdout`. `stderr`/`stdout` remain trimmed for human-readable callers.
 */
export function captureArgv(file, args = [], { cwd, env } = {}) {
  const res = spawnSync(file, args, { cwd, shell: false, encoding: 'utf8', env: { ...process.env, ...(env || {}) } });
  const out = res.stdout || '';
  const err = res.stderr || '';
  const base = { stdout: out.trim(), stdoutRaw: out, stderr: err.trim(), status: res.status, error: res.error || null, signal: res.signal || null };
  if (res.status !== 0) return { ok: false, ...base };
  return { ok: true, ...base };
}
