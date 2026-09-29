import { spawn, spawnSync } from 'node:child_process';
import { writeSync } from 'node:fs';

export interface VerifierProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  maxBufferBytes?: number;
  timeoutMs?: number;
  stdout?: (chunk: Buffer) => void;
  stderr?: (chunk: Buffer) => void;
}

export interface VerifierProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

/** Stream diagnostics immediately, but resolve only after the child actually closes. */
export function runVerifierProcess(
  command: string,
  args: string[],
  options: VerifierProcessOptions,
): Promise<VerifierProcessResult> {
  const maxBufferBytes = options.maxBufferBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBufferBytes) || maxBufferBytes < 1) {
    throw new Error('Verifier capture limit must be a positive integer');
  }
  if (
    options.timeoutMs !== undefined &&
    (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)
  ) {
    throw new Error('Verifier timeout must be positive');
  }
  return new Promise((resolve, reject) => {
    // A separate POSIX group lets timeout/signal/output failures stop descendants.
    // Parent signal handlers below ensure an outer timeout also reaches this group.
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: options.shell ?? false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const captured: Record<'stdout' | 'stderr', Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let failure: Error | undefined;
    let closed = false;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      if (!child.pid || closed) return;
      try {
        if (process.platform === 'win32') {
          const killed = spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
            timeout: 5000,
          });
          if (killed.error || killed.status !== 0) child.kill('SIGKILL');
        } else {
          process.kill(-child.pid, signal);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          failure ??= error instanceof Error ? error : new Error(String(error));
          child.kill('SIGKILL');
        }
      }
    };
    const stop = (error: Error): void => {
      failure ??= error;
      terminate('SIGTERM');
      escalation ??= setTimeout(() => terminate('SIGKILL'), 500);
    };
    const onTerm = (): void => stop(new Error('Verifier interrupted by SIGTERM'));
    const onInt = (): void => stop(new Error('Verifier interrupted by SIGINT'));
    process.once('SIGTERM', onTerm);
    process.once('SIGINT', onInt);
    if (options.timeoutMs !== undefined) {
      deadline = setTimeout(
        () => stop(new Error(`Verifier timed out after ${options.timeoutMs}ms`)),
        options.timeoutMs,
      );
    }
    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream].on('data', (chunk: Buffer) => {
        if (failure) return;
        sizes[stream] += chunk.length;
        if (sizes[stream] > maxBufferBytes) {
          stop(new Error(`Verifier ${stream} exceeded ${maxBufferBytes} captured bytes`));
          return;
        }
        captured[stream].push(chunk);
        try {
          const forward = options[stream];
          if (forward) forward(chunk);
          else writeSync(stream === 'stdout' ? 1 : 2, chunk);
        } catch (error) {
          // EPIPE and other forwarding failures must not be mistaken for success.
          stop(error instanceof Error ? error : new Error(String(error)));
        }
      });
      child[stream].on('error', (error) => stop(error));
    }
    child.on('error', (error) => stop(error));
    child.on('close', (status, signal) => {
      // A failed parent can exit before a descendant that ignores SIGTERM.
      // Finish tree cleanup before clearing the escalation timer.
      if (failure || status !== 0 || signal !== null) terminate('SIGKILL');
      closed = true;
      if (deadline) clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      if (failure) reject(failure);
      else
        resolve({
          status,
          signal,
          stdout: Buffer.concat(captured.stdout).toString('utf8'),
          stderr: Buffer.concat(captured.stderr).toString('utf8'),
        });
    });
  });
}
