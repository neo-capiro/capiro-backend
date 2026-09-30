export function resolvePhase3ScopeBase({ git, end = 'HEAD', explicitBase }) {
  if (explicitBase) return git(['rev-parse', `${explicitBase}^{commit}`]);
  for (const ref of ['origin/main', 'main']) {
    try {
      git(['rev-parse', '--verify', '--quiet', ref]);
    } catch {
      continue;
    }
    const base = git(['merge-base', ref, end]);
    if (!/^[0-9a-f]{40}$/i.test(base)) throw new Error('Invalid Phase 3 merge base');
    return base;
  }
  throw new Error('Phase 3 scope requires a verified origin/main or main ref');
}
