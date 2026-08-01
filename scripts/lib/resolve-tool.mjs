/**
 * Resolve logical tool names to directly spawnable executables.
 *
 * These release gates deliberately spawn with `shell: false` so no gate argument
 * is ever exposed to shell interpolation. That makes hardcoded `*.cmd` names
 * unusable on Windows for two reasons:
 *
 *   1. Since Node 20, spawning a `.cmd`/`.bat` without a shell fails EINVAL.
 *   2. `pnpm.cmd` / `psql.exe` are frequently absent anyway — pnpm ships through
 *      corepack as a plain `.js`, and AWS CLI v2 / Docker install real `.exe`s
 *      in their own directories.
 *
 * So resolve to a real binary (or `node <script.js>`) instead of relaxing the
 * no-shell guarantee. Every tool honours an explicit `<TOOL>_PATH` override so
 * CI and operators can pin an exact binary.
 */
import { accessSync, constants, existsSync } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const isWindows = process.platform === 'win32';

function isExecutable(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Look a bare name up on PATH, honouring Windows executable extensions. */
function onPath(name) {
  // Prefer a native .exe, then an extensionless script (MSYS/Git-Bash style, which
  // we can hand to bash directly). A .cmd/.bat is the last resort because it is
  // usually just a thin wrapper around one of the former and cannot be spawned
  // shell-less.
  const exts = isWindows ? ['.exe', '', '.cmd', '.bat'] : [''];
  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, `${name}${ext}`);
      if (isExecutable(candidate) && !candidate.endsWith(path.sep)) return candidate;
    }
  }
  return null;
}

function bashExecutable() {
  if (process.env.BASH_PATH) return process.env.BASH_PATH;
  if (!isWindows) return '/bin/bash';
  try {
    const found = execFileSync('where.exe', ['bash.exe'], { encoding: 'utf8', windowsHide: true })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (found.length) return found[0];
  } catch {
    /* fall through */
  }
  return 'bash.exe';
}

/**
 * pnpm is distributed via corepack as plain JavaScript. Spawning
 * `node <corepack>/pnpm.js` avoids the batch shim entirely.
 */
function resolvePnpm(args) {
  if (process.env.PNPM_PATH) return spawnable(process.env.PNPM_PATH, args);
  const corepack = path.join(
    path.dirname(process.execPath),
    'node_modules',
    'corepack',
    'dist',
    'pnpm.js',
  );
  if (existsSync(corepack)) return { command: process.execPath, args: [corepack, ...args] };
  const onPathPnpm = isWindows ? onPath('pnpm') : 'pnpm';
  return spawnable(onPathPnpm ?? 'pnpm', args);
}

/**
 * A resolved path that is not a native executable (extensionless shell script,
 * or a `.cmd`/`.bat` we must not spawn shell-less) is launched through its
 * interpreter. `.js` goes to node; anything else is treated as a shell script.
 */
function spawnable(target, args) {
  const ext = path.extname(target).toLowerCase();
  if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
    return { command: process.execPath, args: [target, ...args] };
  }
  if (isWindows && (ext === '.cmd' || ext === '.bat' || ext === '')) {
    return { command: bashExecutable(), args: [target, ...args] };
  }
  return { command: target, args };
}

function resolveSimple(name, envVar, args) {
  if (process.env[envVar]) return spawnable(process.env[envVar], args);
  const found = onPath(name);
  return found ? spawnable(found, args) : { command: name, args };
}

/**
 * Translate a logical tool token plus its arguments into a directly spawnable
 * `{ command, args }` pair. Unknown tokens pass through unchanged so absolute
 * paths and `process.execPath` callers keep working.
 */
export function resolveSpawn(command, args = []) {
  switch (command) {
    case 'pnpm':
      return resolvePnpm(args);
    case 'psql':
      return resolveSimple('psql', 'PSQL_PATH', args);
    case 'git':
      return resolveSimple('git', 'GIT_PATH', args);
    case 'docker':
      return resolveSimple('docker', 'DOCKER_PATH', args);
    case 'actionlint':
      return resolveSimple('actionlint', 'ACTIONLINT_PATH', args);
    case 'bash':
      return { command: bashExecutable(), args };
    default:
      return { command, args };
  }
}

/** True when a logical tool can actually be launched on this host. */
export function toolAvailable(command) {
  const resolved = resolveSpawn(command, []);
  if (path.isAbsolute(resolved.command)) return isExecutable(resolved.command);
  return Boolean(onPath(resolved.command));
}
