import { spawn, spawnSync } from 'node:child_process';
import { Writable } from 'node:stream';

type VerifierSink = Writable | ((chunk: Buffer) => void);

export interface VerifierProcessOptions {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  maxBufferBytes?: number;
  timeoutMs?: number;
  stdout?: VerifierSink;
  stderr?: VerifierSink;
}

export interface VerifierProcessResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

function forwardChunk(sink: VerifierSink, chunk: Buffer, signal: AbortSignal): Promise<void> {
  if (typeof sink === 'function') {
    return Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      sink(chunk);
    });
  }
  return new Promise((resolve, reject) => {
    let accepted: boolean | undefined;
    let written = false;
    let drained = false;
    let done = false;
    const cleanup = (): void => {
      sink.removeListener('drain', onDrain);
      sink.removeListener('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const fail = (error: Error): void => {
      if (done) return;
      done = true;
      cleanup();
      reject(error);
    };
    const complete = (): void => {
      if (!done && written && accepted !== undefined && (accepted || drained)) {
        done = true;
        cleanup();
        resolve();
      }
    };
    const onDrain = (): void => {
      drained = true;
      complete();
    };
    const onError = (error: Error): void => fail(error);
    const onAbort = (): void => fail(signal.reason);
    sink.once('drain', onDrain);
    sink.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    try {
      // Node's Writable handles nonblocking fd readiness. Do not busy-retry a
      // raw writeSync: a full Linux pipe legitimately reports EAGAIN.
      accepted = sink.write(chunk, (error) => {
        if (error) {
          fail(error);
          return;
        }
        written = true;
        complete();
      });
      complete();
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
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
    const sinks = {
      stdout: options.stdout ?? process.stdout,
      stderr: options.stderr ?? process.stderr,
    };
    const writes = new AbortController();
    let failure: Error | undefined;
    let closed = false;
    let settled = false;
    let pendingWrites = 0;
    let exitStatus: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let escalation: NodeJS.Timeout | undefined;
    let deadline: NodeJS.Timeout | undefined;
    const terminate = (signal: NodeJS.Signals): void => {
      if (!child.pid) return;
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
    const finish = (): void => {
      if (settled || !closed || pendingWrites !== 0) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      process.removeListener('SIGTERM', onTerm);
      process.removeListener('SIGINT', onInt);
      for (const sink of Object.values(sinks)) {
        if (typeof sink !== 'function') sink.removeListener('error', onSinkError);
      }
      if (failure) reject(failure);
      else
        resolve({
          status: exitStatus,
          signal: exitSignal,
          stdout: Buffer.concat(captured.stdout).toString('utf8'),
          stderr: Buffer.concat(captured.stderr).toString('utf8'),
        });
    };
    const stop = (error: Error): void => {
      if (failure) return;
      failure = error;
      writes.abort(error);
      terminate('SIGTERM');
      // A paused readable must not keep close pending after a fatal sink error.
      child.stdout.destroy();
      child.stderr.destroy();
      escalation ??= setTimeout(() => terminate('SIGKILL'), 500);
      finish();
    };
    const onSinkError = (error: Error): void => stop(error);
    for (const sink of Object.values(sinks)) {
      if (typeof sink !== 'function') sink.on('error', onSinkError);
    }
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
        child[stream].pause();
        pendingWrites++;
        void forwardChunk(sinks[stream], chunk, writes.signal)
          .catch((error) => stop(error instanceof Error ? error : new Error(String(error))))
          .finally(() => {
            pendingWrites--;
            if (!failure) child[stream].resume();
            finish();
          });
      });
      child[stream].on('error', (error) => stop(error));
    }
    child.on('error', (error) => stop(error));
    child.on('close', (status, signal) => {
      // A failed parent can exit before a descendant that ignores SIGTERM.
      // Finish tree cleanup before clearing the escalation timer.
      if (failure || status !== 0 || signal !== null) terminate('SIGKILL');
      closed = true;
      exitStatus = status;
      exitSignal = signal;
      finish();
    });
  });
}
