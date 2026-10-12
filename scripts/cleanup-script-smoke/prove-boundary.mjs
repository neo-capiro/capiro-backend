/**
 * CleanUp1 §6.2 — end-to-end isolation + attempt-audit boundary proof.
 *
 * Stages tracked source (git archive HEAD) into a disposable dir, drops the
 * task-owned adversarial fixtures into an EXCLUDED (fixtures/) subdir, and runs
 * each through the REAL Docker boundary UNDER THE REAL strace audit
 * (attempt-audit.mjs) — the same path the smoke runner now uses, not a
 * side-proof.
 *
 * It asserts, as failures (never passing smokes):
 *   - a denied loopback network attempt and a denied read-only-tree write;
 *   - a SUPPRESSED (caught) network/write attempt the stderr signal misses but
 *     the syscall audit still records (with a contrast check proving the signal
 *     alone is blind);
 *   - an ignored `--help` and a no-args exit with no usage;
 *   - the exact owned container is terminated (no residual).
 *
 * Exit 0 only if every check passes; an unavailable audit fails closed.
 */
import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stageTrackedSource, classifyRun } from './run-smoke.mjs';
import { dockerAvailable, imagePresent, runIsolated, ISOLATION_IMAGE } from './isolation.mjs';
import { ensureAuditImage, runWithAttemptAudit, classifyAttemptAudit } from './attempt-audit.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures');
const REL_DIR = 'scripts/cleanup-script-smoke/fixtures';
const FIXTURE_FILES = [
  'net-attempt.mjs',
  'write-attempt.mjs',
  'help-ignored.mjs',
  'net-caught.mjs',
  'write-caught.mjs',
];

export function proveBoundary(repoRoot, { timeoutMs = 20000 } = {}) {
  if (!dockerAvailable()) return { ok: false, reason: 'docker-unavailable', checks: [] };
  if (!imagePresent()) return { ok: false, reason: `image-missing:${ISOLATION_IMAGE}`, checks: [] };
  const audit = ensureAuditImage();
  if (!audit.ok) {
    return { ok: false, reason: `attempt-audit-unavailable:${audit.reason}`, checks: [] };
  }

  const stage = mkdtempSync(join(tmpdir(), 'cleanup-smoke-proof-'));
  const checks = [];
  try {
    stageTrackedSource(repoRoot, stage);
    mkdirSync(join(stage, REL_DIR), { recursive: true });
    for (const f of FIXTURE_FILES) cpSync(join(FIXTURES, f), join(stage, REL_DIR, f));

    const entry = (rel) => ({ kind: 'entrypoint', rel, subject: 'proof-fixtures' });
    const evDir = () => mkdtempSync(join(tmpdir(), 'cleanup-smoke-audit-evidence-'));
    const audited = (rel, args, traceName, ev) =>
      runWithAttemptAudit({ repoRoot: stage, rel, args, timeoutMs, evidenceDir: ev, traceName, image: audit.image });

    // ---- 1. denied network attempt (reported) -------------------------------
    {
      const rel = `${REL_DIR}/net-attempt.mjs`;
      const ev = evDir();
      const noArgs = audited(rel, [], 'noargs.trace', ev);
      const help = { ...audited(rel, ['--help'], 'help.trace', ev), args: ['--help'] };
      const unknown = { ...audited(rel, ['--x'], 'unknown.trace', ev), args: ['--x'] };
      const c = classifyRun(entry(rel), { ...noArgs, args: [] }, help, unknown);
      checks.push({
        name: 'denied network attempt fails (audited)',
        status: c.status,
        ok: c.status === 'attempt-audit-network' && noArgs.attempts.network.length > 0,
        detail: `${c.status}: ${noArgs.attempts.network[0] ?? ''}`.slice(0, 200),
      });
      // Retained: raw boundary evidence is not deleted.
    }

    // ---- 2. denied write to the read-only staged tree -----------------------
    {
      const rel = `${REL_DIR}/write-attempt.mjs`;
      const ev = evDir();
      const noArgs = audited(rel, [], 'noargs.trace', ev);
      const help = { ...audited(rel, ['--help'], 'help.trace', ev), args: ['--help'] };
      const unknown = { ...audited(rel, ['--x'], 'unknown.trace', ev), args: ['--x'] };
      const c = classifyRun(entry(rel), { ...noArgs, args: [] }, help, unknown);
      checks.push({
        name: 'denied read-only-tree write fails (audited)',
        status: c.status,
        ok: c.status === 'attempt-audit-write' && noArgs.attempts.write.length > 0,
        detail: `${c.status}: ${noArgs.attempts.write[0] ?? ''}`.slice(0, 200),
      });
      // Retained: raw boundary evidence is not deleted.
    }

    // ---- 3. suppressed (caught) attempts the stderr signal misses -----------
    // Contrast: the stderr heuristic alone sees NOTHING for the suppressed net
    // fixture; the syscall audit still records the attempt.
    {
      const rel = `${REL_DIR}/net-caught.mjs`;
      const ev = evDir();
      const sig = runIsolated({ repoRoot: stage, rel, args: [], timeoutMs });
      const noArgs = audited(rel, [], 'noargs.trace', ev);
      checks.push({
        name: 'stderr signal alone misses a suppressed network attempt (audit required)',
        status: sig.status,
        ok: sig.denials.network === false,
        detail: `stderr signal network=${sig.denials.network} (expected false — the heuristic is not an audit)`,
      });
      checks.push({
        name: 'syscall audit catches the suppressed network attempt',
        status: classifyAttemptAudit(noArgs).status,
        ok: noArgs.auditOk && noArgs.attempts.network.length > 0,
        detail: `${noArgs.attempts.network[0] ?? ''}`.slice(0, 200),
      });
      // Retained: raw boundary evidence is not deleted.
    }
    {
      const rel = `${REL_DIR}/write-caught.mjs`;
      const ev = evDir();
      const sig = runIsolated({ repoRoot: stage, rel, args: [], timeoutMs });
      const noArgs = audited(rel, [], 'noargs.trace', ev);
      checks.push({
        name: 'stderr signal alone misses a suppressed write attempt (audit required)',
        status: sig.status,
        ok: sig.denials.write === false,
        detail: `stderr signal write=${sig.denials.write} (expected false — the heuristic is not an audit)`,
      });
      checks.push({
        name: 'syscall audit catches the suppressed write attempt',
        status: classifyAttemptAudit(noArgs).status,
        ok: noArgs.auditOk && noArgs.attempts.write.length > 0,
        detail: `${noArgs.attempts.write[0] ?? ''}`.slice(0, 200),
      });
      // Retained: raw boundary evidence is not deleted.
    }

    // ---- 4. ignored --help / no-args-without-usage --------------------------
    {
      const rel = `${REL_DIR}/help-ignored.mjs`;
      const ev = evDir();
      const noArgs = { ...audited(rel, [], 'noargs.trace', ev), args: [] };
      const help = { ...audited(rel, ['--help'], 'help.trace', ev), args: ['--help'] };
      const unknown = { ...audited(rel, ['--x'], 'unknown.trace', ev), args: ['--x'] };
      const noArgsC = classifyRun(entry(rel), noArgs, help, unknown);
      checks.push({
        name: 'no-args exit 0 with no usage is not a pass',
        status: noArgsC.status,
        ok: noArgsC.status === 'noargs-contract',
        detail: `no-args exit ${noArgs.exit}, usage=${/usage/i.test(`${noArgs.out}${noArgs.err}`)}`,
      });
      // Retained: raw boundary evidence is not deleted.
    }

    // ---- 5. exact owned container termination -------------------------------
    {
      const rel = `${REL_DIR}/net-caught.mjs`;
      const ev = evDir();
      const r = audited(rel, [], 'noargs.trace', ev);
      const residual = runIsolated({ repoRoot: stage, rel, args: [], timeoutMs, evidenceDir: ev });
      checks.push({
        name: 'exact owned container is terminated (no residual)',
        status: 'container-lifecycle',
        ok: r.containerTerminated === true && r.containerResidual === false && residual.containerTerminated === true,
        detail: `container=${r.containerName} terminated=${r.containerTerminated} residual=${r.containerResidual}`,
      });
      // Retained: raw boundary evidence is not deleted.
    }

    return {
      ok: checks.every((c) => c.ok),
      sandbox: `docker ${ISOLATION_IMAGE} --network none --read-only (+ strace -f denied-syscall attempt audit)`,
      auditImage: audit.image,
      built: audit.built,
      checks,
    };
  } finally {
    // Retained: the owned proof staging tree is not recursively deleted.
  }
}

if (process.argv[1]?.endsWith('prove-boundary.mjs')) {
  const rootArg = process.argv[2] ?? process.cwd();
  const r = proveBoundary(rootArg);
  process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  process.exitCode = r.ok ? 0 : 1;
}
