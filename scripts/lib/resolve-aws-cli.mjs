/**
 * Resolve the AWS CLI executable for the current platform.
 *
 * On Windows, AWS CLI v2 installs `aws.exe` (typically under
 * `%ProgramFiles%\Amazon\AWSCLIV2`). The previous hardcoded `aws.cmd` is a v1 /
 * pip-shim artifact and is normally absent, and since Node 20 `child_process`
 * refuses to spawn `.cmd`/`.bat` without a shell (EINVAL) — so naming a `.cmd`
 * both misses the real binary and trips the batch-spawn restriction.
 *
 * Preferring the absolute path to `aws.exe` also keeps these release operators
 * off any shell interpolation path.
 */
import { accessSync, constants } from 'node:fs';
import path from 'node:path';

function executable(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAwsCli() {
  if (process.env.AWS_CLI_PATH) return process.env.AWS_CLI_PATH;
  if (process.platform !== 'win32') return 'aws';

  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
  ].filter(Boolean);

  for (const root of roots) {
    const candidate = path.join(root, 'Amazon', 'AWSCLIV2', 'aws.exe');
    if (executable(candidate)) return candidate;
  }

  for (const dir of String(process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'aws.exe');
    if (executable(candidate)) return candidate;
  }

  // Let execFile surface a clear ENOENT rather than silently guessing a shim.
  return 'aws.exe';
}
