/**
 * Working-tree input detection for the CleanUp1 acceptance gate.
 *
 * Independent review round 3 (item 2) found the clean-source precondition
 * silently missed a whole untracked source directory: plain
 * `git status --porcelain` collapses the addition to `?? dir/`, and the old
 * extension test then ignored the collapsed directory name. The fix is to ask
 * git for EVERY untracked file with `-uall` and parse the NUL-separated
 * (`-z`) form, which is unambiguous for whitespace and quoted paths.
 *
 * These helpers are pure so the guard-config test can assert the behaviour
 * without touching a real repository.
 */

/**
 * Parse `git status --porcelain -z -uall` output into records.
 *
 * In `-z` form each record is `XY <path>` terminated by NUL, with NO path
 * quoting. A rename/copy record is followed by a second NUL-terminated token
 * holding the original path; that extra token is consumed so it is never
 * mistaken for a status line.
 *
 * The caller MUST pass the RAW bytes (`captureArgv(...).stdoutRaw`), not a
 * trimmed string: the first record of a tracked-only change is ` M path` and a
 * whole-output trim would drop the leading status-column space, shifting the
 * columns and truncating the path. The third character MUST be the status/path
 * separator; anything else means the byte protocol was pre-mangled, so we
 * surface it instead of silently producing a corrupt path.
 *
 * @param {string} text raw NUL-delimited porcelain output
 * @returns {Array<{x:string,y:string,path:string}>}
 * @throws {Error} if a record does not carry the `XY<space>path` shape
 */
export function parsePorcelainZ(text) {
  const records = [];
  if (typeof text !== 'string' || text.length === 0) return records;
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i += 1) {
    const rec = parts[i];
    if (!rec) continue;
    // A valid record is at least `XY <path>` (4 chars). An empty path is not
    // valid porcelain; treat a trailing/empty token as the terminator.
    if (rec.length < 3) continue;
    if (rec[2] !== ' ') {
      throw new Error(
        `malformed porcelain -z record ${JSON.stringify(rec)}: expected the status/path separator at index 2 ` +
          `(did the caller pass trimmed stdout instead of raw bytes?)`,
      );
    }
    const x = rec[0];
    const y = rec[1];
    const p = rec.slice(3);
    if (p.length === 0) {
      throw new Error(`malformed porcelain -z record ${JSON.stringify(rec)}: empty path`);
    }
    records.push({ x, y, path: p });
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') i += 1; // skip original-path token
  }
  return records;
}

/** Tracked changes: any record that is neither untracked (??) nor ignored (!!). */
export function trackedDirtyFiles(records) {
  return records
    .filter((r) => r.x !== '?' && r.x !== '!')
    .map((r) => `${r.x}${r.y} ${r.path}`);
}

/** Every untracked (??) file path, including files inside new directories. */
export function untrackedFiles(records) {
  return records.filter((r) => r.x === '?' && r.y === '?').map((r) => r.path);
}

/**
 * Filter untracked files down to the RELEVANT (source/config) inputs, honouring
 * explicit non-source exclusions. `docs/` is NOT excluded blanketly (it carries
 * executable operator scripts); only the declared scratch/evidence trees are.
 */
export function relevantUntrackedFiles(records, { exclusions = [], extRe } = {}) {
  const ex = exclusions.map((e) => e.replace(/\/$/, ''));
  return untrackedFiles(records).filter((p) => {
    const posix = p.split('\\').join('/');
    if (ex.some((e) => posix === e || posix.startsWith(`${e}/`))) return false;
    return extRe ? extRe.test(posix) : true;
  });
}
