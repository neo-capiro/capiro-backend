import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from '@jest/globals';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const apiRoot = resolve(scriptDirectory, '..', '..');
const closeoutSource = readFileSync(
  join(apiRoot, 'scripts/verify-memory-phase2-persistence-closeout.ts'),
  'utf8',
);
const runnerSource = readFileSync(
  join(apiRoot, 'scripts/lib/memory-phase2-command-runner.ts'),
  'utf8',
);

describe('memory phase 2 persistence closeout runner contract', () => {
  it('routes every pnpm operation through the portable command runner', () => {
    expect(closeoutSource).toContain("from './lib/memory-phase2-command-runner.js'");
    expect(closeoutSource).toContain('const pnpm = resolveMemoryPhase2Pnpm();');
    expect(closeoutSource).toContain('runMemoryPhase2Command({');
    expect(closeoutSource).toContain("runPnpm(['exec', 'prisma', 'validate'");
    expect(closeoutSource).toContain("runPnpm(['exec', 'prisma', 'generate'");
    expect(closeoutSource).toContain("runPnpm(['exec', 'prisma', 'migrate', 'deploy'");
    expect(closeoutSource).not.toContain("command === 'pnpm' ? 'pnpm.cmd'");
    expect(closeoutSource).not.toContain("from 'node:child_process'");
  });

  it('pins bounded output capture and secret redaction', () => {
    expect(runnerSource).toContain('64 * 1024 * 1024');
    expect(runnerSource).toContain('maxBuffer: input.maxBuffer ?? MEMORY_PHASE2_COMMAND_MAX_BUFFER');
    expect(runnerSource).toContain('DATABASE_URL|PASSWORD|TOKEN|SECRET|PRIVATE_KEY|API_KEY');
    expect(runnerSource).toContain("join('[REDACTED]')");
    expect(runnerSource).toContain("source: 'windows-shell'");
    expect(runnerSource).toContain("source: 'bundled-corepack-js'");
  });
});
