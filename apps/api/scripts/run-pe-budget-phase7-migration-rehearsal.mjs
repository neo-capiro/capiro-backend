import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = dirname(scriptDirectory);
const rehearsalScript = join(scriptDirectory, 'pe-budget-phase7-migration-rehearsal.sh');

function selectBash() {
  if (process.env.P7_REHEARSAL_BASH) {
    return process.env.P7_REHEARSAL_BASH;
  }
  if (process.platform !== 'win32') {
    return 'bash';
  }

  const candidates = [
    process.env.ProgramFiles ? join(process.env.ProgramFiles, 'Git', 'bin', 'bash.exe') : undefined,
    process.env.LOCALAPPDATA
      ? join(process.env.LOCALAPPDATA, 'hermes', 'git', 'bin', 'bash.exe')
      : undefined,
  ].filter(Boolean);
  const gitBash = candidates.find((candidate) => existsSync(candidate));
  if (!gitBash) {
    throw new Error(
      'Git-for-Windows Bash is required. Install Git Bash or set P7_REHEARSAL_BASH to its bash.exe path; WSL Bash cannot use a Windows node_modules tree.',
    );
  }
  return gitBash;
}

let bash;
try {
  bash = selectBash();
} catch (error) {
  console.error(`[p7-rehearsal-launcher] ${error.message}`);
  process.exit(1);
}

if (process.argv.includes('--print-bash')) {
  console.log(bash);
  process.exit(0);
}

const child = spawnSync(bash, [rehearsalScript], {
  cwd: apiRoot,
  env: process.env,
  stdio: 'inherit',
});
if (child.error) {
  console.error(`[p7-rehearsal-launcher] Could not start ${bash}: ${child.error.message}`);
  process.exit(1);
}
if (child.signal) {
  console.error(`[p7-rehearsal-launcher] Rehearsal terminated by signal ${child.signal}.`);
  process.exit(1);
}
process.exit(child.status ?? 1);
