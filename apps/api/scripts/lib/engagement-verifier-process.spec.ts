import { runVerifierProcess } from './engagement-verifier-process';
import { existsSync, mkdtempSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { Writable } from 'node:stream';

const options = { cwd: process.cwd(), stdout: () => {}, stderr: () => {} };
const run = (code: string, extra: Partial<Parameters<typeof runVerifierProcess>[2]> = {}) =>
  runVerifierProcess(process.execPath, ['-e', code], { ...options, ...extra });

describe('Engagement verifier child lifecycle', () => {
  it('streams output before exit and waits for genuine exit zero', async () => {
    let finished = false;
    let observe!: () => void;
    const output = new Promise<void>((resolve) => {
      observe = resolve;
    });
    const child = run("process.stdout.write('started'); setTimeout(() => process.exit(0), 300)", {
      stdout: (chunk) => {
        expect(chunk.toString()).toBe('started');
        observe();
      },
    }).then((result) => {
      finished = true;
      return result;
    });
    await output;
    expect(finished).toBe(false);
    const result = await child;
    expect(result).toEqual({ status: 0, signal: null, stdout: 'started', stderr: '' });
  });

  it('retains exit one even after a COMPLETE marker or green-looking summary', async () => {
    const result = await run(
      "console.log('ENGAGEMENT_PHASE1_DB_FREE_COMPLETE'); console.log('Tests 10 passed'); process.exitCode = 1",
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('ENGAGEMENT_PHASE1_DB_FREE_COMPLETE');
  });

  it('does not treat signal termination as exit zero', async () => {
    const result = await run("process.kill(process.pid, 'SIGTERM')");
    expect(result.status).not.toBe(0);
  });

  it('fails and reaps a child that exceeds its deadline even after COMPLETE', async () => {
    await expect(
      run("console.log('ENGAGEMENT_PHASE1_DB_FREE_COMPLETE'); setInterval(() => {}, 1000)", {
        timeoutMs: 250,
      }),
    ).rejects.toThrow('timed out');
  });

  it.each(['stdout', 'stderr'] as const)('caps captured %s by bytes', async (stream) => {
    await expect(
      run(`process.${stream}.write('x'.repeat(1025)); setInterval(() => {}, 1000)`, {
        maxBufferBytes: 1024,
      }),
    ).rejects.toThrow(`Verifier ${stream} exceeded 1024 captured bytes`);
  });

  it('retains stderr for narrowly classified retry diagnostics', async () => {
    const result = await run("console.error('Worker exited unexpectedly'); process.exitCode = 1");
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Worker exited unexpectedly');
  });

  it('fails closed when a live output sink throws EPIPE', async () => {
    const error = Object.assign(new Error('broken output pipe'), { code: 'EPIPE' });
    await expect(
      run("console.log('output'); setInterval(() => {}, 1000)", {
        stdout: () => {
          throw error;
        },
      }),
    ).rejects.toThrow('broken output pipe');
  });

  it('rejects a missing executable instead of accepting a null status', async () => {
    await expect(
      runVerifierProcess('engagement-verifier-definitely-missing-command', [], options),
    ).rejects.toThrow();
  });
  it('forwards large output through a slow small-buffer Writable without loss', async () => {
    const chunks: Buffer[] = [];
    let drains = 0;
    const sink = new Writable({
      highWaterMark: 32,
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        setTimeout(callback, 2);
      },
    });
    sink.on('drain', () => {
      drains++;
    });
    const result = await run("process.stdout.write('x'.repeat(2 * 1024 * 1024))", { stdout: sink });
    expect(result.status).toBe(0);
    expect(drains).toBeGreaterThan(0);
    expect(Buffer.concat(chunks).toString()).toBe(result.stdout);
    expect(result.stdout).toHaveLength(2 * 1024 * 1024);
    expect(sink.writableLength).toBe(0);
  });

  it('does not resolve before the final pending write completes', async () => {
    let release!: () => void;
    let observe!: () => void;
    const writing = new Promise<void>((resolve) => {
      observe = resolve;
    });
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        release = callback;
        observe();
      },
    });
    let finished = false;
    const child = run("process.stdout.write('done')", { stdout: sink }).then((result) => {
      finished = true;
      return result;
    });
    await writing;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toBe(false);
    release();
    expect((await child).status).toBe(0);
    expect(sink.writableLength).toBe(0);
  });

  it('rejects an asynchronous Writable EPIPE error', async () => {
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(
          () => callback(Object.assign(new Error('async broken output pipe'), { code: 'EPIPE' })),
          10,
        );
      },
    });
    await expect(
      run("console.log('output'); setInterval(() => {}, 1000)", { stdout: sink }),
    ).rejects.toThrow('async broken output pipe');
  });

  it('times out safely while the output Writable remains backpressured', async () => {
    const sink = new Writable({ highWaterMark: 1, write() {} });
    await expect(
      run("console.log('output'); setInterval(() => {}, 1000)", { stdout: sink, timeoutMs: 250 }),
    ).rejects.toThrow('timed out');
    sink.destroy();
  });

  it('retains a child signal failure while waiting for a slow output write', async () => {
    let wrote = false;
    const sink = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        setTimeout(() => {
          wrote = true;
          callback();
        }, 150);
      },
    });
    const result = await run(
      "process.stdout.write('output', () => process.kill(process.pid, 'SIGTERM'))",
      { stdout: sink },
    );
    expect(wrote).toBe(true);
    expect(result.status).not.toBe(0);
  });
  it('stops a descendant on timeout even if that descendant ignores SIGTERM', async () => {
    const directory = mkdtempSync(
      path.join(process.platform === 'win32' ? 'C:/dev' : tmpdir(), 'engagement-verifier-tree-'),
    );
    const heartbeat = path.join(directory, 'heartbeat.txt');
    const grandchildCode = `const fs = require('node:fs'); process.on('SIGTERM', () => {}); setInterval(() => fs.appendFileSync(${JSON.stringify(heartbeat)}, 'x'), 20);`;
    const parentCode = `const {spawn} = require('node:child_process'); const child = spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], {stdio: 'ignore'}); console.log(child.pid); setInterval(() => {}, 1000);`;
    let descendantPid: number | undefined;
    try {
      await expect(
        run(parentCode, {
          timeoutMs: 500,
          stdout: (chunk) => {
            descendantPid = Number(chunk.toString().trim());
          },
        }),
      ).rejects.toThrow('timed out');
      expect(descendantPid).toBeGreaterThan(0);
      expect(existsSync(heartbeat)).toBe(true);
      const size = statSync(heartbeat).size;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(statSync(heartbeat).size).toBe(size);
    } finally {
      if (descendantPid) {
        try {
          process.kill(descendantPid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
      if (existsSync(heartbeat)) unlinkSync(heartbeat);
      rmdirSync(directory);
    }
  });
});

describe('Phase 2 actual-exit gate', () => {
  const script = readFileSync(
    path.resolve(__dirname, '../../../../scripts/verify-engagement-phase2-code.sh'),
    'utf8',
  );
  const gate = script.match(/^phase1_gate\(\) \{[\s\S]*?^\}/m)?.[0];
  const bash = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash';
  let directory: string;
  let log: string;
  beforeEach(() => {
    directory = mkdtempSync(
      path.join(process.platform === 'win32' ? 'C:/dev' : tmpdir(), 'engagement-verifier-spec-'),
    );
    log = path.join(directory, 'child.log').replace(/\\/g, '/');
  });
  afterEach(() => {
    if (existsSync(log)) unlinkSync(log);
    rmdirSync(directory);
  });
  const execute = (command: string, deadline = '5', teeFunction = '') => {
    expect(gate).toBeDefined();
    return runVerifierProcess(
      bash,
      [
        '-c',
        `TIMEOUT_BIN=/usr/bin/timeout\n${teeFunction}\n${gate}\nphase1_gate "$TEST_LOG" "$TEST_DEADLINE" bash -c "$TEST_COMMAND"`,
      ],
      {
        ...options,
        timeoutMs: 10000,
        env: { ...process.env, TEST_LOG: log, TEST_DEADLINE: deadline, TEST_COMMAND: command },
      },
    );
  };
  it('requires real exit zero together with the completion marker', async () => {
    expect((await execute("printf 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE\\n'; exit 0")).status).toBe(
      0,
    );
  });
  it('rejects exit one despite a completion marker', async () => {
    expect(
      (await execute("printf 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE\\n'; exit 1")).status,
    ).not.toBe(0);
  });
  it('rejects an exit-zero child without a completion marker', async () => {
    expect((await execute('exit 0')).status).not.toBe(0);
  });
  it('rejects a malformed completion marker despite exit zero', async () => {
    expect(
      (await execute("printf 'prefixENGAGEMENT_PHASE1_DB_FREE_COMPLETEsuffix\\n'; exit 0")).status,
    ).not.toBe(0);
  });
  it('rejects tee failure despite child exit zero and a valid marker in the file', async () => {
    expect(
      (
        await execute(
          "printf 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE\\n'; exit 0",
          '5',
          'tee() { /usr/bin/tee "$@"; return 1; }',
        )
      ).status,
    ).not.toBe(0);
    expect(readFileSync(log, 'utf8')).toContain('ENGAGEMENT_PHASE1_DB_FREE_COMPLETE');
  });
  it('rejects a FAILED marker even alongside COMPLETE and exit zero', async () => {
    expect(
      (
        await execute(
          "printf 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE\\nENGAGEMENT_PHASE1_DB_FREE_FAILED\\n'; exit 0",
        )
      ).status,
    ).not.toBe(0);
  });
  it('rejects signal termination after COMPLETE', async () => {
    expect(
      (await execute("printf 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE\\n'; kill -TERM $$")).status,
    ).not.toBe(0);
  });
  it('rejects a timeout after COMPLETE', async () => {
    expect(
      (await execute("printf 'ENGAGEMENT_PHASE1_DB_FREE_COMPLETE\\n'; sleep 5", '0.2')).status,
    ).not.toBe(0);
  });
});
