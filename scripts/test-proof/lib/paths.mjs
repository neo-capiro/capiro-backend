/**
 * Path normalisation for the test-name proof tooling.
 *
 * The whole point of normalising a discovered test's file path RELATIVE TO ITS
 * OWN PACKAGE is that the SAME logical test dumped from two different worktrees
 * (two checkout roots on disk) must compare equal in the diff. A raw absolute
 * path from worktree A can never equal one from worktree B, so an unnormalised
 * path would present every test as "changed" purely because the harness ran in
 * a different directory.
 *
 * Contract:
 *   - separators are always forward slashes ("/"):
 *   - no leading "./":
 *   - relative to the package directory, never the repo root or the drive root.
 */

export function toPosix(p) {
  if (typeof p !== 'string') return p;
  return p.replace(/\\/g, '/');
}

/**
 * Strip a single trailing slash (but never turn "/" into "").
 */
function trimTrailingSlash(s) {
  return s.length > 1 ? s.replace(/\/+$/, '') : s;
}

/**
 * Normalise a path found inside a runner report so it is relative to the
 * package directory it belongs to.
 *
 * @param {string} raw          path from the runner (absolute or relative)
 * @param {string} packageDirAbs absolute path of the package directory
 * @param {string} [packageDirRel] repo-root-relative package dir (e.g. "apps/api")
 * @returns {string} posix, package-relative path (or the cleaned input when no anchor matches)
 */
export function normalizeSuitePath(raw, packageDirAbs, packageDirRel) {
  if (raw == null || raw === '') return '';
  let s = toPosix(String(raw));

  const anchors = [];
  if (packageDirAbs) anchors.push(trimTrailingSlash(toPosix(packageDirAbs)));
  if (packageDirRel) anchors.push(trimTrailingSlash(toPosix(packageDirRel)));

  for (const anchor of anchors) {
    if (!anchor) continue;
    // Exact absolute prefix (case-sensitive; the harness is single-platform per run).
    if (s === anchor) return '';
    if (s.startsWith(anchor + '/')) {
      s = s.slice(anchor.length + 1);
      return cleanRel(s);
    }
  }

  // Cross-worktree fallback: the report may have been produced under a foreign
  // root (e.g. the baseline worker's checkout). Locate the package-relative
  // segment and cut everything before it. Anchored on "/<rel>/" so we never
  // slice a coincidental substring, and the LAST occurrence wins so a nested
  // path that itself contains the segment is not mis-cut.
  for (const anchor of [packageDirRel && trimTrailingSlash(toPosix(packageDirRel)), packageDirAbs && trimTrailingSlash(toPosix(packageDirAbs))]) {
    if (!anchor) continue;
    const needle = '/' + anchor + '/';
    const idx = s.lastIndexOf(needle);
    if (idx !== -1) {
      return cleanRel(s.slice(idx + needle.length));
    }
  }

  return cleanRel(s);
}

function cleanRel(s) {
  let out = s.replace(/^\.\//, '');
  // Collapse accidental leading slashes that would make it look rooted.
  out = out.replace(/^\/+/, '');
  return out;
}

/**
 * Repo-root-relative, posix directory for a package (provenance / discovery key).
 */
export function packageDirRelative(dirAbs, rootAbs) {
  const rel = toPosix(dirAbs).replace(trimTrailingSlash(toPosix(rootAbs)) + '/', '');
  return trimTrailingSlash(rel).replace(/^\.\//, '');
}
