/**
 * ONE canonical tar validator shared by the producer (make-source-archive.mjs)
 * and the host runner (linux/validate-archive.mjs) — round-16.
 *
 * Fixes the three root round-15 false accepts:
 *   - PAX GLOBAL ('g') defaults PERSIST across subsequent entries (kept in a
 *     separate `globalPax` map, never cleared); per-entry ('x') overrides apply
 *     to the next data entry only;
 *   - end-of-archive requires >=2 consecutive zero blocks with NO nonzero data
 *     after them (a lone zero block followed by a malicious header is refused);
 *   - numeric fields are validated as STRICT octal (or GNU base-256), not
 *     parseInt prefix acceptance ('08' is refused);
 *   - PAX records are parsed on the raw UTF-8 BYTES with strict length syntax;
 *     malformed/incomplete records and unsupported extraction-affecting fields
 *     (size override, GNU.sparse) are refused.
 *
 * Typeflags are the real POSIX bytes: '0'/NUL/'7' regular, '5' dir, '1' hardlink,
 * '2' symlink, '3' char, '4' block, '6' FIFO, 'x'/'g'/'L'/'K' metadata. Any other
 * typeflag is refused (fail-closed). Git's ordinary PAX global commit comment is
 * accepted.
 */
import { createHash } from 'node:crypto';

const BLOCK = 512;
export const REGULAR = new Set(['0', '\0', '7']);
export const DIRECTORY = new Set(['5']);
export const LINK_OR_DEVICE = new Set(['1', '2', '3', '4', '6']);

function cstr(buf, off, len) {
  const slice = buf.subarray(off, off + len);
  const nul = slice.indexOf(0);
  return (nul >= 0 ? slice.subarray(0, nul) : slice).toString('utf8');
}

/** Strict numeric field: {ok, value}. GNU base-256 when the high bit is set. */
function numberField(buf, off, len) {
  if (buf[off] & 0x80) {
    let n = 0n;
    for (let i = off; i < off + len; i++) n = (n << 8n) | BigInt(i === off ? buf[i] & 0x7f : buf[i]);
    const v = Number(n);
    return Number.isSafeInteger(v) ? { ok: true, value: v } : { ok: false, value: NaN };
  }
  let end = off + len;
  while (end > off && (buf[end - 1] === 0 || buf[end - 1] === 0x20)) end--;
  let start = off;
  while (start < end && buf[start] === 0x20) start++;
  const s = buf.subarray(start, end);
  if (s.length === 0) return { ok: true, value: 0, empty: true };
  for (const c of s) if (c < 0x30 || c > 0x37) return { ok: false, value: NaN };
  return { ok: true, value: parseInt(s.toString('ascii'), 8) };
}

function checksumOk(buf, off) {
  const declared = numberField(buf, off + 148, 8);
  if (!declared.ok || declared.empty) return false;
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : buf[off + i];
  return sum === declared.value;
}

function isZeroBlock(buf, off) {
  for (let i = 0; i < BLOCK; i++) if (buf[off + i] !== 0) return false;
  return true;
}

/** Parse a PAX extended header payload from RAW BYTES with strict lengths. */
function parsePax(buf) {
  const records = {};
  let pos = 0;
  while (pos < buf.length) {
    let sp = -1;
    for (let i = pos; i < buf.length; i++) {
      if (buf[i] === 0) { sp = -2; break; }
      if (buf[i] === 0x20) { sp = i; break; }
    }
    if (sp === -2) break; // trailing NUL padding
    if (sp < 0) return { error: 'PAX record without a length separator' };
    const lenStr = buf.subarray(pos, sp).toString('ascii');
    if (!/^[0-9]+$/.test(lenStr)) return { error: `PAX non-numeric record length ${JSON.stringify(lenStr)}` };
    const len = parseInt(lenStr, 10);
    if (!(len > 0) || pos + len > buf.length) return { error: 'PAX incomplete/malformed record (bad length)' };
    const recEnd = pos + len;
    if (buf[recEnd - 1] !== 0x0a) return { error: 'PAX record not newline-terminated' };
    const body = buf.subarray(sp + 1, recEnd - 1);
    const eq = body.indexOf(0x3d);
    if (eq <= 0) return { error: 'PAX record missing key=value' };
    records[body.subarray(0, eq).toString('utf8')] = body.subarray(eq + 1).toString('utf8');
    pos = recEnd;
  }
  return { records };
}

function pathSafe(p) {
  if (typeof p !== 'string' || p.length === 0) return false;
  if (p.startsWith('/')) return false;
  if (/^[A-Za-z]:/.test(p)) return false;
  return !p.split('/').includes('..');
}

function rejectUnsupportedPax(pax, where, errors) {
  for (const k of Object.keys(pax)) {
    if (k === 'size' || k.startsWith('GNU.sparse')) errors.push(`unsupported extraction-affecting PAX field ${k} on ${where}`);
  }
}

export function parseAndValidateTar(buf) {
  const errors = [];
  const entries = [];
  let off = 0;
  let sawTerminator = false;
  let localPax = {};        // 'x' — next data entry only
  const globalPax = {};     // 'g' — persists across all following entries
  let pendingName = null;   // 'L'
  let pendingLink = null;   // 'K'
  const seenPaths = new Set();

  while (off + BLOCK <= buf.length) {
    if (isZeroBlock(buf, off)) {
      let j = off; let zeros = 0;
      while (j + BLOCK <= buf.length && isZeroBlock(buf, j)) { zeros++; j += BLOCK; }
      if (zeros < 2) errors.push('archive not terminated by two zero blocks');
      for (let k = j; k < buf.length; k++) if (buf[k] !== 0) { errors.push('nonzero data after end-of-archive marker (hidden trailing entry)'); break; }
      sawTerminator = true;
      break;
    }
    if (!checksumOk(buf, off)) { errors.push(`header checksum mismatch at offset ${off} (corrupt/truncated archive)`); break; }

    const rawName = cstr(buf, off, 100);
    const prefix = cstr(buf, off + 345, 155);
    const headerPath = prefix ? `${prefix}/${rawName}` : rawName;
    const linkname = cstr(buf, off + 157, 100);
    const typeByte = buf[off + 156];
    const type = String.fromCharCode(typeByte === 0 ? 0x30 : typeByte);

    const sizeRes = numberField(buf, off + 124, 12);
    if (!sizeRes.ok) { errors.push(`invalid size field at offset ${off} (not strict octal)`); break; }
    const size = sizeRes.value;
    const dataOff = off + BLOCK;
    if (dataOff + size > buf.length) { errors.push(`truncated payload at offset ${off} (size ${size})`); break; }
    const payload = buf.subarray(dataOff, dataOff + size);
    const nextOff = dataOff + Math.ceil(size / BLOCK) * BLOCK;

    if (type === 'x' || type === 'g') {
      const pr = parsePax(payload);
      if (pr.error) { errors.push(pr.error); break; }
      rejectUnsupportedPax(pr.records, type === 'g' ? 'global PAX header' : 'PAX header', errors);
      if (type === 'g') Object.assign(globalPax, pr.records);
      else localPax = { ...pr.records };
      off = nextOff; continue;
    }
    if (type === 'L') { pendingName = payload.toString('utf8').replace(/\0.*$/, ''); off = nextOff; continue; }
    if (type === 'K') { pendingLink = payload.toString('utf8').replace(/\0.*$/, ''); off = nextOff; continue; }

    // A PAX 'size' record applies to THIS (next) data entry; refuse any override
    // that disagrees with the header size (unsupported size semantics).
    if (localPax.size !== undefined && Number(localPax.size) !== size) {
      errors.push(`unsupported PAX size override on ${headerPath} (${localPax.size} != ${size})`);
    }

    const effectivePath = localPax.path ?? pendingName ?? globalPax.path ?? headerPath;
    const effectiveLink = localPax.linkpath ?? pendingLink ?? globalPax.linkpath ?? linkname;
    localPax = {}; pendingName = null; pendingLink = null;

    if (!pathSafe(effectivePath)) errors.push(`unsafe effective path: ${JSON.stringify(effectivePath)}`);
    if (seenPaths.has(effectivePath)) errors.push(`duplicate/ambiguous entry path: ${effectivePath}`);
    seenPaths.add(effectivePath);

    if (LINK_OR_DEVICE.has(type)) {
      const kind = type === '1' ? 'hardlink' : type === '2' ? 'symlink' : type === '3' ? 'char-device' : type === '4' ? 'block-device' : 'fifo';
      errors.push(`unsupported ${kind} entry: ${effectivePath}${effectiveLink ? ` -> ${effectiveLink}` : ''}`);
      if (effectiveLink && !pathSafe(effectiveLink)) errors.push(`unsafe link target: ${JSON.stringify(effectiveLink)}`);
    } else if (REGULAR.has(type)) {
      if (Number.isInteger(size)) entries.push({ path: effectivePath, type: 'file', size, dataOffset: dataOff, sha256: createHash('sha256').update(payload).digest('hex') });
    } else if (DIRECTORY.has(type)) {
      entries.push({ path: effectivePath.replace(/\/+$/, ''), type: 'dir', size });
    } else {
      errors.push(`unsupported typeflag ${JSON.stringify(type)} for entry: ${effectivePath}`);
    }
    off = nextOff;
  }

  if (!sawTerminator) errors.push('archive missing end-of-archive zero blocks (truncated)');
  return { ok: errors.length === 0, errors, entries };
}

/**
 * Bind an archive to the canonical manifest/required-inputs.
 *   - every REQUIRED_INPUT must have >=1 REGULAR FILE at that path or under it
 *     (an empty directory alone does NOT satisfy a required input);
 *   - every manifest.files[] path must exist as a regular file whose payload
 *     sha256 AND size equal the manifest entry.
 */
export function validateTarAgainstManifest(buf, manifest, requiredInputs = []) {
  const errors = [];
  const { ok, errors: parseErrors, entries } = parseAndValidateTar(buf);
  errors.push(...parseErrors);
  if (!ok) return { ok: false, errors };

  const fileEntries = entries.filter((e) => e.type === 'file');
  const byPath = new Map(fileEntries.map((e) => [e.path, e]));
  for (const req of requiredInputs) {
    const base = req.replace(/\/+$/, '');
    const present = fileEntries.some((e) => e.path === base || e.path.startsWith(`${base}/`));
    if (!present) errors.push(`required source input has no regular file in the archive: ${req}`);
  }
  const files = Array.isArray(manifest?.files) ? manifest.files : [];
  if (!files.length) errors.push('manifest.files[] missing/empty — cannot bind archive payloads');
  let bound = 0;
  for (const f of files) {
    const e = byPath.get(f.path);
    if (!e) { errors.push(`manifest file absent from the archive: ${f.path}`); continue; }
    if (e.sha256 !== f.sha256 || e.size !== f.bytes) {
      errors.push(`archive payload mismatch for ${f.path} (tar ${e.sha256.slice(0, 12)}/${e.size} vs manifest ${String(f.sha256).slice(0, 12)}/${f.bytes})`);
      continue;
    }
    bound++;
  }
  return { ok: errors.length === 0, errors, bound, entries: entries.length };
}

/** Containment-only check (producer): no manifest bind. */
export function validateTarContainment(buf) {
  const { ok, errors, entries } = parseAndValidateTar(buf);
  return { ok, errors, entryCount: entries.length };
}
