/**
 * PR2224 tar ADAPTOR — the ONE way the smoke tooling consumes archives.
 *
 * It adds NO parser of its own: it imports the canonical reviewed validator
 * (`./hermes-execution-canonical-tar-validate.mjs`, root-owned, read-only) and
 * only (a) re-exports it and (b) materialises a VALIDATED archive on the Windows
 * host WITHOUT `tar -xf`/drive paths:
 *
 *   materializeValidatedArchive(buf, destDir):
 *     - refuses unless parseAndValidateTar(buf).ok === true (nothing is written
 *       before the canonical validator accepts the archive);
 *     - writes each REGULAR file's payload slice (dataOffset/size) into a FRESH
 *       empty, task-owned dir;
 *     - requires resolved-lexical containment under destDir, and rejects
 *       backslashes, drive letters, colons (device/ADS), UNC names, '.'/ '..'
 *       segments, trailing dot/space component aliases, Windows-invalid
 *       component characters (< > : " | ? *) and control characters;
 *     - creates parent dirs itself (never follows a symlink component, because
 *       destDir is verified empty and we create every component).
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseAndValidateTar, validateTarAgainstManifest, validateTarContainment, REGULAR, DIRECTORY, LINK_OR_DEVICE } from './tar-validate.mjs';

export { parseAndValidateTar, validateTarAgainstManifest, validateTarContainment, REGULAR, DIRECTORY, LINK_OR_DEVICE };

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/** Windows reserved device names (case-insensitive, extension-insensitive). */
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
/** Characters Windows forbids in a path component (':' is handled separately). */
const WINDOWS_INVALID_CHARS = /[<>"|?*]/;
/** ASCII control characters (0x00-0x1F) and DEL (0x7F). */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

/**
 * Reject Windows-unsafe names even though the canonical parser already vets
 * `/`, `..` and drive prefixes. Windows silently ALIASES several forms that a
 * naive POSIX check accepts, so each is refused BEFORE any payload is written:
 *   - a literal `.` component (`a/./b`);
 *   - a component with a TRAILING dot or space (`foo.`, `foo ` — Windows strips
 *     them, so `foo.` and `foo` collide, and `CON .` aliases `CON`);
 *   - a component naming a reserved device (CON/PRN/AUX/NUL/COM1-9/LPT1-9);
 *   - Windows-invalid component characters `< > " | ? *` (and, already, `:`);
 *   - any ASCII control character (or DEL) anywhere in the path.
 */
export function windowsSafeRelPath(p) {
  if (typeof p !== 'string' || p.length === 0) return { ok: false, reason: 'empty' };
  if (CONTROL_CHARS.test(p)) return { ok: false, reason: 'control-char' };
  if (p.includes('\\')) return { ok: false, reason: 'backslash' };
  if (p.includes(':')) return { ok: false, reason: 'colon/device' };
  if (p.startsWith('//')) return { ok: false, reason: 'unc' };
  if (/^[A-Za-z]:/.test(p)) return { ok: false, reason: 'drive' };
  if (p.startsWith('/')) return { ok: false, reason: 'absolute' };
  if (WINDOWS_INVALID_CHARS.test(p)) return { ok: false, reason: 'windows-invalid-char' };
  const segs = p.split('/');
  if (segs.some((s) => s === '..')) return { ok: false, reason: 'traversal' };
  if (segs.some((s) => s === '.' || s === '')) return { ok: false, reason: 'dot/empty-segment' };
  if (segs.some((s) => WINDOWS_RESERVED.test(s))) return { ok: false, reason: 'windows-reserved/device-name' };
  if (segs.some((s) => /[ .]$/.test(s))) return { ok: false, reason: 'trailing-dot-or-space' };
  return { ok: true };
}

/**
 * Materialise a validated archive into a fresh empty dir. Returns the written
 * files (path + sha256 + bytes) plus the archive sha256, or fails closed.
 */
export function materializeValidatedArchive(buf, destDir) {
  const parsed = parseAndValidateTar(buf);
  if (!parsed.ok) return { ok: false, errors: parsed.errors, files: [], archiveSha256: sha256(buf) };
  if (!existsSync(destDir)) return { ok: false, errors: [`destDir does not exist: ${destDir}`], files: [], archiveSha256: sha256(buf) };
  if (readdirSync(destDir).length !== 0) return { ok: false, errors: [`destDir must be empty (refusing to overlay): ${destDir}`], files: [], archiveSha256: sha256(buf) };
  const destReal = realpathSync(destDir);

  // PREFLIGHT: validate EVERY file entry (name safety, containment, collision,
  // file/dir conflict) BEFORE writing any payload, so a later invalid entry can
  // never leave partial output behind.
  const errors = [];
  const plan = [];
  const seen = new Set();
  const seenLower = new Set();
  for (const e of parsed.entries) {
    if (e.type === 'dir') continue; // dirs are created implicitly by their files
    if (e.type !== 'file') { errors.push(`unexpected entry type ${e.type} for ${e.path}`); continue; }
    const safe = windowsSafeRelPath(e.path);
    if (!safe.ok) { errors.push(`unsafe archive path ${JSON.stringify(e.path)} (${safe.reason})`); continue; }
    const lower = e.path.toLowerCase();
    if (seen.has(e.path) || seenLower.has(lower)) { errors.push(`colliding archive path ${JSON.stringify(e.path)}`); continue; }
    seen.add(e.path);
    seenLower.add(lower);
    const target = resolve(destReal, e.path);
    if (target !== destReal && !target.startsWith(destReal + sep)) {
      errors.push(`lexical escape for ${JSON.stringify(e.path)} -> ${target}`);
      continue;
    }
    plan.push({ path: e.path, target, dataOffset: e.dataOffset, size: e.size });
  }
  if (errors.length === 0) {
    // File/directory collision: any path whose ANCESTOR component is itself a
    // regular file is refused. O(n · depth) via prefix sets (exact + casefolded),
    // not the previous plan×plan O(n²) scan that would walk ~18k archive paths.
    const fileExact = new Set(plan.map((p) => p.path));
    const fileLower = new Set(plan.map((p) => p.path.toLowerCase()));
    for (const p of plan) {
      const segs = p.path.split('/');
      let prefix = '';
      for (let i = 0; i < segs.length - 1; i++) {
        prefix = prefix ? `${prefix}/${segs[i]}` : segs[i];
        if (fileExact.has(prefix) || fileLower.has(prefix.toLowerCase())) {
          errors.push(`file/directory collision: ${prefix} vs ${p.path}`);
          break;
        }
      }
    }
  }
  if (errors.length) return { ok: false, errors, files: [], archiveSha256: sha256(buf) };

  const files = [];
  for (const p of plan) {
    const slice = buf.subarray(p.dataOffset, p.dataOffset + p.size);
    mkdirSync(dirname(p.target), { recursive: true });
    writeFileSync(p.target, slice, { flag: 'wx' });
    files.push({ path: p.path, sha256: sha256(slice), bytes: p.size });
  }
  return { ok: true, errors: [], files, archiveSha256: sha256(buf) };
}

/**
 * Independently bind an archive to the EXACT recorded commit/tree/source. BOTH
 * the actual and the expected archive sha256 must be a FULL 64-hex digest and
 * must be equal, and the commit/tree must be FULL 40-hex shas — a caller-claimed
 * short/partial hash can never satisfy the binding.
 */
export function bindArchiveToSource({ actualArchiveSha256, expectedArchiveSha256, commit, tree }) {
  const errors = [];
  if (!/^[0-9a-f]{40}$/.test(String(commit ?? ''))) errors.push('recorded commit is not a full 40-hex sha');
  if (!/^[0-9a-f]{40}$/.test(String(tree ?? ''))) errors.push('recorded tree is not a full 40-hex sha');
  if (!/^[0-9a-f]{64}$/.test(String(actualArchiveSha256 ?? ''))) errors.push('actual archive sha256 is not a full 64-hex digest');
  if (!/^[0-9a-f]{64}$/.test(String(expectedArchiveSha256 ?? ''))) errors.push('expected archive sha256 is not a full 64-hex digest');
  if (
    /^[0-9a-f]{64}$/.test(String(expectedArchiveSha256 ?? '')) &&
    /^[0-9a-f]{64}$/.test(String(actualArchiveSha256 ?? '')) &&
    expectedArchiveSha256 !== actualArchiveSha256
  ) {
    errors.push(`archive sha256 ${actualArchiveSha256.slice(0, 12)} != deterministic Git archive of the recorded ref ${expectedArchiveSha256.slice(0, 12)}`);
  }
  return { ok: errors.length === 0, errors, archiveSha256: actualArchiveSha256 ?? null, commit: commit ?? null, tree: tree ?? null };
}

export { isAbsolute, join, resolve, sep };
