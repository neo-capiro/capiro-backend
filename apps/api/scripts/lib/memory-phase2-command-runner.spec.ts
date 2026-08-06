import { describe, expect, it, jest } from '@jest/globals';
import type { spawnSync } from 'node:child_process';
import {
  MEMORY_PHASE2_COMMAND_MAX_BUFFER,
  resolveMemoryPhase2Pnpm,
  runMemoryPhase2Command,
} from './memory-phase2-command-runner.js';

type SpawnSync = typeof spawnSync;

describe('memory phase 2 command runner', () => {
  it('uses an explicit Corepack pnpm module without a shell', () => {
    const result = resolveMemoryPhase2Pnpm({
      platform: 'win32',
      execPath: 'C:/node/node.exe',
      env: { CAPIRO_COREPACK_PNPM_JS: '/tools/corepack/pnpm.js' },
      exists: (path) => path === '/tools/corepack/pnpm.js',
    });

    expect(result).toEqual({
      command: 'C:/node/node.exe',
      prefixArgs: ['/tools/corepack/pnpm.js'],
      shell: false,
      source: 'explicit-corepack-js',
    });
  });

  it('fails closed when the explicit Corepack module is missing', () => {
    expect(() =>
      resolveMemoryPhase2Pnpm({
        env: { CAPIRO_COREPACK_PNPM_JS: '/missing/pnpm.js' },
        exists: () => false,
      }),
    ).toThrow('CAPIRO_COREPACK_PNPM_JS does not exist');
  });

  it('prefers a Node-adjacent Corepack module and uses platform-safe fallbacks', () => {
    expect(
      resolveMemoryPhase2Pnpm({
        platform: 'linux',
        execPath: '/opt/node/bin/node',
        env: {},
        exists: (path) => path === '/opt/node/lib/node_modules/corepack/dist/pnpm.js',
      }),
    ).toEqual({
      command: '/opt/node/bin/node',
      prefixArgs: ['/opt/node/lib/node_modules/corepack/dist/pnpm.js'],
      shell: false,
      source: 'bundled-corepack-js',
    });
    expect(
      resolveMemoryPhase2Pnpm({
        platform: 'win32',
        execPath: 'C:/node/node.exe',
        env: {},
        exists: () => false,
      }),
    ).toMatchObject({ command: 'pnpm', shell: true, source: 'windows-shell' });
    expect(
      resolveMemoryPhase2Pnpm({
        platform: 'linux',
        execPath: '/opt/node/bin/node',
        env: {},
        exists: () => false,
      }),
    ).toMatchObject({ command: 'pnpm', shell: false, source: 'pnpm-path' });
  });

  it('uses a bounded output buffer and redacts database credentials on success', () => {
    let capturedOptions: Record<string, unknown> | undefined;
    const spawn = jest.fn(
      (_command: string, _args: readonly string[], options: Record<string, unknown>) => {
        capturedOptions = options;
        return {
          status: 0,
          signal: null,
          stdout: 'connected postgresql://user:password@localhost/memory_phase2_clean',
          stderr: 'safe warning',
        };
      },
    ) as unknown as SpawnSync;

    const output = runMemoryPhase2Command({
      command: 'node',
      args: ['pnpm.js', 'exec', 'prisma', 'validate'],
      cwd: '/repo/apps/api',
      env: {
        DATABASE_URL: 'postgresql://user:password@localhost/memory_phase2_clean',
      },
      spawn,
    });

    expect(capturedOptions).toMatchObject({
      maxBuffer: MEMORY_PHASE2_COMMAND_MAX_BUFFER,
      shell: false,
      windowsHide: true,
      stdio: 'pipe',
    });
    expect(output).toEqual({ stdout: 'connected [REDACTED]', stderr: 'safe warning' });
  });

  it('redacts sensitive arguments and output from failed commands', () => {
    const secret = 'postgresql://user:password@localhost/memory_phase2_clean';
    const spawn = jest.fn(() => ({
      status: 1,
      signal: null,
      stdout: `database=${secret}`,
      stderr: `could not connect to ${secret}`,
    })) as unknown as SpawnSync;

    expect(() =>
      runMemoryPhase2Command({
        command: 'pnpm',
        args: ['exec', 'prisma', 'validate', secret],
        cwd: '/repo/apps/api',
        env: { DATABASE_URL: secret },
        spawn,
      }),
    ).toThrow(/\[REDACTED\]/);
    try {
      runMemoryPhase2Command({
        command: 'pnpm',
        args: ['exec', secret],
        cwd: '/repo/apps/api',
        env: { DATABASE_URL: secret },
        spawn,
      });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
      expect(String(error)).toContain('exit 1');
    }
  });

  it('reports process startup failures with the operating-system error code', () => {
    const spawn = jest.fn(() => ({
      status: null,
      signal: null,
      stdout: '',
      stderr: '',
      error: Object.assign(new Error('command not found'), { code: 'ENOENT' }),
    })) as unknown as SpawnSync;

    expect(() =>
      runMemoryPhase2Command({
        command: 'pnpm',
        args: ['--version'],
        cwd: '/repo/apps/api',
        spawn,
      }),
    ).toThrow('pnpm could not start [ENOENT]: command not found');
  });
});
