/**
 * One sandboxed analysis run (assistant-parity F4).
 *
 * The runner writes the user code + serialized datasets + harness into a
 * fresh temp directory, spawns `python3 harness.py` with a scrubbed
 * environment, enforces a wall-clock kill, and collects capped outputs
 * (stdout/stderr, results.json, out/*.png). Tenant isolation lives OUTSIDE
 * this process (Fargate microVM + no-egress SG + no-credential task role —
 * see docs/adr/0001-clio-analysis-sandbox-isolation.md); this module is the
 * inner resource/abuse layer.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface SandboxDataset {
  name: string;
  /** Rows serialized to CSV (objects) or raw text written verbatim. */
  rows?: Array<Record<string, unknown>>;
  text?: string;
  format?: 'csv' | 'json' | 'txt';
}

export interface SandboxRunRequest {
  code: string;
  datasets?: SandboxDataset[];
  timeoutMs?: number;
}

export interface SandboxImage {
  filename: string;
  dataBase64: string;
}

export interface SandboxRunResult {
  ok: boolean;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
  results: unknown | null;
  images: SandboxImage[];
  warnings: string[];
}

const WALL_TIMEOUT_MS = 35_000;
const MAX_CODE_CHARS = 40_000;
const MAX_DATASETS = 8;
const MAX_DATASET_ROWS = 5000;
const MAX_STD_CHARS = 64_000;
const MAX_RESULTS_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

const HARNESS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'harness.py');

function sanitizeDatasetName(name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);
  return safe || 'dataset';
}

function toCsv(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const escape = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(',')];
  for (const row of rows.slice(0, MAX_DATASET_ROWS)) {
    lines.push(columns.map((c) => escape(row[c])).join(','));
  }
  return lines.join('\n');
}

export function validateRunRequest(
  body: unknown,
): { ok: true; req: SandboxRunRequest } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'body must be an object' };
  const b = body as Record<string, unknown>;
  if (typeof b.code !== 'string' || !b.code.trim()) {
    return { ok: false, error: 'code is required' };
  }
  if (b.code.length > MAX_CODE_CHARS) {
    return { ok: false, error: `code exceeds ${MAX_CODE_CHARS} chars` };
  }
  const datasets: SandboxDataset[] = [];
  if (b.datasets !== undefined) {
    if (!Array.isArray(b.datasets)) return { ok: false, error: 'datasets must be an array' };
    if (b.datasets.length > MAX_DATASETS) {
      return { ok: false, error: `at most ${MAX_DATASETS} datasets` };
    }
    for (const d of b.datasets) {
      if (!d || typeof d !== 'object') {
        return { ok: false, error: 'each dataset must be an object' };
      }
      const ds = d as Record<string, unknown>;
      if (typeof ds.name !== 'string' || !ds.name) {
        return { ok: false, error: 'dataset.name is required' };
      }
      const rows = Array.isArray(ds.rows) ? (ds.rows as Array<Record<string, unknown>>) : undefined;
      const text = typeof ds.text === 'string' ? ds.text : undefined;
      if (!rows && !text) {
        return { ok: false, error: `dataset "${ds.name}" needs rows or text` };
      }
      datasets.push({
        name: ds.name,
        rows,
        text,
        format: ds.format === 'json' || ds.format === 'txt' ? ds.format : 'csv',
      });
    }
  }
  return { ok: true, req: { code: b.code, datasets, timeoutMs: WALL_TIMEOUT_MS } };
}

export async function runSandboxed(req: SandboxRunRequest): Promise<SandboxRunResult> {
  const started = Date.now();
  const workdir = await mkdtemp(join(tmpdir(), 'clio-sbx-'));
  try {
    await mkdir(join(workdir, 'data'), { recursive: true });
    await mkdir(join(workdir, 'out'), { recursive: true });
    await writeFile(join(workdir, 'code.py'), req.code, 'utf8');
    const harness = await readFile(HARNESS_PATH, 'utf8');
    await writeFile(join(workdir, 'harness.py'), harness, 'utf8');
    for (const dataset of req.datasets ?? []) {
      const base = sanitizeDatasetName(dataset.name);
      if (dataset.rows) {
        await writeFile(join(workdir, 'data', `${base}.csv`), toCsv(dataset.rows), 'utf8');
      } else if (dataset.text) {
        const ext = dataset.format === 'json' ? 'json' : dataset.format === 'txt' ? 'txt' : 'csv';
        await writeFile(
          join(workdir, 'data', `${base}.${ext}`),
          dataset.text.slice(0, 5_000_000),
          'utf8',
        );
      }
    }

    const python =
      process.env.SANDBOX_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3');
    const child = spawn(python, ['harness.py'], {
      cwd: workdir,
      // Scrubbed environment: no inherited secrets, ever. The Windows-only
      // passthroughs exist for local dev (user-site packages + CPython's
      // SYSTEMROOT requirement); the production container is Linux.
      env: {
        PATH: process.env.PATH ?? '',
        HOME: workdir,
        TMPDIR: workdir,
        MPLCONFIGDIR: join(workdir, 'out'),
        SANDBOX_CPU_SECONDS: '30',
        SANDBOX_MEM_BYTES: String(1024 * 1024 * 1024),
        PYTHONDONTWRITEBYTECODE: '1',
        PYTHONIOENCODING: 'utf-8',
        ...(process.platform === 'win32'
          ? {
              SYSTEMROOT: process.env.SYSTEMROOT ?? '',
              APPDATA: process.env.APPDATA ?? '',
              LOCALAPPDATA: process.env.LOCALAPPDATA ?? '',
            }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_STD_CHARS) stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_STD_CHARS) stderr += chunk.toString('utf8');
    });

    const timeoutMs = Math.min(req.timeoutMs ?? WALL_TIMEOUT_MS, WALL_TIMEOUT_MS);
    let timedOut = false;
    const exitCode: number | null = await new Promise((resolve) => {
      const killer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', () => {
        clearTimeout(killer);
        resolve(null);
      });
      child.on('close', (code) => {
        clearTimeout(killer);
        resolve(code);
      });
    });

    const warnings: string[] = [];
    let results: unknown = null;
    try {
      const bytes = await readFile(join(workdir, 'out', 'results.json'));
      if (bytes.length > MAX_RESULTS_BYTES) {
        warnings.push(
          `Structured results exceeded ${MAX_RESULTS_BYTES} bytes and were omitted. Return a smaller table or fewer visualization rows.`,
        );
      } else {
        results = JSON.parse(bytes.toString('utf8'));
      }
    } catch {
      /* no results.json produced or invalid JSON */
    }

    const images: SandboxImage[] = [];
    try {
      const files = (await readdir(join(workdir, 'out'))).filter((f) => f.endsWith('.png')).sort();
      for (const file of files.slice(0, MAX_IMAGES)) {
        const bytes = await readFile(join(workdir, 'out', file));
        if (bytes.length <= MAX_IMAGE_BYTES) {
          images.push({ filename: file, dataBase64: bytes.toString('base64') });
        } else {
          warnings.push(
            `Chart ${file} exceeded ${MAX_IMAGE_BYTES} bytes and was omitted. Reduce figure size or DPI.`,
          );
        }
      }
    } catch {
      /* no out dir */
    }

    return {
      ok: !timedOut && exitCode === 0,
      exitCode,
      timedOut,
      durationMs: Date.now() - started,
      stdout: stdout.slice(0, MAX_STD_CHARS),
      stderr: timedOut
        ? `${stderr}\n[sandbox] killed after ${timeoutMs}ms wall-clock limit`.trim()
        : stderr.slice(0, MAX_STD_CHARS),
      results,
      images,
      warnings,
    };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
